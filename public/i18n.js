'use strict';
// Chuỗi giao diện game theo ngôn ngữ trang. Server chèn sẵn bộ chữ vào window.I18N_DICT
// (lấy từ locales/<mã>.js → ui, thiếu khoá nào thì dùng tiếng Anh).
window.I18N = (() => {
  const D = window.I18N_DICT || {};
  const lang = (document.documentElement.lang || 'en').split('-')[0];
  const t = (key, vars = {}) => String(D[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  const LOCALES = { en: 'en-US', zh: 'zh-CN', hi: 'hi-IN', es: 'es-ES', ar: 'ar', fr: 'fr-FR', bn: 'bn-BD', pt: 'pt-BR', ru: 'ru-RU', id: 'id-ID', vi: 'vi-VN' };
  return { lang, t, locale: LOCALES[lang] || 'en-US' };
})();
