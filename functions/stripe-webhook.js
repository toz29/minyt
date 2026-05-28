// Cloudflare Pages function: /stripe-webhook
// Handles Stripe events for one-time payments and subscriptions.
// Required env vars: STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_KEY

export async function onRequestPost(context) {
  try {
    const body = await context.request.text();
    const sig = context.request.headers.get('stripe-signature');

    const verified =
      (await verifyStripeSignature(body, sig, context.env.STRIPE_WEBHOOK_SECRET)) ||
      (await verifyStripeSignature(body, sig, context.env.STRIPE_WEBHOOK_SECRET_CONNECT));
    if (!verified) {
      return new Response('Invalid signature', { status: 400 });
    }

    const stripeEvent = JSON.parse(body);
    // For Connect events, stripeEvent.account is the connected account that triggered the event
    const connectedAccountId = stripeEvent.account || null;
    const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_KEY;
    const headers = {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };

    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const listing_id = session.metadata?.listing_id;
        if (!listing_id) break;

        // Idempotency: Stripe can retry webhooks, so make sure we haven't already
        // recorded this checkout session before inserting a duplicate order row.
        const existingCheck = await fetch(
          `${supabaseUrl}/rest/v1/orders?stripe_payment_id=eq.${encodeURIComponent(session.id)}&select=id`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const existing = await existingCheck.json();
        if (existing && existing.length > 0) break;

        const amount = (session.amount_total || 0) / 100;
        // With direct charges, application_fee_amount lives on payment_intent or in metadata
        // Fall back to metadata for the commission amount we tagged at checkout creation
        const commission = parseFloat(
          session.metadata?.minyt_commission || session.metadata?.mentigo_commission || 0
        ) / 100;

        await fetch(`${supabaseUrl}/rest/v1/orders`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            listing_id,
            buyer_email: session.customer_details?.email || 'unknown',
            amount,
            commission,
            stripe_payment_id: session.id,
            stripe_customer_id: session.customer || null,
            stripe_seller_account_id: connectedAccountId,
            subscription_id: session.subscription || null,
            subscription_status: session.subscription ? 'active' : null,
            status: 'completed'
          })
        });

        // Race-safe revenue: recompute from the orders table rather than incrementing.
        // If two webhook deliveries race, both will recompute to the same correct total.
        const ordersRes = await fetch(
          `${supabaseUrl}/rest/v1/orders?listing_id=eq.${listing_id}&status=eq.completed&select=amount`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const allOrders = await ordersRes.json();
        const newRevenue = (allOrders || []).reduce((sum, o) => sum + (parseFloat(o.amount) || 0), 0);
        let commissionRate = 0.10;
        if (newRevenue >= 100000) commissionRate = 0.06;
        else if (newRevenue >= 50000) commissionRate = 0.08;

        await fetch(`${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ revenue: newRevenue, commission_rate: commissionRate })
        });

        // Send purchase confirmation email (fire-and-forget, don't block webhook response).
        // Branches on subscription vs one-time AND whether buyer already has a Minyt account.
        try {
          const buyerEmail = session.customer_details?.email;
          if (buyerEmail) {
            // Check if a Minyt account already exists with this email (uses Supabase Admin API)
            let hasAccount = false;
            try {
              const userCheck = await fetch(
                `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(buyerEmail)}`,
                { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
              );
              if (userCheck.ok) {
                const userData = await userCheck.json();
                hasAccount = !!(userData && userData.users && userData.users.length > 0);
              }
            } catch (e) {
              // If the lookup fails, fall back to assuming no account (worst case: send the nudge to an existing user, which is fine)
              hasAccount = false;
            }

            // Get the listing title for the email body
            let listingTitle = 'your offer';
            try {
              const titleRes = await fetch(
                `${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}&select=title`,
                { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
              );
              if (titleRes.ok) {
                const titleData = await titleRes.json();
                if (titleData && titleData.length > 0 && titleData[0].title) {
                  listingTitle = titleData[0].title;
                }
              }
            } catch (e) {}

            // Fire-and-forget; don't await response, don't fail webhook on email errors
            fetch('https://getminyt.com/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'purchase',
                to: buyerEmail,
                title: listingTitle,
                isSubscription: !!session.subscription,
                hasAccount,
                buyerEmail
              })
            }).catch(() => {});
          }
        } catch (e) {
          // Never let email failures break the webhook
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = stripeEvent.data.object;
        if (!inv.subscription) break;
        const periodEnd = inv.lines && inv.lines.data[0]
          ? new Date(inv.lines.data[0].period.end * 1000).toISOString()
          : null;

        // Update the order row's status + new period end on every successful invoice payment
        await fetch(
          `${supabaseUrl}/rest/v1/orders?subscription_id=eq.${inv.subscription}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              subscription_status: 'active',
              current_period_end: periodEnd
            })
          }
        );

        // Revenue accumulation for renewals.
        // `subscription_create` is the initial payment — that's already counted by checkout.session.completed.
        // `subscription_cycle` is a renewal — that's what we want to count here.
        // Idempotency: track each paid invoice id in the order's invoice_history JSON array,
        // skipping any invoice we've already processed (handles webhook retries).
        if (inv.billing_reason === 'subscription_cycle' && inv.id) {
          const orderLookup = await fetch(
            `${supabaseUrl}/rest/v1/orders?subscription_id=eq.${inv.subscription}&select=id,listing_id,invoice_history`,
            { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
          );
          const orderRows = await orderLookup.json();
          if (orderRows && orderRows.length > 0) {
            const order = orderRows[0];
            const history = Array.isArray(order.invoice_history) ? order.invoice_history : [];
            if (!history.includes(inv.id)) {
              const renewalAmount = (inv.amount_paid || 0) / 100;
              // Append the invoice id to the order's history
              const updatedHistory = history.concat([inv.id]);
              await fetch(
                `${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`,
                {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ invoice_history: updatedHistory })
                }
              );
              // Increment listing revenue + recompute commission tier
              if (order.listing_id && renewalAmount > 0) {
                const listingRes = await fetch(
                  `${supabaseUrl}/rest/v1/listings?id=eq.${order.listing_id}&select=revenue`,
                  { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
                );
                const listings = await listingRes.json();
                if (listings && listings.length > 0) {
                  const currentRevenue = listings[0].revenue || 0;
                  const newRevenue = currentRevenue + renewalAmount;
                  let commissionRate = 0.10;
                  if (newRevenue >= 100000) commissionRate = 0.06;
                  else if (newRevenue >= 50000) commissionRate = 0.08;
                  await fetch(
                    `${supabaseUrl}/rest/v1/listings?id=eq.${order.listing_id}`,
                    {
                      method: 'PATCH',
                      headers,
                      body: JSON.stringify({ revenue: newRevenue, commission_rate: commissionRate })
                    }
                  );
                }
              }
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = stripeEvent.data.object;
        if (!inv.subscription) break;
        await fetch(
          `${supabaseUrl}/rest/v1/orders?subscription_id=eq.${inv.subscription}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ subscription_status: 'past_due' })
          }
        );
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        await fetch(
          `${supabaseUrl}/rest/v1/orders?subscription_id=eq.${sub.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              subscription_status: sub.status,
              current_period_end: new Date(sub.current_period_end * 1000).toISOString()
            })
          }
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await fetch(
          `${supabaseUrl}/rest/v1/orders?subscription_id=eq.${sub.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ subscription_status: 'canceled' })
          }
        );
        break;
      }

      case 'account.updated': {
        // Seller's Connect account changed status (onboarding completed, capabilities enabled, etc.)
        const acct = stripeEvent.data.object;
        const fullyReady = acct.charges_enabled && acct.payouts_enabled && acct.details_submitted;

        // Match by stripe_account_id which we saved on the seller's row during onboarding
        await fetch(
          `${supabaseUrl}/rest/v1/sellers?stripe_account_id=eq.${acct.id}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ stripe_connected: fullyReady })
          }
        );

        // Also update any listings owned by this seller so checkout uses the right seller_stripe_id
        if (fullyReady) {
          // Find seller_id from the metadata we set when creating the account
          const sellerId = acct.metadata && (acct.metadata.seller_id || acct.metadata.mentigo_seller_id);
          if (sellerId) {
            await fetch(
              `${supabaseUrl}/rest/v1/listings?seller_id=eq.${sellerId}`,
              {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ seller_stripe_id: acct.id })
              }
            );
          }
        }
        break;
      }

      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const expected = parts.v1;
  if (!timestamp || !expected) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(signedPayload));
  const hex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === expected;
}
