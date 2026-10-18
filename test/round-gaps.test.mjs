// Round gaps after merging onboarding wizard + smart import + country tax + layout wizard.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const req = createRequire(import.meta.url);
const tests = []; const t = (n, f) => tests.push([n, f]);

t('onboarding loads HelmCountry + smart import after store-api; wizard uses real HelmCountry names', () => {
  const h = read('public/onboarding.html');
  const i = (s) => h.indexOf(s);
  assert.ok(i('country-profile.js?v=4') > 0 && i('country-profile.js') < i('store-api.js?v=240'));
  for (const s of ['xlsx-lite.js?v=2', 'smart-import-core.js?v=6', 'smart-import.js?v=3']) assert.ok(i(s) > i('store-api.js'), s);
  global.HelmCountry = req('../public/country-profile.js');
  const W = req('../public/onboarding-wizard.js');
  const ae = W.countryDefaults('AE'); assert.equal(ae.currency, 'AED'); assert.equal(ae.taxName, 'VAT'); assert.equal(ae.taxRate, 5); assert.equal(ae.idLabel, 'TRN');
  const us = W.countryDefaults('US'); assert.equal(us.currency, 'USD'); assert.equal(us.idLabel, 'EIN');
  delete global.HelmCountry;
});
t('US tax ID: EIN accepted, blank allowed, same rule in HelmCountry / onboarding-core / store', () => {
  const H = req('../public/country-profile.js'); const O = req('../public/onboarding-core.js');
  assert.equal(H.validateTaxId('US', '12-3456789').ok, true); assert.equal(H.validateTaxId('US', '').ok, true);
  assert.equal(O.taxIdOf('US').label, 'EIN'); assert.ok(O.taxIdOf('US').re.test('12-3456789'));
  assert.equal(String(O.taxIdOf('US').re), String(H.get('US').taxIdRegex));
  assert.equal(O.validateBilling({ country: 'US', legal_name: 'A', line1: 'x', city: 'c', state: 'TX', pin: '75001', phone: '+1 214 555 0100', location: 'Dallas', gstin: '' }).errors.gstin, undefined);
});
t('US state base rates match Tax Foundation 2026', () => {
  const H = req('../public/country-profile.js');
  const want = { CA: 7.25, TX: 6.25, NY: 4, CO: 2.9, MN: 6.875, MO: 4.225, NJ: 6.625, NM: 4.875, OR: 0, DE: 0, DC: 6, IN: 7, MS: 7, RI: 7, TN: 7, SD: 4.2, UT: 6.1, VA: 5.3 };
  for (const [k, v] of Object.entries(want)) assert.equal(H.defaultRate('US', k), v, k);
  assert.equal(H.get('US').regions.length, 51);
});
t('payment terms + supplier header + attribute merge helpers', () => {
  const src = read('public/store-api.js');
  assert.match(src, /BPStore\.paymentTerms = function/); assert.match(src, /BPStore\.studioHeader = function/); assert.match(src, /BPStore\.mergeAttributes = async function/);
  assert.match(src, /localStorage\.setItem\(STUDIO_TAX_KEY/); assert.match(src, /"helm\.studioTax"\]/);
  // evaluate the two pure helpers
  const pick = (name) => { const s = src.indexOf('BPStore.' + name + ' = function'); const e = src.indexOf('\n  };\n', s); return src.slice(s, e + 5); };
  const ctx = { BPStore: { tax: { profile: (cc) => ({ AE: { name: 'United Arab Emirates', idLabel: 'TRN' }, IN: { name: 'India', idLabel: 'GSTIN' } })[cc] } } };
  vm.runInNewContext(pick('paymentTerms') + pick('studioHeader'), ctx);
  const pt = ctx.BPStore.paymentTerms({ advancePct: 30, balanceDueDays: 7, paymentTermsNote: 'No refunds <b>' }, '2026-12-20');
  assert.equal(pt.advancePct, 30); assert.equal(pt.balanceDue, '2026-12-13'); assert.doesNotMatch(pt.note, /[<>]/);
  assert.equal(ctx.BPStore.paymentTerms({}, '2026-12-20').advancePct, null);
  assert.equal(ctx.BPStore.paymentTerms({ advancePct: 150 }).advancePct, null);
  const hd = ctx.BPStore.studioHeader({ name: 'Glow', gst_number: '100123456700003', brand: { billing: { country: 'AE', legal_name: 'Glow Events LLC', line1: 'Office 4', city: 'Dubai', state: 'Dubai' } } });
  assert.equal(hd.name, 'Glow Events LLC'); assert.equal(hd.taxIdLabel, 'TRN'); assert.equal(hd.taxId, '100123456700003'); assert.match(hd.address, /Office 4, Dubai, Dubai, United Arab Emirates/);
});
t('flow advance % + terms, quote print header + terms', () => {
  const f = read('public/flow.html');
  assert.match(f, /function applyPayTerms\(\)/); assert.match(f, /BPStore\.paymentTerms\(rates/); assert.match(f, /id="pay_terms"/); assert.match(f, /dataset\.touched/);
  const q = read('public/quotes.html');
  assert.match(q, /BPStore\.quoteSupplier\(full, studioOrg\)/); assert.match(q, /sup\.taxIdLabel/); assert.match(q, /\$\{termsHtml\}/);
  assert.doesNotMatch(q, /<h1>Helm Events<\/h1>/);
});
t('portal formats with the quote currency (0090)', () => {
  const p = read('public/portal.html'); assert.match(p, /d\.tax/); assert.match(p, /BPStore\.tax\.money/);
  const m = read('supabase/migrations/0090_portal_quote_currency.sql'); assert.match(m, /- 'billing'/); assert.match(m, /tax_snapshot/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0090_portal_quote_currency\.sql/);
});
t('smart import attribute edits merge (changes only, re-read before save)', () => {
  global.window = undefined;
  const ctx = {}; vm.runInNewContext(read('public/smart-import.js').replace(/if \(typeof document[^\n]*\n/, ''), ctx);
  const M = ctx.HelmImport.mergeAttrs;
  assert.equal(JSON.stringify(M({ a: '1', b: '2', c: '3' }, { set: { b: 'x' }, unset: ['c'] })), JSON.stringify({ a: '1', b: 'x' }));
  for (const p of ['public/staff.html', 'public/inventory.html']) { const h = read(p); assert.match(h, /attrEd\.changes\(\)/, p); assert.match(h, /BPStore\.mergeAttributes\(/, p); }
  assert.match(read('public/smart-import.js'), /accept: "\.xlsx,\.xls,/); assert.match(read('public/smart-import.js'), /Old Excel \(\.xls\)/);
});
t('3D fullscreen: no ruler gutter', () => {
  assert.match(read('public/layout-wizard.css'), /body\.fs-on \.viewport\.is3d \.stage3d,\.viewport\.is3d:fullscreen \.stage3d\{left:0;top:0\}/);
  assert.match(read('public/builder.html'), /layout-wizard\.css\?v=5/);
});
t('APPLY-0088-0090: ASCII, all three migrations, verify grid', () => {
  const a = read('supabase/APPLY-0088-0090.sql');
  assert.ok(!/[^\x00-\x7f]/.test(a));
  assert.ok(a.indexOf('0088_smart_import') < a.indexOf('0089_country_tax') && a.indexOf('0089_country_tax') < a.indexOf('0090_portal_quote_currency'));
  assert.ok((a.match(/^  \('00(88|89|90) \d\d /gm) || []).length >= 25);
});

let pass = 0; for (const [n, f] of tests) { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { console.log('  ✗ ' + n + '\n    ' + e.message); process.exitCode = 1; } }
console.log('round-gaps: ' + pass + '/' + tests.length + ' passed');
