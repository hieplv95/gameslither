'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const panel = require('./panel');
const { Room, send, TICK_RATE, START_MASS, CLASSIC, FREE_SKINS, SKIN_COUNT } = require('./room');

// ---------------------------------------------------------------- config
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';           // trên VPS đặt 127.0.0.1 để chỉ Nginx truy cập được
const PROD = process.env.NODE_ENV === 'production';
const PAID_ENABLED = process.env.PAID_MODE === '1';    // chế độ chơi mất phí + ví: mặc định TẮT
const DEMO = process.env.DEMO !== '0';                 // bật nút "Nạp thử" (tiền ảo)
const PAID_ROOM_SIZE = Math.max(2, Number(process.env.PAID_ROOM_SIZE) || 15);
const FEE_PERCENT = 5;
const STAKES = [1, 5, 10];                              // USDT
const COUNTDOWN_MS = 10_000;
const FREE_CAP = 50;
// Số "đang online" ở sảnh = ONLINE_BASE + số kết nối thật (trang quản trị vẫn dùng số thật). Đặt ONLINE_BASE=0 để hiện đúng số thật.
const ONLINE_BASE = Math.max(0, Math.floor(Number(process.env.ONLINE_BASE ?? 500)) || 0);
const FREE_BOTS = 18;
const MIN_WITHDRAW = 2;                                 // USDT
const U = db.UNIT;
// Cửa hàng mẫu rắn: xu chỉ kiếm được ở phòng miễn phí, cộng khi rắn chết.
const COINS_PER_LENGTH = 10;                            // +1 xu cho mỗi 10 độ dài đạt được (tính từ độ dài lúc mới vào)
const KILL_COINS = 5;                                   // +5 xu cho mỗi con rắn hạ gục
const SKIN_PRICE = 500;                                 // giá mỗi mẫu cờ (xu)
const SHOP = new Map();                                 // mẫu -> giá; các mẫu từ FREE_SKINS trở đi phải mua
for (let k = FREE_SKINS; k < SKIN_COUNT; k++) SHOP.set(k, SKIN_PRICE);

// ---------------------------------------------------------------- static files
const PUBLIC = path.join(__dirname, 'public');
// Địa chỉ website thật (không có dấu / cuối), dùng cho thẻ canonical, Open Graph và sitemap.
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};
// Trang chủ các ngôn ngữ dựng sẵn trong pages.js (tiếng Anh ở /, các ngôn ngữ khác ở /<mã>/)
const { LOCALES, PAGES } = require('./pages');
const LOCALE_BY_CODE = new Map(LOCALES.map(L => [L.code, L]));
const REDIRECTS = { '/index.html': '/' };
for (const L of LOCALES) if (L.path !== '/') { REDIRECTS[L.path.slice(0, -1)] = L.path; REDIRECTS[L.path + 'index.html'] = L.path; }
const SEO_FILES = require('./seo-files')(SITE_URL);
const blog = require('./blog');
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (REDIRECTS[p]) { res.writeHead(301, { Location: REDIRECTS[p] }); return res.end(); } // tránh trùng lặp nội dung
  if (panel.handle(req, res, p, liveStats)) return;
  if (SEO_FILES[p]) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] });
    return res.end(SEO_FILES[p]());
  }
  if (p.startsWith('/media/')) return blog.serveMedia(res, p);
  const b = blog.route(p);
  if (b) {
    if (b.location) { res.writeHead(301, { Location: b.location }); return res.end(); }
    res.writeHead(b.code, { 'Content-Type': b.type });
    return res.end(b.body.replaceAll('{{SITE_URL}}', SITE_URL));
  }
  const page = PAGES.get(p);
  if (page) {
    const headers = { 'Content-Type': MIME['.html'] };
    // menu "Blog" + khối bài mới nhất chỉ hiện khi ngôn ngữ này đã có bài
    let html = panel.applySeo(blog.injectHome(page.html, page.lang).replaceAll('{{SITE_URL}}', SITE_URL), page.lang);
    // Tắt chế độ mất phí: gỡ hẳn các khối liên quan khỏi trang, không chỉ ẩn bằng CSS
    html = PAID_ENABLED
      ? html.replaceAll('<!--PAID-->', '').replaceAll('<!--/PAID-->', '')
      : html.replace(/<!--PAID-->[\s\S]*?<!--\/PAID-->/g, '');
    if (req.method === 'GET') {
      const cookie = panel.trackVisit(req);
      if (cookie) headers['Set-Cookie'] = cookie;
    }
    res.writeHead(200, headers);
    return res.end(html);
  }
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page not found'); }
    const ext = path.extname(file);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---------------------------------------------------------------- rooms
