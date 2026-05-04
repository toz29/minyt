import Stripe from 'stripe';

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { seller_id, email } = await context.request.json();

    if (!seller_id || !email) {
      return new Response(JSON.stringify({ error: 'Missing seller_id or email' }), { status: 400, headers: corsHeaders });
    }

    const stripe = new Stripe(context.env.STRIPE_SECRET_KEY);

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      metadata: { mentigo_seller_id: seller_id }
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://getminyt.com/account.html?reauth=true',
      return_url: 'https://getminyt.com/account.html?connected=true',
      type: 'account_onboarding'
    });

    return new Response(JSON.stringify({ account_id: account.id, onboarding_url: accountLink.url }), { status: 200, headers: corsHeaders });

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
