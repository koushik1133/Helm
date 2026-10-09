// R4-B gaps: booklet exact tax label (0081), insights no-revenue margins, account-level
// getting-started hint (see getting-started-ui), legacy .xls message + one-click template.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok - ' + name); };
const J = (x) => JSON.parse(JSON.stringify(x));

const ctx = { window: {}, document: undefined, console };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const B = ctx.HelmBooklet;
const base = { chairs: 10, chairPrice: 100, gstPct: 5, computed: { subtotal: 1000, totalGst: 50, total: 1050 }, total: 1050 };
const tax = (q) => J(B.quoteLines(q).lines).filter((l) => !['Seating', 'Subtotal', 'Discount'].includes(l.label)).map((l) => l.label);

t('booklet: custom tax name from the server is shown exactly', () => {
  assert.deepEqual(tax({ ...base, currency: 'EUR', taxCountry: 'DE', taxName: 'MwSt' }), ['MwSt']);
  assert.deepEqual(tax({ ...base, currency: 'CHF', taxCountry: 'CH', taxName: 'MWST' }), ['MWST']);
});
t('booklet: hostile tax name is stripped, unknown falls back to currency map / "Tax"', () => {
  assert.deepEqual(tax({ ...base, currency: 'AED', taxCountry: 'AE', taxName: '<img>' }), ['img']);
  assert.deepEqual(tax({ ...base, currency: 'AED', taxCountry: 'AE' }), ['VAT']);
  assert.deepEqual(tax({ ...base, currency: 'XYZ', taxCountry: 'ZZ' }), ['Tax']);
});
t('booklet: taxInclusive from the server marks "(included)"', () => {
  assert.deepEqual(tax({ ...base, currency: 'GBP', taxCountry: 'GB', taxName: 'VAT', taxInclusive: true, total: 1000, computed: { subtotal: 1000, totalGst: 48, total: 1000 } }), ['VAT (included)']);
  assert.deepEqual(tax({ ...base, gstPct: 18, taxInclusive: true, computed: { subtotal: 1000, cgst: 76, sgst: 76, total: 1000 }, total: 1000 }), ['CGST (included)', 'SGST (included)']);
});
t('booklet: India unchanged (CGST/SGST / IGST, no inference)', () => {
  assert.deepEqual(tax({ ...base, gstPct: 18, computed: { subtotal: 1000, cgst: 90, sgst: 90, total: 1180 }, total: 1180 }), ['CGST', 'SGST']);
  assert.deepEqual(tax({ ...base, gstPct: 18, computed: { subtotal: 1000, igst: 180, total: 1180 }, total: 1180 }), ['IGST']);
});
t('0081 migration: wrap-once, allow-listed keys, no brand/billing read, definer + empty search_path', () => {
  const m = read('supabase/migrations/0081_booklet_tax_labels.sql'), ap = read('supabase/APPLY-0081.sql');
  assert.match(m, /alter function public\.public_get_booklet\(uuid\) rename to public_get_booklet__pre0081/);
  assert.match(m, /security definer set search_path = ''/);
  assert.doesNotMatch(m.replace(/^--.*$/gm, ''), /brand|billing|organizations/);
  assert.match(m, /'taxCountry'/); assert.match(m, /'taxName'/); assert.match(m, /'taxInclusive', true/);
  assert.ok(/^[\x00-\x7f]*$/.test(ap), 'APPLY-0081 pure ASCII');
  assert.match(ap, /select item, ok from \(values/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0081_booklet_tax_labels\.sql/);
});
t('insights: zero-revenue closed events kept out of the margin chart + average', () => {
  const s = read('public/store-api.js'), h = read('public/insights.html');
  assert.match(s, /const withRevenue = mlist\.filter\(\(x\) => Number\(x\.revenue\) > 0\)/);
  assert.match(s, /avgMargin = withRevenue\.length \?/);
  assert.match(s, /margins: \{ events: mlist, withRevenue, noRevenue,/);
  assert.match(h, /bars\("margins", mw\.map/);
  assert.match(h, /No revenue recorded \(not in the margin\)/);
});
t('xls: legacy .xls stays rejected, clear message + one-click .xlsx template button', () => {
  const x = read('public/xlsx-lite.js'), o = read('public/onboarding.js');
  assert.match(x, /e\.code = "xls_legacy"; throw e;/);
  assert.match(o, /if \(e && e\.code === "xls_legacy"\) return showXlsHelp\(e\.message\);/);
  assert.match(o, /b\.dataset\.act = "template"; b\.dataset\.fmt = "xlsx"; b\.textContent = "Download template \(\.xlsx\)"/);
});
console.log(`r4-gaps: ${n} passed`);
