#!/usr/bin/env node
/* tour-positioning.test.mjs — guards the mobile guided-tour spotlight fix.
 *
 * The bug: place() scrolled the target into view with behavior:"smooth" and then
 * read getBoundingClientRect() after a FIXED 240ms setTimeout. On mobile the
 * smooth scroll travels farther/slower, so at 240ms it was still mid-scroll and
 * the spotlight ring/tip/arrow were pinned where the target USED to be
 * ("highlighted boxes showing at a different place"). There was also no re-sync
 * when the page scrolled afterwards.
 *
 * The fix (public/tour.js) must keep ALL of these invariants, which this test
 * asserts at the source level (geometry needs a real browser; the browser run is
 * the companion check). It is pure Node, no deps.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'tour.js'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('positioning is split into a pure position() function', () =>
  assert.ok(/function\s+position\s*\(\s*\)/.test(SRC), 'position() must exist as its own function'));

t('a capturing scroll listener re-glues the spotlight, and is removed on end', () => {
  assert.ok(/addEventListener\(\s*["']scroll["']\s*,\s*onView\s*,\s*true\s*\)/.test(SRC),
    'start() must add a capturing scroll listener (onView)');
  assert.ok(/removeEventListener\(\s*["']scroll["']\s*,\s*onView\s*,\s*true\s*\)/.test(SRC),
    'end() must remove the capturing scroll listener');
});

t('resize is handled by the same re-glue handler (not a re-scroll)', () => {
  assert.ok(/addEventListener\(\s*["']resize["']\s*,\s*onView\s*\)/.test(SRC), 'resize → onView');
  assert.ok(/removeEventListener\(\s*["']resize["']\s*,\s*onView\s*\)/.test(SRC), 'resize listener removed on end');
});

t('place() positions IMMEDIATELY, before the rAF settle loop (robust when rAF is throttled)', () => {
  const afterScroll = SRC.indexOf('scrollIntoView');
  assert.ok(afterScroll > -1, 'place() must scroll the target into view');
  const idxPos = SRC.indexOf('position();', afterScroll);     // immediate position() in place()
  const idxSettle = SRC.indexOf('function settle', afterScroll);
  assert.ok(idxPos > -1, 'place() must call position() synchronously after scrollIntoView');
  assert.ok(idxSettle > -1 && idxPos < idxSettle,
    'the immediate position() must precede the settle() rAF loop (so the ring is never stranded)');
});

t('the old fixed-240ms positioning timeout is gone', () =>
  assert.ok(!/\}\s*,\s*240\s*\)\s*;/.test(SRC), 'must not re-introduce the setTimeout(…,240) positioning race'));

t('the scroll settle loop has a hard frame cap (never hangs)', () => {
  assert.ok(/requestAnimationFrame\(\s*settle\s*\)/.test(SRC), 'settle uses requestAnimationFrame');
  assert.ok(/frames\s*>\s*60/.test(SRC), 'settle has a ~1s (60-frame) hard cap');
});

t('the tip is clamped into the viewport (cannot render off a short phone screen)', () =>
  assert.ok(/Math\.min\(Math\.max\(12,\s*ty\)/.test(SRC) || /ty\s*=\s*Math\.min\(Math\.max/.test(SRC),
    'vertical tip position is clamped to [12, innerHeight - th - 12]'));

/* ---- resize / layout-change robustness (source level) ------------------ */
t('orientationchange + visualViewport re-glue the spotlight, and are removed on end', () => {
  assert.ok(/addEventListener\(\s*["']orientationchange["']\s*,\s*onView\s*\)/.test(SRC));
  assert.ok(/removeEventListener\(\s*["']orientationchange["']\s*,\s*onView\s*\)/.test(SRC));
  assert.ok(/visualViewport\.addEventListener\(\s*["']resize["']/.test(SRC));
  assert.ok(/visualViewport\.removeEventListener\(\s*["']resize["']/.test(SRC));
});
t('a ResizeObserver watches the document AND the current target (layout shifts), disconnected on end', () => {
  assert.ok(/new ResizeObserver\(\s*onView\s*\)/.test(SRC));
  assert.ok(/ro\.observe\(\s*document\.documentElement\s*\)/.test(SRC));
  assert.ok(/ro\.observe\(\s*tgt\s*\)/.test(SRC));
  assert.ok(/ro\.disconnect\(\)/.test(SRC));
});
t('the ring has no CSS transition (it must not trail the target during scroll/resize)', () =>
  assert.ok(!/\.ring\{[^}]*transition/.test(SRC)));
t('steps are NOT permanently dropped at start() because of a hidden-at-this-breakpoint target', () =>
  assert.ok(/\.filter\(\s*s\s*=>\s*document\.querySelector\(\s*s\.sel\s*\)\s*\)/.test(SRC)));

t('dashboard (first-login tour) delegates to the shared engine — no private fixed-timeout copy', () => {
  const D = readFileSync(join(ROOT, 'public', 'dashboard.html'), 'utf8');
  assert.ok(/<script src="tour\.js\?v=\d+"><\/script>/.test(D), 'dashboard loads tour.js');
  assert.ok(/HelmTour\.start\(\s*TOUR\s*,\s*["']bp_seen_tour["']\s*\)/.test(D), 'startTour → HelmTour.start(TOUR, "bp_seen_tour")');
  assert.ok(!/function\s+placeTour/.test(D) && !/\},\s*260\s*\)/.test(D), 'old placeTour + 260ms timeout removed');
});
t('clipping ancestors (scrolling nav bars) are intersected into the measured rect', () =>
  assert.ok(/function\s+visibleRect\s*\(/.test(SRC) && /layout\(\s*vr\s*,/.test(SRC)));

/* ---- geometry: run the real layout() from tour.js in a stubbed DOM ------- */
import vm from 'node:vm';
function loadTour(elements = {}) {
  const noop = () => {};
  const mk = () => ({ style: {}, addEventListener: noop, appendChild: noop, remove: noop, querySelector: () => null });
  const document = {
    readyState: 'complete', head: { appendChild: noop }, body: { appendChild: noop },
    documentElement: { clientWidth: 1280, clientHeight: 800 },
    createElement: mk, getElementById: () => null, addEventListener: noop,
    querySelector: sel => elements[sel] || null,
  };
  const window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
  const ctx = { window, document, location: { pathname: '/quotes.html' }, localStorage: { getItem: () => null, setItem: noop },
    getComputedStyle: el => el._cs || { display: 'block', visibility: 'visible' }, requestAnimationFrame: noop, console };
  vm.runInNewContext(SRC, ctx);
  return window.HelmTour;
}
const T = loadTour();
const rect = (left, top, w, h) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
const inside = (L, vw, vh, tw, th) => L.tip.left >= 12 && L.tip.top >= 12 && L.tip.left + tw <= vw - 12 + 0.01 && L.tip.top + th <= vh - 12 + 0.01;

t('layout(): tip below the target on a desktop viewport, arrow points at target centre', () => {
  const L = T._layout(rect(500, 100, 120, 40), 1280, 800, 320, 170);
  assert.equal(L.side, 'below'); assert.ok(inside(L, 1280, 800, 320, 170));
  assert.ok(Math.abs(L.arrow.left + 14 - 560) < 1, 'arrow centred on target');
  assert.equal(L.ring.left, 494); assert.equal(L.ring.top, 94);
});
t('layout(): flips ABOVE when a bottom-of-screen target has no room below', () => {
  const L = T._layout(rect(500, 700, 120, 40), 1280, 800, 320, 170);
  assert.equal(L.side, 'above'); assert.ok(inside(L, 1280, 800, 320, 170));
});
t('layout(): flips to the SIDE for a tall target with no room above/below', () => {
  const L = T._layout(rect(40, 40, 300, 720), 1280, 800, 320, 170);
  assert.equal(L.side, 'right'); assert.ok(inside(L, 1280, 800, 320, 170));
});
t('layout(): RESIZE — same target re-laid-out for a 375x640 phone stays fully on-screen', () => {
  const desk = T._layout(rect(1100, 60, 120, 40), 1280, 800, 320, 170);
  const phone = T._layout(rect(300, 60, 60, 36), 375, 640, 320, 170);
  assert.ok(inside(desk, 1280, 800, 320, 170));
  assert.ok(inside(phone, 375, 640, 320, 170), 'tip clamped horizontally on a narrow screen');
  assert.ok(phone.arrow.left <= 375 - 28 && phone.arrow.left >= 2, 'arrow clamped');
});
t('layout(): very narrow viewport shrinks the tip width to fit', () => {
  const L = T._layout(rect(10, 10, 50, 30), 280, 500, 320, 170);
  assert.equal(L.tip.width, 256); assert.ok(L.tip.left >= 12);
});
t('layout(): huge / partly off-screen target has its ring clipped to the viewport', () => {
  const L = T._layout(rect(-50, -100, 2000, 2000), 1280, 800, 320, 170);
  assert.ok(L.ring.left >= 0 && L.ring.top >= 0 && L.ring.left + L.ring.width <= 1280 && L.ring.top + L.ring.height <= 800);
  assert.ok(inside(L, 1280, 800, 320, 170));
});
t('layout(): target scrolled fully out of view → no ring sliver; card + arrow at that edge point toward it', () => {
  const up = T._layout(rect(10, -600, 300, 50), 375, 812, 320, 170);
  assert.equal(up.ring, null); assert.equal(up.arrow.glyph, '▲'); assert.ok(up.arrow.top <= 4); assert.ok(inside(up, 375, 812, 320, 170));
  const down = T._layout(rect(10, 900, 300, 50), 375, 812, 320, 170);
  assert.equal(down.ring, null); assert.equal(down.arrow.glyph, '▼'); assert.ok(inside(down, 375, 812, 320, 170));
});
t('layout(null): hidden target → centered step, no ring/arrow', () => {
  const L = T._layout(null, 1280, 800, 320, 170);
  assert.equal(L.centered, true); assert.equal(L.ring, null); assert.equal(L.arrow, null);
  assert.equal(L.tip.left, 480); assert.equal(L.tip.top, 315);
});

t('present(): display:none / [hidden] ancestor / zero-size targets are NOT visible; a normal one is', () => {
  const mkEl = (o) => Object.assign({ hidden: false, closest: () => null, getBoundingClientRect: () => rect(0, 0, 100, 30) }, o);
  const T2 = loadTour({
    '#ok': mkEl({}),
    '#none': mkEl({ _cs: { display: 'none', visibility: 'visible' } }),
    '#inHidden': mkEl({ closest: () => ({}) }),
    '#zero': mkEl({ getBoundingClientRect: () => rect(0, 0, 0, 0) }),
    '#collapsed': mkEl({ checkVisibility: () => false }),
  });
  assert.ok(T2._present('#ok'));
  for (const s of ['#none', '#inHidden', '#zero', '#collapsed', '#missing']) assert.equal(T2._present(s), null, s);
});

console.log(`\ntour-positioning: ${passed} assertion(s) passed.`);
