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

console.log(`\ntour-positioning: ${passed} assertion(s) passed.`);
