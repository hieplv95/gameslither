'use strict';
// Blog: trang danh sách /<ngôn ngữ>/blog/, trang bài /<ngôn ngữ>/blog/<slug>, ảnh /media/…
// Nội dung bài lưu dạng Markdown trong bảng posts (db.js) và được chuyển sang HTML ở đây —
// mọi chữ đều được escape, chỉ sinh ra một số thẻ cố định nên nội dung do AI viết không chèn được script.
// Trang trả về còn chỗ trống {{SITE_URL}}, server.js điền khi gửi.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const LOCALES = require('./locales');

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_RE = /^[a-z0-9][a-z0-9-]{0,100}\.(webp|png|jpe?g|svg)$/;
const MEDIA_MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const BY_CODE = new Map(LOCALES.map(L => [L.code, L]));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForScript = obj => JSON.stringify(obj).replace(/</g, '\\u003c');
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const stripTags = s => String(s).replace(/<[^>]+>/g, '');
const blogPath = L => `${L.path}blog/`;
const postPath = (L, slug) => `${L.path}blog/${slug}`;
const isoDay = ts => new Date(ts).toISOString().slice(0, 10);
const fmtDate = (L, ts) => new Intl.DateTimeFormat(L.numLocale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(ts));
const isRaster = src => /\.(webp|png|jpe?g)$/i.test(src || '');

// ---------------------------------------------------------------- Markdown → HTML
// Hỗ trợ: ## / ### / #### tiêu đề, đoạn văn, danh sách -, 1., trích dẫn >, bảng |…|, ---, ảnh ![alt](src "chú thích"),
// **đậm**, *nghiêng*, `code`, [liên kết](url). Không hỗ trợ HTML thô.
function slugifyHeading(s) {
  return stripTags(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'muc';
}
const safeUrl = u => /^(https?:\/\/|\/(?!\/)|#)/i.test(u);
function inline(src) {
  let t = esc(src);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
    if (!safeUrl(url)) return txt;
    const ext = /^https?:/i.test(url);
    return `<a href="${url}"${ext ? ' target="_blank" rel="noopener"' : ''}>${txt}</a>`;
  });
  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function figure(alt, src, caption) {
  if (!safeUrl(src)) return '';
  return `<figure class="post-figure"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async">` +
    (caption ? `<figcaption>${inline(caption)}</figcaption>` : '') + '</figure>';
}
const IMG_LINE = /^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)\s*$/;
const splitRow = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

function markdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [], toc = [], used = new Set();
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], tr = line.trim();
    let m;
    if (!tr) { flush(); continue; }
    if ((m = tr.match(/^(#{1,4})\s+(.+?)\s*#*$/))) {
      flush();
      const level = Math.max(2, m[1].length);           // H1 dành cho tiêu đề bài
      let id = slugifyHeading(m[2]), n = 2;
      while (used.has(id)) id = `${slugifyHeading(m[2])}-${n++}`;
      used.add(id);
      if (level === 2) toc.push({ id, text: stripTags(inline(m[2])) });
      out.push(`<h${level} id="${esc(id)}">${inline(m[2])}</h${level}>`);
      continue;
    }
    if ((m = tr.match(IMG_LINE))) { flush(); out.push(figure(m[1], m[2], m[3])); continue; }
    if (/^(-{3,}|\*{3,})$/.test(tr)) { flush(); out.push('<hr>'); continue; }
    if (/^[-*+]\s+/.test(tr) || /^\d+[.)]\s+/.test(tr)) {
      flush();
      const ordered = /^\d/.test(tr), re = ordered ? /^\d+[.)]\s+/ : /^[-*+]\s+/, items = [];
      while (i < lines.length && re.test(lines[i].trim())) {
        let item = lines[i].trim().replace(re, '');
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !re.test(lines[i + 1].trim())) item += ' ' + lines[++i].trim();
        items.push(`<li>${inline(item)}</li>`); i++;
      }
      i--;
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (tr.startsWith('>')) {
      flush();
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) q.push(lines[i++].trim().replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote><p>${inline(q.join(' '))}</p></blockquote>`);
      continue;
    }
    if (tr.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())) {
      flush();
      const head = splitRow(tr);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      i--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map(r => `<tr>${head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
      continue;
    }
    para.push(tr);
  }
  flush();
  return { html: out.join('\n'), toc };
}

