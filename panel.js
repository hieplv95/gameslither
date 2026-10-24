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
  return applySocial(html
    .replaceAll('{{SEO_TITLE}}', esc(s.title))
    .replaceAll('{{SEO_DESCRIPTION}}', esc(s.description))
    .replaceAll('{{SEO_KEYWORDS}}', esc(s.keywords))
    .replace('{{GSC_META}}', all.gsc ? `<meta name="google-site-verification" content="${esc(all.gsc)}">` : ''));
}

// ---------------------------------------------------------------- mạng xã hội
// Link dùng chung mọi ngôn ngữ, khoá 'social.<mạng>'. Icon SVG nhúng thẳng (viewBox 24×24, tô bằng currentColor).
const SOCIAL = [
  { key: 'facebook', name: 'Facebook', placeholder: 'https://www.facebook.com/…',
    svg: '<path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>' },
  { key: 'youtube', name: 'YouTube', placeholder: 'https://www.youtube.com/@…',
    svg: '<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>' },
  { key: 'tiktok', name: 'TikTok', placeholder: 'https://www.tiktok.com/@…',
    svg: '<path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>' },
  { key: 'x', name: 'X', placeholder: 'https://x.com/…',
    svg: '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/>' },
  { key: 'instagram', name: 'Instagram', placeholder: 'https://www.instagram.com/…',
    svg: '<rect x="2" y="2" width="20" height="20" rx="5.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.7" cy="6.3" r="1.35"/>' },
  { key: 'pinterest', name: 'Pinterest', placeholder: 'https://www.pinterest.com/…',
    svg: '<path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z"/>' },
];
const SOCIAL_MAX = 300;
let socialCache = null;
// { facebook: 'https://…' | '', youtube: …, … }
function social() {
  if (!socialCache) {
    const s = db.getSettings();
    socialCache = Object.fromEntries(SOCIAL.map(n => [n.key, s[`social.${n.key}`] || '']));
  }
  return socialCache;
}
// Rỗng → ''. Thiếu "https://" thì tự thêm. Chỉ nhận http(s). Trả về null nếu không hợp lệ.
function cleanUrl(v) {
  v = String(v).replace(/[\u0000-\u001f\s]/g, '');
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  let u;
  try { u = new URL(v); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || u.username || u.password) return null;
  return u.href.length > SOCIAL_MAX ? null : u.href;
}

