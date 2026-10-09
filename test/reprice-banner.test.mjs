// R4: re-price banner (flow.html, 0077 price snapshot) - simulate a price-list change on a
// saved snapshot and assert the banner lines + old -> new totals (runs the shipping code).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok - ' + name); };

const src = read('public/store-api.js');
function block(start) { const i = src.indexOf(start); assert.ok(i >= 0, start); const o = src.indexOf('{', i); let d = 0, j = o;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { j++; break; } } } return src.slice(o, j); }
const canon = new Function('a', block('_canon(a)').slice(1, -1));
const qtBody = block('quoteTotal(p)').slice(1, -1);
const quoteTotal = (p) => new Function('p', qtBody).call({ _canon: canon }, p);
const ti = src.indexOf('BPStore.tax = (function () {'); const te = src.indexOf('})();', ti) + 5;
const tctx = { BPStore: { countries: () => [] } }; vm.runInNewContext(src.slice(ti, te), tctx);

const flow = read('public/flow.html');
const a = flow.indexOf('const nOrNull=v=>'), b = flow.indexOf('async function applyReprice');
assert.ok(a > 0 && b > a, 'reprice block found');
const fTaxSrc = flow.slice(flow.indexOf('const fTax=()=>'), flow.indexOf('\n', flow.indexOf('const inr=(n)=>')));

function harness({ pricing, rates, status = 'draft', eventDate = '2099-01-01' }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, hidden: true, textContent: '', children: [], appendChild(c) { this.children.push(c); } });
  const ctx = {
    BPStore: { tax: tctx.BPStore.tax, pricing: { quoteTotal, fromItems: () => ({ objectsCost: 0, chairs: 0 }) } },
    $: (s) => el(s.replace('#', '')), document: { createElement: () => ({ textContent: '' }) },
    sessionStorage: { getItem: () => null }, ev: { pricing, status, eventDate, lifecycleStage: 'planning' },
    rates, appliedPkg: null, layoutItems: [], failed: {}, canEdit: true, id: 'q1', quoteBlocked: () => false,
  };
  vm.createContext(ctx);
  vm.runInContext('var ev=this.ev, rates=this.rates, appliedPkg=null, layoutItems=[], failed={}, canEdit=true, id="q1";\n'
    + fTaxSrc + '\n' + flow.slice(a, b) + '\nthis.repriceDiff=repriceDiff; this.renderReprice=renderReprice;', ctx);
  return { ctx, els };
}
// a quote saved at the old price list (the shipping save path: pricing = inputs + computed + _ratesAt)
function savedQuote(inputs) { const tt = quoteTotal(inputs); return { ...inputs, computed: tt, total: tt.total, _ratesAt: { chairPrice: inputs.chairPrice, platePrice: inputs.platePrice, gstPct: inputs.gstPct, serviceChargePct: 0, layoutBase: 0, assets: '[]' } }; }
const base = { chairs: 100, chairPrice: 200, guests: 100, platePrice: 500, other: 0, gstPct: 18, serviceChargePct: 0, discount: 0, catering: { mode: 'inhouse', gstPct: 18 }, placeOfSupply: 'intra', currency: 'INR' };

t('unchanged price list -> no banner', () => {
  const h = harness({ pricing: savedQuote(base), rates: { chairPrice: 200, platePrice: 500, gstPct: 18, serviceChargePct: 0, layoutBase: 0 } });
  assert.equal(h.ctx.repriceDiff(), null); h.ctx.renderReprice(); assert.equal(h.els.repriceBanner.hidden, true);
});
t('chair + plate rate change -> per-line old->new and totals', () => {
  const pr = savedQuote(base); assert.equal(pr.total, 82600);
  const h = harness({ pricing: pr, rates: { chairPrice: 250, platePrice: 600, gstPct: 18, serviceChargePct: 0, layoutBase: 0 } });
  const d = h.ctx.repriceDiff();
  assert.equal(d.oldTotal, 82600); assert.equal(d.newTotal, Math.round((100 * 250 + 100 * 600) * 1.18));
  h.ctx.renderReprice(); assert.equal(h.els.repriceBanner.hidden, false);
  const lines = h.els.repriceLines.children.map((c) => c.textContent);
  assert.deepEqual(lines, ['Chair rate · 100 chairs: ₹200 → ₹250 (₹20,000 → ₹25,000)', 'Plate price · 100 plates: ₹500 → ₹600 (₹50,000 → ₹60,000)']);
  assert.match(h.els.repriceMeta.textContent, /Total ₹82,600 → ₹1,00,300 at today's prices/);
});
t('GST + service charge change -> pct lines, total re-computed', () => {
  const h = harness({ pricing: savedQuote(base), rates: { chairPrice: 200, platePrice: 500, gstPct: 5, serviceChargePct: 10, layoutBase: 0 } });
  const d = h.ctx.repriceDiff();
  assert.deepEqual(JSON.parse(JSON.stringify(d.lines)).map((l) => [l.label, l.from, l.to]), [['GST', 18, 5], ['Service charge', 0, 10]]);
  assert.equal(d.newTotal, Math.round(70000 * 1.1 * 1.05));
});
t('country tax: the line uses the studio tax name, not "GST"', () => {
  const pr = savedQuote({ ...base, gstPct: 5, catering: { mode: 'inhouse', gstPct: 5 }, taxCountry: 'AE', taxName: 'VAT', currency: 'AED' });
  const h = harness({ pricing: pr, rates: { chairPrice: 200, platePrice: 500, gstPct: 0, serviceChargePct: 0, layoutBase: 0, taxCountry: 'AE' } });
  const d = h.ctx.repriceDiff(); assert.equal(d.lines[0].label, 'VAT'); assert.equal(d.newTotal, 70000);
});
t('switching "prices include tax" shows a line and the new (tax-inclusive) total', () => {
  const h = harness({ pricing: savedQuote(base), rates: { chairPrice: 200, platePrice: 500, gstPct: 18, serviceChargePct: 0, layoutBase: 0, taxInclusive: true } });
  const d = h.ctx.repriceDiff(); assert.equal(d.oldTotal, 82600); assert.equal(d.newTotal, 70000);
  h.ctx.renderReprice(); assert.equal(h.els.repriceLines.children[0].textContent, 'Prices include GST: no → yes');
});
t('past / closed events never show the banner', () => {
  const h = harness({ pricing: savedQuote(base), rates: { chairPrice: 999, platePrice: 500, gstPct: 18 }, eventDate: '2001-01-01' });
  assert.equal(h.ctx.repriceDiff(), null);
});
t('re-save clears stale tax snapshot keys (currentInputs sets them undefined before the snapshot)', () => {
  assert.match(flow, /taxCountry:undefined, taxName:undefined, taxInclusive:undefined, \.\.\.BPStore\.tax\.snapshot\(fTax\(\)\)/);
});
console.log(`reprice-banner: ${n} passed`);