// Số phút đọc: tiếng Trung đếm theo ký tự, các tiếng khác đếm theo từ.
function readMinutes(md, lang) {
  const text = String(md).replace(/[#*>|`\-!\[\]()]/g, ' ');
  const n = lang === 'zh' ? text.replace(/\s/g, '').length / 400 : text.split(/\s+/).filter(Boolean).length / 220;
  return Math.max(1, Math.round(n));
}

// ---------------------------------------------------------------- khung trang
// Ngôn ngữ có ít nhất 1 bài đã đăng (chỉ những trang này mới cho Google lập chỉ mục & đưa vào hreflang)
function langsWithPosts() {
  const set = new Set(db.allPublishedPosts().map(p => p.lang));
  return LOCALES.filter(L => set.has(L.code));
}

function shell(L, o) {
  const t = L.t, b = L.blog;
  const alternates = (o.alternates || []).map(([hl, href]) => `<link rel="alternate" hreflang="${hl}" href="{{SITE_URL}}${href}">`).join('\n  ');
  const img = isRaster(o.image) ? `{{SITE_URL}}${o.image}` : '';
  const withPosts = new Set(langsWithPosts().map(x => x.code));
  const langLinks = LOCALES.map(l => {
    const href = withPosts.has(l.code) ? blogPath(l) : l.path;
    return `<a href="${href}" hreflang="${l.hreflang}" lang="${l.htmlLang}"${l.code === L.code ? ' aria-current="page"' : ''}>${esc(l.name)}</a>`;
  }).join('\n          ');
  return `<!doctype html>
<html lang="${L.htmlLang}" dir="${L.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${esc(o.title)}</title>
  <meta name="description" content="${esc(o.description)}">
  ${o.keywords ? `<meta name="keywords" content="${esc(o.keywords)}">` : ''}
  <link rel="canonical" href="{{SITE_URL}}${o.canonical}">
  ${alternates}
  <meta name="robots" content="${o.robots || 'index, follow, max-image-preview:large, max-snippet:-1'}">
  <meta name="theme-color" content="#0b0f14">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/rss+xml" title="${esc(b.h1)}" href="{{SITE_URL}}${blogPath(L)}rss.xml">
  <meta property="og:type" content="${o.ogType || 'website'}">
  <meta property="og:site_name" content="GameSlither">
  <meta property="og:locale" content="${L.ogLocale}">
  <meta property="og:url" content="{{SITE_URL}}${o.canonical}">
  <meta property="og:title" content="${esc(o.ogTitle || o.title)}">
  <meta property="og:description" content="${esc(o.description)}">
  ${img ? `<meta property="og:image" content="${img}">\n  <meta property="og:image:alt" content="${esc(o.imageAlt || '')}">` : ''}
  ${o.extraMeta || ''}
  <meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${esc(o.ogTitle || o.title)}">
  <meta name="twitter:description" content="${esc(o.description)}">
  ${img ? `<meta name="twitter:image" content="${img}">` : ''}
  <script type="application/ld+json">${jsonForScript(o.jsonLd)}</script>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/blog.css">
</head>
<body class="blog-page">
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="${L.path}" aria-label="${esc(t.homeAria)}">
        <img src="/favicon.svg" alt="" width="30" height="30">
        <span>Game<b>Slither</b></span>
      </a>
      <button class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="siteNav" aria-label="${esc(t.openMenu)}">☰</button>
      <nav id="siteNav" class="site-nav" aria-label="${esc(t.mainNav)}">
        <a href="${L.path}#game-area">${t.nav[0]}</a>
        <a href="${blogPath(L)}"${o.section === 'blog' ? ' aria-current="page"' : ''}>${esc(b.nav)}</a>
        <a href="${L.path}#how-to-play">${t.nav[1]}</a>
        <a href="${L.path}#faq">${t.nav[4]}</a>
        <details class="lang-menu">
          <summary aria-label="${esc(t.langMenu)}">🌐 ${esc(L.name)}</summary>
          <div class="lang-list">
          ${langLinks}
          </div>
        </details>
      </nav>
    </div>
  </header>

  <main class="container blog-main">
${o.body}
  </main>

  <footer class="site-footer">
    <div class="container footer-grid blog-footer">
      <div class="footer-brand">
        <a class="brand" href="${L.path}"><img src="/favicon.svg" alt="" width="28" height="28"><span>Game<b>Slither</b></span></a>
        <p>${t.footerTagline}</p>
      </div>
      <nav aria-label="${esc(stripTags(t.footerGame))}">
        <div class="footer-title">${t.footerGame}</div>
        <a href="${L.path}#game-area">${t.nav[0]}</a>
        <a href="${L.path}#snake-skins">${t.nav[3]}</a>
        <a href="${blogPath(L)}">${esc(b.nav)}</a>
      </nav>
      <nav aria-label="${esc(stripTags(t.footerGuide))}">
        <div class="footer-title">${t.footerGuide}</div>
        <a href="${L.path}#how-to-play">${t.nav[1]}</a>
        <a href="${L.path}#vs-slither-io">GameSlither vs Slither.io</a>
        <a href="${L.path}#faq">${t.nav[4]}</a>
      </nav>
    </div>
    <div class="container footer-bottom">© <span id="year">2026</span> GameSlither. ${t.rights}
      <p class="disclaimer">${t.disclaimer}</p></div>
  </footer>
  <script src="/blog.js"></script>
</body>
</html>
`;
}

function card(L, p, headingTag = 'h2') {
  const href = postPath(L, p.slug);
  return `<article class="post-card">
      <a class="post-card-img" href="${href}" tabindex="-1" aria-hidden="true">${p.cover
        ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="ph"></span>'}</a>
      <div class="post-card-body">
        <${headingTag}><a href="${href}">${esc(p.title)}</a></${headingTag}>
        <p>${esc(p.excerpt || p.description)}</p>
        <div class="post-meta"><time datetime="${isoDay(p.published_at)}">${esc(fmtDate(L, p.published_at))}</time></div>
      </div>
    </article>`;
}

const org = { '@type': 'Organization', '@id': '{{SITE_URL}}/#org', name: 'GameSlither', url: '{{SITE_URL}}/', logo: '{{SITE_URL}}/favicon.svg' };
const crumbs = items => ({ '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `{{SITE_URL}}${url}` })) });

// ---------------------------------------------------------------- trang danh sách
// Phân trang: trang 1 ở /blog/, trang n ở /blog/page/n/ — mỗi trang có canonical riêng để Google thu thập được bài cũ.
const PER_PAGE = 12;
const pagePath = (L, n) => (n > 1 ? `${blogPath(L)}page/${n}/` : blogPath(L));

// Thanh phân trang: Mới hơn · 1 … 4 5 [6] 7 8 … 20 · Cũ hơn
function pager(L, page, pages) {
  if (pages < 2) return '';
  const b = L.blog, nums = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) nums.push(n);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const link = (n, text, rel) => `<a href="${pagePath(L, n)}"${rel ? ` rel="${rel}"` : ''}>${esc(text)}</a>`;
  return `<nav class="pager" aria-label="${esc(b.pages)}">
      ${page > 1 ? link(page - 1, b.newer, 'prev') : ''}
      <span class="pager-nums">${nums.map(n => (n === '…' ? '<span class="gap">…</span>'
        : n === page ? `<span aria-current="page">${n}</span>` : link(n, String(n)))).join('')}</span>
      ${page < pages ? link(page + 1, b.older, 'next') : ''}
    </nav>`;
}

// Trả về null nếu số trang vượt quá (→ 404).
function renderIndex(L, page = 1) {
  const b = L.blog;
  const { posts, total } = db.publishedPage(L.code, PER_PAGE, (page - 1) * PER_PAGE);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) return null;
  const langs = langsWithPosts();
  // trang 2 trở đi chỉ có ở ngôn ngữ này nên không gắn hreflang
  const alternates = total && page === 1 ? [...langs.map(l => [l.hreflang, blogPath(l)])] : [];
  const suffix = page > 1 ? ` – ${b.page.replace('{n}', page)}` : '';
  const url = pagePath(L, page);
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="${L.path}">${esc(b.home)}</a> › ${page > 1
      ? `<a href="${blogPath(L)}">${esc(b.nav)}</a> › <span aria-current="page">${esc(b.page.replace('{n}', page))}</span>`
      : `<span aria-current="page">${esc(b.nav)}</span>`}</nav>
    <header class="blog-head">
      <h1>${esc(b.h1)}${esc(suffix)}</h1>
      ${page === 1 ? `<p class="lead">${esc(b.intro)}</p>` : ''}
    </header>
    ${posts.length ? `<div class="post-grid">
    ${posts.map(p => card(L, p)).join('\n    ')}
    </div>
    ${pager(L, page, pages)}` : `<p class="empty">${esc(b.empty)}</p>`}
    ${cta(L)}`;
  return shell(L, {
    title: b.title + suffix, description: b.description + suffix, canonical: url, section: 'blog', alternates,
    robots: total ? undefined : 'noindex, follow',   // trang rỗng: không cho lập chỉ mục (tránh nội dung mỏng)
    image: posts[0] && posts[0].cover, imageAlt: posts[0] && posts[0].cover_alt,
    extraMeta: [page > 1 && `<link rel="prev" href="{{SITE_URL}}${pagePath(L, page - 1)}">`,
      page < pages && `<link rel="next" href="{{SITE_URL}}${pagePath(L, page + 1)}">`].filter(Boolean).join('\n  '),
    jsonLd: { '@context': 'https://schema.org', '@graph': [org,
      { '@type': 'Blog', '@id': `{{SITE_URL}}${blogPath(L)}#blog`, name: b.h1, description: b.description, url: `{{SITE_URL}}${blogPath(L)}`,
        inLanguage: L.htmlLang, publisher: { '@id': '{{SITE_URL}}/#org' },
        blogPost: posts.map(p => ({ '@type': 'BlogPosting', headline: p.title, url: `{{SITE_URL}}${postPath(L, p.slug)}`,
          datePublished: new Date(p.published_at).toISOString(), ...(isRaster(p.cover) ? { image: `{{SITE_URL}}${p.cover}` } : {}) })) },
      crumbs(page > 1 ? [[b.home, L.path], [b.nav, blogPath(L)], [b.page.replace('{n}', page), url]] : [[b.home, L.path], [b.nav, blogPath(L)]])] },
    body,
  });
}

