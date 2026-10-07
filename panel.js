'use strict';
// Trang quản trị: đăng nhập admin, API thống kê + cài đặt SEO, ghi nhận lượt truy cập.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const blog = require('./blog');
const writer = require('./writer');

const ADMIN_DIR = path.join(__dirname, 'admin');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Mật khẩu mặc định khi chưa đổi lần nào. Đăng nhập bằng mật khẩu này sẽ bị buộc đổi ngay.
const DEFAULT_PASSWORD = '12345678';
const MIN_PASSWORD = 8;
const SESSION_MS = 12 * 3600_000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60_000;

// Mật khẩu lưu dạng băm scrypt (kèm muối riêng) trong bảng settings, khoá 'admin.pass'.
function hashPassword(pw, salt = crypto.randomBytes(16)) {
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
}
// Nếu chưa đổi mật khẩu: dùng ADMIN_PASSWORD trong .env (nếu có), không thì mật khẩu mặc định.
const INITIAL_HASH = hashPassword(process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD);
const storedHash = () => db.getSettings()['admin.pass'] || INITIAL_HASH;
const mustChange = () => !db.getSettings()['admin.pass'] && !process.env.ADMIN_PASSWORD;

const USER_SALT = crypto.randomBytes(16);
const USER_HASH = crypto.scryptSync(ADMIN_USER, USER_SALT, 64);
const sameUser = u => crypto.timingSafeEqual(crypto.scryptSync(String(u), USER_SALT, 64), USER_HASH);
const sessions = new Map();   // token -> hết hạn
const fails = new Map();      // ip -> { n, until }

