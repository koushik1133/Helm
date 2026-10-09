/* item-specs.test.mjs — 0086 item specifications + spec-based pricing (BPStore.pricing / ITEM_SPEC).
   Every formula, m<->ft, rounding, bad inputs rejected, missing rate -> catalog fallback with a note,
   items without specs priced exactly as before, and the static wiring (builder Adjust popup,
   Control Center card, RBAC area, migration, versions). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
export function loadPricing() {
  const s = read('public/store-api.js');
  const a = s.indexOf('const OBJECT_CAT_PRICE'), p0 = s.indexOf('const pricing = {', a);
  let i = s.indexOf('{', p0), d = 0; for (; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) break; }
  return new Function(s.slice(a, i + 1) + '; return { pricing, ITEM_SPEC };')();
}
const { pricing: P, ITEM_SPEC: S } = loadPricing();
const R = S.DEFAULT_RATES;
let n = 0; const t = (name, f) => { f(); n++; };
const c = (type, spec, rates = R[type]) => S.compute(type, spec, rates);

t('stage 8 x 5 m @ 450/m2 = 18,000 with the owner-requested label', () => {
  const r = c('stage', { lengthM: 8, widthM: 5, heightM: 0.6 });
  assert.equal(r.price, 18000); assert.equal(r.label, 'Stage 8 × 5 m (40 m²) @ ₹450/m² = ₹18,000');
});
t('stage height surcharge above standard + base', () => {
  const r = c('stage', { lengthM: 10, widthM: 6, heightM: 1.2 }, { base: 5000, perSqM: 450, stdHeightM: 0.6, heightPerSqMPerM: 150 });
  assert.equal(r.price, Math.round(5000 + 60 * 450 + 0.6 * 60 * 150));
});
t('stage in feet: stored metres, ft label, same price as metres', () => {
  const L = S.toM(26.25, 'ft'), W = S.toM(16.4, 'ft');
  const r = c('stage', { lengthM: L, widthM: W, unit: 'ft' });
  assert.ok(/ft/.test(r.label)); assert.equal(r.price, Math.round(L * W * 450));
  assert.ok(Math.abs(S.fromM(S.toM(20, 'ft'), 'ft') - 20) < 1e-9); assert.equal(S.toM(10, 'm'), 10); assert.ok(Math.abs(S.toM(1, 'ft') - 0.3048) < 1e-12);
});
t('generator 125 kVA x 1 day (+diesel +operator, multi-day)', () => {
  assert.equal(c('generator', { kva: 125, days: 1 }).price, 2000 + 125 * 60);
  assert.equal(c('generator', { kva: 125, days: 1 }).label, 'Generator 125 kVA × 1 day = ₹9,500');
  assert.equal(c('generator', { kva: 62.5, days: 2, diesel: true, operator: true }).price, Math.round(2 * (2000 + 62.5 * 60 + 62.5 * 100 + 1000)));
  for (const k of S.KVA_PRESETS) assert.ok(c('generator', { kva: k, days: 1 }).price > 0);
});
t('DJ power pin + setup + extra speakers', () => {
  assert.equal(c('dj', { setup: 'console', power: 'pin3' }).price, 16500);
  assert.equal(c('dj', { setup: 'speakers2', power: 'pin4', extraSpeakers: 2 }).price, 25000 + 4000 + 6000);
  assert.ok(/3-pin/.test(c('dj', { setup: 'speakers2', power: 'pin3' }).label));
  assert.equal(c('dj', { setup: 'speakers4', power: 'pin2' }).price, 40000);
});
t('lighting per unit and per metre (string / truss)', () => {
  assert.equal(c('lighting', { kind: 'moving_head', qty: 4 }).price, 10000);
  assert.equal(c('lighting', { kind: 'fairy', qty: 3, lengthM: 20 }).price, 3 * 20 * 40);
  assert.equal(c('lighting', { kind: 'truss_wash', qty: 1, lengthM: 12.5 }).price, 10000);
});
t('LED wall pitch x size x days', () => {
  assert.equal(c('led', { pitch: 'p39_indoor', widthM: 4, heightM: 2.5, days: 1 }).price, 11000);
  assert.equal(c('led', { pitch: 'p48_outdoor', widthM: 6, heightM: 3, days: 2 }).price, 6 * 3 * 900 * 2);
});
t('chandelier, photo booth (min hours), fountain, chariot, smoke, dancers', () => {
  assert.equal(c('chandelier', { size: 'large', qty: 3 }).price, 36000);
  assert.equal(c('photobooth', { kind: 'spin360', hours: 1 }).price, 10000);   // 2 h minimum
  assert.equal(c('photobooth', { kind: 'mirror', hours: 4 }).price, 16000);
  assert.equal(c('chocolatefountain', { size: 'medium', servings: 150 }).price, 9000 + 150 * 40);
  assert.equal(c('chariot', { kind: 'horse', trips: 2 }).price, 30000);
  assert.equal(c('smoke', { kind: 'cold_pyro', units: 4 }).price, 10000);
  assert.equal(c('dancers', { count: 6, basis: 'show', qty: 2 }).price, 6 * 2 * 3500);
  assert.equal(c('dancers', { count: 4, basis: 'hour', qty: 3 }).price, 4 * 3 * 1500);
});
t('rounding: fractional areas round to whole rupees', () => {
  const r = c('stage', { lengthM: 3.333, widthM: 2.777 }, { perSqM: 451.37 });
  assert.equal(r.price, Math.round(3.333 * 2.777 * 451.37)); assert.ok(Number.isInteger(r.price));
});
t('zero / negative / huge / non-numeric specs rejected', () => {
  for (const bad of [{ lengthM: 0, widthM: 5 }, { lengthM: -8, widthM: 5 }, { lengthM: 1e9, widthM: 5 }, { lengthM: 'x', widthM: 5 }, { lengthM: NaN, widthM: 5 }, { lengthM: Infinity, widthM: 5 }, { widthM: 5 }])
    assert.throws(() => c('stage', bad));
  assert.throws(() => c('generator', { kva: 0 })); assert.throws(() => c('generator', { kva: 99999 })); assert.throws(() => c('generator', { kva: 125, days: -1 }));
  assert.throws(() => c('dancers', { count: 0 })); assert.throws(() => c('lighting', { kind: 'par', qty: 1e7 }));
});
t('missing rate -> catalog price with "rate not set"; bad spec -> catalog with "spec invalid"', () => {
  const it = { type: 'stage', category: 'structure', properties: { spec: { lengthM: 8, widthM: 5 } } };
  const noCard = S.price(it, {}, 45000); assert.equal(noCard.price, 45000); assert.equal(noCard.note, 'rate not set'); assert.equal(noCard.spec, false);
  const noKey = S.price(it, { stage: { base: 0 } }, 45000); assert.equal(noKey.price, 45000); assert.equal(noKey.note, 'rate not set');
  const djOpt = S.price({ type: 'dj', properties: { spec: { setup: 'stadium', power: 'pin3' } } }, R, 10000); assert.equal(djOpt.note, 'rate not set'); assert.equal(djOpt.price, 10000);
  const bad = S.price({ type: 'stage', properties: { spec: { lengthM: -1, widthM: 5 } } }, R, 45000); assert.equal(bad.price, 45000); assert.match(bad.note, /^spec invalid/);
  assert.equal(S.price({ type: 'stage', properties: {} }, R, 45000).price, 45000);   // no spec: old price
  assert.equal(S.price({ type: 'tent', properties: { spec: { lengthM: 2 } } }, R, 35000).price, 35000);   // not a spec type
});
t('fromItems: items without spec priced exactly as before (old quotes unchanged)', () => {
  const items = [{ type: 'stage', category: 'structure', properties: {} }, { type: 'stage', category: 'structure' }, { type: 'dj', category: 'av' },
    { type: 'generator', category: 'logistics' }, { type: 'round', category: 'seating', properties: { seats: 8 } }];
  const r = P.fromItems(items, {});
  assert.equal(r.objectsCost, 2 * 45000 + 10000 + 15000); assert.equal(r.chairs, 8);
  assert.equal(P.fromItems(items, { stage: 40000 }).objectsCost, 80000 + 25000);
});
t('fromItems: spec items become their own lines and feed objectsCost', () => {
  const items = [{ id: 's1', type: 'stage', category: 'structure', properties: { spec: { lengthM: 8, widthM: 5, heightM: 0.6 } } },
    { type: 'stage', category: 'structure' }, { id: 'g1', type: 'generator', category: 'logistics', properties: { spec: { kva: 125, days: 1 } } }];
  const r = P.fromItems(items, {});
  assert.equal(r.objectsCost, 18000 + 45000 + 9500);
  const sl = r.objectLines.find((l) => l.spec && l.type === 'stage'); assert.equal(sl.label, 'Stage 8 × 5 m (40 m²) @ ₹450/m² = ₹18,000');
  // studio rate card overrides defaults
  assert.equal(P.fromItems(items, {}, Object.assign({}, R, { stage: { perSqM: 500 } })).objectsCost, 20000 + 45000 + 9500);
  // bad spec falls back to catalog with a note on the line
  const fb = P.fromItems([{ type: 'stage', category: 'structure', properties: { spec: { lengthM: -3, widthM: 2 } } }], {});
  assert.equal(fb.objectsCost, 45000); assert.match(fb.objectLines[0].note, /spec invalid/);
});
t('breakdown(): spec price flows into the canonical total', () => {
  const b = P.breakdown({ items: [{ type: 'stage', category: 'structure', properties: { spec: { lengthM: 8, widthM: 5 } } }], guests: 0 }, { gstPct: 18 });
  assert.equal(b.objectsCost, 18000); assert.equal(b.total, Math.round(18000 * 1.18));
});
t('rate-card validator mirrors _a86_rates_ok', () => {
  for (const k of S.TYPES) assert.ok(S.ratesOk(R[k]), k);
  for (const bad of [null, [], {}, { a: -1 }, { a: 1e8 }, { a: '1' }, { a: { b: { c: 1 } } }, { 'bad key': 1 }, { a: {} }]) assert.equal(S.ratesOk(bad), false, JSON.stringify(bad));
});
t('defaults: client mirror == SQL _a86_default_rates()', () => {
  const sql = read('supabase/migrations/0086_item_specs.sql');
  const j = JSON.parse(sql.slice(sql.indexOf("select '{", sql.indexOf('_a86_default_rates()')) + 8, sql.indexOf("}'::jsonb") + 1));
  assert.deepEqual(j, JSON.parse(JSON.stringify(R)));
  assert.deepEqual(Object.keys(j).sort(), [...S.TYPES].sort());
});
t('wiring: RBAC area, Control Center card, builder Adjust popup, versions', () => {
  const s = read('public/store-api.js'), cc = read('public/control.html'), bj = read('public/builder.js'), bh = read('public/builder.html');
  assert.match(s, /key: "item_pricing"/);
  assert.match(s, /rpc\("set_item_rate_card"/); assert.match(s, /rpc\("get_item_rate_cards"\)/);
  assert.match(cc, /id="itemPricingCard"/); assert.match(cc, /<script src="item-pricing\.js\?v=1"><\/script>/); assert.match(read('public/item-pricing.js'), /setItemRate\(/); assert.ok(!/innerHTML/.test(read('public/item-pricing.js')));
  assert.match(bj, /ITEM-SPEC ADJUST: BEGIN/); assert.match(bj, /ITEM-SPEC ADJUST: END/);
  assert.match(bh, /builder\.js\?v=28/); assert.match(bh, /store-api\.js\?v=158/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0086_item_specs\.sql/);
  const ap = read('supabase/APPLY-0086.sql'); assert.ok(!/[^\x00-\x7f]/.test(ap), 'APPLY-0086 must be pure ASCII');
  assert.match(read('docs/ITEM-PRICING-DEFAULTS.md'), /Generator/);
});
console.log(`item-specs: ${n} passed`);
