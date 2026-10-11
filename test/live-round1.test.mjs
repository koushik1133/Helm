// live-round1.test.mjs — regressions for the bugs found live on www.helm.events (B1-B16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const H = require('../public/country-profile.js');
const store = read('public/store-api.js');
// pure BPStore helpers evaluated in a sandbox (tax engine + per-quote money + supplier/date helpers)
function storeCtx() {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(store.slice(ti, te) + ['quoteTaxCfg', 'quoteTax', 'quoteMoney', 'studioHeader', 'quoteSupplier', 'supplierSnapshot', 'quoteDate', 'paymentTerms'].map(pick).join('\n'), ctx);
  return ctx.BPStore;
}

t('B1 one shared form-metadata source: tax ID / region / postal / phone per country', () => {
  const ae = H.formMeta('AE'), us = H.formMeta('US'), inn = H.formMeta('IN');
  assert.equal(inn.taxIdLabel, 'GSTIN'); assert.equal(ae.taxIdLabel, 'TRN'); assert.equal(us.taxIdLabel, 'EIN');
  assert.equal(ae.regionLabel, 'Emirate'); assert.equal(ae.regions.length, 7); assert.equal(us.regions.length, 51);
  assert.equal(inn.postalLabel, 'PIN code'); assert.equal(us.postalLabel, 'ZIP code'); assert.equal(us.phoneCode, '+1'); assert.equal(ae.phoneCode, '+971');
  assert.equal(H.formMeta('GB', 'VAT number').taxIdLabel, 'VAT number');
  const ob = read('public/onboarding.js');
  // a country change updates the form in place (no full re-render of the select)
  assert.equal((ob.match(/bill = \{ values: vals, errors: \{\} \}; applyBillCountry\(ev\.target\.value\); return;/g) || []).length, 2);
  assert.match(ob, /function applyBillCountry\(cc\)/); assert.match(ob, /hp && !hp\.national\(\)\) hp\.setCountry\(cc\)/);
  assert.match(ob, /data-country="\$\{esc\(cc\)\}"/); assert.match(ob, /list="ob_b_state_list"/);
  assert.match(read('public/control.html'), /HC\.formMeta\(r\.country\)/);
});
t('B2 timezone follows country (US by state) unless customised', () => {
  assert.equal(H.timezone('AE'), 'Asia/Dubai'); assert.equal(H.timezone('IN'), 'Asia/Kolkata'); assert.equal(H.timezone('US'), 'America/New_York');
  assert.equal(H.timezone('US', 'CA'), 'America/Los_Angeles'); assert.equal(H.timezone('US', 'Texas'), 'America/Chicago'); assert.equal(H.timezone('US', 'AZ'), 'America/Phoenix'); assert.equal(H.timezone('US', 'HI'), 'Pacific/Honolulu');
  assert.ok(H.isAutoTimezone('Asia/Kolkata') && H.isAutoTimezone('') && !H.isAutoTimezone('Europe/Paris'));
  global.HelmCountry = H; const W = require('../public/onboarding-wizard.js');
  const cd = { currency: 'AED', timezone: 'Asia/Dubai' };
  assert.deepEqual(W.followCountry({ currency: 'INR', timezone: 'Asia/Kolkata' }, {}, cd), { currency: 'AED', timezone: 'Asia/Dubai' });
  assert.equal(W.followCountry({ currency: 'INR', timezone: 'Europe/Paris' }, {}, cd).timezone, 'Europe/Paris', 'customised kept');
  assert.equal(W.followCountry({ currency: 'INR', timezone: 'Asia/Kolkata' }, { timezone: 'Asia/Kolkata' }, cd).timezone, 'Asia/Kolkata', 'typed this session kept');
  delete global.HelmCountry;
  const c = read('public/control.html'); assert.match(c, /function followTz\(\)/); assert.match(c, /\$\("#o_state"\)\.addEventListener\("change",followTz\)/);
});
t('B3/B12 pricing country = studio tax country, relabels, proposes rate, confirms, syncs both ways', () => {
  const c = read('public/control.html');
  assert.match(c, /\$\("#p_country"\)\.addEventListener\("change"/); assert.match(c, /function onPricingCountry\(regionOnly\)/);
  assert.match(c, /cc\.value=BPStore\.tax\.code\(p\.taxCountry\|\|"IN"\)/, 'p_country shows the tax country');
  assert.match(c, /Switch your studio to \$\{tp\.name\}\? New quotes will use \$\{tp\.tax\} \$\{gstPct\}%/);
  assert.match(c, /taxCountry:country \}\);/); assert.match(c, /await syncOrgCountry\(country, region\)/);
  assert.match(c, /\$\("#p_country"\)\.value=newCountry;/, 'o_country save repaints p_country');
  assert.match(c, /id="p_region"/); assert.match(c, /id="p_chair_lbl"/);
  // labels use the trimmed symbol: "Price / chair (AED)" (B14)
  assert.match(c, /t\+" \("\+String\(r\.symbol\)\.trim\(\)\+"\)"/);
  assert.equal(H.defaultRate('AE'), 5); assert.equal(H.defaultRate('US', 'CA'), 7.25);
});
t('B4 a blank data row (only a serial number) is dropped, not "Fix needed"', () => {
  const C = require('../public/smart-import-core.js');
  const table = [['Sr', 'Name', 'Phone', 'Role', 'Email', 'Dept', 'Rate', 'Notes', 'City'], ['1', 'Asha Rao', '9876543210', 'Waiter', '', '', '', '', ''], ['2', 'Ravi K', '9876543211', 'Chef', '', '', '', '', ''], ['3', '', '', '', '', '', '', '', '']];
  const h = C.detectHeader(table, 'staff'); const m = C.autoMap('staff', h.headers, table.slice(h.index + 1));
  const b = C.buildRows('staff', table, h.index, m);
  assert.equal(b.rows.length, 2); assert.equal(b.skippedBlank, 1); assert.ok(b.rows.every((r) => !r.errors.length));
});
t('B5 lists refresh after a smart import (callback + window event)', () => {
  const si = read('public/smart-import.js'); assert.match(si, /dispatchEvent\(new CustomEvent\("helm:import-done"/);
  for (const p of ['staff.html', 'inventory.html']) { const h = read('public/' + p);
    assert.match(h, /onDone:\(sum\)=>\{ if\(sum\) return refreshAfterImport\(\); \}/, p); assert.match(h, /addEventListener\("helm:import-done"/, p); }
});
t('B6 one default advance % (10) everywhere', () => {
  global.BPStore = { DEFAULT_ADVANCE_PCT: 10 }; delete require.cache[require.resolve('../public/onboarding-wizard.js')];
  const W = require('../public/onboarding-wizard.js'); delete global.BPStore;
  assert.equal(W.paymentFromCfg({}).advancePct, '10'); assert.equal(W.paymentFromCfg({ advancePct: 25 }).advancePct, '25');
  assert.match(store, /BPStore\.DEFAULT_ADVANCE_PCT = 10;/); assert.match(read('public/flow.html'), /id="pay_pct" type="number" min="0" max="100" value="10"/);
});
t('B7 political 1000 guests / 700 seats / 200x140 theatre: symmetric blocks, review text = placed', () => {
  const HW = require('../public/layout-wizard.js');
  const spec = HW.defaults('political', { guests: 1000, w: 200, h: 140 }); spec.seating.style = 'theatre'; HW.fitSeating(spec);
  const pl = HW.seatPlan(spec);
  let uid = 0; const D = { ASSETS: new Proxy({}, { get: () => ({ w: 10, h: 10, category: 'structure' }) }),
    makeItem: (type, x, y, o) => ({ id: 'i' + (++uid), type, x, y, width: o.width, height: o.height, rotation: o.rotation || 0, label: o.label }), genSeats: () => 0 };
  const out = HW.layout(spec, D);
  const blocks = out.items.filter((i) => i.type === 'seatblock' || (i.type === 'chairrow' && /^Seating block/.test(i.label)));
  const seats = (i) => (i.properties.rows || 1) * i.properties.cols;
  const L = blocks.filter((b) => b.x + b.width / 2 < 100).reduce((a, b) => a + seats(b), 0), R = blocks.filter((b) => b.x + b.width / 2 > 100).reduce((a, b) => a + seats(b), 0);
  assert.equal(L + R, pl.main); assert.ok(Math.abs(L - R) <= 1, `L=${L} R=${R}`);
  const sb = blocks.filter((b) => b.type === 'seatblock'); assert.equal(sb.length, 4);
  for (const b of sb) assert.ok(sb.some((o) => Math.abs((o.x + o.width / 2 - 100) + (b.x + b.width / 2 - 100)) < 0.6 && o.y === b.y), 'mirrored');
  const txt = HW.theatreText(spec.seating, pl.main); assert.match(txt, new RegExp('= ' + pl.main + ' seats$')); assert.match(txt, /^4 blocks × 11 rows × 15 \+ 2 in a last row/);
});
t('B8 fullscreen hides trial / subscription notices', () => {
  assert.match(read('public/layout-wizard.css'), /body\.fs-on \.hau-notes,body\.fs-on \.hau-note,body\.fs-on \.hau-note\.dock-left/);
});
t('B9 Review renders the preview on open; one "Place on floor" action', () => {
  const lw = read('public/layout-wizard.js');
  assert.ok(!/wizUse/.test(lw)); assert.match(lw, /step === 3 \? 'Place on floor'/); assert.match(lw, /renderBody\(\); if \(step === 3\) generate\(\);/);
  assert.match(lw, /else \{ generate\(\); if \(lastResult\) apply\(lastResult\); \}/);
});
t('B10 flow quotation has the tax-exempt tick, saved as pricing.taxExempt, shown as "(exempt)"', () => {
  const f = read('public/flow.html');
  assert.match(f, /id="q_taxExempt"/); assert.match(f, /taxExempt: exemptOn\(\) \? true : undefined,/); assert.match(f, /t\.taxExempt\?" \(exempt\)"/);
  assert.match(f, /\$\("#q_taxExempt"\)\.checked=String\(pr\.taxExempt\)==="true"/);
  const B = storeCtx(); assert.equal(B.tax.resolve({ taxCountry: 'AE', taxExempt: true }).rate, 0);
});
t('B11 every quote is shown in its OWN currency; no snapshot = INR', () => {
  const B = storeCtx();
  assert.equal(B.quoteTax({ pricing: { total: 306800, gstPct: 18 } }).currency, 'INR');
  assert.equal(B.quoteMoney(306800, { pricing: { total: 306800 } }), '₹' + (306800).toLocaleString('en-IN'));
  assert.equal(B.quoteTax({ pricing: { taxCountry: 'AE', currency: 'AED' } }).currency, 'AED');
  assert.equal(B.quoteTax({ pricing: {}, tax_snapshot: { country: 'US', region: 'CA' } }).country, 'US');
  assert.match(store, /tax_country:pricing->>taxCountry/); assert.match(store, /pricing\.taxCountry = q\.tax_country/);
  const q = read('public/quotes.html');
  assert.match(q, /esc\(BPStore\.quoteMoney\(x\.total,x\)\)/); assert.match(q, /const qTax=BPStore\.quoteTax\(full\)/); assert.match(q, /function paintCurBanner/);
  const f = read('public/flow.html'); assert.match(f, /This quote is in \$\{qT\.currency\}/); assert.match(f, /quoteKeep&&ev \? BPStore\.quoteTaxCfg\(ev\)/);
  for (const p of ['settlement.html', 'closure.html', 'event.html', 'budget.html']) assert.match(read('public/' + p), /evTax\?BPStore\.quoteMoney\(n,evTax\)/, p);
  assert.ok(!/BPStore\.studioMoney\(n,\{round:true\}\);\s*$/m.test(read('public/portal.html').split('\n').find((l) => /const inr=/.test(l))), 'portal falls back to INR');
  // quotes.html gatherPricing: currency:"INR" is always overridden by the snapshot for AE/US
  for (const cc of ['AE', 'US']) assert.notEqual(Object.assign({ currency: 'INR' }, B.tax.snapshot(B.tax.resolve({ taxCountry: cc }))).currency, 'INR');
  // migration 0091 + APPLY
  const m = read('supabase/migrations/0091_quote_currency_backfill.sql'), a = read('supabase/APPLY-0091.sql');
  assert.match(m, /where q0\.currency is null/); assert.match(m, /and q\.currency is null;/); assert.ok(!/update public\.quotes[^;]*set[^;]*pricing\s*=/.test(m), 'never writes pricing');
  assert.ok(!/[^\x00-\x7f]/.test(a)); assert.match(a, /\) v\(item, ok\)/); assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0091_quote_currency_backfill\.sql/);
});
t('B12 account card: country-aware tax-ID label, readable tax-ID types', () => {
  const a = read('public/auth-ui.js'); assert.ok(!/IN_GSTIN, IN_PAN, EU_VAT/.test(a)); assert.match(a, /\["AE_TRN", "UAE - TRN \(VAT\)"\]/); assert.match(a, /function accLabel\(f, a, st\)/);
});
t('B13 a guest count alone never becomes the event title', () => {
  const E = require('../public/event-name.js');
  assert.equal(E.fromQuote({ client: { guests: 1000 } }), ''); assert.equal(E.isAuto('1000', 'X'), true);
  assert.equal(E.fromQuote({ eventType: 'wedding', client: { guests: 1000 } }), 'WED_1000');
});
t('B14 "(₹)" becomes "(AED)" with no space inside the brackets', () => {
  const s = store.slice(store.indexOf('BPStore.localizeCurrency = function'), store.indexOf('\n  };\n', store.indexOf('BPStore.localizeCurrency = function')) + 5);
  const node = { nodeValue: 'Price / chair (₹) · Amount ₹500' };
  const ctx = { BPStore: { studioSymbol: () => 'AED' }, document: { createTreeWalker: () => { let d = false; return { nextNode: () => (d ? null : (d = true, node)) }; } } };
  vm.runInNewContext(s, ctx); ctx.BPStore.localizeCurrency({ querySelectorAll: () => [{}] });
  assert.equal(node.nodeValue, 'Price / chair (AED) · Amount AED 500');
});
t('B15 print header: frozen supplier, else current studio only when the country matches', () => {
  const B = storeCtx();
  const aeOrg = { name: 'ZZ Test Studio', gst_number: '100123456700003', brand: { billing: { country: 'AE', legal_name: 'ZZ Test Studio FZ-LLC', line1: 'Office 1', city: 'Dubai' } } };
  const oldIn = { pricing: { total: 306800, gstPct: 18 } };
  const s1 = B.quoteSupplier(oldIn, aeOrg); assert.equal(s1.taxId, ''); assert.equal(s1.address, ''); assert.equal(s1.country, 'IN');
  const s2 = B.quoteSupplier({ pricing: { taxCountry: 'AE' } }, aeOrg); assert.equal(s2.taxIdLabel, 'TRN'); assert.equal(s2.taxId, '100123456700003');
  const s3 = B.quoteSupplier({ pricing: { total: 1, supplier: { name: 'Old India Pvt Ltd', taxIdLabel: 'GSTIN', taxId: '36ABCDE1234F1Z5', country: 'IN' } } }, aeOrg);
  assert.equal(s3.name, 'Old India Pvt Ltd'); assert.equal(s3.taxId, '36ABCDE1234F1Z5');
  assert.equal(B.supplierSnapshot(aeOrg, 'IN'), null); assert.equal(B.supplierSnapshot(aeOrg, 'AE').taxId, '100123456700003');
  const q = read('public/quotes.html'); assert.match(q, /pricing\.supplier=sp/); assert.match(q, /isInv\?invTitle\(qTax,sup\)/); assert.match(q, /return qTax\.country==="IN" \? "Tax Invoice" : "Invoice";/);   // UAE audit: AE title in invTitle()
});
t('B16 missing / epoch dates are hidden; locale per quote country', () => {
  const B = storeCtx();
  assert.equal(B.quoteDate(null), ''); assert.equal(B.quoteDate(0), ''); assert.equal(B.quoteDate('1970-01-01T00:00:00Z'), ''); assert.equal(B.quoteDate('garbage'), '');
  assert.equal(B.quoteDate('2026-10-08T10:00:00Z', { country: 'IN' }), '08/10/2026'); assert.equal(B.quoteDate('2026-10-08T10:00:00Z', { country: 'US' }), '10/08/2026');
  assert.ok(!/"Confirmed "\+fmtDate\(full\.confirmedAt\)/.test(read('public/quotes.html')));
});

let pass = 0; for (const [n, f] of tests) { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { console.log('  ✗ ' + n + '\n    ' + e.message); process.exitCode = 1; } }
console.log('live-round1: ' + pass + '/' + tests.length + ' passed');
