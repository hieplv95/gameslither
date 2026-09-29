'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const fmt = n => Number(n).toLocaleString('vi-VN');
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, parent) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---------------------------------------------------------------- API
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'x-admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* rỗng */ }
    if (!res.ok) { const e = new Error(data.error || `Lỗi ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ---------------------------------------------------------------- đăng nhập
  async function boot() {
    try {
      const me = await api('GET', '/admin/api/me');
      if (me.mustChange) forceChange(); else startApp();
    } catch (e) {
      if (e.status === 503) { $('disabledMsg').textContent = e.message; show('disabledView'); }
      else show('loginView');
    }
  }
  $('loginForm').onsubmit = async e => {
    e.preventDefault();
    $('lgError').textContent = '';
    try {
      const r = await api('POST', '/admin/api/login', { username: $('lgUser').value, password: $('lgPass').value });
      $('lgPass').value = '';
      show('loginView', false);
      if (r.mustChange) forceChange(); else startApp();
    } catch (err) { $('lgError').textContent = err.message; }
  };
  $('logout').onclick = async () => {
    await api('POST', '/admin/api/logout').catch(() => {});
    location.reload();
  };

  // ---------------------------------------------------------------- tab
  function setTab(name) {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.tab === name);
    for (const t of ['stats', 'seo', 'account']) show('tab-' + t, t === name);
    if (name === 'stats') renderChart();
  }
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { if (!b.disabled) setTab(b.dataset.tab); };

  // Còn dùng mật khẩu mặc định: chỉ mở tab Tài khoản, khoá các tab khác
  let forced = false;
  function forceChange() {
    forced = true;
    show('appView');
    show('forceBanner');
    for (const b of document.querySelectorAll('.tabs button')) b.disabled = b.dataset.tab !== 'account';
    setTab('account');
    $('pwCur').focus();
  }

  $('pwForm').onsubmit = async e => {
    e.preventDefault();
    $('pwError').textContent = '';
    if ($('pwNew').value !== $('pwConfirm').value) { $('pwError').textContent = 'Hai lần nhập mật khẩu mới không khớp.'; return; }
    try {
      await api('PUT', '/admin/api/password', { current: $('pwCur').value, next: $('pwNew').value });
      for (const id of ['pwCur', 'pwNew', 'pwConfirm']) $(id).value = '';
      toast('Đã đổi mật khẩu.');
      if (forced) {
        forced = false;
        show('forceBanner', false);
        for (const b of document.querySelectorAll('.tabs button')) b.disabled = false;
        setTab('stats');
        startApp();
      }
    } catch (err) {
      if (err.status === 401) location.reload();
      else $('pwError').textContent = err.message;
    }
  };

  let started = false;
  function startApp() {
    if (started) return;
    started = true;
    show('appView');
    loadStats();
    loadSeo();
    setInterval(loadStats, 30_000); // cập nhật số người online
  }

  // ---------------------------------------------------------------- thống kê
  let days = 30, stats = null;
  for (const b of document.querySelectorAll('.range button')) {
    b.onclick = () => {
      days = Number(b.dataset.days);
      for (const x of document.querySelectorAll('.range button')) x.classList.toggle('on', x === b);
      loadStats();
    };
  }
  async function loadStats() {
    try {
      stats = await api('GET', `/admin/api/stats?days=${days}`);
      renderStats();
    } catch (e) {
      if (e.status === 401) location.reload();
      else toast(e.message, true);
    }
  }

  const SERIES = [
    { key: 'visits', name: 'Lượt truy cập', color: '--series-1' },
    { key: 'visitors', name: 'Khách', color: '--series-2' },
    { key: 'plays', name: 'Lượt chơi', color: '--series-3' },
  ];
  const dm = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  function renderStats() {
    const s = stats;
    $('kVisits').textContent = fmt(s.total.visits);
    $('kVisitors').textContent = fmt(s.total.visitors);
    $('kPlays').textContent = fmt(s.total.plays);
    $('kVisitsToday').textContent = `Hôm nay: ${fmt(s.today.visits)}`;
    $('kVisitorsToday').textContent = `Hôm nay: ${fmt(s.today.visitors)}`;
    $('kPlaysToday').textContent = `Hôm nay: ${fmt(s.today.plays)}`;
    $('kOnline').textContent = fmt(s.live.online);
    $('kPlaying').textContent = `${fmt(s.live.playing)} người đang trong ván`;

    const legend = $('legend');
    legend.textContent = '';
    for (const se of SERIES) {
      const sp = document.createElement('span');
      const i = document.createElement('i'); i.style.background = cssVar(se.color);
      sp.append(i, se.name);
      legend.appendChild(sp);
    }
    renderChart();
    renderTable();

    const regionName = (() => { try { const dn = new Intl.DisplayNames(['vi'], { type: 'region' }); return c => dn.of(c); } catch { return c => c; } })();
    const flag = c => c.replace(/./g, ch => String.fromCodePoint(127397 + ch.charCodeAt(0)));
    renderBars($('countries'), s.countries.map(r => ({
      name: r.country === 'XX' ? '🌐 Không rõ' : `${flag(r.country)} ${regionName(r.country)}`, value: r.visits,
    })), s.total.visits);
    const unknown = s.countries.find(r => r.country === 'XX');
    show('geoNote', s.geo === 'cdn-header' && unknown && unknown.visits >= s.total.visits * 0.5);

    const DEV = { desktop: 'Máy tính', mobile: 'Điện thoại', tablet: 'Máy tính bảng' };
    renderBars($('devices'), s.devices.map(r => ({ name: DEV[r.device] || r.device, value: r.visits })), s.total.visits);
    renderBars($('referrers'), s.referrers.map(r => ({ name: r.ref, value: r.visits })), s.total.visits, 'Chưa có — khách chủ yếu vào thẳng hoặc từ ứng dụng.');
  }

  function renderBars(el, rows, total, emptyText = 'Chưa có dữ liệu trong khoảng này.') {
    el.textContent = '';
    if (!rows.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = emptyText; el.appendChild(p); return; }
    const max = Math.max(...rows.map(r => r.value), 1);
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'bar-row';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = r.name; name.title = r.name;
      const track = document.createElement('div'); track.className = 'bar-track';
      const fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = (r.value / max * 100) + '%';
      track.appendChild(fill);
      const val = document.createElement('span'); val.className = 'val';
      const b = document.createElement('b'); b.textContent = fmt(r.value);
      val.append(b, ` · ${total ? Math.round(r.value / total * 100) : 0}%`);
      row.append(name, track, val);
      el.appendChild(row);
    }
  }

  function renderTable() {
    const t = $('dailyTable');
    t.textContent = '';
    const head = t.createTHead().insertRow();
    for (const h of ['Ngày', ...SERIES.map(s => s.name)]) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
    const body = t.createTBody();
    for (const d of [...stats.daily].reverse()) {
      const tr = body.insertRow();
      tr.insertCell().textContent = dm(d.day);
      for (const s of SERIES) tr.insertCell().textContent = fmt(d[s.key]);
    }
  }

  // Biểu đồ đường: 1 trục (cùng đơn vị "lượt"), đường 2px, nhãn cuối đường, rê chuột xem chi tiết.
  // Bước chia trục "đẹp" và luôn là số nguyên (đếm lượt không có số lẻ): 1, 2, 5, 10, 20, 50…
  function niceTicks(max) {
    const raw = Math.max(1, max / 4);
    const p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
    const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
    const count = Math.max(1, Math.ceil(max / step));
    return { step, count, top: step * count };
  }
  function renderChart() {
    if (!stats) return;
    const box = $('chart'), W = box.clientWidth, H = box.clientHeight;
    if (!W) return;
    box.querySelector('svg')?.remove();
    const M = { l: 40, r: 108, t: 12, b: 26 };
    const data = stats.daily, n = data.length;
    const ticks = niceTicks(Math.max(1, ...data.flatMap(d => SERIES.map(s => d[s.key]))));
    const yMax = ticks.top;
    const x = i => M.l + (n === 1 ? 0 : i / (n - 1)) * (W - M.l - M.r);
    const y = v => M.t + (1 - v / yMax) * (H - M.t - M.b);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Biểu đồ lượt truy cập, khách và lượt chơi ${n} ngày gần nhất` });
    box.insertBefore(svg, $('tooltip'));

    for (let k = 0; k <= ticks.count; k++) {
      const v = ticks.step * k, yy = y(v);
      svgEl('line', { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: k === 0 ? 'baseline' : 'grid-line' }, svg);
      svgEl('text', { x: M.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = fmt(v);
    }
    const step = Math.max(1, Math.ceil(n / 7));
    for (let i = 0; i < n; i += step) {
      svgEl('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'middle', class: 'tick' }, svg).textContent = dm(data[i].day);
    }

    const ends = [];
    for (const s of SERIES) {
      const color = cssVar(s.color);
      const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join('');
      svgEl('path', { d, class: 'series', stroke: color }, svg);
      ends.push({ s, color, y: y(data[n - 1][s.key]), v: data[n - 1][s.key] });
    }
    // nhãn cuối đường, đẩy ra để không chồng nhau
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    for (const e of ends) {
      svgEl('circle', { cx: x(n - 1), cy: y(data[n - 1][e.s.key]), r: 4, fill: e.color, stroke: cssVar('--surface'), 'stroke-width': 2 }, svg);
      svgEl('text', { x: x(n - 1) + 10, y: e.y + 4, class: 'end-label' }, svg).textContent = `${e.s.name}`;
    }

    // lớp rê chuột
    const cross = svgEl('line', { class: 'cross', y1: M.t, y2: H - M.b, visibility: 'hidden' }, svg);
    const dots = SERIES.map(s => svgEl('circle', { r: 4, fill: cssVar(s.color), stroke: cssVar('--surface'), 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = svgEl('rect', { x: M.l - 10, y: 0, width: W - M.l - M.r + 20, height: H, fill: 'transparent' }, svg);
    const tip = $('tooltip');
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); tip.classList.add('hidden'); };
    hit.addEventListener('pointermove', ev => {
      const rc = svg.getBoundingClientRect();
      const px = ev.clientX - rc.left;
      const i = Math.max(0, Math.min(n - 1, Math.round((px - M.l) / (W - M.l - M.r) * (n - 1))));
      const cx = x(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      SERIES.forEach((s, k) => { dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', y(data[i][s.key])); dots[k].setAttribute('visibility', 'visible'); });
      tip.textContent = '';
      const b = document.createElement('b'); b.textContent = new Date(data[i].day + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
      tip.appendChild(b);
      for (const s of SERIES) {
        const row = document.createElement('div'); row.className = 'row';
        const l = document.createElement('span'); const dot = document.createElement('i'); dot.style.background = cssVar(s.color); l.append(dot, s.name);
        const r = document.createElement('span'); r.textContent = fmt(data[i][s.key]);
        row.append(l, r); tip.appendChild(row);
      }
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(W - tw - 4, Math.max(4, cx + 12 + tw > W ? cx - tw - 12 : cx + 12)) + 'px';
      tip.style.top = M.t + 'px';
    });
    hit.addEventListener('pointerleave', hide);
  }
  new ResizeObserver(() => renderChart()).observe($('chart'));

  // ---------------------------------------------------------------- SEO
  // SEO riêng cho từng ngôn ngữ: en = trang chủ (/), vi = /vi/. Mã Search Console dùng chung.
  let seoDefaults = null, seoAll = null, seoLang = 'en';
  async function loadSeo() {
    const r = await api('GET', '/admin/api/settings');
    seoDefaults = r.defaults; seoAll = r.seo; seoLangs = r.langs;
    renderLangButtons();
    fillSeo(seoAll[seoLang], seoAll.gsc);
  }
  function fillSeo(s, gsc) {
    $('sTitle').value = s.title; $('sDesc').value = s.description; $('sKeys').value = s.keywords;
    if (gsc !== undefined) $('sGsc').value = gsc;
    updatePreview();
  }
  // Nút chọn ngôn ngữ dựng theo danh sách server trả về (locales/)
  let seoLangs = [];
  function renderLangButtons() {
    const box = $('seoLang');
    box.textContent = '';
    for (const l of seoLangs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l.name;
      b.title = l.path;
      b.classList.toggle('on', l.code === seoLang);
      b.onclick = () => {
        seoLang = l.code;
        for (const x of box.children) x.classList.toggle('on', x === b);
        fillSeo(seoAll[seoLang]);
      };
      box.appendChild(b);
    }
  }
  function counter(el, n, lo, hi) {
    el.textContent = '';
    const b = document.createElement('b'); b.textContent = n;
    if (n < lo || n > hi) b.className = 'warn';
    el.appendChild(b);
  }
  function updatePreview() {
    const t = $('sTitle').value.trim(), d = $('sDesc').value.trim();
    counter($('cTitle'), t.length, 30, 60);
    counter($('cDesc'), d.length, 120, 160);
    $('pUrl').textContent = location.host + ' › ' + ((seoLangs.find(l => l.code === seoLang) || {}).path || '/').replace(/^\/|\/$/g, '');
    $('pTitle').textContent = t.length > 60 ? t.slice(0, 58) + '…' : t;
    $('pDesc').textContent = d.length > 160 ? d.slice(0, 157) + '…' : d;
  }
  for (const id of ['sTitle', 'sDesc']) $(id).addEventListener('input', updatePreview);
  $('seoReset').onclick = () => { if (seoDefaults) fillSeo(seoDefaults[seoLang], seoDefaults.gsc); toast('Đã điền lại giá trị mặc định — bấm Lưu để áp dụng.'); };
  $('seoForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('PUT', '/admin/api/settings', { seo: { lang: seoLang, title: $('sTitle').value, description: $('sDesc').value, keywords: $('sKeys').value, gsc: $('sGsc').value } });
      seoAll = r.seo;
      fillSeo(seoAll[seoLang], seoAll.gsc);
      toast('Đã lưu SEO cho trang ' + ((seoLangs.find(l => l.code === seoLang) || {}).name || seoLang) + '.');
    } catch (err) { toast(err.message, true); }
  };

  boot();
})();
