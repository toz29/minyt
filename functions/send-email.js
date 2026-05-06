export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { type, to, title } = await context.request.json();

    if (!type || !to) {
      return new Response(JSON.stringify({ error: 'Missing type or to' }), { status: 400, headers: corsHeaders });
    }

    let subject, html;

    if (type === 'approved') {
      subject = 'Your offer is live on Minyt!';
      html = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem">
          <div style="font-size:1.25rem;font-weight:600;color:#6366F1;margin-bottom:1.5rem">minyt</div>
          <h2 style="font-size:1.25rem;font-weight:500;margin-bottom:0.75rem">Your offer has been approved!</h2>
          <p style="color:#6b7280;line-height:1.6;margin-bottom:1rem">"${title}" is now live on Minyt and visible to buyers. Make sure your delivery link is set up so buyers get instant access after purchasing.</p>
          <a href="https://getminyt.com/account.html" style="display:inline-block;padding:10px 22px;background:#6366F1;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">View your dashboard</a>
          <p style="color:#9ca3af;font-size:12px;margin-top:2rem">— The Minyt team</p>
        </div>
      `;
    } else if (type === 'denied') {
      subject = 'Update on your Minyt offer';
      html = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem">
          <div style="font-size:1.25rem;font-weight:600;color:#6366F1;margin-bottom:1.5rem">minyt</div>
          <h2 style="font-size:1.25rem;font-weight:500;margin-bottom:0.75rem">Your offer was not approved</h2>
          <p style="color:#6b7280;line-height:1.6;margin-bottom:1rem">"${title}" didn't meet our guidelines. This could be due to incomplete details, unclear description, or content that doesn't fit the platform.</p>
          <p style="color:#6b7280;line-height:1.6;margin-bottom:1rem">You're welcome to revise and resubmit. If you have questions reply to this email and we'll help.</p>
          <a href="https://getminyt.com/create-listing.html" style="display:inline-block;padding:10px 22px;background:#6366F1;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">Submit a new offer</a>
          <p style="color:#9ca3af;font-size:12px;margin-top:2rem">— The Minyt team</p>
        </div>
      `;
    } else if (type === 'purchase') {
      subject = 'Your Minyt purchase is confirmed';
      html = `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem">
          <div style="font-size:1.25rem;font-weight:600;color:#6366F1;margin-bottom:1.5rem">minyt</div>
          <h2 style="font-size:1.25rem;font-weight:500;margin-bottom:0.75rem">Purchase confirmed!</h2>
          <p style="color:#6b7280;line-height:1.6;margin-bottom:1rem">You purchased "${title}". Check your access link on the confirmation page or in your account dashboard.</p>
          <a href="https://getminyt.com/account.html" style="display:inline-block;padding:10px 22px;background:#6366F1;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">View your purchases</a>
          <p style="color:#9ca3af;font-size:12px;margin-top:2rem">— The Minyt team</p>
        </div>
      `;
    } else {
      return new Response(JSON.stringify({ error: 'Unknown email type' }), { status: 400, headers: corsHeaders });
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Minyt <hello@getminyt.com>',
        to: [to],
        subject,
        html
      })
    });

    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, id: data.id }), { status: 200, headers: corsHeaders });

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
