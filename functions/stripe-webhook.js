export async function onRequestPost(context) {
  try {
    const body = await context.request.text();
    const sig = context.request.headers.get('stripe-signature');
    
    // For now we'll trust the webhook and parse the event directly
    // Full signature verification requires crypto APIs we'll add later
    const stripeEvent = JSON.parse(body);

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const listing_id = session.metadata?.listing_id;
      const amount = session.amount_total / 100;
      const commission = parseFloat(session.metadata?.mentigo_commission || 0) / 100;

      if (listing_id) {
        const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
        const supabaseKey = context.env.SUPABASE_SERVICE_KEY;
        const headers = {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        };

        // Insert order
        await fetch(`${supabaseUrl}/rest/v1/orders`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            listing_id,
            buyer_email: session.customer_details?.email || 'unknown',
            amount,
            commission,
            stripe_payment_id: session.id,
            status: 'completed'
          })
        });

        // Get current listing revenue
        const listingRes = await fetch(`${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}&select=revenue`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        const listings = await listingRes.json();

        if (listings && listings.length > 0) {
          const currentRevenue = listings[0].revenue || 0;
          const newRevenue = currentRevenue + amount;
          let commissionRate = 0.10;
          if (newRevenue >= 100000) commissionRate = 0.06;
          else if (newRevenue >= 50000) commissionRate = 0.08;

          // Update listing revenue and commission rate
          await fetch(`${supabaseUrl}/rest/v1/listings?id=eq.${listing_id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ revenue: newRevenue, commission_rate: commissionRate })
          });
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
