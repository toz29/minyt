// Cloudflare Pages function: /manage-subscription
// Creates a Stripe Customer Portal session and redirects the buyer to it.
// Customers for direct-charge Connect subscriptions live on the seller's connected account,
// not on the platform — so we look up which account this customer belongs to and pass
// the Stripe-Account header.
// Required env vars: STRIPE_SECRET_KEY, SUPABASE_SERVICE_KEY

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const customer = url.searchParams.get('customer');

    if (!customer) {
      return new Response('Missing customer ID', { status: 400 });
    }

    // Look up which connected account this customer belongs to via the orders table.
    // We stored stripe_seller_account_id on every order when the webhook created it.
    const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_KEY;
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/orders?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=stripe_seller_account_id&limit=1`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const rows = await lookupRes.json();
    const connectedAccountId = rows && rows[0] ? rows[0].stripe_seller_account_id : null;

    if (!connectedAccountId) {
      return new Response(JSON.stringify({
        error: "We couldn't find the seller account for this subscription. Please contact support."
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const params = new URLSearchParams();
    params.append('customer', customer);
    params.append('return_url', 'https://getminyt.com/account.html');

    // The key fix: call Stripe's billing portal API ON BEHALF OF the connected account
    // by including the Stripe-Account header. Without this, Stripe looks for the customer
    // on the platform's books and returns "No such customer".
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': connectedAccountId
      },
      body: params.toString()
    });

    const session = await res.json();

    if (session.error) {
      return new Response(JSON.stringify({ error: session.error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Redirect the buyer to the Stripe-hosted portal on the connected account
    return Response.redirect(session.url, 302);

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
