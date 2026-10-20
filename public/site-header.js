/* site-header.js - r23: the ONE public header (markup from scripts/gen-site-header.mjs, styles in site-header.css).
   Same behaviour as the home page nav (home.js): mega panels on click / hover, the phone sheet behind the burger,
   Escape closes everything. CSP-safe: it only toggles classes and ARIA attributes (no HTML strings, no inline styles). */
(function () {
  'use strict';
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  ready(function () {
    var nav = document.querySelector('header.sh');
    if (!nav) return;
    var burger = nav.querySelector('.sh-burger'), menu = nav.querySelector('.sh-menu');
    var megas = Array.prototype.slice.call(nav.querySelectorAll('.sh-mi'));
    var fine = !!(window.matchMedia && window.matchMedia('(pointer:fine)').matches);
    var mobile = function () { return window.innerWidth < 1024; };
    function btnOf(li) { return li.querySelector('.sh-link'); }
    function closeMegas(except) {
      megas.forEach(function (li) {
        if (li === except) return;
        li.classList.remove('open');
        var b = btnOf(li); if (b) b.setAttribute('aria-expanded', 'false');
      });
    }
    megas.forEach(function (li) {
      var btn = btnOf(li), t = null, hoverAt = 0;
      if (!btn) return;
      btn.addEventListener('click', function () {
        // a mouse click lands right after the hover opened the panel: keep it open instead of toggling it shut
        if (fine && !mobile() && li.classList.contains('open') && Date.now() - hoverAt < 600) return;
        var open = !li.classList.contains('open');
        closeMegas(li);
        li.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
      });
      if (fine) {
        li.addEventListener('mouseenter', function () { if (mobile()) return; clearTimeout(t); closeMegas(li); if (!li.classList.contains('open')) hoverAt = Date.now(); li.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); });
        li.addEventListener('mouseleave', function () { if (mobile()) return; t = setTimeout(function () { li.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }, 160); });
      }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.sh-mi')) closeMegas(); });
    function setMenu(open) {
      if (!burger) return;
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      nav.classList.toggle('sh-open', open);
      document.body.classList.toggle('sh-lock', open);
      if (!open) closeMegas();
    }
    if (burger) burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
    if (menu) menu.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) { setMenu(false); closeMegas(); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setMenu(false); closeMegas(); } });
    window.addEventListener('resize', function () { if (!mobile() && nav.classList.contains('sh-open')) setMenu(false); }, { passive: true });
  });
})();
