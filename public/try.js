/* try.js — the public "Try the planner" mini-demo (public/try.html, generated
   from builder.html by scripts/gen-try.mjs). Loaded FIRST, in <head>:
     1. no Supabase: the config is blanked, so store-api.js runs its browser-only
        localStorage tier (layouts live in this browser and nowhere else);
     2. network guard: only same-origin static GETs and the pinned three.js CDN
        directories are allowed — every API / Supabase / write request is refused;
     3. theme (the builder's inline theme script is not carried over);
     4. after load: a pre-made wedding banquet, the 2D / 3D / Measure toggle (m / ft),
        a 5-item "Add item" tray, rotate and reset (builder.js window.__helmSandbox hook). */
(function () {
  'use strict';
  var W = window;
  try { Object.defineProperty(W, 'HELM_SANDBOX', { value: true, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(W, 'SUPABASE_CONFIG', { value: Object.freeze({ url: '', anonKey: '' }), writable: false, configurable: false }); } catch (e) {}

  /* ---- 2. network guard ---- */
  var CDN = ['https://cdnjs.cloudflare.com/ajax/libs/three.js/', 'https://cdn.jsdelivr.net/npm/three@'];
  function okUrl(u, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    var url; try { url = new URL(String(u), location.href); } catch (e) { return false; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.origin === location.origin) return !/^\/(api|functions|rest|auth|storage)(\/|$)/.test(url.pathname);
    for (var i = 0; i < CDN.length; i++) if (url.href.indexOf(CDN[i]) === 0) return true;
    return false;
  }
  W.__trySandboxOk = okUrl;   // for tests / debugging only
  var realFetch = W.fetch;
  if (realFetch) {
    W.fetch = function (input, init) {
      var u = input && typeof input === 'object' && 'url' in input ? input.url : input;
      var m = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
      if (!okUrl(u, m)) return Promise.reject(new TypeError('Sandbox: network request blocked'));
      return realFetch.apply(this, arguments);
    };
  }
  if (W.XMLHttpRequest) {
    var open = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (m, u) {
      if (!okUrl(u, m)) throw new TypeError('Sandbox: network request blocked');
      return open.apply(this, arguments);
    };
  }
  try { if (navigator.sendBeacon) navigator.sendBeacon = function () { return false; }; } catch (e) {}
  if (W.WebSocket) W.WebSocket = function () { throw new TypeError('Sandbox: network request blocked'); };

  /* ---- 3. theme (same key as the builder) ---- */
  try {
    var t = window.HELM_DARK_MODE === true ? localStorage.getItem('bps.theme') : 'light';   // dark mode off for now: always light
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
  } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }

  /* ---- 4. the focused mini-demo: a pre-made wedding banquet, 3 modes, a 5-item tray ---- */
  var HALL = { w: 80, h: 54 };                       // ft (about 24.4 × 16.5 m)
  var DEMO = [
    { t: 'stagebackdrop', x: 25, y: 1,  o: { width: 30, label: 'Floral backdrop' } },
    { t: 'stage',         x: 25, y: 3,  o: { width: 30, height: 11, label: 'Stage' } },
    { t: 'lightingtree',  x: 19, y: 5,  o: { label: 'Light' } },
    { t: 'lightingtree',  x: 58, y: 5,  o: { label: 'Light' } },
    { t: 'dancefloor',    x: 30, y: 19, o: { width: 20, height: 15, label: 'Dance floor' } },
    { t: 'buffet',        x: 3,  y: 49, o: { width: 16, label: 'Buffet' } },
    { t: 'sofa',          x: 61, y: 49, o: { label: 'Lounge' } },
    { t: 'sofa',          x: 70, y: 49, o: { label: 'Lounge' } },
    { t: 'floralentrance',x: 33, y: 49, o: { label: 'Entrance arch' } },
    { t: 'lightingtree',  x: 28, y: 50, o: { label: 'Light' } },
    { t: 'lightingtree',  x: 49, y: 50, o: { label: 'Light' } }
  ];
  (function () {
    var n = 1, P = [[6, 18], [16, 18], [58, 18], [68, 18], [6, 28], [16, 28], [58, 28], [68, 28], [6, 38], [16, 38], [58, 38], [68, 38], [27, 39], [47, 39]];
    for (var i = 0; i < P.length; i++) DEMO.push({ t: 'table', x: P[i][0], y: P[i][1], o: { label: 'T' + (n++) } });
  })();
  var COLORS = {"stagebackdrop": "#c0607a", "stage": "#0f5c45", "lightingtree": "#c99a3e", "dancefloor": "#b8955a", "buffet": "#9a6b3f", "sofa": "#6b5a8e", "floralentrance": "#c0607a", "table": "#3f7d68", "floralarch": "#c0607a"};
  for (var di = 0; di < DEMO.length; di++) { DEMO[di].o.color = COLORS[DEMO[di].t]; DEMO[di].o.colorCustom = true; }
  var state = { mode: '2d', unit: 'm' };
  function api() { return W.__helmSandbox; }
  function $(id) { return document.getElementById(id); }
  function reduced() { try { return W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function loadDemo() { var A = api(); if (!A) return false; A.load(DEMO, HALL); A.unit(state.unit); return true; }
  function swapFx() {
    if (reduced()) return;
    var r = document.documentElement; r.classList.remove('try-swap'); void r.offsetWidth; r.classList.add('try-swap');
    setTimeout(function () { r.classList.remove('try-swap'); }, 420);
  }
  function setMode(m) {
    var A = api(); if (!A || (m !== '2d' && m !== '3d' && m !== 'measure')) return;
    if (m === state.mode) return;
    swapFx();
    var seg = document.getElementById('viewSeg');
    var want = m === '3d' ? '3d' : '2d';
    if (m !== 'measure') A.measure(false);
    var b = seg && seg.querySelector('[data-v="' + want + '"]');
    if (b && !b.classList.contains('on')) b.click();
    if (m === 'measure') A.measure(true);
    state.mode = m;
    document.documentElement.setAttribute('data-try-mode', m);
    var bs = document.querySelectorAll('#tryModes [data-m]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-checked', String(bs[i].getAttribute('data-m') === m));
    $('tryUnits').hidden = m !== 'measure';
    $('tryHint').textContent = m === '3d' ? 'Drag to orbit · scroll or pinch to zoom' :
      m === 'measure' ? 'Tap an item to see its distance to every wall and neighbour' : 'Drag any item to move it · R or the round handle to rotate';
    if (m !== '3d') setTimeout(function () { A.fit(); }, 30);
    else [300, 1200].forEach(function (ms) { setTimeout(function () { if (state.mode === '3d' && typeof W.__zoom3D === 'function') W.__zoom3D('fit'); }, ms); });
    if (m === '3d') setTimeout(function () { if (state.mode === '3d' && typeof W.__zoom3D === 'function') W.__zoom3D(0.72); }, 1700);
  }
  function setUnit(u) {
    var A = api(); if (!A || (u !== 'm' && u !== 'ft')) return;
    state.unit = u; A.unit(u);
    var bs = document.querySelectorAll('#tryUnits [data-u]');
    for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-checked', String(bs[i].getAttribute('data-u') === u));
  }
  // nothing here is ever saved — skip the builder's "leave with unsaved changes?" prompt
  if (typeof W.addEventListener !== 'function') return;   // not a browser (unit tests)
  W.addEventListener('beforeunload', function (e) { e.stopImmediatePropagation(); }, true);
  W.__trySandbox = { setMode: setMode, setUnit: setUnit, reset: loadDemo };
  W.addEventListener('load', function () {
    if (!loadDemo()) return;
    document.documentElement.setAttribute('data-try-mode', '2d');
    var modes = $('tryModes');
    modes.addEventListener('click', function (e) { var b = e.target.closest('[data-m]'); if (b) setMode(b.getAttribute('data-m')); });
    modes.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var order = ['2d', '3d', 'measure'], i = order.indexOf(state.mode);
      i = (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3; setMode(order[i]);
      var nb = modes.querySelector('[data-m="' + order[i] + '"]'); if (nb) nb.focus(); e.preventDefault();
    });
    $('tryUnits').addEventListener('click', function (e) { var b = e.target.closest('[data-u]'); if (b) setUnit(b.getAttribute('data-u')); });
    var tray = $('tryTray'), add = $('tryAdd');
    function tray_(open) { tray.hidden = !open; add.setAttribute('aria-expanded', String(open)); }
    add.addEventListener('click', function () { tray_(tray.hidden); });
    tray.addEventListener('click', function (e) {
      var b = e.target.closest('[data-add]'); if (!b) return;
      if (state.mode === '3d') setMode('2d');
      api().add(b.getAttribute('data-add'), { color: COLORS[b.getAttribute('data-add')] }); tray_(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !tray.hidden) tray_(false); });
    $('tryRotate').addEventListener('click', function () { api().rotate(); });
    $('tryReset').addEventListener('click', function () { setMode('2d'); loadDemo(); });
    var rt; W.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (state.mode !== '3d') api().fit(); }, 150); });
  });
})();
