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

  /* r21 landing 2: position dots under every swipe row (visual cue that more cards follow).
     Decorative only (aria-hidden) — the row itself is the keyboard/AT control. Hidden >= 768px by CSS. */
  $$('.snap').forEach(function (el) {
    var dots = document.createElement('div');
    dots.className = 'snap-dots'; dots.setAttribute('aria-hidden', 'true');
    el.parentNode.insertBefore(dots, el.nextSibling);
    var items = function () { return Array.prototype.filter.call(el.children, function (c) { return c.offsetParent !== null; }); };
    var raf = 0;
    function paint() {
      raf = 0;
      if (!snapMq.matches) return;
      var list = items(), n = list.length;
      if (dots.childElementCount !== n) {
        while (dots.firstChild) dots.removeChild(dots.firstChild);
        for (var i = 0; i < n; i++) dots.appendChild(document.createElement('i'));
      }
      dots.classList.toggle('one', n < 2);
      if (!n) return;
      var x = el.scrollLeft, base = list[0].offsetLeft, best = 0, bd = Infinity;
      list.forEach(function (c, k) { var d = Math.abs(c.offsetLeft - base - x); if (d < bd) { bd = d; best = k; } });
      if (x + el.clientWidth >= el.scrollWidth - 4) best = n - 1;       // last card fully in view
      Array.prototype.forEach.call(dots.children, function (d, k) { d.classList.toggle('on', k === best); });
    }
    var req = function () { if (!raf) raf = requestAnimationFrame(paint); };
    el.addEventListener('scroll', req, { passive: true });
    window.addEventListener('resize', req, { passive: true });
    el.addEventListener('click', function () { setTimeout(req, 50); });          // flip cards / filters change layout
    var tabs = document.getElementById('ftabs');
    if (el.id === 'flips' && tabs) tabs.addEventListener('click', function () { el.scrollLeft = 0; setTimeout(req, 60); });
    if (el.id === 'flips' && 'MutationObserver' in window) new MutationObserver(req).observe(el, { childList: true });
    req();
  });

  /* r21 landing 2: phones show "every tool in -> one Helm" as a compact static block; it plays a
     short staggered reveal once, when it scrolls into view (CSS keeps it fully visible without JS/motion) */
  var cvSec = $('#converge');
  if (cvSec) {
    if (reduce || !('IntersectionObserver' in window)) cvSec.classList.add('cv-in');
    else {
      var cvIo = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { cvSec.classList.add('cv-in'); cvIo.disconnect(); } }, { threshold: 0.18 });
      cvIo.observe(cvSec);
    }
  }

  /* ---------- mobile sticky CTA: shows once the hero is gone, hides over the final CTA ---------- */
  /* r21 mobile: the bar can be hidden with its X; that choice is remembered on this device for
     14 days (localStorage; private mode / blocked storage just means it is remembered for this visit). */
  var mcta = $('#mcta'), heroEl = $('.hero'), finEl = $('.final');
  var MCTA_KEY = 'helm-mcta-hidden', MCTA_DAYS = 14;
  var mctaHidden = (function () {
    try { var t = Number(window.localStorage.getItem(MCTA_KEY)); return !!t && (Date.now() - t) < MCTA_DAYS * 864e5; } catch (e) { return false; }
  })();
  if (mcta && mctaHidden) { mcta.remove(); mcta = null; document.body.classList.add('mcta-off'); }
  if (mcta) {
    var mctaX = $('.mcta-x', mcta);
    if (mctaX) mctaX.addEventListener('click', function () {
      try { window.localStorage.setItem(MCTA_KEY, String(Date.now())); } catch (e) { /* storage blocked: hide for this visit */ }
      mcta.classList.remove('on'); document.body.classList.remove('has-mcta'); document.body.classList.add('mcta-off');
      var main = $('#main'); if (main) { main.setAttribute('tabindex', '-1'); main.focus({ preventScroll: true }); }
      setTimeout(function () { if (mcta && mcta.parentNode) mcta.parentNode.removeChild(mcta); mcta = null; }, 400);
    });
  }
  if (mcta && heroEl && 'IntersectionObserver' in window) {
    var heroIn = true, finIn = false;
    var paintCta = function () { if (!mcta) return; var on = !heroIn && !finIn; mcta.classList.toggle('on', on); document.body.classList.toggle('has-mcta', on); };
    new IntersectionObserver(function (es) { heroIn = es[0].isIntersecting; paintCta(); }).observe(heroEl);
    if (finEl) new IntersectionObserver(function (es) { finIn = es[0].isIntersecting; paintCta(); }).observe(finEl);
  }

  /* ---------- lazy, offscreen-paused videos ---------- */
  /* r21 mobile: Data Saver / Save-Data or a 2G-class connection = no autoplaying video at all;
     posters stay, and the hero film starts only when the visitor presses Play. */
  var netInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  var liteData = !!netInfo.saveData || /(^|-)2g$/.test(String(netInfo.effectiveType || ''));
  var smallScreen = !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
  var userPaused = reduce || liteData;
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
        heroReady = true; loadV(heroVideo);
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
    var heroUserPaused = reduce || liteData, heroVisible = false;
    /* r23: the film (HQ ~3.7 MB) never competes with the first paint - it is fetched only after the page's own
       load event + an idle moment (poster shows until then); pressing Play or a chapter starts it at once */
    var heroReady = false;
    function heroGo() {
      heroReady = true;
      if (!smallScreen) loadV(heroVideo);   // desktop: buffer it now (idle) so it plays the moment it scrolls in; phones wait for the scroll
      if (heroVisible && !heroUserPaused) { loadV(heroVideo); tryPlay(heroVideo); }
    }
    function afterLoadIdle(fn) {
      var idle = function () { if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 2500 }); else setTimeout(fn, 300); };
      if (document.readyState === 'complete') idle(); else window.addEventListener('load', idle, { once: true });
    }
    function setBtn() {
      var paused = heroUserPaused;
      btn.setAttribute('aria-pressed', String(paused));
      btn.setAttribute('aria-label', paused ? 'Play film' : 'Pause film');
    }
    setBtn();
    btn.addEventListener('click', function () {
      heroUserPaused = !heroUserPaused; setBtn();
      if (heroUserPaused) heroVideo.pause(); else { heroReady = true; loadV(heroVideo); tryPlay(heroVideo); }
    });
    heroVideo.muted = true;
    if (!reduce && !liteData) {
      heroVideo.addEventListener('loadeddata', function () { if (heroVisible && !heroUserPaused) tryPlay(heroVideo); }, { once: true });
      /* phones: fetch the film only once its card scrolls into view (observer below), not on page load;
         desktop: after load + idle (heroGo), never during the first paint */
      afterLoadIdle(heroGo);
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (ents) {
        ents.forEach(function (en) {
          heroVisible = en.isIntersecting;
          if (heroVisible) { if (!heroUserPaused && heroReady) { loadV(heroVideo); tryPlay(heroVideo); } }
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

  /* ---------- contact form -> Helm sales (r24, 0271: submit_sales_enquiry; lands in HQ -> Requests) ----------
     The home page markup has name / studio / topic / message; the work e-mail, phone, consent tick and a hidden bot
     trap are added here (createElement only). config.js (the public Supabase URL + anon key) is loaded on first use. */
  var form = $('#ctForm');
  if (form) (function () {
    function fld(id, label, input) {
      var d = document.createElement('div'); d.className = 'fr';
      var l = document.createElement('label'); l.htmlFor = id; l.textContent = label; d.appendChild(l); d.appendChild(input); return d;
    }
    function inp(id, type, attrs) {
      var i = document.createElement('input'); i.id = id; i.type = type;
      Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); }); return i;
    }
    var studioRow = form.studio ? form.studio.closest('.fr') : null;
    var email = inp('cf-e', 'email', { name: 'email', autocomplete: 'email', maxlength: '200', required: '', placeholder: 'name@company.com' });
    var phone = inp('cf-p', 'tel', { name: 'phone', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', placeholder: 'e.g. 98765 43210' });
    var anchor = studioRow ? studioRow.nextSibling : form.firstChild;
    form.insertBefore(fld('cf-e', 'Work e-mail', email), anchor);
    form.insertBefore(fld('cf-p', 'Phone (optional)', phone), anchor);
    var trap = inp('cf-w', 'text', { name: 'website', tabindex: '-1', autocomplete: 'off' });
    var trapBox = document.createElement('div'); trapBox.setAttribute('aria-hidden', 'true');
    trapBox.style.position = 'absolute'; trapBox.style.left = '-10000px'; trapBox.style.width = '1px'; trapBox.style.height = '1px'; trapBox.style.overflow = 'hidden';
    trapBox.appendChild(trap); form.appendChild(trapBox);
    var errEl = $('#cfErr');
    var consentL = document.createElement('label'); consentL.className = 'fr-consent';
    consentL.style.display = 'flex'; consentL.style.gap = '10px'; consentL.style.alignItems = 'flex-start'; consentL.style.fontSize = '14px';
    var consent = inp('cf-c', 'checkbox', { name: 'consent' }); consent.style.width = '18px'; consent.style.height = '18px'; consent.style.marginTop = '3px'; consent.style.flex = '0 0 auto';
    var consentT = document.createElement('span'); consentT.textContent = 'Helm may contact me about this message.';
    consentL.appendChild(consent); consentL.appendChild(consentT);
    if (errEl) form.insertBefore(consentL, errEl); else form.appendChild(consentL);
    var btn = form.querySelector('button[type="submit"]');
    var fine = form.querySelector('.fine-d');
    if (fine) fine.textContent = 'Goes straight to our sales team. We reply within one working day.';
    var btnLabel = btn ? btn.firstChild : null;
    if (btnLabel && btnLabel.nodeType === 3) btnLabel.nodeValue = 'Send to sales ';

    var cfgP = null;
    function loadCfg() {
      if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) return Promise.resolve(window.SUPABASE_CONFIG);
      if (cfgP) return cfgP;
      cfgP = new Promise(function (res) {
        var s = document.createElement('script'); s.src = '/config.js?v=109';
        s.onload = function () { res(window.SUPABASE_CONFIG || {}); }; s.onerror = function () { cfgP = null; res({}); };
        document.head.appendChild(s);
      });
      return cfgP;
    }
    // r26: the Cloudflare security check - only when config.js has a Turnstile site key (captcha.js loaded on first use;
    // no key = nothing loaded, the form works exactly as before). Its one-use pass goes in the "captcha" field.
    var capHost = document.createElement('div'); capHost.className = 'ct-captcha'; capHost.hidden = true;
    capHost.style.minHeight = '65px'; capHost.style.maxWidth = '100%'; capHost.style.overflow = 'hidden';
    if (errEl) form.insertBefore(capHost, errEl); else form.appendChild(capHost);
    var capP = null, CAPTCHA_V = '1';
    function loadCap() {
      if (capP) return capP;
      capP = loadCfg().then(function (cfg) {
        var c = (cfg && cfg.captcha) || {};
        if (c.provider !== 'turnstile' || !/^[0-9A-Za-z_-]{8,128}$/.test(String(c.siteKey || '').trim())) return null;
        return new Promise(function (res) {
          if (window.HelmCaptcha) return res(window.HelmCaptcha.guard(capHost, 'contact'));
          var s = document.createElement('script'); s.src = '/captcha.js?v=' + CAPTCHA_V;
          s.onload = function () { res(window.HelmCaptcha ? window.HelmCaptcha.guard(capHost, 'contact') : null); };
          s.onerror = function () { capP = null; res(null); };
          document.head.appendChild(s);
        });
      });
      return capP;
    }
    form.addEventListener('focusin', function () { loadCap(); }, { once: true });
    function bad(msg, el) {
      errEl.textContent = msg;
      [form.name, email, phone, form.studio, form.msg, consent].forEach(function (x) { if (x) x.removeAttribute('aria-invalid'); });
      if (el) { el.setAttribute('aria-invalid', 'true'); try { el.focus(); } catch (x) {} }
    }
    var EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
    var MAP = { name: form.name, email: email, phone: phone, company: form.studio, message: form.msg, consent: consent };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = form.name.value.trim(), m = form.msg.value.trim(), em = email.value.trim(), ph = phone.value.trim(), st = form.studio.value.trim();
      if (n.length < 2) return bad('Please add your name.', form.name);
      if (!EMAIL.test(em)) return bad('Please add a valid work e-mail.', email);
      if (ph && !/^\+?[0-9\s().-]{10,20}$/.test(ph)) return bad('Please enter a valid phone number (10 digits).', phone);
      if (st.length < 2) return bad('Please add your studio or company name.', form.studio);
      if (!m) return bad('Please add a short message.', form.msg);
      if (!consent.checked) return bad('Please tick the box so we may contact you.', consent);
      bad('');
      var topic = form.topic ? form.topic.value : '';
      var body = { name: n, email: em, phone: ph || null, company: st, message: (topic ? "I'd like: " + topic + '\n\n' : '') + m,
        plan: /enterprise/i.test(topic) ? 'enterprise' : null, consent: true, source: 'home' };
      if (trap.value) body.website = trap.value;
      if (btn) btn.disabled = true;
      var cfg = {};
      loadCfg().then(function (c) { cfg = c || {}; return loadCap(); }).then(function (cap) {
        return cap ? cap.pass() : { ok: true, pass: null };
      }).then(function (c) {
        if (!c.ok) return { ok: false, error: 'captcha', captcha: c.message };
        if (c.pass) body.captcha = c.pass;
        var base = String(cfg.url || '').replace(/\/+$/, '');
        if (!base || !cfg.anonKey) return { ok: false, error: 'config' };
        return fetch(base + '/rest/v1/rpc/submit_sales_enquiry', { method: 'POST', credentials: 'omit',
          headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey },
          body: JSON.stringify({ p: body }) })
          .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: '' }; }, function () { return { ok: false, error: '' }; }); })
          .catch(function () { return { ok: false, error: 'network' }; });
      }).then(function (r) {
        if (btn) btn.disabled = false;
        if (r.captcha) return bad(r.captcha);
        var d = r.ok ? r.data : null;
        if (d && d.ok === true) {
          form.reset(); bad('');
          if (fine) { fine.textContent = 'Thank you! We have your message and will get back to you within one working day.'; fine.classList.add('ok'); fine.setAttribute('role', 'status'); }
          return;
        }
        bad(d && d.message ? String(d.message).slice(0, 200)
          : (r.error === 'network' ? 'No connection. Check your internet and try again.' : 'Something went wrong. Please try again, or e-mail sales@helm.events.'),
          d && d.field ? MAP[d.field] : null);
      });
    });
  })();

  /* r24 (0271): the footer's "Send a suggestion" link (public /suggest page) next to Contact */
  (function () {
    var c = $('.foot a[href="#contact"]') || $('.foot a[href="/#contact"]');
    if (!c || $('.foot a[href="/suggest"]')) return;
    var a = document.createElement('a'); a.href = '/suggest'; a.textContent = 'Send a suggestion';
    c.parentNode.insertBefore(a, c.nextSibling);
  })();

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
  var phReel = $('#phReel');
  if (phReel) phReel.addEventListener('touchstart', function () { phReel.classList.toggle('rl-paused'); }, { passive: true });
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
      /* converge — r21 landing 2: phones (<768px) get a compact static layout from CSS, so the
         scroll-driven fold-in only runs on wider screens; inline styles are cleared when we get small */
      if (apps && core && vw < 768) {
        if (appsP !== -2) {
          appsP = -2;
          tiles.forEach(function (t) { t.style.removeProperty('transform'); t.style.removeProperty('opacity'); });
          core.style.removeProperty('transform'); core.style.removeProperty('opacity');
        }
      } else if (apps && core && (moved || appsP < 0)) {
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
    /* r21 landing photos: owner-supplied photos in /landing/events/ (1600w + 800w WebP).
       Data Saver / Save-Data or a 2G-class connection keeps the gradient only (no photo requests). */
    var CEL_PHOTOS = { wedding: 'wedding', corporate: 'product-launch', birthday: 'birthday', concert: 'sangeet', gala: 'corporate-gala', cultural: 'mehendi' };
    var celNet = navigator.connection || {};
    var celLite = !!celNet.saveData || /(^|-)2g$/.test(String(celNet.effectiveType || ''));
    var celLoad = function (bg) {   /* sets the src only when the slide is shown (or next), so later photos never load early */
      if (!bg || !bg._im || bg._im.getAttribute('src')) return;
      var f = '/landing/events/' + bg._ph;
      bg._im.srcset = f + '-800.webp 800w, ' + f + '.webp 1600w';
      bg._im.setAttribute('src', f + '.webp');
    };
    /* phones: the copy sits at the bottom over the photo, so the photo panel + scrim end where the heading starts
       (measured, since the copy height depends on the phone) -> the white heading/body text always sits on the dark
       section colour; only the small eyebrow pill (own dark background) overlaps the photo */
    var celPhone = window.matchMedia('(max-width: 760px)'), celHd = $('.cel-h', cel), celPin = $('.cel-pin', cel);
    var celMeasure = function () {
      if (!celPhone.matches || !celHd || !celPin) { cel.style.removeProperty('--cel-tt'); return; }
      cel.style.setProperty('--cel-tt', Math.max(0, Math.round(celHd.getBoundingClientRect().top - celPin.getBoundingClientRect().top)) + 'px');
    };
    celMeasure();
    window.addEventListener('resize', celMeasure, { passive: true });
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
        } else if (CEL_PHOTOS[name] && !celLite) {
          var ph = el('img'); ph.alt = ''; ph.decoding = 'async'; ph.loading = 'lazy';
          ph.sizes = '(max-width: 760px) 100vw, 58vw';
          ph.addEventListener('load', function () { bg.classList.add('has-media'); if (!cel.classList.contains('has-photos')) { cel.classList.add('has-photos'); celMeasure(); } });
          bg._im = ph; bg._ph = CEL_PHOTOS[name]; bg.appendChild(ph);
          if (k === 0 || k === cur || k === cur + 1) celLoad(bg);   /* first slide (lazy) + whatever is showing / next */
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
      celLoad(bgs[i]); celLoad(bgs[i + 1]);   /* current + next photo only */
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

/* ================= r21 landing photos: "Event ideas" film strip (was a photo grid) =================
   Photos live in /landing/events/ and are listed in /landing/events/events.json
   ([{ src, alt, caption, type, small?, avif?, width?, height? }] — see public/landing/events/README.md).
   Shown as a full-width film strip: one row (fewer than 6 photos) or two rows running in opposite
   directions. Each row = the photos once (focusable, read by screen readers) + copies that only fill
   the band and make the loop seamless (aria-hidden, not focusable). Motion = one transform per row per
   frame, only while the strip is on screen; it pauses on hover / keyboard focus, can be dragged or
   swiped, and every frame opens the lightbox. Reduced motion = no copies, no motion: one row that
   scrolls sideways with snap. Save-Data / 2G = the ~800px copies only (strip and lightbox).
   The section stays hidden while the list is empty, missing or invalid. DOM APIs only (no HTML strings). */
(function () {
  'use strict';
  var sec = document.getElementById('events'), reel = document.getElementById('evReel');
  if (!sec || !reel || !window.fetch) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var net = navigator.connection || {};
  var lite = !!net.saveData || /(^|-)2g$/.test(String(net.effectiveType || ''));
  var LOCAL = /^\/landing\/events\/[A-Za-z0-9._-]+\.(webp|avif|jpe?g|png)$/i;   // own folder only
  var str = function (v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; };
  var num = function (v) { v = Number(v); return v > 0 && v < 10000 ? Math.round(v) : 0; };

  fetch('/landing/events/events.json', { cache: 'no-cache', credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (list) {
      if (!Array.isArray(list)) return;
      var items = list.map(function (p) {
        p = p || {};
        var src = str(p.src, 200), alt = str(p.alt, 200), avif = str(p.avif, 200), small = str(p.small, 200);
        if (!LOCAL.test(src) || !alt) return null;
        return { src: src, alt: alt, avif: LOCAL.test(avif) && /\.avif$/i.test(avif) ? avif : '', small: LOCAL.test(small) ? small : '', caption: str(p.caption, 120), type: str(p.type, 30), w: num(p.width), h: num(p.height) };
      }).filter(Boolean).slice(0, 24);
      if (!items.length) return;
      build(items);
    })
    .catch(function () { /* no list = no section */ });

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  /* one film frame: equal size for every photo (CSS aspect-ratio + object-fit: cover) */
  function frame(it, i) {
    var fig = el('figure', 'reel-frame'); fig.setAttribute('role', 'listitem');
    var btn = el('button', 'ev-open'); btn.type = 'button'; btn.setAttribute('data-i', String(i));
    btn.setAttribute('aria-label', 'Open image: ' + (it.caption || it.alt));
    var pic = el('picture');
    if (it.avif && !lite) { var so = el('source'); so.type = 'image/avif'; so.srcset = it.avif; pic.appendChild(so); }
    var img = el('img'); img.alt = it.alt; img.loading = 'lazy'; img.decoding = 'async'; img.draggable = false;
    if (lite) img.src = it.small || it.src;
    else {
      if (it.small) { img.srcset = it.small + ' 800w, ' + it.src + ' 1600w'; img.sizes = '(max-width: 767px) 240px, 400px'; }
      img.src = it.src;
    }
    img.width = it.w || 1600; img.height = it.h || 1067;
    pic.appendChild(img); btn.appendChild(pic);
    if (it.type) btn.appendChild(el('span', 'ev-tag', it.type));
    if (it.caption) btn.appendChild(el('span', 'reel-cap', it.caption));
    fig.appendChild(btn);
    return { fig: fig, btn: btn, img: img };
  }

  var rows = [];
  function build(items) {
    var groups = (!reduce && items.length >= 6)
      ? [items.filter(function (_, k) { return k % 2 === 0; }), items.filter(function (_, k) { return k % 2 === 1; })]
      : [items];
    var idx = new Map(items.map(function (it, k) { return [it, k]; }));
    groups.forEach(function (g, r) {
      var row = el('div', 'reel-row'), track = el('div', 'reel-track'), set = el('div', 'reel-set');
      set.setAttribute('role', 'list');
      set.setAttribute('aria-label', groups.length > 1 ? 'Event images, row ' + (r + 1) : 'Event images');
      g.forEach(function (it) { var f = frame(it, idx.get(it)); it.img = f.img; it.btn = f.btn; set.appendChild(f.fig); });
      track.appendChild(set); row.appendChild(track); reel.appendChild(row);
      rows.push({ row: row, track: track, set: set, dir: r % 2 ? -1 : 1, speed: r % 2 ? 26 : 32, x: 0, segW: 0, copies: 0 });
    });
    reel.classList.toggle('still', reduce);
    reel.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.ev-open');
      if (!b || !reel.contains(b)) return;
      if (dragged) { e.preventDefault(); e.stopPropagation(); return; }
      var i = Number(b.getAttribute('data-i')) || 0;
      open(i, items[i].btn);   // focus returns to the real (focusable) frame, never a filler copy
    }, true);
    reel.addEventListener('keydown', function (e) {   // ← → move between frames of the same row
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var b = document.activeElement, set = b && b.closest && b.closest('.reel-set');
      if (!set || !reel.contains(set)) return;
      var all = Array.prototype.slice.call(set.querySelectorAll('.ev-open')), k = all.indexOf(b);
      var nb = all[(k + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
      if (nb) { e.preventDefault(); nb.focus(); }
    });
    sec.hidden = false;
    lightbox(items);
    if (!reduce) motion();
  }

  /* ---- seamless marquee: [set][copy]...[copy] where copies cover the band; x wraps every segW ---- */
  var dragged = false;
  function fill(R) {
    var bandW = reel.clientWidth || window.innerWidth;
    var gap = parseFloat(getComputedStyle(R.track).columnGap) || 0;
    var setW = R.set.offsetWidth + gap;
    if (!setW) return;
    var need = Math.max(1, Math.ceil(bandW / setW)) * 2;   // 2x the band = always covered while x wraps
    if (need !== R.copies + 1) {
      while (R.track.children.length > 1) R.track.removeChild(R.track.lastChild);
      for (var c = 1; c < need; c++) {
        var cp = R.set.cloneNode(true);
        cp.setAttribute('aria-hidden', 'true'); cp.removeAttribute('role'); cp.removeAttribute('aria-label');
        cp.querySelectorAll('.ev-open').forEach(function (b) { b.tabIndex = -1; });
        R.track.appendChild(cp);
      }
      R.copies = need - 1;
    }
    R.segW = setW * (need / 2);
  }
  function wrap(R) { if (!R.segW) return; while (R.x > 0) R.x -= R.segW; while (R.x <= -R.segW) R.x += R.segW; }
  function paint(R) { R.track.style.transform = 'translate3d(' + R.x.toFixed(2) + 'px,0,0)'; }

  function motion() {
    reel.classList.add('moving');
    rows.forEach(function (R) {
      fill(R); if (R.dir < 0) R.x = -R.segW / 2; wrap(R); paint(R);
      // keep the band itself from ever scrolling (focus could scroll an overflow box)
      R.row.addEventListener('scroll', function () { R.row.scrollLeft = 0; });
    });
    var hover = false, focus = false, visible = false, raf = 0, last = 0, holdUntil = 0;
    function running() { return visible && !hover && !focus && !drag && !document.hidden; }
    function tick(t) {
      raf = 0;
      if (!running()) { last = 0; return; }
      var dt = last ? Math.min(t - last, 64) / 1000 : 0; last = t;
      if (t >= holdUntil) rows.forEach(function (R) { R.x -= R.dir * R.speed * dt; wrap(R); paint(R); });
      raf = requestAnimationFrame(tick);
    }
    function go() { if (!raf && running()) raf = requestAnimationFrame(tick); }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; go(); }, { rootMargin: '80px 0px' }).observe(reel);
    } else { visible = true; }
    document.addEventListener('visibilitychange', go);
    reel.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') { hover = true; } });
    reel.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { hover = false; go(); } });
    reel.addEventListener('focusin', function (e) {
      var kb = true; try { kb = e.target.matches(':focus-visible'); } catch (_) {}
      if (!kb) return;   // a mouse click focuses the frame too; only keyboard focus stops the film
      focus = true;
      var b = e.target.closest && e.target.closest('.ev-open'), R = rows.filter(function (q) { return q.row.contains(b); })[0];
      if (!b || !R) return;
      var bandW = R.row.clientWidth, left = b.parentNode.offsetLeft + R.x;   // frame position inside the band
      if (left < 0 || left + b.offsetWidth > bandW) { R.x = Math.min(0, Math.max(-R.segW + 1, (bandW - b.offsetWidth) / 2 - b.parentNode.offsetLeft)); paint(R); }
      R.row.scrollLeft = 0;
    });
    reel.addEventListener('focusout', function (e) { if (!reel.contains(e.relatedTarget)) { focus = false; go(); } });

    /* drag / swipe to scrub (horizontal only; vertical swipes still scroll the page: touch-action pan-y) */
    var drag = null;
    rows.forEach(function (R) {
      R.row.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        drag = null; dragged = false;
        R.p = { id: e.pointerId, x0: e.clientX, from: R.x, moved: false };
      });
      R.row.addEventListener('pointermove', function (e) {
        var p = R.p; if (!p || p.id !== e.pointerId) return;
        var dx = e.clientX - p.x0;
        if (!p.moved) {
          if (Math.abs(dx) < 6) return;
          p.moved = true; drag = R; dragged = true; R.row.classList.add('dragging');
          try { R.row.setPointerCapture(e.pointerId); } catch (_) {}
        }
        R.x = p.from + dx; wrap(R); paint(R);
      });
      var end = function (e) {
        var p = R.p; if (!p || p.id !== e.pointerId) return;
        R.p = null;
        if (p.moved) {
          drag = null; R.row.classList.remove('dragging');
          holdUntil = performance.now() + 900;   // let the eye settle before the film moves again
          setTimeout(function () { dragged = false; }, 0);   // swallow the click that ends a drag
          go();
        }
      };
      R.row.addEventListener('pointerup', end);
      R.row.addEventListener('pointercancel', end);
    });

    var rt = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { rows.forEach(function (R) { fill(R); wrap(R); paint(R); }); }, 150);
    }, { passive: true });
    go();
  }

  var open = function () {};
  function lightbox(items) {
    var box = document.getElementById('evBox'), bimg = document.getElementById('evBoxImg'), bcap = document.getElementById('evBoxCap');
    if (!box || typeof box.showModal !== 'function' || !bimg) return;   // no <dialog>: photos still show in the strip
    var cur = 0, opener = null;
    function show(i) {
      cur = (i + items.length) % items.length;
      var it = items[cur];
      var shown = (it.img && it.img.currentSrc) || '';
      // full-size file (AVIF if the strip picked it), never the 800px copy — except on Save-Data
      bimg.src = lite ? (it.small || it.src) : (/\.avif$/i.test(shown) ? shown : it.src); bimg.alt = it.alt;
      if (it.w && it.h) { bimg.width = it.w; bimg.height = it.h; }
      bcap.textContent = [it.type, it.caption].filter(Boolean).join(' · ');
    }
    var many = items.length > 1;
    box.querySelector('.ev-prev').hidden = !many; box.querySelector('.ev-next').hidden = !many;
    box.querySelector('.ev-prev').addEventListener('click', function () { show(cur - 1); });
    box.querySelector('.ev-next').addEventListener('click', function () { show(cur + 1); });
    box.querySelector('.ev-close').addEventListener('click', function () { box.close(); });
    box.addEventListener('click', function (e) { if (e.target === box) box.close(); });   // tap the backdrop
    box.addEventListener('keydown', function (e) {
      if (!many) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
    });
    var x0 = null;
    box.addEventListener('touchstart', function (e) { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
    box.addEventListener('touchend', function (e) {
      if (x0 == null || !many) return;
      var dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : x0) - x0; x0 = null;
      if (Math.abs(dx) > 50) show(cur + (dx < 0 ? 1 : -1));
    }, { passive: true });
    box.addEventListener('close', function () { document.body.classList.remove('lock'); if (opener && document.contains(opener)) opener.focus(); });
    open = function (i, from) {
      opener = from; show(i);
      box.classList.toggle('still', reduce);
      box.showModal(); document.body.classList.add('lock');
      box.querySelector('.ev-close').focus();
    };
  }
})();
