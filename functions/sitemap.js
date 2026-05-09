export async function onRequest(context) {
  try {
    const supabaseUrl = 'https://qoigwxwkhpcgisprkozg.supabase.co';
    const supabaseKey = context.env.SUPABASE_SERVICE_KEY;

    const res = await fetch(`${supabaseUrl}/rest/v1/listings?approved=eq.true&select=id,title,created_at`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    const listings = await res.json();

    const staticPages = [
      { url: 'https://getminyt.com', changefreq: 'daily', priority: '1.0' },
      { url: 'https://getminyt.com/account.html', changefreq: 'monthly', priority: '0.8' },
      { url: 'https://getminyt.com/create-listing.html', changefreq: 'monthly', priority: '0.7' }
    ];

    const offerPages = (listings || []).map(function(l) {
      return {
        url: 'https://getminyt.com/offer.html?id=' + l.id,
        changefreq: 'weekly',
        priority: '0.9'
      };
    });

    const allPages = [...staticPages, ...offerPages];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages.map(function(p) {
  return `  <url>
    <loc>${p.url}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`;
}).join('\n')}
</urlset>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=3600'
      }
    });

  } catch (err) {
    return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://getminyt.com</loc></url></urlset>', {
      status: 200,
      headers: { 'Content-Type': 'application/xml' }
    });
  }
}
