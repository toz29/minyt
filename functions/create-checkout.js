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
    const applicationFeeAmount = Math.round(priceInCents * 0.10);

    if (!seller_stripe_id) {
      return new Response(JSON.stringify({ error: 'Seller has not connected a payout account' }), { status: 400, headers: corsHeaders });
    }

    // Backstop: prevent duplicate active subscriptions for the same buyer + listing.
    // Client-side UI already handles the common case (logged-in buyer sees "Manage" button instead of "Buy"),
    // but this catches edge cases — guest buyer using known email, race conditions, etc.
    if (isRecurring && buyer_email) {
      try {
        const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
        const supabaseKey = context.env.SUPABASE_SERVICE_KEY;
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

    // Pre-fill buyer's email on the Stripe Checkout page if they're logged in
    if (buyer_email) {
      params.append('customer_email', buyer_email);
    }

    if (isRecurring) {
      params.append('line_items[0][price_data][recurring][interval]', billing_unit === '/ week' ? 'week' : 'month');
      // Direct charges with subscription: application fee as a percent
      params.append('subscription_data[application_fee_percent]', '10');
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
