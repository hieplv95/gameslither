'use strict';
// Dựng logo vuông 500×500 và banner 1200×600 cho các trang entity / mạng xã hội
// (chạy trên máy có font Segoe UI, ví dụ Windows: node assets/make-entity.js). Kết quả ở assets/entity/.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, 'entity');
fs.mkdirSync(OUT, { recursive: true });
const FONT = 'Segoe UI, Arial, sans-serif';

// Biểu tượng con rắn (giống public/favicon.svg, hệ toạ độ 64×64)
const snake = `
  <path d="M14 46c0-10 12-10 18-16s4-14 14-14" fill="none" stroke="#7cff6b" stroke-width="11" stroke-linecap="round"/>
  <path d="M14 46c0-10 12-10 18-16s4-14 14-14" fill="none" stroke="#22d3ee" stroke-width="3" stroke-linecap="round" opacity=".6" transform="translate(-1.5 -2)"/>
  <circle cx="44" cy="13.5" r="2.6" fill="#fff"/><circle cx="50" cy="17.5" r="2.6" fill="#fff"/>
  <circle cx="44.6" cy="13.2" r="1.2" fill="#111"/><circle cx="50.6" cy="17.2" r="1.2" fill="#111"/>`;
const glow = id => `
  <filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="2.2" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>`;

// Mạng xã hội hay cắt ảnh đại diện thành hình tròn → nền phủ kín, nội dung nằm trong vòng tròn giữa.
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="65%">
      <stop offset="0" stop-color="#173040"/><stop offset="0.6" stop-color="#0d151d"/><stop offset="1" stop-color="#0b0f14"/>
    </radialGradient>
    ${glow('g')}
  </defs>
  <rect width="500" height="500" fill="url(#bg)"/>
  <g transform="translate(118 52) scale(4.1)" filter="url(#g)">${snake}</g>
  <text x="250" y="378" text-anchor="middle" font-family="${FONT}" font-size="62" font-weight="900" letter-spacing="-1.5" fill="#e8eef5">Game<tspan fill="#7cff6b">Slither</tspan></text>
  <text x="250" y="418" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="4" fill="#93a4b8">SNAKE .IO GAME</text>
</svg>`;

const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600">
  <defs>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#0b0f14" stop-opacity="0.95"/>
      <stop offset="0.42" stop-color="#0b0f14" stop-opacity="0.82"/>
      <stop offset="0.62" stop-color="#0b0f14" stop-opacity="0"/>
    </linearGradient>
    ${glow('g')}
  </defs>
  <rect width="1200" height="600" fill="url(#fade)"/>
  <g transform="translate(70 92) scale(1.9)" filter="url(#g)">${snake}</g>
  <text x="200" y="182" font-family="${FONT}" font-size="76" font-weight="900" letter-spacing="-1.5" fill="#e8eef5">Game<tspan fill="#7cff6b">Slither</tspan></text>
  <text x="84" y="276" font-family="${FONT}" font-size="46" font-weight="800" fill="#fbbf24">Game Slither io Online</text>
  <text x="84" y="326" font-family="${FONT}" font-size="26" font-weight="600" fill="#cbd5e1">Free multiplayer snake game · up to 50 players</text>
  <text x="84" y="362" font-family="${FONT}" font-size="26" font-weight="600" fill="#cbd5e1">No download · PC, phone &amp; tablet</text>
  <rect x="84" y="410" width="330" height="70" rx="35" fill="#7cff6b"/>
  <text x="249" y="455" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="900" fill="#062014">gameslither.io</text>
</svg>`;

(async () => {
  await sharp(Buffer.from(logo), { density: 144 }).resize(500, 500).png().toFile(path.join(OUT, 'logo-500.png'));
  // nền banner: cảnh thật dựng bằng code vẽ của game; nửa trái phủ tối để đặt chữ
  const bg = await sharp(path.join(__dirname, 'game-ref-1.jpg')).resize(1200, 600, { fit: 'cover', position: 'centre' }).toBuffer();
  await sharp(bg)
    .composite([{ input: await sharp(Buffer.from(banner), { density: 72 }).png().toBuffer() }])
    .jpeg({ quality: 90 })
    .toFile(path.join(OUT, 'banner-1200x600.jpg'));
  for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size, 'bytes');
})();
