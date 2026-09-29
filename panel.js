'use strict';
// Trang quản trị: đăng nhập admin, API thống kê + cài đặt SEO, ghi nhận lượt truy cập.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

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
    const asked = Number(new URL(req.url, 'http://x').searchParams.get('days'));
    const days = [7, 30, 90].includes(asked) ? asked : 30;
    json(res, 200, { ...db.stats(days), live: getLive(), geo: geoip ? 'geoip-lite' : 'cdn-header' });
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

  json(res, 404, { error: 'Không tìm thấy' });
  return true;
}

module.exports = { handle, applySeo, trackVisit, countryOf };
