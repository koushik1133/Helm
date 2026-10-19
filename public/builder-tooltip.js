/* builder-tooltip.js - r21 builder hover: one small, themed tooltip for the layout builder instead of the
 * browser's native title box (owner 2026-10-19: the dark native box under "Create layout" dropped over the
 * second header row and covered "Save & back to quote" / the version picker).
 *
 * How it works
 *   - Markup keeps its plain title="" attributes (screen readers, tests and other scripts still read them).
 *     While the pointer / keyboard focus is on a control, its title is lifted into a WeakMap so the native box
 *     never appears, and it is put back the moment the tooltip closes (a title the page changed meanwhile wins).
 *   - Shows after ~400 ms (quicker when moving between neighbouring controls), on mouse / pen hover and on
 *     keyboard focus (:focus-visible) only - never for touch. Closes on leave, click, Esc, scroll, wheel,
 *     resize and window blur.
 *   - Placement with collision detection: below the control, else above; in the header also beside it - the
 *     first spot that stays on screen and covers NO other header control wins (so a first-row tooltip never
 *     drops over the second row). A crowded toolbar falls back to just under the whole header (over the canvas,
 *     never over a toolbar row). Items in a dropdown menu open beside the menu. Always clamped to the window.
 *   - A trailing shortcut "(⌘Z)" / "(F)" / "(Esc)" is drawn as a key chip. A title that only repeats the
 *     control's visible text is not shown (it adds nothing).
 *   - Money stays private: shell-b-privacy.js already lifts money titles away while amounts are hidden, so they
 *     are never shown here either.
 */
