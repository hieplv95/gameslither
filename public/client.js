'use strict';
(() => {
  // Khi tắt chế độ mất phí, server gỡ các phần tử ví/hàng chờ khỏi trang → trả về phần tử rỗng để code không lỗi.
  const $ = id => document.getElementById(id) || document.createElement('div');
  const canvas = $('game'), ctx = canvas.getContext('2d');
  const mini = $('minimap'), mctx = mini.getContext('2d');
  // Hiển thị trễ một chút để nội suy mượt giữa các gói tin. Độ trễ tự nới ra khi mạng giật
  // (WiFi điện thoại hay có gói đến muộn 100–300ms), nếu không rắn sẽ đứng hình rồi giật cục.
  const INTERP_MIN = 80, INTERP_MAX = 250, EXTRAP_MAX = 150; // ms
  let interpDelay = INTERP_MIN;
  const lateness = [];   // độ muộn của các gói gần đây so với gói nhanh nhất (ms)
  const Skins = window.SnakeSkins;
  const HUES = [0, 20, 45, 75, 120, 160, 190, 215, 250, 280, 310, 335]; // màu cho mẫu Cổ điển
  const UNIT = 1e6;
  const { t: T, locale: LOCALE, lang: LANG } = window.I18N;
  const usd = v => (v / UNIT).toLocaleString(LOCALE, { maximumFractionDigits: 2 });

  // Game nằm trong khung #gameWrap của trang (có header/footer), không chiếm cả cửa sổ.
  const wrap = $('gameWrap');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth; H = wrap.clientHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }
  new ResizeObserver(resize).observe(wrap);
  resize();
  // Góc lái tính từ tâm khung game
  const angleFrom = (cx, cy) => { const rc = canvas.getBoundingClientRect(); return Math.atan2(cy - rc.top - H / 2, cx - rc.left - W / 2); };

  $('fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
  };
  // Đang chơi thì lăn chuột không cuộn trang
  wrap.addEventListener('wheel', e => { if (alive) e.preventDefault(); }, { passive: false });

  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  function angleDiff(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

  // ------------------------------------------------------------ state
  let ws = null, myId = 0, baseR = 4000, alive = false;
  let mode = null;            // 'free' | 'paid' | null (đang ở sảnh)
  let inQueue = false;
  const snaps = [];
  let clockOffset = null;
  const foods = new Map();
  const eatAnims = [];
  let myMass = 0, shownMass = -1;
  const cam = { x: 0, y: 0 };
  let scale = 1, ringR = 4000;
  let lbData = null, lobby = null;
  let mouseAngle = 0, boost = false, sentAngle = null, sentBoost = false;
  let mySkin = Math.floor(Math.random() * Skins.SKINS.length);
  let myHue = HUES[Math.floor(Math.random() * HUES.length)];

  // ------------------------------------------------------------ menu
  {
    const k = lsGet('rn_skin'); if (k !== null && Skins.SKINS[+k]) mySkin = +k;
    const h = lsGet('rn_hue'); if (h !== null && !isNaN(+h)) myHue = +h;
    const n = lsGet('rn_name'); if (n) $('name').value = n;
  }
  const skinsEl = $('skins');
  // Cổ điển đứng đầu, sau đó là 5 mẫu hoa văn
  const skinOrder = [Skins.CLASSIC, ...Skins.SKINS.keys()].filter((v, i, arr) => arr.indexOf(v) === i);
  const skinCanvases = [];
  for (const i of skinOrder) {
    const sk = Skins.SKINS[i];
    const b = document.createElement('button');
    b.className = 'skin' + (i === mySkin ? ' sel' : '');
    const cv = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = T('skin.' + i);
    b.append(cv, label);
    b.onclick = () => {
      mySkin = i; lsSet('rn_skin', i);
      for (const x of skinsEl.children) x.classList.toggle('sel', x === b);
      show('hues', mySkin === Skins.CLASSIC);
    };
    skinsEl.appendChild(b);
    skinCanvases.push([cv, i]);
  }
  // Hàng chọn màu, chỉ hiện khi chọn mẫu Cổ điển
  const huesEl = $('hues');
  for (const h of HUES) {
    const b = document.createElement('button');
    b.className = 'hue' + (h === myHue ? ' sel' : '');
    b.style.background = `radial-gradient(circle at 35% 35%, hsl(${h},100%,75%), hsl(${h},85%,50%) 60%, hsl(${h},85%,32%))`;
    b.setAttribute('aria-label', T('chooseColor'));
    b.onclick = () => {
      myHue = h; lsSet('rn_hue', h);
      for (const x of huesEl.children) x.classList.toggle('sel', x === b);
    };
    huesEl.appendChild(b);
  }
  show('hues', mySkin === Skins.CLASSIC);
  // Rắn nhỏ uốn lượn tại chỗ trong mỗi ô chọn mẫu
  function drawSkinPreviews(t) {
    if ($('menu').classList.contains('hidden')) return;
    skinCanvases.forEach(([cv, i]) => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w) return;
      if (cv.width !== Math.round(w * DPR)) { cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); }
      const g = cv.getContext('2d');
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, w, h);
      const r = Math.min(8, h * 0.17), pts = [];
      for (let j = 0, x = w - r * 1.8; x > r; j++, x -= 3) pts.push(x, h / 2 + Math.sin(t * 3 - j * 0.14) * h * 0.16);
      const P = Skins.resampleFlat(pts, r, Math.atan2(pts[1] - pts[3], pts[0] - pts[2]));
      Skins.draw(g, P, i, t, r, P[0].a, false, myHue);
    });
  }
  const myName = () => {
    const n = $('name').value.trim().slice(0, 16) || T('guest');
    lsSet('rn_name', n);
    return n;
  };

  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function showLobby(msg) {
    mode = null; alive = false; inQueue = false;
    for (const id of ['death', 'hud', 'queue', 'roomsModal', 'walletModal']) show(id, false);
    show('menu');
    $('status').textContent = msg || '';
    snaps.length = 0;
  }

  // ------------------------------------------------------------ connection
  function sendMsg(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect() {
    $('status').textContent = T('connecting');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => { $('status').textContent = ''; sendMsg({ t: 'hello', token: lsGet('rn_token'), lang: LANG }); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = () => {
      ws = null;
      showLobby(T('disconnected'));
      setTimeout(connect, 2000);
    };
  }
  connect();

  // ------------------------------------------------------------ lobby actions
  $('play').onclick = () => sendMsg({ t: 'joinFree', name: myName(), skin: mySkin, hue: myHue });
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('play').click(); });
  $('pickRoom').onclick = () => { renderRooms(); show('roomsModal'); };
  $('joinCode').onclick = () => {
    const code = $('roomCode').value.trim().toUpperCase();
    if (code) sendMsg({ t: 'joinFree', code, name: myName(), skin: mySkin, hue: myHue });
  };
  $('createRoom').onclick = () => sendMsg({ t: 'joinFree', create: true, name: myName(), skin: mySkin, hue: myHue });
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('.overlay').classList.add('hidden');

  function renderRooms() {
    const list = $('roomList');
    list.textContent = '';
    for (const [code, n, cap] of (lobby ? lobby.free : [])) {
      const row = document.createElement('div');
      row.className = 'roomItem';
      const label = document.createElement('span');
      label.textContent = T('roomItem', { code, n, cap });
      const btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.textContent = T('join');
      btn.onclick = () => sendMsg({ t: 'joinFree', code, name: myName(), skin: mySkin, hue: myHue });
      row.append(label, btn);
      list.appendChild(row);
    }
  }

  function renderLobby() {
    if (!lobby) return;
    $('onlineInfo').textContent = T('online', { n: lobby.online });
    if (lobby.tiers.length) $('paidRule').textContent = T('paidRule', { size: lobby.tiers[0][2], fee: lobby.fee });
    const el = $('tiers');
    if (el.children.length !== lobby.tiers.length) {
      el.textContent = '';
      for (const [stake] of lobby.tiers) {
        const b = document.createElement('button');
        b.className = 'tier';
        b.onclick = () => sendMsg({ t: 'joinPaid', stake, name: myName(), skin: mySkin, hue: myHue });
        b.append(document.createElement('b'), document.createElement('span'), document.createElement('span'));
        el.appendChild(b);
      }
    }
    lobby.tiers.forEach(([stake, n, size], i) => {
      const [b1, s1, s2] = el.children[i].children;
      b1.textContent = `${stake} USDT`;
      s1.textContent = T('tierWin', { amount: (stake * size * (100 - lobby.fee) / 100).toLocaleString(LOCALE) });
      s2.textContent = T('tierWaiting', { n, size });
    });
    show('demoBox', lobby.demo);
    $('wdNote').textContent = T('wdNote', { min: lobby.minWithdraw });
    if (!$('roomsModal').classList.contains('hidden')) renderRooms();
  }

  // ------------------------------------------------------------ wallet
  function openWallet(tab) {
    show('walletModal');
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const p of document.querySelectorAll('[data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== tab);
    if (tab === 'history') sendMsg({ t: 'history' });
  }
  for (const b of document.querySelectorAll('[data-wallet]')) b.onclick = () => openWallet(b.dataset.wallet);
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => openWallet(b.dataset.tab);
  $('faucet').onclick = () => sendMsg({ t: 'faucet' });
  $('wdSubmit').onclick = () => sendMsg({ t: 'withdraw', amount: Number($('wdAmount').value), address: $('wdAddress').value });

  function renderHistory(rows) {
    const ul = $('historyList');
    ul.textContent = '';
    if (!rows.length) { const li = document.createElement('li'); li.textContent = T('noTx'); ul.appendChild(li); }
    for (const [type, amount, , at] of rows) {
      const li = document.createElement('li');
      const l = document.createElement('span');
      l.textContent = `${T('tx.' + type)} · ${new Date(at).toLocaleString(LOCALE)}`;
      const r = document.createElement('span');
      r.className = amount >= 0 ? 'plus' : 'minus';
      r.textContent = (amount >= 0 ? '+' : '') + usd(amount);
      li.append(l, r);
      ul.appendChild(li);
    }
  }

  // ------------------------------------------------------------ queue / result
  $('qLeave').onclick = () => sendMsg({ t: 'leaveQueue' });
  $('again').onclick = () => {
    show('death', false);
    if (mode === 'free') sendMsg({ t: 'joinFree', name: myName(), skin: mySkin, hue: myHue });
    else { sendMsg({ t: 'leave' }); showLobby(); }
  };
  $('toMenu').onclick = () => { sendMsg({ t: 'leave' }); showLobby(); };
  $('watch').onclick = () => { show('death', false); show('hud'); };

  function showDeath(title, text, opts) {
    $('deathTitle').textContent = title;
    $('deathText').textContent = text;
    $('again').textContent = opts.againLabel || T('playAgain');
    show('again', !!opts.again);
    show('watch', !!opts.watch);
    show('toMenu', !opts.againLabel);
    show('death');
  }

  // ------------------------------------------------------------ messages
  function handle(m) {
    switch (m.t) {
      case 'acct':
        lsSet('rn_token', m.token);
        $('balance').textContent = usd(m.bal);
        break;
      case 'bal':
        $('balance').textContent = usd(m.bal);
        break;
      case 'lobby':
        lobby = m;
        renderLobby();
        break;
      case 'err': toast(m.msg, true); break;
      case 'ok': toast(m.msg); break;
      case 'history': renderHistory(m.rows); break;

      case 'queue':
        inQueue = true;
        show('menu', false); show('walletModal', false);
        show('queue');
        $('qTitle').textContent = T('queueTitle', { stake: m.stake });
        $('qCount').textContent = `${m.n} / ${m.size}`;
        $('qFill').style.width = (m.n / m.size * 100) + '%';
        $('qPrize').textContent = T('queuePrize', { amount: usd(m.prize) });
        $('qCountdown').textContent = m.countdown ? T('queueFull', { s: m.countdown }) : T('queueWaiting');
        break;
      case 'queueLeft':
        showLobby();
        break;

      case 'init':
        myId = m.id; baseR = m.wr; ringR = m.wr; alive = true; mode = m.mode; inQueue = false;
        snaps.length = 0; foods.clear(); eatAnims.length = 0; clockOffset = null; sentAngle = null;
        for (const id of ['menu', 'death', 'queue', 'roomsModal', 'walletModal']) show(id, false);
        show('hud');
        // đưa khung game vào giữa màn hình khi bắt đầu chơi
        const rc = wrap.getBoundingClientRect();
        if (!document.fullscreenElement && (rc.top < -2 || rc.bottom > innerHeight + 2)) wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
        show('paidBar', mode === 'paid');
        if (mode === 'free' && m.code) toast(T('roomToast', { code: m.code }));
        break;
      case 's': onState(m); break;
      case 'lb':
        lbData = m;
        renderLeaderboard();
        if (m.paid) renderPaidBar(m.paid);
        break;
      case 'dead':
        alive = false;
        setTimeout(() => {
          if (alive || (mode !== 'free' && mode !== 'paid')) return;
          if (mode === 'paid') {
            showDeath(T('eliminated'), T('place', { p: m.place }) + ' · ' + (m.by ? T('killedBy', { name: m.by }) : T('hitRing')),
              { watch: true, again: true, againLabel: T('backLobby') });
          } else {
            showDeath(T('youDied'), T('finalLength', { m: m.mass }) + ' · ' + (m.by ? T('killedBy', { name: m.by }) : T('hitWall')),
              { again: true });
          }
        }, 1200);
        break;
      case 'result':
        alive = false;
        show('hud', false);
        if (m.won) showDeath(T('youWon'), T('prizeAdded', { amount: usd(m.prize) }), { again: true, againLabel: T('backLobby') });
        else showDeath(T('matchOver'), T('winnerWon', { name: m.winner, amount: usd(m.prize) }), { again: true, againLabel: T('backLobby') });
        mode = 'ended';
        break;
    }
  }

  function renderPaidBar(p) {
    const bar = $('paidBar');
    const mm = String(Math.floor(p.tLeft / 60)), ss = String(p.tLeft % 60).padStart(2, '0');
    bar.textContent = '';
    const parts = [
      ['', T('left', { l: p.left, t: p.total })],
      ['gold', ` · 🏆 ${usd(p.prize)} USDT`],
      ['', ` · ⏱ ${mm}:${ss}`],
      ['red', ' · ' + (p.shrinkIn > 0 ? T('ringIn', { s: p.shrinkIn }) : T('ringNow'))],
    ];
    for (const [cls, text] of parts) {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = text;
      bar.appendChild(s);
    }
  }

  function onState(m) {
    const now = Date.now();
    const d = now - m.ts;
    if (clockOffset === null || d < clockOffset) clockOffset = d;
    else clockOffset += (d - clockOffset) * 0.02;
    // Độ giật: lấy mức muộn ở 95% gói trong ~3 giây gần nhất, cộng 1 nhịp gửi (33ms)
    lateness.push(d - clockOffset);
    if (lateness.length > 90) lateness.shift();
    const sorted = [...lateness].sort((a, b) => a - b);
    const want = Math.min(INTERP_MAX, Math.max(INTERP_MIN, sorted[Math.floor(sorted.length * 0.95)] + 40));
    interpDelay += (want - interpDelay) * (want > interpDelay ? 0.2 : 0.02);   // tăng nhanh, giảm từ từ

    const map = new Map();
    for (const a of m.sn) map.set(a[0], { id: a[0], name: a[1], skin: a[2], r: a[3] / 10, boost: a[4], ang: a[5] / 100, pts: a[6], hue: a[7] });
    snaps.push({ ts: m.ts, snakes: map, vr: m.vr, vx: m.vx, vy: m.vy, wr: m.wr });
    if (snaps.length > 40) snaps.shift();

    const fa = m.fa;
    for (let i = 0; i < fa.length; i += 5) {
      foods.set(fa[i], { x: fa[i + 1], y: fa[i + 2], v: fa[i + 3], hue: fa[i + 4], ph: Math.random() * 6.28, born: now });
    }
    const fr = m.fr;
    for (let i = 0; i < fr.length; i += 2) {
      const f = foods.get(fr[i]);
      if (!f) continue;
      foods.delete(fr[i]);
      if (fr[i + 1]) eatAnims.push({ x: f.x, y: f.y, v: f.v, hue: f.hue, eater: fr[i + 1], t0: now });
    }
    if (m.m !== undefined) myMass = m.m;
  }

  setInterval(() => {
    if (!alive || !ws || ws.readyState !== 1) return;
    if (sentAngle === null || Math.abs(angleDiff(sentAngle, mouseAngle)) > 0.015 || sentBoost !== boost) {
      sentAngle = mouseAngle; sentBoost = boost;
      sendMsg({ t: 'in', a: Math.round(mouseAngle * 1000) / 1000, b: boost ? 1 : 0 });
    }
  }, 33);

  // ------------------------------------------------------------ input
  addEventListener('mousemove', e => { mouseAngle = angleFrom(e.clientX, e.clientY); });
  canvas.addEventListener('mousedown', () => { boost = true; });
  addEventListener('mouseup', () => { boost = false; });
  addEventListener('keydown', e => {
    if ((e.code === 'Space' || e.code === 'ArrowUp') && alive) { boost = true; e.preventDefault(); }
  });
  addEventListener('keyup', e => { if (e.code === 'Space' || e.code === 'ArrowUp') boost = false; });
  let boostBtnHeld = false;
  const onTouch = e => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) mouseAngle = angleFrom(t.clientX, t.clientY);
    boost = e.touches.length >= 2 || boostBtnHeld;
  };
  canvas.addEventListener('touchstart', onTouch, { passive: false });
  canvas.addEventListener('touchmove', onTouch, { passive: false });
  canvas.addEventListener('touchend', onTouch, { passive: false });
  const bb = $('boostBtn');
  bb.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); boostBtnHeld = boost = true; }, { passive: false });
  bb.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); boostBtnHeld = boost = false; }, { passive: false });

  // ------------------------------------------------------------ sprites (vẽ sẵn cho nhanh)
  const foodSprites = new Map();
  function mk(size, paint) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    paint(c.getContext('2d'), size); return c;
  }
  function getFoodSprite(h) {
    let s = foodSprites.get(h);
    if (s) return s;
    s = mk(64, (g, n) => {
      const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grd.addColorStop(0, `hsla(${h},100%,88%,1)`);
      grd.addColorStop(0.3, `hsla(${h},100%,62%,1)`);
      grd.addColorStop(0.42, `hsla(${h},100%,55%,0.45)`);
      grd.addColorStop(1, `hsla(${h},100%,50%,0)`);
      g.fillStyle = grd; g.fillRect(0, 0, n, n);
    });
    foodSprites.set(h, s);
    return s;
  }
  const bgPattern = (() => {
    const s = 30, w = 90, h = 52;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#10151b'; g.fillRect(0, 0, w, h);
    const hex = (cx, cy) => {
      g.beginPath();
      g.moveTo(cx + s - 2, cy); g.lineTo(cx + s / 2 - 1, cy + h / 2 - 2); g.lineTo(cx - s / 2 + 1, cy + h / 2 - 2);
      g.lineTo(cx - s + 2, cy); g.lineTo(cx - s / 2 + 1, cy - h / 2 + 2); g.lineTo(cx + s / 2 - 1, cy - h / 2 + 2);
      g.closePath(); g.fill();
    };
    g.fillStyle = '#18202a';
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]]) hex(x, y);
    return ctx.createPattern(c, 'repeat');
  })();

  // ------------------------------------------------------------ interpolation
  function getFrame(now) {
    if (!snaps.length) return null;
    const rt = now - clockOffset - interpDelay;
    let a = -1;
    for (let k = snaps.length - 1; k >= 0; k--) if (snaps[k].ts <= rt) { a = k; break; }
    if (a < 0) return snaps[0];
    let t;
    if (a === snaps.length - 1) {
      // Gói tiếp theo chưa tới: đoán tiếp chuyển động từ 2 gói cuối (tối đa EXTRAP_MAX) thay vì đứng hình
      if (a === 0) return snaps[0];
      a--;
      const dt = snaps[a + 1].ts - snaps[a].ts;
      t = Math.min((rt - snaps[a].ts) / dt, 1 + EXTRAP_MAX / dt);
    }
    const s0 = snaps[a], s1 = snaps[a + 1];
    if (t === undefined) t = (rt - s0.ts) / (s1.ts - s0.ts);
    const out = new Map();
    for (const [id, b] of s1.snakes) {
      const p = s0.snakes.get(id);
      if (!p) { out.set(id, b); continue; }
      const n = b.pts.length, m = p.pts.length, pts = new Array(n);
      for (let j = 0; j < n; j++) pts[j] = j < m ? p.pts[j] + (b.pts[j] - p.pts[j]) * t : b.pts[j];
      out.set(id, { id, name: b.name, skin: b.skin, hue: b.hue, boost: b.boost, r: p.r + (b.r - p.r) * t, ang: p.ang + angleDiff(p.ang, b.ang) * t, pts });
    }
    if (a > 2) snaps.splice(0, a - 2);
    const L = (x, y) => x + (y - x) * t;
    return { snakes: out, vr: L(s0.vr, s1.vr), vx: L(s0.vx, s1.vx), vy: L(s0.vy, s1.vy), wr: L(s0.wr, s1.wr) };
  }

  // ------------------------------------------------------------ rendering
  function drawSnake(s, isMe, now) {
    if (s.pts.length < 4) return;
    const P = Skins.resampleFlat(s.pts, s.r, s.ang);
    Skins.draw(ctx, P, s.skin, now / 1000, s.r, isMe ? mouseAngle : s.ang, s.boost, s.hue);
  }

  function foodRadius(v) { return 3 + Math.sqrt(v) * 2.6; }

  function render() {
    requestAnimationFrame(render);
    const now = Date.now();
    drawSkinPreviews(performance.now() / 1000);
    const fr = mode && clockOffset !== null ? getFrame(now) : null;
    const me = fr ? fr.snakes.get(myId) : null;
    if (fr) ringR = fr.wr;

    if (me && alive) { cam.x = me.pts[0]; cam.y = me.pts[1]; }
    else if (fr) { cam.x += (fr.vx - cam.x) * 0.1; cam.y += (fr.vy - cam.y) * 0.1; }
    else { cam.x = Math.cos(now / 12000) * 600; cam.y = Math.sin(now / 12000) * 600; ringR = 4000; }

    const halfDiag = Math.hypot(W, H) / 2;
    const target = halfDiag / (fr ? fr.vr : 1000) * (halfDiag < 700 ? 1.5 : 1);
    scale += (target - scale) * 0.05;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#0d1116';
    ctx.fillRect(0, 0, W, H);

    const k = scale * DPR;
    ctx.setTransform(k, 0, 0, k, (W / 2 - cam.x * scale) * DPR, (H / 2 - cam.y * scale) * DPR);
    const hw = W / 2 / scale, hh = H / 2 / scale;
    const x0 = cam.x - hw, x1 = cam.x + hw, y0 = cam.y - hh, y1 = cam.y + hh;

    ctx.fillStyle = bgPattern;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    // vùng ngoài biên / vòng bo
    ctx.beginPath();
    ctx.rect(x0 - 10, y0 - 10, x1 - x0 + 20, y1 - y0 + 20);
    ctx.arc(0, 0, ringR, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(80, 0, 12, 0.6)';
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(0, 0, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 50, 70, 0.8)';
    ctx.lineWidth = 10;
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    if (fr) {
      for (const f of foods.values()) {
        if (f.x < x0 - 40 || f.x > x1 + 40 || f.y < y0 - 40 || f.y > y1 + 40) continue;
        const age = Math.min(1, (now - f.born) / 300);
        const rr = foodRadius(f.v) * (0.85 + 0.15 * Math.sin(now / 280 + f.ph)) * age * 2.5;
        ctx.drawImage(getFoodSprite(f.hue), f.x - rr, f.y - rr, rr * 2, rr * 2);
      }
    }
    for (let i = eatAnims.length - 1; i >= 0; i--) {
      const a = eatAnims[i];
      const p = (now - a.t0) / 250;
      if (p >= 1) { eatAnims.splice(i, 1); continue; }
      const e = fr && fr.snakes.get(a.eater);
      let x = a.x, y = a.y;
      if (e) { x += (e.pts[0] - a.x) * p; y += (e.pts[1] - a.y) * p; }
      const rr = foodRadius(a.v) * (1 - p) * 2.5;
      ctx.drawImage(getFoodSprite(a.hue), x - rr, y - rr, rr * 2, rr * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    if (fr) {
      for (const s of fr.snakes.values()) if (s.id !== myId) drawSnake(s, false, now);
      if (me) drawSnake(me, true, now);

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (const s of fr.snakes.values()) {
        if (s.id === myId) continue;
        const sx = (s.pts[0] - cam.x) * scale + W / 2, sy = (s.pts[1] - cam.y) * scale + H / 2 + s.r * scale + 16;
        if (sx > -100 && sx < W + 100 && sy > -20 && sy < H + 20) ctx.fillText(s.name, sx, sy);
      }
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    if (mode === 'free' || mode === 'paid') {
      drawMinimap(me);
      if (alive && myMass !== shownMass) {
        shownMass = myMass;
        $('score').textContent = T('length');
        const b = document.createElement('b');
        b.textContent = myMass;
        $('score').appendChild(b);
      }
    }
  }

  function drawMinimap(me) {
    const s = mini.width, c = s / 2, R = s / 2 - 3;
    mctx.clearRect(0, 0, s, s);
    mctx.fillStyle = 'rgba(16, 22, 30, 0.7)';
    mctx.beginPath(); mctx.arc(c, c, R, 0, Math.PI * 2); mctx.fill();
    mctx.strokeStyle = 'rgba(255,255,255,0.25)'; mctx.lineWidth = 2; mctx.stroke();
    if (ringR < baseR - 1) {
      mctx.strokeStyle = 'rgba(255,60,80,0.9)';
      mctx.beginPath(); mctx.arc(c, c, R * ringR / baseR, 0, Math.PI * 2); mctx.stroke();
    }
    if (lbData && lbData.mm) {
      mctx.fillStyle = 'rgba(255,255,255,0.4)';
      for (let i = 0; i < lbData.mm.length; i += 2) {
        mctx.beginPath(); mctx.arc(c + lbData.mm[i] / 100 * R, c + lbData.mm[i + 1] / 100 * R, 2.5, 0, Math.PI * 2); mctx.fill();
      }
    }
    if (me) {
      mctx.fillStyle = `hsl(${me.hue || 0},100%,60%)`;
      mctx.strokeStyle = '#fff'; mctx.lineWidth = 1.5;
      mctx.beginPath(); mctx.arc(c + me.pts[0] / baseR * R, c + me.pts[1] / baseR * R, 4, 0, Math.PI * 2);
      mctx.fill(); mctx.stroke();
    }
  }

  function renderLeaderboard() {
    const ol = $('lbList');
    ol.textContent = '';
    for (const [id, name, mass] of lbData.top) {
      const li = document.createElement('li');
      if (id === myId && alive) li.className = 'me';
      const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
      const m = document.createElement('span'); m.className = 'm'; m.textContent = mass;
      li.append(n, m);
      ol.appendChild(li);
    }
    $('rank').textContent = alive && lbData.rank ? T('yourRank', { r: lbData.rank, n: lbData.n }) : '';
  }

  requestAnimationFrame(render);
})();
