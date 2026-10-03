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
    for (const t of ['stats', 'seo', 'blog', 'account']) show('tab-' + t, t === name);
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
    loadBlog();
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

  // ---------------------------------------------------------------- blog
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const k in props) { if (k === 'class') e.className = props[k]; else if (k in e) e[k] = props[k]; else e.setAttribute(k, props[k]); }
    e.append(...kids);
    return e;
  };
  const fmtDate = ts => ts ? new Date(ts).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '–';
  let blogLangs = [], posts = [], editing = null;
  const langName = code => (blogLangs.find(l => l.code === code) || {}).name || code;
  const langPath = code => (blogLangs.find(l => l.code === code) || {}).path || '/';
  const onErr = err => { if (err.status === 401) location.reload(); else toast(err.message, true); };

  async function loadBlog() {
    try {
      const r = await api('GET', '/admin/api/blog');
      posts = r.posts;
      if (!blogLangs.length) {
        blogLangs = r.langs;
        for (const sel of [$('gLang'), $('eLang')]) for (const l of blogLangs) sel.appendChild(el('option', { value: l.code, textContent: l.name }));
        $('gLang').value = 'en';   // ngôn ngữ viết bài mặc định
        $('gLang').onchange = () => { $('blogView').href = `${langPath($('gLang').value)}blog/`; };
        $('gLang').onchange();
      }
      renderCaps(r.caps);
      renderPosts();
    } catch (err) { onErr(err); }
  }

  function renderCaps(c) {
    const IMG = { vertex: 'Ảnh: AI vẽ (Google Vertex AI) + logo', openai: 'Ảnh: AI vẽ (OpenAI) + logo', pexels: 'Ảnh: kho ảnh Pexels',
      svg: 'Ảnh: ảnh bìa tự vẽ (thêm VERTEX_KEY_FILE, OPENAI_API_KEY hoặc PEXELS_API_KEY để có ảnh đẹp hơn)' };
    $('caps').textContent = c.text ? `Chữ: ${c.model} · ${IMG[c.image]}` : IMG[c.image];
    show('noKey', !c.text);
    $('genBtn').disabled = $('suggest').disabled = !c.text;
    // Chưa có key ảnh: chỉ tạo được 1 ảnh bìa tự vẽ, không có ảnh trong bài
    const noImg = c.image === 'svg';
    if (noImg) $('gImages').value = '1';
    $('gImages').disabled = noImg;
    $('gImages').title = noImg ? 'Cần VERTEX_KEY_FILE, OPENAI_API_KEY hoặc PEXELS_API_KEY để có ảnh trong bài' : '';
    show('imgHint', noImg);
  }

  function renderPosts() {
    const t = $('postTable');
    t.textContent = '';
    $('postCount').textContent = `${posts.length} bài · ${posts.filter(p => p.status === 'published').length} đã đăng`;
    if (!posts.length) { t.appendChild(el('tbody', {}, el('tr', {}, el('td', { class: 'empty' }, 'Chưa có bài nào. Hãy viết bài đầu tiên ở trên.')))); return; }
    const head = t.createTHead().insertRow();
    for (const h of ['', 'Tiêu đề', 'Ngôn ngữ', 'Trạng thái', 'Ngày', '']) head.appendChild(el('th', { textContent: h }));
    const body = t.createTBody();
    for (const p of posts) {
      const tr = body.insertRow();
      tr.insertCell().appendChild(p.cover ? el('img', { src: p.cover, alt: '', class: 'thumb', loading: 'lazy' }) : el('span', { class: 'thumb' }));
      const a = el('a', { href: '#', textContent: p.title, class: 'post-title' });
      a.onclick = e => { e.preventDefault(); openEditor(p.id); };
      tr.insertCell().append(a, el('div', { class: 'hint', textContent: `${langPath(p.lang)}blog/${p.slug}` }));
      tr.insertCell().textContent = langName(p.lang);
      tr.insertCell().appendChild(el('span', { class: 'badge-st ' + p.status, textContent: p.status === 'published' ? 'Đã đăng' : 'Nháp' }));
      tr.insertCell().textContent = fmtDate(p.published_at || p.updated_at);
      const act = tr.insertCell();
      act.className = 'actions';
      const view = el('a', { href: p.status === 'published' ? `${langPath(p.lang)}blog/${p.slug}` : `/admin/preview/${p.id}`, target: '_blank', rel: 'noopener', textContent: 'Xem' });
      const edit = el('button', { type: 'button', class: 'ghost sm', textContent: 'Sửa' });
      edit.onclick = () => openEditor(p.id);
      act.append(view, edit);
    }
  }

  // --- gợi ý chủ đề
  $('suggest').onclick = async () => {
    const b = $('suggest');
    b.disabled = true; b.textContent = '⏳ Đang nghĩ chủ đề…';
    try {
      const r = await api('POST', '/admin/api/blog/topics', { lang: $('gLang').value, seed: $('gSeed').value });
      const box = $('topics');
      box.textContent = '';
      for (const tp of r.topics) {
        const chip = el('button', { type: 'button', class: 'topic', role: 'listitem' },
          el('b', { textContent: tp.title }), el('span', { textContent: `🔑 ${tp.keyword} · ${tp.intent}` }), el('small', { textContent: tp.angle }));
        chip.onclick = () => {
          $('gTopic').value = tp.title; $('gKeyword').value = tp.keyword;
          for (const c of box.children) c.classList.toggle('on', c === chip);
        };
        box.appendChild(chip);
      }
      show('topics', r.topics.length > 0);
    } catch (err) { onErr(err); }
    b.disabled = false; b.textContent = '💡 Gợi ý chủ đề';
  };

  // --- viết bài (chạy nền, hỏi tiến độ 3 giây/lần)
  $('genForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/api/blog/generate', {
        lang: $('gLang').value, topic: $('gTopic').value, keyword: $('gKeyword').value, length: $('gLength').value,
        tone: $('gTone').value, images: $('gImages').value, notes: $('gNotes').value, publish: $('gPublish').checked,
      });
      trackJob(r.job);
      $('gTopic').value = ''; $('gKeyword').value = '';
      for (const c of $('topics').children) c.classList.remove('on');
    } catch (err) { onErr(err); }
  };
  function trackJob(job) {
    const row = el('div', { class: 'job' });
    $('jobs').prepend(row);
    const draw = j => {
      row.textContent = '';
      const secs = Math.round((Date.now() - j.startedAt) / 1000);
      row.className = 'job ' + j.status;
      row.append(el('span', { class: 'job-ico', textContent: j.status === 'running' ? '⏳' : j.status === 'done' ? '✅' : '⚠️' }),
        el('span', { class: 'job-topic', textContent: j.topic }),
        el('span', { class: 'job-step', textContent: j.status === 'error' ? j.error : `${j.step} (${secs}s)` }));
      if (j.status === 'done') {
        const b = el('button', { type: 'button', class: 'ghost sm', textContent: 'Mở bài' });
        b.onclick = () => openEditor(j.postId);
        row.appendChild(b);
      }
    };
    draw(job);
    const timer = setInterval(async () => {
      try {
        const r = await api('GET', `/admin/api/blog/job/${job.id}`);
        draw(r.job);
        if (r.job.status !== 'running') {
          clearInterval(timer);
          if (r.job.status === 'done') { toast('Đã viết xong: ' + r.job.topic); loadBlog(); }
        }
      } catch (err) { clearInterval(timer); onErr(err); }
    }, 3000);
  }

  // --- trình soạn thảo
  $('newPost').onclick = () => openEditor(0);
  $('edBack').onclick = () => closeEditor();
  function closeEditor() { editing = null; show('editor', false); show('blogList'); loadBlog(); }

  async function openEditor(id) {
    let p = { id: 0, lang: $('gLang').value || 'en', title: '', slug: '', description: '', keywords: '', excerpt: '', content: '', faq: [], cover: '', cover_alt: '', credit: '', status: 'draft', topic: '' };
    if (id) { try { p = (await api('GET', `/admin/api/blog/post/${id}`)).post; } catch (err) { return onErr(err); } }
    editing = p;
    setTab('blog');
    show('blogList', false); show('editor');
    $('edHeading').textContent = id ? 'Sửa bài' : 'Bài mới';
    $('eTitle').value = p.title; $('eSlug').value = p.slug; $('eDesc').value = p.description; $('eKeys').value = p.keywords;
    $('eExcerpt').value = p.excerpt; $('eContent').value = p.content; $('eStatus').value = p.status; $('eLang').value = p.lang;
    $('eCoverAlt').value = p.cover_alt; $('eCredit').value = p.credit;
    $('eDates').textContent = id ? `Tạo: ${fmtDate(p.created_at)} · Sửa: ${fmtDate(p.updated_at)}${p.published_at ? ' · Đăng: ' + fmtDate(p.published_at) : ''}` : '';
    show('edDelete', !!id);
    syncView();
    setCover(p.cover);
    $('faqList').textContent = '';
    for (const f of p.faq) addFaq(f[0], f[1]);
    updateEdPreview();
    window.scrollTo(0, 0);
  }

  function setCover(src) {
    editing.cover = src || '';
    $('eCoverImg').src = src || '';
    show('eCoverImg', !!src); show('coverEmpty', !src);
  }

  function addFaq(q = '', a = '') {
    const row = el('div', { class: 'faq-row' },
      el('input', { placeholder: 'Câu hỏi', value: q, maxLength: 300, class: 'fq' }),
      el('textarea', { placeholder: 'Trả lời', value: a, rows: 2, maxLength: 1200, class: 'fa' }));
    const del = el('button', { type: 'button', class: 'ghost sm', textContent: '✕', title: 'Xoá câu hỏi' });
    del.onclick = () => row.remove();
    row.appendChild(del);
    $('faqList').appendChild(row);
  }
  $('faqAdd').onclick = () => addFaq();

  function updateEdPreview() {
    const t = $('eTitle').value.trim(), d = $('eDesc').value.trim();
    counter($('ceTitle'), t.length, 30, 60);
    counter($('ceDesc'), d.length, 120, 160);
    const prefix = `${langPath($('eLang').value)}blog/`;
    $('eSlugPrefix').textContent = prefix;
    $('eUrl').textContent = location.host + ' › ' + (prefix + $('eSlug').value).replace(/^\/|\/$/g, '').replace(/\//g, ' › ');
    const full = `${t} | GameSlither`;
    $('eSerpTitle').textContent = full.length > 60 ? full.slice(0, 58) + '…' : full;
    $('eSerpDesc').textContent = d.length > 160 ? d.slice(0, 157) + '…' : d;
  }
  for (const id of ['eTitle', 'eDesc', 'eSlug', 'eLang']) $(id).addEventListener('input', updateEdPreview);
  // Bài mới: slug tự sinh theo tiêu đề cho tới khi người dùng tự sửa slug
  let slugTouched = false;
  $('eSlug').addEventListener('input', () => { slugTouched = true; });
  $('eTitle').addEventListener('input', () => {
    if (editing && !editing.id && !slugTouched) {
      $('eSlug').value = $('eTitle').value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
      updateEdPreview();
    }
  });

  function collect() {
    return {
      lang: $('eLang').value, title: $('eTitle').value, slug: $('eSlug').value, description: $('eDesc').value, keywords: $('eKeys').value,
      excerpt: $('eExcerpt').value, content: $('eContent').value, status: $('eStatus').value, cover: editing.cover,
      cover_alt: $('eCoverAlt').value, credit: $('eCredit').value, topic: editing.topic,
      faq: [...document.querySelectorAll('.faq-row')].map(r => [r.querySelector('.fq').value, r.querySelector('.fa').value]),
    };
  }
  $('editor').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = editing.id ? await api('PUT', `/admin/api/blog/post/${editing.id}`, collect()) : await api('POST', '/admin/api/blog/post', collect());
      const wasNew = !editing.id;
      editing = r.post;
      slugTouched = false;
      $('eSlug').value = r.post.slug;
      $('edHeading').textContent = 'Sửa bài';
      show('edDelete');
      $('eDates').textContent = `Tạo: ${fmtDate(r.post.created_at)} · Sửa: ${fmtDate(r.post.updated_at)}${r.post.published_at ? ' · Đăng: ' + fmtDate(r.post.published_at) : ''}`;
      updateEdPreview();
      syncView();
      toast(r.post.status === 'published' ? 'Đã lưu và đăng bài.' : wasNew ? 'Đã tạo bản nháp.' : 'Đã lưu bản nháp.');
    } catch (err) { onErr(err); }
  };
  // Nút "Xem bài": chỉ hiện khi bài đã lưu ở trạng thái Đã đăng (theo slug/ngôn ngữ đã lưu, không theo ô đang sửa dở)
  function syncView() { show('edView', !!(editing && editing.id && editing.status === 'published')); }
  $('edView').onclick = () => window.open(`${langPath(editing.lang)}blog/${editing.slug}`, '_blank', 'noopener');
  $('edPreview').onclick = () => {
    if (!editing.id) return toast('Lưu bài trước rồi mới xem trước được.', true);
    window.open(`/admin/preview/${editing.id}`, '_blank', 'noopener');
  };
  $('edDelete').onclick = async () => {
    if (!editing.id || !confirm(`Xoá hẳn bài "${editing.title}"? Không khôi phục được.`)) return;
    try { await api('DELETE', `/admin/api/blog/post/${editing.id}`); toast('Đã xoá bài.'); closeEditor(); } catch (err) { onErr(err); }
  };

  // --- ảnh: tải lên / tạo bằng AI
  function pickFile() {
    return new Promise(resolve => {
      const inp = $('fileInput');
      inp.value = '';
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }
  async function uploadImage() {
    const f = await pickFile();
    if (!f) return null;
    if (f.size > 6 * 1024 * 1024) { toast('Ảnh tối đa 6 MB.', true); return null; }
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
    toast('Đang tải ảnh lên…');
    try { return (await api('POST', '/admin/api/blog/image', { data, name: $('eSlug').value || f.name })).src; } catch (err) { onErr(err); return null; }
  }
  async function aiImage(cover) {
    const prompt = window.prompt('Mô tả ảnh cần tạo (nên viết tiếng Anh cho AI vẽ, hoặc từ khoá tìm ảnh kho):',
      cover ? `Blog cover illustration: ${$('eTitle').value}` : '');
    if (!prompt) return null;
    toast('Đang tạo ảnh… (có thể mất tới 1 phút)');
    try {
      const r = await api('POST', '/admin/api/blog/image/ai', { prompt, slug: $('eSlug').value, title: $('eTitle').value, cover });
      if (r.credit) $('eCredit').value = [$('eCredit').value, r.credit].filter(Boolean).join(', ');
      return r.src;
    } catch (err) { onErr(err); return null; }
  }
  function insertAtCursor(text) {
    const ta = $('eContent'), s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, 'end');
    ta.focus();
  }
  $('coverUpload').onclick = async () => { const src = await uploadImage(); if (src) setCover(src); };
  $('coverAi').onclick = async () => { const src = await aiImage(true); if (src) setCover(src); };
  $('coverRemove').onclick = () => setCover('');
  $('mdUpload').onclick = async () => { const src = await uploadImage(); if (src) insertAtCursor(`\n\n![${prompt('Mô tả ảnh (alt):') || ''}](${src})\n\n`); };
  $('mdAiImg').onclick = async () => { const src = await aiImage(false); if (src) insertAtCursor(`\n\n![${prompt('Mô tả ảnh (alt) bằng ngôn ngữ của bài:') || ''}](${src})\n\n`); };
  for (const b of document.querySelectorAll('[data-md]')) {
    b.onclick = () => {
      const ta = $('eContent'), m = b.dataset.md, sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (m === '**') insertAtCursor(`**${sel || 'chữ đậm'}**`);
      else if (m === 'link') insertAtCursor(`[${sel || 'chữ liên kết'}](${prompt('Địa chỉ liên kết (VD: /vi/ hoặc https://…):', langPath($('eLang').value)) || '#'})`);
      else {
        const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
        ta.setSelectionRange(start, start);
        insertAtCursor(m);
      }
    };
  }

  boot();
})();
