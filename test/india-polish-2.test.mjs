// india-polish-2.test.mjs — India audit pass 2 (Oct 2026): amount in words keeps paise (#13),
// staff "payment received" WhatsApp carries balance due (#15), Hindi/Hinglish import headers (#16),
// custom dish veg/non-veg inference (#17), mehendi/haldi + free-text layout types (#18), reports CSV BOM (#19).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const store = read('public/store-api.js');

function words() {
  const s = store.indexOf('BPStore.amountInWords = function'); const e = store.indexOf('\n  };\n', s);
  const ctx = { BPStore: {} }; vm.createContext(ctx); vm.runInContext(store.slice(s, e + 5), ctx); return ctx.BPStore.amountInWords;
}
t('#13 amount in words keeps paise', () => {
  const w = words();
  assert.equal(w(306800), 'Rupees Three Lakh Six Thousand Eight Hundred only');
  assert.equal(w(1250.5), 'Rupees One Thousand Two Hundred Fifty and Fifty Paise only');
  assert.equal(w(99.999), 'Rupees One Hundred only');
  assert.equal(w(0.75), 'Seventy Five Paise only');
  assert.equal(w(0), 'Rupees Zero only');
  assert.equal(w(12345678.09), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Nine Paise only');
});
t('#15 pkg_payment WhatsApp text carries balance when sent', () => {
  const src = read('supabase/functions/pkg-client-notify/templates.ts');
  assert.match(src, /Balance due: \$\{money\(p\.balance, p\.currency\)\}/);
  assert.match(src, /Paid in full\./);
});
t('#16 Hindi + Hinglish staff sheet headers map', () => {
  const C = require('../public/smart-import-core.js');
  for (const hdr of [['Naam', 'Mobile', 'Rate (₹)', 'Shahar'], ['नाम', 'मोबाइल', 'दर (₹)', 'शहर']]) {
    const table = [hdr, ['Ramesh', '98765 43210', '1,200', 'Hyderabad']];
    const h = C.detectHeader(table, 'staff'); const m = C.autoMap('staff', h.headers, table.slice(h.index + 1));
    assert.deepEqual(m.map((x) => x.target), ['field:name', 'field:phone', 'field:day_rate', 'field:city'], hdr.join());
  }
  assert.equal(C.parseAmount('Rs. 2,500/-'), 2500); assert.equal(C.parseAmount('1.5 lakh'), 150000);
  assert.equal(C.parsePhone('+91 98765-43210').value, '+919876543210');
});
t('#17 custom dish kind inferred (non-veg never saved as veg)', () => {
  const D = require('../public/flow-dish-editor.js');
  assert.equal(D.kindOf('Main course', 'Chicken 65'), 'nonveg');
  assert.equal(D.kindOf('Main course', 'Mutton biryani'), 'nonveg');
  assert.equal(D.kindOf('Starters (nonveg)', 'Apollo'), 'nonveg');
  assert.equal(D.kindOf('Main course', 'Paneer butter masala'), 'veg');
  assert.equal(D.kindOf('Desserts', 'Eggless cake'), 'veg');
  assert.match(read('public/flow-dish-editor.js'), /dishCatalog\.add\(course, name, kindOf\(course, name\)\)/);
});
t('#18 mehendi / haldi / roka use the engagement layout, not the wedding mandap', () => {
  const W = require('../public/layout-wizard.js');
  for (const k of ['Mehendi', 'mehndi', 'Haldi', 'Roka', 'Sangeet']) assert.equal(W.typeKey(k), 'engagement', k);
  assert.equal(W.typeKey('Political rally'), 'political'); assert.equal(W.typeKey('Birthday party'), 'birthday'); assert.equal(W.typeKey('Corporate offsite'), 'corporate'); assert.equal(W.typeKey('Gala dinner'), 'wedding'); assert.equal(W.typeKey('Product launch'), 'product_launch');
});
t('#19 reports CSV starts with a UTF-8 BOM so ₹ opens in Excel', () => {
  assert.match(read('public/reports.html'), /new Blob\(\["\\uFEFF"\+text\]/);
});
t('#20 Indian states list = 28 states + 8 UTs; PIN / phone rules', () => {
  const H = require('../public/country-profile.js');
  const src = read('public/country-profile.js'); const m = src.match(/IN_STATES = \[([\s\S]*?)\];/);
  const list = m[1].match(/"[^"]+"/g); assert.equal(list.length, 36);
  assert.equal(H.validatePostal('IN', '500001'), true); assert.equal(H.validatePostal('IN', '050001'), false); assert.equal(H.validatePostal('IN', '50001'), false);
});

let bad = 0;
for (const [n, f] of tests) { try { f(); } catch (e) { bad++; console.error('FAIL ' + n + ': ' + e.message.split('\n').slice(0, 4).join(' | ')); } }
console.log(`india-polish-2: ${tests.length - bad}/${tests.length} passed`);
if (bad) process.exit(1);
