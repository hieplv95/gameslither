'use strict';
// Công cụ viết bài tự động cho blog: gợi ý chủ đề + viết bài chuẩn SEO bằng Claude, kèm ảnh.
// Chữ: Claude API (ANTHROPIC_API_KEY). Ảnh, theo thứ tự ưu tiên:
//   1. VERTEX_KEY_FILE → ảnh do Gemini vẽ qua Vertex AI (Google Cloud, khoá service account dạng JSON)
//   2. OPENAI_API_KEY → ảnh minh hoạ do AI vẽ (gpt-image)
//   3. PEXELS_API_KEY → ảnh kho miễn phí từ Pexels (có ghi nguồn)
//   4. không có key nào → ảnh bìa SVG tự vẽ (tiêu đề + hình rắn), không có ảnh trong bài
// Ảnh do AI vẽ được đóng logo GameSlither ở góc dưới phải (BLOG_IMAGE_LOGO=0 để tắt).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const blog = require('./blog');

const MODEL = process.env.BLOG_MODEL || 'claude-opus-5';
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const VERTEX_IMAGE_MODEL = process.env.VERTEX_IMAGE_MODEL || 'gemini-3.1-flash-image';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
let client = null;
// Chỉ dùng đúng ANTHROPIC_API_KEY trong .env (tính phí vào tài khoản API của key đó).
// Tắt hẳn các nguồn đăng nhập khác của SDK (ANTHROPIC_AUTH_TOKEN, hồ sơ `ant auth login` trên máy)
// để không vô tình dùng thông tin đăng nhập nào khác có sẵn trong môi trường.
const ai = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trong file .env.');
  return (client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null }));
};

function capabilities() {
  return {
    text: !!process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    image: process.env.VERTEX_KEY_FILE ? 'vertex' : process.env.OPENAI_API_KEY ? 'openai'
      : process.env.PEXELS_API_KEY ? 'pexels' : 'svg',
  };
}

// ---------------------------------------------------------------- bối cảnh website
const SITE_FACTS = `GameSlither is a free, browser-based multiplayer online snake game in the style of Slither.io.
- Players steer a snake with the mouse or touch, eat glowing pellets to grow, and try to make other snakes crash into their body.
- Boost: hold left click, Space or the ⚡ button (boosting costs length).
- Up to 50 players per public room, public rooms also have AI snakes; real-time leaderboard and minimap.
- Private rooms: create a room and share its 4-character code with friends.
- 6 snake skins: Classic (12 colors), Neon Cyber, Golden Dragon, Rainbow Candy, Jungle Python, Galaxy.
- Works on desktop, mobile and tablet browsers; no download, no sign-up.
- Available in 11 languages.
GameSlither is independent and NOT affiliated with Slither.io or Lowtech Studios. "Slither io" may be used only to describe the genre/style.`;

const LENGTHS = { short: '700–900', medium: '1300–1600', long: '2200–2600' };
const TONES = {
  friendly: 'friendly, energetic and conversational, like an experienced gamer talking to a friend',
  expert: 'authoritative and analytical, like a veteran strategy guide writer',
  news: 'neutral and informative, like a gaming news editor',
  beginner: 'patient and very clear, explaining everything for complete beginners',
};

function langOf(code) {
  const L = blog.BY_CODE.get(code);
  if (!L) throw new Error('Ngôn ngữ không hợp lệ');
  return L;
}

// Gọi Claude với đầu ra JSON theo schema; trả về object đã parse.
// Dùng streaming (bài dài, tránh timeout) + fallbacks: "default" (nếu model chính từ chối, API tự chạy lại bằng model dự phòng).
async function askJson({ system, prompt, schema, maxTokens = 64000, effort }) {
  const stream = ai().beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema }, ...(effort ? { effort } : {}) },
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('AI từ chối viết chủ đề này. Hãy thử chủ đề khác.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Bài viết quá dài, AI bị cắt giữa chừng. Hãy chọn độ dài ngắn hơn.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); } catch { throw new Error('AI trả về dữ liệu không đọc được. Hãy thử lại.'); }
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY không hợp lệ.';
  if (e instanceof Anthropic.RateLimitError) return 'Đang bị giới hạn tốc độ gọi Claude API, thử lại sau ít phút.';
  if (e instanceof Anthropic.BadRequestError) return `Claude API từ chối yêu cầu: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Lỗi Claude API (${e.status || 'mạng'}): ${e.message}`;
  return e.message || String(e);
}

