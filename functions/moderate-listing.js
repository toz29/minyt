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
    // Calibrated to catch real violations without being aggressive about creators'
    // expressive or unconventional copy.
    const systemPrompt = `You are a content moderator for Minyt, a marketplace where creators sell courses, communities, coaching, services, and digital products. Creators come from many backgrounds — some are formal, some are casual, some write in all caps, some use emojis, some have edgy or motivational copy.

Your job is to BLOCK only clear violations, NOT to enforce a particular writing style. Many creators are enthusiastic, loud, or unconventional — that's fine and welcome.

BLOCK ONLY if the content contains:
- Explicit profanity (fuck, shit, asshole, bitch, dick, cunt, etc. — actual swear words, not just casual emphasis)
- Slurs (racial, ethnic, ableist like "retard", anti-LGBT like the f-slur, etc.)
- Sexually explicit content (pornography, escort services, OnlyFans funnels)
- Hard drug sales (cocaine, heroin, meth, fentanyl)
- Weapons sales (firearms, ammunition)
- Obvious scam markers (guaranteed returns, pyramid schemes, ponzi)
- Threats, harassment, doxxing
- Content sexualizing minors (always block, zero tolerance)
- Targeted hate speech

DO NOT BLOCK for any of these reasons:
- All caps text or enthusiastic energy
- Emojis, slang, or informal language
- Bold marketing claims, motivational hype, or "sales-y" copy
- Mentions of money, income, or earnings (creators often sell business courses)
- Mentions of YouTube, TikTok, Instagram, or other platforms
- Edgy humor that isn't a slur or threat
- Unconventional formatting

Be permissive. When in doubt, ALLOW. A creator's unique voice matters.

Reply with EXACTLY one of:
ALLOW: ok
BLOCK: <specific reason — name the actual word or phrase>`;

    const result = await context.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 80
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
