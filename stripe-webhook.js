import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export async function onRequestPost(context) {
  try {
    const stripe = new Stripe(context.env.STRIPE_SECRET_KEY);
    const sig = context.request.headers.get('stripe-signature');
    const body = await context.request.text();

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(body, sig, context.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const listing_id = session.metadata?.listing_id;
      const amount = session.amount_total / 100;
      const commission = parseFloat(session.metadata?.minyt_commission || 0) / 100;

      if (listing_id) {
        const supabase = createClient(
          'https://qoigwxwkhpcgisprkozg.supabase.co',
          context.env.SUPABASE_SERVICE_KEY
        );

        await supabase.from('orders').insert({
          listing_id,
          buyer_email: session.customer_details?.email || 'unknown',
          amount,
          commission,
          stripe_payment_id: session.id,
          status: 'completed'
        });

        const { data: listing } = await supabase
          .from('listings')
          .select('revenue')
          .eq('id', listing_id)
          .single();

        if (listing) {
          const newRevenue = (listing.revenue || 0) + amount;
          let commissionRate = 0.10;
          if (newRevenue >= 100000) commissionRate = 0.06;
          else if (newRevenue >= 50000) commissionRate = 0.08;

          await supabase
            .from('listings')
            .update({ revenue: newRevenue, commission_rate: commissionRate })
            .eq('id', listing_id);
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