const uid = () => crypto.randomBytes(6).toString('hex');
const makeCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)];
  return freeRooms.has(s) ? makeCode() : s;
};

const freeRooms = new Map();   // code -> Room
const paidRooms = new Set();   // phòng mất phí đang đếm ngược / đang chơi / vừa kết thúc
const queues = new Map();      // stake -> { ref, members: Map<accountId, client>, countdownAt }
const inPaid = new Map();      // accountId -> client (mỗi tài khoản chỉ được 1 ghế mất phí)
const clients = new Set();

function liveStats() {
  let playing = 0;
  for (const r of freeRooms.values()) playing += r.humanCount();
  for (const r of paidRooms) playing += r.humanCount();
  return { online: clients.size, playing };
}

function createFreeRoom(isPublic) {
  const code = makeCode();
  const room = new Room({ uid: uid(), code, mode: 'free', worldR: 4000, bots: FREE_BOTS, cap: FREE_CAP });
  room.onDeath = rewardCoins;
  room.isPublic = isPublic;
  room.emptySince = Date.now();
  freeRooms.set(code, room);
  return room;
}
createFreeRoom(true);

function newQueue(stake) {
  const q = { stake, ref: `room:${uid()}`, members: new Map(), countdownAt: 0 };
  queues.set(stake, q);
  return q;
}
for (const s of STAKES) newQueue(s);

function leaveRoom(c) {
  if (c.room) {
    c.room.clients.delete(c);
    if (c.snake && c.snake.alive && c.room.snakes.get(c.snake.id) === c.snake) c.room.killSnake(c.snake, null);
    if (c.room.mode === 'free' && !c.room.clients.size) c.room.emptySince = Date.now();
  }
  c.room = null;
  c.snake = null;
  c.known = new Set();
  c.vx = undefined;
}

// Thông báo gửi cho người chơi theo ngôn ngữ trang họ đang mở (locales/<mã>.js → server)
const M = (c, key, vars = {}) => String((LOCALE_BY_CODE.get(c.lang) || LOCALES[0]).server[key]).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

