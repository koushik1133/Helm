/* legal.js - footer year, reading-progress bar, table-of-contents scroll-spy and section reveal
   for the public legal pages. No innerHTML; transform/opacity only; honours prefers-reduced-motion. */
(function () {
  'use strict';
  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  ready(function () {
    var yr = document.getElementById('yr');
    if (yr) yr.textContent = String(new Date().getFullYear());

    var nav = document.querySelector('.nav');
    if (nav) {
      var navTick = false;
      var navUpd = function () { navTick = false; nav.classList.toggle('scrolled', window.scrollY > 8); };
      window.addEventListener('scroll', function () { if (!navTick) { navTick = true; requestAnimationFrame(navUpd); } }, { passive: true });
      navUpd();
    }

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var sections = Array.prototype.slice.call(document.querySelectorAll('.lg-doc section[id]'));
    var links = {};
    Array.prototype.forEach.call(document.querySelectorAll('.lg-toc a[href^="#"]'), function (a) {
      links[a.getAttribute('href').slice(1)] = a;
    });

    if (!('IntersectionObserver' in window)) return;

    if (!reduce) {
      document.documentElement.classList.add('lg-js');
      var rev = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-in'); rev.unobserve(e.target); } });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.02 });
      sections.forEach(function (s) { rev.observe(s); });

      var bar = document.querySelector('.lg-progress');
      if (bar) {
        var ticking = false;
        var update = function () {
          ticking = false;
          var h = document.documentElement.scrollHeight - window.innerHeight;
          var p = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
          bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
        };
        window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
        update();
      }
    }

    var current = null;
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var a = links[e.target.id];
        if (!a || a === current) return;
        if (current) { current.classList.remove('is-active'); current.removeAttribute('aria-current'); }
        a.classList.add('is-active'); a.setAttribute('aria-current', 'true'); current = a;
      });
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { spy.observe(s); });
  });
})();
