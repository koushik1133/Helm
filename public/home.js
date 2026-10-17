/* Helm demo 9 — vanilla JS, CSP-safe (no inline styles in markup; CSSOM only). */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer:fine)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var ease = function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };  // easeInOutCubic
  var vh = window.innerHeight, vw = window.innerWidth;
  window.addEventListener('resize', function () { vh = window.innerHeight; vw = window.innerWidth; layoutTiles(); }, { passive: true });
  requestAnimationFrame(function () { document.body.classList.add('loaded'); });

  /* ---------- nav: mega menus, mobile sheet, sticky glass ---------- */
  var nav = $('.nav'), burger = $('.burger'), menu = $('#menu');
  var megas = $$('.has-mega');
  var mobile = function () { return window.innerWidth < 1024; };
  function closeMegas(except) {
    megas.forEach(function (li) {
      if (li === except) return;
      li.classList.remove('open');
      $('.mlink', li).setAttribute('aria-expanded', 'false');
    });
  }
  megas.forEach(function (li) {
    var btn = $('.mlink', li), t = null;
    btn.addEventListener('click', function () {
      var open = !li.classList.contains('open');
      closeMegas(li);
      li.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    if (finePointer) {
      li.addEventListener('mouseenter', function () { if (mobile()) return; clearTimeout(t); closeMegas(li); li.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); });
      li.addEventListener('mouseleave', function () { if (mobile()) return; t = setTimeout(function () { li.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }, 160); });
    }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.has-mega')) closeMegas(); });
  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    nav.classList.toggle('menu-open', open);
    document.body.classList.toggle('lock', open);
    if (!open) closeMegas();
  }
  burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
  menu.addEventListener('click', function (e) { if (e.target.closest('a')) { setMenu(false); closeMegas(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setMenu(false); closeMegas(); } });
  window.addEventListener('resize', function () { if (!mobile() && nav.classList.contains('menu-open')) setMenu(false); }, { passive: true });

  /* ---------- reveal ---------- */
  var rvs = $$('.rv');
  if (reduce || !('IntersectionObserver' in window)) rvs.forEach(function (el) { el.classList.add('in'); });
  else {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    rvs.forEach(function (el) {
      var i = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty('transition-delay', Math.min(i, 6) * 60 + 'ms');
      io.observe(el);
    });
  }

  /* ---------- mobile carousels: grids become swipe rows under 768px (CSS); give them a tab stop
     and a region role only while they scroll, so desktop grids add no extra stops ---------- */
  var snapMq = window.matchMedia('(max-width: 767px)');
  function snapA11y() {
    $$('.snap').forEach(function (el) {
      if (snapMq.matches) {
        el.setAttribute('tabindex', '0');
        if (!el.getAttribute('role')) { el.setAttribute('role', 'region'); el.dataset.snapRole = '1'; }
        if (el.getAttribute('aria-label') && !/swipe/.test(el.getAttribute('aria-label'))) el.setAttribute('aria-label', el.getAttribute('aria-label') + ' (swipe or use arrow keys)');
        $$('.rv', el).forEach(function (c) { c.classList.add('in'); });
      } else {
        el.removeAttribute('tabindex');
        if (el.dataset.snapRole) { el.removeAttribute('role'); delete el.dataset.snapRole; }
        if (el.getAttribute('aria-label')) el.setAttribute('aria-label', el.getAttribute('aria-label').replace(' (swipe or use arrow keys)', ''));
      }
    });
  }
  snapA11y();
  if (snapMq.addEventListener) snapMq.addEventListener('change', snapA11y);

  /* ---------- mobile sticky CTA: shows once the hero is gone, hides over the final CTA ---------- */
  var mcta = $('#mcta'), heroEl = $('.hero'), finEl = $('.final');
  if (mcta && heroEl && 'IntersectionObserver' in window) {
    var heroIn = true, finIn = false;
    var paintCta = function () { var on = !heroIn && !finIn; mcta.classList.toggle('on', on); document.body.classList.toggle('has-mcta', on); };
    new IntersectionObserver(function (es) { heroIn = es[0].isIntersecting; paintCta(); }).observe(heroEl);
    if (finEl) new IntersectionObserver(function (es) { finIn = es[0].isIntersecting; paintCta(); }).observe(finEl);
  }

  /* ---------- lazy, offscreen-paused videos ---------- */
  var userPaused = reduce;
  function loadV(v) {
    if (v.dataset.ok) return;
    // same-origin path only: no scheme, no protocol-relative //host, path characters only
    $$('source[data-src]', v).forEach(function (s) { s.src = '/' + String(s.getAttribute('data-src') || '').replace(/^\/+/, '').replace(/[^A-Za-z0-9_\-.\/]/g, ''); });
    v.dataset.ok = '1'; v.load();
  }
  function tryPlay(v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  var vio = ('IntersectionObserver' in window) ? new IntersectionObserver(function (ents) {
    ents.forEach(function (en) {
      var v = en.target;
      if (en.isIntersecting) { loadV(v); if (!userPaused) tryPlay(v); } else if (!v.paused) v.pause();
    });
  }, { rootMargin: '200px 0px' }) : null;
  $$('video.lazyv').forEach(function (v) { if (vio) vio.observe(v); else loadV(v); });

  /* ---------- optional owner assets (manifest avoids 404s) ---------- */
  var heroVideo = $('#heroVideo'), heroVidWrap = $('#heroVidWrap');
  /* HQ film (1920x1080) on >=1024px screens unless Save-Data; light 1600px encode otherwise. */
  var heroConn = navigator.connection || {};
  var heroHQ = !!(window.matchMedia && window.matchMedia('(min-width: 1024px)').matches) && !heroConn.saveData;
  var heroPosterSrc = heroHQ ? '/home-assets/hero-hq-poster.jpg' : '/home-assets/hero-poster.jpg';
  if (heroVideo && heroHQ) {
    $$('source[data-src]', heroVideo).forEach(function (s) {
      s.setAttribute('data-src', s.getAttribute('data-src').replace('/hero.', '/hero-hq.'));
    });
  }
  Promise.resolve(window.DEMO9_MANIFEST || {}).then(function (m) {
    if (m.heroVideo && heroVideo && !reduce) {
      if (m.heroPoster) heroVideo.poster = heroPosterSrc;
      if (!m.heroWebm) { var w = $('source[type="video/webm"]', heroVideo); if (w) w.remove(); }
      heroVidWrap.hidden = false;
      heroFilm();
    } else if (m.heroVideo && heroVideo && reduce) {
      if (m.heroPoster) heroVideo.poster = heroPosterSrc;
      if (!m.heroWebm) { var w2 = $('source[type="video/webm"]', heroVideo); if (w2) w2.remove(); }
      heroVidWrap.hidden = false;
      heroFilm();
    }
  });

  /* ---------- hero film: scroll-expand, captions, chapters, chips ---------- */
  function heroFilm() {
    var card = $('#hvCard'), capEl = $('#hvCap'), capSpan = capEl && capEl.firstElementChild, prog = $('#hvProg'), btn = $('#hvPlay');
    var copy = $('.hero-copy'), chips = $$('.hv-chip', heroVidWrap);
    var CAPS = ['Plans on paper. Measurements guessed.', 'Chats, spreadsheets, an unhappy client.', 'Meet Helm \u2014 every event in one calm place.', 'Precise 2D plans, instantly in 3D.', 'Proposals clients approve in one tap.', 'Run the day. See the profit.'];
    var segs = CAPS.map(function (c, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'hv-seg';
      b.setAttribute('aria-label', 'Chapter ' + (i + 1) + ': ' + c);
      b.appendChild(document.createElement('b'));
      b.addEventListener('click', function () {
        loadV(heroVideo);
        var d = heroVideo.duration;
        if (d && isFinite(d)) heroVideo.currentTime = d * i / 6 + 0.05;
        else heroVideo.addEventListener('loadedmetadata', function () { heroVideo.currentTime = heroVideo.duration * i / 6 + 0.05; }, { once: true });
        setCap(i, true);
      });
      prog.appendChild(b); return b;
    });
    var curCh = -1, capT = 0;
    function setCap(i, force) {
      if (i === curCh && !force) return;
      var first = curCh < 0; curCh = i;
      clearTimeout(capT);
      if (reduce || first) { capSpan.textContent = CAPS[i]; return; }
      capEl.classList.add('out');
      capT = setTimeout(function () {
        capSpan.textContent = CAPS[i];
        capEl.classList.remove('out'); capEl.classList.add('pre');
        void capSpan.offsetWidth;
        capEl.classList.remove('pre');
      }, 260);
    }
    setCap(0);
    var lastF = [];
    function syncTime() {
      var d = heroVideo.duration;
      if (!d || !isFinite(d)) return;
      var t = heroVideo.currentTime, len = d / 6, ch = Math.min(5, Math.floor(t / len));
      setCap(ch);
      segs.forEach(function (s, k) {
        var f = k < ch ? 1 : k > ch ? 0 : (t - ch * len) / len;
        f = Math.round(f * 200) / 200;
        if (lastF[k] !== f) { lastF[k] = f; s.style.setProperty('--f', f); }
      });
    }
    heroVideo.addEventListener('timeupdate', syncTime);
    heroVideo.addEventListener('seeked', syncTime);

    /* play / pause */
    var heroUserPaused = reduce, heroVisible = false;
    function setBtn() {
      var paused = heroUserPaused;
      btn.setAttribute('aria-pressed', String(paused));
      btn.setAttribute('aria-label', paused ? 'Play film' : 'Pause film');
    }
    setBtn();
    btn.addEventListener('click', function () {
      heroUserPaused = !heroUserPaused; setBtn();
      if (heroUserPaused) heroVideo.pause(); else { loadV(heroVideo); tryPlay(heroVideo); }
    });
    heroVideo.muted = true;
    if (!reduce) {
      heroVideo.addEventListener('loadeddata', function () { if (heroVisible && !heroUserPaused) tryPlay(heroVideo); }, { once: true });
      loadV(heroVideo);
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (ents) {
        ents.forEach(function (en) {
          heroVisible = en.isIntersecting;
          if (heroVisible) { if (!heroUserPaused) { loadV(heroVideo); tryPlay(heroVideo); } }
          else if (!heroVideo.paused) heroVideo.pause();
        });
      }, { threshold: 0.15 }).observe(card);
    } else { heroVisible = true; }
    if (reduce) { capSpan.textContent = CAPS[0]; return; }

    /* scroll-scrubbed expand + parallax + chips (lerped rAF) */
    var mq = window.matchMedia('(max-width:640px)');
    var target = 0, cur = 0, raf = 0, vh = window.innerHeight, navh = 72;
    var last = {};
    function setVar(el, key, name, v) { if (last[key] !== v) { last[key] = v; el.style.setProperty(name, v); } }
    function measure() {
      var r = heroVidWrap.getBoundingClientRect();
      vh = window.innerHeight;
      if (mq.matches) {
        target = Math.max(0, Math.min(1, (vh - r.top) / (vh * 0.6)));
      } else {
        // 0 while the film sits below the hero copy; 1 when the track reaches the sticky point
        var start = vh * 0.7, end = navh;
        target = Math.max(0, Math.min(1, (start - r.top) / (start - end)));
      }
    }
    function ease(x) { return 1 - Math.pow(1 - x, 3); }
    function render() {
      raf = 0;
      cur += (target - cur) * 0.12;
      if (Math.abs(target - cur) < 0.0005) cur = target;
      var e = ease(cur), mob = mq.matches;
      var s = mob ? 0.9 + 0.1 * e : 0.74 + 0.26 * e;
      setVar(card, 's', '--s', s.toFixed(4));
      if (!mob) {
        setVar(card, 'rx', '--rx', (6 * (1 - e)).toFixed(2) + 'deg');
        setVar(card, 'r', '--r', Math.round(32 - 20 * e) + 'px');
        if (copy) {
          setVar(copy, 'cy', 'transform', 'translate3d(0,' + (-60 * e).toFixed(1) + 'px,0)');
          setVar(copy, 'co', 'opacity', (1 - 0.35 * e).toFixed(3));
        }
        chips.forEach(function (c, k) {
          var p = Math.max(0, Math.min(1, (cur - 0.25 - k * 0.12) / 0.4));
          var pe = ease(p);
          setVar(c, 'o' + k, '--o', pe.toFixed(3));
          setVar(c, 'y' + k, '--y', (40 * (1 - pe)).toFixed(1) + 'px');
        });
      }
      if (cur !== target) raf = requestAnimationFrame(render);
    }
    function onScroll() { measure(); if (!raf) raf = requestAnimationFrame(render); }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    if (mq.addEventListener) mq.addEventListener('change', function () {
      if (copy) { copy.style.removeProperty('transform'); copy.style.removeProperty('opacity'); }
      last = {}; onScroll();
    });
    onScroll();
  }

  /* ---------- tool map tabs ---------- */
  var mtabs = $$('.tabs [data-f]'), rows = $$('.mrow[data-g]');
  mtabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var f = t.dataset.f;
      mtabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
      rows.forEach(function (r) { r.classList.toggle('off', f !== 'all' && r.dataset.g !== f); });
    });
  });

  /* ---------- contact form -> mailto (nothing sent from page) ---------- */
  var form = $('#ctForm');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = form.name.value.trim(), m = form.msg.value.trim(), err = $('#cfErr');
    if (!n || !m) { err.textContent = 'Please add your name and a short message.'; return; }
    err.textContent = '';
    var body = 'Name: ' + n + '\nStudio: ' + form.studio.value.trim() + '\n\n' + m;
    window.location.href = 'mailto:sales@helm.events?subject=' + encodeURIComponent('Helm: ' + form.topic.value) + '&body=' + encodeURIComponent(body);
  });

  /* ---------- converge tiles: ring positions ---------- */
  var field = $('#field'), tiles = $$('.tile'), core = $('.core', field), tilePos = [];
  function layoutTiles() {
    if (!field) return;
    var w = field.clientWidth, h = field.clientHeight, n = tiles.length;
    var rx = Math.min(w * 0.42, 540), ry = Math.min(h * 0.44, 300);
    if (w < 640) {                                         // phones: two tidy columns
      var rowsN = Math.ceil(n / 2), gapY = (h - 40) / rowsN;
      tilePos = tiles.map(function (t, i) {
        var col = i % 2, row = Math.floor(i / 2);
        return { x: (col ? 1 : -1) * w * 0.245, y: -h / 2 + 20 + gapY * (row + 0.5), r: (i % 3 - 1) * 2 };
      });
      return;
    }
    var outer = Math.min(n, 10), inner = n - outer;
    tilePos = tiles.map(function (t, i) {
      var isOut = i < outer, k = isOut ? i : i - outer, m = isOut ? outer : inner;
      var a = ((k + (isOut ? 0 : 0.5)) / m) * Math.PI * 2 - Math.PI / 2;
      var j = isOut ? 1 : 0.55;
      var tw = t.offsetWidth / 2, th = t.offsetHeight / 2;
      var x = clamp(Math.cos(a) * rx * j, -w / 2 + tw + 4, w / 2 - tw - 4);
      var y = clamp(Math.sin(a) * ry * j, -h / 2 + th, h / 2 - th);
      return { x: x, y: y, r: (i % 5 - 2) * 3 };
    });
  }
  layoutTiles();

  /* ---------- one rAF loop: nav state, converge, morph, lerped parallax ---------- */
  var apps = $('#converge'), morph = $('#morph'), mimgs = [$('.mx0'), $('.mx1'), $('.mx2'), $('.mx3')], mstages = $$('#mstages li'), mframe = $('#morph .mframe');
  var mbar = $('#mbar'), mtag = $('#mtag'), mNames = ['2D plan', '3D view', 'Photo render', 'Measure'];
  var heroLayers = [];
  var lerpEls = reduce ? [] : $$('[data-lerp]').map(function (el) { return { el: el, k: parseFloat(el.dataset.lerp), cur: 0 }; });
  var phStage = $('#phStage');
  var lastY = -1, lastStage = -1, mx = 0, my = 0, tmx = 0, tmy = 0, appsP = -1, morphP = -1;

  if (heroLayers.length) {
    heroStage && heroStage.addEventListener('pointermove', function (e) { var r = heroStage.getBoundingClientRect(); tmx = (e.clientX - r.left) / r.width - .5; tmy = (e.clientY - r.top) / r.height - .5; });
    heroStage.addEventListener('pointerleave', function () { tmx = 0; tmy = 0; });
  }
  function progress(el) { var r = el.getBoundingClientRect(), span = r.height - vh; return span > 0 ? clamp(-r.top / span, 0, 1) : 0; }
  function setStage(i) {
    if (i === lastStage) return; lastStage = i;
    mstages.forEach(function (li, k) { li.classList.toggle('on', k === i); });
    $$('#mseg button').forEach(function (b, k) { b.setAttribute('aria-pressed', String(k === i)); });
    if (mtag) mtag.textContent = mNames[i];
    if (mframe) mframe.classList.toggle('is-measure', i === 3);
  }
  function showView(k) { mimgs.forEach(function (im, j) { if (j && im) im.style.setProperty('opacity', j <= k ? '1' : '0'); }); var v = $('.mx1v'); if (v) v.style.setProperty('opacity', k >= 1 ? '1' : '0'); setStage(k); }
  $$('#mseg button').forEach(function (b, k) {
    b.addEventListener('click', function () {
      if (reduce || !morph) { showView(k); return; }
      var top = morph.getBoundingClientRect().top + window.scrollY, span = morph.offsetHeight - vh;
      var q = [0.04, 0.38, 0.66, 0.96][k];
      window.scrollTo({ top: top + span * q, behavior: 'smooth' });
    });
  });

  /* perf: the loop only runs while something is moving (scroll, resize, lerp settling,
     phone drift on screen). Idle frames no longer call getBoundingClientRect 60x/sec. */
  var running = false, busy = false, phVis = false;
  function kick() { if (!running) { running = true; requestAnimationFrame(frame); } }
  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', function () { lastY = -1; appsP = -1; morphP = -1; kick(); }, { passive: true });
  if (phStage && 'IntersectionObserver' in window) new IntersectionObserver(function (es) { phVis = es[0].isIntersecting; if (phVis) kick(); }, { rootMargin: '200px 0px' }).observe(phStage);
  else phVis = true;
  function frame() {
    var y = window.scrollY, moved = y !== lastY;
    busy = false;
    if (moved) {
      nav.classList.toggle('scrolled', y > 10);
      lastY = y;
    }
    if (!reduce) {
      if (moved || appsP < 0) { filmFrame(); storyFrame(); }
      speedFrame();
      /* converge */
      if (apps && core && (moved || appsP < 0)) {
        var p = progress(apps);
        if (Math.abs(p - appsP) > 0.0005) {
          appsP = p;
          var e = ease(clamp((p - 0.08) / 0.72, 0, 1));
          tiles.forEach(function (t, i) {
            var tp = tilePos[i]; if (!tp) return;
            var d = clamp(e * 1.15 - i * 0.012, 0, 1);
            t.style.setProperty('transform', 'translate(-50%,-50%) translate3d(' + (tp.x * (1 - d)).toFixed(1) + 'px,' + (tp.y * (1 - d)).toFixed(1) + 'px,0) rotate(' + (tp.r * (1 - d)).toFixed(2) + 'deg) scale(' + (1 - d * 0.7).toFixed(3) + ')');
            t.style.setProperty('opacity', (1 - clamp((d - 0.75) / 0.25, 0, 1)).toFixed(3));
          });
          core.style.setProperty('transform', 'scale(' + (0.6 + e * 0.55).toFixed(3) + ')');
          core.style.setProperty('opacity', vw < 640 ? clamp(e * 2.2, 0, 1).toFixed(3) : '1');
        }
      }
      /* morph 2D -> 3D -> photo render -> measure */
      if (morph && (moved || morphP < 0)) {
        var q = progress(morph);
        if (Math.abs(q - morphP) > 0.0005) {
          morphP = q;
          var a = ease(clamp((q - 0.1) / 0.18, 0, 1)), b = ease(clamp((q - 0.42) / 0.16, 0, 1)), c = ease(clamp((q - 0.7) / 0.16, 0, 1));
          // every view settles at scale(1) exactly, so the visible image is never resampled (no blur)
          mimgs[0].style.setProperty('transform', 'scale(' + (1 + a * 0.04).toFixed(4) + ')');
          mimgs[1].style.setProperty('opacity', a.toFixed(3));
          mimgs[1].style.setProperty('transform', a >= 1 && b <= 0 ? 'none' : 'scale(' + (1.06 - a * 0.06 + b * 0.03).toFixed(4) + ')');
          var mv = $('.mx1v'); if (mv) { mv.style.setProperty('opacity', a.toFixed(3)); mv.style.setProperty('transform', mimgs[1].style.getPropertyValue('transform')); }
          if (mimgs[2]) { mimgs[2].style.setProperty('opacity', b.toFixed(3)); mimgs[2].style.setProperty('transform', b >= 1 ? 'none' : 'scale(' + (1.06 - b * 0.06).toFixed(4) + ')'); }
          if (mimgs[3]) { mimgs[3].style.setProperty('opacity', c.toFixed(3)); mimgs[3].style.setProperty('transform', c >= 1 ? 'none' : 'scale(' + (1.06 - c * 0.06).toFixed(4) + ')'); }
          if (mbar) mbar.style.setProperty('transform', 'scaleX(' + q.toFixed(4) + ')');
          setStage(q < 0.3 ? 0 : q < 0.56 ? 1 : q < 0.82 ? 2 : 3);
        }
      }
      /* hero pointer depth (lerped) */
      if (heroLayers.length) {
        mx += (tmx - mx) * 0.08; my += (tmy - my) * 0.08;
        if (Math.abs(tmx - mx) > 0.0005 || Math.abs(tmy - my) > 0.0005 || mx || my) heroLayers.forEach(function (el) {
          var d = parseFloat(el.dataset.depth);
          el.style.setProperty('translate', (mx * d * 28).toFixed(2) + 'px ' + (my * d * 22).toFixed(2) + 'px');
        });
      }
      /* phone section: lerped scroll parallax + idle drift */
      if (lerpEls.length && phStage && phVis) {
        var r = phStage.getBoundingClientRect();
        if (r.bottom > -200 && r.top < vh + 200) {
          var center = (r.top + r.height / 2 - vh / 2), t = performance.now() / 1000, small = vw < 768;
          if (!small) busy = true;
          lerpEls.forEach(function (o, i) {
            var target = small ? 0 : center * o.k;
            o.cur += (target - o.cur) * 0.09;
            var drift = small ? 0 : Math.sin(t * 0.6 + i * 1.7) * 6;
            o.el.style.setProperty('transform', 'translate3d(0,' + (o.cur + drift).toFixed(2) + 'px,0)');
          });
        }
      }
    }
    if (moved || busy) requestAnimationFrame(frame); else running = false;
  }
  kick();

  /* ================= v2 additions ================= */

  /* ---------- film: scroll-scrubbed end-to-end story ---------- */
  var film = $('#film'), fcs = $$('.fc'), fscr = $$('.sc-p'), frail = $$('#filmRail li');
  var fbar = $('#filmBar'), devStep = $('#devStep'), dzImgs = $$('#dz .dz-i');
  var dsg = [$('#dsg0'), $('#dsg1'), $('#dsg2')];
  var fNames = ['Leads', 'Proposal', 'Layout', 'Quote', 'Crew', 'Live', 'Closure'];
  var fIdx = -1, dsgIdx = -1, dsgTimer = null;
  function setDesign(k) {
    if (k === dsgIdx) return; dsgIdx = k;
    dsg.forEach(function (d, j) { if (d) d.classList.toggle('on', j === k); });
    dzImgs.forEach(function (im, j) { im.classList.toggle('on', j === k); });
  }
  function setFilm(i) {
    if (i === fIdx) return; fIdx = i;
    fcs.forEach(function (el, k) { el.classList.toggle('on', k === i); el.classList.toggle('past', k < i); el.setAttribute('aria-hidden', String(k !== i)); });
    fscr.forEach(function (el, k) { el.classList.toggle('on', k === i); });
    frail.forEach(function (el, k) { el.classList.toggle('on', k === i); el.classList.toggle('past', k < i); $('i', el).style.setProperty('--f', k <= i ? '1' : '0'); });
    if (devStep) devStep.textContent = fNames[i];
    if (fbar) fbar.style.setProperty('transform', 'scaleX(' + ((i + 1) / fcs.length).toFixed(4) + ')');
    film.setAttribute('data-c', String(i));
    clearInterval(dsgTimer); dsgTimer = null; setDesign(0);
    if (i === 2) dsgTimer = setInterval(function () { setDesign((dsgIdx + 1) % 3); }, 1700);
  }
  function filmFrame() {
    if (!film) return;
    var p = progress(film), n = fcs.length;
    setFilm(Math.min(n - 1, Math.floor(p * n * 0.9999)));
  }
  if (reduce && film) { fcs.forEach(function (el) { el.classList.add('on'); }); }

  /* ---------- story: pinned horizontal slider, one stage per scroll step ---------- */
  var story = $('#story'), svTrack = $('#svTrack'), sls = $$('.sl'), svDots = $$('#svDots button');
  var recRows = $$('#recRows li'), recSt = $('#recSt'), recBar = $('#recBar'), svCount = $('#svCount');
  var stNames = ['Lead', 'Layout', 'Quote', 'Run', 'Settled'], sIx = -1;
  function setStory(i) {
    if (i === sIx) return; sIx = i;
    if (svTrack && !reduce) svTrack.style.setProperty('transform', 'translate3d(' + (-i * 100) + '%,0,0)');
    sls.forEach(function (el, k) { el.classList.toggle('on', k === i); if (!reduce) el.setAttribute('aria-hidden', String(k !== i)); });
    svDots.forEach(function (b, k) { if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    recRows.forEach(function (li, k) { li.classList.toggle('on', k <= i); li.classList.toggle('cur', k === i); });
    if (recSt) recSt.textContent = stNames[i];
    if (recBar) recBar.style.setProperty('transform', 'scaleX(' + ((i + 1) / sls.length).toFixed(3) + ')');
    if (svCount) svCount.textContent = (i + 1) + ' / ' + sls.length;
  }
  function storyFrame() {
    if (!story) return;
    var p = progress(story);
    setStory(Math.min(sls.length - 1, Math.floor(p * sls.length * 0.999 + 0.0001)));
  }
  svDots.forEach(function (b, k) {
    b.addEventListener('click', function () {
      if (reduce) { setStory(k); return; }
      var top = story.getBoundingClientRect().top + window.scrollY, span = story.offsetHeight - vh;
      window.scrollTo({ top: top + span * (k + 0.5) / sls.length, behavior: 'smooth' });
    });
  });
  setStory(0);

  /* ---------- word-by-word heading reveal ---------- */
  function splitWords(node, counter) {
    Array.prototype.slice.call(node.childNodes).forEach(function (c) {
      if (c.nodeType === 3) {
        var parts = c.textContent.split(/(\s+)/), frag = document.createDocumentFragment();
        parts.forEach(function (w) {
          if (!w) return;
          if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(' ')); return; }
          var o = document.createElement('span'), i = document.createElement('span');
          o.className = 'w'; i.textContent = w; i.style.setProperty('--i', String(counter.n++));
          o.appendChild(i); frag.appendChild(o);
        });
        node.replaceChild(frag, c);
      } else if (c.nodeType === 1 && c.tagName !== 'BR') splitWords(c, counter);
    });
  }
  if (!reduce) $$('h2.h2.rv').forEach(function (h) { h.setAttribute('aria-label', h.textContent.replace(/\s+/g, ' ').trim()); splitWords(h, { n: 0 }); h.classList.add('sw-h'); });

  /* ---------- depth parallax on [data-speed] ---------- */
  var speedEls = reduce ? [] : $$('[data-speed]').map(function (el) { return { el: el, k: parseFloat(el.dataset.speed), cur: 0 }; });
  function speedFrame() {
    if (!speedEls.length || vw < 768) return;
    speedEls.forEach(function (o) {
      var r = o.el.parentElement.getBoundingClientRect();
      if (r.bottom < -100 || r.top > vh + 100) return;
      var target = (r.top + r.height / 2 - vh / 2) * -o.k;
      o.cur += (target - o.cur) * 0.12;
      if (Math.abs(target - o.cur) > 0.1) busy = true;
      o.el.style.setProperty('translate', '0 ' + o.cur.toFixed(2) + 'px');
    });
  }

  /* ---------- magnetic primary buttons ---------- */
  if (!reduce && finePointer) $$('.btn-dark, .btn-light').forEach(function (b) {
    b.classList.add('mag');
    b.addEventListener('pointermove', function (e) {
      var r = b.getBoundingClientRect();
      b.style.setProperty('translate', ((e.clientX - r.left - r.width / 2) * 0.18).toFixed(1) + 'px ' + ((e.clientY - r.top - r.height / 2) * 0.28).toFixed(1) + 'px');
    });
    b.addEventListener('pointerleave', function () { b.style.removeProperty('translate'); });
  });

  /* ---------- section colour transitions ---------- */
  if ('IntersectionObserver' in window) {
    var tio = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        var t = en.target.getAttribute('data-tone');
        if (en.isIntersecting) document.body.setAttribute('data-tone', t);
        else if (document.body.getAttribute('data-tone') === t) document.body.removeAttribute('data-tone');
      });
    }, { rootMargin: '-45% 0px -45% 0px' });
    $$('[data-tone]').forEach(function (s) { tio.observe(s); });
  }

  /* ---------- counters (real facts only) ---------- */
  var cnts = $$('[data-count]');
  if (!reduce && 'IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return; cio.unobserve(en.target);
        var el = en.target, to = +el.getAttribute('data-count'), t0 = performance.now();
        (function tick(now) { var k = clamp((now - t0) / 1400, 0, 1); el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(tick); })(t0);
      });
    }, { threshold: 0.6 });
    cnts.forEach(function (el) { el.textContent = '0'; cio.observe(el); });
  }
}());

