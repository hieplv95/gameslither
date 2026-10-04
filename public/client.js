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
  let mySkin = Math.floor(Math.random() * Skins.FREE);
  let myHue = HUES[Math.floor(Math.random() * HUES.length)];
  // Cửa hàng: xu, mẫu đã mua, bảng giá (server gửi trong tin 'acct')
  let coins = 0, owned = new Set(), prices = new Map(), earn = { per: 10, kill: 5 };
  const unlocked = i => i < Skins.FREE || owned.has(i);
  const curSkin = () => (unlocked(mySkin) ? mySkin : Skins.CLASSIC);
  const look = () => ({ skin: curSkin(), hue: myHue });
  const num = n => n.toLocaleString(LOCALE);
  let ach = [];                 // mẫu thành tích: [mẫu, loại, mốc]
  const infoCache = new Map();  // id rắn -> { name, skin, hue } (server chỉ gửi lần đầu client thấy con rắn đó)
  const bursts = [];            // hiệu ứng nổ khi rắn chết
  let roomCode = null, lastRun = null;
  // Link mời: ?room=ABCD → bấm "Chơi ngay" là vào đúng phòng đó
  let pendingRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(pendingRoom)) pendingRoom = '';
  const unitFmt = unit => { try { return new Intl.NumberFormat(LOCALE, { style: 'unit', unit, unitDisplay: 'long' }); } catch { return { format: n => `${n} ${unit}` }; } };
  const MIN_FMT = unitFmt('minute'), HOUR_FMT = unitFmt('hour');
  const fmtMin = sec => MIN_FMT.format(Math.round(sec / 60));
  const fmtHM = sec => { const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return (h ? HOUR_FMT.format(h) + ' ' : '') + MIN_FMT.format(m); };
  const fmtClock = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  function copyText(s) {
    try { return navigator.clipboard.writeText(s).then(() => true, () => false); } catch { return Promise.resolve(false); }
  }

  // ------------------------------------------------------------ âm thanh (tổng hợp bằng WebAudio, không cần file) + rung
  let muted = lsGet('rn_mute') === '1', ac = null, acted = false, lastEat = 0;
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => { acted = true; }, { once: true, capture: true });
  function audio() {
    if (muted || !acted) return null;   // trình duyệt chỉ cho phát tiếng sau khi người dùng đã bấm gì đó
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(freq, dur, { type = 'sine', vol = 0.15, to, delay = 0 } = {}) {
    const a = audio();
    if (!a) return;
    const t0 = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const sfx = {
    eat(v) {
      const t = performance.now();
      if (t - lastEat < 70) return;
      lastEat = t;
      tone(500 + Math.random() * 160 + v * 40, 0.07, { vol: 0.045, to: 900 });
    },
    boost() { tone(190, 0.28, { type: 'sawtooth', vol: 0.035, to: 85 }); },
    kill() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, { type: 'triangle', vol: 0.11, delay: i * 0.07 })); },
    die() { tone(420, 0.7, { type: 'sawtooth', vol: 0.07, to: 60 }); },
    coin() { tone(988, 0.08, { type: 'square', vol: 0.04 }); tone(1319, 0.22, { type: 'square', vol: 0.04, delay: 0.08 }); },
  };
  const buzz = p => { try { if (acted && navigator.vibrate) navigator.vibrate(p); } catch { /* không hỗ trợ */ } };
  function renderMute() {
    $('muteBtn').textContent = muted ? '🔇' : '🔊';
    $('muteBtn').setAttribute('aria-pressed', muted);
  }
  $('muteBtn').onclick = () => { muted = !muted; lsSet('rn_mute', muted ? '1' : '0'); renderMute(); };
  renderMute();

  // ------------------------------------------------------------ menu
  {
    const k = lsGet('rn_skin'); if (k !== null && Skins.SKINS[+k]) mySkin = +k;
    const h = lsGet('rn_hue'); if (h !== null && !isNaN(+h)) myHue = +h;
    const n = lsGet('rn_name'); if (n) $('name').value = n;
  }
  const skinsEl = $('skins');
  const skinCanvases = [], shopCanvases = [];
  // Cổ điển đứng đầu, sau đó là 5 mẫu hoa văn, rồi các mẫu cờ đã mua
  function renderPicker() {
    skinsEl.textContent = '';
    skinCanvases.length = 0;
    const order = [Skins.CLASSIC, ...Skins.SKINS.keys()].filter((v, i, arr) => arr.indexOf(v) === i && unlocked(v));
    for (const i of order) {
      const b = document.createElement('button');
      b.className = 'skin' + (i === curSkin() ? ' sel' : '');
      const cv = document.createElement('canvas');
      const label = document.createElement('span');
      label.textContent = Skins.nameOf(i);
      b.append(cv, label);
      b.onclick = () => selectSkin(i);
      skinsEl.appendChild(b);
      skinCanvases.push([cv, i]);
    }
    show('hues', curSkin() === Skins.CLASSIC);
  }
  function selectSkin(i) {
    mySkin = i; lsSet('rn_skin', i);
    renderPicker();
    if (!$('shopModal').classList.contains('hidden')) renderShop();
  }
  renderPicker();

  // ------------------------------------------------------------ cửa hàng mẫu rắn
  function setCoins(n) { coins = n; $('coins').textContent = num(n); }
  function renderShop() {
    $('shopCoins').textContent = num(coins);
    $('shopIntro').textContent = T('shopIntro', { per: earn.per, kill: earn.kill });
    const list = $('shopList');
    list.textContent = '';
    shopCanvases.length = 0;
    for (const [i, price] of prices) {
      const item = document.createElement('div');
      item.className = 'shop-item' + (owned.has(i) ? ' owned' : '');
      const cv = document.createElement('canvas');
      const name = document.createElement('b');
      name.textContent = Skins.nameOf(i);
      const btn = document.createElement('button');
      if (owned.has(i)) {
        const using = curSkin() === i;
        btn.className = 'btn sm ghost';
        btn.textContent = using ? T('inUse') : T('use');
        btn.disabled = using;
        btn.onclick = () => selectSkin(i);
      } else {
        btn.className = 'btn sm';
        btn.textContent = `🪙 ${num(price)}`;
        btn.title = `${T('buy')} · ${num(price)}`;
        btn.setAttribute('aria-label', btn.title);
        btn.disabled = coins < price;
        btn.onclick = () => sendMsg({ t: 'buySkin', skin: i });
      }
      item.append(cv, name, btn);
      list.appendChild(item);
      shopCanvases.push([cv, i]);
    }
    // mẫu thành tích: không bán, ghi điều kiện mở khoá
    for (const [i, kind, n] of ach) {
      const item = document.createElement('div');
      item.className = 'shop-item ach' + (owned.has(i) ? ' owned' : '');
      const cv = document.createElement('canvas');
      const name = document.createElement('b');
      name.textContent = Skins.nameOf(i);
      let el;
      if (owned.has(i)) {
        el = document.createElement('button');
        const using = curSkin() === i;
        el.className = 'btn sm ghost';
        el.textContent = using ? T('inUse') : T('use');
        el.disabled = using;
        el.onclick = () => selectSkin(i);
      } else {
        el = document.createElement('small');
        el.textContent = '🔒 ' + achText(kind, n);
      }
      item.append(cv, name, el);
      list.appendChild(item);
      shopCanvases.push([cv, i]);
    }
  }
  const achText = (kind, n) => T('ach.' + kind, { n: num(n), t: fmtMin(n) });
  $('openShop').onclick = () => { renderShop(); show('shopModal'); };
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
  // Rắn nhỏ uốn lượn tại chỗ trong mỗi ô chọn mẫu / ô cửa hàng (ô đang ẩn có clientWidth = 0 nên bỏ qua)
  function drawSkinPreviews(t) {
    if ($('menu').classList.contains('hidden')) return;
    for (const [cv, i] of [...skinCanvases, ...shopCanvases, ...achCanvases]) {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w) continue;
      if (cv.width !== Math.round(w * DPR)) { cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); }
      const g = cv.getContext('2d');
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, w, h);
      const r = Math.min(10, h * 0.17), pts = [];
      for (let j = 0, x = w - r * 1.8; x > r; j++, x -= 3) pts.push(x, h / 2 + Math.sin(t * 3 - j * 0.14) * h * 0.16);
      const P = Skins.resampleFlat(pts, r, Math.atan2(pts[1] - pts[3], pts[0] - pts[2]));
      Skins.draw(g, P, i, t, r, P[0].a, false, myHue);
    }
  }
  const myName = () => {
    const n = $('name').value.trim().slice(0, 16) || T('guest');
    lsSet('rn_name', n);
    return n;
  };

  // Thông báo nhỏ ở đáy khung game. Nhiều thông báo liền nhau thì xếp hàng hiện lần lượt (lỗi thì hiện ngay).
  let toastTimer = 0;
  const toastQueue = [];
  function toast(msg, isErr) {
    if (isErr) toastQueue.length = 0;
    else if (toastTimer) { if (toastQueue.length < 4) toastQueue.push(msg); return; }
    const t = $('toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      t.classList.add('hidden');
      if (toastQueue.length) toast(toastQueue.shift());
    }, toastQueue.length ? 2500 : 3500);
  }

  const MODALS = ['roomsModal', 'walletModal', 'shopModal', 'missionsModal', 'hofModal', 'accountModal'];
  function showLobby(msg) {
    mode = null; alive = false; inQueue = false;
    for (const id of ['death', 'hud', 'queue', ...MODALS]) show(id, false);
    show('menu');
    renderInvite();
    $('status').textContent = msg || '';
    snaps.length = 0;
  }

  // ------------------------------------------------------------ connection
  function sendMsg(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function connect() {
    $('status').textContent = T('connecting');
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { $('status').textContent = ''; sendMsg({ t: 'hello', token: lsGet('rn_token'), lang: LANG }); };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') { onState(decodeState(e.data)); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      ws = null;
      showLobby(T('disconnected'));
      setTimeout(connect, 2000);
    };
  }
  connect();

  // Gói trạng thái nhị phân — cấu trúc ghi ở room.js (phần "gói trạng thái nhị phân")
  const utf8 = new TextDecoder();
  function decodeState(buf) {
    const v = new DataView(buf);
    let o = 1;
    const u8 = () => v.getUint8(o++), i8 = () => v.getInt8(o++);
    const u16 = () => { const x = v.getUint16(o, true); o += 2; return x; };
    const i16 = () => { const x = v.getInt16(o, true); o += 2; return x; };
    const u32 = () => { const x = v.getUint32(o, true); o += 4; return x; };
    const ts = v.getFloat64(o, true); o += 8;
    const vx = i16(), vy = i16(), vr = u16(), wr = u16();
    const m = v.getInt32(o, true); o += 4;
    const sn = [];
    for (let k = u16(); k > 0; k--) {
      const id = u32(), fl = u8(), r = u16() / 10, ang = i16() / 10000;
      if (fl & 2) {
        const skin = u8(), hue = u16(), len = u8();
        infoCache.set(id, { name: utf8.decode(new Uint8Array(buf, o, len)), skin, hue });
        o += len;
      }
      const info = infoCache.get(id) || { name: '', skin: 0, hue: 0 };
      const n = u16(), pts = new Array(n * 2);
      let x = i16(), y = i16();
      pts[0] = x; pts[1] = y;
      for (let j = 1; j < n; j++) {
        if (fl & 4) { x = i16(); y = i16(); } else { x += i8(); y += i8(); }
        pts[j * 2] = x; pts[j * 2 + 1] = y;
      }
      sn.push({ id, name: info.name, skin: info.skin, hue: info.hue, r, boost: fl & 1, ang, pts });
    }
    const fa = [], fr = [];
    for (let k = u16(); k > 0; k--) fa.push(u32(), i16(), i16(), u8(), u16());
    for (let k = u16(); k > 0; k--) fr.push(u32(), u32());
    return { ts, vx, vy, vr, wr, m: m < 0 ? undefined : m, sn, fa, fr };
  }

  // ------------------------------------------------------------ lobby actions
  function renderInvite() {
    $('inviteInfo').textContent = pendingRoom ? T('invited', { code: pendingRoom }) : '';
    show('inviteInfo', !!pendingRoom);
  }
  renderInvite();
  $('play').onclick = () => {
    if (pendingRoom) {
      sendMsg({ t: 'joinFree', code: pendingRoom, name: myName(), ...look() });
      pendingRoom = '';
      renderInvite();
      try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* ignore */ }
    } else sendMsg({ t: 'joinFree', name: myName(), ...look() });
  };
  $('inviteBtn').onclick = () => {
    if (!roomCode) return;
    const link = `${location.origin}${location.pathname}?room=${roomCode}`;
    copyText(link).then(ok => toast(ok ? T('inviteCopied') : link));
  };
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('play').click(); });
  $('pickRoom').onclick = () => { renderRooms(); show('roomsModal'); };
  $('joinCode').onclick = () => {
    const code = $('roomCode').value.trim().toUpperCase();
    if (code) sendMsg({ t: 'joinFree', code, name: myName(), ...look() });
  };
  $('createRoom').onclick = () => sendMsg({ t: 'joinFree', create: true, name: myName(), ...look() });
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
      btn.onclick = () => sendMsg({ t: 'joinFree', code, name: myName(), ...look() });
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
        b.onclick = () => sendMsg({ t: 'joinPaid', stake, name: myName(), ...look() });
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

  // ------------------------------------------------------------ nhiệm vụ, quà đăng nhập, thành tích
  const achCanvases = [];
  $('openMissions').onclick = () => { sendMsg({ t: 'missions' }); show('missionDot', false); show('missionsModal'); };
  const missionText = m => T('m.' + m.kind, { n: num(m.n), t: fmtMin(m.n) });
  function renderMissions(d) {
    const ul = $('missionList');
    ul.textContent = '';
    d.list.forEach((m, i) => {
      const done = d.prog.done.includes(i), cur = Math.min(m.n, d.prog[m.kind] || 0);
      const li = document.createElement('li');
      if (done) li.className = 'done';
      const top = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = (done ? '✅ ' : '') + missionText(m);
      const reward = document.createElement('b');
      reward.textContent = `🪙 ${num(m.reward)}`;
      top.append(label, reward);
      const bar = document.createElement('div');
      bar.className = 'mbar';
      const fill = document.createElement('i');
      fill.style.width = (done ? 100 : cur / m.n * 100) + '%';
      bar.appendChild(fill);
      const val = document.createElement('small');
      val.textContent = m.kind === 'time' ? `${fmtClock(done ? m.n : cur)} / ${fmtClock(m.n)}` : `${num(done ? m.n : cur)} / ${num(m.n)}`;
      li.append(top, bar, val);
      ul.appendChild(li);
    });
    $('missionReset').textContent = T('missionsReset', { t: fmtHM(d.reset) });
    // quà đăng nhập 7 ngày, ngày đã nhận được tô sáng
    const row = $('streakRow');
    row.textContent = '';
    const today = d.streak ? ((d.streak - 1) % d.rewards.length) + 1 : 0;
    d.rewards.forEach((r, i) => {
      const box = document.createElement('div');
      box.className = 'sday' + (i < today ? ' got' : '') + (i === today - 1 ? ' today' : '');
      const a = document.createElement('small'); a.textContent = T('streakDay', { n: i + 1 });
      const b = document.createElement('b'); b.textContent = `🪙${r}`;
      box.append(a, b);
      row.appendChild(box);
    });
    const al = $('achList');
    al.textContent = '';
    achCanvases.length = 0;
    for (const [i, kind, n] of ach) {
      const li = document.createElement('li');
      li.className = 'ach-row' + (owned.has(i) ? ' done' : '');
      const cv = document.createElement('canvas');
      const txt = document.createElement('div');
      const b = document.createElement('b'); b.textContent = Skins.nameOf(i);
      const s = document.createElement('small'); s.textContent = (owned.has(i) ? '✅ ' : '🔒 ') + achText(kind, n);
      txt.append(b, s);
      li.append(cv, txt);
      al.appendChild(li);
      achCanvases.push([cv, i]);
    }
  }

  // ------------------------------------------------------------ bảng vàng
  let hof = null, hofTab = 'week';
  $('openHof').onclick = () => { sendMsg({ t: 'hof' }); show('hofModal'); renderHof(); };
  for (const b of document.querySelectorAll('[data-hof]')) b.onclick = () => { hofTab = b.dataset.hof; renderHof(); };
  function renderHof() {
    for (const b of document.querySelectorAll('[data-hof]')) b.classList.toggle('on', b.dataset.hof === hofTab);
    const ol = $('hofList');
    ol.textContent = '';
    const rows = hof ? hof[hofTab] : [];
    if (hof && !rows.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = T('hofEmpty'); ol.appendChild(li); }
    rows.forEach(([name, len, kills], i) => {
      const li = document.createElement('li');
      const medal = document.createElement('i'); medal.textContent = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = name;
      const k = document.createElement('small'); k.textContent = `⚔ ${num(kills)}`;
      const m = document.createElement('b'); m.textContent = num(len);
      li.append(medal, n, k, m);
      ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------ tài khoản: mã khôi phục
  let restoring = false;
  $('openAccount').onclick = () => { show('codeBox', false); show('accountModal'); };
  $('makeCode').onclick = () => sendMsg({ t: 'recoveryCode' });
  $('copyCode').onclick = () => copyText($('codeText').textContent).then(ok => { if (ok) toast(T('copied')); });
  $('restoreBtn').onclick = () => {
    const code = $('restoreCode').value.trim();
    if (!code) return;
    restoring = true;
    sendMsg({ t: 'recover', code });
  };

  // ------------------------------------------------------------ queue / result
  $('qLeave').onclick = () => sendMsg({ t: 'leaveQueue' });
  $('again').onclick = () => {
    show('death', false);
    if (mode === 'free') sendMsg({ t: 'joinFree', name: myName(), ...look() });
    else { sendMsg({ t: 'leave' }); showLobby(); }
  };
  $('toMenu').onclick = () => { sendMsg({ t: 'leave' }); showLobby(); };
  $('watch').onclick = () => { show('death', false); show('hud'); };
  $('shareBtn').onclick = () => shareRun();

  // opts: { again, againLabel, watch, stats: [[nhãn, giá trị]], extra: [dòng], share }
  function showDeath(title, text, opts) {
    $('deathTitle').textContent = title;
    $('deathText').textContent = text;
    $('again').textContent = opts.againLabel || T('playAgain');
    const st = $('deathStats');
    st.textContent = '';
    for (const [label, value] of opts.stats || []) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = value;
      const s = document.createElement('span'); s.textContent = label;
      d.append(b, s);
      st.appendChild(d);
    }
    show('deathStats', !!(opts.stats && opts.stats.length));
    const ex = $('deathExtra');
    ex.textContent = '';
    for (const line of opts.extra || []) { const p = document.createElement('p'); p.textContent = line; ex.appendChild(p); }
    show('again', !!opts.again);
    show('watch', !!opts.watch);
    show('shareBtn', !!opts.share);
    show('toMenu', !opts.againLabel);
    show('death');
  }

  // Ảnh kết quả 1200×630 để khoe lên mạng xã hội: điện thoại mở bảng chia sẻ, máy tính tải ảnh về + chép sẵn lời mời
  async function shareRun() {
    const r = lastRun;
    if (!r) return;
    const cv = document.createElement('canvas');
    cv.width = 1200; cv.height = 630;
    const g = cv.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 1200, 630);
    bg.addColorStop(0, '#0b1d26'); bg.addColorStop(1, '#10151b');
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    for (let y = 0, row = 0; y < 680; y += 52, row++) for (let x = (row % 2) * 45; x < 1250; x += 90) { g.beginPath(); g.arc(x, y, 22, 0, Math.PI * 2); g.fill(); }
    const pts = [];
    for (let x = 1130; x > 60; x -= 6) pts.push(x, 485 + Math.sin(x / 110) * 55);
    const P = Skins.resampleFlat(pts, 34, Math.atan2(pts[1] - pts[3], pts[0] - pts[2]));
    Skins.draw(g, P, curSkin(), 1, 34, P[0].a, false, myHue);
    g.textAlign = 'left';
    g.font = '900 64px system-ui, sans-serif';
    g.fillStyle = '#fff'; g.fillText('Game', 70, 112);
    g.fillStyle = '#7cff6b'; g.fillText('Slither', 70 + g.measureText('Game').width, 112);
    g.fillStyle = '#fbbf24'; g.font = '900 150px system-ui, sans-serif'; g.fillText(num(r.peak), 66, 285);
    g.fillStyle = '#cbd5e1'; g.font = '700 40px system-ui, sans-serif';
    g.fillText(`${T('shareLength')}  ·  ⚔ ${num(r.kills)} ${T('shareKills')}  ·  ⏱ ${fmtClock(r.time)}`, 72, 350);
    g.fillStyle = '#93a4b8'; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'right';
    g.fillText(`${T('shareCta')} ${location.host}`, 1130, 600);
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
    if (!blob) return;
    const text = T('shareText', { m: num(r.peak), k: num(r.kills) }), url = location.origin + location.pathname;
    const file = new File([blob], 'gameslither.jpg', { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, url }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gameslither.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    copyText(`${text} ${url}`);
    toast(T('shareSaved'));
  }

  // ------------------------------------------------------------ dòng hạ gục, thông báo giữa màn hình, hiệu ứng nổ
  function killFeed(ev) {
    const feed = $('killFeed');
    const row = document.createElement('div');
    if (ev.kid === myId || ev.vid === myId) row.className = 'mine';
    const k = document.createElement('b'), v = document.createElement('b');
    k.textContent = ev.k; v.textContent = ev.v;
    const [before, after] = T('kfKill', { k: '\u0000', v: '\u0001' }).split('\u0000');
    const [mid, end] = after.split('\u0001');
    row.append(before, k, mid, v, end);
    feed.prepend(row);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => row.remove(), 5000);
  }
  let noticeTimer = 0;
  function notice(msg) {
    const n = $('notice');
    n.textContent = msg;
    n.classList.remove('pop');
    void n.offsetWidth;   // chạy lại hiệu ứng
    n.classList.add('pop');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => n.classList.remove('pop'), 1800);
  }
  function addBurst(ev) {
    if (Math.hypot(ev.x - cam.x, ev.y - cam.y) > 3000) return;
    const parts = [], n = ev.big ? 34 : 20;
    for (let i = 0; i < n; i++) parts.push({ a: Math.random() * Math.PI * 2, sp: 90 + Math.random() * (ev.big ? 300 : 190), r: 4 + Math.random() * (ev.big ? 9 : 6) });
    // hiện cùng lúc với hình ảnh (vốn được vẽ trễ interpDelay để nội suy)
    bursts.push({ x: ev.x, y: ev.y, hue: ev.hue, t0: Date.now() + interpDelay, parts, ring: ev.big ? 170 : 100 });
  }
  const missionLines = list => (list || []).map(m => '🎯 ' + T('missionDone', { name: missionText(m), n: num(m.reward) }));
  const skinLines = list => (list || []).map(i => '🏅 ' + T('newSkin', { name: Skins.nameOf(i) }));

  // ------------------------------------------------------------ messages
  function handle(m) {
    switch (m.t) {
      case 'acct':
        lsSet('rn_token', m.token);
        $('balance').textContent = usd(m.bal);
        owned = new Set(m.owned); prices = new Map(m.shop); earn = m.earn; ach = m.ach || [];
        setCoins(m.coins);
        renderPicker();
        if (m.checkIn && m.checkIn.reward) { toast('🎁 ' + T('streakToday', { day: m.checkIn.day, n: num(m.checkIn.reward) })); show('missionDot'); }
        for (const line of skinLines(m.newSkins)) toast(line);
        if (restoring) { restoring = false; show('accountModal', false); $('restoreCode').value = ''; }
        break;
      case 'missions': renderMissions(m); break;
      case 'mdone':
        setCoins(m.coins);
        for (const line of missionLines(m.list)) toast(line);
        if (m.list.length) { sfx.coin(); show('missionDot'); }
        break;
      case 'hof': hof = m; renderHof(); break;
      case 'recovery':
        $('codeText').textContent = m.code;
        show('codeBox');
        break;
      case 'kf':
        if (!mode) break;
        addBurst(m);
        if (m.k) killFeed(m);
        if (m.kid && m.kid === myId) { notice(T('youKilled', { name: m.v })); sfx.kill(); buzz(40); }
        break;
      case 'shop':
        owned = new Set(m.owned);
        setCoins(m.coins);
        if (m.bought !== undefined) { toast(T('bought', { name: Skins.nameOf(m.bought) })); selectSkin(m.bought); }
        else renderPicker();
        if (!$('shopModal').classList.contains('hidden')) renderShop();
        break;
      case 'bal':
        $('balance').textContent = usd(m.bal);
        break;
      case 'lobby':
        lobby = m;
        renderLobby();
        break;
      case 'err': restoring = false; toast(m.msg, true); break;
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
        infoCache.clear(); bursts.length = 0; $('killFeed').textContent = '';
        roomCode = m.mode === 'free' ? m.code : null;
        for (const id of ['menu', 'death', 'queue', ...MODALS]) show(id, false);
        show('hud');
        show('inviteBtn', !!roomCode);
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
      case 'dead': {
        alive = false;
        sfx.die(); buzz([80, 40, 140]);
        if (m.coins !== undefined) setCoins(m.coins);
        if (m.owned) { owned = new Set(m.owned); renderPicker(); }
        if ((m.mdone && m.mdone.length) || (m.newSkins && m.newSkins.length)) show('missionDot');
        lastRun = { peak: m.peak, kills: m.kills, time: m.time };
        const stats = [[T('statLength'), num(m.peak)], [T('statKills'), num(m.kills)], [T('statTime'), fmtClock(m.time)]];
        if (m.rank) stats.push([T('statRank'), '#' + m.rank]);
        setTimeout(() => {
          if (alive || (mode !== 'free' && mode !== 'paid')) return;
          if (mode === 'paid') {
            showDeath(T('eliminated'), T('place', { p: m.place }) + ' · ' + (m.by ? T('killedBy', { name: m.by }) : T('hitRing')),
              { watch: true, again: true, againLabel: T('backLobby'), stats });
          } else {
            if (m.earned !== undefined) stats.push([T('statCoins'), '+' + num(Math.max(0, m.earned))]);
            const why = m.by ? T('killedBy', { name: m.by }) : T('hitWall');
            showDeath(T('youDied'), why.charAt(0).toUpperCase() + why.slice(1),
              { again: true, stats, share: true, extra: [...missionLines(m.mdone), ...skinLines(m.newSkins)] });
          }
        }, 1200);
        break;
      }
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
    for (const a of m.sn) map.set(a.id, a);
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
      if (fr[i + 1] === myId && alive) sfx.eat(f.v);
    }
    if (m.m !== undefined) myMass = m.m;
  }

  setInterval(() => {
    if (!alive || !ws || ws.readyState !== 1) return;
    if (sentAngle === null || Math.abs(angleDiff(sentAngle, mouseAngle)) > 0.015 || sentBoost !== boost) {
      if (boost && !sentBoost && myMass > 15) sfx.boost();
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
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i], p = (now - b.t0) / 750;
      if (p >= 1) { bursts.splice(i, 1); continue; }
      if (p < 0) continue;
      const e = 1 - (1 - p) ** 3, spr = getFoodSprite(b.hue);
      ctx.globalAlpha = 1 - p;
      for (const q of b.parts) {
        const d = q.sp * e, rr = q.r * (1 - p * 0.6) * 2.5;
        ctx.drawImage(spr, b.x + Math.cos(q.a) * d - rr, b.y + Math.sin(q.a) * d - rr, rr * 2, rr * 2);
      }
      ctx.strokeStyle = `hsl(${b.hue},100%,70%)`;
      ctx.lineWidth = 8 * (1 - p);
      ctx.beginPath(); ctx.arc(b.x, b.y, b.ring * e + 10, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
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
