/* public-theme.js - applies the visitor's saved Helm theme to PUBLIC pages before paint (look only).
   Palette: localStorage 'helm.shellb.theme' (default cobalt). Mode: saved 'bps.theme' (light|dark), else OS preference. */
(function () {
  var root = document.documentElement, pt = 'cobalt', mode = null;
  var ok = { cobalt: 1, midnight: 1, emerald: 1, graphite: 1, studio: 1 };
  try { var s = localStorage.getItem('helm.shellb.theme'); if (s && ok[s]) pt = s; } catch (e) {}
  try { var m = localStorage.getItem('bps.theme'); if (m === 'dark' || m === 'light') mode = m; } catch (e) {}
  if (!mode) { try { mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { mode = 'light'; } }
  root.setAttribute('data-pt', pt);
  root.setAttribute('data-hb-theme', pt);
  root.setAttribute('data-theme', mode);
})();