// ---------------------------------------------------------------- gợi ý chủ đề
const TOPICS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'keyword', 'intent', 'angle'],
        properties: {
          title: { type: 'string', description: 'Working headline in the target language' },
          keyword: { type: 'string', description: 'Main search keyword in the target language, as people actually type it' },
          intent: { type: 'string', enum: ['informational', 'how-to', 'comparison', 'list', 'news'] },
          angle: { type: 'string', description: 'One sentence (target language): what makes this article useful/unique' },
        },
      },
    },
  },
};

async function suggestTopics({ lang, seed = '', count = 10 }) {
  const L = langOf(lang);
  const existing = db.listPosts().filter(p => p.lang === lang).map(p => `- ${p.title}`).join('\n') || '(none yet)';
  const r = await askJson({
    system: `You are an SEO content strategist for a gaming website.\n\n${SITE_FACTS}`,
    prompt: `Suggest ${Math.min(15, Math.max(3, count))} blog article topics for the GameSlither blog, written in ${L.name} (${L.htmlLang}) for readers searching in that language.
${seed ? `Focus area requested by the editor: "${seed}".` : 'Cover a mix: gameplay tips & strategy, beginner guides, comparisons with similar .io games, snake-game culture/history, playing with friends, mobile play.'}
Pick topics with real search demand in that language, a clear search intent, and a realistic chance to rank for a small new site (prefer specific long-tail keywords over very broad head terms).
Every topic must be naturally relevant to GameSlither so the article can link to the game.
Avoid duplicating these existing articles:
${existing}`,
    schema: TOPICS_SCHEMA,
    maxTokens: 16000,
    effort: 'medium',
  });
  return (r.topics || []).slice(0, 15);
}

// ---------------------------------------------------------------- viết bài
const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'slug', 'metaDescription', 'keywords', 'excerpt', 'content', 'faq', 'images'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    metaDescription: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    excerpt: { type: 'string' },
    content: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'],
      properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    images: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['prompt', 'searchQuery', 'alt'],
      properties: { prompt: { type: 'string' }, searchQuery: { type: 'string' }, alt: { type: 'string' } } } },
  },
};

