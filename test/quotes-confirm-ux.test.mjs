// Quotes page: confirm dialog opens robustly, inline validation, double-click safety,
// clearer row actions, no duplicate "Views" presets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const q = read('public/quotes.html'), sf = read('public/saved-filters.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
t('row Confirm surfaces failures instead of failing silently', () => {
  assert.match(q, /act==="confirm"\) BPUI\.guard\(b,\(\)=>openConfirm\(id\)\)\.catch\(/);
  assert.match(q, /const soft=\(fn,fb\)=>Promise\.race/);
  assert.doesNotMatch(q, /try\{ cmVendors=await BPStore\.vendors\.list\(\); \}catch/);
});
t('inline errors + Confirm & lock disabled while invalid', () => {
  for (const id of ['p_chairs', 'p_guests', 'p_discountPct']) assert.match(q, new RegExp('id="' + id + '_err"'));
  assert.match(q, /must be between 0 and 100,000\./);
  assert.match(q, /b\.disabled=!ok;/);
});
t('double click: buttons locked before the prompt; group offer only after the lock', () => {
  const s = q.indexOf('async function savePricing'), e = q.indexOf('function invTitle');
  const body = q.slice(s, e);
  assert.ok(body.indexOf('cmSaving=true') < body.indexOf('Confirm & lock quote?'));
  assert.ok(body.indexOf('await BPStore.quotes.confirm(') < body.indexOf('showEventGroupPrompt(confirmedId)'));
});
t('row actions: Edit layout, name opens the workspace', () => {
  assert.match(q, />Edit layout<\/button>/);
  assert.match(q, /<a class="qname" href="event\.html\?id=\$\{esc\(encodeURIComponent\(x\.id\)\)\}"/);
});
t('quotes Views row hides presets that duplicate the tabs', () => {
  assert.match(sf, /hidePresets: true/);
  assert.match(sf, /if \(!this\.cfg\.hidePresets\) this\.cfg\.presets\.forEach/);
});
console.log(n + ' passed');