function cta(L) {
  const b = L.blog;
  return `<aside class="play-cta">
      <div><h2>${esc(b.ctaTitle)}</h2><p>${esc(b.ctaText)}</p></div>
      <a class="btn-play" href="${L.path}#game-area">${esc(b.ctaBtn)} →</a>
    </aside>`;
}

// ---------------------------------------------------------------- trang bài viết
function renderPost(L, p, { preview = false } = {}) {
  const b = L.blog;
  const { html, toc } = markdown(p.content);
  const url = postPath(L, p.slug);
  const minutes = readMinutes(p.content, L.code);
  const pub = p.published_at || p.updated_at;
  const related = db.publishedPosts(L.code, 4).filter(x => x.id !== p.id).slice(0, 3);
  const faq = (p.faq || []).filter(f => f && f[0] && f[1]);
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="${L.path}">${esc(b.home)}</a> › <a href="${blogPath(L)}">${esc(b.nav)}</a> › <span aria-current="page">${esc(p.title)}</span></nav>
    <article class="post">
      <header class="post-head">
        <h1>${esc(p.title)}</h1>
        <div class="post-meta">${esc(b.published)} <time datetime="${new Date(pub).toISOString()}">${esc(fmtDate(L, pub))}</time>` +
        (p.updated_at - pub > 86400_000 ? ` · ${esc(b.updated)} <time datetime="${new Date(p.updated_at).toISOString()}">${esc(fmtDate(L, p.updated_at))}</time>` : '') +
        ` · ${esc(fill(b.minRead, { n: minutes }))}</div>
      </header>
      ${p.cover ? `<figure class="post-cover"><img src="${esc(p.cover)}" alt="${esc(p.cover_alt || p.title)}" fetchpriority="high" decoding="async"></figure>` : ''}
      ${toc.length >= 3 ? `<details class="toc" open><summary>${esc(b.toc)}</summary><ol>${toc.map(h => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ol></details>` : ''}
      <div class="post-body">
${html}
      </div>
      ${faq.length ? `<section class="post-faq" id="faq">
        <h2>${esc(b.faq)}</h2>
        ${faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${inline(a)}</p></details>`).join('\n        ')}
      </section>` : ''}
      ${p.credit ? `<p class="credit">${esc(b.photo)} ${inline(p.credit)}</p>` : ''}
    </article>
    ${cta(L)}
    ${related.length ? `<section class="related">
      <h2>${esc(b.related)}</h2>
      <div class="post-grid">${related.map(r => card(L, r, 'h3')).join('')}</div>
      <p><a href="${blogPath(L)}">${esc(b.allPosts)} →</a></p>
    </section>` : ''}`;

  const graph = [org,
    { '@type': 'BlogPosting', '@id': `{{SITE_URL}}${url}#article`, headline: p.title, description: p.description,
      url: `{{SITE_URL}}${url}`, mainEntityOfPage: `{{SITE_URL}}${url}`, inLanguage: L.htmlLang,
      datePublished: new Date(pub).toISOString(), dateModified: new Date(p.updated_at).toISOString(),
      ...(isRaster(p.cover) ? { image: [`{{SITE_URL}}${p.cover}`] } : {}),
      keywords: p.keywords || undefined, wordCount: String(p.content).split(/\s+/).filter(Boolean).length,
      author: { '@id': '{{SITE_URL}}/#org' }, publisher: { '@id': '{{SITE_URL}}/#org' },
      isPartOf: { '@id': `{{SITE_URL}}${blogPath(L)}#blog` }, about: { '@id': '{{SITE_URL}}/#game' } },
    crumbs([[b.home, L.path], [b.nav, blogPath(L)], [p.title, url]]),
  ];
  if (faq.length) graph.push({ '@type': 'FAQPage', inLanguage: L.htmlLang,
    mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: stripTags(inline(a)) } })) });

  return shell(L, {
    title: `${p.title} | GameSlither`, ogTitle: p.title, description: p.description, keywords: p.keywords,
    canonical: url, section: 'blog', ogType: 'article', image: p.cover, imageAlt: p.cover_alt,
    alternates: preview ? [] : [[L.hreflang, url]],
    robots: preview ? 'noindex, nofollow' : undefined,
    extraMeta: `<meta property="article:published_time" content="${new Date(pub).toISOString()}">\n  <meta property="article:modified_time" content="${new Date(p.updated_at).toISOString()}">`,
    jsonLd: { '@context': 'https://schema.org', '@graph': graph },
    body,
  });
}

