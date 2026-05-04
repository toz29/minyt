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

    const accountParams = new URLSearchParams();
    accountParams.append('type', 'express');
    accountParams.append('email', email);
    accountParams.append('capabilities[card_payments][requested]', 'true');
    accountParams.append('capabilities[transfers][requested]', 'true');
    accountParams.append('metadata[mentigo_seller_id]', seller_id);

    const accountRes = await fetch('https://api.stripe.com/v1/accounts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: accountParams.toString()
    });

    const account = await accountRes.json();

    if (account.error) {
      return new Response(JSON.stringify({ error: account.error.message }), { status: 400, headers: corsHeaders });
    }

    const linkParams = new URLSearchParams();
    linkParams.append('account', account.id);
    linkParams.append('refresh_url', 'https://getminyt.com/account.html?reauth=true');
    linkParams.append('return_url', 'https://getminyt.com/account.html?connected=true');
    linkParams.append('type', 'account_onboarding');

    const linkRes = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: linkParams.toString()
    });

    const accountLink = await linkRes.json();

    if (accountLink.error) {
      return new Response(JSON.stringify({ error: accountLink.error.message }), { status: 400, headers: corsHeaders });
    }

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