async function writeArticle({ lang, topic, keyword = '', length = 'medium', tone = 'friendly', images = 2, notes = '' }) {
  const L = langOf(lang);
  const nImages = Math.max(1, Math.min(4, Number(images) || 1));
  const related = db.publishedPosts(lang, 30).map(p => `- ${p.title}: ${blog.postPath(L, p.slug)}`).join('\n') || '(none yet)';
  const system = `You are a senior SEO copywriter and a native ${L.name} speaker writing for the GameSlither blog.

${SITE_FACTS}

Writing rules:
- Write entirely in natural, fluent ${L.name} (${L.htmlLang}) — idiomatic, as a native writer would, never a translation. Keep proper names (GameSlither, Slither.io) as-is.
- Be genuinely helpful and specific (E-E-A-T): concrete tips, examples, numbers only when they are facts about GameSlither listed above. Never invent statistics, studies, quotes, release dates or features.
- Never claim GameSlither is Slither.io or affiliated with it.
- No fluff, no keyword stuffing; use the main keyword naturally (title, first paragraph, one H2, conclusion) and related terms/synonyms elsewhere.`;

  const prompt = `Write a blog article.

Topic: ${topic}
Main keyword: ${keyword || '(choose the best one for this topic)'}
Length of "content": ${LENGTHS[length] || LENGTHS.medium} words (or the equivalent for ${L.name}).
Tone: ${TONES[tone] || TONES.friendly}.
${notes ? `Editor's extra instructions: ${notes}\n` : ''}
Internal links you may use (Markdown links, use 2–4 where relevant):
- GameSlither home / play now: ${L.path}
- How to play: ${L.path}#how-to-play
- Snake skins: ${L.path}#snake-skins
- GameSlither vs Slither.io: ${L.path}#vs-slither-io
Existing blog articles in this language:
${related}

Field requirements:
- title: compelling SEO title in ${L.name}, 45–60 characters, contains the main keyword near the start. Do not append the site name.
- slug: lowercase ASCII only (a-z, 0-9, hyphens), 3–7 words, transliterate if the language is not Latin-script, no stop words, no dates.
- metaDescription: 140–158 characters in ${L.name}, includes the keyword, ends with a soft call to action.
- keywords: 5–8 keyword phrases in ${L.name} (main keyword first).
- excerpt: 1–2 sentences (max 200 characters) for article cards.
- content: GitHub-flavored Markdown. Do NOT include the H1 title. Start with a 2–3 sentence intro paragraph that answers the searcher's question directly. Then 4–7 "##" sections with descriptive headings (some with "###" subsections), short paragraphs, bullet or numbered lists, and at least one comparison table if it fits the topic. Use **bold** sparingly for key terms. End with a short conclusion section that invites the reader to play GameSlither (link ${L.path}). No raw HTML. Do not put an FAQ section inside content.
- Images: provide exactly ${nImages} item(s) in "images". images[0] is the cover. ${nImages > 1 ? `Place a line containing exactly [[IMAGE 2]]${nImages > 2 ? `, [[IMAGE 3]]` : ''}${nImages > 3 ? `, [[IMAGE 4]]` : ''} on its own line inside content, each after a relevant section (not the cover).` : 'Do not put image markers in content.'}
  - prompt: English prompt for an AI image generator: a vivid digital illustration that fits the section, stylized glowing neon snakes / arcade game art on a dark background, no text, no letters, no logos, no UI screenshots, no real people.
  - searchQuery: 2–4 English words for a stock photo search (e.g. "gamer playing laptop").
  - alt: descriptive alt text in ${L.name} (max 120 characters), include the keyword naturally in the first image's alt only.
- faq: 3–5 questions real users would search in ${L.name}, with concise 1–3 sentence answers (plain text, may contain Markdown links).`;

  const r = await askJson({ system, prompt, schema: ARTICLE_SCHEMA });
  return normalizeArticle(r, L, nImages);
}

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
}
function toSlug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 10).join('-').slice(0, 80).replace(/-+$/, '');
}
function uniqueSlug(lang, slug, exceptId = 0) {
  let s = toSlug(slug) || `bai-viet-${Date.now().toString(36)}`, n = 2;
  const base = s;
  while (db.slugTaken(lang, s, exceptId)) s = `${base}-${n++}`;
  return s;
}
function normalizeArticle(r, L, nImages) {
  return {
    title: clean(r.title, 120),
    slug: uniqueSlug(L.code, r.slug || r.title),
    description: clean(r.metaDescription, 320),
    keywords: (r.keywords || []).map(k => clean(k, 80)).filter(Boolean).slice(0, 10).join(', '),
    excerpt: clean(r.excerpt, 300),
    content: clean(r.content, 60000),
    faq: (r.faq || []).map(f => [clean(f.question, 300), clean(f.answer, 1200)]).filter(f => f[0] && f[1]).slice(0, 8),
    images: (r.images || []).slice(0, nImages).map(i => ({ prompt: clean(i.prompt, 1500), query: clean(i.searchQuery, 80), alt: clean(i.alt, 160) })),
  };
}

// ---------------------------------------------------------------- ảnh
const STYLE = 'Style: polished digital illustration for a gaming blog, vibrant neon green, cyan and gold glow on a deep dark-navy background, arcade .io snake game vibe. Absolutely no text, letters, numbers, logos or watermarks.';

async function openaiImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: `${prompt}\n\n${STYLE}`, size: '1536x1024', quality: 'medium', output_format: 'webp', n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI: ${(j.error && j.error.message) || res.status}`);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error('OpenAI không trả về ảnh');
  return Buffer.from(b64, 'base64');
}

// ---- Vertex AI: khoá service account (JSON) → access token (1 giờ, ký JWT bằng private key) → Gemini vẽ ảnh
let vertexKey = null, vertexToken = null;
function vertexCreds() {
  if (!vertexKey) {
    let k;
    try { k = JSON.parse(fs.readFileSync(process.env.VERTEX_KEY_FILE, 'utf8')); }
    catch (e) { throw new Error(`Không đọc được VERTEX_KEY_FILE (${e.code || e.message})`); }
    if (!k.client_email || !k.private_key) throw new Error('VERTEX_KEY_FILE không phải khoá service account dạng JSON.');
    vertexKey = k;
  }
  return vertexKey;
}
async function vertexAccessToken() {
  if (vertexToken && vertexToken.exp > Date.now() + 60_000) return vertexToken.value;
  const k = vertexCreds(), now = Math.floor(Date.now() / 1000);
  const tokenUri = k.token_uri || 'https://oauth2.googleapis.com/token';
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
    iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(k.private_key, 'base64url');
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google: đăng nhập bằng service account lỗi (${j.error_description || j.error || res.status})`);
  vertexToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return vertexToken.value;
}
async function vertexImage(prompt) {
  const k = vertexCreds();
  const project = process.env.VERTEX_PROJECT || k.project_id;
  const host = VERTEX_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_IMAGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await vertexAccessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${prompt}\n\n${STYLE}` }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:2' } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vertex AI (${VERTEX_IMAGE_MODEL}): ${(j.error && j.error.message) || res.status}`);
  const c = j.candidates && j.candidates[0];
  const img = ((c && c.content && c.content.parts) || []).find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error(`Vertex AI không trả về ảnh (${(j.promptFeedback && j.promptFeedback.blockReason) || (c && c.finishReason) || 'không rõ lý do'})`);
  return Buffer.from(img.inlineData.data, 'base64');
}