// ---------------------------------------------------------------- RSS
function renderRss(L) {
  const b = L.blog, posts = db.publishedPosts(L.code, 30);
  const x = s => esc(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${x(b.h1)}</title>
  <link>{{SITE_URL}}${blogPath(L)}</link>
  <atom:link href="{{SITE_URL}}${blogPath(L)}rss.xml" rel="self" type="application/rss+xml"/>
  <description>${x(b.description)}</description>
  <language>${L.htmlLang}</language>
${posts.map(p => `  <item>
    <title>${x(p.title)}</title>
    <link>{{SITE_URL}}${postPath(L, p.slug)}</link>
    <guid>{{SITE_URL}}${postPath(L, p.slug)}</guid>
    <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
    <description>${x(p.excerpt || p.description)}</description>
  </item>`).join('\n')}
</channel>
</rss>
`;
}

// ---------------------------------------------------------------- định tuyến
// Trả về { code, type, body } hoặc { code: 301, location } nếu p là đường dẫn blog, ngược lại null.
function route(p) {
  for (const L of LOCALES) {
    const base = blogPath(L);
    if (p === base.slice(0, -1)) return { code: 301, location: base };
    if (!p.startsWith(base)) continue;
    const rest = p.slice(base.length);
    if (rest === '') return { code: 200, type: 'text/html; charset=utf-8', body: renderIndex(L) };
    if (rest === 'rss.xml') return { code: 200, type: 'application/rss+xml; charset=utf-8', body: renderRss(L) };
    const pm = rest.match(/^page\/(\d{1,4})(\/?)$/);
    if (pm) {
      const n = Number(pm[1]);
      if (n < 1) return null;
      if (n === 1 || pm[1] !== String(n) || !pm[2]) return { code: 301, location: pagePath(L, n) };   // /page/1/, /page/02, thiếu "/"
      const body = renderIndex(L, n);
      return body ? { code: 200, type: 'text/html; charset=utf-8', body } : null;
    }
    const slug = rest.replace(/\/$/, '');
    if (!SLUG_RE.test(slug)) return null;
    if (rest.endsWith('/')) return { code: 301, location: postPath(L, slug) };
    const post = db.publishedPost(L.code, slug);
    if (!post) return null;
    return { code: 200, type: 'text/html; charset=utf-8', body: renderPost(L, post) };
  }
  return null;
}

// Ảnh trong /media: tên file đã kiểm tra chặt, cache dài (đổi ảnh luôn sinh tên file mới).
function serveMedia(res, p) {
  const name = p.slice('/media/'.length);
  if (!MEDIA_RE.test(name)) { res.writeHead(404); res.end(); return; }
  fs.readFile(path.join(MEDIA_DIR, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    const ext = name.split('.').pop();
    const headers = { 'Content-Type': MEDIA_MIME[ext], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
    if (ext === 'svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Lưu ảnh vào /media, trả về đường dẫn công khai.
function saveMedia(buf, ext, base = 'img') {
  const safe = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'img';
  const name = `${safe}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return `/media/${name}`;
}

// ---------------------------------------------------------------- trang chủ: menu Blog + bài mới nhất
function injectHome(html, lang) {
  const L = BY_CODE.get(lang) || LOCALES[0];
  const posts = db.publishedPosts(L.code, 3);
  if (!posts.length) return html.replace(/<!--BLOG-->[\s\S]*?<!--\/BLOG-->/g, '').replace('{{LATEST_POSTS}}', '');
  const section = `<section id="blog">
        <h2>${esc(L.blog.related)}</h2>
        <div class="post-grid">${posts.map(p => card(L, p, 'h3')).join('')}</div>
        <p><a href="${blogPath(L)}">${esc(L.blog.allPosts)} →</a></p>
      </section>`;
  return html.replaceAll('<!--BLOG-->', '').replaceAll('<!--/BLOG-->', '').replace('{{LATEST_POSTS}}', section);
}

// ---------------------------------------------------------------- sitemap, llms.txt
function sitemapUrls(SITE_URL) {
  const posts = db.allPublishedPosts(), langs = langsWithPosts();
  const alt = langs.map(l => `    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${SITE_URL}${blogPath(l)}"/>\n`).join('');
  let out = '';
  for (const L of langs) {
    const last = Math.max(...posts.filter(p => p.lang === L.code).map(p => p.updated_at));
    out += `  <url>\n    <loc>${SITE_URL}${blogPath(L)}</loc>\n    <lastmod>${isoDay(last)}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n${alt}  </url>\n`;
  }
  for (const p of posts) {
    const L = BY_CODE.get(p.lang);
    if (!L) continue;
    out += `  <url>\n    <loc>${SITE_URL}${postPath(L, p.slug)}</loc>\n    <lastmod>${isoDay(p.updated_at)}</lastmod>\n    <priority>0.6</priority>\n` +
      (isRaster(p.cover) ? `    <image:image><image:loc>${SITE_URL}${esc(p.cover)}</image:loc></image:image>\n` : '') + '  </url>\n';
  }
  return out;
}
function llmsLines(SITE_URL) {
  return db.allPublishedPosts().slice(0, 50).map(p => {
    const L = BY_CODE.get(p.lang);
    return L ? `- [${p.title}](${SITE_URL}${postPath(L, p.slug)}) (${L.name})` : '';
  }).filter(Boolean).join('\n');
}

module.exports = {
  MEDIA_DIR, MEDIA_RE, SLUG_RE, BY_CODE, route, serveMedia, saveMedia, renderPost, injectHome, sitemapUrls, llmsLines,
  markdown, blogPath, postPath,
};
