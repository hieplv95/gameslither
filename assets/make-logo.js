'use strict';
// Dựng logo-badge.png từ logo-badge.svg (chạy trên máy có font, ví dụ Windows: node assets/make-logo.js).
// Server chỉ dùng file PNG nên VPS không cần cài font.
const path = require('path');
const sharp = require('sharp');

sharp(path.join(__dirname, 'logo-badge.svg'), { density: 216 })   // 3× độ phân giải gốc cho sắc nét
  .png()
  .toFile(path.join(__dirname, 'logo-badge.png'))
  .then(i => console.log(`logo-badge.png ${i.width}×${i.height}`));
