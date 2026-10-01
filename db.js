'use strict';
// Sổ cái tiền: mọi thay đổi số dư đều đi qua applyTx() và được ghi vào bảng ledger.
// Đơn vị lưu trữ: micro-USD (1 USDT = 1_000_000) để tránh lỗi làm tròn số thực.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const UNIT = 1_000_000;
const HOUSE_ID = 0; // tài khoản nhà cái (thu phí)

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    type TEXT NOT NULL,          -- deposit | withdraw | entry | refund | prize | fee
    amount INTEGER NOT NULL,     -- dương = cộng, âm = trừ
    ref TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    ref TEXT NOT NULL,           -- room:<uid>
    status TEXT NOT NULL         -- held | refunded | settled
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL,
    stake INTEGER NOT NULL,
    players INTEGER NOT NULL,
    pot INTEGER NOT NULL,
    fee INTEGER,
    prize INTEGER,
    winner_account INTEGER,
    status TEXT NOT NULL,        -- playing | settled
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    address TEXT NOT NULL,
    status TEXT NOT NULL,        -- pending | sent | rejected
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, id);

  -- thống kê website (không lưu IP, chỉ lưu quốc gia)
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,           -- YYYY-MM-DD theo giờ Việt Nam
    vid TEXT,                    -- mã khách (cookie) để đếm khách duy nhất
    country TEXT,                -- mã quốc gia 2 chữ, XX = không rõ
    device TEXT,                 -- desktop | mobile | tablet
    ref TEXT                     -- tên miền trang giới thiệu
  );
  CREATE INDEX IF NOT EXISTS visits_day ON visits (day);
  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    mode TEXT NOT NULL,          -- free | paid
    country TEXT
  );
  CREATE INDEX IF NOT EXISTS plays_day ON plays (day);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- blog: mỗi bài thuộc 1 ngôn ngữ, đường dẫn /<ngôn ngữ>/blog/<slug>
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY,
    lang TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',   -- meta description
    keywords TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',       -- Markdown
    faq TEXT NOT NULL DEFAULT '[]',         -- JSON [[hỏi, đáp], …]
    cover TEXT NOT NULL DEFAULT '',         -- /media/…
    cover_alt TEXT NOT NULL DEFAULT '',
    credit TEXT NOT NULL DEFAULT '',        -- ghi nguồn ảnh (nếu là ảnh kho)
    topic TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    UNIQUE (lang, slug)
  );
  CREATE INDEX IF NOT EXISTS posts_pub ON posts (status, lang, published_at);
  INSERT OR IGNORE INTO accounts (id, token_hash, balance, created_at) VALUES (0, 'HOUSE', 0, 0);

  -- cửa hàng mẫu rắn: xu kiếm được khi chơi miễn phí (không liên quan số dư USDT), mẫu đã mua
  CREATE TABLE IF NOT EXISTS owned_skins (
    account_id INTEGER NOT NULL,
    skin INTEGER NOT NULL,
    price INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, skin)
  );