// Chân trang: {{SOCIAL_LINKS}} → hàng icon (chỉ mạng đã có link, không có mạng nào thì bỏ trống).
// JSON-LD: Organization có "sameAs":"{{SAME_AS}}" → mảng link, hoặc gỡ hẳn khi chưa có link nào.
function applySocial(html) {
  const s = social(), on = SOCIAL.filter(n => s[n.key]);
  const links = on.map(n => `<a href="${esc(s[n.key])}" target="_blank" rel="noopener me" aria-label="${n.name}" title="${n.name}">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">${n.svg}</svg></a>`).join('');
  return html
    .replaceAll('{{SOCIAL_LINKS}}', on.length ? `<div class="footer-social">${links}</div>` : '')
    .replaceAll(',"sameAs":"{{SAME_AS}}"', on.length ? `,"sameAs":${JSON.stringify(on.map(n => s[n.key])).replace(/</g, '\\u003c')}` : '');
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

  if (route === 'GET /admin/api/settings') {
    json(res, 200, { seo: seo(), defaults: SEO_DEFAULTS, langs: LANG_LIST,
      social: social(), networks: SOCIAL.map(({ key, name, placeholder }) => ({ key, name, placeholder })) });
    return true;
  }

  if (route === 'PUT /admin/api/social') {
    readJson(req).then(body => {
      // body: { social: { facebook: 'https://…', youtube: '', … } }
      const inp = body && body.social;
      if (!inp || typeof inp !== 'object') return json(res, 400, { error: 'Thiếu dữ liệu' });
      const out = {};
      for (const n of SOCIAL) {
        if (typeof inp[n.key] !== 'string') continue;
        const v = cleanUrl(inp[n.key]);
        if (v === null) return json(res, 400, { error: `Link ${n.name} không hợp lệ — cần là địa chỉ http(s)://, tối đa ${SOCIAL_MAX} ký tự.` });
        out[`social.${n.key}`] = v;
      }
      db.setSettings(out);
      socialCache = null;
      json(res, 200, { ok: true, social: social() });
    }).catch(() => json(res, 400, { error: 'Dữ liệu không hợp lệ' }));
    return true;
  }

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
  // Gợi ý chủ đề: các gợi ý được lưu lại (lần sau AI tránh trùng), kèm độ phủ theo nhóm chủ đề
  const ideasPayload = lang => ({ ideas: writer.openIdeas(lang), coverage: db.coverage(lang), clusters: writer.CLUSTERS.map(c => ({ key: c.key, label: c.label })) });
  if (route === 'GET /admin/api/blog/ideas') {
    const lang = new URL(req.url, 'http://x').searchParams.get('lang');
    if (!LANGS.includes(lang)) return json(res, 400, { error: 'Ngôn ngữ không hợp lệ.' });
    return json(res, 200, ideasPayload(lang));
  }
  if (route === 'POST /admin/api/blog/topics') {
    return readJson(req).then(async b => {
      if (!LANGS.includes(b.lang)) throw new Error('Ngôn ngữ không hợp lệ.');
      const keys = new Set(writer.CLUSTERS.map(c => c.key));
      const clusters = (Array.isArray(b.clusters) ? b.clusters : []).filter(c => keys.has(c));
      const count = Math.min(writer.MAX_COUNT, Math.max(5, Number(b.count) || 10));
      const r = await writer.suggestTopics({ lang: b.lang, seed: oneLine(b.seed).slice(0, 300), clusters, count });
      for (const c of r.classified) db.setPostCluster(c.id, c.cluster);
      const fresh = db.saveIdeas(b.lang, r.topics);
      json(res, 200, { fresh: fresh.map(t => t.id), ...ideasPayload(b.lang) });
    }).catch(fail);
  }
  if (route.startsWith('POST /admin/api/blog/ideas/') && route.endsWith('/dismiss')) {
    const idea = db.getIdea(Number(route.slice('POST /admin/api/blog/ideas/'.length, -'/dismiss'.length)));
    if (!idea) return json(res, 404, { error: 'Không tìm thấy gợi ý' });
    db.setIdeaStatus(idea.id, 'dismissed');
    return json(res, 200, ideasPayload(idea.lang));
  }
  if (route === 'POST /admin/api/blog/generate') {
    return readJson(req).then(b => {
      const topic = oneLine(b.topic).slice(0, 300);
      if (!topic) throw new Error('Hãy nhập hoặc chọn một chủ đề.');
      if (!LANGS.includes(b.lang)) throw new Error('Ngôn ngữ không hợp lệ.');
      // viết từ một gợi ý đã lưu → gợi ý thành "đã viết" (ẩn khỏi danh sách), bài được gắn nhóm chủ đề.
      // Không có ideaId (đã sửa chữ sau khi bấm gợi ý) thì tìm gợi ý đang chờ khớp với chủ đề.
      const keyword = oneLine(b.keyword).slice(0, 120);
      let idea = b.ideaId ? db.getIdea(Number(b.ideaId)) : null;
      if (!idea || idea.lang !== b.lang || idea.status !== 'suggested') idea = writer.matchIdea(b.lang, topic, keyword);
      const job = writer.startJob({
        cluster: idea ? idea.cluster : '',
        ideaId: idea ? idea.id : 0,
        lang: b.lang, topic, keyword, notes: String(b.notes || '').slice(0, 2000),
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
  const html = applySocial(blog.renderPost(blog.BY_CODE.get(post.lang) || LOCALES[0], post, { preview: true }).replaceAll('{{SITE_URL}}', ''));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  res.end(html);
}

module.exports = { handle, applySeo, applySocial, trackVisit, countryOf };
