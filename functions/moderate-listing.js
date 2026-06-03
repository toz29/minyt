// Cloudflare Pages Function: /moderate-listing
// Two-layer content moderation:
//   1. Hardcoded slur list (deterministic, zero tolerance)
//   2. Cloudflare Workers AI Llama-3.1 with marketplace-specific prompt (contextual)

// SLURS — zero tolerance, context-independent block.
// Word-boundary matched (so "ass" inside "assistant" doesn't trigger).
// Multi-word entries use substring match.
// Maintenance: review every 3-6 months. Add new terms as they emerge.
const SLURS = [
  // Anti-Black
  'nigger', 'niggers', 'nigga', 'niggas', 'coon', 'jigaboo', 'porch monkey', 'spook',
  // Anti-Hispanic/Latino
  'beaner', 'beaners', 'spic', 'spics', 'wetback', 'wetbacks',
  // Anti-Asian
  'chink', 'chinks', 'gook', 'gooks', 'jap', 'japs', 'slant eye', 'slanteye', 'slope head',
  // Anti-Indigenous
  'redskin', 'injun', 'squaw',
  // Anti-Arab/Middle Eastern/Muslim
  'sand nigger', 'towel head', 'towelhead', 'raghead', 'camel jockey', 'mudslime',
  // Antisemitic
  'kike', 'kikes', 'hymie', 'yid', 'yids',
  // Anti-LGBT
  'faggot', 'faggots', 'fag', 'fags', 'tranny', 'trannies', 'shemale', 'shemales',
  'dyke', 'dykes', 'homo', 'homos',
  // Ableist
  'retard', 'retards', 'retarded', 'retardation', 'tard', 'tards',
  'spaz', 'spazzes', 'mongoloid', 'cripple', 'cripples',
  // Misogynistic
  'whore', 'whores', 'slut', 'sluts', 'cunt', 'cunts',
  // Anti-Italian / Irish / Polish / Romani
  'wop', 'wops', 'guido', 'dago', 'dagos',
  'mick', 'micks',
  'polack', 'polacks',
  'gypsy', 'gypsies', 'gyp',
  // Hate group / dogwhistles
  'white power', 'white supremacy', 'heil hitler', 'sieg heil', 'gas the jews',
  'race war', '14 words', 'jewish question',
  'kkk member', 'kkk recruitment', 'aryan nation', 'aryan brotherhood'
];

function findSlur(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const word of SLURS) {
    const w = word.toLowerCase();
    if (w.indexOf(' ') !== -1) {
      // Multi-word phrase — substring match
      if (lower.indexOf(w) !== -1) return word;
    } else {
      // Single word — word-boundary regex to avoid false positives
      const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(lower)) return word;
    }
  }
  return null;
}

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

    // Layer 1: hardcoded slur list (deterministic, zero tolerance).
    // Catches known slurs that an LLM is too inconsistent to reliably block.
    const slurMatch = findSlur(text);
    if (slurMatch) {
      console.log('[MOD-LISTING] SLUR-BLOCK matched:', slurMatch);
      return new Response(JSON.stringify({
        allowed: false,
        reason: 'Your listing contains language that isn\'t allowed on Minyt. Please remove "' + slurMatch + '" and try again.'
      }), { status: 200, headers: corsHeaders });
    }

    // Layer 2: LLM moderation for contextual violations
    // Two-layer moderation: 
    // 1. Slur word list (deterministic, zero-tolerance) — handled at top of this function
    // 2. LLM (contextual) — catches scams, threats, illegal content, sexually explicit material
    //
    // Profanity itself is NOT blocked. Creator marketplaces (Skool, Whop, Gumroad)
    // all allow swears in copy. Creators have voice and we respect it.
    const systemPrompt = `You are a content moderator for Minyt, a marketplace where creators sell courses, communities, coaching, services, and digital products. Creators have a wide range of voices — some are formal, some loud, some edgy, some use profanity, some use emojis. That's all welcome.

Your job is to BLOCK only clear violations, NOT to enforce a particular writing style or tone.

BLOCK ONLY if the content contains:
- Sexually explicit content (pornography, escort services, OnlyFans funnels, "spicy" content, sex work promotion)
- Hard drug sales or promotion (cocaine, heroin, meth, fentanyl, MDMA, etc.)
- Weapons sales (firearms, ammunition, explosives, illegal weapon mods)
- Obvious scams (guaranteed returns/income, pyramid schemes, ponzi schemes, "I'll make you rich" without delivering value)
- Threats, doxxing, harassment, or calls to harm specific people
- Content sexualizing minors (zero tolerance, always block)
- Stolen content, piracy, cracked software, hacking services for hire
- Counterfeit goods or fake credentials/diplomas

DO NOT BLOCK for any of these reasons:
- Profanity used as emphasis (fuck, shit, damn, ass, etc. are fine in copy)
- All caps text, emojis, or enthusiastic energy
- Slang, informal language, or "internet" voice
- Bold marketing claims, hype, motivational language, or sales copy
- Mentions of money, income, earnings, or making money (creators sell business courses)
- Mentions of YouTube, TikTok, Instagram, OnlyFans (as a platform name only, not selling NSFW content)
- Mentions of crypto, trading, investing (legal financial education is fine — only block obvious scams)
- Edgy humor that isn't a slur or threat
- Unconventional formatting

Be permissive. When in doubt, ALLOW. Creator voice matters.

Reply with EXACTLY one of:
ALLOW: ok
BLOCK: <specific reason — name the actual word or phrase that triggered the block>`;

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
