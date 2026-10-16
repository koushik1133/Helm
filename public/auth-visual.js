/* auth-visual.js - small story visual for the sign-in brand panel:
   paper sketch -> precise 2D -> 3D -> tracked. Built with DOM APIs only (no innerHTML). Static under reduced motion. */
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function build() {
    var host = document.getElementById('authVisual');
    if (!host) return;
    var svg = el('svg', { viewBox: '0 0 440 150', role: 'img', 'aria-label': 'A paper sketch becomes a precise 2D plan, then a 3D view, then a tracked event' });
    var stages = [];
    function stage(x, label) {
      var g = el('g', { 'class': 'av-st', transform: 'translate(' + x + ',10)' }, svg);
      el('rect', { x: 0, y: 0, width: 96, height: 96, rx: 14, 'class': 'av-card' }, g);
      var t = el('text', { x: 48, y: 124, 'text-anchor': 'middle', 'class': 'av-lbl' }, g);
      t.appendChild(document.createTextNode(label));
      stages.push(g);
      return g;
    }
    // 1. sketch: wobbly hand-drawn outline + scribbled tables
    var s1 = stage(0, 'Sketch');
    el('path', { d: 'M18 22 C34 18 62 24 78 20 C80 40 76 60 79 76 C60 79 38 74 17 77 C20 58 15 40 18 22Z', 'class': 'av-ink av-dash' }, s1);
    el('path', { d: 'M32 38 c4 -5 10 -2 9 3 c-1 5 -8 6 -10 1', 'class': 'av-ink' }, s1);
    el('path', { d: 'M56 54 c5 -4 10 0 8 5 c-2 4 -9 4 -9 -1', 'class': 'av-ink' }, s1);
    // 2. precise 2D plan
    var s2 = stage(114, '2D plan');
    el('rect', { x: 18, y: 20, width: 60, height: 56, rx: 2, 'class': 'av-ink' }, s2);
    [[34, 38], [62, 38], [34, 60], [62, 60]].forEach(function (p) { el('circle', { cx: p[0], cy: p[1], r: 6, 'class': 'av-fill' }, s2); });
    el('line', { x1: 18, y1: 84, x2: 78, y2: 84, 'class': 'av-ink av-thin' }, s2);
    // 3. 3D isometric block
    var s3 = stage(228, '3D view');
    el('path', { d: 'M48 22 L76 38 L48 54 L20 38Z', 'class': 'av-top' }, s3);
    el('path', { d: 'M20 38 L48 54 L48 80 L20 64Z', 'class': 'av-left' }, s3);
    el('path', { d: 'M76 38 L48 54 L48 80 L76 64Z', 'class': 'av-right' }, s3);
    // 4. tracked: check badge
    var s4 = stage(342, 'Tracked');
    el('circle', { cx: 48, cy: 48, r: 24, 'class': 'av-fill' }, s4);
    el('path', { d: 'M37 49 L45 57 L60 40', 'class': 'av-check' }, s4);
    // connectors
    [100, 214, 328].forEach(function (x) { el('path', { d: 'M' + (x + 2) + ' 58 l8 0 m-3 -3 l3 3 l-3 3', 'class': 'av-ink av-thin' }, svg); });
    host.appendChild(svg);

    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduce) { stages.forEach(function (g) { g.classList.add('on'); }); return; }
    var i = 0;
    function tick() {
      stages.forEach(function (g, k) { g.classList.toggle('on', k <= i); g.classList.toggle('cur', k === i); });
      i = (i + 1) % (stages.length + 1);
    }
    tick();
    setInterval(tick, 1400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
