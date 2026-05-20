// Cloudflare Pages function: /manage-subscription
// Creates a Stripe Customer Portal session and redirects the buyer to it.
// Requires env var: STRIPE_SECRET_KEY

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const customer = url.searchParams.get('customer');

    if (!customer) {
      return new Response('Missing customer ID', { status: 400 });
    }

    const params = new URLSearchParams();
    params.append('customer', customer);
    params.append('return_url', 'https://getminyt.com');

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
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

    // Redirect the buyer to the Stripe-hosted portal
    return Response.redirect(session.url, 302);

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
