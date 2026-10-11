// Owner: "the phone alignment in nurture is not working". Root causes: (1) the HelmPhone wrapper
// had a fixed 44px min-height while the page fields are 36-38px; (2) the number box kept its
// intrinsic (size=20) width, so the wrapper's min-content (~280px) pushed narrow grid tracks
// (Nurture's 6-column add row) out of the card and squeezed the number to ~20px on phones.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const css = read('public/theme.css'), nur = read('public/nurture.html'), ops = read('public/ops.html');
const rule = (sel) => { const i = css.indexOf(sel + '{'); assert.ok(i >= 0, 'missing ' + sel); return css.slice(i, css.indexOf('}', i)); };

t('wrapper height follows the page field height (var, 38px default), not a fixed 44px', () => {
  const r = rule('.hp');
  assert.match(r, /min-height:var\(--hp-h,38px\)/); assert.doesNotMatch(r, /min-height:44px/);
  assert.match(r, /max-width:100%/); assert.match(r, /min-width:0/);
});
t('number box has flex-basis 0 + width 0 so it never forces the wrapper wider than its cell', () => {
  const r = rule('.hp > input.hp-num');
  assert.match(r, /flex:1 1 0/); assert.match(r, /width:0!important/); assert.match(r, /height:auto!important/); assert.match(r, /min-width:0/);
});
t('country button never wraps and is not stretched by page button rules', () => {
  assert.match(css, /\.hp \.hp-cc\{white-space:nowrap\}/);
  assert.match(rule('.hp .hp-cc'), /height:auto;min-height:0/);
});
t('touch / phone widths: 44px target + 16px text (no iOS zoom)', () => {
  assert.match(css, /@media \(pointer:coarse\)\{\.hp\{min-height:44px\}\.hp > input\.hp-num\{font-size:16px(?:!important)?\}/);
  assert.match(css, /@media \(max-width:480px\)\{\.hp > input\.hp-num\{font-size:16px\}\}/);
});
t('nurture add row: minmax(0,..) tracks, phone gets the widest track, 3 -> 1 columns on small screens', () => {
  assert.match(nur, /\.addgrid\{display:grid;grid-template-columns:minmax\(0,1\.1fr\) minmax\(0,\.95fr\) minmax\(0,1\.6fr\)/);
  assert.match(nur, /\.addgrid > \.fld\{min-width:0\}/);
  assert.match(nur, /@media\(max-width:980px\)\{\.addgrid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\}/);
  assert.match(nur, /@media\(max-width:640px\)\{\.addgrid\{grid-template-columns:minmax\(0,1fr\)\}\}/);
  assert.doesNotMatch(nur, /class="addgrid s-4504b58"/, 'the extracted fixed-fr class must not override the grid');
});
t('nurture phone field matches the 36px fields and their look', () => {
  assert.match(nur, /\.fld \.hp\{--hp-h:36px;background:var\(--panel-2\);border-color:var\(--line\);border-radius:9px\}/);
});
t('ops staff row: phone takes a full row on phones', () => {
  assert.match(ops, /\.crewrow > \.hp\{grid-column:1\/-1\}/);
});
t('no inline style attribute added for the phone layout', () => {
  assert.doesNotMatch(nur, /<div class="fld"[^>]*style=/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`\nnurture-phone-align: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
