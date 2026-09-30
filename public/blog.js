'use strict';
// Trang blog: menu điện thoại + năm ở footer.
(() => {
  const toggle = document.getElementById('navToggle'), nav = document.getElementById('siteNav');
  toggle.onclick = () => toggle.setAttribute('aria-expanded', nav.classList.toggle('open'));
  document.getElementById('year').textContent = new Date().getFullYear();
})();
