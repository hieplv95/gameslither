'use strict';
// robots.txt, sitemap.xml (có hreflang cho mọi ngôn ngữ) và llms.txt (tóm tắt website cho AI).
const { LOCALES, SITE_UPDATED } = require('./pages');
const blog = require('./blog');

// Bot AI (tìm kiếm & trả lời) được phép đọc trang — cần cho GEO
const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User', 'ClaudeBot', 'Claude-SearchBot',
  'Claude-User', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'CCBot'];

module.exports = function seoFiles(SITE_URL) {
  return {
    '/robots.txt': () => 'User-agent: *\nAllow: /\nDisallow: /admin\n\n' +
      AI_BOTS.map(b => `User-agent: ${b}\nAllow: /\nDisallow: /admin\n`).join('\n') +
      `\nSitemap: ${SITE_URL}/sitemap.xml\n`,

    '/sitemap.xml': () => {
      const alt = LOCALES.map(L => `    <xhtml:link rel="alternate" hreflang="${L.hreflang}" href="${SITE_URL}${L.path}"/>\n`).join('') +
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/"/>\n`;
      const urls = LOCALES.map(L => `  <url>\n    <loc>${SITE_URL}${L.path}</loc>\n    <lastmod>${SITE_UPDATED}</lastmod>\n` +
        `    <changefreq>weekly</changefreq>\n    <priority>${L.path === '/' ? '1.0' : '0.8'}</priority>\n${alt}  </url>\n`).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
        urls + blog.sitemapUrls(SITE_URL) + '</urlset>\n';
    },

    '/llms.txt': () => `# GameSlither

> GameSlither is a free, browser-based multiplayer online snake game in the style of Slither.io. Players steer a snake, eat glowing pellets to grow, and make other players crash into their body. No download or sign-up is required.

GameSlither is an independent game. It is not affiliated with, endorsed by, or connected to Slither.io or Lowtech Studios.

## Key facts
- Genre: multiplayer .io snake game (arcade), real-time
- Platforms: any modern web browser on desktop, mobile and tablet
- Price: free to play
- Players: up to 50 per public room; public rooms also have AI snakes
- Controls: mouse or touch to steer; hold left click, Space or the ⚡ button to boost (boosting costs length)
- Private rooms: create a room and share its 4-character code with friends
- Snake skins: 6 (Classic with 12 colors, Neon Cyber, Golden Dragon, Rainbow Candy, Jungle Python, Galaxy)
- Languages: ${LOCALES.length} (${LOCALES.map(L => L.name).join(', ')})

## Pages
${LOCALES.map(L => `- [${L.name}](${SITE_URL}${L.path}): ${L.seo.title}`).join('\n')}
${(list => (list ? `\n## Blog articles\n${list}\n` : ''))(blog.llmsLines(SITE_URL))}`,
  };
};
