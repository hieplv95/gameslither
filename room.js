'use strict';
// Mô phỏng một phòng chơi: rắn, mồi, va chạm, bot. Không biết gì về tiền —
// server.js lắng nghe onFinish() của phòng mất phí để trả thưởng.

const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const SEG = 8;
const BASE_SPEED = 190;
const BOOST_SPEED = 400;
const START_MASS = 10;
const MIN_BOOST_MASS = 15;
const MAX_R = 46;
const CELL = 120;
const SECTOR = 500;   // kích thước vùng giữ mật độ mồi
const DROP_TTL = 120_000;   // mồi rơi từ rắn tồn tại ~2 phút
// Mật độ mồi: gốc 2200 viên cho bản đồ bán kính 4000, nhân với FOOD_MULT (mặc định 2 → 4400 viên)
const FOOD_MULT = Math.min(5, Math.max(0.5, Number(process.env.FOOD_MULT) || 2));
const FOOD_DENSITY = FOOD_MULT * 2200 / (Math.PI * 4000 * 4000);

const BOT_NAMES = ['King Cobra', 'Silk Python', 'Electric Eel', 'Sidewinder', 'Slinky', 'Noodle', 'Viper',
  'Kaa', 'Sssnek', 'Wiggles', 'Python', 'Anaconda', 'Mamba', 'Cobra', 'Boa', 'Zigzag',
  'Hisss', 'Spaghetti', 'Ramen', 'Rubber Band', 'Curry', 'Shoelace'];

const rand = (a, b) => a + Math.random() * (b - a);
const radiusOf = m => Math.min(9 + Math.sqrt(m) * 0.9, MAX_R);
const segCountOf = m => Math.floor(10 + m / 2.5);
const viewRadiusOf = m => 800 + radiusOf(m) * 20;
const cellKey = (cx, cy) => cx * 100003 + cy;
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Màu chủ đạo của các mẫu rắn (Neon, Rồng Vàng, Kẹo, Trăn, Thiên Hà) — dùng cho mồi rơi ra khi chết.
// Mẫu cuối (CLASSIC) là rắn một màu: màu do người chơi chọn.
const SKIN_HUES = [188, 42, 320, 80, 262, null];
const CLASSIC = SKIN_HUES.length - 1;

let nextSnakeId = 1; // dùng chung mọi phòng để id không bao giờ trùng
let nextFoodId = 1;

function send(c, obj) {
  if (c.ws.readyState === 1 && c.ws.bufferedAmount < 512 * 1024) c.ws.send(JSON.stringify(obj));
}