/* ================= Stage 2: vignettes, tool flip cards, celebrations ================= */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function icon(id) { var s = document.createElementNS(NS, 'svg'); s.setAttribute('aria-hidden', 'true'); var u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; }

  /* play looping vignettes only while in view */
  var playIO = ('IntersectionObserver' in window) ? new IntersectionObserver(function (ents) {
    ents.forEach(function (en) { en.target.classList.toggle('play', en.isIntersecting); });
  }, { threshold: 0.15 }) : null;
  function watchPlay(node) { if (reduce) return; if (playIO) playIO.observe(node); else node.classList.add('play'); }
  $$('.vig').forEach(watchPlay);

  /* ---------- tool flip cards: add a row here to add a tool ---------- */
  var AREAS = { sales: 'Sales', design: 'Design', money: 'Money', ops: 'Ops & team', client: 'Client' };
  var TOOLS = [
    { n: 'Paper diary', i: 'i-book', g: 'sales', a: 'paper', p: 'Enquiries scribbled down, crossed out, lost — nobody owns the follow-up.', f: 'Leads pipeline', s: 'Every enquiry lands in one pipeline with an owner and a follow-up reminder.', sv: { t: 'rows', r: [['Priya · wedding', 'New'], ['Arjun · gala', 'Called'], ['Mira · launch', 'Follow up']] } },
    { n: 'Phone calls', i: 'i-phone', g: 'sales', a: 'ring', p: 'What the client asked for is never written down.', f: 'Discovery notes', s: 'Call notes and the full client history sit on the event record.', sv: { t: 'rows', r: [['300 guests, garden', 'Noted'], ['Stage near the lawn', 'Noted'], ['Budget agreed', 'Noted']] } },
    { n: 'Printed PDF quotes', i: 'i-pdf', g: 'sales', a: 'stack', p: 'Out of date the moment the client changes their mind.', f: 'Quote versions', s: 'Revise the quote and compare versions side by side — nothing reprinted.', sv: { t: 'rows', r: [['Version A', '$18,400'], ['Version B', '$16,950'], ['Sent to client', 'B']] } },
    { n: 'Excel / Sheets', i: 'i-sheet', g: 'money', a: 'grid', p: 'quote_FINAL_v7 — versions multiply and formulas break.', f: 'Live quote', s: 'The quote updates itself as you design the layout and pick packages.', sv: { t: 'total', r: [['Decor', 4200], ['Catering', 9850], ['Lighting', 2300]], tot: 'Total' } },
    { n: 'Calculator', i: 'i-calc', g: 'money', a: 'calc', p: 'Totals retyped by hand; tax lines forgotten.', f: 'Live pricing', s: 'Prices, quantities and your tax rules add up automatically.', sv: { t: 'total', r: [['Subtotal', 14800], ['Tax 8%', 1184], ['Discount', -500]], tot: 'Due' } },
    { n: 'Accounting books', i: 'i-ledger', g: 'money', a: 'grid', p: 'Profit per event worked out weeks later, if at all.', f: 'Settlement & P&L', s: 'Close each event with a settlement and a clear profit-and-loss.', sv: { t: 'total', r: [['Revenue', 24000], ['Vendor costs', -13600], ['Crew', -3100]], tot: 'Profit' } },
    { n: 'Bank & payment screenshots', i: 'i-upi', g: 'money', a: 'stack', p: 'Proof of payment scattered across chats and camera rolls.', f: 'Payment milestones', s: 'Advance, part and final payments tracked against the event, with receipts.', sv: { t: 'rows', r: [['Advance', '$5,000'], ['Part payment', '$8,000'], ['Final', '$6,500']], ok: 'Received' } },
    { n: 'CAD / SketchUp', i: 'i-cad', g: 'design', a: 'grid', p: 'A separate tool and licence that never feeds the quote.', f: '2D builder + 3D view', s: 'Draw the venue to real measurements and lift it into 3D — linked to pricing.', sv: { t: 'plan' } },
    { n: 'Drive folders', i: 'i-folder', g: 'design', a: 'stack', p: 'Renders and reference photos hunted for on event day.', f: 'Event files', s: 'Layouts, media and files live on the event, not in someone\'s drive.', sv: { t: 'rows', r: [['Layouts', '2D · 3D'], ['Renders', 'Final'], ['Contracts', 'Signed']], ic: 'i-folder' } },
    { n: 'Canva', i: 'i-brush', g: 'client', a: 'stack', p: 'Every booklet and invite rebuilt by hand for each client.', f: 'Booklet & invite site', s: 'Generate the design booklet and an invitation website from the event.', sv: { t: 'rows', r: [['Cover', 'Ready'], ['Layout pages', 'Ready'], ['Invite site', 'Live']] } },
    { n: 'Email threads', i: 'i-mail', g: 'client', a: 'chat', p: 'Proposals sent as attachments; the approval gets buried.', f: 'Client e-approval', s: 'Share a proposal link the client approves online — timestamped.', sv: { t: 'msg', m: 'Proposal for the Rao wedding is ready to review.', b: 'Approve' } },
    { n: 'WhatsApp', i: 'i-msg', g: 'ops', a: 'chat', p: 'Decisions buried under hundreds of unread messages.', f: 'Team chat per event', s: 'Conversations stay with the event, visible by role.', sv: { t: 'msg', m: 'Ravi: generator loads in at 2 pm, gate B.', b: 'Seen by crew' } },
    { n: 'Group chats for tasks', i: 'i-group', g: 'ops', a: 'chat', p: '"Who\'s bringing the generator?" — tasks with no owner.', f: 'Crew task app', s: 'Tasks are assigned, accepted and ticked off by named people.', sv: { t: 'msg', m: 'Bring the generator · Sat 2 pm · Gate B', b: 'Accept' } },
    { n: 'Sticky notes', i: 'i-sticky', g: 'ops', a: 'stack', p: 'They fall off the monitor and nobody owns them.', f: 'Tasks & run sheet', s: 'Every to-do and every time slot on one run sheet per event.', sv: { t: 'rows', r: [['Confirm florist', ''], ['Book DJ', ''], ['Load-out list', '']], ok: 'Done' } },
    { n: 'Calendar', i: 'i-cal', g: 'ops', a: 'clash', p: 'No link to crew or stock — clashes found on the day.', f: 'Resource calendar', s: 'See crew and stock across events with clash warnings before you commit.', sv: { t: 'time', r: [['Load-in', '10:00'], ['Ceremony', '17:00'], ['Load-out', '23:30']] } },
    { n: 'To-do apps', i: 'i-kanban', g: 'ops', a: 'paper', p: 'Another login, not tied to the event or the money.', f: 'Tasks on the event', s: 'Tasks, crew and stock live on the same record as the quote.', sv: { t: 'rows', r: [['Stage build', 'Ravi'], ['Florals', 'Meena'], ['Sound check', 'Sam']] } },
    { n: 'Stock registers', i: 'i-box', g: 'ops', a: 'grid', p: '80 chairs promised, 62 in the store — found out at load-in.', f: 'Inventory', s: 'Stock is reserved against each event so you know what is free.', sv: { t: 'total', r: [['Chairs owned', 80], ['Reserved here', -62], ['Other event', -10]], tot: 'Free', n: 1 } }
  ];
  var ILL = { paper: 3, grid: 16, chat: 4, ring: 2, stack: 3, clash: 21, calc: 0 };
  function buildIll(a) {
    var d = el('div', 'f-ill il-' + a); d.setAttribute('aria-hidden', 'true');
    for (var k = 0; k < ILL[a]; k++) d.appendChild(el('i'));
    if (a === 'paper' || a === 'ring') d.appendChild(el('b'));
    if (a === 'calc') { var b = el('b'), sp = el('span'); ['1,240', '1,248', '12,48?', 'ERR'].forEach(function (t) { sp.appendChild(el('em', null, t)); }); b.appendChild(sp); d.appendChild(b); }
    return d;
  }
  /* solution mini-mockups for the back of each card, driven by TOOLS[].sv */
  function money(v, n) { var a = Math.abs(Math.round(v)).toLocaleString('en-US'); return (v < 0 ? '−' : '') + (n ? a : '$' + a); }
  function buildSol(sv) {
    var d = el('div', 'ts ts-' + sv.t + (sv.t === 'rows' ? ' ts-rows' : '')); d.setAttribute('aria-hidden', 'true');
    if (sv.t === 'plan') {
      var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 200 84');
      [['rect', { x: 8, y: 10, width: 150, height: 64, rx: 3, 'class': 'pl-room' }], ['rect', { x: 20, y: 20, width: 46, height: 18, rx: 2, 'class': 'pl-it' }],
       ['circle', { cx: 100, cy: 44, r: 9, 'class': 'pl-it' }], ['circle', { cx: 132, cy: 52, r: 9, 'class': 'pl-it' }],
       ['path', { d: 'M8 80h150M8 77v6M158 77v6', 'class': 'pl-dim' }], ['path', { d: 'M166 10v64M163 10h6M163 74h6', 'class': 'pl-dim' }]].forEach(function (a) {
        var n = document.createElementNS(ns, a[0]); Object.keys(a[1]).forEach(function (k) { n.setAttribute(k, a[1][k]); }); s.appendChild(n); });
      [['24 m', 83, 83], ['12 m', 186, 46]].forEach(function (a) { var t = document.createElementNS(ns, 'text'); t.setAttribute('x', a[1]); t.setAttribute('y', a[2]); t.setAttribute('class', 'pl-tx'); t.textContent = a[0]; s.appendChild(t); });
      d.appendChild(s); return d;
    }
    if (sv.t === 'msg') {
      d.appendChild(el('p', 'ts-bub', sv.m)); var bt = el('span', 'ts-btn'); bt.appendChild(icon('i-check')); bt.appendChild(document.createTextNode(sv.b)); d.appendChild(bt); return d;
    }
    sv.r.forEach(function (r) {
      var row = el('div', 'ts-row');
      if (sv.t === 'time') row.appendChild(el('i', 'ts-dot'));
      else if (sv.ok || sv.ic) { var c = el('i', 'ts-ck'); c.appendChild(icon(sv.ic || 'i-check')); row.appendChild(c); }
      row.appendChild(el('span', null, r[0]));
      row.appendChild(el('b', null, typeof r[1] === 'number' ? money(r[1], sv.n) : (r[1] || sv.ok)));
      d.appendChild(row);
    });
    if (sv.t === 'total') {
      var sum = sv.r.reduce(function (a, r) { return a + r[1]; }, 0), tr = el('div', 'ts-row ts-tot'), out = el('b', null, money(sum, sv.n));
      out.dataset.to = sum; if (sv.n) out.dataset.n = '1';
      tr.appendChild(el('span', null, sv.tot)); tr.appendChild(out); d.appendChild(tr);
    }
    return d;
  }
  function tick(card) {
    if (reduce) return;
    $$('[data-to]', card).forEach(function (o) {
      var to = +o.dataset.to, n = !!o.dataset.n, t0 = performance.now();
      (function f(now) { var k = Math.min(1, (now - t0) / 1100), e = 1 - Math.pow(1 - k, 3); o.textContent = money(to * e, n); if (k < 1) requestAnimationFrame(f); })(t0);
    });
  }
  var flipsBox = $('#flips'), cards = [];
  if (flipsBox) {
    TOOLS.forEach(function (t, idx) {
      var c = el('div', 'flip'); c.tabIndex = 0; c.setAttribute('role', 'button'); c.setAttribute('aria-pressed', 'false'); c.dataset.g = t.g;
      c.setAttribute('aria-label', t.n + ': ' + t.p + ' Helm instead: ' + t.f + '. ' + t.s);
      var inner = el('div', 'flip-in'); inner.setAttribute('aria-hidden', 'true');
      var f = el('div', 'face face-f'), tag = el('div', 'f-tag'); tag.appendChild(el('span', null, AREAS[t.g])); tag.appendChild(el('span', null, String(idx + 1).padStart(2, '0')));
      f.appendChild(tag); f.appendChild(buildIll(t.a));
      var h = el('h3'); h.appendChild(icon(t.i)); h.appendChild(document.createTextNode(t.n)); f.appendChild(h);
      f.appendChild(el('p', null, t.p));
      var hint = el('span', 'f-hint', 'See the Helm way'); hint.appendChild(icon('i-chev')); f.appendChild(hint);
      var b = el('div', 'face face-b'), tag2 = el('div', 'f-tag'); tag2.appendChild(el('span', null, 'Helm instead')); tag2.appendChild(el('span', null, t.n));
      b.appendChild(tag2); var big = icon(t.i); big.setAttribute('class', 'f-big'); b.appendChild(big);
      if (t.sv) b.appendChild(buildSol(t.sv));
      b.appendChild(el('h3', null, t.f)); b.appendChild(el('p', null, t.s));
      var ok = el('span', 'f-ok', 'Built into Helm'); ok.insertBefore(icon('i-check'), ok.firstChild); b.appendChild(ok);
      inner.appendChild(f); inner.appendChild(b); c.appendChild(inner); flipsBox.appendChild(c); cards.push(c);
      var toggle = function () { var on = !c.classList.contains('on'); c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); if (on) tick(c); };
      c.addEventListener('mouseenter', function () { tick(c); });
      c.addEventListener('click', toggle);
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      watchPlay(c);
    });
    /* counts come from the data, so adding a tool updates them */
    var ftabs = $$('#ftabs button');
    ftabs.forEach(function (bt) {
      var g = bt.dataset.f, n = g === 'all' ? TOOLS.length : TOOLS.filter(function (t) { return t.g === g; }).length;
      $('span', bt).textContent = n; bt.setAttribute('aria-label', bt.firstChild.textContent.trim() + ', ' + n + ' tools');
    });
    var reveal = function (list) { list.forEach(function (c, k) { c.classList.remove('in'); setTimeout(function () { c.classList.add('in'); }, reduce ? 0 : 40 + k * 55); }); };
    var cardIO = ('IntersectionObserver' in window && !reduce) ? new IntersectionObserver(function (ents) {
      var vis = ents.filter(function (en) { return en.isIntersecting; }).map(function (en) { cardIO.unobserve(en.target); return en.target; });
      reveal(vis);
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 }) : null;
    cards.forEach(function (c) { if (cardIO) cardIO.observe(c); else c.classList.add('in'); });
    ftabs.forEach(function (bt) {
      bt.addEventListener('click', function () {
        var g = bt.dataset.f;
        ftabs.forEach(function (x) { x.setAttribute('aria-pressed', String(x === bt)); });
        var show = cards.filter(function (c) { return g === 'all' || c.dataset.g === g; });
        cards.forEach(function (c) { if (cardIO) cardIO.unobserve(c); c.classList.remove('in'); });
        setTimeout(function () {
          cards.forEach(function (c) { c.classList.toggle('hide', show.indexOf(c) < 0); c.classList.remove('on'); c.setAttribute('aria-pressed', 'false'); });
          reveal(show);
        }, reduce ? 0 : 220);
      });
    });
  }

  /* ---------- celebrations: pinned background slider ---------- */
  var cel = $('#solutions'), slides = $$('.cel-s'), bgBox = $('#celBgs'), dotsBox = $('#celDots');
  if (cel && slides.length) {
    cel.style.setProperty('--cn', String(slides.length));
    var bgs = [], dots = [], cur = -1;
    var evMan = Promise.resolve(window.DEMO9_MANIFEST || {});
    slides.forEach(function (s, k) {
      var name = s.dataset.ev, bg = el('div', 'cel-bg');
      bg.setAttribute('data-ev', name);
      bg.appendChild(el('div', 'cel-gr'));   /* tinted gradient fallback, no request */
      /* media only when the manifest flag is on, so missing files are never requested:
         events_video[name] -> <name>.mp4/.webm loop; events[name] -> <name>.<events_ext[name]|webp> */
      evMan.then(function (m) {
        m = m || {};
        var ext = (m.events_ext && /^(webp|jpg|jpeg|png)$/.test(m.events_ext[name])) ? m.events_ext[name] : 'webp';
        var base = '/home-assets/events/' + encodeURIComponent(name);
        if (m.events_video && m.events_video[name] === true) {
          var v = el('video'); v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
          v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
          if (m.events && m.events[name] === true) v.poster = base + '.' + ext;
          var sw = el('source'); sw.src = base + '.webm'; sw.type = 'video/webm';
          var sm = el('source'); sm.src = base + '.mp4'; sm.type = 'video/mp4';
          v.appendChild(sw); v.appendChild(sm);
          v.addEventListener('loadeddata', function () { bg.classList.add('has-media'); });
          bg.appendChild(v); bg._v = v;
          if (bg.classList.contains('on') && !reduce) { var pp = v.play(); if (pp && pp.catch) pp.catch(function () {}); }
        } else if (m.events && m.events[name] === true) {
          var im = el('img'); im.alt = ''; im.decoding = 'async'; im.loading = 'lazy';
          im.addEventListener('load', function () { bg.classList.add('has-media'); });
          im.src = base + '.' + ext; bg.appendChild(im);
        }
      });
      bgBox.appendChild(bg); bgs.push(bg);
      var li = el('li'), b = el('button'); b.type = 'button'; b.appendChild(el('i'));
      b.setAttribute('aria-label', $('.cel-n', s).textContent);
      b.addEventListener('click', function () {
        var r = cel.getBoundingClientRect(), span = cel.offsetHeight - window.innerHeight;
        window.scrollTo({ top: window.scrollY + r.top + span * (k + 0.5) / slides.length, behavior: reduce ? 'auto' : 'smooth' });
      });
      li.appendChild(b); dotsBox.appendChild(li); dots.push(b);
    });
    var set = function (i) {
      if (i === cur) return; cur = i;
      slides.forEach(function (s, k) { s.classList.toggle('on', k === i); s.classList.toggle('past', k < i); s.setAttribute('aria-hidden', String(k !== i)); });
      bgs.forEach(function (b, k) {
        b.classList.toggle('on', k === i);
        if (b._v) { if (k === i && !reduce) { var pp = b._v.play(); if (pp && pp.catch) pp.catch(function () {}); } else b._v.pause(); }
      });
      dots.forEach(function (d, k) { d.setAttribute('aria-current', String(k === i)); });
    };
    if (reduce) {
      slides.forEach(function (s) { s.removeAttribute('aria-hidden'); });
      bgs[0].classList.add('on');
    } else {
      set(0);
      var tick = function () {
        var r = cel.getBoundingClientRect(), span = cel.offsetHeight - window.innerHeight;
        if (r.bottom > 0 && r.top < window.innerHeight) {
          var p = span > 0 ? Math.min(Math.max(-r.top / span, 0), 0.9999) : 0;
          set(Math.floor(p * slides.length));
          /* gentle parallax: image panel drifts up to ~3% of the viewport while pinned */
          bgBox.style.setProperty('--cpy', ((0.5 - p) * window.innerHeight * 0.06).toFixed(1) + 'px');
        }
      };
      /* perf: scroll-driven instead of a perpetual rAF loop */
      var celRaf = 0, celReq = function () { if (!celRaf) celRaf = requestAnimationFrame(function () { celRaf = 0; tick(); }); };
      window.addEventListener('scroll', celReq, { passive: true });
      window.addEventListener('resize', celReq, { passive: true });
      celReq();
    }
  }
})();

