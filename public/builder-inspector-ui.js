/* builder-inspector-ui.js — R71
 *
 * Two purely-presentational enhancements for the builder's RIGHT inspector panel.
 * No markup/behaviour change to values: steppers call the native stepUp()/stepDown()
 * and fire the same input/change events the old native spin buttons did.
 *
 *  1) Clean number steppers — replaces the browser's misaligned native spin buttons
 *     (which overlapped the field border and the unit label) with a tidy up/down
 *     control that sits inside the field, vertically centred, clear of the radius.
 *
 *  2) Drag-to-resize section dividers — the lines between the stacked right-panel
 *     sections (Menu package & guests / Price breakdown / Inspector) become splitter
 *     handles so the owner can adjust the height split. Transient (resets on reload).
 *
 * Vanilla JS, no library, no inline (keeps the hash-based CSP untouched). Chevrons are
 * drawn in CSS, so this file never touches innerHTML.
 */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------------
   * 1) Number steppers
   * -------------------------------------------------------------------------- */
  var STEP_SEL = '#rightPanel input[type="number"]';

  function fire(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function step(input, dir) {
    if (input.disabled || input.readOnly) return;
    try { dir > 0 ? input.stepUp() : input.stepDown(); }
    catch (e) {                                  // empty / non-numeric → seed from min or 0
      var min = parseFloat(input.min);
      input.value = String(isNaN(min) ? 0 : min);
    }
    fire(input);
  }

  function makeBtn(dir) {
    var b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;                             // keep tab order on the input itself
    b.className = 'nstep-btn ' + (dir > 0 ? 'up' : 'down');
    b.setAttribute('aria-hidden', 'true');
    b.dataset.dir = String(dir);
    return b;
  }

  function enhance(input) {
    if (input.dataset.nstep) return;
    input.dataset.nstep = '1';

    // The input needs a positioned wrapper for the absolute stepper.
    // X/Y/Width/Height/Diameter/Spacing already live inside `.unit` (position:relative);
    // bare inputs (rows, cols, seats, guests…) get a `.numwrap` of their own.
    var wrap = input.parentElement;
    if (wrap && wrap.classList.contains('unit')) {
      wrap.classList.add('has-step');
    } else {
      wrap = document.createElement('span');
      wrap.className = 'numwrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
    }

    var nav = document.createElement('span');
    nav.className = 'nstep';
    nav.appendChild(makeBtn(1));
    nav.appendChild(makeBtn(-1));
    wrap.appendChild(nav);
  }

  function scanSteppers(root) {
    var list = (root || document).querySelectorAll
      ? root.querySelectorAll('input[type="number"]') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.closest && el.closest('#rightPanel')) enhance(el);
    }
  }

  // Press-and-hold auto-repeat (mirrors a native spin button) via one delegated listener.
  var repeatTimer = null, repeatDelay = null;
  function stopRepeat() {
    if (repeatDelay) { clearTimeout(repeatDelay); repeatDelay = null; }
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
  }

  function wireStepperEvents() {
    var panel = document.getElementById('rightPanel');
    if (!panel || panel.dataset.nstepWired) return;
    panel.dataset.nstepWired = '1';

    panel.addEventListener('pointerdown', function (e) {
      var btn = e.target.closest && e.target.closest('.nstep-btn');
      if (!btn) return;
      e.preventDefault();                                   // don't steal focus/selection
      var dir = Number(btn.dataset.dir) || 0;
      var input = btn.closest('.numwrap, .unit').querySelector('input[type="number"]');
      if (!input) return;
      step(input, dir);                                     // immediate first step
      stopRepeat();
      repeatDelay = setTimeout(function () {
        repeatTimer = setInterval(function () { step(input, dir); }, 75);
      }, 380);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(function (ev) {
      panel.addEventListener(ev, stopRepeat, true);
    });
    window.addEventListener('pointerup', stopRepeat, true);
  }

  /* ----------------------------------------------------------------------------
   * 2) Resizable section dividers (splitter)
   * -------------------------------------------------------------------------- */
  var MIN_SEC = 44;        // a section can't collapse below this
  var MIN_SCROLLER = 90;   // the inspector (flex:1) always keeps at least this

  function addResizer(section) {
    if (!section || section.dataset.hasResizer) return;
    section.dataset.hasResizer = '1';
    var bar = document.createElement('div');
    bar.className = 'insp-resizer';
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', 'horizontal');
    bar.setAttribute('aria-label', 'Resize section');
    section.parentNode.insertBefore(bar, section.nextSibling);

    var startY = 0, startH = 0, maxGrow = 0, dragging = false;

    function onMove(e) {
      if (!dragging) return;
      var delta = e.clientY - startY;
      var h = Math.max(MIN_SEC, Math.min(startH + delta, startH + maxGrow));
      section.style.height = h + 'px';
      section.style.maxHeight = 'none';
      section.style.flex = '0 0 auto';
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      document.body.classList.remove('insp-resizing');
      try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var scroller = document.querySelector('#rightPanel .scroller');
      if (!scroller) return;
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startH = section.getBoundingClientRect().height;
      // only the flex:1 inspector gives room, so growth is bounded by its spare height
      maxGrow = Math.max(0, scroller.getBoundingClientRect().height - MIN_SCROLLER);
      bar.classList.add('dragging');
      document.body.classList.add('insp-resizing');
      try { bar.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function wireResizers() {
    var panel = document.getElementById('rightPanel');
    if (!panel) return;
    var boxes = panel.querySelectorAll('.pricebox');   // #pkgPanel, #pricePanel
    if (!boxes.length) return;
    panel.classList.add('has-resizers');
    for (var i = 0; i < boxes.length; i++) addResizer(boxes[i]);
  }

  /* ----------------------------------------------------------------------------
   * init + keep up with dynamic re-renders
   * -------------------------------------------------------------------------- */
  function init() {
    var panel = document.getElementById('rightPanel');
    if (!panel) return;
    wireStepperEvents();
    wireResizers();
    scanSteppers(panel);

    // The inspector + price panels are re-rendered on selection/price changes;
    // re-attach steppers to any freshly-created number inputs.
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1) {
            if (n.matches && n.matches('input[type="number"]') &&
                n.closest('#rightPanel')) enhance(n);
            else scanSteppers(n);
          }
        }
      }
    });
    mo.observe(panel, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
