// Cloudflare Pages Function: /moderate-image
// Uses Cloudflare Workers AI to classify images for NSFW content.
// Accepts a public image URL (from Supabase Storage) and returns whether it's safe.
// Bound to env.AI via the project's Workers AI binding.

const NSFW_THRESHOLD = 0.7;  // 0.5 = aggressive, 0.7 = balanced, 0.85 = lenient

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { image_url } = await context.request.json();
    if (!image_url) {
      return new Response(JSON.stringify({ error: 'Missing image_url' }), { status: 400, headers: corsHeaders });
    }

    console.log('[MOD-IMAGE] fetching:', image_url.slice(0, 100));

    // Fetch the image bytes
    const imgRes = await fetch(image_url);
    if (!imgRes.ok) {
      console.log('[MOD-IMAGE] fetch failed, status:', imgRes.status);
      // Can't reach the image — let it through. Admin review backstop.
      return new Response(JSON.stringify({ allowed: true, soft_error: true }), { status: 200, headers: corsHeaders });
    }
    const imgBuf = await imgRes.arrayBuffer();
    const imgBytes = [...new Uint8Array(imgBuf)];

    console.log('[MOD-IMAGE] image bytes:', imgBytes.length);

    // Cloudflare's image classifier returns labels with confidence scores.
    // For NSFW specifically, we use a vision-language model to detect explicit content.
    const result = await context.env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: imgBytes,
      prompt: 'Is this image sexually explicit, pornographic, or contains nudity? Answer only "yes" or "no".',
      max_tokens: 10
    });

    console.log('[MOD-IMAGE] AI response:', JSON.stringify(result));

    const responseText = ((result.description || result.response || '') + '').toLowerCase().trim();
    const isNSFW = responseText.startsWith('yes') || responseText.includes(' yes') || responseText === 'yes.';

    console.log('[MOD-IMAGE] verdict:', isNSFW ? 'NSFW' : 'SAFE', 'raw:', responseText);

    if (isNSFW) {
      return new Response(JSON.stringify({
        allowed: false,
        reason: 'This image appears to contain explicit or inappropriate content and cannot be used in a listing.'
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });

  } catch (err) {
    // Soft-fail: if moderation hiccups, let it through. Admin approval still gates the listing.
    console.log('[MOD-IMAGE-ERR]', err && err.message, 'stack:', err && err.stack);
    return new Response(JSON.stringify({ allowed: true, soft_error: true, debug: err && err.message }), {
      status: 200,
      headers: corsHeaders
    });
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
