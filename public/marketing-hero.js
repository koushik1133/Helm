/* marketing-hero.js - (1) scroll reveals for marketing pages, (2) the landing "Before -> After" hero story.
   CSP-safe: builds all SVG with createElementNS + textContent; no innerHTML, no inline styles.
   Stage contract (index.html): #mkStage[data-step] > #mkStageSvg, #mkPlay, #mkStepper button[data-go], #mkStageCap.
   Steps: 0 Paper -> 1 2D -> 2 3D -> 3 Render -> 4 Tracked. CSS in marketing.css drives every transition off data-step. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  root.classList.add('mk-js');
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /* ---------------- reveals ---------------- */
  function reveals() {
    var els = doc.querySelectorAll('.mk-reveal, main section.blk, main .finalcta, main .stats, main .flowstrip');
    var list = [];
    for (var i = 0; i < els.length; i++) { els[i].classList.add('mk-reveal'); list.push(els[i]); }
    if (reduce || !('IntersectionObserver' in window)) { list.forEach(function (el) { el.classList.add('is-in'); }); return; }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    list.forEach(function (el) { io.observe(el); });
  }

  /* ---------------- svg helpers ---------------- */
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent, text) {
    var n = doc.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) {
      var v = String(attrs[k]);
      // presentation attributes can't take var(); theme tokens go through CSSOM (CSP-safe)
      if (v.indexOf('var(') === 0) n.style.setProperty(k, v); else n.setAttribute(k, v);
    }
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  var seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function j(a) { return (rnd() - 0.5) * 2 * a; }
  // wobbly pencil path through points (closed if close)
  function wob(pts, amp, close) {
    var p = pts.map(function (q) { return [q[0] + j(amp), q[1] + j(amp)]; });
    var d = 'M' + p[0][0].toFixed(1) + ' ' + p[0][1].toFixed(1);
    var all = close ? p.concat([p[0]]) : p;
    for (var i = 1; i < all.length; i++) {
      var a = all[i - 1], b = all[i];
      var mx = (a[0] + b[0]) / 2 + j(amp * 1.4), my = (a[1] + b[1]) / 2 + j(amp * 1.4);
      d += ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
    }
    return d;
  }
  function wobCircle(cx, cy, r, amp) {
    var pts = []; for (var i = 0; i < 9; i++) { var t = i / 9 * Math.PI * 2; pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]); }
    return wob(pts, amp, true);
  }

  /* plan geometry: venue 24m x 16m at 13px/m */
  var M = 13, OX = 164, OY = 108, W = 24, H = 16, CX = OX + W * M / 2, CY = OY + H * M / 2;
  function P(x, y) { return [OX + x * M, OY + y * M]; }
  // isometric projection matching CSS scale(1,.58) rotate(45deg) about (CX, CY)
  var C45 = Math.SQRT1_2;
  function iso(x, y, z) {
    var dx = OX + x * M - CX, dy = OY + y * M - CY;
    return [CX + (dx * C45 - dy * C45), CY + 0.58 * (dx * C45 + dy * C45) - (z || 0) * M];
  }
  function poly(pts) { return pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
  function box(g, x, y, w, d, h, cTop, cL, cR, cls) {
    var gg = el('g', cls ? { 'class': cls } : null, g);
    el('polygon', { points: poly([iso(x, y + d, 0), iso(x + w, y + d, 0), iso(x + w, y + d, h), iso(x, y + d, h)]), fill: cL }, gg);
    el('polygon', { points: poly([iso(x + w, y, 0), iso(x + w, y + d, 0), iso(x + w, y + d, h), iso(x + w, y, h)]), fill: cR }, gg);
    el('polygon', { points: poly([iso(x, y, h), iso(x + w, y, h), iso(x + w, y + d, h), iso(x, y + d, h)]), fill: cTop }, gg);
    return gg;
  }
  var TABLES = []; (function () { for (var r = 0; r < 3; r++) for (var c = 0; c < 4; c++) TABLES.push([3.6 + c * 5.6 + (c > 1 ? 0.0 : 0), 7.2 + r * 3.0]); })();
  // central aisle: tables at columns x=3.6,9.2 | 14.8,20.4 -> gap between 9.2+1 and 14.8-1 = 3.6 m; show exact 1.5m side aisle to exit instead

  function buildDefs(svg) {
    var defs = el('defs', null, svg);
    var f = el('filter', { id: 'mkPaperTex', x: '0', y: '0', width: '100%', height: '100%' }, defs);
    el('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '2', seed: '3', result: 'n' }, f);
    el('feColorMatrix', { type: 'matrix', values: '0 0 0 0 0.45  0 0 0 0 0.36  0 0 0 0 0.25  0 0 0 0.10 0' }, f);
    el('feComposite', { in2: 'SourceGraphic', operator: 'in' }, f);
    var gp = el('pattern', { id: 'mkGrid', width: String(M), height: String(M), patternUnits: 'userSpaceOnUse', x: String(OX), y: String(OY) }, defs);
    el('path', { d: 'M' + M + ' 0H0V' + M, fill: 'none', stroke: 'currentColor', 'stroke-width': '.5', opacity: '.35' }, gp);
    function lg(id, stops, x2, y2) {
      var g = el('linearGradient', { id: id, x1: '0', y1: '0', x2: x2 || '0', y2: y2 || '1' }, defs);
      stops.forEach(function (s) { el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] == null ? '1' : s[2] }, g); });
    }
    lg('mkSky', [['0', '#2a1b3d'], ['.55', '#6b3a4a'], ['1', '#d98b5f']]);
    lg('mkFloor', [['0', '#f3d7b3'], ['1', '#b9875e']]);
    lg('mkStageG', [['0', '#3b2a2a'], ['1', '#1f1616']]);
    lg('mkWipe', [['0', '#fff', '0'], ['.5', '#fff', '.9'], ['1', '#fff', '0']], '1', '0');
    var rg = el('radialGradient', { id: 'mkGlow', cx: '.5', cy: '.5', r: '.5' }, defs);
    el('stop', { offset: '0', 'stop-color': '#ffe2a8', 'stop-opacity': '.85' }, rg);
    el('stop', { offset: '1', 'stop-color': '#ffe2a8', 'stop-opacity': '0' }, rg);
    var sh = el('filter', { id: 'mkSoft', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: '3' }, sh);
  }

  /* ---------- BEFORE: paper ---------- */
  function buildPaper(svg) {
    var g = el('g', { 'class': 'mkh-l mkh-paper' }, svg);
    el('rect', { x: '0', y: '0', width: '640', height: '440', fill: '#f5ecdb' }, g);
    el('rect', { x: '0', y: '0', width: '640', height: '440', fill: '#f5ecdb', filter: 'url(#mkPaperTex)' }, g);
    for (var i = 0; i < 13; i++) el('line', { x1: '0', x2: '640', y1: String(40 + i * 31), y2: String(40 + i * 31), stroke: '#9fb7d0', 'stroke-width': '.6', opacity: '.45' }, g);
    el('line', { x1: '58', x2: '58', y1: '0', y2: '440', stroke: '#e3a0a0', 'stroke-width': '.8', opacity: '.6' }, g);
    var sk = el('g', { 'class': 'mkh-sketch', fill: 'none', stroke: '#4a4038', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    var pen = { fill: '#4a4038', stroke: 'none', 'font-family': '"Segoe Print","Bradley Hand","Comic Sans MS",cursive', 'font-size': '13' };
    function note(x, y, t, size, rot, col) {
      var a = {}; for (var k in pen) a[k] = pen[k];
      a.x = String(x); a.y = String(y); if (size) a['font-size'] = String(size); if (col) a.fill = col;
      if (rot) a.transform = 'rotate(' + rot + ' ' + x + ' ' + y + ')';
      return el('text', a, sk, t);
    }
    // venue outline, twice for a sketchy look
    var v = [P(0, 0), P(W, 0), P(W, H), P(0, H)];
    el('path', { d: wob(v, 3, true) }, sk);
    el('path', { d: wob(v, 4, true), opacity: '.45' }, sk);
    // stage (overlapping the fire exit on the right wall)
    var st = [P(15, 3.5), P(25.2, 3.6), P(25.4, 7.4), P(15.2, 7.2)];
    el('path', { d: wob(st, 2.5, true) }, sk);
    for (var h = 0; h < 6; h++) el('path', { d: wob([P(15.6 + h * 1.6, 3.9), P(14.8 + h * 1.6 + 1.6, 7)], 1.2), opacity: '.4' }, sk);
    note(P(17, 5.7)[0], P(17, 5.7)[1], 'STAGE', 14);
    // fire exit gap in the right wall + red circle
    note(P(W, 5)[0] + 10, P(W, 5)[1] - 20, 'EXIT', 12, -8);
    var wg = el('g', { 'class': 'mkh-warn' }, sk);
    el('path', { d: wobCircle(P(W, 5.4)[0], P(W, 5.4)[1], 30, 4), stroke: '#d93025', 'stroke-width': '2.4' }, wg);
    el('path', { d: wobCircle(P(W, 5.4)[0] + 2, P(W, 5.4)[1] - 1, 33, 5), stroke: '#d93025', 'stroke-width': '1.2', opacity: '.6' }, wg);
    note(P(W, 5)[0] + 26, P(W, 5)[1] + 38, 'blocked?!', 13, 6, '#d93025');
    // tables, wobbly + some spilling outside the outline
    var tb = [[3, 6], [7.5, 5.6], [3.4, 10.4], [8, 10], [12.2, 11.2], [16.6, 10.6], [20.8, 11.6], [4.6, 14.3], [10.4, 14.8], [16.4, 15.4], [22.6, 15.8], [-1.6, 12.2]];
    tb.forEach(function (t) { var c = P(t[0], t[1]); el('path', { d: wobCircle(c[0], c[1], 13 + j(2), 2) }, sk); });
    // entry
    var e1 = P(10, H), e2 = P(14, H);
    el('path', { d: wob([[e1[0], e1[1] + 8], [e1[0], e1[1] - 6]], 1.5) }, sk);
    el('path', { d: wob([[e2[0], e2[1] + 8], [e2[0], e2[1] - 6]], 1.5) }, sk);
    note(e1[0] + 8, e1[1] + 22, 'entry ~ here', 12);
    // guessed distances
    note(P(1, -0.6)[0], P(1, -0.6)[1], '~10 ft?', 14, -4);
    note(P(9.5, 8)[0], P(9.5, 8)[1] + 4, 'approx', 12, 8);
    el('path', { d: wob([P(1, -1.2), P(9, -1.4)], 1.5) }, sk);
    note(P(W - 4, -0.7)[0], P(W - 4, -0.7)[1], '80 ft?? 25 m?', 12, 3);
    note(P(-0.6, 15.6)[0] - 46, P(-0.6, 15.6)[1] + 20, 'table outside!', 11, -6, '#d93025');
    // run-of-show sticky note, crossed out
    var sn = el('g', { transform: 'rotate(-5 20 30)' }, sk);
    el('rect', { x: '18', y: '22', width: '120', height: '74', fill: '#fff3a6', stroke: 'none', opacity: '.95' }, sn);
    var rs = ['Run of show', '6:00 guests in', '6:30 speech?', '7:00 dinner 7:30?'];
    rs.forEach(function (t, i) {
      var a = {}; for (var k in pen) a[k] = pen[k]; a.x = '26'; a.y = String(40 + i * 15); a['font-size'] = i ? '11' : '12';
      el('text', a, sn, t);
      if (i) el('path', { d: wob([[24, 36 + i * 15], [124, 36 + i * 15]], 1.2), stroke: '#4a4038', 'stroke-width': '1.3' }, sn);
    });
    // WhatsApp-style bills
    var bg = el('g', null, g);
    var bills = [['Decor advance 25k?', '10:42'], ['Tent bill ₹18,500 pls send', '11:05'], ['Caterer: add 40 plates??', '11:31'], ['Sound guy wants cash', '12:02']];
    bills.forEach(function (b, i) {
      var y = 320 - i * 40, x = 408 + (i % 2) * 18;
      var bb = el('g', { 'class': 'mkh-bub' }, bg);
      el('rect', { x: String(x), y: String(y), width: '196', height: '32', rx: '9', fill: '#d9fdd3', stroke: '#b9dcb3', 'stroke-width': '.8' }, bb);
      el('text', { x: String(x + 10), y: String(y + 20), 'font-size': '11.5', fill: '#1f2c1f', 'font-family': 'system-ui,sans-serif' }, bb, b[0]);
      el('text', { x: String(x + 188), y: String(y + 28), 'font-size': '8', fill: '#667', 'text-anchor': 'end', 'font-family': 'system-ui,sans-serif' }, bb, b[1] + ' ✓✓');
    });
    var calc = el('g', { 'class': 'mkh-calc' }, g);
    var ca = {}; for (var k in pen) ca[k] = pen[k];
    ca.x = '88'; ca.y = '410'; ca['font-size'] = '20'; ca.transform = 'rotate(-3 88 410)';
    el('text', ca, calc, '1,00,000 − ? − ? = ?');
    el('path', { d: wob([[300, 392], [330, 396], [312, 410], [336, 414]], 2), fill: 'none', stroke: '#4a4038', 'stroke-width': '1.4' }, calc);
    el('text', { x: '20', y: '432', 'font-size': '10', fill: '#7a6a58', 'font-family': 'system-ui,sans-serif', 'letter-spacing': '.12em' }, g, 'BEFORE · PAPER + WHATSAPP + EXCEL');
  }

  /* ---------- AFTER 1: 2D plan ---------- */
  function buildPlan(svg) {
    var g = el('g', { 'class': 'mkh-l mkh-plan' }, svg);
    el('rect', { x: String(OX), y: String(OY), width: String(W * M), height: String(H * M), fill: 'var(--panel)', stroke: 'var(--ink)', 'stroke-width': '2.2' }, g);
    el('rect', { x: String(OX), y: String(OY), width: String(W * M), height: String(H * M), fill: 'url(#mkGrid)', 'class': 'mkh-gridl', color: 'var(--accent)' }, g);
    // stage 8 x 3 m centered on top wall
    el('rect', { x: String(P(8, 0)[0]), y: String(P(8, 0.6)[1]), width: String(8 * M), height: String(3 * M), fill: 'var(--accent-soft)', stroke: 'var(--accent)', 'stroke-width': '1.6', rx: '2' }, g);
    el('text', { x: String(P(12, 2.4)[0]), y: String(P(12, 2.4)[1]), 'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700', fill: 'var(--acc-text)', 'letter-spacing': '.1em' }, g, 'STAGE 8 × 3 m');
    // tables
    TABLES.forEach(function (t) {
      var c = P(t[0], t[1]);
      el('circle', { cx: String(c[0]), cy: String(c[1]), r: String(0.9 * M), fill: 'var(--panel)', stroke: 'var(--ink-2)', 'stroke-width': '1.3' }, g);
      for (var a = 0; a < 6; a++) { var th = a / 6 * Math.PI * 2; el('circle', { cx: (c[0] + Math.cos(th) * 1.45 * M).toFixed(1), cy: (c[1] + Math.sin(th) * 1.45 * M).toFixed(1), r: '2.6', fill: 'var(--ink-3)' }, g); }
    });
    // fire exit (right wall, clear) + entry (bottom)
    var ex = P(W, 9.5);
    el('rect', { x: String(ex[0] - 2), y: String(ex[1]), width: '4', height: String(2 * M), fill: '#16a34a' }, g);
    var en = P(10.5, H);
    el('rect', { x: String(en[0]), y: String(en[1] - 2), width: String(3 * M), height: '4', fill: 'var(--panel)', stroke: 'var(--accent)', 'stroke-width': '1.4' }, g);
    el('text', { x: String(en[0] + 1.5 * M), y: String(en[1] + 14), 'text-anchor': 'middle', 'font-size': '9.5', fill: 'var(--ink-2)', 'font-weight': '600' }, g, 'ENTRY 3.0 m');
    // dimension lines
    var dims = el('g', { 'font-family': '"IBM Plex Mono",ui-monospace,monospace', 'font-size': '10.5', 'font-weight': '600' }, g);
    function dim(x1, y1, x2, y2, label, lx, ly, col, anchor) {
      var d = el('g', { 'class': 'mkh-dim', stroke: col || 'var(--accent)', fill: col || 'var(--acc-text)' }, dims);
      el('line', { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2), 'stroke-width': '1' }, d);
      var vert = x1 === x2;
      [[x1, y1], [x2, y2]].forEach(function (p) {
        el('line', vert ? { x1: String(p[0] - 4), x2: String(p[0] + 4), y1: String(p[1]), y2: String(p[1]), 'stroke-width': '1' } : { x1: String(p[0]), x2: String(p[0]), y1: String(p[1] - 4), y2: String(p[1] + 4), 'stroke-width': '1' }, d);
      });
      el('text', { x: String(lx), y: String(ly), stroke: 'none', 'text-anchor': anchor || 'middle' }, d, label);
    }
    dim(OX, OY - 16, OX + W * M, OY - 16, '24.0 m', CX, OY - 22);
    dim(OX - 16, OY, OX - 16, OY + H * M, '16.0 m', OX - 22, CY + 4, null, 'end');
    var a1 = P(W - 1.5, 15.2), a2 = P(W, 15.2);
    dim(a1[0], a1[1], a2[0], a2[1], '1.5 m aisle', a1[0] - 6, a1[1] + 4, null, 'end');
    dim(ex[0] + 14, ex[1], ex[0] + 14, ex[1] + 2 * M, 'Exit clear ✓', ex[0] + 20, ex[1] + M + 4, '#16a34a', 'start');
    el('text', { x: '20', y: '432', 'font-size': '10', fill: 'var(--ink-3)', 'letter-spacing': '.12em', 'font-family': 'system-ui,sans-serif' }, g, 'AFTER · 2D PLAN, EXACT TO THE CENTIMETRE');
  }

  /* ---------- AFTER 2: isometric 3D ---------- */
  function buildIso(svg) {
    var g = el('g', { 'class': 'mkh-l mkh-iso' }, svg);
    el('rect', { x: '0', y: '0', width: '640', height: '440', fill: 'var(--panel-2)' }, g);
    el('polygon', { points: poly([iso(0, 0), iso(W, 0), iso(W, H), iso(0, H)]), fill: 'var(--panel)', stroke: 'var(--line)', 'stroke-width': '1' }, g);
    el('polygon', { points: poly([iso(0, 0), iso(W, 0), iso(W, H), iso(0, H)]), fill: 'url(#mkGrid)', color: 'var(--accent)' }, g);
    // back walls
    el('polygon', { points: poly([iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, 3), iso(0, 0, 3)]), fill: 'var(--accent-soft)', opacity: '.7' }, g);
    el('polygon', { points: poly([iso(0, 0, 0), iso(0, H, 0), iso(0, H, 3), iso(0, 0, 3)]), fill: 'var(--accent-soft)', opacity: '.45' }, g);
    var up = el('g', null, g);
    box(up, 8, 0.6, 8, 3, 1, '#34d399', '#047857', '#065f46', 'mkh-up');
    // floral arch at the entry
    var ag = el('g', { 'class': 'mkh-up' }, up);
    var al = iso(10.5, H, 0), ar = iso(13.5, H, 0), top = iso(12, H, 3.6);
    el('path', { d: 'M' + al[0] + ' ' + al[1] + ' L' + iso(10.5, H, 2.4).join(' ') + ' Q' + top[0] + ' ' + (top[1] - 16) + ' ' + iso(13.5, H, 2.4).join(' ') + ' L' + ar[0] + ' ' + ar[1], fill: 'none', stroke: '#be185d', 'stroke-width': '3' }, ag);
    for (var f = 0; f <= 8; f++) { var t = f / 8, pp = iso(10.5 + 3 * t, H, 2.4 + Math.sin(t * Math.PI) * 1.1); el('circle', { cx: pp[0].toFixed(1), cy: pp[1].toFixed(1), r: '3.4', fill: f % 2 ? '#f9a8d4' : '#fda4af' }, ag); }
    // tables back-to-front
    TABLES.slice().sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (tt) {
      var tg = el('g', { 'class': 'mkh-up' }, up);
      for (var a = 0; a < 6; a++) { var th = a / 6 * Math.PI * 2; box(tg, tt[0] + Math.cos(th) * 1.45 - .2, tt[1] + Math.sin(th) * 1.45 - .2, .4, .4, .45, '#94a3b8', '#64748b', '#475569'); }
      var c = iso(tt[0], tt[1], .75);
      el('ellipse', { cx: c[0].toFixed(1), cy: (c[1] + 5).toFixed(1), rx: (0.9 * M * 1.0).toFixed(1), ry: (0.9 * M * .58).toFixed(1), fill: '#cbd5e1' }, tg);
      el('ellipse', { cx: c[0].toFixed(1), cy: c[1].toFixed(1), rx: (0.9 * M * 1.0).toFixed(1), ry: (0.9 * M * .58).toFixed(1), fill: '#ffffff', stroke: '#94a3b8', 'stroke-width': '.8' }, tg);
    });
    el('text', { x: '20', y: '432', 'font-size': '10', fill: 'var(--ink-3)', 'letter-spacing': '.12em', 'font-family': 'system-ui,sans-serif' }, g, 'AFTER · 3D VIEW OF THE SAME PLAN');
  }

  /* ---------- AFTER 3: illustrated render ---------- */
  function buildRender(svg) {
    var g = el('g', { 'class': 'mkh-l mkh-render' }, svg);
    el('rect', { x: '0', y: '0', width: '640', height: '440', fill: 'url(#mkSky)' }, g);
    el('polygon', { points: poly([iso(0, 0), iso(W, 0), iso(W, H), iso(0, H)]), fill: 'url(#mkFloor)' }, g);
    el('polygon', { points: poly([iso(0, 0, 0), iso(W, 0, 0), iso(W, 0, 3.2), iso(0, 0, 3.2)]), fill: '#4a2e3a', opacity: '.8' }, g);
    el('polygon', { points: poly([iso(0, 0, 0), iso(0, H, 0), iso(0, H, 3.2), iso(0, 0, 3.2)]), fill: '#3a2433', opacity: '.75' }, g);
    // string lights
    var lights = el('g', null, g);
    for (var i = 0; i <= 22; i++) {
      var t = i / 22, p = iso(t * W, 0, 3.1 - Math.sin(t * Math.PI * 3) * .25), q = iso(0, t * H, 3.1 - Math.sin(t * Math.PI * 2) * .25);
      el('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: '2.2', fill: '#ffe6a6', 'class': 'mkh-twinkle' }, lights);
      el('circle', { cx: q[0].toFixed(1), cy: q[1].toFixed(1), r: '2.2', fill: '#ffe6a6', 'class': 'mkh-twinkle' }, lights);
    }
    var sc = iso(12, 2.1, 1);
    el('ellipse', { cx: sc[0].toFixed(1), cy: (sc[1] + 10).toFixed(1), rx: '150', ry: '70', fill: 'url(#mkGlow)' }, g);
    box(g, 8, 0.6, 8, 3, 1, '#5b3b3b', '#2a1c1c', '#3a2626');
    box(g, 9, 0.6, 6, .3, 2.6, '#c08457', '#8a5a3a', '#a06a44');
    TABLES.slice().sort(function (a, b) { return (a[0] + a[1]) - (b[0] + b[1]); }).forEach(function (tt) {
      var c = iso(tt[0], tt[1], .75), fl = iso(tt[0], tt[1], 0);
      el('ellipse', { cx: (fl[0] + 6).toFixed(1), cy: (fl[1] + 4).toFixed(1), rx: '20', ry: '9', fill: '#3b2416', opacity: '.35', filter: 'url(#mkSoft)' }, g);
      for (var a = 0; a < 6; a++) { var th = a / 6 * Math.PI * 2; box(g, tt[0] + Math.cos(th) * 1.45 - .2, tt[1] + Math.sin(th) * 1.45 - .2, .4, .4, .5, '#f1e1c6', '#c9a77a', '#dcbf95'); }
      el('path', { d: 'M' + (c[0] - 11.7) + ' ' + c[1] + ' L' + (c[0] - 12.5) + ' ' + (c[1] + 12) + ' Q' + c[0] + ' ' + (c[1] + 19) + ' ' + (c[0] + 12.5) + ' ' + (c[1] + 12) + ' L' + (c[0] + 11.7) + ' ' + c[1] + 'Z', fill: '#f8f3ea' }, g);
      el('ellipse', { cx: c[0].toFixed(1), cy: c[1].toFixed(1), rx: '11.7', ry: '6.8', fill: '#fffaf1' }, g);
      el('circle', { cx: c[0].toFixed(1), cy: (c[1] - 3).toFixed(1), r: '3.4', fill: '#f472b6' }, g);
      el('circle', { cx: (c[0] + 2).toFixed(1), cy: (c[1] - 5).toFixed(1), r: '2.2', fill: '#fbcfe8' }, g);
    });
    var al = iso(10.5, H, 0), ar = iso(13.5, H, 0), top = iso(12, H, 3.6);
    el('path', { d: 'M' + al[0] + ' ' + al[1] + ' L' + iso(10.5, H, 2.4).join(' ') + ' Q' + top[0] + ' ' + (top[1] - 16) + ' ' + iso(13.5, H, 2.4).join(' ') + ' L' + ar[0] + ' ' + ar[1], fill: 'none', stroke: '#7c4a2a', 'stroke-width': '3' }, g);
    for (var f = 0; f <= 14; f++) { var tf = f / 14, pf = iso(10.5 + 3 * tf, H, 2.4 + Math.sin(tf * Math.PI) * 1.1); el('circle', { cx: (pf[0] + j(1.5)).toFixed(1), cy: (pf[1] + j(1.5)).toFixed(1), r: (3 + rnd() * 2).toFixed(1), fill: ['#f9a8d4', '#fda4af', '#fff1f2', '#86efac'][f % 4] }, g); }
    el('rect', { x: '0', y: '0', width: '640', height: '440', fill: 'url(#mkGlow)', opacity: '.18' }, g);
    el('text', { x: '20', y: '432', 'font-size': '10', fill: '#fde7cf', 'letter-spacing': '.12em', 'font-family': 'system-ui,sans-serif' }, g, 'AFTER · RENDER FOR THE CLIENT (ILLUSTRATION)');
    el('rect', { 'class': 'mkh-wipe', x: '-40', y: '0', width: '40', height: '440', fill: 'url(#mkWipe)' }, svg);
  }

  /* ---------- AFTER 4: tracked checklist ---------- */
  function buildCheck(svg) {
    var g = el('g', { 'class': 'mkh-l mkh-check' }, svg);
    el('rect', { x: '404', y: '206', width: '216', height: '196', rx: '16', fill: '#000', opacity: '.25', filter: 'url(#mkSoft)' }, g);
    el('rect', { x: '400', y: '200', width: '216', height: '196', rx: '16', fill: 'var(--panel)', stroke: 'var(--line)' }, g);
    var hd = el('g', null, g);
    el('text', { x: '418', y: '228', 'font-size': '10', 'font-weight': '700', fill: 'var(--ink-3)', 'letter-spacing': '.12em', 'font-family': 'system-ui,sans-serif' }, hd, 'EVENT TRACKED IN HELM');
    var rows = [['Tasks assigned'], ['Vendors booked'], ['Payments tracked'], ['Profit ₹40,000', true]];
    rows.forEach(function (r, i) {
      var y = 252 + i * 36, rg = el('g', { 'class': 'mkh-row' }, g);
      el('rect', { x: '414', y: String(y - 14), width: '188', height: '30', rx: '9', fill: r[1] ? 'var(--accent-soft)' : 'var(--panel-2)' }, rg);
      el('circle', { cx: '430', cy: String(y + 1), r: '8', fill: 'var(--accent)' }, rg);
      el('path', { d: 'M426 ' + (y + 1) + 'l3 3 5-6', fill: 'none', stroke: 'var(--acc-ink)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, rg);
      el('text', { x: '446', y: String(y + 5), 'font-size': '13', 'font-weight': r[1] ? '800' : '600', fill: r[1] ? 'var(--acc-text)' : 'var(--ink)', 'font-family': 'system-ui,sans-serif' }, rg, r[0]);
    });
  }

  /* ---------------- player ---------------- */
  var CAPS = ['Before: layouts sketched on paper, distances guessed, bills lost in WhatsApp, profit worked out by hand.',
    'Helm 2D: the same venue drawn to exact measurements, aisles and fire exits checked.',
    'Helm 3D: the plan lifts into a 3D view so the team sees the space before event day.',
    'Render: a realistic view to show and approve with the client.',
    'Tracked: tasks, vendors, payments and profit in one place.'];
  var DUR = [4200, 3600, 3200, 3000, 3600], PAUSE = 2200;

  function hero() {
    var stage = doc.getElementById('mkStage'), host = doc.getElementById('mkStageSvg');
    if (!stage || !host) return;
    var svg = el('svg', { viewBox: '0 0 640 440', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid slice' }, host);
    buildDefs(svg); buildPaper(svg); buildRender(svg); buildIso(svg); buildPlan(svg);
    // order: render must sit above iso; plan above all for the tilt; reorder so iso < render
    svg.insertBefore(svg.querySelector('.mkh-iso'), svg.querySelector('.mkh-render'));
    buildCheck(svg);
    var btns = stage.querySelectorAll('[data-go]'), cap = doc.getElementById('mkStageCap'), playBtn = doc.getElementById('mkPlay');
    var step = 4, timer = null, userPaused = reduce, visible = false;
    function set(n) {
      step = n; stage.setAttribute('data-step', String(n));
      stage.style.setProperty('--mk-dur', (DUR[n] + (n === 4 ? PAUSE : 0)) / 1000 + 's');
      for (var i = 0; i < btns.length; i++) { if (i === n) btns[i].setAttribute('aria-current', 'step'); else btns[i].removeAttribute('aria-current'); }
      if (cap) cap.textContent = CAPS[n];
    }
    function playing() { return !userPaused && visible && !reduce && !doc.hidden; }
    function schedule() {
      clearTimeout(timer); timer = null;
      stage.classList.toggle('is-playing', playing());
      if (!playing()) return;
      timer = setTimeout(function () { set((step + 1) % 5); schedule(); }, DUR[step] + (step === 4 ? PAUSE : 0));
    }
    function syncBtn() { playBtn.setAttribute('aria-pressed', userPaused ? 'true' : 'false'); playBtn.setAttribute('aria-label', userPaused ? 'Play animation' : 'Pause animation'); }
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      var n = Number(this.getAttribute('data-go'));
      // replay the step's entrance by passing through a neutral frame
      if (n === step && !reduce) { stage.setAttribute('data-step', '-1'); void stage.offsetWidth; }
      set(n); schedule();
    });
    playBtn.addEventListener('click', function () { userPaused = !userPaused; syncBtn(); if (!userPaused && step === 4) set(0); schedule(); });
    if (reduce) { set(4); syncBtn(); playBtn.hidden = true; return; }
    set(0); syncBtn();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { visible = e[0].isIntersecting; schedule(); }, { threshold: 0.35 }).observe(stage);
    } else { visible = true; schedule(); }
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) { clearTimeout(timer); stage.classList.remove('is-playing'); } else schedule(); });
  }

  function init() { reveals(); hero(); }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})();