// ---------------------------------------------------------------- SEO mặc định
// Mỗi ngôn ngữ có tiêu đề/mô tả/từ khoá riêng. "Slither io" chỉ dùng để mô tả thể loại
// ("Slither io style", "kiểu Slither io"), không tự nhận là game Slither.io chính chủ.
// Giá trị mặc định lấy từ locales/<mã>.js → seo.
const LOCALES = require('./locales');
const LANGS = LOCALES.map(L => L.code);
const LANG_LIST = LOCALES.map(L => ({ code: L.code, name: L.name, path: L.path }));
const SEO_FIELDS = ['title', 'description', 'keywords'];
const SEO_DEFAULTS = { gsc: '' };
for (const L of LOCALES) SEO_DEFAULTS[L.code] = { ...L.seo };
const LIMITS = { title: 120, description: 320, keywords: 400, gsc: 120 };
let seoCache = null;
// { en: {title, description, keywords}, vi: {...}, gsc }
function seo() {
  if (!seoCache) {
    const s = db.getSettings();
    seoCache = { gsc: s['seo.gsc'] ?? SEO_DEFAULTS.gsc };
    for (const l of LANGS) {
      seoCache[l] = {};
      for (const k of SEO_FIELDS) seoCache[l][k] = s[`seo.${l}.${k}`] ?? SEO_DEFAULTS[l][k];
    }
  }
  return seoCache;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Điền tiêu đề / mô tả / từ khoá / mã Search Console vào trang theo ngôn ngữ của trang
function applySeo(html, lang = 'en') {
  const all = seo(), s = all[LANGS.includes(lang) ? lang : 'en'];
  return html
    .replaceAll('{{SEO_TITLE}}', esc(s.title))
    .replaceAll('{{SEO_DESCRIPTION}}', esc(s.description))
    .replaceAll('{{SEO_KEYWORDS}}', esc(s.keywords))
    .replace('{{GSC_META}}', all.gsc ? `<meta name="google-site-verification" content="${esc(all.gsc)}">` : '');
}

// ---------------------------------------------------------------- nhận diện khách
let geoip = null;
try { geoip = require('geoip-lite'); } catch { /* không bắt buộc */ }

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
}
// Ưu tiên header quốc gia do CDN gắn (Cloudflare, Vercel, CloudFront); không có thì tra geoip-lite nếu đã cài.
function countryOf(req) {
  const h = req.headers;
  const c = String(h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['cloudfront-viewer-country'] || h['x-country-code'] || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1') return c;
  if (geoip) { const g = geoip.lookup(clientIp(req)); if (g && g.country) return g.country; }
  return 'XX';
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|lighthouse|headless|curl|wget|python-requests/i;
function deviceOf(ua) {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Ghi 1 lượt xem trang chủ. Trả về header Set-Cookie (nếu khách mới) để gắn vào phản hồi.
function trackVisit(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) return null;
  const cookies = parseCookies(req);
  let vid = /^[a-f0-9]{24}$/.test(cookies.vid || '') ? cookies.vid : null;
  const isNew = !vid;
  if (isNew) vid = crypto.randomBytes(12).toString('hex');
  let ref = '';
  try {
    const r = new URL(req.headers.referer || '');
    if (r.host && r.host !== req.headers.host) ref = r.host.replace(/^www\./, '');
  } catch { /* không có referer */ }
  db.recordVisit({ vid, country: countryOf(req), device: deviceOf(ua), ref });
  return isNew ? `vid=${vid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` : null;
}

// ---------------------------------------------------------------- HTTP helpers
// Khoảng thống kê (ngày theo giờ Việt Nam, mặc định hôm nay): range = today | yesterday | week (từ thứ Hai) | month | custom (from, to).
// Kèm kỳ trước để so sánh: hôm qua / hôm kia / tuần trước / tháng trước (cùng số ngày) / đoạn liền trước cùng độ dài.
// Trả về null nếu khoảng tuỳ chỉnh không hợp lệ.
const DAY_MS = 86400_000;
const dayNum = d => Date.parse(d + 'T00:00:00Z') / DAY_MS;            // YYYY-MM-DD -> số ngày
const numDay = n => new Date(n * DAY_MS).toISOString().slice(0, 10);   // ngược lại
function statsRange(params) {
  const today = db.dayOf(Date.now()), t = dayNum(today);
  const range = params.get('range') || 'today';
  const shift = (from, to, k) => ({ prevFrom: numDay(dayNum(from) - k), prevTo: numDay(dayNum(to) - k) });
  if (range === 'today') return { range, from: today, to: today, ...shift(today, today, 1) };
  if (range === 'yesterday') { const y = numDay(t - 1); return { range, from: y, to: y, ...shift(y, y, 1) }; }
  if (range === 'week') { const w = db.weekOf(Date.now()); return { range, from: w, to: today, ...shift(w, today, 7) }; }
  if (range === 'custom') {
    const from = params.get('from'), to = params.get('to');
    const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(dayNum(d));
    if (!ok(from) || !ok(to) || from > to || to > today || dayNum(to) - dayNum(from) > 365) return null;
    const len = dayNum(to) - dayNum(from) + 1;
    return { range, from, to, ...shift(from, to, len) };
  }
  // tháng này: ngày 1 → hôm nay; so với cùng các ngày của tháng trước (tháng trước ngắn hơn thì dừng ở ngày cuối tháng)
  const [y, m, d] = today.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  const lastPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  return { range: 'month', from: `${y}-${pad(m)}-01`, to: today,
    prevFrom: `${py}-${pad(pm)}-01`, prevTo: `${py}-${pad(pm)}-${pad(Math.min(d, lastPrev))}` };
}

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...extra });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function isAuthed(req) {
  const t = parseCookies(req).adm;
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
const secureFlag = req => (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '');

const ADMIN_FILES = { '/admin': 'index.html', '/admin/': 'index.html', '/admin/app.js': 'app.js', '/admin/style.css': 'style.css' };
const ADMIN_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * Xử lý mọi request /admin*. Trả về true nếu đã xử lý.
 * getLive(): { online, playing } — số liệu thời gian thực từ server game.
 */
function handle(req, res, p, getLive) {
  if (p !== '/admin' && !p.startsWith('/admin/')) return false;

  if (ADMIN_FILES[p]) {
    const file = path.join(ADMIN_DIR, ADMIN_FILES[p]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': ADMIN_MIME[path.extname(file)], 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return true;
  }
  if (req.method === 'GET' && p.startsWith('/admin/preview/')) { preview(req, res, p); return true; }
  if (!p.startsWith('/admin/api/')) { res.writeHead(404); res.end(); return true; }

  // Chống CSRF: mọi request ghi phải có header tuỳ chỉnh (trình duyệt không tự gửi từ trang khác).
  if (req.method !== 'GET' && req.headers['x-admin'] !== '1') { json(res, 403, { error: 'Bị từ chối' }); return true; }
  const route = `${req.method} ${p}`;

  if (route === 'POST /admin/api/login') {
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) {
      json(res, 429, { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil((f.until - Date.now()) / 60000)} phút.` });
      return true;
    }
    readJson(req).then(body => {
      const okUser = sameUser(body.username || '');
      const okPass = checkPassword(body.password || '', storedHash());
      if (!(okUser && okPass)) {
        const lockExpired = f && f.until && f.until <= Date.now();   // đã hết thời gian khoá → đếm lại từ đầu
        const n = (f && !lockExpired ? f.n : 0) + 1;
        fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        return json(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      json(res, 200, { ok: true, mustChange: mustChange() }, { 'Set-Cookie': `adm=${token}; Path=/admin; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict${secureFlag(req)}` });
    }).catch(() => json(res, 400, { error: 'Dữ liệu không hợp lệ' }));
    return true;
  }

  if (route === 'POST /admin/api/logout') {
    sessions.delete(parseCookies(req).adm);
    json(res, 200, { ok: true }, { 'Set-Cookie': 'adm=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict' });
    return true;
  }

  if (!isAuthed(req)) { json(res, 401, { error: 'Chưa đăng nhập' }); return true; }

  if (route === 'GET /admin/api/me') { json(res, 200, { user: ADMIN_USER, mustChange: mustChange() }); return true; }

  if (route === 'PUT /admin/api/password') {
    readJson(req).then(body => {
      const cur = String(body.current || ''), next = String(body.next || '');
      if (!checkPassword(cur, storedHash())) return json(res, 400, { error: 'Mật khẩu hiện tại không đúng.' });
      if (next.length < MIN_PASSWORD) return json(res, 400, { error: `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD} ký tự.` });
      if (next.length > 200) return json(res, 400, { error: 'Mật khẩu mới quá dài.' });
      if (next === DEFAULT_PASSWORD) return json(res, 400, { error: 'Không được dùng lại mật khẩu mặc định.' });
      if (next === cur) return json(res, 400, { error: 'Mật khẩu mới phải khác mật khẩu hiện tại.' });
      db.setSettings({ 'admin.pass': hashPassword(next) });
      // đăng xuất mọi phiên khác, giữ phiên hiện tại
      const mine = parseCookies(req).adm;
      for (const t of sessions.keys()) if (t !== mine) sessions.delete(t);
      json(res, 200, { ok: true });
    }).catch(() => json(res, 400, { error: 'Dữ liệu không hợp lệ' }));
    return true;
  }

  // Còn dùng mật khẩu mặc định thì chỉ được đổi mật khẩu hoặc đăng xuất.
  if (mustChange()) { json(res, 403, { error: 'Hãy đổi mật khẩu mặc định trước.', mustChange: true }); return true; }

  if (route === 'GET /admin/api/stats') {
    const r = statsRange(new URL(req.url, 'http://x').searchParams);
    if (!r) { json(res, 400, { error: 'Khoảng ngày không hợp lệ (tối đa 366 ngày, không quá hôm nay).' }); return true; }
    json(res, 200, { ...db.stats(r), range: r.range, live: getLive(), geo: geoip ? 'geoip-lite' : 'cdn-header' });
    return true;
  }

  if (route === 'GET /admin/api/settings') { json(res, 200, { seo: seo(), defaults: SEO_DEFAULTS, langs: LANG_LIST }); return true; }

  if (route === 'PUT /admin/api/settings') {
    readJson(req).then(body => {
      // body: { seo: { lang: 'en'|'vi', title, description, keywords, gsc } }
      const inp = body && body.seo;
      if (!inp || typeof inp !== 'object' || !LANGS.includes(inp.lang)) return json(res, 400, { error: 'Thiếu dữ liệu' });
      const out = {};
      for (const k of [...SEO_FIELDS, 'gsc']) {
        if (typeof inp[k] !== 'string') continue;
        let v = inp[k].replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (k === 'gsc') { const m = v.match(/content=["']([^"']+)["']/); if (m) v = m[1]; }  // dán cả thẻ meta cũng được
        if (v.length > LIMITS[k]) return json(res, 400, { error: `"${k}" dài quá ${LIMITS[k]} ký tự.` });
        if ((k === 'title' || k === 'description') && !v) return json(res, 400, { error: 'Tiêu đề và mô tả không được để trống.' });
        if (k === 'gsc' && v && !/^[A-Za-z0-9_\-]{10,100}$/.test(v)) return json(res, 400, { error: 'Mã xác minh Google Search Console không hợp lệ.' });
        out[k === 'gsc' ? 'seo.gsc' : `seo.${inp.lang}.${k}`] = v;
      }
      db.setSettings(out);
      seoCache = null;
      json(res, 200, { ok: true, seo: seo() });
    }).catch(() => json(res, 400, { error: 'Dữ liệu không hợp lệ' }));
    return true;
  }

  if (p.startsWith('/admin/api/blog')) { handleBlog(req, res, route); return true; }

  json(res, 404, { error: 'Không tìm thấy' });
  return true;
}

// ---------------------------------------------------------------- blog
const BLOG_LIMITS = { title: 120, description: 320, keywords: 400, excerpt: 300, content: 100_000, cover_alt: 160, credit: 500, topic: 300 };
const oneLine = s => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const MAX_UPLOAD = 6 * 1024 * 1024;
const IMG_MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

// Kiểm tra + chuẩn hoá bài gửi lên từ trình soạn thảo. Trả về { post } hoặc { error }.
function validatePost(b, id = 0) {
  const post = {};
  if (!LANGS.includes(b.lang)) return { error: 'Ngôn ngữ không hợp lệ.' };
  post.lang = b.lang;
  for (const k of ['title', 'description', 'keywords', 'excerpt', 'cover_alt', 'credit', 'topic']) {
    post[k] = oneLine(b[k]);
    if (post[k].length > BLOG_LIMITS[k]) return { error: `"${k}" dài quá ${BLOG_LIMITS[k]} ký tự.` };
  }
  if (!post.title) return { error: 'Tiêu đề không được để trống.' };
  post.content = String(b.content ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (post.content.length > BLOG_LIMITS.content) return { error: 'Nội dung quá dài.' };
  post.slug = writer.toSlug(b.slug || post.title);
  if (!blog.SLUG_RE.test(post.slug)) return { error: 'Đường dẫn (slug) chỉ gồm chữ thường không dấu, số và dấu gạch ngang.' };
  if (db.slugTaken(post.lang, post.slug, id)) return { error: 'Đường dẫn này đã có bài khác dùng.' };
  post.cover = String(b.cover || '');
  if (post.cover && !(post.cover.startsWith('/media/') && blog.MEDIA_RE.test(post.cover.slice(7)))) return { error: 'Ảnh bìa không hợp lệ.' };
  post.faq = (Array.isArray(b.faq) ? b.faq : []).filter(f => Array.isArray(f)).map(f => [oneLine(f[0]).slice(0, 300), oneLine(f[1]).slice(0, 1200)])
    .filter(f => f[0] && f[1]).slice(0, 12);
  post.status = b.status === 'published' ? 'published' : 'draft';
  if (post.status === 'published' && !post.description) return { error: 'Cần có mô tả (meta description) trước khi đăng.' };
  return { post };
}

function decodeUpload(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD || !IMG_MAGIC[ext].every((v, i) => buf[i] === v)) return null;
  return { buf, ext };
}

function handleBlog(req, res, route) {
  const fail = e => json(res, 400, { error: e.message || 'Dữ liệu không hợp lệ' });
  const idOf = pre => { const m = route.slice(pre.length).match(/^(\d+)$/); return m ? Number(m[1]) : 0; };

  if (route === 'GET /admin/api/blog') {
    return json(res, 200, { posts: db.listPosts(), caps: writer.capabilities(), langs: LANG_LIST });
  }
  if (route.startsWith('GET /admin/api/blog/post/')) {
    const post = db.getPost(idOf('GET /admin/api/blog/post/'));
    return post ? json(res, 200, { post }) : json(res, 404, { error: 'Không tìm thấy bài' });
  }
  if (route === 'POST /admin/api/blog/post' || route.startsWith('PUT /admin/api/blog/post/')) {
    const id = req.method === 'PUT' ? idOf('PUT /admin/api/blog/post/') : 0;
    if (req.method === 'PUT' && !db.getPost(id)) return json(res, 404, { error: 'Không tìm thấy bài' });
    return readJson(req, 256 * 1024).then(b => {
      const { post, error } = validatePost(b || {}, id);
      if (error) return json(res, 400, { error });
      const saved = db.savePost(post, id);
      json(res, 200, { ok: true, post: db.getPost(saved) });
    }).catch(fail);
  }
  if (route.startsWith('DELETE /admin/api/blog/post/')) {
    db.deletePost(idOf('DELETE /admin/api/blog/post/'));
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /admin/api/blog/topics') {
    return readJson(req).then(b => writer.suggestTopics({ lang: b.lang, seed: oneLine(b.seed).slice(0, 300), count: 10 }))
      .then(topics => json(res, 200, { topics })).catch(fail);
  }
  if (route === 'POST /admin/api/blog/generate') {
    return readJson(req).then(b => {
      const topic = oneLine(b.topic).slice(0, 300);
      if (!topic) throw new Error('Hãy nhập hoặc chọn một chủ đề.');
      if (!LANGS.includes(b.lang)) throw new Error('Ngôn ngữ không hợp lệ.');
      const job = writer.startJob({
        lang: b.lang, topic, keyword: oneLine(b.keyword).slice(0, 120), notes: String(b.notes || '').slice(0, 2000),
        length: ['short', 'medium', 'long'].includes(b.length) ? b.length : 'medium',
        tone: ['friendly', 'expert', 'news', 'beginner'].includes(b.tone) ? b.tone : 'friendly',
        images: Math.max(1, Math.min(4, Number(b.images) || 2)), publish: !!b.publish,
      });
      json(res, 200, { job });
    }).catch(fail);
  }
  if (route.startsWith('GET /admin/api/blog/job/')) {
    const job = writer.getJob(route.slice('GET /admin/api/blog/job/'.length));
    return job ? json(res, 200, { job }) : json(res, 404, { error: 'Không tìm thấy tác vụ' });
  }
  // Tải ảnh lên (dạng data URL base64) → /media/…
  if (route === 'POST /admin/api/blog/image') {
    return readJson(req, MAX_UPLOAD * 1.4 + 1024).then(b => {
      const up = decodeUpload(b.data);
      if (!up) return json(res, 400, { error: 'Chỉ nhận ảnh PNG, JPG hoặc WebP, tối đa 6 MB.' });
      json(res, 200, { src: blog.saveMedia(up.buf, up.ext, writer.toSlug(b.name || 'anh')) });
    }).catch(() => json(res, 400, { error: 'Ảnh quá lớn hoặc không hợp lệ.' }));
  }
  // Tạo ảnh bằng AI / ảnh kho theo mô tả
  if (route === 'POST /admin/api/blog/image/ai') {
    return readJson(req).then(async b => {
      const prompt = String(b.prompt || '').slice(0, 1500).trim();
      if (!prompt) throw new Error('Hãy nhập mô tả ảnh.');
      if (!b.cover && writer.capabilities().image === 'svg') throw new Error('Cần VERTEX_KEY_FILE, OPENAI_API_KEY hoặc PEXELS_API_KEY trong .env để tạo ảnh chèn vào bài.');
      const slug = writer.toSlug(b.slug || 'anh') || 'anh';
      const img = await writer.makeImage({ prompt, query: prompt.split(/\s+/).slice(0, 4).join(' ') },
        { slug, title: oneLine(b.title) || prompt, cover: !!b.cover, strict: true });
      if (!img) throw new Error('Không tạo được ảnh (xem log server).');
      json(res, 200, img);
    }).catch(fail);
  }
  json(res, 404, { error: 'Không tìm thấy' });
}

// Xem trước bài (kể cả bản nháp) — chỉ admin đã đăng nhập, không cho Google lập chỉ mục.
function preview(req, res, p) {
  if (!isAuthed(req) || mustChange()) { res.writeHead(302, { Location: '/admin' }); res.end(); return; }
  const post = db.getPost(Number(p.slice('/admin/preview/'.length)) || 0);
  if (!post) { res.writeHead(404); res.end('Không tìm thấy bài'); return; }
  const html = blog.renderPost(blog.BY_CODE.get(post.lang) || LOCALES[0], post, { preview: true }).replaceAll('{{SITE_URL}}', '');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  res.end(html);
}

module.exports = { handle, applySeo, trackVisit, countryOf };
