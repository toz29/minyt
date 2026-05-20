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

        const listingRes = await fetch(
          `${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}&select=revenue`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const listings = await listingRes.json();
        if (listings && listings.length > 0) {
          const currentRevenue = listings[0].revenue || 0;
          const newRevenue = currentRevenue + amount;
          let commissionRate = 0.10;
          if (newRevenue >= 100000) commissionRate = 0.06;
          else if (newRevenue >= 50000) commissionRate = 0.08;

          await fetch(`${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ revenue: newRevenue, commission_rate: commissionRate })
          });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = stripeEvent.data.object;
        if (!inv.subscription) break;
        const periodEnd = inv.lines && inv.lines.data[0]
          ? new Date(inv.lines.data[0].period.end * 1000).toISOString()
          : null;
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
