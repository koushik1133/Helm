// india-clickthrough.test.mjs - live India click-through D1 (stale AED draft), D2 (budget range), D4 (close blockers).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const H = require('../public/country-profile.js');
const store = read('public/store-api.js');
function tax() {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(store.slice(ti, te) + ['quoteTaxCfg', 'quoteTax'].map(pick).join('\n'), ctx);
  return ctx.BPStore;
}
const B = tax(), T = B.tax;
const IN = T.resolve({}), AEs = T.resolve({ taxCountry: 'AE' });
const flow = read('public/flow.html'), closure = read('public/closure.html'), disc = read('public/discovery.html');

t('D1 untouched AED draft adopts India when the studio is back in India', () => {
  const q = { status: 'quote', approvalStatus: 'none', pricing: { taxCountry: 'AE', taxName: 'VAT', currency: 'AED', chairs: 0 } };
  const out = T.restampUnpriced(q, IN);
  assert.ok(out, 'restamped');
  assert.equal(out.taxCountry, undefined); assert.equal(out.currency, undefined); assert.equal(out.taxName, undefined);
  assert.equal(out.chairs, 0, 'non-tax keys kept');
  assert.equal(B.quoteTax({ pricing: out }).currency, 'INR', 'display and storage agree: INR');
});
t('D1 untouched India draft adopts UAE in a UAE studio; no-op when already matching', () => {
  const out = T.restampUnpriced({ pricing: {} }, AEs);
  assert.equal(out.taxCountry, 'AE'); assert.equal(out.currency, 'AED');
  assert.equal(T.restampUnpriced({ pricing: out }, AEs), null);
  assert.equal(T.restampUnpriced({ pricing: {} }, IN), null);
});
t('D1 priced / sent / confirmed quotes keep their snapshot (banner path)', () => {
  const AE = { taxCountry: 'AE', taxName: 'VAT', currency: 'AED' };
  assert.equal(T.restampUnpriced({ pricing: Object.assign({ gstPct: 5, total: 105 }, AE) }, IN), null);
  assert.equal(T.restampUnpriced({ approvalStatus: 'sent', pricing: AE }, IN), null);
  assert.equal(T.restampUnpriced({ status: 'confirmed', pricing: AE }, IN), null);
  assert.equal(T.restampUnpriced({ approval_status: 'paid', pricing: AE }, IN), null);
  assert.equal(T.isPricedQuote({ pricing: AE }), false);
});
t('D1 flow wires re-stamp on open and before the quotation save', () => {
  const st = flow.slice(flow.indexOf('async function stampNewQuoteTax'), flow.indexOf('function paintCurBanner'));
  assert.match(st, /restampUnpriced\(ev,/);
  const sv = flow.slice(flow.indexOf('async function saveQuotation'), flow.indexOf('preserveSnapshot(ev.pricing'));
  assert.match(sv, /restampUnpriced\(ev, BPStore\.tax\.resolve\(rates/);
});
t('D2 (retired): single Budget field, no min/max inversion check', () => {
  for (const [name, src] of [['flow', flow], ['discovery', disc]]) assert.doesNotMatch(src, /Max should be at least the min/, name);
});
t('versions: store-api bumped to 172', () => { for (const f of [flow, closure, disc]) assert.match(f, /store-api\.js\?v=262/); });
t('D4 closure lists money owed AND equipment together, with links + admin override', () => {
  const fn = closure.slice(closure.indexOf('function closeBlockerLines('), closure.indexOf('async function renderCloseSummary'));
  const ctx = { evTax: null, BPStore: { studioMoney: (n) => '₹' + n } }; vm.createContext(ctx); vm.runInContext(fn + ';this.f=closeBlockerLines;', ctx);
  const r = ctx.f({ blocked: true, balance_owed: 256800, open_checkouts: 0 }, ['Chair ×5', 'Table ×2']);
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[0], /Balance due from client: ₹256800 \(collect it in Settlement\)/);
  assert.match(r.lines[1], /2 equipment reservations not marked returned/);
  const ce = closure.slice(closure.indexOf('async function closeEvent'), closure.indexOf('// Gate 1.5'));
  assert.doesNotMatch(ce, /Equipment still out/, 'no equipment-only dialog any more');
  assert.match(ce, /settlement\.html\?quote=/); assert.match(ce, /inventory\.html\?quote=/);
  assert.match(ce, /Override & close/); assert.match(ce, /overrideReason=t/);
  assert.match(closure, /id="closeBlockers"/); assert.match(closure, /renderCloseSummary\(\);/);
});
let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n  ' + e.message); } }
if (fail) { console.log(fail + ' failed'); process.exit(1); }
console.log('india-clickthrough: ' + tests.length + ' passed');