function sanitizeName(n) {
  return (typeof n === 'string' ? n : '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Guest';
}
// Mẫu rắn + màu (màu chỉ dùng cho mẫu Cổ điển). Mẫu phải mua mà tài khoản chưa có → Cổ điển.
function sanitizeLook(m, acct) {
  let k = Math.floor(Number(m.skin));
  if (!(k >= 0 && k < SKIN_COUNT)) k = Math.floor(Math.random() * FREE_SKINS);
  if (k >= FREE_SKINS && !db.ownsSkin(acct, k)) k = CLASSIC;
  let h = Math.floor(Number(m.hue));
  if (!Number.isFinite(h)) h = Math.floor(Math.random() * 360);
  return { skin: k, hue: ((h % 360) + 360) % 360 };
}
function sendBalance(c) {
  if (c.acct) send(c, { t: 'bal', bal: db.balance(c.acct) });
}

// ---------------------------------------------------------------- xu & cửa hàng
// Gọi khi rắn của người chơi chết trong phòng miễn phí; kết quả được gửi kèm tin 'dead'.
function rewardCoins(s) {
  const acct = s.client && s.client.acct;
  if (!acct) return null;
  const earned = Math.floor((s.peak - START_MASS) / COINS_PER_LENGTH) + s.kills * KILL_COINS;
  return { earned, coins: earned > 0 ? db.addCoins(acct, earned) : db.coins(acct) };
}

function buySkin(c, m) {
  const skin = Math.floor(Number(m.skin));
  const price = SHOP.get(skin);
  if (!price) return;
  const r = db.buySkin(c.acct, skin, price);
  if (r === 'noCoins') return send(c, { t: 'err', msg: M(c, 'noCoins') });
  send(c, { t: 'shop', coins: db.coins(c.acct), owned: db.ownedSkins(c.acct), bought: r === 'ok' ? skin : undefined });
}

// ---------------------------------------------------------------- free play
function joinFree(c, m) {
  if (c.queue) return send(c, { t: 'err', msg: M(c, 'inQueue') });
  let room;
  if (m.create) room = createFreeRoom(false);
  else if (typeof m.code === 'string' && m.code) {
    room = freeRooms.get(m.code.toUpperCase().trim());
    if (!room) return send(c, { t: 'err', msg: M(c, 'noRoom') });
  } else if (c.room && c.room.mode === 'free') room = c.room;
  else {
    // Chơi ngay: vào phòng công khai đông nhất còn chỗ
    room = [...freeRooms.values()].filter(r => r.isPublic && r.humanCount() < r.cap)
      .sort((a, b) => b.humanCount() - a.humanCount())[0] || createFreeRoom(true);
  }
  if (room.humanCount() >= room.cap && c.room !== room) return send(c, { t: 'err', msg: M(c, 'roomFull') });
  if (c.room !== room) { leaveRoom(c); room.clients.add(c); c.room = room; }
  if (c.snake && c.snake.alive) return;
  c.snake = room.spawnSnake(sanitizeName(m.name), sanitizeLook(m, c.acct), false, c);
  db.recordPlay('free', c.country);
  c.known = new Set();
  send(c, { t: 'init', id: c.snake.id, wr: room.baseR, mode: 'free', code: room.code });
}

// ---------------------------------------------------------------- paid play
function queueInfo(q) {
  return { t: 'queue', stake: q.stake, n: q.members.size, size: PAID_ROOM_SIZE,
    countdown: q.countdownAt ? Math.max(0, Math.ceil((q.countdownAt - Date.now()) / 1000)) : 0,
    prize: (q.stake * U * PAID_ROOM_SIZE * (100 - FEE_PERCENT)) / 100 };
}
function broadcastQueue(q) {
  const info = queueInfo(q);
  for (const c of q.members.values()) send(c, info);
}

function joinPaid(c, m) {
  const stake = Number(m.stake);
  if (!STAKES.includes(stake)) return;
  if (!c.acct) return;
  if (inPaid.has(c.acct)) return send(c, { t: 'err', msg: M(c, 'hasSeat') });
  const q = queues.get(stake);
  if (q.members.size >= PAID_ROOM_SIZE) return send(c, { t: 'err', msg: M(c, 'starting') });
  if (PROD) {
    for (const o of q.members.values()) {
      if (o.ip === c.ip) return send(c, { t: 'err', msg: M(c, 'sameNet') });
    }
  }
  if (!db.chargeEntry(c.acct, stake * U, q.ref)) return send(c, { t: 'err', msg: M(c, 'noFunds') });
  leaveRoom(c);
  c.queue = q;
  c.paidName = sanitizeName(m.name);
  c.paidLook = sanitizeLook(m, c.acct);
  q.members.set(c.acct, c);
  inPaid.set(c.acct, c);
  sendBalance(c);
  if (q.members.size >= PAID_ROOM_SIZE && !q.countdownAt) q.countdownAt = Date.now() + COUNTDOWN_MS;
  broadcastQueue(q);
}

function leaveQueue(c) {
  const q = c.queue;
  if (!q) return;
  q.members.delete(c.acct);
  inPaid.delete(c.acct);
  c.queue = null;
  db.refundEntry(c.acct, q.ref);
  sendBalance(c);
  send(c, { t: 'queueLeft' });
  if (q.members.size < PAID_ROOM_SIZE) q.countdownAt = 0;
  broadcastQueue(q);
}

// Nhả ghế mất phí của tài khoản (khi đã bị loại hoặc trận kết thúc) để có thể vào trận khác.
function releaseSeat(acct, room) {
  const c = inPaid.get(acct);
  if (c && c.room === room) inPaid.delete(acct);
}

function startPaidMatch(q) {
  const members = [...q.members.entries()];
  newQueue(q.stake);
  const pot = q.stake * U * members.length;
  const room = new Room({
    uid: q.ref, code: null, mode: 'paid', worldR: 1600 + members.length * 60, bots: 0,
    shrink: { startAt: 45, endAt: 240, minR: 300 }, timeLimit: 300,
  });
  room.stake = q.stake;
  room.players = members.length;
  room.pot = pot;
  room.prize = pot - Math.floor(pot * FEE_PERCENT / 100);
  room.matchId = db.startMatch(q.ref, q.stake * U, members.length);
  room.accounts = new Map();
  room.start(Date.now());
  paidRooms.add(room);

  members.forEach(([acct, c], i) => {
    c.queue = null;
    c.room = room;
    room.clients.add(c);
    c.snake = room.spawnSnake(c.paidName, c.paidLook, false, c, { index: i, total: members.length });
    db.recordPlay('paid', c.country);
    room.accounts.set(c.snake.id, acct);
    c.known = new Set();
    send(c, { t: 'init', id: c.snake.id, wr: room.baseR, mode: 'paid', stake: q.stake, prize: room.prize });
  });

  room.onFinish = winner => {
    const winAcct = room.accounts.get(winner.id);
    const { prize } = db.settleMatch(room.matchId, room.uid, winAcct, pot, FEE_PERCENT);
    for (const acct of room.accounts.values()) releaseSeat(acct, room);
    for (const c of room.clients) {
      send(c, { t: 'result', winner: winner.name, prize, won: c.acct === winAcct });
      sendBalance(c);
    }
    console.log(`[match ${room.matchId}] ${q.stake} USDT x${members.length} → thắng: ${winner.name} (acct ${winAcct}), thưởng ${prize / U}`);
    setTimeout(() => {
      for (const c of room.clients) if (c.room === room) { c.room = null; c.snake = null; c.vx = undefined; }
      paidRooms.delete(room);
    }, 3000);
  };
}

// ---------------------------------------------------------------- wallet
function withdraw(c, m) {
  const amount = Math.round(Number(m.amount) * 100) / 100;
  const address = typeof m.address === 'string' ? m.address.trim() : '';
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAW) return send(c, { t: 'err', msg: M(c, 'minWd', { min: MIN_WITHDRAW }) });
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return send(c, { t: 'err', msg: M(c, 'badAddr') });
  if (c.queue || inPaid.has(c.acct)) return send(c, { t: 'err', msg: M(c, 'wdInPaid') });
  const id = db.requestWithdrawal(c.acct, Math.round(amount * U), address);
  if (!id) return send(c, { t: 'err', msg: M(c, 'noFunds2') });
  sendBalance(c);
  send(c, { t: 'ok', msg: M(c, 'wdOk', { id, amount }) });
}

