// Date guard: event dates today..+5y, meetings -2y..+1y, half-typed years (0026) cleared with a hint.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const s = read('public/store-api.js');
t('event window is today .. today + 5 years', () => { assert.match(s, /win === "future" \? isoDay\(new Date\(\)\)/); assert.match(s, /win === "future" \? addYears\(5\)/); });
t('recent window is -2 .. +1 years', () => { assert.match(s, /win === "recent" \? addYears\(-2\)/); assert.match(s, /win === "recent" \? addYears\(1\)/); });
t('half-typed year (badInput) is cleared on blur with a hint', () => assert.match(s, /!el\.value && el\.validity && el\.validity\.badInput[\s\S]{0,120}negHint\(el, msg\(\), 5000\)/));
t('a value already saved is kept when editing', () => assert.match(s, /original && v === original\) return false/));
t('event date fields opt in', () => {
  assert.match(read('public/flow.html'), /id="c_date" type="date" data-min-today/);
  assert.match(read('public/event.html'), /type="date" data-min-today id="evDate"/);
  assert.match(read('public/calendar.html'), /type="date" data-min-today class="setdate"/);
  assert.match(read('public/invite-studio.html'), /id="f_date" type="date" data-min-today/);
});
t('meeting dates use the recent window', () => {
  assert.match(read('public/flow.html'), /id="d_date" type="date" data-date-window="recent"/);
  assert.match(read('public/discovery.html'), /id="d_date" data-date-window="recent"/);
});
console.log(`date-guard: ${n} passed`);
