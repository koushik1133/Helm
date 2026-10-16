/* marketing-features.js - animated "screen" previews for the feature category cards (index #services, services.html).
   Builds every SVG with createElementNS + textContent (CSP / no HTML sinks). Each preview shows a static, complete frame;
   it plays only on hover, keyboard focus or tap, stops off-screen, and never plays under prefers-reduced-motion. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function s(tag, attrs, parent, text) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function rect(p, x, y, w, h, cls, rx) { return s('rect', { x: x, y: y, width: w, height: h, rx: rx == null ? 4 : rx, 'class': cls || 'mf-s2' }, p); }
  function txt(p, x, y, t, cls) { return s('text', { x: x, y: y, 'class': cls || 'mf-tx' }, p, t); }

  var builders = {
    crm: function (g) {
      var cols = ['New', 'Discovery', 'Quoted', 'Won'];
      for (var i = 0; i < 4; i++) {
        rect(g, 8 + i * 58, 10, 54, 130, 'mf-s1', 6);
        txt(g, 14 + i * 58, 24, cols[i]);
      }
      rect(g, 14, 32, 42, 18, 'mf-s2'); rect(g, 14, 54, 42, 18, 'mf-s2');
      rect(g, 72, 32, 42, 18, 'mf-s2'); rect(g, 130, 32, 42, 18, 'mf-s2');
      rect(g, 188, 32, 42, 18, 'mf-acc mf-a-pop');
      var c = rect(g, 72, 54, 42, 18, 'mf-acc mf-a-slide');
      c.setAttribute('data-mf-delay', '1');
    },
    layout: function (g) {
      var plan = s('g', { 'class': 'mf-a-tilt' }, g);
      rect(plan, 20, 12, 200, 124, 'mf-s1', 6);
      rect(plan, 80, 18, 80, 18, 'mf-acc');
      txt(plan, 98, 31, 'STAGE', 'mf-tx mf-tx-inv');
      for (var r = 0; r < 2; r++) for (var c = 0; c < 4; c++) s('circle', { cx: 50 + c * 46, cy: 66 + r * 38, r: 11, 'class': 'mf-s2' }, plan);
      s('line', { x1: 50, y1: 124, x2: 96, y2: 124, 'class': 'mf-ln' }, plan);
      txt(plan, 58, 133, '2.40 m', 'mf-tx mf-tx-s');
    },
    quotes: function (g) {
      rect(g, 16, 10, 208, 130, 'mf-s1', 8);
      var items = [['Stage & backdrop', '1,20,000'], ['Floral arch', '45,000'], ['Seating (300)', '90,000'], ['Lighting', '60,000']];
      for (var i = 0; i < items.length; i++) {
        var row = s('g', { 'class': 'mf-a-row', 'data-i': String(i) }, g);
        txt(row, 26, 32 + i * 18, items[i][0]);
        txt(row, 214, 32 + i * 18, '₹' + items[i][1], 'mf-tx mf-tx-r');
      }
      s('line', { x1: 26, y1: 108, x2: 214, y2: 108, 'class': 'mf-ln' }, g);
      txt(g, 26, 128, 'Total', 'mf-tx mf-tx-b');
      var t = txt(g, 214, 128, '₹3,15,000', 'mf-tx mf-tx-b mf-tx-r mf-acc-t');
      t.setAttribute('data-mf-total', '315000');
    },
    ops: function (g) {
      rect(g, 16, 10, 208, 130, 'mf-s1', 8);
      var tasks = ['Stage set up', 'Sound check', 'Florals placed', 'Crew briefed', 'Doors open'];
      for (var i = 0; i < tasks.length; i++) {
        var y = 22 + i * 23;
        rect(g, 28, y, 14, 14, 'mf-s2', 3);
        var tick = s('path', { d: 'M31 ' + (y + 7) + 'l3 4 6-8', 'class': 'mf-tick mf-a-tick', 'data-i': String(i) }, g);
        tick.setAttribute('aria-hidden', 'true');
        txt(g, 50, y + 11, tasks[i]);
      }
    },
    money: function (g) {
      var h = [56, 80, 44, 96, 70];
      for (var i = 0; i < h.length; i++) {
        var b = rect(g, 24 + i * 34, 128 - h[i], 22, h[i], i === 3 ? 'mf-acc mf-a-bar' : 'mf-s2 mf-a-bar', 3);
        b.setAttribute('data-i', String(i));
      }
      s('line', { x1: 16, y1: 128, x2: 196, y2: 128, 'class': 'mf-ln' }, g);
      rect(g, 150, 12, 80, 34, 'mf-s1', 6);
      txt(g, 158, 26, 'Profit', 'mf-tx mf-tx-s');
      txt(g, 158, 40, '+₹84,500', 'mf-tx mf-tx-b mf-acc-t');
    },
    analytics: function (g) {
      rect(g, 12, 10, 216, 130, 'mf-s1', 8);
      for (var i = 0; i < 4; i++) s('line', { x1: 24, y1: 36 + i * 24, x2: 216, y2: 36 + i * 24, 'class': 'mf-gl' }, g);
      var clip = s('g', { 'class': 'mf-a-draw' }, g);
      s('path', { d: 'M24 116 L60 98 L96 104 L132 72 L168 80 L208 40', 'class': 'mf-line' }, clip);
      s('circle', { cx: 208, cy: 40, r: 4, 'class': 'mf-acc' }, clip);
      txt(g, 24, 26, 'Profit per event', 'mf-tx mf-tx-s');
    },
    team: function (g) {
      var msgs = [[16, 18, 120, 'Truck leaves 6 am', 0], [104, 48, 120, 'Stage crew ready', 1], [16, 78, 132, 'Florist on site ✓', 0], [92, 108, 132, 'Great, opening doors', 1]];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var b = s('g', { 'class': 'mf-a-bub', 'data-i': String(i) }, g);
        rect(b, m[0], m[1], m[2], 24, m[4] ? 'mf-acc' : 'mf-s1', 10);
        txt(b, m[0] + 10, m[1] + 16, m[3], m[4] ? 'mf-tx mf-tx-inv' : 'mf-tx');
      }
    },
    client: function (g) {
      rect(g, 84, 4, 72, 142, 'mf-s1', 12);
      rect(g, 90, 14, 60, 120, 'mf-s2', 4);
      var pages = s('g', { 'class': 'mf-a-pages' }, g);
      rect(pages, 94, 20, 52, 34, 'mf-acc', 3);
      txt(pages, 98, 66, 'Your event', 'mf-tx mf-tx-s');
      rect(pages, 98, 74, 44, 6, 'mf-s1', 2);
      rect(pages, 98, 86, 36, 6, 'mf-s1', 2);
      rect(pages, 98, 108, 44, 16, 'mf-acc', 8);
      txt(pages, 106, 119, 'Approve', 'mf-tx mf-tx-s mf-tx-inv');
    }
  };

  function fmtINR(n) {
    var s0 = String(Math.round(n)), last3 = s0.slice(-3), rest = s0.slice(0, -3);
    if (rest) last3 = ',' + last3;
    return '₹' + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  }

  function build(host) {
    var kind = host.getAttribute('data-mf');
    if (!builders[kind] || host.firstChild) return;
    var svg = s('svg', { viewBox: '0 0 240 150', 'class': 'mf-svg', 'aria-hidden': 'true', focusable: 'false' });
    builders[kind](s('g', {}, svg));
    host.appendChild(svg);
  }

  function play(card, on) {
    if (reduce) return;
    if (on === card.classList.contains('mf-play')) return;
    card.classList.toggle('mf-play', on);
    var t = card.querySelector('[data-mf-total]');
    if (!t) return;
    var end = Number(t.getAttribute('data-mf-total'));
    if (card._mfTimer) { clearInterval(card._mfTimer); card._mfTimer = 0; }
    if (!on) { t.textContent = fmtINR(end); return; }
    var start = Date.now();
    card._mfTimer = setInterval(function () {
      var p = Math.min(1, ((Date.now() - start) % 3200) / 1600);
      t.textContent = fmtINR(end * p);
    }, 60);
  }

  function init() {
    var cards = document.querySelectorAll('.mf-card');
    var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
      for (var i = 0; i < es.length; i++) if (!es[i].isIntersecting) play(es[i].target, false);
    }) : null;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i], host = card.querySelector('.mf-screen');
      if (host) build(host);
      if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
      (function (c) {
        c.addEventListener('mouseenter', function () { play(c, true); });
        c.addEventListener('mouseleave', function () { play(c, false); });
        c.addEventListener('focusin', function () { c._mfF = Date.now(); play(c, true); });
        c.addEventListener('focusout', function (e) { if (!c.contains(e.relatedTarget)) play(c, false); });
        c.addEventListener('click', function (e) {
          if ((e.target.closest && e.target.closest('a')) || Date.now() - (c._mfF || 0) < 400) return;
          if (window.matchMedia && window.matchMedia('(hover: none)').matches) play(c, !c.classList.contains('mf-play'));
        });
      })(card);
      if (io) io.observe(card);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
