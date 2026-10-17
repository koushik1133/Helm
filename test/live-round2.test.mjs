// live-round2.test.mjs — regressions for live-test round 2 (C1-C5).
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
const AE = { taxCountry: 'AE', taxName: 'VAT', currency: 'AED', gstPct: 5, total: 1050, chairs: 10 };
const KEYS = ['taxCountry', 'taxRegion', 'currency', 'taxName', 'taxInclusive'];
const same = (a, b, tag) => KEYS.forEach((k) => assert.deepEqual(a[k], b[k], tag + ' ' + k));

t('C3 every pricing writer keeps the quote tax snapshot', () => {
  // builder sync: rebuilt object without tax keys
  same(T.preserveSnapshot(AE, { chairs: 12, gstPct: 5, total: 1260 }), AE, 'builder');
  // quotes.html gatherPricing stamped with the STUDIO's (India) tax -> quote keeps AE
  same(T.preserveSnapshot(AE, { chairs: 12, currency: 'INR', gstPct: 18 }), AE, 'quotes.html');
  // flow currentInputs with undefined-clearing keys
  same(T.preserveSnapshot(AE, { currency: 'INR', taxCountry: undefined, taxName: undefined, taxInclusive: undefined, taxRegion: undefined }), AE, 'flow');
  // layout wizard / menu package / flow-layout-sync style partial merges
  same(T.preserveSnapshot(AE, Object.assign({}, AE, { other: 900, otherAuto: 900 })), AE, 'layout sync');
  // an India quote stays India when the studio is now UAE (no keys added)
  const IN = { gstPct: 18, total: 118, currency: 'INR' };
  const o = T.preserveSnapshot(IN, { gstPct: 18, taxCountry: 'AE', currency: 'AED', taxName: 'VAT' });
  assert.equal(o.taxCountry, undefined); assert.equal(o.currency, 'INR'); assert.equal(o.taxName, undefined);
  // soft keys survive a writer that doesn't know them
  const p2 = T.preserveSnapshot(Object.assign({ placeOfSupply: 'inter', supplier: { name: 'S' }, taxExempt: true }, IN), { gstPct: 18 });
  assert.equal(p2.placeOfSupply, 'inter'); assert.deepEqual(p2.supplier, { name: 'S' }); assert.equal(p2.taxExempt, true);
  // ... but an explicit untick (taxExempt: undefined present) wins
  assert.equal(T.preserveSnapshot({ taxExempt: true, gstPct: 5 }, { taxExempt: undefined }).taxExempt, undefined);
});
t('C3 explicit Switch re-stamps to the studio country (INR quote -> AED/VAT 5%)', () => {
  const IN = { gstPct: 18, total: 118, currency: 'INR' };
  const studio = T.resolve({ taxCountry: 'AE', gstPct: 5 });
  const next = Object.assign({}, IN, { gstPct: 5, currency: 'INR', taxCountry: undefined }, T.snapshot(studio));
  const o = T.preserveSnapshot(IN, next, { switch: true });
  assert.equal(o.taxCountry, 'AE'); assert.equal(o.currency, 'AED'); assert.equal(o.taxName, 'VAT'); assert.equal(o.gstPct, 5);
  assert.equal(B.quoteTax({ pricing: JSON.parse(JSON.stringify(o)) }).currency, 'AED');
  // a later builder / layout write keeps AED
  same(T.preserveSnapshot(JSON.parse(JSON.stringify(o)), { chairs: 1, gstPct: 5 }), o, 'after switch');
});
t('C3 new quote in an AE / US studio starts in its currency', () => {
  const ae = T.snapshot(T.resolve({ taxCountry: 'AE', gstPct: 5 }));
  assert.equal(ae.taxCountry, 'AE'); assert.equal(ae.currency, 'AED'); assert.equal(T.resolve(ae).rate, 5);
  // unpriced quote: the first write takes the studio snapshot (nothing to preserve)
  assert.equal(T.preserveSnapshot({}, Object.assign({ gstPct: 5 }, ae)).taxCountry, 'AE');
  assert.equal(T.preserveSnapshot({ taxCountry: 'AE', currency: 'AED' }, Object.assign({ gstPct: 5 }, ae)).currency, 'AED');
  const us = T.snapshot(T.resolve({ taxCountry: 'US', taxRegion: 'CA', gstPct: 7.25 }));
  assert.equal(us.taxCountry, 'US'); assert.equal(us.currency, 'USD'); assert.equal(us.taxRegion, 'CA');
  assert.equal(T.resolve(Object.assign({ gstPct: 7.25 }, us)).rate, 7.25);
  assert.deepEqual(JSON.parse(JSON.stringify(T.snapshot(T.resolve({ taxCountry: 'IN', gstPct: 18 })))), {});
});
t('C3 wiring: flow / builder / quotes.html route writes through preserveSnapshot; Switch persists', () => {
  const flow = read('public/flow.html'), bj = read('public/builder.js'), qh = read('public/quotes.html');
  assert.match(flow, /pricing=BPStore\.tax\.preserveSnapshot\(ev\.pricing\|\|\{\}, pricing, \{ switch: taxSwitched \}\);/);
  assert.match(flow, /quoteKeep = !taxSwitched && priced/);
  assert.match(flow, /taxSwitched=true;[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*BPUI\.guard\(\$\("#q_curSwitch"\), async\(\)=>\{ await saveQuotation\(\);/);
  assert.match(flow, /async function stampNewQuoteTax\(\)/); assert.match(flow, /stampNewQuoteTax\(\);/);
  assert.match(bj, /BPStore\.tax\.preserveSnapshot\(currentPricing, Object\.assign\(\{\}, p, \{ computed:t, total:t\.total, client: currentClient \}\)\)/);
  assert.match(qh, /BPStore\.tax\.preserveSnapshot\(prevPr, pricing, \{ switch: cmTaxSwitched \}\);\n\s*Object\.keys\(pricing\)\.forEach\(\(k\) => \{ if \(!\(k in keep\)\) delete pricing\[k\]; \}\); Object\.assign\(pricing, keep\);/);
  assert.match(qh, /cmKeep=false; cmTaxSwitched=true;/);
});

const C = require('../public/smart-import-core.js');
const mapOne = (entity, h) => C.autoMap(entity, ['Name', h], [['X', '15']])[1].target;
t('C1 smart import: rental vs purchase price header variants', () => {
  for (const h of ['Rate/day (AED)', 'Rate / day', 'Per day', 'Day rate', 'Daily rate', 'Hire', 'Hire rate', 'Rent', 'Rental', 'Rental price', 'Rate per event', 'Rent per day'])
    assert.equal(mapOne('inventory', h), 'field:rental_price', h);
  for (const h of ['Purchase price', 'Purchase', 'Cost', 'Cost price', 'Buying price', 'MRP', 'Unit cost'])
    assert.equal(mapOne('inventory', h), 'field:unit_cost', h);
  assert.equal(mapOne('inventory', 'Purchase date'), 'field:purchase_date');
  const m = C.autoMap('inventory', ['Item', 'Qty', 'Rate/day (AED)', 'Purchase price (AED)', 'Replacement cost'], [['Chair', '10', '15', '40', '50']]).map((x) => x.target);
  assert.deepEqual(m, ['field:name', 'field:total_qty', 'field:rental_price', 'field:unit_cost', 'field:replacement_cost']);
  assert.equal(mapOne('menu', 'Rate/plate'), 'field:price_per_plate'); assert.equal(mapOne('menu', 'Price'), 'field:price_per_plate');
  assert.equal(mapOne('menu', 'Food cost'), 'field:cost'); assert.equal(mapOne('menu', 'Cost'), 'field:cost');
  assert.equal(mapOne('staff', 'Per day'), 'field:day_rate'); assert.equal(mapOne('staff', 'Rate/day'), 'field:day_rate');
  assert.equal(mapOne('vendors', 'Rate'), 'field:rate');
});
t('C5 money attributes shown with the studio currency', () => {
  const money = (n) => 'AED ' + Number(n).toFixed(2);
  const v = (e, a, defs) => Object.fromEntries(C.attrList(e, a, defs, { money }).map((x) => [x.key, x.value]));
  const inv = v('inventory', { rental_price: 15, replacement_cost: '200', unit_cost: 40, colour: 'Red', rating_note: 'ok' });
  assert.equal(inv.rental_price, 'AED 15.00'); assert.equal(inv.replacement_cost, 'AED 200.00'); assert.equal(inv.unit_cost, 'AED 40.00'); assert.equal(inv.colour, 'Red');
  const st = v('staff', { monthly_salary: 3000, hourly_rate: 20, rating: 4 });
  assert.equal(st.monthly_salary, 'AED 3000.00'); assert.equal(st.hourly_rate, 'AED 20.00'); assert.equal(st.rating, '4');
  assert.equal(v('menu', { cost: 12 }).cost, 'AED 12.00');
  assert.equal(v('vendors', { rate: 500 }).rate, 'AED 500.00');
  // custom field defs decide; non-numeric values stay text
  assert.equal(v('inventory', { deposit_amt: 50 }, [{ key: 'deposit_amt', label: 'Deposit', type: 'money' }]).deposit_amt, 'AED 50.00');
  assert.equal(v('inventory', { hire_rate: 'on request' }).hire_rate, 'on request');
  // no formatter available (node) -> unchanged raw value
  assert.equal(C.attrList('inventory', { rental_price: 15 }, [])[0].value, '15');
});

// C2 layout wizard quality
const js = read('public/builder.js');
const block = (s) => { let i = js.indexOf('{', s), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const fn = (name) => { const s = js.indexOf('function ' + name + '('); let i = js.indexOf('{', js.indexOf(')', s)), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const line = (h) => { const s = js.indexOf(h); return js.slice(s, js.indexOf('\n', s)); };
const BB = new Function([block(js.indexOf('const ASSETS = {')) + ';', line('const round1 = '), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '),
  'let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";', fn('makeItem'), fn('genSeats'), fn('sumSeats'), 'return { ASSETS, makeItem, genSeats, sumSeats };'].join('\n'))();
const HW = require('../public/layout-wizard.js');
const D = { ASSETS: BB.ASSETS, makeItem: BB.makeItem, genSeats: BB.genSeats };
const rectOf = (it) => { const q = (((+it.rotation || 0) % 180) + 180) % 180, sw = q > 45 && q < 135 ? it.height : it.width, sh = q > 45 && q < 135 ? it.width : it.height; return { x: it.x + it.width / 2 - sw / 2, y: it.y + it.height / 2 - sh / 2, w: sw, h: sh }; };
const isMain = (it) => it.type === 'seatblock' || (it.type === 'chairrow' && /^Seating block/.test(it.label || '')) || (it.type === 'table' && /^T\d/.test(it.label || '')) || it.type === 'longtable';
t('C2 wedding 400 guests in 200x140: balanced round-table grid filling the zone', () => {
  const spec = HW.defaults('wedding', { guests: 400, w: 200, h: 140 }); const out = HW.layout(spec, D);
  const tb = out.items.filter((i) => i.type === 'table' && /^T\d/.test(i.label)).map(rectOf);
  assert.equal(BB.sumSeats(out.items.filter(isMain)), out.main); assert.ok(out.fits);
  const rows = new Set(tb.map((r) => r.y.toFixed(1))).size; assert.ok(rows >= 3, 'rows ' + rows);
  const y0 = Math.min(...tb.map((r) => r.y)), y1 = Math.max(...tb.map((r) => r.y + r.h)), dz = out.zone.bottom - out.zone.top;
  assert.ok((y1 - y0) / dz >= 0.6, 'depth used');
  // pitch at least the comfortable 10 ft between table centres in a row
  const r0 = tb.filter((r) => Math.abs(r.y - y0) < 0.1).map((r) => r.x).sort((a, b) => a - b);
  for (let i = 1; i < r0.length; i++) if (Math.abs(r0[i] - r0[i - 1]) < 20) assert.ok(r0[i] - r0[i - 1] >= 10 - 1e-6, 'pitch');
});
t('C2 seating uses the zone for every type / hall / style (span >= 50% or centred)', () => {
  let n = 0;
  for (const type of Object.keys(HW.TYPES)) for (const [W, H2, G] of [[200, 140, 400], [200, 140, 900], [80, 50, 160], [262, 164, 1500], [120, 80, 300], [300, 100, 600]])
    for (const st of [null, 'rounds', 'theatre', 'banquet', 'mixed']) {
      const spec = HW.defaults(type, { guests: G, w: W, h: H2 }); if (st) { spec.seating.style = st; HW.fitSeating(spec); }
      if (spec.seating.style === 'standing') continue;
      const out = HW.layout(spec, D); if (!out.fits) continue;
      const m = out.items.filter(isMain).map(rectOf); if (!m.length) continue;
      const y0 = Math.min(...m.map((r) => r.y)), y1 = Math.max(...m.map((r) => r.y + r.h)), dz = out.zone.bottom - out.zone.top;
      const span = (y1 - y0) / dz, off = Math.abs((y0 + y1) / 2 - (out.zone.top + out.zone.bottom) / 2) / dz;
      assert.ok(span >= 0.5 || off <= 0.1, `${type} ${W}x${H2} ${G} ${spec.seating.style}: span ${span.toFixed(2)} off ${off.toFixed(2)}`); n++;
    }
  assert.ok(n > 100, 'checked ' + n);
});
t('C4 fill-only migration note documented', () => {
  const d = read('docs/FILL-ONLY-MIGRATIONS.md');
  assert.match(d, /disable trigger quotes_set_updated/); assert.match(d, /enable trigger quotes_set_updated/); assert.match(d, /0091/);
});
t('versions bumped', () => {
  assert.match(read('public/flow.html'), /store-api\.js\?v=215/);
  assert.match(read('public/inventory.html'), /smart-import-core\.js\?v=6/);
  assert.match(read('public/builder.html'), /layout-wizard\.js\?v=12/); assert.match(read('public/builder.html'), /builder\.js\?v=65/);
});
let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('ok  - ' + n); } catch (e) { console.error('FAIL - ' + n + '\n', e); process.exitCode = 1; } }
console.log(`live-round2: ${pass}/${tests.length} passed`);

// C5b: a built-in money attribute whose def was saved as "number" by an earlier import still shows currency
{
  const { readFileSync } = await import('node:fs'); const vm = (await import('node:vm')).default;
  const cx = { window: { BPStore: { studioMoney: (n) => 'AED ' + n } } }; cx.globalThis = cx; vm.createContext(cx);
  vm.runInContext(readFileSync(new URL('../public/smart-import-core.js', import.meta.url), 'utf8'), cx);
  const C = cx.window.HelmImportCore || cx.HelmImportCore;
  const defs = [{ key: 'rental_price', label: 'Rental price', type: 'number', active: true }, { key: 'colour', label: 'Colour', type: 'text', active: true }, { key: 'pax', label: 'Pax', type: 'number', active: true }];
  const out = C.attrList('inventory', { rental_price: '15', colour: 'Gold', pax: '8' }, defs);
  const v = Object.fromEntries(out.map((x) => [x.key, x.value]));
  if (v.rental_price !== 'AED 15' || v.colour !== 'Gold' || v.pax !== '8') throw new Error('C5b ' + JSON.stringify(v));
  console.log('ok - C5b money attr with number def');
}
