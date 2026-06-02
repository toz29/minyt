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

    // Fetch the image bytes
    const imgRes = await fetch(image_url);
    if (!imgRes.ok) {
      // Can't reach the image — let it through. Admin review backstop.
      return new Response(JSON.stringify({ allowed: true, soft_error: true }), { status: 200, headers: corsHeaders });
    }
    const imgBuf = await imgRes.arrayBuffer();
    const imgBytes = [...new Uint8Array(imgBuf)];

    // Cloudflare's image classifier returns labels with confidence scores.
    // We use a general-purpose model and look for NSFW-related labels.
    // The @cf/microsoft/resnet-50 model returns top labels — useful for object classification.
    // For NSFW specifically, we use a vision-language model to detect explicit content.
    const result = await context.env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: imgBytes,
      prompt: 'Is this image sexually explicit, pornographic, or contains nudity? Answer only "yes" or "no".',
      max_tokens: 10
    });

    const responseText = ((result.description || result.response || '') + '').toLowerCase().trim();
    const isNSFW = responseText.startsWith('yes') || responseText.includes(' yes') || responseText === 'yes.';

    if (isNSFW) {
      return new Response(JSON.stringify({
        allowed: false,
        reason: 'This image appears to contain explicit or inappropriate content and cannot be used in a listing.'
      }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });

  } catch (err) {
    // Soft-fail: if moderation hiccups, let it through. Admin approval still gates the listing.
    console.log('[MODERATE-IMAGE-ERR]', err.message);
    return new Response(JSON.stringify({ allowed: true, soft_error: true }), {
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
