export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { listing_id, title, price, billing_unit, seller_stripe_id, buyer_email } = await context.request.json();

    if (!listing_id || !title || !price) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: corsHeaders });
    }

    const priceInCents = Math.round(parseFloat(price) * 100);
    const isRecurring = billing_unit === '/ month' || billing_unit === '/ week';

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