class Room {
  /**
   * opts: { uid, code, mode: 'free'|'paid', worldR, bots: number, cap,
   *         shrink: { startAt, endAt, minR } (giây, chỉ phòng mất phí), timeLimit (giây) }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.baseR = this.worldR;
    this.snakes = new Map();
    this.foods = new Map();
    this.foodGrid = new Map();
    this.segGrid = new Map();
    this.eatenBy = new Map();
    this.clients = new Set();
    this.tickNo = 0;
    this.running = opts.mode === 'free';
    this.startedAt = 0;
    this.finished = false;
    this.onFinish = null;
    this.deathOrder = 0;
    this.natural = new Map();      // vùng -> số mồi tự nhiên đang có
    this.sectorCap = new Map();    // vùng -> số mồi tự nhiên tối đa
    this.sectorR = 0;
    const target = this.foodTarget();
    for (let i = 0, n = 0; i < target * 6 && n < target; i++) if (this.spawnNaturalFood()) n++;
  }

  foodTarget() { return Math.round(FOOD_DENSITY * Math.PI * this.worldR * this.worldR); }
  humanCount() { let n = 0; for (const s of this.snakes.values()) if (!s.bot) n++; return n; }

  // ------------------------------------------------------------ food
  randomPoint(margin = 0) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * Math.max(10, this.worldR - margin);
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  }
  addFood(x, y, v, hue, sector) {
    if (Math.hypot(x, y) > this.worldR - 15) return null;
    const f = { id: nextFoodId++, x: Math.round(x), y: Math.round(y), v, hue,
      cx: Math.floor(x / CELL), cy: Math.floor(y / CELL) };
    if (sector !== undefined) { f.sector = sector; this.natural.set(sector, (this.natural.get(sector) || 0) + 1); }
    else f.exp = (this.now || Date.now()) + DROP_TTL * (0.8 + Math.random() * 0.4);   // lệch nhẹ để không biến mất cùng lúc
    this.foods.set(f.id, f);
    const k = cellKey(f.cx, f.cy);
    let s = this.foodGrid.get(k);
    if (!s) { s = new Set(); this.foodGrid.set(k, s); }
    s.add(f);
    return f;
  }
  removeFood(f) {
    if (!this.foods.delete(f.id)) return;
    if (f.sector !== undefined) this.natural.set(f.sector, this.natural.get(f.sector) - 1);
    const k = cellKey(f.cx, f.cy);
    const s = this.foodGrid.get(k);
    if (s) { s.delete(f); if (!s.size) this.foodGrid.delete(k); }
  }
  forFoodNear(x, y, rad, cb) {
    const cx0 = Math.floor((x - rad) / CELL), cx1 = Math.floor((x + rad) / CELL);
    const cy0 = Math.floor((y - rad) / CELL), cy1 = Math.floor((y + rad) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const s = this.foodGrid.get(cellKey(cx, cy));
      if (s) for (const f of s) cb(f);
    }
  }
  // Mồi tự nhiên giữ mật độ đều theo từng vùng SECTOR×SECTOR: chỉ đếm tổng thì mồi dồn ra rìa bản đồ
  // (ít ai tới) còn vùng giữa bị ăn trống mà không được bù. Mồi rơi từ rắn chết / tăng tốc không tính vào đây.
  updateSectorCaps() {
    if (Math.abs(this.worldR - this.sectorR) < 40) return;
    this.sectorR = this.worldR;
    this.sectorCap.clear();
    const n = Math.ceil(this.worldR / SECTOR), S = 8, lim = (this.worldR - 20) ** 2;
    for (let sx = -n; sx < n; sx++) for (let sy = -n; sy < n; sy++) {
      let inside = 0;   // phần diện tích vùng nằm trong bản đồ (lấy mẫu S×S điểm)
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        const x = (sx + (i + 0.5) / S) * SECTOR, y = (sy + (j + 0.5) / S) * SECTOR;
        if (x * x + y * y < lim) inside++;
      }
      if (inside) this.sectorCap.set(cellKey(sx, sy), FOOD_DENSITY * SECTOR * SECTOR * inside / (S * S));
    }
  }
  // Thử đặt 1 viên mồi ở điểm ngẫu nhiên; bỏ qua nếu vùng đó đã đủ mồi. Trả về true nếu đặt được.
  spawnNaturalFood() {
    this.updateSectorCaps();
    const p = this.randomPoint(20);
    const sector = cellKey(Math.floor(p.x / SECTOR), Math.floor(p.y / SECTOR));
    if ((this.natural.get(sector) || 0) >= (this.sectorCap.get(sector) || 0)) return false;
    const r = Math.random();
    return !!this.addFood(p.x, p.y, r < 0.75 ? 1 : r < 0.95 ? 2 : 3, Math.floor(Math.random() * 360), sector);
  }

  // ------------------------------------------------------------ snakes
  segHit(px, py, rad, self) {
    const reach = rad + MAX_R;
    const cx0 = Math.floor((px - reach) / CELL), cx1 = Math.floor((px + reach) / CELL);
    const cy0 = Math.floor((py - reach) / CELL), cy1 = Math.floor((py + reach) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const arr = this.segGrid.get(cellKey(cx, cy));
      if (!arr) continue;
      for (let j = 0; j < arr.length; j += 3) {
        const o = arr[j];
        if (o === self || !o.alive) continue;
        const dx = arr[j + 1] - px, dy = arr[j + 2] - py, rr = rad + o.r;
        if (dx * dx + dy * dy < rr * rr) return o;
      }
    }
    return null;
  }

  // Phòng mất phí: xếp người chơi cách đều trên một vòng tròn, đầu hướng vào tâm.
  // look: { skin, hue } — hue chỉ dùng cho mẫu Cổ điển
  spawnSnake(name, look, bot, client, slot) {
    const skin = look.skin, hue = skin === CLASSIC ? look.hue : SKIN_HUES[skin];
    let p, angle;
    if (slot) {
      const a = slot.index / slot.total * Math.PI * 2;
      const d = this.worldR * 0.6;
      p = { x: Math.cos(a) * d, y: Math.sin(a) * d };
      angle = a + Math.PI;
    } else {
      p = null;
      for (let i = 0; i < 30 && !p; i++) {
        const c = this.randomPoint(this.worldR * 0.25);
        if (!this.segHit(c.x, c.y, 250, null)) p = c;
      }
      p = p || this.randomPoint(this.worldR * 0.25);
      angle = Math.atan2(-p.y, -p.x) + rand(-1, 1);
    }
    const s = {
      id: nextSnakeId++, name, skin, hue, bot, alive: true, client,
      x: p.x, y: p.y, angle, targetAngle: angle, boost: false, boosting: false,
      mass: START_MASS, r: radiusOf(START_MASS), boostAcc: 0, segs: [],
      foodTarget: null, thinkIn: 0, boostTicks: 0,
    };
    const len = segCountOf(s.mass) * SEG;
    s.path = [{ x: p.x, y: p.y }, { x: p.x - Math.cos(angle) * len, y: p.y - Math.sin(angle) * len }];
    rebuildSegs(s);
    this.snakes.set(s.id, s);
    return s;
  }

  moveSnake(s) {
    s.r = radiusOf(s.mass);
    const turnRate = 5.2 / (1 + (s.r - 9) / 25);
    const d = angleDiff(s.angle, s.targetAngle), maxT = turnRate * DT;
    s.angle += Math.max(-maxT, Math.min(maxT, d));
    s.boosting = s.boost && s.mass > MIN_BOOST_MASS;
    const sp = s.boosting ? BOOST_SPEED : BASE_SPEED;
    s.x += Math.cos(s.angle) * sp * DT;
    s.y += Math.sin(s.angle) * sp * DT;
    s.path.unshift({ x: s.x, y: s.y });
    if (s.boosting) {
      const lost = (5 + s.mass * 0.01) * DT;
      s.mass -= lost;
      s.boostAcc += lost;
      if (s.boostAcc >= 1.5) {
        s.boostAcc -= 1.5;
        const tail = s.segs[s.segs.length - 1] || s;
        this.addFood(tail.x + rand(-6, 6), tail.y + rand(-6, 6), 1, s.hue);
      }
    }
    rebuildSegs(s);
  }

  killSnake(s, killer) {
    if (!s.alive) return;
    s.alive = false;
    const segs = s.segs;
    const drops = Math.max(3, Math.floor(segs.length / 2));
    const v = Math.max(1, Math.round((s.mass * 0.75) / drops));
    for (let k = 0; k < drops; k++) {
      const g = segs[Math.floor(k * segs.length / drops)];
      this.addFood(g.x + rand(-s.r * 0.6, s.r * 0.6), g.y + rand(-s.r * 0.6, s.r * 0.6), v, s.hue);
    }
    this.snakes.delete(s.id);
    if (s.client) {
      const msg = { t: 'dead', mass: Math.floor(s.mass), by: killer ? killer.name : null };
      if (this.mode === 'paid') msg.place = this.humanCount() + 1;
      send(s.client, msg);
    }
  }

  // ------------------------------------------------------------ bot AI
  botThink(s) {
    if (Math.hypot(s.x, s.y) > this.worldR - 350) {
      s.targetAngle = Math.atan2(-s.y, -s.x);
      s.boost = false;
      return;
    }
    const look = s.r + 40;
    const danger = ang => {
      for (let i = 1; i <= 3; i++) {
        const d = look * i * (s.boosting ? 1.6 : 1);
        const px = s.x + Math.cos(ang) * d, py = s.y + Math.sin(ang) * d;
        if (Math.hypot(px, py) > this.worldR - s.r) return true;
        if (this.segHit(px, py, s.r * 0.9, s)) return true;
      }
      return false;
    };
    if (danger(s.angle)) {
      s.boost = false;
      s.foodTarget = null;
      for (const off of [0.7, -0.7, 1.3, -1.3, 2, -2, 2.7, -2.7]) {
        if (!danger(s.angle + off)) { s.targetAngle = s.angle + off; return; }
      }
      s.targetAngle = s.angle + Math.PI;
      return;
    }
    if (s.boostTicks > 0) { s.boostTicks--; if (!s.boostTicks) s.boost = false; }
    if (s.foodTarget && !this.foods.has(s.foodTarget.id)) s.foodTarget = null;
    if (--s.thinkIn <= 0 || !s.foodTarget) {
      s.thinkIn = 6 + Math.floor(Math.random() * 6);
      let best = null, bestScore = 0;
      this.forFoodNear(s.x, s.y, 320, f => {
        const d = Math.hypot(f.x - s.x, f.y - s.y);
        const facing = 1.4 - Math.abs(angleDiff(s.angle, Math.atan2(f.y - s.y, f.x - s.x))) / Math.PI;
        const score = (f.v / (d + 40)) * facing;
        if (score > bestScore) { bestScore = score; best = f; }
      });
      s.foodTarget = best;
      if (best && best.v >= 4 && s.mass > 30 && Math.random() < 0.3) { s.boost = true; s.boostTicks = 20; }
    }
    if (s.foodTarget) s.targetAngle = Math.atan2(s.foodTarget.y - s.y, s.foodTarget.x - s.x);
    else if (Math.random() < 0.03) s.targetAngle = s.angle + rand(-1.2, 1.2);
  }

  // ------------------------------------------------------------ paid-room helpers
  start(now) {
    this.running = true;
    this.startedAt = now;
  }
  elapsed(now) { return (now - this.startedAt) / 1000; }
  timeLeft(now) { return this.timeLimit ? Math.max(0, this.timeLimit - this.elapsed(now)) : null; }

  updateShrink(now) {
    const sh = this.shrink;
    if (!sh) return;
    const t = this.elapsed(now);
    const k = Math.min(1, Math.max(0, (t - sh.startAt) / (sh.endAt - sh.startAt)));
    this.worldR = this.baseR + (sh.minR - this.baseR) * k;
    if (k > 0 && this.tickNo % 15 === 0) {
      const lim = this.worldR - 15;
      for (const f of this.foods.values()) if (f.x * f.x + f.y * f.y > lim * lim) this.removeFood(f);
    }
  }

  // ------------------------------------------------------------ main tick
  tick(now) {
    if (!this.running || this.finished) return;
    this.tickNo++;
    this.now = now;
    if (this.mode === 'paid') this.updateShrink(now);
    // mồi rơi (rắn chết / tăng tốc) không ai ăn sau DROP_TTL thì biến mất, tránh dồn mồi vô hạn
    if (this.tickNo % TICK_RATE === 0) for (const f of this.foods.values()) if (f.exp && f.exp < now) this.removeFood(f);

    for (const s of this.snakes.values()) if (s.bot) this.botThink(s);
    for (const s of this.snakes.values()) this.moveSnake(s);

    this.segGrid = new Map();
    for (const s of this.snakes.values()) {
      for (const g of s.segs) {
        const k = cellKey(Math.floor(g.x / CELL), Math.floor(g.y / CELL));
        let arr = this.segGrid.get(k);
        if (!arr) { arr = []; this.segGrid.set(k, arr); }
        arr.push(s, g.x, g.y);
      }
    }

    const deaths = [];
    for (const s of this.snakes.values()) {
      if (Math.hypot(s.x, s.y) + s.r > this.worldR) { deaths.push([s, null]); continue; }
      const hit = this.segHit(s.x, s.y, s.r * 0.6, s);
      if (hit) deaths.push([s, hit]);
    }
    // Nếu tất cả người còn lại chết cùng lúc, người to nhất trong số đó thắng.
    let fallbackWinner = null;
    if (this.mode === 'paid' && deaths.length && deaths.length >= this.humanCount()) {
      for (const [s] of deaths) if (!fallbackWinner || s.mass > fallbackWinner.mass) fallbackWinner = s;
    }
    for (const [s, killer] of deaths) {
      if (s === fallbackWinner) { this.snakes.delete(s.id); s.alive = false; continue; }
      this.killSnake(s, killer);
    }

    for (const s of this.snakes.values()) {
      const er = s.r + 14;
      this.forFoodNear(s.x, s.y, er, f => {
        const dx = f.x - s.x, dy = f.y - s.y;
        if (dx * dx + dy * dy < er * er) {
          s.mass += f.v;
          this.eatenBy.set(f.id, s.id);
          this.removeFood(f);
        }
      });
    }

    let natural = 0;
    // Bù mồi dần (tối đa 10 viên/tick = 300 viên/giây) vào những vùng đang thiếu
    for (let tries = 0; tries < 120 && natural < 10; tries++) if (this.spawnNaturalFood()) natural++;

    if (this.bots) {
      let bots = 0, humans = 0;
      for (const s of this.snakes.values()) s.bot ? bots++ : humans++;
      const want = Math.max(Math.min(6, this.bots), this.bots - humans);
      if (bots < want && Math.random() < 0.08) {
        this.spawnSnake(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], { skin: Math.floor(Math.random() * SKIN_HUES.length), hue: Math.floor(Math.random() * 360) }, true, null);
      }
    }

    if (this.mode === 'paid') {
      const humans = [...this.snakes.values()].filter(s => !s.bot);
      let winner = null;
      if (fallbackWinner) winner = fallbackWinner;
      else if (humans.length === 1) winner = humans[0];
      else if (this.timeLeft(now) === 0) winner = humans.reduce((a, b) => (b.mass > a.mass ? b : a), humans[0]);
      if (winner) {
        this.finished = true;
        if (this.onFinish) this.onFinish(winner);
      }
    }

    for (const c of this.clients) this.sendState(c, now);
    if (this.tickNo % TICK_RATE === 0) this.sendLeaderboards(now);
    this.eatenBy = new Map();
  }

  // ------------------------------------------------------------ networking
  sendState(c, now) {
    const s = c.snake;
    const alive = !!s && s.alive && this.snakes.get(s.id) === s;
    if (alive) { c.vx = s.x; c.vy = s.y; c.vr = viewRadiusOf(s.mass); }
    else if (this.mode === 'paid') {
      // đã bị loại: theo dõi con rắn to nhất còn sống
      let top = null;
      for (const o of this.snakes.values()) if (!top || o.mass > top.mass) top = o;
      if (top) { c.vx = top.x; c.vy = top.y; c.vr = viewRadiusOf(top.mass); }
    }
    if (c.vx === undefined) return;
    const vx = c.vx, vy = c.vy, vr = c.vr;

    const sn = [];
    for (const o of this.snakes.values()) {
      if (o.maxX < vx - vr || o.minX > vx + vr || o.maxY < vy - vr || o.minY > vy + vr) continue;
      const pts = [];
      for (let i = 0; i < o.segs.length; i += 2) pts.push(Math.round(o.segs[i].x), Math.round(o.segs[i].y));
      sn.push([o.id, o.name, o.skin, Math.round(o.r * 10), o.boosting ? 1 : 0, Math.round(o.angle * 100), pts, o.hue]);
    }

    const cur = new Set(), fa = [], fr = [];
    this.forFoodNear(vx, vy, vr, f => {
      if (Math.abs(f.x - vx) > vr || Math.abs(f.y - vy) > vr) return;
      cur.add(f.id);
      if (!c.known.has(f.id)) fa.push(f.id, f.x, f.y, f.v, f.hue);
    });
    for (const id of c.known) if (!cur.has(id)) fr.push(id, this.eatenBy.get(id) || 0);
    c.known = cur;

    send(c, { t: 's', ts: now, vx: Math.round(vx), vy: Math.round(vy), vr: Math.round(vr),
      wr: Math.round(this.worldR), m: alive ? Math.floor(s.mass) : undefined, sn, fa, fr });
  }

  sendLeaderboards(now) {
    const list = [...this.snakes.values()].sort((a, b) => b.mass - a.mass);
    const top = list.slice(0, 10).map(s => [s.id, s.name, Math.floor(s.mass)]);
    const mm = [];
    for (const s of list.slice(0, 10)) mm.push(Math.round(s.x / this.baseR * 100), Math.round(s.y / this.baseR * 100));
    const base = { t: 'lb', top, n: list.length, mm };
    if (this.mode === 'paid') {
      base.paid = { left: this.humanCount(), total: this.players, pot: this.pot, prize: this.prize,
        tLeft: Math.ceil(this.timeLeft(now)), shrinkIn: Math.max(0, Math.ceil(this.shrink.startAt - this.elapsed(now))) };
    }
    for (const c of this.clients) {
      const rank = c.snake && c.snake.alive ? list.indexOf(c.snake) + 1 : 0;
      send(c, { ...base, rank });
    }
  }
}


// Đặt các đốt thân cách đều nhau dọc theo đường đi của đầu rắn
function rebuildSegs(s) {
  const count = segCountOf(s.mass);
  const P = s.path;
  const segs = [{ x: s.x, y: s.y }];
  let nextD = SEG, acc = 0, k = 0;
  for (; k < P.length - 1 && segs.length < count; k++) {
    const a = P[k], b = P[k + 1];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len === 0) continue;
    while (acc + len >= nextD && segs.length < count) {
      const t = (nextD - acc) / len;
      segs.push({ x: a.x + dx * t, y: a.y + dy * t });
      nextD += SEG;
    }
    acc += len;
  }
  if (segs.length >= count && P.length > k + 2) P.length = k + 2;
  s.segs = segs;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of segs) {
    if (g.x < minX) minX = g.x; if (g.x > maxX) maxX = g.x;
    if (g.y < minY) minY = g.y; if (g.y > maxY) maxY = g.y;
  }
  s.minX = minX - s.r; s.maxX = maxX + s.r; s.minY = minY - s.r; s.maxY = maxY + s.r;
}

module.exports = { Room, send, TICK_RATE, SKIN_COUNT: SKIN_HUES.length };