// ---- đóng logo + lưu ảnh AI (chuyển sang WebP cho nhẹ). Thiếu thư viện sharp thì lưu nguyên ảnh gốc.
let sharp = null;
try { sharp = require('sharp'); } catch { /* chưa cài sharp */ }
const LOGO_FILE = path.join(__dirname, 'assets', 'logo-badge.png');
const extOf = b => (b[0] === 0x89 ? 'png' : b[0] === 0xff ? 'jpg' : 'webp');
async function saveAiImage(buf, slug) {
  if (!sharp) return blog.saveMedia(buf, extOf(buf), slug);
  let img = sharp(buf);
  if (process.env.BLOG_IMAGE_LOGO !== '0') {
    const { width, height } = await img.metadata();
    const w = Math.round(width * 0.22), margin = Math.round(width * 0.025);
    const logo = await sharp(LOGO_FILE).resize({ width: w }).toBuffer({ resolveWithObject: true });
    img = img.composite([{ input: logo.data, left: width - w - margin, top: height - logo.info.height - margin }]);
  }
  return blog.saveMedia(await img.webp({ quality: 86 }).toBuffer(), 'webp', slug);
}

async function pexelsImage(query, slug, skip = 0) {
  const u = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query || 'video game')}&orientation=landscape&per_page=${skip + 1}`;
  const res = await fetch(u, { headers: { Authorization: process.env.PEXELS_API_KEY }, signal: AbortSignal.timeout(30_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pexels: ${j.error || res.status}`);
  const ph = j.photos && j.photos[Math.min(skip, j.photos.length - 1)];
  if (!ph) throw new Error(`Pexels không có ảnh cho "${query}"`);
  const img = await fetch(ph.src.large2x || ph.src.large, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error('Không tải được ảnh Pexels');
  const type = img.headers.get('content-type') || '';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  return { src: blog.saveMedia(Buffer.from(await img.arrayBuffer()), ext, slug), credit: `[${ph.photographer}](${ph.photographer_url}) / [Pexels](${ph.url})` };
}

