// Saves buyer intake responses to an order row.
// Browser-side updates would be blocked by RLS, so this endpoint uses the service key.
// Validates that the session_id exists and that responses haven't already been saved,
// preventing replay/overwrite from anyone with the session_id.

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { session_id, responses } = await context.request.json();

    if (!session_id || !Array.isArray(responses) || responses.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing session_id or responses' }), { status: 400, headers: corsHeaders });
    }

    const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_KEY;

    // Look up the order. Reject if already has responses (prevents overwrite).
    const lookup = await fetch(
      `${supabaseUrl}/rest/v1/orders?stripe_payment_id=eq.${encodeURIComponent(session_id)}&select=id,intake_responses`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const rows = await lookup.json();
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: corsHeaders });
    }
    if (rows[0].intake_responses) {
      return new Response(JSON.stringify({ error: 'Responses already submitted' }), { status: 409, headers: corsHeaders });
    }

    const orderId = rows[0].id;
    const updateRes = await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ intake_responses: responses })
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      return new Response(JSON.stringify({ error: 'Could not save responses', details: errText }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });

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
