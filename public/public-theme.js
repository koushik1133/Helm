/* public-theme.js - applies the visitor's saved Helm theme to PUBLIC pages before paint (look only).
   Palette: localStorage 'helm.shellb.theme' (default EMERALD since Oct 2026; was cobalt).
   Mode: ALWAYS LIGHT while dark mode is off (window.HELM_DARK_MODE !== true). With the flag on, the saved
   'bps.theme' (light|dark) and then the OS preference are used again. Dark CSS is kept, just never applied. */
(function () {
  var root = document.documentElement, pt = 'emerald', mode = 'light';
  var ok = { cobalt: 1, midnight: 1, emerald: 1, graphite: 1, studio: 1 };
  var DARK_ON = window.HELM_DARK_MODE === true;
  try {
    var s = localStorage.getItem('helm.shellb.theme');
    /* one-time move to the new default: a device still on the OLD default (cobalt / nothing saved) starts on emerald */
    if (localStorage.getItem('helm.theme.v') !== '2') {
      if (!s || s === 'cobalt') { s = 'emerald'; localStorage.setItem('helm.shellb.theme', s); }
      localStorage.setItem('helm.theme.v', '2');
    }
    if (s && ok[s]) pt = s;
  } catch (e) {}
  if (DARK_ON) {
    mode = null;
    try { var m = localStorage.getItem('bps.theme'); if (m === 'dark' || m === 'light') mode = m; } catch (e) {}
    if (!mode) { try { mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { mode = 'light'; } }
  }
  root.setAttribute('data-pt', pt);
  root.setAttribute('data-hb-theme', pt);
  root.setAttribute('data-theme', mode);
  if (!DARK_ON) {
    try { root.style.colorScheme = 'light'; } catch (e) {}
    /* light lock (shared with store-api.js): page-level toggles (builder, demo, try) can never switch to dark */
    if (!window.__helmLightLock) {
      window.__helmLightLock = true;
      try { new MutationObserver(function () { if (root.getAttribute('data-theme') !== 'light') root.setAttribute('data-theme', 'light'); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) {}
    }
  }
})();
