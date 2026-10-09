// 0079 country-based tax: client engine == server rule (D8), India unchanged, labels/IDs per country.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// --- extract the shipping engine + the tax module from store-api.js ---------------
const src = read('public/store-api.js');
function block(start) { const i = src.indexOf(start); assert.ok(i >= 0, start); const o = src.indexOf('{', i); let d = 0, j = o;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { j++; break; } } } return src.slice(o, j); }
const canon = new Function('a', block('_canon(a)').slice(1, -1));
const qtBody = block('quoteTotal(p)').slice(1, -1);
const quoteTotal = (p) => new Function('p', qtBody).call({ _canon: canon }, p);
const ti = src.indexOf('BPStore.tax = (function () {'); const te = src.indexOf('})();', ti) + 5;
const ctx = { BPStore: { countries: () => [{ iso: 'DE', name: 'Germany', dial: '49' }] } };
vm.runInNewContext(src.slice(ti, te), ctx);
const T0 = ctx.BPStore.tax;
const J = (x) => JSON.parse(JSON.stringify(x));
const T = { ...T0, rows: (...a) => J(T0.rows(...a)), COUNTRIES: T0.COUNTRIES };

// --- server reference: helm_quote_total (0001 canonical) wrapped by 0079 -----------
function serverCanonical(p) {
  const n = (k) => Number(p[k] ?? 0); const client = (p.catering?.mode ?? 'inhouse') === 'client';
  const preSvc = n('chairs') * n('chairPrice') + n('other') + (client ? 0 : n('guests') * n('platePrice')) + (client ? 0 : Number(p.catering?.amount ?? 0));
  const sub = preSvc + preSvc * n('serviceChargePct') / 100;
  let disc = n('discount') + sub * n('discountPct') / 100;
  if (p.coupon && typeof p.coupon === 'object' && 'value' in p.coupon) disc += p.coupon.kind === 'percent' ? sub * Number(p.coupon.value || 0) / 100 : Number(p.coupon.value || 0);
  disc = Math.min(Math.max(0, disc), sub); const taxed = Math.max(0, sub - disc);
  return Math.round(taxed + taxed * n('gstPct') / 100);
}
const server0079 = (p) => String(p.taxInclusive ?? '').toLowerCase() === 'true' ? serverCanonical({ ...p, gstPct: 0 }) : serverCanonical(p);