function faucet(c) {
  if (!DEMO) return;
  if (db.balance(c.acct) >= 100 * U) return send(c, { t: 'err', msg: M(c, 'demoMax') });
  db.deposit(c.acct, 10 * U, 'demo-faucet');
  sendBalance(c);
}

// ---------------------------------------------------------------- lobby
function lobbyInfo() {
  const free = [...freeRooms.values()].filter(r => r.isPublic).map(r => [r.code, r.humanCount(), r.cap]);
  const tiers = PAID_ENABLED ? STAKES.map(s => [s, queues.get(s).members.size, PAID_ROOM_SIZE]) : [];
  let playing = 0;
  for (const r of paidRooms) playing += r.humanCount();
  return { t: 'lobby', free, tiers, online: ONLINE_BASE + clients.size, paidPlaying: playing,
    paid: PAID_ENABLED, fee: FEE_PERCENT, demo: DEMO, minWithdraw: MIN_WITHDRAW };
}

// ---------------------------------------------------------------- connections
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const c = { ws, ip, country: panel.countryOf(req), acct: 0, room: null, snake: null, queue: null, known: new Set(), vx: undefined, msgs: 0 };
  clients.add(c);

  ws.on('message', data => {
    if (++c.msgs > 120) return ws.close();  // chống spam: tối đa ~120 gói/giây
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      if (c.acct) return;
      c.lang = LOCALE_BY_CODE.has(m.lang) ? m.lang : 'en';
      const a = db.login(m.token);
      c.acct = a.id;
      send(c, { t: 'acct', token: a.token, id: a.id, bal: a.balance,
        coins: db.coins(a.id), owned: db.ownedSkins(a.id), shop: [...SHOP], earn: { per: COINS_PER_LENGTH, kill: KILL_COINS } });
      send(c, lobbyInfo());
      return;
    }
    if (!c.acct) return;
    if (!PAID_ENABLED && ['joinPaid', 'leaveQueue', 'faucet', 'withdraw', 'history'].includes(m.t)) return;

    switch (m.t) {
      case 'in':
        if (c.snake && c.snake.alive) {
          if (Number.isFinite(m.a)) c.snake.targetAngle = m.a;
          c.snake.boost = !!m.b;
        }
        break;
      case 'joinFree': joinFree(c, m); break;
      case 'buySkin': buySkin(c, m); break;
      case 'leave':
        if (!c.room) break;
        if (c.room.mode === 'paid') {
          if (c.snake && c.snake.alive) break;   // đang sống trong trận mất phí thì không được thoát
          releaseSeat(c.acct, c.room);
        }
        leaveRoom(c);
        break;
      case 'joinPaid': joinPaid(c, m); break;
      case 'leaveQueue': leaveQueue(c); break;
      case 'faucet': faucet(c); break;
      case 'withdraw': withdraw(c, m); break;
      case 'history': send(c, { t: 'history', rows: db.history(c.acct) }); break;
    }
  });

  ws.on('close', () => {
    clients.delete(c);
    if (c.queue) leaveQueue(c);          // chưa vào trận → hoàn tiền
    if (c.room && c.room.mode === 'paid') releaseSeat(c.acct, c.room);
    leaveRoom(c);                        // đang trong trận → rắn chết, tính là thua
  });
});

