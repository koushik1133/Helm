// 1029 recheck fixes: saved quote total = live rail (default chairs), booklet default advance %,
// lead archive acts on the open detail (not leftover form state), rejected discount blocks save.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/quote-state.js'), ctx); vm.runInContext(read('public/booklet.js'), ctx);
const flow = read('public/flow.html'), leads = read('public/leads.html');

t('#1 saved total is derived from the stored pricing object with the same engine', () => {
  const engine = (p) => { const sub = (p.chairs || 0) * (p.chairPrice || 0) + (p.guests || 0) * (p.platePrice || 0); return { subtotal: sub, total: sub * 1.18 }; };
  const stale = { chairs: 63, chairPrice: 200, guests: 100, platePrice: 900, total: 106200 };
  const out = ctx.HelmQuoteTotal.withTotal(stale, engine);
  assert.equal(out.total, engine(stale).total); assert.equal(out.computed.total, out.total);
  assert.match(flow, /pricing=HelmQuoteTotal\.withTotal\(pricing, BPStore\.pricing\.quoteTotal\.bind\(BPStore\.pricing\)\)/);   // flow-validation: bound (this._canon)
  assert.match(flow, /if\(!chairsManual\)\{ const a=autoChairs\(\);[^\n]*renderPrice\(\)/, 'default chairs applied before the save prices');
});
t('#2 booklet advance row falls back to the flow default 10%', () => {
  const w = ctx.HelmBooklet.withAdvance;
  const r = w([{ label: 'Balance', amount: 1 }], 121068, {});
  assert.equal(r.length, 2); assert.match(r[0].label, /Advance \(10%\)/);
  assert.match(w([], 1000, { advance_pct: 25 })[0].label, /25%/);
  assert.equal(w([], 1000, { advance_pct: 0 }).length, 0);
});
t('#3 archive / edit use the open detail lead, never the shared form editingId', () => {
  assert.match(leads, /\$\("#dt_del"\)\.addEventListener\("click",async\(\)=>\{\s*const id=detailId, l=leadById\(id\);\s*if\(!id \|\| !l\)/);
  assert.match(leads, /\$\("#dt_edit"\)\.addEventListener\("click",\(\)=>\{ const l=leadById\(detailId\)/);
});
t('#4 a just-rejected negative discount blocks the save', () => {
  const mk = (v, rej) => ({ value: v, getAttribute: (k) => (k === 'data-rejected' && rej ? 'negative' : null) });
  assert.ok(ctx.HelmDiscount.rejectedError([mk('', true)]));
  assert.equal(ctx.HelmDiscount.rejectedError([mk('500', true), mk('', false)]), '');
  assert.match(read('public/store-api.js'), /el\.setAttribute\("data-rejected", "negative"\)/);
  assert.match(flow, /HelmDiscount\.rejectedError\(\[\$\("#q_discount"\)/);
});
console.log(`recheck-1029: ${n} passed`);