t('India / exclusive: totals identical to before (5000 + 18% = 5900)', () => {
  const p = { gstPct: 18, chairs: 10, chairPrice: 500 };
  assert.equal(quoteTotal(p).total, 5900); assert.equal(server0079(p), 5900);
});
t('inclusive: total = post-discount value, tax extracted (5000 incl. 18% -> 762.71)', () => {
  const p = { gstPct: 18, chairs: 10, chairPrice: 500, taxInclusive: true };
  const c = quoteTotal(p); assert.equal(c.total, 5000); assert.equal(server0079(p), 5000);
  assert.ok(Math.abs(c.totalGst - 5000 * 18 / 118) < 1e-9);
});
t('differential: client == server across 400 random quotes (incl/excl, every country rate)', () => {
  let seed = 7; const r = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * m); };
  const rates = [0, 5, 9, 10, 12, 18, 20, 28, 13, 7.25];
  for (let i = 0; i < 400; i++) {
    const p = { gstPct: rates[r(rates.length)], chairs: r(500), chairPrice: r(900), guests: r(800), platePrice: r(1500), other: r(200000),
      serviceChargePct: r(3) ? 0 : r(15), discount: r(4) ? 0 : r(20000), discountPct: r(5) ? 0 : r(30),
      coupon: r(4) ? null : { kind: r(2) ? 'percent' : 'flat', value: r(20) }, catering: { mode: ['inhouse', 'vendor', 'client'][r(3)], amount: r(50000) } };
    if (r(2)) p.taxInclusive = true;
    assert.equal(quoteTotal(p).total, server0079(p), JSON.stringify(p));
  }
});
t('no snapshot keys for India/exclusive (existing payloads unchanged)', () => {
  assert.deepEqual({ ...T.snapshot(T.resolve({ gstPct: 18 })) }, {});
  const uae = T.snapshot(T.resolve({ taxCountry: 'AE', gstPct: 5, taxInclusive: true }));
  assert.equal(uae.taxCountry, 'AE'); assert.equal(uae.taxName, 'VAT'); assert.equal(uae.currency, 'AED'); assert.equal(uae.taxInclusive, true);
});
t('country profiles: labels, default rates, currency', () => {
  const r = (cc) => T.resolve({ taxCountry: cc });
  assert.equal(r('IN').rate, 18); assert.equal(r('IN').name, 'GST'); assert.equal(r('IN').idLabel, 'GSTIN');
  assert.equal(r('AE').rate, 5); assert.equal(r('AE').idLabel, 'TRN'); assert.equal(r('GB').rate, 20); assert.equal(r('GB').name, 'VAT');
  assert.equal(r('US').rate, 0); assert.equal(r('US').name, 'Sales tax'); assert.equal(r('SG').rate, 9); assert.equal(r('AU').rate, 10);
  assert.equal(r('AU').idLabel, 'ABN'); assert.equal(r('CA').name, 'GST/HST'); assert.equal(r('CA').rate, 0);
  const de = T.resolve({ taxCountry: 'DE', taxName: 'MwSt<b>', gstPct: 19, currency: 'EUR' });
  assert.equal(de.name, 'MwStb'); assert.equal(de.rate, 19); assert.equal(de.currency, 'EUR'); assert.equal(de.countryName, 'Germany');
  assert.equal(T.resolve({}).country, 'IN'); assert.equal(T.resolve({ gstPct: 0 }).rate, 0);
});
t('India split: CGST+SGST intra, IGST inter; other countries one line', () => {
  const c = quoteTotal({ gstPct: 18, chairs: 10, chairPrice: 500 });
  assert.deepEqual(T.rows(c, {}, T.resolve({})).map((x) => [x.label, x.pct, x.amount]), [['CGST', 9, 450], ['SGST', 9, 450]]);
  assert.deepEqual(T.rows(c, { placeOfSupply: 'inter' }, T.resolve({})).map((x) => x.label), ['IGST']);
  assert.deepEqual(T.rows(c, {}, T.resolve({ taxCountry: 'GB', gstPct: 20, taxInclusive: true })).map((x) => x.label), ['VAT (included)']);
  assert.equal(T.placeOfSupply('Telangana', ' telangana '), 'intra'); assert.equal(T.placeOfSupply('Telangana', 'Karnataka'), 'inter');
  assert.equal(T.placeOfSupply('', 'Karnataka'), null);
});
t('tax ID validation per country', () => {
  assert.equal(T.validateId('IN', '36abcde1234f1z5').ok, true); assert.equal(T.validateId('IN', '36ABCDE1234F1Z').ok, false);
  assert.equal(T.validateId('AE', '100123456700003').ok, true); assert.equal(T.validateId('AE', '1001').ok, false);
  assert.equal(T.validateId('GB', 'GB 123 4567 89').ok, true); assert.equal(T.validateId('AU', '51 824 753 556').ok, true);
  assert.equal(T.validateId('CA', '123456789RT0001').ok, true); assert.equal(T.validateId('SG', '200312345A').ok, true);
  assert.equal(T.validateId('US', '').ok, true);
});
t('money: India symbol unchanged, others localised', () => {
  assert.equal(T.money(536000, T.resolve({})), '₹5,36,000'); assert.equal(T.money(1200, T.resolve({ taxCountry: 'GB' })), '£1,200');
  assert.equal(T.money(10, T.resolve({ taxCountry: 'AE' })), 'AED 10');
});
t('onboarding-core: country-aware billing, India rules unchanged, tax ID tables match store-api', () => {
  const O = require('../public/onboarding-core.js');
  const good = { legal_name: 'Aurora', line1: '1 Rd', city: 'Hyd', state: 'Telangana', pin: '500034', phone: '+91 98765 43210', location: 'Hyd' };
  assert.equal(O.validateBilling(good).data.country, 'IN'); assert.ok(O.validateBilling({ ...good, pin: '5000' }).errors.pin);
  const uk = O.validateBilling({ ...good, country: 'gb', pin: 'SW1A 1AA', phone: '+44 20 7946 0958', gstin: 'GB123456789' });
  assert.equal(uk.ok, true, JSON.stringify(uk.errors)); assert.equal(uk.data.country, 'GB');
  assert.ok(O.validateBilling({ ...good, country: 'AE', gstin: '12' }).errors.gstin.includes('TRN'));
  assert.equal(O.billingPatch({ name: 'x' }, uk.data).brand.billing.country, 'GB');
  assert.equal(O.billingFromOrg({}).country, 'IN');
  for (const cc of Object.keys(O.TAX_IDS)) { assert.equal(String(O.TAX_IDS[cc].re), String(T.COUNTRIES[cc].idRe), cc); assert.equal(O.TAX_IDS[cc].label, T.COUNTRIES[cc].idLabel, cc); }
});
t('migration 0079 + APPLY: additive, idempotent, ASCII, verify rows, wraps the D8 total', () => {
  const m = read('supabase/migrations/0079_country_tax.sql'), a = read('supabase/APPLY-0079.sql');
  assert.ok(!/[^\x00-\x7f]/.test(a)); assert.ok(!/\b(drop table|delete from|truncate|update public\.)/i.test(m));
  assert.ok(!/create table \w/i.test(a.replace(/^--.*$/gm, '')) && !/--[^\n]*create table \w/i.test(a));
  assert.match(m, /to_regprocedure\('public\.helm_quote_total__pretax\(jsonb\)'\) is null/);
  assert.match(m, /security definer set search_path = ''/); assert.match(m, /jsonb_build_object\('gstPct', 0\)/);
  assert.ok(a.includes(m.trim())); assert.match(a, /select item, ok from \(values/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0079_country_tax\.sql/);
});
console.log(`country-tax: ${n} passed`);