`);
// DB cũ chưa có cột xu thì thêm vào
if (!db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === 'coins')) {
  db.exec('ALTER TABLE accounts ADD COLUMN coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0)');
}

const q = {
  byToken: db.prepare('SELECT id, balance FROM accounts WHERE token_hash = ?'),
  create: db.prepare('INSERT INTO accounts (token_hash, balance, created_at) VALUES (?, 0, ?)'),
  balance: db.prepare('SELECT balance FROM accounts WHERE id = ?'),
  add: db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND balance + ? >= 0'),
  ledger: db.prepare('INSERT INTO ledger (account_id, type, amount, ref, created_at) VALUES (?, ?, ?, ?, ?)'),
  history: db.prepare('SELECT type, amount, ref, created_at FROM ledger WHERE account_id = ? ORDER BY id DESC LIMIT ?'),
  entryHold: db.prepare("INSERT INTO entries (account_id, amount, ref, status) VALUES (?, ?, ?, 'held')"),
  entryHeld: db.prepare("SELECT id, amount FROM entries WHERE account_id = ? AND ref = ? AND status = 'held'"),
  entrySet: db.prepare('UPDATE entries SET status = ? WHERE id = ?'),
  entriesSettle: db.prepare("UPDATE entries SET status = 'settled' WHERE ref = ? AND status = 'held'"),
  allHeld: db.prepare("SELECT id, account_id, amount, ref FROM entries WHERE status = 'held'"),
  cancelPlaying: db.prepare("UPDATE matches SET status = 'cancelled', ended_at = ? WHERE status = 'playing'"),
  matchStart: db.prepare("INSERT INTO matches (ref, stake, players, pot, status, started_at) VALUES (?, ?, ?, ?, 'playing', ?)"),
  matchEnd: db.prepare("UPDATE matches SET fee = ?, prize = ?, winner_account = ?, status = 'settled', ended_at = ? WHERE id = ?"),
  withdrawal: db.prepare("INSERT INTO withdrawals (account_id, amount, address, status, created_at) VALUES (?, ?, ?, 'pending', ?)"),
  coins: db.prepare('SELECT coins FROM accounts WHERE id = ?'),
  addCoins: db.prepare('UPDATE accounts SET coins = coins + ? WHERE id = ? AND coins + ? >= 0'),
  owned: db.prepare('SELECT skin FROM owned_skins WHERE account_id = ? ORDER BY skin'),
  owns: db.prepare('SELECT 1 FROM owned_skins WHERE account_id = ? AND skin = ?'),
  own: db.prepare('INSERT INTO owned_skins (account_id, skin, price, created_at) VALUES (?, ?, ?, ?)'),
};

const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

// Ngày theo giờ Việt Nam (UTC+7)
const TZ_OFFSET_MS = 7 * 3600_000;
const dayOf = ts => new Date(ts + TZ_OFFSET_MS).toISOString().slice(0, 10);

const qa = {
  visit: db.prepare('INSERT INTO visits (ts, day, vid, country, device, ref) VALUES (?, ?, ?, ?, ?, ?)'),
  play: db.prepare('INSERT INTO plays (ts, day, mode, country) VALUES (?, ?, ?, ?)'),
  vDaily: db.prepare('SELECT day, COUNT(*) v, COUNT(DISTINCT vid) u FROM visits WHERE day >= ? GROUP BY day'),
  pDaily: db.prepare('SELECT day, COUNT(*) p FROM plays WHERE day >= ? GROUP BY day'),
  vTotal: db.prepare('SELECT COUNT(*) v, COUNT(DISTINCT vid) u FROM visits WHERE day >= ?'),
  pTotal: db.prepare('SELECT COUNT(*) p FROM plays WHERE day >= ?'),
  countries: db.prepare('SELECT country, COUNT(*) n, COUNT(DISTINCT vid) u FROM visits WHERE day >= ? GROUP BY country ORDER BY n DESC LIMIT 20'),
  devices: db.prepare('SELECT device, COUNT(*) n FROM visits WHERE day >= ? GROUP BY device ORDER BY n DESC'),
  refs: db.prepare("SELECT ref, COUNT(*) n FROM visits WHERE day >= ? AND ref IS NOT NULL AND ref != '' GROUP BY ref ORDER BY n DESC LIMIT 10"),
  getSettings: db.prepare('SELECT key, value FROM settings'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

const POST_FIELDS = ['lang', 'slug', 'title', 'description', 'keywords', 'excerpt', 'content', 'faq', 'cover', 'cover_alt', 'credit', 'topic', 'status'];
const qp = {
  all: db.prepare('SELECT id, lang, slug, title, cover, status, topic, created_at, updated_at, published_at FROM posts ORDER BY COALESCE(published_at, updated_at) DESC'),
  byId: db.prepare('SELECT * FROM posts WHERE id = ?'),
  bySlug: db.prepare("SELECT * FROM posts WHERE lang = ? AND slug = ? AND status = 'published'"),
  slugTaken: db.prepare('SELECT id FROM posts WHERE lang = ? AND slug = ? AND id != ?'),
  published: db.prepare("SELECT id, lang, slug, title, description, excerpt, cover, cover_alt, published_at, updated_at FROM posts WHERE status = 'published' AND lang = ? ORDER BY published_at DESC LIMIT ?"),
  publishedAll: db.prepare("SELECT lang, slug, title, cover, published_at, updated_at FROM posts WHERE status = 'published' ORDER BY published_at DESC"),
  del: db.prepare('DELETE FROM posts WHERE id = ?'),
};
const postRow = r => r && { ...r, id: Number(r.id), faq: (() => { try { return JSON.parse(r.faq); } catch { return []; } })(),
  created_at: Number(r.created_at), updated_at: Number(r.updated_at), published_at: r.published_at == null ? null : Number(r.published_at) };

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Cộng/trừ số dư. Ném lỗi nếu không đủ tiền. Chỉ dùng bên trong tx() hoặc qua các hàm bên dưới.
function applyTx(accountId, amount, type, ref) {
  const r = q.add.run(amount, accountId, amount);
  if (r.changes !== 1) throw new Error('INSUFFICIENT_FUNDS');
  q.ledger.run(accountId, type, amount, ref == null ? null : String(ref), Date.now());
}

module.exports = {
  UNIT, HOUSE_ID,

  // Trả về tài khoản ứng với token; tạo mới nếu token rỗng hoặc không tồn tại.
  login(token) {
    if (typeof token === 'string' && token.length >= 32) {
      const row = q.byToken.get(hashToken(token));
      if (row) return { id: Number(row.id), token, balance: Number(row.balance) };
    }
    const fresh = crypto.randomBytes(32).toString('hex');
    const r = q.create.run(hashToken(fresh), Date.now());
    return { id: Number(r.lastInsertRowid), token: fresh, balance: 0 };
  },

  balance(accountId) {
    const row = q.balance.get(accountId);
    return row ? Number(row.balance) : 0;
  },

  deposit(accountId, amount, ref) {
    tx(() => applyTx(accountId, amount, 'deposit', ref));
  },

  // Trừ tiền vé và "giữ" lại theo phòng. Trả về false nếu không đủ tiền.
  chargeEntry(accountId, amount, ref) {
    try {
      tx(() => { applyTx(accountId, -amount, 'entry', ref); q.entryHold.run(accountId, amount, ref); });
      return true;
    } catch (e) { if (e.message === 'INSUFFICIENT_FUNDS') return false; throw e; }
  },

  // Hoàn lại vé đang giữ của một người trong phòng (rời phòng chờ, phòng bị huỷ...).
  refundEntry(accountId, ref) {
    tx(() => {
      const e = q.entryHeld.get(accountId, ref);
      if (!e) return;
      applyTx(accountId, Number(e.amount), 'refund', ref);
      q.entrySet.run('refunded', e.id);
    });
  },

  startMatch(ref, stake, players) {
    return Number(q.matchStart.run(ref, stake, players, stake * players, Date.now()).lastInsertRowid);
  },

  // Trả thưởng cho người thắng + thu phí nhà cái, tất cả trong một giao dịch.
  settleMatch(matchId, ref, winnerAccountId, pot, feePercent) {
    const fee = Math.floor(pot * feePercent / 100);
    const prize = pot - fee;
    tx(() => {
      applyTx(winnerAccountId, prize, 'prize', ref);
      applyTx(HOUSE_ID, fee, 'fee', ref);
      q.entriesSettle.run(ref);
      q.matchEnd.run(fee, prize, winnerAccountId, Date.now(), matchId);
    });
    return { fee, prize };
  },

  // Gọi khi khởi động: server sập giữa chừng thì hoàn hết vé đang giữ, huỷ các trận dang dở.
  recoverOnStartup() {
    let n = 0;
    tx(() => {
      for (const e of q.allHeld.all()) {
        applyTx(Number(e.account_id), Number(e.amount), 'refund', e.ref);
        q.entrySet.run('refunded', e.id);
        n++;
      }
      q.cancelPlaying.run(Date.now());
    });
    return n;
  },

  requestWithdrawal(accountId, amount, address) {
    try {
      return tx(() => {
        applyTx(accountId, -amount, 'withdraw', address);
        return Number(q.withdrawal.run(accountId, amount, address, Date.now()).lastInsertRowid);
      });
    } catch (e) { if (e.message === 'INSUFFICIENT_FUNDS') return null; throw e; }
  },

  // ---------------------------------------------------------------- xu & cửa hàng mẫu rắn
  coins(accountId) {
    const row = q.coins.get(accountId);
    return row ? Number(row.coins) : 0;
  },
  // Cộng xu, trả về số xu mới.
  addCoins(accountId, n) {
    q.addCoins.run(n, accountId, n);
    return this.coins(accountId);
  },
  ownedSkins(accountId) { return q.owned.all(accountId).map(r => Number(r.skin)); },
  ownsSkin(accountId, skin) { return !!q.owns.get(accountId, skin); },
  // Trừ xu + ghi mẫu đã mua trong một giao dịch. Trả về 'ok' | 'owned' | 'noCoins'.
  buySkin(accountId, skin, price) {
    return tx(() => {
      if (q.owns.get(accountId, skin)) return 'owned';
      if (q.addCoins.run(-price, accountId, -price).changes !== 1) return 'noCoins';
      q.own.run(accountId, skin, price, Date.now());
      return 'ok';
    });
  },

  // ---------------------------------------------------------------- thống kê & cài đặt
  recordVisit({ vid, country, device, ref }) {
    const ts = Date.now();
    qa.visit.run(ts, dayOf(ts), vid, country, device, ref || null);
  },
  recordPlay(mode, country) {
    const ts = Date.now();
    qa.play.run(ts, dayOf(ts), mode, country || 'XX');
  },
  // Thống kê `days` ngày gần nhất (tính cả hôm nay), ngày trống được điền 0.
  stats(days) {
    const now = Date.now();
    const since = dayOf(now - (days - 1) * 86400_000), today = dayOf(now);
    const v = new Map(qa.vDaily.all(since).map(r => [r.day, r]));
    const p = new Map(qa.pDaily.all(since).map(r => [r.day, r]));
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = dayOf(now - i * 86400_000);
      daily.push({ day: d, visits: Number(v.get(d)?.v || 0), visitors: Number(v.get(d)?.u || 0), plays: Number(p.get(d)?.p || 0) });
    }
    const vt = qa.vTotal.get(since), vToday = qa.vTotal.get(today);
    const num = x => Number(x || 0);
    return {
      days, daily,
      total: { visits: num(vt.v), visitors: num(vt.u), plays: num(qa.pTotal.get(since).p) },
      today: { visits: num(vToday.v), visitors: num(vToday.u), plays: num(qa.pTotal.get(today).p) },
      countries: qa.countries.all(since).map(r => ({ country: r.country || 'XX', visits: num(r.n), visitors: num(r.u) })),
      devices: qa.devices.all(since).map(r => ({ device: r.device || 'desktop', visits: num(r.n) })),
      referrers: qa.refs.all(since).map(r => ({ ref: r.ref, visits: num(r.n) })),
    };
  },
  getSettings() {
    return Object.fromEntries(qa.getSettings.all().map(r => [r.key, r.value]));
  },
  setSettings(obj) {
    tx(() => { for (const [k, v] of Object.entries(obj)) qa.setSetting.run(k, String(v)); });
  },

  // ---------------------------------------------------------------- blog
  listPosts() { return qp.all.all().map(postRow); },
  getPost(id) { return postRow(qp.byId.get(id)); },
  publishedPost(lang, slug) { return postRow(qp.bySlug.get(lang, slug)); },
  publishedPosts(lang, limit = 500) { return qp.published.all(lang, limit).map(postRow); },
  allPublishedPosts() { return qp.publishedAll.all().map(postRow); },
  slugTaken(lang, slug, exceptId = 0) { return !!qp.slugTaken.get(lang, slug, exceptId); },
  // Lưu bài (tạo mới khi không có id). Lần đầu chuyển sang "published" thì ghi ngày đăng.
  savePost(p, id) {
    const now = Date.now();
    const vals = POST_FIELDS.map(k => (k === 'faq' ? JSON.stringify(p.faq || []) : String(p[k] ?? '')));
    if (!id) {
      const r = db.prepare(`INSERT INTO posts (${POST_FIELDS.join(', ')}, created_at, updated_at, published_at) VALUES (${POST_FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`)
        .run(...vals, now, now, p.status === 'published' ? now : null);
      return Number(r.lastInsertRowid);
    }
    db.prepare(`UPDATE posts SET ${POST_FIELDS.map(k => `${k} = ?`).join(', ')}, updated_at = ?,
      published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END WHERE id = ?`)
      .run(...vals, now, p.status, now, id);
    return id;
  },
  deletePost(id) { qp.del.run(id); },

  history(accountId, limit = 30) {
    return q.history.all(accountId, limit).map(r => [r.type, Number(r.amount), r.ref, Number(r.created_at)]);
  },
};