/* ================= Stage A: chapter stepping, layout gallery, measure, crew flow ================= */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  if (!reduce) document.documentElement.classList.add('js-motion');

  /* ---------- one chapter per gesture (wheel / trackpad / keys / touch) ---------- */
  var LOCK_MS = 600, GAP_MS = 320, WHEEL_MIN = 12, SWIPE_MIN = 40, lastAbs = 0;
  var steppers = [];
  function jumpTo(y) {
    var html = document.documentElement;
    html.style.setProperty('scroll-behavior', 'auto');
    window.scrollTo(0, Math.round(y));
    html.style.removeProperty('scroll-behavior');
  }
  function Stepper(sec, n) {
    var st = { sec: sec, n: n, locked: false, used: false, last: 0, acc: 0 };
    st.vh = function () { return window.innerHeight; };
    st.engaged = function () { var r = sec.getBoundingClientRect(); return r.top <= 2 && r.bottom >= st.vh() - 2; };
    st.cur = function () {
      var r = sec.getBoundingClientRect(), span = sec.offsetHeight - st.vh();
      var p = span > 0 ? Math.min(Math.max(-r.top / span, 0), 1) : 0;
      return Math.min(n - 1, Math.floor(p * n * 0.9999));
    };
    st.pos = function (i) {
      var top = sec.getBoundingClientRect().top + window.scrollY, span = sec.offsetHeight - st.vh();
      return top + span * (i + 0.5) / n;
    };
    st.go = function (i) {
      st.locked = true; st.used = true; st.acc = 0;
      jumpTo(st.pos(i));
      clearTimeout(st.t); st.t = setTimeout(function () { st.locked = false; }, LOCK_MS);
    };
    steppers.push(st);
    return st;
  }
  function norm(e) { var d = e.deltaY; if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= window.innerHeight; return d; }
  function onWheel(e) {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    var d = norm(e); if (!d) return;
    var now = performance.now();
    for (var k = 0; k < steppers.length; k++) {
      var st = steppers[k], r = st.sec.getBoundingClientRect(), vh = st.vh();
      if (!st.engaged()) {
        /* entering: land exactly on the first (or last) chapter instead of overshooting */
        if (d > 0 && r.top > 2 && r.top < vh && r.top - d < 0) { e.preventDefault(); st.last = now; st.go(0); return; }
        if (d < 0 && r.bottom < vh - 2 && r.bottom > 0 && r.bottom - d > vh) { e.preventDefault(); st.last = now; st.go(st.n - 1); return; }
        continue;
      }
      /* a new gesture = a real pause, or a rising wheel delta (trackpad inertia only ever decays) */
      var ad = Math.abs(d), gap = now - st.last;
      var fresh = gap > GAP_MS || (ad > 24 && ad > lastAbs * 1.6);
      st.last = now; lastAbs = ad;
      if (fresh && !st.locked) { st.used = false; st.acc = 0; }
      if (st.locked || st.used) { e.preventDefault(); return; }        // swallow the rest of this gesture / inertia
      var t = st.cur() + (d > 0 ? 1 : -1);
      if (t < 0 || t >= st.n) return;                                    // first/last chapter: release to the page
      e.preventDefault();
      if ((st.acc > 0) !== (d > 0)) st.acc = 0;
      st.acc += d;
      if (Math.abs(st.acc) >= WHEEL_MIN) st.go(t);
      return;
    }
  }
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var tg = e.target; if (tg && (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tg.tagName) || tg.isContentEditable)) return;
    var dir = 0;
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) dir = 1;
    else if (e.key === 'ArrowUp' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) dir = -1;
    if (!dir) return;
    for (var k = 0; k < steppers.length; k++) {
      var st = steppers[k]; if (!st.engaged()) continue;
      var t = st.cur() + dir;
      if (t < 0 || t >= st.n) return;
      e.preventDefault();
      if (!st.locked) st.go(t);
      return;
    }
  }
  var ty0 = null, tSt = null, tTarget = -1;
  function onTouchStart(e) {
    ty0 = e.touches.length === 1 ? e.touches[0].clientY : null; tSt = null; tTarget = -1;
    for (var k = 0; k < steppers.length; k++) if (steppers[k].engaged()) { tSt = steppers[k]; break; }
  }
  function onTouchMove(e) {
    if (ty0 == null || !tSt) return;
    var dy = ty0 - e.touches[0].clientY; if (Math.abs(dy) < 6) return;
    var t = tSt.cur() + (dy > 0 ? 1 : -1);
    if (t < 0 || t >= tSt.n) { if (!tSt.locked) { tSt = null; return; } }
    if (e.cancelable) e.preventDefault();
    tTarget = t;
  }
  function onTouchEnd(e) {
    if (ty0 == null || !tSt) return;
    var dy = ty0 - (e.changedTouches[0] ? e.changedTouches[0].clientY : ty0);
    if (Math.abs(dy) >= SWIPE_MIN && !tSt.locked && tTarget >= 0 && tTarget < tSt.n) tSt.go(tTarget);
    ty0 = null; tSt = null;
  }
  if (!reduce) {
    var film = $('#film'), story = $('#story');
    if (film) Stepper(film, $$('#film .fc').length);
    if (story) Stepper(story, $$('#story .sl').length);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    /* touch momentum can still land mid-way: settle on the chapter we are in once scrolling stops */
    var settleT = null;
    window.addEventListener('scroll', function () {
      clearTimeout(settleT);
      settleT = setTimeout(function () {
        steppers.forEach(function (st) {
          if (!st.engaged() || st.locked) return;
          var i = st.cur(), y = st.pos(i), span = (st.sec.offsetHeight - st.vh()) / st.n;
          if ((i === 0 && window.scrollY < y) || (i === st.n - 1 && window.scrollY > y)) return;  // edge halves: free scroll
          if (Math.abs(window.scrollY - y) > span * 0.08) jumpTo(y);
        });
      }, 160);
    }, { passive: true });
  }

  /* ---------- layout gallery: manifest-driven, never requests missing files ---------- */
  var VIEWS = ['2d', '3d', 'render', 'measure'];
  var SAMPLE = {
    wedding: ['/mk/media/hero-2d.webp', '/mk/media/hero-3d.webp', '/mk/media/hero-render.webp', '/mk/media/hero-measure.webp'],
    corporate: ['/mk/media/hero-2d.webp', '/mk/media/hero-3d.webp', '/mk/media/hero-render.webp', '/mk/media/hero-measure.webp']
  };
  var SAMPLE_MEAS = [{ label: 'Stage to first table', m: 4.5 }, { label: 'Centre aisle', m: 1.8 }, { label: 'Table to table', m: 1.5 }, { label: 'Hall', w: 24, h: 16 }];
  var ready = {}, names = { wedding: 'Garden wedding', corporate: 'Corporate gala' }, exts = {}, hasMeasure = {}, hasVideo = {}, meas = {};
  var M_TO_FT = 3.28084, mUnit = 'm';
  function extFor(id, v) { var e = exts[id] && exts[id][v]; return e === 'jpg' || e === 'png' ? e : 'webp'; }
  // layout ids come from the page's data-ly attributes; only ids the script itself knows (SAMPLE / manifest)
  // are ever put into a URL, so DOM text never becomes part of an image / video src.
  function lyId(x) { var ids = Object.keys(SAMPLE).concat(Object.keys(ready)), i = ids.indexOf(String(x)); return i < 0 ? 'corporate' : ids[i]; }
  function srcFor(id, k) {
    id = lyId(id);
    var own = k === 3 ? ready[id] && hasMeasure[id] : ready[id];
    return own ? '/home-assets/layouts/' + id + '/' + VIEWS[k] + '.' + extFor(id, VIEWS[k]) : (SAMPLE[id] || SAMPLE.corporate)[k];
  }
  var mimgs = [$('.mx0'), $('.mx1'), $('.mx2'), $('.mx3')], mnote = $('#mnote'), lyTabs = $$('#lyTabs [data-ly]'), curLy = 'corporate';
  var mlist = $('#mmeas'), mframeEl = $('#morph .mframe');
  function len(m) { return (mUnit === 'ft' ? (m * M_TO_FT).toFixed(1) : (+m).toFixed(1)) + ' ' + mUnit; }
  function paintLegend() {
    if (!mlist) return;
    while (mlist.firstChild) mlist.removeChild(mlist.firstChild);
    (meas[curLy] || SAMPLE_MEAS).forEach(function (r) {
      var li = document.createElement('li'), k = document.createElement('span'), v = document.createElement('b');
      k.textContent = r.label;
      v.textContent = r.w != null ? (mUnit === 'ft' ? (r.w * M_TO_FT).toFixed(1) + ' × ' + (r.h * M_TO_FT).toFixed(1) : (+r.w).toFixed(1) + ' × ' + (+r.h).toFixed(1)) + ' ' + mUnit : len(r.m);
      li.appendChild(k); li.appendChild(v); mlist.appendChild(li);
    });
    $$('.munits [data-mu]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mu') === mUnit)); });
  }
  $$('.munits [data-mu]').forEach(function (b) { b.addEventListener('click', function () { mUnit = b.getAttribute('data-mu') === 'ft' ? 'ft' : 'm'; paintLegend(); }); });
  function paintVideo() {   // optional short 3D loop: layouts/<id>/3d.mp4 (manifest video3d: true)
    var v = $('.mx1v'), want = ready[curLy] && hasVideo[curLy] && !reduce;
    if (!want) { if (v) v.parentNode.removeChild(v); return; }
    var src = '/home-assets/layouts/' + curLy + '/3d.mp4';
    if (!v) {
      v = document.createElement('video'); v.className = 'mimg mx1v';
      v.muted = true; v.loop = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true'); v.preload = 'metadata';
      mimgs[1].parentNode.insertBefore(v, mimgs[1].nextSibling);
      v.style.setProperty('opacity', mimgs[1].style.getPropertyValue('opacity') || '0');
    }
    if (v.getAttribute('src') !== src) { v.setAttribute('poster', srcFor(curLy, 1)); v.setAttribute('src', src); }
    var pr = v.play(); if (pr && pr.catch) pr.catch(function () {});
  }
  function paintShowcase() {
    mimgs.forEach(function (im, k) {
      if (!im) return;
      var s = srcFor(curLy, k);
      if (im.getAttribute('src') !== s) im.setAttribute('src', s);
      im.classList.remove('fallback');   // SAMPLE images are real product screenshots now
      im.alt = names[curLy] + ' — ' + ['2D venue plan on a measured grid', 'the same plan in 3D', 'the same plan as a photoreal render', 'plan with measured gaps and clearances'][k];
    });
    if (mnote) mnote.hidden = !!ready[curLy];
    paintLegend(); paintVideo();
  }
  lyTabs.forEach(function (b) {
    b.addEventListener('click', function () {
      curLy = lyId(b.getAttribute('data-ly'));
      lyTabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      paintShowcase();
    });
  });
  function paintFilm() {
    $$('.ly-img[data-ly]').forEach(function (im) {
      var id = im.getAttribute('data-ly'), k = VIEWS.indexOf(im.getAttribute('data-v'));
      if (!ready[id] || k < 0) return;
      im.setAttribute('src', srcFor(id, k)); im.classList.remove('fallback');
    });
    $$('.ly-sample[data-ly]').forEach(function (t) { t.hidden = !!ready[t.getAttribute('data-ly')]; });
  }
  function cleanMeas(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    list.slice(0, 8).forEach(function (r) {
      if (!r || typeof r.label !== 'string' || !r.label || r.label.length > 60) return;
      var ok = function (n) { return typeof n === 'number' && isFinite(n) && n > 0 && n < 10000; };
      if (ok(r.m)) out.push({ label: r.label, m: r.m });
      else if (ok(r.w) && ok(r.h)) out.push({ label: r.label, w: r.w, h: r.h });
    });
    return out.length ? out : null;
  }
  Promise.resolve(window.DEMO9_MANIFEST || {}).then(function (m) {
    (Array.isArray(m.layouts) ? m.layouts : []).forEach(function (l) {
      if (!l || !/^[a-z0-9-]{1,40}$/.test(String(l.id))) return;
      if (typeof l.name === 'string' && l.name.length < 60) names[l.id] = l.name;
      ready[l.id] = l.ready === true;
      hasMeasure[l.id] = l.measure === true;
      hasVideo[l.id] = l.video3d === true;
      if (l.ext && typeof l.ext === 'object') exts[l.id] = l.ext;
      var ms = cleanMeas(l.measurements); if (ms) meas[l.id] = ms;
    });
    lyTabs.forEach(function (b) { var id = b.getAttribute('data-ly'); if (names[id]) b.textContent = names[id]; });
    paintShowcase(); paintFilm();
  });
  paintShowcase();
  if (mframeEl && 'IntersectionObserver' in window) new IntersectionObserver(function (es) {
    var v = $('.mx1v'); if (!v) return;
    if (es[0].isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause();
  }).observe(mframeEl);

  /* ---------- measure: units toggle + draw-in ---------- */
  var msVis = $('#msVis'), units = $$('.unit [data-u]');
  function fmt(m, u) {
    if (u === 'm') return m.toFixed(1) + ' m';
    var inch = Math.round(m * 39.3701), ft = Math.floor(inch / 12), i = inch % 12;
    return ft + '′ ' + i + '″';
  }
  function setUnit(u) {
    units.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-u') === u)); });
    $$('#msVis [data-m]').forEach(function (t) {
      var m = parseFloat(t.getAttribute('data-m'));
      if (t.hasAttribute('data-ax')) { t.textContent = u === 'm' ? String(m) : String(Math.round(m * 3.28084)); return; }
      var suf = t.getAttribute('data-suf') || '', need = t.getAttribute('data-need');
      if (need) suf = ' to exit · needs ' + fmt(parseFloat(need), u);
      t.textContent = fmt(m, u) + suf;
    });
  }
  units.forEach(function (b) { b.addEventListener('click', function () { setUnit(b.getAttribute('data-u')); }); });
  if (msVis) {
    if (reduce || !('IntersectionObserver' in window)) msVis.classList.add('drawn');
    else {
      var mio = new IntersectionObserver(function (ents) { ents.forEach(function (en) { if (en.isIntersecting) { msVis.classList.add('drawn'); mio.disconnect(); } }); }, { threshold: 0.35 });
      mio.observe(msVis);
    }
  }

  /* ---------- crew flow: notify -> decline -> reassign -> remind -> check in ---------- */
  var cflow = $('#cflow'), cfSteps = $$('#cfSteps li'), cpWho = $('#cpWho'), msgSrc = $('#crewMsg'), msgDst = $('.cmsg', cflow || document);
  if (msgSrc && msgDst) msgDst.textContent = msgSrc.textContent.replace(/^[“"]|[”"]$/g, '');
  function setCrew(i) {
    if (!cflow) return;
    cflow.setAttribute('data-s', String(i));
    cfSteps.forEach(function (li, k) { li.classList.toggle('on', reduce ? true : k === i); });
    if (cpWho) cpWho.textContent = i >= 3 ? "Arun's phone" : "Sana's phone";
  }
  var cfI = 0, cfTimer = null;
  function cfRun(on) {
    clearInterval(cfTimer); cfTimer = null;
    if (on) cfTimer = setInterval(function () { cfI = (cfI + 1) % 5; setCrew(cfI); }, 2600);
  }
  if (cflow) {
    if (reduce) setCrew(1);
    else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (ents) { ents.forEach(function (en) { cfRun(en.isIntersecting); }); }, { threshold: 0.3 }).observe(cflow);
      setCrew(0);
    }
    cfSteps.forEach(function (li, k) {
      li.tabIndex = 0;
      var pick = function () { cfI = k; setCrew(k); if (cfTimer) cfRun(true); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }
  /* scroll moments: word fill + curtain reveal (only active while on screen) */
  (function () {
    var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    var $ = function (q) { return document.querySelector(q); }, vh = window.innerHeight;
    var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; }, ease = function (t) { return 1 - Math.pow(1 - t, 3); };
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.addEventListener('resize', function () { vh = window.innerHeight; }, { passive: true });
    var line = $('[data-fill]'), cur = $('.curtain'), ws = null;
    if (line) {
      var words = line.textContent.trim().split(/\s+/); line.textContent = '';
      var sr = el('span', 'sr', words.join(' ')); line.appendChild(sr);
      ws = words.map(function (w) { var sp = el('span', 'fw', w); sp.setAttribute('aria-hidden', 'true'); line.appendChild(sp); line.appendChild(document.createTextNode(' ')); return sp; });
    }
    if (reduce) { if (ws) ws.forEach(function (w) { w.classList.add('on'); }); if (cur) cur.classList.add('open'); return; }
    var live = new Set(), raf = 0;
    function frame() {
      raf = 0;
      if (line && live.has(line)) {
        var r = line.getBoundingClientRect(), k = clamp((vh * .85 - r.top) / (r.height + vh * .45), 0, 1), n = Math.round(k * ws.length);
        ws.forEach(function (w, i) { w.classList.toggle('on', i < n); });
      }
      if (cur && live.has(cur)) {
        var c = cur.getBoundingClientRect(), p = clamp((vh - c.top) / (vh * .7), 0, 1);
        cur.style.setProperty('--cu', (1 - ease(p)).toFixed(3));
      }
    }
    var req = function () { if (!raf) raf = requestAnimationFrame(frame); };
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) live.add(e.target); else live.delete(e.target); }); req(); });
      [line, cur].forEach(function (n) { if (n) io.observe(n); });
    } else { if (ws) ws.forEach(function (w) { w.classList.add('on'); }); if (cur) cur.classList.add('open'); return; }
    window.addEventListener('scroll', req, { passive: true });
  })();
})();
