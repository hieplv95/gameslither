'use strict';
// Phần website quanh game: menu điện thoại, bộ sưu tập mẫu rắn, năm ở footer.
(() => {
  const $ = id => document.getElementById(id);
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  // ---------------------------------------------------------------- menu điện thoại
  const toggle = $('navToggle'), nav = $('siteNav');
  toggle.onclick = () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
  };
  nav.addEventListener('click', e => { if (e.target.tagName === 'A') { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', false); } });

  $('year').textContent = new Date().getFullYear();

  // ---------------------------------------------------------------- bộ sưu tập mẫu rắn
  const Skins = window.SnakeSkins;
  const T = window.I18N.t;
  const gallery = $('skinsGallery');
  const order = [Skins.CLASSIC, ...Skins.SKINS.keys()].filter((v, i, a) => a.indexOf(v) === i);
  const items = order.map(i => {
    const fig = document.createElement('figure');
    fig.className = 'skin-card';
    const cv = document.createElement('canvas');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', T('skinAria', { name: T('skin.' + i) }));
    const cap = document.createElement('figcaption');
    const b = document.createElement('b'); b.textContent = T('skin.' + i);
    const s = document.createElement('span'); s.textContent = T('skinDesc.' + i);
    cap.append(b, s);
    fig.append(cv, cap);
    gallery.appendChild(fig);
    return { cv, i };
  });

  let visible = false;
  new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); }).observe(gallery);

  function frame(ms) {
    requestAnimationFrame(frame);
    if (!visible) return;
    const t = ms / 1000;
    for (const { cv, i } of items) {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w) continue;
      if (cv.width !== Math.round(w * DPR)) { cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); }
      const g = cv.getContext('2d');
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, w, h);
      const r = Math.min(16, h * 0.14), pts = [];
      for (let j = 0, x = w - r * 2.2; x > r * 1.2; j++, x -= 4) pts.push(x, h / 2 + Math.sin(t * 2.6 - j * 0.09) * h * 0.2);
      const P = Skins.resampleFlat(pts, r, Math.atan2(pts[1] - pts[3], pts[0] - pts[2]));
      Skins.draw(g, P, i, t, r, P[0].a, false, 150);
    }
  }
  requestAnimationFrame(frame);
})();
