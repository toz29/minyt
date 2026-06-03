// Cloudflare Pages Function: /moderate-listing
// Uses Cloudflare Workers AI (Llama Guard) to moderate listing text content.
// Bound to env.AI via the project's Workers AI binding.

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  try {
    const { title, description, long_description } = await context.request.json();

    // Combine all text fields into a single content blob for the moderator
    const text = [title || '', description || '', long_description || '']
      .filter(s => s.trim().length > 0)
      .join('\n\n');

    console.log('[MOD-LISTING] text length:', text.length, 'title:', (title||'').slice(0,50));

    if (!text.trim()) {
      console.log('[MOD-LISTING] empty text, allowing');
      // Nothing to moderate — let it through; other validation handles empty submissions
      return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });
    }

    // Use a general LLM with a marketplace-specific moderation prompt.
    // Llama Guard alone is too permissive — it only flags formal harm categories
    // (violence, CSAM, terrorism) and lets through profanity/slurs that have no place
    // on a professional marketplace.
    const systemPrompt = `You are a content moderator for a professional creator marketplace called Minyt where people sell courses, communities, coaching, and digital products.

Evaluate the following listing content. Reply with EXACTLY one word — either "BLOCK" or "ALLOW" — followed by a colon and a brief reason.

BLOCK if the content contains ANY of:
- Profanity (fuck, shit, damn, etc. used in the listing copy)
- Slurs of any kind (racial, ethnic, ableist, anti-LGBT, religious)
- Sexually explicit or pornographic content
- Drugs (sale, recommendation, or promotion of illegal drugs)
- Weapons (sale or promotion of firearms, ammunition, explosives)
- Get-rich-quick or pyramid scheme language
- Threats, violence, or harassment
- Content sexualizing minors
- Hate speech or discriminatory rhetoric

ALLOW if the content is professional, appropriate, and free of the above.

Be strict. A marketplace must maintain a professional standard. When in doubt, BLOCK.

Format your reply as: BLOCK: <reason> or ALLOW: looks fine`;

    const result = await context.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 60
    });

    console.log('[MOD-LISTING] AI response:', JSON.stringify(result));

    const response = (result.response || '').trim();
    const isUnsafe = /^block\b/i.test(response);

    console.log('[MOD-LISTING] verdict:', isUnsafe ? 'BLOCK' : 'ALLOW', 'raw:', response);

    if (!isUnsafe) {
      return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });
    }

    // Extract the reason after "BLOCK:" for the user-facing message
    const reasonMatch = response.match(/^block\s*:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : null;
    const reasonText = reason
      ? 'Your listing was flagged: ' + reason + ' — please revise.'
      : 'Your listing was flagged by our content moderation system. Please revise the title or description.';

    return new Response(JSON.stringify({
      allowed: false,
      reason: reasonText
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    // If moderation itself fails, allow the submission — admin review is the backstop.
    // Don't block legitimate creators because of an AI service hiccup.
    console.log('[MOD-LISTING-ERR]', err && err.message, 'stack:', err && err.stack);
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
