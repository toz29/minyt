export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { listing_id, title, price, billing_unit, seller_stripe_id, buyer_email } = await context.request.json();

    if (!listing_id || !title || price === undefined || price === null) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: corsHeaders });
    }

    const priceNum = parseFloat(price);
    const priceInCents = Math.round(priceNum * 100);
    const isRecurring = billing_unit === '/ month' || billing_unit === '/ week';
    const isFree = priceNum === 0;

    // ── FREE OFFER PATH ──
    // No Stripe interaction. Insert an order row directly using the service key (bypasses RLS).
    // Returns a success URL pointing at success.html with a synthetic session_id so the intake
    // flow and dashboard tracking all work the same as for paid orders.
    if (isFree) {
      if (!buyer_email) {
        return new Response(JSON.stringify({ error: 'Email required to claim a free offer' }), { status: 400, headers: corsHeaders });
      }
      const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
      const supabaseKey = context.env.SUPABASE_SERVICE_KEY;

      // Dupe check: same buyer can't claim the same free offer twice.
      // This catches both repeat clicks and intentional re-claims that would clutter the creator's dashboard.
      try {
        const dupeCheck = await fetch(
          `${supabaseUrl}/rest/v1/orders?listing_id=eq.${listing_id}&buyer_email=eq.${encodeURIComponent(buyer_email)}&status=eq.completed&select=id,stripe_payment_id`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const dupes = await dupeCheck.json();
        if (dupes && dupes.length > 0) {
          // Return the existing claim's URL so the buyer can re-access their content (intake, link)
          const existingSessionId = dupes[0].stripe_payment_id;
          const reuseUrl = `https://getminyt.com/success.html?session_id=${encodeURIComponent(existingSessionId)}&listing_id=${encodeURIComponent(listing_id)}`;
          return new Response(JSON.stringify({
            url: reuseUrl,
            session_id: existingSessionId,
            free: true,
            already_claimed: true
          }), { status: 200, headers: corsHeaders });
        }
      } catch (e) {
        // Non-fatal — fall through and create the claim
      }

      // Look up seller_id from the listing so the order is properly attributed
      let freeSellerId = null;
      try {
        const sellerLookup = await fetch(
          `${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}&select=seller_id`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const rows = await sellerLookup.json();
        freeSellerId = rows && rows[0] && rows[0].seller_id;
      } catch (e) { /* non-fatal */ }

      const freeId = 'free_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        const insertRes = await fetch(`${supabaseUrl}/rest/v1/orders`, {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            listing_id,
            seller_id: freeSellerId,
            buyer_email,
            amount: 0,
            commission: 0,
            stripe_payment_id: freeId,
            status: 'completed'
          })
        });
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          return new Response(JSON.stringify({ error: 'Could not record free offer claim', details: errText }), { status: 500, headers: corsHeaders });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }

      const successUrl = `https://getminyt.com/success.html?session_id=${encodeURIComponent(freeId)}&listing_id=${encodeURIComponent(listing_id)}`;
      return new Response(JSON.stringify({ url: successUrl, session_id: freeId, free: true }), { status: 200, headers: corsHeaders });
    }

    // ── PAID OFFER PATH (existing logic continues below) ──
    if (!seller_stripe_id) {
      return new Response(JSON.stringify({ error: 'Seller has not connected a payout account' }), { status: 400, headers: corsHeaders });
    }

    // ── LAUNCH PROMO: First 10 creators' first sale is commission-free ──
    // Approach: at checkout creation, check if this seller qualifies for the promo.
    // (a) Does this seller already have completed orders? If yes → not a first sale, normal commission.
    // (b) If no prior sales for this seller, how many distinct sellers have completed orders so far?
    //     If <10 → promo applies, commission = 0. If 10+ → promo exhausted, normal commission.
    // Race condition note: two checkouts at exactly the 10th spot could both pass. Cost is bounded
    // (worst case ~11 free sales instead of 10), acceptable for launch-volume traffic.
    let isPromoSale = false;
    const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_KEY;
    try {
      // Look up seller_id from the listing being purchased
      const listingRes = await fetch(
        `${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}&select=seller_id`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
      );
      const listingRows = await listingRes.json();
      const sellerId = listingRows && listingRows[0] && listingRows[0].seller_id;

      if (sellerId) {
        // (a) Has this seller had any completed orders yet?
        const sellerOrdersRes = await fetch(
          `${supabaseUrl}/rest/v1/orders?seller_id=eq.${sellerId}&status=eq.completed&select=id&limit=1`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const sellerOrders = await sellerOrdersRes.json();

        if (!sellerOrders || sellerOrders.length === 0) {
          // (b) Count distinct sellers with at least one completed order
          const allOrdersRes = await fetch(
            `${supabaseUrl}/rest/v1/orders?status=eq.completed&select=seller_id`,
            { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
          );
          const allOrders = await allOrdersRes.json();
          const distinctSellers = new Set((allOrders || []).map(o => o.seller_id).filter(Boolean));
          if (distinctSellers.size < 10) {
            isPromoSale = true;
          }
        }
      }
    } catch (e) {
      // If the promo check fails for any reason, fall through to normal commission.
      // Don't block the sale.
    }

    const applicationFeeAmount = isPromoSale ? 0 : Math.round(priceInCents * 0.10);

    // Backstop: prevent duplicate active subscriptions for the same buyer + listing.
    // Client-side UI already handles the common case (logged-in buyer sees "Manage" button instead of "Buy"),
    // but this catches edge cases — guest buyer using known email, race conditions, etc.
    if (isRecurring && buyer_email) {
      try {
        const dupeCheck = await fetch(
          `${supabaseUrl}/rest/v1/orders?listing_id=eq.${listing_id}&buyer_email=eq.${encodeURIComponent(buyer_email)}&subscription_status=in.(active,trialing)&select=id`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        const dupes = await dupeCheck.json();
        if (dupes && dupes.length > 0) {
          return new Response(JSON.stringify({
            error: "You already have an active subscription to this offer. Manage it from your account dashboard.",
            already_subscribed: true
          }), { status: 400, headers: corsHeaders });
        }
      } catch (e) {
        // Don't block checkout if the dupe-check itself fails — fall through and let Stripe handle it
      }
    }

    const params = new URLSearchParams();
    params.append('payment_method_types[]', 'card');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', title);
    params.append('line_items[0][price_data][product_data][metadata][listing_id]', listing_id);
    params.append('line_items[0][price_data][unit_amount]', priceInCents.toString());
    params.append('line_items[0][quantity]', '1');
    params.append('mode', isRecurring ? 'subscription' : 'payment');
    params.append('success_url', `https://getminyt.com/success.html?session_id={CHECKOUT_SESSION_ID}&listing_id=${listing_id}`);
    params.append('cancel_url', 'https://getminyt.com');
    params.append('metadata[listing_id]', listing_id);
    params.append('metadata[minyt_commission]', applicationFeeAmount.toString());
    if (isPromoSale) {
      params.append('metadata[minyt_promo]', 'launch_partner');
    }

    // Pre-fill buyer's email on the Stripe Checkout page if they're logged in
    if (buyer_email) {
      params.append('customer_email', buyer_email);
    }

    if (isRecurring) {
      params.append('line_items[0][price_data][recurring][interval]', billing_unit === '/ week' ? 'week' : 'month');
      // Direct charges with subscription: application fee as a percent (0 for promo, otherwise 10%)
      params.append('subscription_data[application_fee_percent]', isPromoSale ? '0' : '10');
    } else {
      // Direct charges with one-time payment: application fee as a fixed amount
      params.append('payment_intent_data[application_fee_amount]', applicationFeeAmount.toString());
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': seller_stripe_id
      },
      body: params.toString()
    });

    const session = await res.json();

    if (session.error) {
      return new Response(JSON.stringify({ error: session.error.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ url: session.url, session_id: session.id }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}