(function () {
  'use strict';
  var G = typeof window !== 'undefined' ? window : null;
  if (!G || !G.document || G.__helmBuilderTip) return;
  G.__helmBuilderTip = true;
  var doc = G.document;

  var DELAY = 400, WARM = 90, WARM_FOR = 600, GAP = 6, EDGE = 8;
  var held = new WeakMap();        // element -> its title text while we hold it
  var tip = null, txt = null, key = null;
  var anchor = null, timer = 0, lastHide = 0, lastPointer = 'mouse', lastTouchAt = 0, suppressed = null, mo = null, prevDesc = null;

  function build() {
    if (tip) return;
    tip = doc.createElement('div');
    tip.className = 'btip'; tip.id = 'btip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
    txt = doc.createElement('span'); txt.className = 'btip-t';
    key = doc.createElement('kbd'); key.className = 'btip-k';
    tip.append(txt, key);
    (doc.body || doc.documentElement).appendChild(tip);
  }

  function tipText(el) {
    if (held.has(el)) return held.get(el);
    var t = el.getAttribute && el.getAttribute('title');
    return t == null ? '' : t;
  }
  // the control a tooltip belongs to (nearest element with a title, or the one we are holding)
  function host(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el === tip) return null;
      if (held.has(el)) return el;
      if (el.hasAttribute('title')) {
        if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;   // SVG title attrs: leave them to the browser
        return el;
      }
      if (el.tagName === 'BODY' || el.tagName === 'HTML') return null;
    }
    return null;
  }
  function excluded(el) {
    return !el || !el.isConnected || !!el.closest('.htour,.htrm,[data-no-tip],iframe') || el.tagName === 'OPTION';
  }
  function visibleText(el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim(); }

  function hold(el) {
    if (held.has(el)) return;
    var t = el.getAttribute('title');
    if (t == null) return;
    held.set(el, t); el.removeAttribute('title');
    // keep following the page: a new title written while we hold it updates the tooltip and stays lifted
    if (G.MutationObserver) {
      mo = new G.MutationObserver(function () {
        if (!el.hasAttribute('title')) return;
        var nt = el.getAttribute('title'); held.set(el, nt); el.removeAttribute('title');
        if (anchor === el && !tip.hidden) { if (!fill(el)) hide(); else place(el); }
      });
      mo.observe(el, { attributes: true, attributeFilter: ['title'] });
    }
  }
  function release(el) {
    if (mo) { mo.disconnect(); mo = null; }
    if (!el || !held.has(el)) return;
    var t = held.get(el); held.delete(el);
    if (!el.hasAttribute('title')) el.setAttribute('title', t);
  }

  var KEY_RE = /\s*\(((?:[⌘⇧⌥⌃]+\s?[A-Za-z0-9]{0,3})|[A-Z0-9]|Esc|Enter|Del|Space|\?)\)\s*$/;
  function fill(el) {
    var t = String(tipText(el) || '').trim();
    if (!t) return false;
    if (t === visibleText(el)) return false;          // nothing to add beyond the visible label
    var m = KEY_RE.exec(t), k = '';
    if (m) { k = m[1]; t = t.slice(0, m.index).trim(); }
    txt.textContent = t; key.textContent = k; key.hidden = !k;
    return !!(t || k);
  }

  // the header controls a tooltip must not cover (anything the user could click or read next)
  var CTRL = 'button,select,input:not([type="hidden"]),a[href],summary,.seg,.capmeter,.qbadge,.kbd,.savestate';
  function obstacles(hdr, el) {
    var out = [];
    hdr.querySelectorAll(CTRL).forEach(function (c) {
      if (c === el || c.contains(el) || el.contains(c) || c === tip) return;
      if (c.checkVisibility && !c.checkVisibility()) return;          // closed menus, hidden controls
      var r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    });
    return out;
  }
  function hits(box, list) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (box.left < r.right + 2 && box.left + box.w > r.left - 2 && box.top < r.bottom + 2 && box.top + box.h > r.top - 2) return true;
    }
    return false;
  }
  function place(el) {
    var r = el.getBoundingClientRect();
    var vw = doc.documentElement.clientWidth || G.innerWidth, vh = doc.documentElement.clientHeight || G.innerHeight;
    tip.style.left = '0px'; tip.style.top = '0px'; tip.style.maxWidth = Math.min(360, vw - EDGE * 2) + 'px';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var clampX = function (x) { return Math.max(EDGE, Math.min(x, vw - w - EDGE)); };
    var fits = function (b) { return b.left >= EDGE - 0.5 && b.left + w <= vw - EDGE + 0.5 && b.top >= EDGE - 0.5 && b.top + h <= vh - EDGE + 0.5; };
    var cx = clampX(r.left + r.width / 2 - w / 2), cy = Math.max(EDGE, Math.min(r.top + (r.height - h) / 2, vh - h - EDGE));
    var menu = el.closest('.hmenu-pop,[role="menu"]');
    var hdr = !menu && el.closest('header');
    var pick = null, cands;
    if (menu) {
      var mr = menu.getBoundingClientRect();
      cands = [{ side: 'right', left: mr.right + GAP, top: cy }, { side: 'left', left: mr.left - GAP - w, top: cy }];
    } else {
      cands = [{ side: 'below', left: cx, top: r.bottom + GAP }, { side: 'above', left: cx, top: r.top - GAP - h }];
      if (hdr) cands.push({ side: 'right', left: r.right + GAP, top: cy }, { side: 'left', left: r.left - GAP - w, top: cy });
    }
    var obs = hdr ? obstacles(hdr, el) : [];
    for (var i = 0; i < cands.length && !pick; i++) {
      var c = cands[i], box = { left: c.left, top: c.top, w: w, h: h };
      if (fits(box) && !hits(box, obs)) pick = c;
    }
    // a crowded toolbar: open under the whole header - over the canvas, never over a toolbar row
    if (!pick && hdr) pick = { side: 'below', left: cx, top: hdr.getBoundingClientRect().bottom + GAP };
    if (!pick) pick = cands[0].top + h <= vh - EDGE ? cands[0] : cands[1] || cands[0];
    tip.dataset.side = pick.side;
    var left = Math.max(EDGE, Math.min(pick.left, vw - w - EDGE)), top = Math.max(EDGE, Math.min(pick.top, vh - h - EDGE));
    tip.style.left = Math.round(left) + 'px'; tip.style.top = Math.round(top) + 'px';
  }

  // theme tokens live on the builder chrome (header / aside / modals), not on <body>: borrow them from the control
  var TOKENS = ['--panel', '--panel-2', '--line', '--ink', '--ink-2', '--ink-3', '--font', '--mono'];
  function theme(el) {
    var cs = G.getComputedStyle(el);
    TOKENS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) tip.style.setProperty(p, v.trim()); else tip.style.removeProperty(p); });
  }

  function show(el) {
    timer = 0;
    if (excluded(el) || anchor !== el) return;
    build();
    if (!fill(el)) return;
    theme(el);
    tip.hidden = false;
    place(el);
    tip.classList.add('on');
    var d = el.getAttribute('aria-describedby');
    prevDesc = d;
    if (!d || d.split(/\s+/).indexOf('btip') < 0) el.setAttribute('aria-describedby', (d ? d + ' ' : '') + 'btip');
  }
  function hide() {
    if (timer) { G.clearTimeout(timer); timer = 0; }
    var el = anchor; anchor = null;
    if (tip && !tip.hidden) { tip.hidden = true; tip.classList.remove('on'); lastHide = Date.now(); }
    if (el) {
      if (prevDesc == null) el.removeAttribute('aria-describedby'); else el.setAttribute('aria-describedby', prevDesc);
      prevDesc = null;
      release(el);
    }
  }
  function arm(el) {
    if (el === anchor) return;
    hide();
    if (excluded(el) || el === suppressed) return;
    if (!String(el.getAttribute('title') || '').trim()) return;
    anchor = el;
    hold(el);                                           // the native box must never start its own timer
    timer = G.setTimeout(function () { show(el); }, Date.now() - lastHide < WARM_FOR ? WARM : DELAY);
  }

  function touchish() { return lastPointer === 'touch' || Date.now() - lastTouchAt < 900; }

  doc.addEventListener('pointerover', function (e) {
    lastPointer = e.pointerType || 'mouse';
    if (lastPointer === 'touch') { lastTouchAt = Date.now(); hide(); return; }
    var el = host(e.target);
    if (!el) { if (anchor && !anchor.contains(e.target)) hide(); return; }
    if (el !== suppressed) suppressed = null;
    arm(el);
  }, true);
  doc.addEventListener('pointerout', function (e) {
    if (!anchor) { if (suppressed && !(e.relatedTarget && suppressed.contains(e.relatedTarget))) suppressed = null; return; }
    if (e.relatedTarget && anchor.contains(e.relatedTarget)) return;
    if (suppressed && !(e.relatedTarget && suppressed.contains(e.relatedTarget))) suppressed = null;
    if (doc.activeElement === anchor && anchor.matches(':focus-visible')) return;   // keyboard focus keeps it
    hide();
  }, true);
  doc.addEventListener('pointerdown', function (e) {
    lastPointer = e.pointerType || 'mouse';
    if (lastPointer === 'touch') lastTouchAt = Date.now();
    var el = anchor; hide();
    if (el && el.contains(e.target)) suppressed = el;   // no tooltip again until the pointer leaves this control
  }, true);
  doc.addEventListener('focusin', function (e) {
    if (touchish()) return;
    var el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!el || !el.hasAttribute('title') && !held.has(el)) return;
    var fv = false; try { fv = el.matches(':focus-visible'); } catch (_) { fv = false; }
    if (!fv) return;
    arm(el);
  }, true);
  doc.addEventListener('focusout', function (e) { if (anchor && e.target === anchor) hide(); }, true);
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') { if (anchor) { var el = anchor; hide(); suppressed = el; } return; }
    if (anchor && (e.key === 'Enter' || e.key === ' ')) hide();
  }, true);
  G.addEventListener('scroll', function () { if (anchor) hide(); }, true);
  G.addEventListener('wheel', function () { if (anchor) hide(); }, { capture: true, passive: true });
  G.addEventListener('resize', function () { if (anchor) hide(); });
  G.addEventListener('blur', function () { if (anchor) hide(); });

  // test hook (node / harness): the pure parts
  G.__helmBuilderTipApi = { KEY_RE: KEY_RE, hide: hide };
})();