// Ảnh bìa SVG tự vẽ: nền tối, rắn neon uốn lượn, tiêu đề bài (ngắt dòng đơn giản).
function svgCover(title, slug) {
  const x = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const words = String(title).split(/\s+/), lines = [];
  const cjk = /[　-鿿]/.test(title), max = cjk ? 16 : 28;
  if (cjk) for (let i = 0; i < title.length; i += max) lines.push(title.slice(i, i + max));
  else for (const w of words) { const l = lines[lines.length - 1]; if (l && (l + ' ' + w).length <= max) lines[lines.length - 1] = l + ' ' + w; else lines.push(w); }
  const shown = lines.slice(0, 4), fs = shown.length > 3 ? 60 : 70, y0 = 512 - (shown.length - 1) * fs * 0.62;
  let seed = 0; for (const ch of slug) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = seed % 360;
  const pts = []; for (let i = 0; i <= 40; i++) pts.push(`${(i * 40).toFixed(0)},${(900 + Math.sin(i / 3 + seed) * 60).toFixed(0)}`);
  const dots = Array.from({ length: 40 }, (_, i) => {
    const px = (seed * (i + 7) * 97) % 1536, py = (seed * (i + 3) * 61) % 1024;
    return `<circle cx="${px}" cy="${py}" r="${4 + (i % 5)}" fill="hsl(${(hue + i * 37) % 360},90%,65%)" opacity=".55"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b0f14"/><stop offset="1" stop-color="hsl(${hue},45%,14%)"/></linearGradient>
<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#7cff6b"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#fbbf24"/></linearGradient></defs>
<rect width="1536" height="1024" fill="url(#g)"/>${dots}
<polyline points="${pts.join(' ')}" fill="none" stroke="url(#s)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
<text x="96" y="140" font-family="system-ui,Segoe UI,sans-serif" font-size="44" font-weight="900" fill="#e8eef5">Game<tspan fill="#7cff6b">Slither</tspan></text>
${shown.map((l, i) => `<text x="96" y="${(y0 + i * fs * 1.2).toFixed(0)}" font-family="system-ui,Segoe UI,Noto Sans,sans-serif" font-size="${fs}" font-weight="800" fill="#ffffff">${x(l)}</text>`).join('\n')}
</svg>`;
  return { src: blog.saveMedia(Buffer.from(svg), 'svg', slug), credit: '' };
}

// Tạo 1 ảnh theo nhà cung cấp đang có; lỗi thì trả null (không làm hỏng cả bài).
// strict: báo lỗi ra ngoài thay vì lặng lẽ dùng ảnh bìa tự vẽ (nút tạo ảnh trong trang quản trị).
async function makeImage(img, { slug, title, index = 0, cover = false, strict = false }) {
  const kind = capabilities().image;
  if (strict && kind !== 'svg') {
    if (kind === 'pexels') return pexelsImage(img.query, slug, index);
    return { src: await saveAiImage(kind === 'vertex' ? await vertexImage(img.prompt) : await openaiImage(img.prompt), slug), credit: '' };
  }
  try {
    if (kind === 'vertex') return { src: await saveAiImage(await vertexImage(img.prompt), slug), credit: '' };
    if (kind === 'openai') return { src: await saveAiImage(await openaiImage(img.prompt), slug), credit: '' };
    if (kind === 'pexels') return await pexelsImage(img.query, slug, index);
  } catch (e) {
    console.warn(`[blog] tạo ảnh lỗi: ${e.message}`);
    if (!cover) return null;
  }
  return cover ? svgCover(title, slug) : null;
}

// ---------------------------------------------------------------- tác vụ nền
// Viết bài mất 1–3 phút → chạy nền, trang quản trị hỏi tiến độ qua jobId.
const jobs = new Map();   // id -> { status, step, postId, error, startedAt }
const MAX_RUNNING = 3;

function startJob(opts) {
  if (!capabilities().text) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trong file .env.');
  if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_RUNNING) throw new Error('Đang viết tối đa 3 bài cùng lúc, đợi xong rồi thử lại.');
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, status: 'running', step: 'Đang viết nội dung…', postId: 0, error: '', startedAt: Date.now(), topic: opts.topic };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (Date.now() - j.startedAt > 6 * 3600_000) jobs.delete(k);   // dọn tác vụ cũ

  (async () => {
    const a = await writeArticle(opts);
    const L = langOf(opts.lang);
    job.step = 'Đang tạo ảnh…';
    const credits = [];
    let cover = '', coverAlt = '';
    const made = [];
    for (let i = 0; i < a.images.length; i++) {
      job.step = `Đang tạo ảnh ${i + 1}/${a.images.length}…`;
      made[i] = await makeImage(a.images[i], { slug: a.slug, title: a.title, index: i, cover: i === 0 });
      if (made[i] && made[i].credit) credits.push(made[i].credit);
    }
    if (made[0]) { cover = made[0].src; coverAlt = a.images[0].alt; }
    const content = a.content.replace(/^[ \t]*\[\[IMAGE (\d)\]\][ \t]*$/gm, (_, n) => {
      const k = Number(n) - 1, m = made[k];
      return m && k > 0 ? `![${a.images[k].alt.replace(/[\[\]]/g, '')}](${m.src})` : '';
    }).replace(/\n{3,}/g, '\n\n');
    job.step = 'Đang lưu…';
    job.postId = db.savePost({
      lang: L.code, slug: a.slug, title: a.title, description: a.description, keywords: a.keywords, excerpt: a.excerpt,
      content, faq: a.faq, cover, cover_alt: coverAlt, credit: [...new Set(credits)].join(', '), topic: opts.topic,
      status: opts.publish ? 'published' : 'draft',
    });
    job.status = 'done';
    job.step = opts.publish ? 'Đã đăng bài.' : 'Đã lưu bản nháp.';
  })().catch(e => {
    console.error('[blog] viết bài lỗi:', e);
    job.status = 'error';
    job.error = friendlyError(e);
  });
  return job;
}

module.exports = { capabilities, suggestTopics: o => suggestTopics(o).catch(e => { throw new Error(friendlyError(e)); }),
  startJob, getJob: id => jobs.get(id) || null, makeImage, uniqueSlug, toSlug };