// ---------------------------------------------------------------- loop
setInterval(() => {
  const now = Date.now();
  for (const r of freeRooms.values()) r.tick(now);
  for (const r of paidRooms) r.tick(now);
}, 1000 / TICK_RATE);

setInterval(() => {
  const now = Date.now();
  for (const c of clients) c.msgs = 0;

  for (const q of queues.values()) {
    if (q.countdownAt && now >= q.countdownAt && q.members.size >= PAID_ROOM_SIZE) startPaidMatch(q);
    else if (q.members.size) broadcastQueue(q);
  }

  // dọn phòng miễn phí trống (luôn giữ ít nhất 1 phòng công khai)
  for (const [code, r] of freeRooms) {
    const publicCount = [...freeRooms.values()].filter(x => x.isPublic).length;
    if (!r.clients.size && now - r.emptySince > 60_000 && (!r.isPublic || publicCount > 1)) freeRooms.delete(code);
  }

  const lobby = lobbyInfo();
  for (const c of clients) if (c.acct && !c.room) send(c, lobby);
}, 1000);

const recovered = db.recoverOnStartup();
if (recovered) console.log(`Đã hoàn ${recovered} vé của các trận bị gián đoạn lần trước.`);
server.listen(PORT, HOST, () => {
  console.log(`GameSlither đang chạy tại http://localhost:${PORT}`);
  console.log(PAID_ENABLED
    ? `Phòng mất phí: BẬT · ${PAID_ROOM_SIZE} người · phí ${FEE_PERCENT}% · ${DEMO ? 'CHẾ ĐỘ THỬ (tiền ảo)' : 'TIỀN THẬT'}`
    : 'Phòng mất phí: TẮT (đặt PAID_MODE=1 để bật)');
});
