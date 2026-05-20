export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { listing_id, title, price, billing_unit, seller_stripe_id } = await context.request.json();

    if (!listing_id || !title || !price) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: corsHeaders });
    }

    const priceInCents = Math.round(parseFloat(price) * 100);
    const isRecurring = billing_unit === '/ month' || billing_unit === '/ week';
    const applicationFeeAmount = Math.round(priceInCents * 0.10);

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

    if (isRecurring) {
      params.append('line_items[0][price_data][recurring][interval]', billing_unit === '/ week' ? 'week' : 'month');
    }

    if (seller_stripe_id) {
      if (isRecurring) {
        params.append('subscription_data[application_fee_percent]', '10');
        params.append('subscription_data[transfer_data][destination]', seller_stripe_id);
        params.append('subscription_data[on_behalf_of]', seller_stripe_id);
      } else {
        params.append('payment_intent_data[application_fee_amount]', applicationFeeAmount.toString());
        params.append('payment_intent_data[transfer_data][destination]', seller_stripe_id);
        params.append('payment_intent_data[on_behalf_of]', seller_stripe_id);
      }
    }

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
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
