/* Helm trial guide — a scripted (not AI) helper. No network calls; DOM built with createElement/textContent only. */
(function () {
  'use strict';
  var KEY = 'helm-guide-dismissed';
  var store = {
    get: function () { try { return window.localStorage.getItem(KEY); } catch (e) { return null; } },
    set: function () { try { window.localStorage.setItem(KEY, '1'); } catch (e) { /* storage blocked: fine */ } }
  };
  /* r21 mobile: the guide never floats over the page on phones/tablets (<768px) or after
     "Don't show again"; it is still one tap away from the in-page "Ask the trial guide" buttons
     ([data-guide-open]), which open it as a bottom sheet on small screens. */
  var muted = !!store.get();
  var smallMq = window.matchMedia('(max-width: 767px)');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TRIAL = '/login?trial=1#signup', SALES = 'mailto:sales@helm.events?subject=Helm%20demo';

  /* Script: each node has bot lines and the chips offered next. Add a node to extend the guide. */
  var CHIPS = { what: 'What is Helm?', price: 'See pricing', trial: 'How does the trial work?', wed: 'I run weddings', corp: 'I run corporate events', sales: 'Talk to sales' };
  var NODES = {
    hello: { say: ['Hi, I\'m the Helm guide.', 'I can point you to the right part of the page in a few taps. What would help?'], next: ['what', 'price', 'trial', 'wed', 'corp', 'sales'] },
    what: { say: ['Helm is one workspace for event studios: enquiries, measured layouts in 2D and 3D, live quotes, crew tasks, stock and payments — all on the same event.', 'Fewer spreadsheets and chat threads, and one set of numbers everyone trusts.'], next: ['trial', 'price', 'wed', 'corp'], link: ['See every module', '#modules'] },
    price: { say: ['Plans are priced per studio in USD, and every plan starts with the free trial.', 'The pricing section lists what each plan includes.'], next: ['trial', 'sales'], link: ['Jump to pricing', '#pricing'] },
    trial: { say: ['The trial runs for 8 days with the full product. No card is needed to start.', 'Set up your studio, draw a real venue, send a client a proposal — and keep everything if you continue.'], next: ['wed', 'corp', 'sales'], cta: true },
    wed: { say: ['Weddings are where Helm shines: garden and hall layouts to real measurements, menu packages, a 3D view the couple can approve, and an invitation website for the big day.', 'Crew get their tasks on their phones, so the florist and the generator are never a guess.'], next: ['trial', 'price'], cta: true },
    corp: { say: ['For galas, launches and conferences: stage and seating plans with exact clearances, versioned quotes, client e-approval and a run sheet per event.', 'Settlement and profit per event are worked out for you at close.'], next: ['trial', 'sales'], cta: true },
    sales: { say: ['Happy to set up a walkthrough for your team.', 'Email our sales team and we\'ll reply with a time that suits you.'], next: ['trial'], mail: true }
  };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(id) { var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), u = document.createElementNS(ns, 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); s.setAttribute('aria-hidden', 'true'); return s; }

  var root = el('div', 'hg'), launcher = el('button', 'hg-launch'), panel = el('div', 'hg-panel');
  launcher.type = 'button'; launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'hg-panel');
  var av = el('span', 'hg-av', 'H'); av.setAttribute('aria-hidden', 'true');
  var teaser = el('span', 'hg-tease', 'Questions about the trial?');
  launcher.appendChild(av); launcher.appendChild(teaser); launcher.setAttribute('aria-label', 'Open the Helm trial guide');

  panel.id = 'hg-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', 'hg-title'); panel.hidden = true;
  var head = el('div', 'hg-head'), hav = el('span', 'hg-av', 'H'); hav.setAttribute('aria-hidden', 'true');
  var ht = el('div', 'hg-ht'); var t = el('b', null, 'Helm guide'); t.id = 'hg-title'; ht.appendChild(t); ht.appendChild(el('span', null, 'Scripted helper · answers instantly'));
  var close = el('button', 'hg-x'); close.type = 'button'; close.setAttribute('aria-label', 'Close guide'); close.appendChild(svg('i-x'));
  var mute = el('button', 'hg-mute', 'Don\'t show again'); mute.type = 'button';
  head.appendChild(hav); head.appendChild(ht); head.appendChild(close);
  var log = el('div', 'hg-log'); log.tabIndex = -1; log.setAttribute('aria-live', 'polite'); log.setAttribute('role', 'log');
  var chips = el('div', 'hg-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Choose a question');
  var foot = el('div', 'hg-foot'); foot.appendChild(mute);
  panel.appendChild(head); panel.appendChild(log); panel.appendChild(chips); panel.appendChild(foot);
  root.appendChild(panel); root.appendChild(launcher);
  document.body.appendChild(root);

  var started = false, timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, reduce ? 0 : ms)); }
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function bot(text) { var p = el('p', 'hg-msg hg-bot', text); log.appendChild(p); scrollDown(); }
  function me(text) { var p = el('p', 'hg-msg hg-me', text); log.appendChild(p); scrollDown(); }
  function typing() { var d = el('p', 'hg-msg hg-bot hg-typing'); d.setAttribute('aria-hidden', 'true'); d.appendChild(el('i')); d.appendChild(el('i')); d.appendChild(el('i')); log.appendChild(d); scrollDown(); return d; }

  function run(key) {
    var n = NODES[key]; chips.textContent = ''; var delay = 0;
    n.say.forEach(function (line) {
      later(function () { var ty = typing(); later(function () { ty.remove(); bot(line); }, 520); }, delay); delay += 900;
    });
    later(function () {
      if (n.link) { var a = el('a', 'hg-link', n.link[0]); a.href = n.link[1]; a.addEventListener('click', function () { toggle(false); }); log.appendChild(a); }
      if (n.cta || n.mail) {
        var row = el('div', 'hg-ctas');
        var tr = el('a', 'hg-cta', 'Start 8-day free trial'); tr.href = TRIAL; row.appendChild(tr);
        if (n.mail) { var m = el('a', 'hg-cta2', 'Email sales'); m.href = SALES; row.appendChild(m); }
        log.appendChild(row);
      }
      scrollDown();
      n.next.forEach(function (k) {
        var b = el('button', 'hg-chip', CHIPS[k]); b.type = 'button';
        b.addEventListener('click', function () { log.focus({ preventScroll: true }); me(CHIPS[k]); run(k); });
        chips.appendChild(b);
      });
      var first = chips.querySelector('button'); if (first && panel.contains(document.activeElement)) first.focus();
    }, delay);
  }

  function focusables() { return Array.prototype.slice.call(panel.querySelectorAll('button, a[href]')).filter(function (x) { return x.offsetParent !== null; }); }
  var opener = null;   /* the in-page button that opened the guide, for focus return */
  function floating() { return !muted && !smallMq.matches; }
  function toggle(open, from) {
    panel.hidden = !open; root.classList.toggle('open', open); launcher.setAttribute('aria-expanded', String(open));
    root.classList.toggle('sheet', open && smallMq.matches);
    document.body.classList.toggle('hg-sheet-open', open && smallMq.matches);
    if (open) {
      opener = from || null;
      root.classList.add('show');
      if (!started) { started = true; run('hello'); }
      requestAnimationFrame(function () { close.focus(); });
    } else {
      if (!shown || !floating()) root.classList.remove('show');
      var back = opener && document.contains(opener) ? opener : (floating() ? launcher : null);
      opener = null;
      if (back) back.focus({ preventScroll: true });
    }
  }
  launcher.addEventListener('click', function () { toggle(panel.hidden); });
  close.addEventListener('click', function () { toggle(false); });
  mute.addEventListener('click', function () { store.set(); muted = true; shown = false; toggle(false); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-guide-open]'), function (b) {
    b.hidden = false;
    b.addEventListener('click', function () { toggle(true, b); });
  });
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); toggle(false); return; }
    if (e.key !== 'Tab') return;
    var f = focusables(); if (!f.length) return;
    var a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  });

  /* appear after a short delay AND some scroll depth, so it never interrupts the hero */
  var shown = false, timeOk = false;
  function maybeShow() {
    if (shown || !timeOk || !floating()) return;
    var depth = (window.scrollY || 0) / Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (depth < 0.12) return;
    shown = true; root.classList.add('show'); window.removeEventListener('scroll', maybeShow);
    setTimeout(function () { root.classList.add('tease-off'); }, 9000);
  }
  setTimeout(function () { timeOk = true; maybeShow(); }, 6000);
  window.addEventListener('scroll', maybeShow, { passive: true });
})();
