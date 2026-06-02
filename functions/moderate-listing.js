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

    if (!text.trim()) {
      // Nothing to moderate — let it through; other validation handles empty submissions
      return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });
    }

    // Call Llama Guard — Cloudflare's safety classification model.
    // It returns a structured response indicating if the content is "safe" or "unsafe"
    // along with which category (e.g. S1: violence, S2: sexual content, etc.).
    const result = await context.env.AI.run('@cf/meta/llama-guard-3-8b', {
      messages: [{ role: 'user', content: text }]
    });

    // Llama Guard typically returns text like "safe" or "unsafe\nS1,S5" etc.
    const response = (result.response || '').trim().toLowerCase();
    const isUnsafe = response.startsWith('unsafe');

    if (!isUnsafe) {
      return new Response(JSON.stringify({ allowed: true }), { status: 200, headers: corsHeaders });
    }

    // Parse which categories flagged
    const categoryMap = {
      's1': 'Violent Crimes',
      's2': 'Non-Violent Crimes',
      's3': 'Sex-Related Crimes',
      's4': 'Child Sexual Exploitation',
      's5': 'Defamation',
      's6': 'Specialized Advice',
      's7': 'Privacy',
      's8': 'Intellectual Property',
      's9': 'Indiscriminate Weapons',
      's10': 'Hate',
      's11': 'Suicide & Self-Harm',
      's12': 'Sexual Content',
      's13': 'Elections',
      's14': 'Code Interpreter Abuse'
    };
    const flaggedCats = (response.match(/s\d+/g) || []).map(c => categoryMap[c] || c).filter(Boolean);
    const reasonText = flaggedCats.length > 0
      ? 'Your listing was flagged for: ' + flaggedCats.join(', ') + '. Please revise the title or description.'
      : 'Your listing was flagged by our moderation system. Please revise the title or description.';

    return new Response(JSON.stringify({
      allowed: false,
      reason: reasonText,
      categories: flaggedCats
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    // If moderation itself fails, allow the submission — admin review is the backstop.
    // Don't block legitimate creators because of an AI service hiccup.
    console.log('[MODERATE-LISTING-ERR]', err.message);
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
