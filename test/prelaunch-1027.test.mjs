// Pre-launch fixes 1027: flow discount kept on save, approval wording, studio route, CRM restore label,
// booklet versions note, Settings search entry.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const src = read('public/store-api.js');
function block(s, start) { const i = s.indexOf(start); assert.ok(i >= 0, start); const o = s.indexOf('{', i); let d = 0, j = o;
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (d === 0) { j++; break; } } } return s.slice(o, j); }
const canon = new Function('a', block(src, '_canon(a)').slice(1, -1));
const qtBody = block(src, 'quoteTotal(p)').slice(1, -1);
const quoteTotal = (p) => new Function('p', qtBody).call({ _canon: canon }, p);
const F = read('public/flow.html');

t('#1 save keeps the Quotes-list 10% discount; 96,000 + 10% + 18% GST = 1,01,952', () => {
  // flow seeds #q_discount from pr.discount (0) and carries pr.discountPct into currentInputs()
  assert.match(F, /HelmDiscount\.pick\(pr\.discount, pr\.discountPct\); \$\("#q_discount"\)\.value=dv\.discount\|\|0;/);
  assert.match(F, /\.\.\.HelmDiscount\.pick\(\$\(\"#q_discount\"\)\.value, \$\(\"#q_discountPct\"\)\?\$\(\"#q_discountPct\"\)\.value:\(ev&&ev\.pricing&&ev\.pricing\.discountPct\)\)/  /* PP1028: ₹/% exclusive */);
  assert.match(F, /let pricing=Object\.assign\(\{\}, ev\.pricing\|\|\{\}, p, \{ computed:t, total:t\.total/);
  const evPricing = { chairs: 0, guests: 120, platePrice: 800, other: 0, gstPct: 18, discountPct: 10, discount: 0 };
  const p = { chairs: 0, chairPrice: 0, guests: 120, platePrice: 800, other: 0, gstPct: 18, serviceChargePct: 0,
    discount: Number(evPricing.discount || 0), discountPct: Number(evPricing.discountPct), catering: { mode: 'inhouse', gstPct: 18 } };
  const tt = quoteTotal(p);
  assert.equal(tt.subtotal, 96000); assert.equal(tt.discount, 9600); assert.equal(tt.total, 101952);
  const saved = Object.assign({}, evPricing, p, { computed: tt, total: tt.total });
  assert.equal(saved.discountPct, 10, 'discount kept'); assert.equal(saved.total, 101952);
  assert.equal(quoteTotal(saved).total, 101952, 're-open after save gives the same total');
  assert.match(F, /id="q_discountPctHint"/); assert.match(F, /stays a % when the quote is re-priced/);
});
t('#2 approval card: Booking confirmed only after an advance', () => {
  // PP1028 #1: wording now comes from HelmApprovalState (quote-state.js); "Booking confirmed" only when paid
  assert.match(F, /apprStateText\(ap==='paid'\)/);
  assert.match(read('public/quote-state.js'), /Client approved — advance pending\./);
  assert.doesNotMatch(F, /ap==='paid'\|\|ev\.status==='confirmed'\) \$\("#apprState"\)/);
});
t('#3 event Record advance uses the studio route', () => {
  assert.match(read('public/event.html'), /if\(window\.HelmUrl&&HelmUrl\.upgrade\) href=HelmUrl\.upgrade\(href\);/);
});
t('#4 CRM: one restore = one RESTORED row', () => {
  const C = read('public/crm.html');
  const fn = new Function('return (function crmActionLabels' + C.slice(C.indexOf('function crmActionLabels') + 'function crmActionLabels'.length, C.indexOf('  // Restore a DELETED lead')) + ')')();
  const rows = [
    { action: 'created', lead_id: 'L1', archived_at: '2026-10-10T10:05:02Z' },
    { action: 'created', lead_id: 'L1', archived_at: '2026-10-10T10:05:00Z' },
    { action: 'deleted', lead_id: 'L1', archived_at: '2026-10-10T10:00:00Z', restored_at: '2026-10-10T10:05:01Z' },
    { action: 'created', lead_id: 'L1', archived_at: '2026-10-09T09:00:00Z' },
  ];
  const m = fn(rows);
  assert.deepEqual(rows.map((x) => m.get(x)), ['updated', 'restored', 'archived', 'created']);
});
t('#5 booklet: 0 extra versions reads "Current quotation (Version 1)"', () => {
  const B = read('public/booklet-share.js');
  const vn = new Function('return (function versionsNote' + block(B, 'function versionsNote(cur)').replace(/^/, '(cur)') + ')')();
  assert.equal(vn({ shared_versions: [] }), 'Current quotation (Version 1)');
  assert.equal(vn({ shared_versions: [1, 2] }), '2 quote versions shown');
  assert.doesNotMatch(B, /quote version\(s\) shown/);
});
t('#6 Settings search finds "control center"', () => {
  const S = require('../public/settings-search-core.js');
  assert.match(read('public/control-split.js'), /control center centre admin/);
  const kw = /key:"general"[^\n]*kw:"([^"]+)"/.exec(read('public/control-split.js'))[1];
  const hits = S.rank('control center', [{ text: 'General', keywords: kw }, { text: 'Venues', keywords: 'venue hall space' }]);
  assert.equal(hits.length, 1); assert.equal(hits[0].text, 'General');
});
console.log(n + ' prelaunch-1027 checks passed');
