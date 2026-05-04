import Stripe from 'stripe';

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

    const stripe = new Stripe(context.env.STRIPE_SECRET_KEY);
    const priceInCents = Math.round(parseFloat(price) * 100);
    const isRecurring = billing_unit === '/ month' || billing_unit === '/ week';
    const applicationFeeAmount = Math.round(priceInCents * 0.10);

    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: title, metadata: { listing_id } },
          unit_amount: priceInCents,
          ...(isRecurring && { recurring: { interval: billing_unit === '/ week' ? 'week' : 'month' } })
        },
        quantity: 1
      }],
      mode: isRecurring ? 'subscription' : 'payment',
      success_url: `https://getminyt.com/success.html?session_id={CHECKOUT_SESSION_ID}&listing_id=${listing_id}`,
      cancel_url: 'https://getminyt.com',
      metadata: { listing_id, minyt_commission: applicationFeeAmount.toString() }
    };

    if (seller_stripe_id) {
      sessionConfig.payment_intent_data = {
        application_fee_amount: applicationFeeAmount,
        transfer_data: { destination: seller_stripe_id }
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

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
