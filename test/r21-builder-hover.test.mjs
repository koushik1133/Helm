// Builder round 21 (fix/r21-builder-hover) - owner 2026-10-19, live builder at 1440 wide:
//   1  hovering "Create layout" showed the dark native title box BELOW the button, over the second header row
//      ("Save & back to quote", the version picker). The builder now has its own small themed tooltip
//      (builder-tooltip.js): ~400 ms delay, collision-aware placement (never over another header control;
//      a crowded toolbar falls back to under the whole header), keyboard focus, Esc / scroll / click dismiss,
//      none on touch; the title attributes stay in the markup.
//   2  "Create layout" (and the other primary header buttons) painted like plain buttons: a calm hairline rule
//      out-ranked .tbtn.primary. They are solid accent again, white text.
//   3  header tidy at 1280 / 1440: one 30px control height, one gap inside / between groups, no dangling dividers.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

const html = read('public/builder.html'), cap = read('public/capture.html'), css = read('public/builder.css'),
  v2 = read('public/builder-v2.css'), js = read('public/builder-tooltip.js'), wiz = read('public/layout-wizard.js');
const head = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];

t('the builder (and its capture host) load the tooltip script after the header scripts', () => {
  assert.match(html, /<script src="fullscreen\.js\?v=\d+"><\/script>\n<script src="builder-tooltip\.js\?v=\d+"><\/script>/);
  assert.match(cap, /<script src="builder-tooltip\.js\?v=\d+"><\/script>/, 'capture.html is regenerated from builder.html');
});

t('Create layout: short title (the long description moved out), same id / label / class', () => {
  assert.match(head, /<button class="tbtn primary" id="customBtn" title="Build a layout from your hall size, guests and seating">✨ Create layout<\/button>/);
  assert.ok(!/Create a layout from your requirements/.test(html + wiz), 'old long title gone (layout-wizard.js re-sets it too)');
  assert.match(wiz, /b\.title = 'Build a layout from your hall size, guests and seating';/);
});

t('primary header buttons are solid accent again (beat the hairline rule)', () => {
  assert.match(v2, /html\[data-hb-theme\] :is\(header,aside,\.modal,\.tools3d,\.hmenu-pop\) \.tbtn\.primary \{ background:var\(--accent\); color:var\(--acc-ink\);/);
  assert.match(v2, /\.tbtn\.primary:hover \{ background:var\(--accent-2\); color:var\(--acc-ink\);/);
});

t('header tidy: one control height, group gaps, no dangling dividers (>=721px only; phones unchanged)', () => {
  const blk = v2.slice(v2.indexOf('r21 builder hover: a tidier toolbar'));
  assert.match(blk, /@media \(min-width:721px\)\{/);
  assert.match(blk, /header > \.hsep \{ display:none; \}/);
  assert.match(blk, /header :is\(select,\.tbtn,\.nameinput,\.capmeter\) \{ height:30px; \}/);
  assert.match(blk, /header \.seg button \{ height:24px;/);
});

t('tooltip: themed, fixed, never on touch, reduced motion respected', () => {
  assert.match(css, /\.btip\{position:fixed;[^}]*pointer-events:none;[^}]*background:var\(--panel,#fff\);color:var\(--ink-2,#3a3a3a\)/);
  assert.match(css, /@media \(hover:none\)\{ \.btip\{display:none!important\} \}/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{ \.btip\{transition:none\} \}/);
});

t('tooltip script: delay, touch skip, keyboard focus, dismissals, collision placement, title restored', () => {
  assert.match(js, /var DELAY = 400,/);
  assert.match(js, /if \(lastPointer === 'touch'\) \{ lastTouchAt = Date\.now\(\); hide\(\); return; \}/);
  assert.match(js, /fv = el\.matches\(':focus-visible'\)/);
  assert.match(js, /e\.key === 'Escape'/);
  assert.match(js, /G\.addEventListener\('scroll', function \(\) \{ if \(anchor\) hide\(\); \}, true\);/);
  assert.match(js, /doc\.addEventListener\('pointerdown'/);
  assert.match(js, /if \(fits\(box\) && !hits\(box, obs\)\) pick = c;/, 'first spot that covers no other header control');
  assert.match(js, /if \(!pick && hdr\) pick = \{ side: 'below', left: cx, top: hdr\.getBoundingClientRect\(\)\.bottom \+ GAP \};/, 'fallback: under the whole header');
  assert.match(js, /if \(!el\.hasAttribute\('title'\)\) el\.setAttribute\('title', t\);/, 'title put back (a newer page title wins)');
  assert.match(js, /el\.setAttribute\('aria-describedby'/);
  assert.ok(!/innerHTML/.test(js), 'text only (textContent) - no HTML sinks');
});

t('shortcut chip parsing', () => {
  const G = { document: null }; // the IIFE bails without a DOM; evaluate the regex on its own
  const m = /var KEY_RE = (\/.*\/);/.exec(js); assert.ok(m);
  const KEY_RE = vm.runInNewContext(m[1], G);
  const split = (s) => { const r = KEY_RE.exec(s); return r ? [s.slice(0, r.index).trim(), r[1]] : [s, '']; };
  assert.deepEqual(split('Undo (⌘Z)'), ['Undo', '⌘Z']);
  assert.deepEqual(split('Redo (⌘⇧Z)'), ['Redo', '⌘⇧Z']);
  assert.deepEqual(split('Fullscreen (F)'), ['Fullscreen', 'F']);
  assert.deepEqual(split('Exit fullscreen (Esc)'), ['Exit fullscreen', 'Esc']);
  assert.deepEqual(split('Guided 3D walk through the venue, stop by stop (← → keys, Esc to exit)'), ['Guided 3D walk through the venue, stop by stop (← → keys, Esc to exit)', '']);
  assert.deepEqual(split('Quote code · current version'), ['Quote code · current version', '']);
});

t('header ids unchanged (tests + the tour rely on them)', () => {
  const ids = [...head.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
  for (const id of ['preset', 'refField', 'customBtn', 'unitSel', 'snapBtn', 'viewSeg', 'measureBtn', 'undoBtn', 'projName', 'saveBtn', 'loadBtn', 'moreMenu', 'capInput', 'capMeter'])
    assert.ok(ids.includes(id), id);
});

console.log(`r21-builder-hover: ${n} checks passed`);
