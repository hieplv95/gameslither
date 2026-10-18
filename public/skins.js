'use strict';
// Các mẫu rắn. Thứ tự trong SKINS phải khớp SKIN_HUES ở room.js (server gửi số thứ tự mẫu).
// Mẫu Cổ điển (số 5) là rắn một màu, màu lấy từ tham số hue. 6 mẫu đầu miễn phí, các mẫu cờ phía sau mua trong cửa hàng.
window.SnakeSkins = (() => {
  const TAU = Math.PI * 2;
  const hash = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };
  const posMod = (a, n) => ((a % n) + n) % n;
  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const f = n => { const k = (n + h / 30) % 12, c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }

  const glowCache = new Map();
  function glowSprite(hex) {
    let c = glowCache.get(hex);
    if (c) return c;
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grd.addColorStop(0.4, `rgba(${r},${g},${b},0.45)`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
    glowCache.set(hex, c);
    return c;
  }

  // Tính hướng + bán kính (thon dần về đuôi, đầu hơi to) cho các điểm thân đã lấy mẫu.
  function finish(P, r) {
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const p = P[i], q = i === 0 ? P[1] : P[i - 1];
      if (!p.a && p.a !== 0) p.a = i === 0 ? Math.atan2(p.y - q.y, p.x - q.x) : Math.atan2(q.y - p.y, q.x - p.x);
      const u = i / Math.max(1, n - 1);
      p.r = r * (u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45 * 0.62) * (i === 0 ? 1.1 : i === 1 ? 1.06 : i === 2 ? 1.03 : 1);
    }
    return P;
  }

  // pts: mảng phẳng [x0,y0,x1,y1,...] từ đầu tới đuôi → các điểm dày, cách đều nhau.
  function resampleFlat(pts, r, headAngle) {
    const sp = Math.max(2.5, r * 0.3);
    const P = [{ x: pts[0], y: pts[1] }];
    let nextD = sp, acc = 0;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k], ay = pts[k + 1], dx = pts[k + 2] - ax, dy = pts[k + 3] - ay, len = Math.hypot(dx, dy);
      if (!len) continue;
      while (acc + len >= nextD) {
        const t = (nextD - acc) / len;
        P.push({ x: ax + dx * t, y: ay + dy * t });
        nextD += sp;
      }
      acc += len;
    }
    if (P.length < 2) P.push({ x: pts[0] - Math.cos(headAngle) * sp, y: pts[1] - Math.sin(headAngle) * sp });
    if (headAngle !== undefined) P[0].a = headAngle;
    return finish(P, r);
  }

  function bodyPath(ctx, P, a, b, extra) {
    ctx.beginPath();
    for (let i = a; i < b; i++) { const p = P[i]; ctx.moveTo(p.x + p.r + extra, p.y); ctx.arc(p.x, p.y, p.r + extra, 0, TAU); }
  }
  function spinePath(ctx, P, a, b, ox, oy) {
    ctx.beginPath();
    ctx.moveTo(P[a].x + ox, P[a].y + oy);
    for (let i = a + 1; i < b; i++) ctx.lineTo(P[i].x + ox, P[i].y + oy);
  }
  const dirOf = p => [Math.cos(p.a), Math.sin(p.a)];
  function circle(ctx, x, y, rad, fill) { ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fillStyle = fill; ctx.fill(); }
  function eyePos(h, r, side, fwd, spread) {
    const [c, s] = dirOf(h);
    return { x: h.x + c * r * fwd - s * r * spread * side, y: h.y + s * r * fwd + c * r * spread * side };
  }
  // Khối tròn 3D: tối phía dưới-phải, vệt sáng dọc sống lưng phía trên-trái.
  function shade(ctx, P, a, b, r, gloss) {
    if (b - a < 2) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const Lx = -0.42, Ly = -0.9;
    spinePath(ctx, P, a, b, -Lx * r * 0.6, -Ly * r * 0.6);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = r * 0.95; ctx.stroke();
    spinePath(ctx, P, a, b, Lx * r * 0.12, Ly * r * 0.12);
    ctx.strokeStyle = `rgba(255,255,255,${0.1 * gloss})`; ctx.lineWidth = r * 1.1; ctx.stroke();
    spinePath(ctx, P, a, b, Lx * r * 0.4, Ly * r * 0.4);
    ctx.strokeStyle = `rgba(255,255,255,${0.3 * gloss})`; ctx.lineWidth = r * 0.3; ctx.stroke();
  }
  function slitEye(ctx, e, r, look, iris, er) {
    circle(ctx, e.x, e.y, er + r * 0.04, 'rgba(0,0,0,0.55)');
    circle(ctx, e.x, e.y, er, iris);
    ctx.save();
    ctx.translate(e.x + Math.cos(look) * er * 0.25, e.y + Math.sin(look) * er * 0.25);
    ctx.rotate(look);
    ctx.beginPath(); ctx.ellipse(0, 0, er * 0.22, er * 0.8, 0, 0, TAU); ctx.fillStyle = '#0b0b0b'; ctx.fill();
    ctx.restore();
    circle(ctx, e.x - er * 0.35, e.y - er * 0.4, er * 0.22, 'rgba(255,255,255,0.85)');
  }
  function roundEye(ctx, e, r, look, er, iris, pupil) {
    circle(ctx, e.x, e.y, er + r * 0.04, 'rgba(0,0,0,0.45)');
    circle(ctx, e.x, e.y, er, '#fff');
    const ix = e.x + Math.cos(look) * er * 0.35, iy = e.y + Math.sin(look) * er * 0.35;
    circle(ctx, ix, iy, er * 0.62, iris);
    circle(ctx, ix, iy, er * 0.34, pupil);
    circle(ctx, ix - er * 0.22, iy - er * 0.25, er * 0.16, 'rgba(255,255,255,0.95)');
  }

  // Mỗi mẫu: body(ctx, P, a, b, t) chỉ vẽ các điểm trong đoạn [a, b) (đã được cắt theo thân).
  const SKINS = [
    {
      name: 'Neon Cyber', outline: '#29e7ff', outlineW: r => r * 0.13 + 1.2, aura: '#29e7ff', glow: '#29e7ff', gloss: 0.45,
      body(ctx, P, a, b, t) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#0a1020'; ctx.fill();
        const phase = Math.floor(t * 14);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ff3df2';
        for (let i = Math.max(3, a - 2); i < Math.min(b + 2, P.length - 2); i++) {
          if (posMod(i - phase, 6)) continue;
          const p = P[i], [c, s] = dirOf(p), w = p.r * 0.58, l = p.r * 0.3;
          ctx.beginPath();
          ctx.moveTo(p.x - c * l - s * w, p.y - s * l + c * w);
          ctx.lineTo(p.x + c * l, p.y + s * l);
          ctx.lineTo(p.x - c * l + s * w, p.y - s * l - c * w);
          ctx.lineWidth = p.r * 0.17; ctx.stroke();
        }
      },
      head(ctx, h, t, look) {
        const R = h.r;
        for (const side of [-1, 1]) {
          const e = eyePos(h, R, side, 0.3, 0.45);
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(glowSprite('#29e7ff'), e.x - R * 0.7, e.y - R * 0.7, R * 1.4, R * 1.4);
          ctx.globalCompositeOperation = 'source-over';
          circle(ctx, e.x, e.y, R * 0.28, '#e9fdff');
          const px = e.x + Math.cos(look) * R * 0.1, py = e.y + Math.sin(look) * R * 0.1;
          circle(ctx, px, py, R * 0.15, '#ff3df2');
          circle(ctx, px, py, R * 0.065, '#1a0020');
        }
      },
    },
    {
      name: 'Rồng Vàng', outline: '#6b3c00', outlineW: r => r * 0.1 + 1, glow: '#ffc233', gloss: 1.1,
      body(ctx, P, a, b) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#d99a1e'; ctx.fill();
        ctx.strokeStyle = 'rgba(110,62,0,0.6)';
        for (let i = Math.max(2, (a - 3) + ((a - 3) & 1)); i < Math.min(b + 3, P.length); i += 2) {
          const p = P[i], [c, s] = dirOf(p), shift = (i / 2) % 2 ? 0.5 : 0;
          ctx.lineWidth = p.r * 0.07;
          for (let j = -2; j <= 1; j++) {
            const off = (j + shift) * p.r * 0.56;
            if (Math.abs(off) > p.r * 0.95) continue;
            ctx.beginPath(); ctx.arc(p.x - s * off, p.y + c * off, p.r * 0.34, p.a + Math.PI / 2, p.a + Math.PI * 1.5); ctx.stroke();
          }
        }
        for (let i = Math.max(5, a - 3); i < Math.min(b + 3, P.length - 4); i++) {
          if ((i - 5) % 4) continue;
          const p = P[i], [c, s] = dirOf(p);
          ctx.beginPath();
          ctx.moveTo(p.x - c * p.r * 0.55, p.y - s * p.r * 0.55);
          ctx.lineTo(p.x + c * p.r * 0.25 - s * p.r * 0.24, p.y + s * p.r * 0.25 + c * p.r * 0.24);
          ctx.lineTo(p.x + c * p.r * 0.25 + s * p.r * 0.24, p.y + s * p.r * 0.25 - c * p.r * 0.24);
          ctx.closePath();
          ctx.fillStyle = '#d42a1f'; ctx.fill();
          ctx.strokeStyle = '#6d0d0d'; ctx.lineWidth = p.r * 0.05; ctx.stroke();
          ctx.strokeStyle = 'rgba(110,62,0,0.6)';
        }
      },
      head(ctx, h, t, look) {
        const [c, s] = dirOf(h), R = h.r;
        ctx.lineCap = 'round';
        for (const side of [-1, 1]) {
          const bx = h.x + c * R * 0.75 - s * R * 0.35 * side, by = h.y + s * R * 0.75 + c * R * 0.35 * side;
          const wave = Math.sin(t * 4 + side) * R * 0.35;
          ctx.beginPath(); ctx.moveTo(bx, by);
          ctx.quadraticCurveTo(bx + c * R * 0.7 - s * (R + wave) * side, by + s * R * 0.7 + c * (R + wave) * side,
            bx - c * R * 0.6 - s * R * 1.9 * side, by - s * R * 0.6 + c * R * 1.9 * side);
          ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = R * 0.08; ctx.stroke();
          const hx = h.x - c * R * 0.25 - s * R * 0.5 * side, hy = h.y - s * R * 0.25 + c * R * 0.5 * side;
          ctx.beginPath(); ctx.moveTo(hx, hy);
          ctx.quadraticCurveTo(hx - c * R * 0.5 - s * R * 0.55 * side, hy - s * R * 0.5 + c * R * 0.55 * side,
            hx - c * R * 1.15 - s * R * 0.4 * side, hy - s * R * 1.15 + c * R * 0.4 * side);
          ctx.strokeStyle = '#5a3a10'; ctx.lineWidth = R * 0.3; ctx.stroke();
          ctx.strokeStyle = '#f5e6b8'; ctx.lineWidth = R * 0.2; ctx.stroke();
        }
        for (const side of [-1, 1]) slitEye(ctx, eyePos(h, R, side, 0.28, 0.46), R, look, '#ffd000', R * 0.3);
      },
    },
    {
      name: 'Kẹo Cầu Vồng', outline: '#ffffff', outlineW: r => r * 0.11 + 1, glow: '#ff8ad8', gloss: 1.7,
      body(ctx, P, a, b, t) {
        for (let i = b - 1; i >= a; i--) {
          const p = P[i];
          circle(ctx, p.x, p.y, p.r + 2, `hsl(${(t * 70 + i * 6) % 360},88%,70%)`);
        }
        for (let i = Math.max(3, a - 1); i < Math.min(b + 1, P.length); i++) {
          if (i % 3) continue;
          const p = P[i], [c, s] = dirOf(p), off = (hash(i, 1) - 0.5) * 1.3 * p.r;
          circle(ctx, p.x - s * off, p.y + c * off, p.r * 0.07, 'rgba(255,255,255,0.75)');
        }
      },
      head(ctx, h, t, look) {
        const R = h.r;
        for (const side of [-1, 1]) {
          const b = eyePos(h, R, side, -0.05, 0.72);
          ctx.beginPath(); ctx.ellipse(b.x, b.y, R * 0.2, R * 0.13, h.a, 0, TAU);
          ctx.fillStyle = 'rgba(255,90,170,0.5)'; ctx.fill();
        }
        const blink = (t % 4) < 0.12;
        for (const side of [-1, 1]) {
          const e = eyePos(h, R, side, 0.22, 0.42);
          if (blink) {
            ctx.beginPath(); ctx.arc(e.x, e.y, R * 0.3, h.a + Math.PI * 0.1, h.a + Math.PI * 0.9);
            ctx.strokeStyle = '#2a1b3d'; ctx.lineWidth = R * 0.08; ctx.stroke();
          } else roundEye(ctx, e, R, look, R * 0.42, '#6b3fa0', '#1c1030');
        }
      },
    },
    {
      name: 'Trăn Rừng', outline: '#27340f', outlineW: r => r * 0.1 + 1, glow: '#b6e35a', gloss: 0.9,
      under(ctx, h, t) {
        const ph = t % 2.4;
        if (ph > 0.4) return;
        const [c, s] = dirOf(h), R = h.r, L = R * 1.2 * Math.sin(ph / 0.4 * Math.PI);
        const sx = h.x + c * R * 0.8, sy = h.y + s * R * 0.8, ex = sx + c * L, ey = sy + s * L;
        ctx.lineCap = 'round'; ctx.strokeStyle = '#e0233a'; ctx.lineWidth = R * 0.09;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
        for (const side of [-0.5, 0.5]) { ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.cos(h.a + side) * R * 0.3, ey + Math.sin(h.a + side) * R * 0.3); }
        ctx.stroke();
      },
      body(ctx, P, a, b) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#76923a'; ctx.fill();
        ctx.lineJoin = 'round';
        // quét rộng hơn đoạn một chút để hoa văn nằm vắt qua ranh giới 2 đoạn không bị mất
        for (let i = Math.max(4, a - 3); i < Math.min(b + 3, P.length - 1); i++) {
          if (i % 4) continue;
          const p = P[i], [c, s] = dirOf(p), off = ((i / 4) % 2 ? 1 : -1) * p.r * 0.16;
          const cx = p.x - s * off, cy = p.y + c * off, L = p.r * 0.72, W = p.r * 0.55;
          ctx.beginPath();
          ctx.moveTo(cx + c * L, cy + s * L); ctx.lineTo(cx - s * W, cy + c * W);
          ctx.lineTo(cx - c * L, cy - s * L); ctx.lineTo(cx + s * W, cy - c * W); ctx.closePath();
          ctx.fillStyle = '#3a2812'; ctx.fill();
          ctx.strokeStyle = '#e6c65c'; ctx.lineWidth = p.r * 0.1; ctx.stroke();
          const q = P[Math.min(P.length - 1, i + 2)], [c2, s2] = dirOf(q);
          for (const side of [-1, 1]) circle(ctx, q.x - s2 * q.r * 0.8 * side, q.y + c2 * q.r * 0.8 * side, q.r * 0.17, '#3a2812');
        }
      },
      head(ctx, h, t, look) {
        const [c, s] = dirOf(h), R = h.r;
        ctx.beginPath();
        ctx.moveTo(h.x + c * R * 0.55, h.y + s * R * 0.55);
        ctx.lineTo(h.x - c * R * 0.35 - s * R * 0.32, h.y - s * R * 0.35 + c * R * 0.32);
        ctx.lineTo(h.x - c * R * 0.1, h.y - s * R * 0.1);
        ctx.lineTo(h.x - c * R * 0.35 + s * R * 0.32, h.y - s * R * 0.35 - c * R * 0.32);
        ctx.closePath(); ctx.fillStyle = 'rgba(58,40,18,0.85)'; ctx.fill();
        for (const side of [-1, 1]) slitEye(ctx, eyePos(h, R, side, 0.2, 0.55), R, look, '#f0b323', R * 0.26);
      },
    },
    {
      name: 'Thiên Hà', outline: '#bfaeff', outlineW: r => r * 0.08 + 1, aura: '#8a5cff', glow: '#b18cff', gloss: 0.8,
      body(ctx, P, a, b, t) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#140a30'; ctx.fill();
        const cols = ['#ff3cc8', '#3cc8ff', '#8a5cff'];
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.4;
        for (let i = Math.max(0, a - 6); i < Math.min(b + 6, P.length); i++) {
          if (i % 3) continue;
          const p = P[i], [c, s] = dirOf(p), off = (hash(i, 1) - 0.5) * p.r, g = p.r * 2.4;
          ctx.drawImage(glowSprite(cols[(i / 3) % 3]), p.x - s * off - g / 2, p.y + c * off - g / 2, g, g);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        for (let i = Math.max(1, a - 2); i < Math.min(b + 2, P.length); i++) {
          if (hash(i, 2) > 0.5) continue;
          const p = P[i], [c, s] = dirOf(p), off = (hash(i, 3) - 0.5) * 1.6 * p.r;
          const x = p.x - s * off, y = p.y + c * off, sz = p.r * (0.05 + hash(i, 4) * 0.07);
          const al = 0.35 + 0.65 * Math.abs(Math.sin(t * 2.2 + hash(i, 5) * 10));
          circle(ctx, x, y, sz, `rgba(255,255,255,${al})`);
          if (hash(i, 6) > 0.85) {
            ctx.strokeStyle = `rgba(255,255,255,${al * 0.8})`; ctx.lineWidth = sz * 0.5;
            ctx.beginPath(); ctx.moveTo(x - sz * 4, y); ctx.lineTo(x + sz * 4, y); ctx.moveTo(x, y - sz * 4); ctx.lineTo(x, y + sz * 4); ctx.stroke();
          }
        }
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) roundEye(ctx, eyePos(h, h.r, side, 0.28, 0.44), h.r, look, h.r * 0.31, '#9d7bff', '#12062a');
      },
    },
    {
      name: 'Cổ điển', classic: true, outlineW: r => r * 0.1 + 1, gloss: 1.2,
      body(ctx, P, a, b, t, hue) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = `hsl(${hue},85%,55%)`; ctx.fill();
        // sọc ngang xen kẽ như slither
        const dark = `hsl(${hue},85%,42%)`;
        for (let i = Math.max(0, a - 3); i < Math.min(b + 3, P.length); i++) {
          if (Math.floor(i / 5) % 2 === 0) continue;
          const p = P[i];
          circle(ctx, p.x, p.y, p.r * 1.05, dark);
        }
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) roundEye(ctx, eyePos(h, h.r, side, 0.28, 0.46), h.r, look, h.r * 0.36, '#2b2b2b', '#000');
      },
    },
  ];
  const CLASSIC = 5;   // 6 mẫu đầu miễn phí; từ FREE trở đi là mẫu cờ, mua trong cửa hàng
  const FREE = 6;

  // ------------------------------------------------------------ mẫu cờ quốc gia
  // Dải ngang của lá cờ chạy dọc thân rắn. Hoạ tiết (sao, mặt trời…) vẽ trong hệ toạ độ của một điểm thân:
  // trục x hướng về phía đầu, trục y ngang thân (y âm = mép trên lá cờ), R = bán kính thân tại điểm đó.
  function ribbon(ctx, P, a, b, bands) {
    // phủ rộng hơn đoạn 4 điểm (≥ 1,2 bán kính): hình tròn cuối đoạn nhô ra sau tâm của nó cả 1 bán kính
    const lo = Math.max(0, a - 4), hi = Math.min(P.length, b + 4), S = [];
    const add = (p, fwd) => { const [c, s] = dirOf(p); S.push(p.x + c * p.r * fwd, p.y + s * p.r * fwd, -s * p.r, c * p.r); };
    if (lo === 0) add(P[0], 1.3);                // kéo dài qua chỏm đầu / chóp đuôi để phủ kín
    for (let i = lo; i < hi; i++) add(P[i], 0);
    if (hi === P.length) add(P[hi - 1], -1.3);
    const total = bands.reduce((t, x) => t + (x[1] || 1), 0);
    let acc = 0;
    bands.forEach(([col, w = 1], k) => {
      const e1 = k ? -1 + 2 * acc / total : -1.6;
      acc += w;
      const e2 = k === bands.length - 1 ? 1.6 : -1 + 2 * acc / total;
      ctx.beginPath();
      for (let j = 0; j < S.length; j += 4) ctx.lineTo(S[j] + S[j + 2] * e1, S[j + 1] + S[j + 3] * e1);
      for (let j = S.length - 4; j >= 0; j -= 4) ctx.lineTo(S[j] + S[j + 2] * e2, S[j + 1] + S[j + 3] * e2);
      ctx.closePath(); ctx.fillStyle = col; ctx.fill();
    });
  }
  // Mảng màu từ điểm i0 tới i1 (gồm cả 2 đầu), phủ ngang thân từ e1 tới e2 (đơn vị: bán kính, âm = mép trên)
  function patch(ctx, P, i0, i1, e1, e2, fill) {
    const S = [];
    const add = (p, fwd) => { const [c, s] = dirOf(p); S.push([p.x + c * p.r * fwd, p.y + s * p.r * fwd, -s * p.r, c * p.r]); };
    if (i0 === 0) add(P[0], 1.3);
    for (let i = i0; i <= i1; i++) add(P[i], 0);
    if (i1 === P.length - 1) add(P[i1], -1.3);
    ctx.beginPath();
    for (const [x, y, nx, ny] of S) ctx.lineTo(x + nx * e1, y + ny * e1);
    for (let k = S.length - 1; k >= 0; k--) { const [x, y, nx, ny] = S[k]; ctx.lineTo(x + nx * e2, y + ny * e2); }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  // Gọi fn cho các điểm start, start+step, … nằm trong (hoặc sát) đoạn [a, b)
  function every(P, a, b, step, start, fn) {
    const lo = Math.max(start, a - 4), hi = Math.min(P.length, b + 4);
    for (let i = lo + posMod(start - lo, step); i < hi; i += step) fn(P[i], i);
  }
  function local(ctx, p, fn) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); fn(p.r); ctx.restore(); }
  function star(ctx, x, y, rad, fill) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const an = -Math.PI / 2 + k * Math.PI / 5, d = k % 2 ? rad * 0.4 : rad;
      ctx.lineTo(x + Math.cos(an) * d, y + Math.sin(an) * d);
    }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  // Trăng lưỡi liềm (hình tròn bị khoét bởi hình tròn lệch về hướng dx, dy) + ngôi sao ở phía miệng trăng
  function crescent(ctx, x, y, rad, dx, dy, fg, bg) {
    circle(ctx, x, y, rad, fg);
    circle(ctx, x + dx * rad * 0.3, y + dy * rad * 0.3, rad * 0.82, bg);
    star(ctx, x + dx * rad * 0.78, y + dy * rad * 0.78, rad * 0.36, fg);
  }

  const flag = (country, name, o) => ({
    name, country, outline: o.outline, outlineW: r => r * 0.1 + 1, glow: o.glow, gloss: o.gloss ?? 1,
    body(ctx, P, a, b, t) {
      bodyPath(ctx, P, a, b, 0); ctx.fillStyle = o.base || o.bands[0][0]; ctx.fill();
      if (o.bands) ribbon(ctx, P, a, b, o.bands);
      if (o.paint) o.paint(ctx, P, a, b, t);
      if (o.emblem) every(P, a, b, o.step || 8, o.start ?? 4, (p, i) => local(ctx, p, R => o.emblem(ctx, R, i)));
    },
    head(ctx, h, t, look) {
      for (const side of [-1, 1]) roundEye(ctx, eyePos(h, h.r, side, 0.28, 0.46), h.r, look, h.r * 0.34, o.iris || '#2b2b2b', '#000');
    },
  });

  // Theo thứ tự dân số (Liên Hợp Quốc, World Population Prospects 2024, ước tính 2025)
  SKINS.push(
    flag('IN', 'India', {
      bands: [['#FF9933'], ['#FFFFFF'], ['#138808']], outline: '#7a4a10', glow: '#FF9933',
      emblem(ctx, R) {
        ctx.strokeStyle = '#06038D';
        ctx.lineWidth = R * 0.06; ctx.beginPath(); ctx.arc(0, 0, R * 0.27, 0, TAU); ctx.stroke();
        ctx.lineWidth = R * 0.03; ctx.beginPath();
        for (let k = 0; k < 12; k++) { ctx.moveTo(0, 0); ctx.lineTo(Math.cos(k * Math.PI / 6) * R * 0.27, Math.sin(k * Math.PI / 6) * R * 0.27); }
        ctx.stroke();
      },
    }),
    flag('CN', 'China', {
      base: '#DE2910', outline: '#6e0f06', glow: '#FFDE00', step: 10,
      emblem(ctx, R) {
        star(ctx, 0, -R * 0.3, R * 0.42, '#FFDE00');
        for (const [x, y] of [[-0.55, 0.12], [-0.2, 0.45], [0.2, 0.45], [0.55, 0.12]]) star(ctx, x * R, y * R, R * 0.14, '#FFDE00');
      },
    }),
    flag('US', 'United States', {
      base: '#B22234', outline: '#2a2950', glow: '#ffffff',
      paint(ctx, P, a, b) {
        // sọc đỏ trắng chạy dọc thân; ô xanh có sao trắng ở nửa trên, lặp lại mỗi 18 điểm (khúc đầu bắt đầu ở đầu rắn)
        ribbon(ctx, P, a, b, [['#B22234'], ['#FFFFFF'], ['#B22234'], ['#FFFFFF'], ['#B22234'], ['#FFFFFF'], ['#B22234']]);
        const n = P.length;
        for (let g = Math.max(0, Math.floor((a - 12) / 18)); g * 18 < Math.min(b + 4, n - 1); g++) {
          const i0 = g * 18, i1 = Math.min(n - 1, i0 + 8);
          patch(ctx, P, i0, i1, -1.6, 0.1, '#3C3B6E');
          for (let i = i0 + 1; i < i1; i += 2) {
            local(ctx, P[i], R => { for (const e of (i - i0) % 4 === 1 ? [-0.75, -0.25] : [-0.5]) star(ctx, 0, e * R, R * 0.14, '#FFFFFF'); });
          }
        }
      },
    }),
    flag('ID', 'Indonesia', { bands: [['#CE1126'], ['#FFFFFF']], outline: '#5e0a12', glow: '#ff3b4e' }),
    flag('PK', 'Pakistan', {
      bands: [['#FFFFFF', 1], ['#01411C', 3]], outline: '#012a12', glow: '#2ecc71', step: 9,
      emblem(ctx, R) { crescent(ctx, 0, R * 0.25, R * 0.44, 0.7, -0.7, '#FFFFFF', '#01411C'); },
    }),
    flag('NG', 'Nigeria', { bands: [['#008751'], ['#FFFFFF'], ['#008751']], outline: '#00452a', glow: '#2ee88a' }),
    flag('BR', 'Brazil', {
      base: '#009C3B', outline: '#004d1d', glow: '#FFDF00', step: 9,
      emblem(ctx, R) {
        ctx.beginPath(); ctx.moveTo(R * 0.95, 0); ctx.lineTo(0, R * 0.78); ctx.lineTo(-R * 0.95, 0); ctx.lineTo(0, -R * 0.78);
        ctx.closePath(); ctx.fillStyle = '#FFDF00'; ctx.fill();
        circle(ctx, 0, 0, R * 0.38, '#002776');
        ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R * 0.38, 0, TAU); ctx.clip();
        ctx.beginPath(); ctx.arc(-R * 0.1, R * 0.7, R * 0.75, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = R * 0.08; ctx.stroke();
        ctx.restore();
      },
    }),
    flag('BD', 'Bangladesh', {
      base: '#006A4E', outline: '#003326', glow: '#F42A41',
      emblem(ctx, R) { circle(ctx, -R * 0.08, 0, R * 0.5, '#F42A41'); },
    }),
    flag('RU', 'Russia', { bands: [['#FFFFFF'], ['#0039A6'], ['#D52B1E']], outline: '#1a2a55', glow: '#4f7dff' }),
    flag('ET', 'Ethiopia', {
      bands: [['#078930'], ['#FCDD09'], ['#DA121A']], outline: '#3d3a05', glow: '#FCDD09', step: 9,
      emblem(ctx, R) { circle(ctx, 0, 0, R * 0.36, '#0F47AF'); star(ctx, 0, 0, R * 0.26, '#FCDD09'); },
    }),
    flag('MX', 'Mexico', {
      bands: [['#006847'], ['#FFFFFF'], ['#CE1126']], outline: '#00331f', glow: '#2fd18b', step: 9,
      emblem(ctx, R) {
        ctx.beginPath(); ctx.arc(0, 0, R * 0.24, Math.PI * 0.15, Math.PI * 0.85);
        ctx.strokeStyle = '#3f8f3a'; ctx.lineWidth = R * 0.07; ctx.stroke();
        circle(ctx, 0, -R * 0.03, R * 0.16, '#8C5A2B');
      },
    }),
    flag('JP', 'Japan', {
      base: '#FFFFFF', outline: '#8a8a8a', glow: '#ff3355', iris: '#BC002D',
      emblem(ctx, R) { circle(ctx, 0, 0, R * 0.52, '#BC002D'); },
    }),
    flag('EG', 'Egypt', {
      bands: [['#CE1126'], ['#FFFFFF'], ['#000000']], outline: '#3a0006', glow: '#C09300', step: 9,
      emblem(ctx, R) {
        circle(ctx, 0, 0, R * 0.22, '#C09300');
        ctx.beginPath(); ctx.moveTo(-R * 0.1, -R * 0.08); ctx.lineTo(R * 0.12, 0); ctx.lineTo(-R * 0.1, R * 0.08);
        ctx.closePath(); ctx.fillStyle = '#7a5c00'; ctx.fill();
      },
    }),
    flag('PH', 'Philippines', {
      bands: [['#0038A8'], ['#CE1126']], outline: '#001f5c', glow: '#FCD116', step: 10,
      emblem(ctx, R) {
        ctx.beginPath(); ctx.moveTo(-R * 0.55, -R * 1.2); ctx.lineTo(R * 0.75, 0); ctx.lineTo(-R * 0.55, R * 1.2);
        ctx.closePath(); ctx.fillStyle = '#FFFFFF'; ctx.fill();
        ctx.strokeStyle = '#FCD116'; ctx.lineWidth = R * 0.05; ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const an = k * Math.PI / 4;
          ctx.moveTo(Math.cos(an) * R * 0.18, Math.sin(an) * R * 0.18); ctx.lineTo(Math.cos(an) * R * 0.32, Math.sin(an) * R * 0.32);
        }
        ctx.stroke();
        circle(ctx, 0, 0, R * 0.15, '#FCD116');
      },
    }),
    flag('CD', 'DR Congo', {
      base: '#007FFF', outline: '#003a75', glow: '#F7D618', step: 9,
      emblem(ctx, R) {
        ctx.save(); ctx.rotate(-0.6);
        ctx.fillStyle = '#F7D618'; ctx.fillRect(-R * 0.3, -R * 2, R * 0.6, R * 4);
        ctx.fillStyle = '#CE1021'; ctx.fillRect(-R * 0.2, -R * 2, R * 0.4, R * 4);
        ctx.restore();
        star(ctx, R * 0.75, -R * 0.45, R * 0.24, '#F7D618');
      },
    }),
    flag('VN', 'Vietnam', {
      base: '#DA251D', outline: '#6b0f0b', glow: '#FFFF00', step: 7,
      emblem(ctx, R) { star(ctx, 0, R * 0.05, R * 0.6, '#FFFF00'); },
    }),
    flag('IR', 'Iran', {
      bands: [['#239F40'], ['#FFFFFF'], ['#DA0000']], outline: '#0f4a1d', glow: '#3ddc6a', step: 9,
      emblem(ctx, R) {
        ctx.strokeStyle = '#DA0000'; ctx.lineWidth = R * 0.05;
        ctx.beginPath(); ctx.arc(-R * 0.06, 0, R * 0.2, -Math.PI * 0.75, Math.PI * 0.75); ctx.stroke();
        ctx.beginPath(); ctx.arc(R * 0.06, 0, R * 0.2, Math.PI * 0.25, Math.PI * 1.75); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-R * 0.26, 0); ctx.lineTo(R * 0.26, 0); ctx.stroke();
      },
    }),
    flag('TR', 'Türkiye', {
      base: '#E30A17', outline: '#6b050b', glow: '#ff4d58',
      emblem(ctx, R) { crescent(ctx, -R * 0.1, 0, R * 0.46, 1, 0, '#FFFFFF', '#E30A17'); },
    }),
    flag('DE', 'Germany', { bands: [['#000000'], ['#DD0000'], ['#FFCE00']], outline: '#000000', glow: '#FFCE00' }),
    flag('TH', 'Thailand', {
      bands: [['#A51931'], ['#F4F5F8'], ['#2D2A4A', 2], ['#F4F5F8'], ['#A51931']], outline: '#1a1830', glow: '#6b66d6',
    }),
    // Thêm ngoài top 20
    flag('GB', 'United Kingdom', {
      base: '#012169', outline: '#000f3a', glow: '#ffffff',
      paint(ctx, P, a, b) {
        // chéo trắng-đỏ, rồi dải ngang của chữ thập chạy dọc thân, rồi nét dọc của chữ thập
        every(P, a, b, 8, 0, p => local(ctx, p, R => {
          ctx.lineCap = 'butt';
          for (const [col, w] of [['#FFFFFF', 0.42], ['#C8102E', 0.14]]) {
            ctx.strokeStyle = col; ctx.lineWidth = R * w; ctx.beginPath();
            ctx.moveTo(-R * 1.2, -R * 1.1); ctx.lineTo(R * 1.2, R * 1.1);
            ctx.moveTo(-R * 1.2, R * 1.1); ctx.lineTo(R * 1.2, -R * 1.1);
            ctx.stroke();
          }
        }));
        ribbon(ctx, P, a, b, [['rgba(0,0,0,0)', 4], ['#FFFFFF', 1], ['#C8102E', 1.4], ['#FFFFFF', 1], ['rgba(0,0,0,0)', 4]]);
        every(P, a, b, 8, 4, p => local(ctx, p, R => {
          ctx.fillStyle = '#FFFFFF'; ctx.fillRect(-R * 0.28, -R * 1.2, R * 0.56, R * 2.4);
          ctx.fillStyle = '#C8102E'; ctx.fillRect(-R * 0.16, -R * 1.2, R * 0.32, R * 2.4);
          ctx.fillRect(-R * 0.6, -R * 0.15, R * 1.2, R * 0.3);
        }));
      },
    }),
    flag('IT', 'Italy', {
      base: '#009246', outline: '#00401f', glow: '#3ee07f',
      paint(ctx, P, a, b) {
        // ba sọc dọc của cờ Ý thành các khúc xanh – trắng – đỏ nối nhau dọc thân
        const cols = ['#009246', '#F1F2F1', '#CE2B37'], L = 5;
        for (let g = Math.max(0, Math.floor((a - 4) / L)); g * L < Math.min(b + 4, P.length - 1); g++) {
          patch(ctx, P, g * L, Math.min(P.length - 1, g * L + L), -1.6, 1.6, cols[g % 3]);
        }
      },
    }),
    flag('ES', 'Spain', {
      bands: [['#AA151B', 1], ['#F1BF00', 2], ['#AA151B', 1]], outline: '#4d0a0c', glow: '#F1BF00', step: 10,
      emblem(ctx, R) {
        // huy hiệu giản lược: vương miện + khiên
        ctx.fillStyle = '#AD1519';
        ctx.beginPath();
        ctx.moveTo(-R * 0.2, -R * 0.18); ctx.lineTo(R * 0.2, -R * 0.18); ctx.lineTo(R * 0.2, R * 0.08);
        ctx.quadraticCurveTo(R * 0.2, R * 0.28, 0, R * 0.3); ctx.quadraticCurveTo(-R * 0.2, R * 0.28, -R * 0.2, R * 0.08);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#8a6a00'; ctx.lineWidth = R * 0.03; ctx.stroke();
        ctx.fillStyle = '#F1BF00'; ctx.fillRect(-R * 0.1, -R * 0.08, R * 0.2, R * 0.2);
        ctx.fillStyle = '#C8A800'; ctx.fillRect(-R * 0.16, -R * 0.32, R * 0.32, R * 0.1);
      },
    }),
  );

  // ------------------------------------------------------------ mẫu thành tích (29–32)
  // Không bán: tự mở khoá khi đạt mốc (ACHIEVEMENTS ở server.js). Có hiệu ứng chuyển động + hào quang.
  const glowEye = (ctx, e, R, look, col, core) => {
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(glowSprite(col), e.x - R * 0.75, e.y - R * 0.75, R * 1.5, R * 1.5);
    ctx.globalCompositeOperation = 'source-over';
    circle(ctx, e.x, e.y, R * 0.24, core);
    circle(ctx, e.x + Math.cos(look) * R * 0.08, e.y + Math.sin(look) * R * 0.08, R * 0.1, '#1a0500');
  };
  SKINS.push(
    {
      name: 'Inferno', outline: '#3a0800', outlineW: r => r * 0.1 + 1, aura: '#ff5a1f', glow: '#ff7a1f', gloss: 0.7,
      body(ctx, P, a, b, t) {
        // lửa chảy từ đầu về đuôi: màu đỏ → cam → vàng đổi theo thời gian
        for (let i = b - 1; i >= a; i--) {
          const p = P[i], w = Math.sin(i * 0.35 - t * 9) * 0.5 + 0.5;
          circle(ctx, p.x, p.y, p.r + 2, `hsl(${8 + w * 38},100%,${38 + w * 18}%)`);
        }
        ctx.globalCompositeOperation = 'lighter';
        for (let i = Math.max(2, a - 2); i < Math.min(b + 2, P.length); i++) {
          if (i % 3) continue;
          const p = P[i], [c, s] = dirOf(p), off = Math.sin(i * 1.7 + t * 6) * p.r * 0.45, g = p.r * 1.3;
          ctx.globalAlpha = 0.35 + 0.35 * Math.abs(Math.sin(t * 5 + i));
          ctx.drawImage(glowSprite('#ffd23f'), p.x - s * off - g / 2, p.y + c * off - g / 2, g, g);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) glowEye(ctx, eyePos(h, h.r, side, 0.3, 0.45), h.r, look, '#ffb21f', '#fff3b0');
      },
    },
    {
      name: 'Frost', outline: '#e8fbff', outlineW: r => r * 0.09 + 1, aura: '#7fe3ff', glow: '#a8efff', gloss: 1.6,
      body(ctx, P, a, b, t) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#5cc8ef'; ctx.fill();
        // tinh thể băng hình thoi + ánh lấp lánh chạy dọc thân
        for (let i = Math.max(2, a - 3); i < Math.min(b + 3, P.length - 1); i++) {
          if (i % 3) continue;
          const p = P[i], [c, s] = dirOf(p), side = (i / 3) % 2 ? 1 : -1, off = side * p.r * 0.38;
          const cx = p.x - s * off, cy = p.y + c * off, L = p.r * 0.5, Wd = p.r * 0.26;
          ctx.beginPath();
          ctx.moveTo(cx + c * L, cy + s * L); ctx.lineTo(cx - s * Wd, cy + c * Wd);
          ctx.lineTo(cx - c * L, cy - s * L); ctx.lineTo(cx + s * Wd, cy - c * Wd); ctx.closePath();
          ctx.fillStyle = 'rgba(235,252,255,0.75)'; ctx.fill();
        }
        for (let i = Math.max(1, a - 2); i < Math.min(b + 2, P.length); i++) {
          if (hash(i, 7) > 0.35) continue;
          const p = P[i], [c, s] = dirOf(p), off = (hash(i, 8) - 0.5) * 1.4 * p.r;
          const al = Math.max(0, Math.sin(t * 3 + hash(i, 9) * 20));
          if (al < 0.2) continue;
          const x = p.x - s * off, y = p.y + c * off, sz = p.r * 0.32 * al;
          ctx.strokeStyle = `rgba(255,255,255,${al})`; ctx.lineWidth = p.r * 0.05;
          ctx.beginPath(); ctx.moveTo(x - sz, y); ctx.lineTo(x + sz, y); ctx.moveTo(x, y - sz); ctx.lineTo(x, y + sz); ctx.stroke();
        }
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) roundEye(ctx, eyePos(h, h.r, side, 0.28, 0.45), h.r, look, h.r * 0.33, '#1d6fa3', '#03203a');
      },
    },
    {
      name: 'Shadow', outline: '#7a2cff', outlineW: r => r * 0.08 + 1, aura: '#6a1fff', glow: '#9b5cff', gloss: 0.5,
      body(ctx, P, a, b, t) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#0b0712'; ctx.fill();
        // khói tím trôi dọc thân
        ctx.globalCompositeOperation = 'lighter';
        for (let i = Math.max(0, a - 6); i < Math.min(b + 6, P.length); i++) {
          if (i % 4) continue;
          const p = P[i], [c, s] = dirOf(p), off = Math.sin(i * 0.9 - t * 2.5) * p.r * 0.5, g = p.r * 2;
          ctx.globalAlpha = 0.18 + 0.14 * Math.sin(t * 3 + i * 0.5);
          ctx.drawImage(glowSprite('#7a2cff'), p.x - s * off - g / 2, p.y + c * off - g / 2, g, g);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(200,160,255,0.35)'; ctx.lineCap = 'round';
        for (let i = Math.max(4, a - 2); i < Math.min(b + 2, P.length - 2); i++) {
          if (i % 6) continue;
          const p = P[i], [c, s] = dirOf(p), w = p.r * 0.6;
          ctx.lineWidth = p.r * 0.08;
          ctx.beginPath(); ctx.moveTo(p.x - s * w, p.y + c * w); ctx.lineTo(p.x + c * p.r * 0.3, p.y + s * p.r * 0.3); ctx.lineTo(p.x + s * w, p.y - c * w); ctx.stroke();
        }
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) glowEye(ctx, eyePos(h, h.r, side, 0.3, 0.42), h.r, look, '#ff2048', '#ff8095');
      },
    },
    {
      name: 'Aurora', outline: '#0b3b3a', outlineW: r => r * 0.09 + 1, aura: '#3dffb0', glow: '#5cffc8', gloss: 1.1,
      body(ctx, P, a, b, t) {
        bodyPath(ctx, P, a, b, 0); ctx.fillStyle = '#062421'; ctx.fill();
        // dải cực quang xanh lá – tím chuyển động
        ctx.globalCompositeOperation = 'lighter';
        for (let i = b - 1; i >= a; i--) {
          const p = P[i], w = Math.sin(i * 0.22 - t * 3);
          ctx.globalAlpha = 0.55;
          circle(ctx, p.x, p.y, p.r * (0.7 + 0.25 * w), `hsl(${150 + w * 60 + Math.sin(t + i * 0.05) * 40},100%,${45 + w * 10}%)`);
        }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        for (let i = Math.max(1, a - 2); i < Math.min(b + 2, P.length); i++) {
          if (hash(i, 11) > 0.3) continue;
          const p = P[i], [c, s] = dirOf(p), off = (hash(i, 12) - 0.5) * 1.5 * p.r;
          circle(ctx, p.x - s * off, p.y + c * off, p.r * 0.06, `rgba(255,255,255,${0.4 + 0.6 * Math.abs(Math.sin(t * 2 + i))})`);
        }
      },
      head(ctx, h, t, look) {
        for (const side of [-1, 1]) roundEye(ctx, eyePos(h, h.r, side, 0.28, 0.45), h.r, look, h.r * 0.33, '#18a878', '#00140d');
      },
    },
  );

  // Tên hiển thị: mẫu cờ dùng tên nước theo ngôn ngữ trang (Intl), mẫu thường lấy từ bản dịch
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames([window.I18N.lang], { type: 'region' }); } catch { /* trình duyệt cũ */ }
  // Tên Intl chưa quen tai với người đọc
  const NAME_FIX = { vi: { IT: 'Ý', CD: 'CHDC Congo' }, en: { CD: 'DR Congo' } }[window.I18N.lang] || {};
  function nameOf(i) {
    const s = SKINS[i];
    if (!s) return '';
    if (NAME_FIX[s.country]) return NAME_FIX[s.country];
    if (s.country) { try { return (regionNames && regionNames.of(s.country)) || s.name; } catch { return s.name; } }
    return window.I18N.t('skin.' + i);
  }

  const CHUNK = 10;

  // Vẽ một con rắn. P: điểm thân (đầu → đuôi) đã qua resampleFlat/finish.
  function draw(ctx, P, skinIdx, t, r, look, boost, hue) {
    const skin = SKINS[skinIdx] || SKINS[0];
    if (hue === undefined || hue === null) hue = 0;
    const outline = skin.classic ? `hsl(${hue},80%,24%)` : skin.outline;
    const glow = skin.classic ? hslHex(hue, 100, 60) : skin.glow;
    const n = P.length;
    if (n < 2) return;
    const glowFor = (hex, alphaFn, mul, step) => {
      ctx.globalCompositeOperation = 'lighter';
      const g = glowSprite(hex);
      for (let i = 0; i < n; i += step) {
        const gr = P[i].r * mul;
        ctx.globalAlpha = alphaFn(i);
        ctx.drawImage(g, P[i].x - gr, P[i].y - gr, gr * 2, gr * 2);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    };
    if (boost) glowFor(glow, i => 0.35 + 0.3 * Math.sin(t * 14 - i * 0.4), 2.6, 2);
    if (skin.aura) glowFor(skin.aura, () => 0.16, 2.1, 3);
    if (skin.under) skin.under(ctx, P[0], t);

    ctx.save(); ctx.translate(r * 0.15, r * 0.3); bodyPath(ctx, P, 0, n, 0); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(); ctx.restore();
    bodyPath(ctx, P, 0, n, skin.outlineW(r)); ctx.fillStyle = outline; ctx.fill();

    // Vẽ thân theo từng đoạn từ đuôi lên đầu: chỗ rắn tự cuộn đè lên mình thì phần gần đầu nằm trên.
    for (let a = Math.floor((n - 1) / CHUNK) * CHUNK; a >= 0; a -= CHUNK) {
      const b = Math.min(n, a + CHUNK + 1);
      ctx.save();
      bodyPath(ctx, P, a, b, 0);
      ctx.clip();
      skin.body(ctx, P, a, b, t, hue);
      shade(ctx, P, Math.max(0, a - 2), Math.min(n, b + 2), r, skin.gloss);
      ctx.restore();
    }
    skin.head(ctx, P[0], t, look);
  }

  return { SKINS, CLASSIC, FREE, nameOf, draw, resampleFlat, finish };
})();
