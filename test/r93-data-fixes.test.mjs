// R93 data fixes: CRM budget fallback + quiet masked look, dashboard "starts NaN:undefined", crew radius default,
// booklet payment cards, Discovery budget shown Indian-grouped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };

t('1 CRM budget falls back to the live lead, then the quote / Discovery budget', () => {
  const api = read('public/store-api.js');
  assert.match(api, /async _fillArchiveBudgets\(rows\)/);
  assert.match(api, /try \{ await leads\._fillArchiveBudgets\(r\.rows\); \} catch \(e\) \{\}/);
  assert.match(api, /from\("quotes"\)\.select\("id,client"\)\.in\("id", qids\)/);
  assert.match(api, /from\("event_discovery"\)\.select\("quote_id,budget_max"\)/);
  const css = read('public/crm-polish.css');   // R115: the lock + "Hidden" chip moved to the shared privacy CSS
  assert.match(css, /html\.hb-priv-on #rows td\.hbp-m:not\(svg \*\) \{ text-align: right; \}/);
  assert.match(read('public/shell-b-privacy.css'), /\.hbp-mask::after \{ content: "Hidden";/);
  assert.match(read('public/shell-b-privacy.js'), /sp\.title = "Amount hidden\. Tap the eye icon to show"/);
});

t('2 dashboard countdown reads {h, m} (never tm[1] / tm[2])', () => {
  const js = read('public/shell-b-dash.js');
  assert.ok(!/pad\(\+tm\[1\]\)/.test(js), 'no regex-array reads');
  const pad = (n) => (n < 10 ? '0' : '') + n, tm = { h: 9, m: 5 };
  assert.equal(pad(tm.h) + ':' + pad(tm.m), '09:05');
  assert.match(js, /function hm\(\) \{ return pad\(tm\.h\) \+ ":" \+ pad\(tm\.m\); \}/);
});

t('3 crew radius shows the default and is only required with Location check on', () => {
  const js = read('public/crew-shifts.js');
  const fn = new Function(js.match(/function radiusOrDefault\(v\) \{[^\n]*\}/)[0] + '; return radiusOrDefault;')();
  assert.equal(fn(undefined), 300); assert.equal(fn(null), 300); assert.equal(fn(''), 300); assert.equal(fn(20), 300);
  assert.equal(fn(450), 450); assert.equal(fn('120'), 120);
  assert.match(js, /if \(r === null && gf\.input\.checked\)/);
  assert.match(js, /if \(r !== null\) patch\.geofenceRadiusM = r;/);
});

t('4 booklet payment cards', () => {
  assert.match(read('public/booklet.js'), /"ps-card ps-"/);
  const css = read('public/booklet-v2.css');
  for (const c of ['.ps-paid', '.ps-bal', '.ps-clear', '#payTable{border-collapse:separate']) assert.ok(css.includes(c), c);
});

t('5 Discovery budget shown Indian-grouped', () => {
  const h = read('public/discovery.html');
  assert.ok(h.includes('id="d_bmaxFmt"'));
  assert.equal(new Intl.NumberFormat('en-IN').format(20000000), '2,00,00,000');
  assert.match(h, /paintBudgetFmt\(\);\n/);
});
console.log('r93-data-fixes: ' + n + ' passed');
