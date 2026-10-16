/* marketing-theme.js - marketing + sign-in pages are ALWAYS Emerald LIGHT (dark mode removed, Oct 2026).
   Any leftover [data-mk-mode] toggle buttons (login/reset) are removed on load. The app's own saved
   'bps.theme' preference is NOT touched, so signed-in screens keep whatever the user chose there. */
(function () {
  var root = document.documentElement;
  root.setAttribute('data-pt', 'emerald');
  root.setAttribute('data-hb-theme', 'emerald');
  root.setAttribute('data-theme', 'light');
  root.setAttribute('data-mk-lock', '');   /* store-api.js: skip the app's saved light/dark here */
  root.style.colorScheme = 'light';
  function strip() {
    var bs = document.querySelectorAll('[data-mk-mode]');
    for (var i = 0; i < bs.length; i++) if (bs[i].parentNode) bs[i].parentNode.removeChild(bs[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', strip); else strip();
})();
