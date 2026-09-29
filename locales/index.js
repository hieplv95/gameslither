'use strict';
// Danh sách ngôn ngữ theo thứ tự hiển thị. Tiếng Anh (phần tử đầu) là mặc định và là bản gốc để so khoá.
// 10 ngôn ngữ nhiều người nói nhất (Ethnologue 2025) + tiếng Việt.
const CODES = ['en', 'zh', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'ru', 'id', 'vi'];
const LOCALES = CODES.map(c => require(`./${c}`));
const EN = LOCALES[0];

// Khoá nào bản dịch thiếu thì dùng tạm tiếng Anh và cảnh báo khi khởi động.
for (const L of LOCALES.slice(1)) {
  for (const part of ['seo', 't', 'ui', 'server']) {
    const missing = Object.keys(EN[part]).filter(k => L[part][k] === undefined);
    if (missing.length) {
      console.warn(`[locales] ${L.code}.${part} thiếu: ${missing.join(', ')} → dùng tiếng Anh`);
      for (const k of missing) L[part][k] = EN[part][k];
    }
  }
}

module.exports = LOCALES;
