// india-polish.test.mjs — India-first audit (Oct 2026): approval "paid" state from the payments
// ledger (advance vs paid in full), quote-currency dashboard rows, IST "today", dd/mm/yyyy dates,
// flow place of supply (IGST for inter-state), invoice place-of-supply row + discount-before-tax.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const H = require('../public/country-profile.js');
const store = read('public/store-api.js');

function B() {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(store.slice(ti, te) + ['quoteTaxCfg', 'quoteTax', 'quoteMoney', 'paymentTerms', 'fmtDateIN', 'todayLocal', 'fmtDay', 'fmtDateTime', 'paidState', 'amountInWords'].map(pick).join('\n'), ctx);
  const st = ctx.BPStore.tax.resolve({ taxCountry: 'IN' }); ctx.BPStore.studioTax = () => st;
  return ctx.BPStore;
}

t('paidState: ₹50,000 advance on ₹3,06,800 is NOT paid in full; balance + due date from terms', () => {
  const S = B().paidState({ total: 306800, paid: 50000, last_receipt: 'RCP-12202026-01-01', event_date: '2026-12-20', balance_due_days: 7 });
  assert.equal(S.full, false); assert.equal(S.balance, 256800); assert.equal(S.receipt, 'RCP-12202026-01-01'); assert.equal(S.balanceDue, '2026-12-13');
});
t('paidState: no terms -> balance due by the event date; paid >= total -> full', () => {
  const b = B();
  assert.equal(b.paidState({ total: 306800, paid: 50000, event_date: '2026-12-20' }).balanceDue, '2026-12-20');
  assert.equal(b.paidState({ total: 306800, paid: 306800 }).full, true);
  assert.equal(b.paidState(null), null); assert.equal(b.paidState({ paid: 10 }), null);
  assert.equal(b.paidState({ paid: 10, total: null }, 500).balance, 490);
});
t('approve.html: paid step computes advance vs full from the ledger RPC, not approval_status alone', () => {
  const h = read('public/approve.html');
  assert.match(h, /approval_status==='paid'\)\{ showStep\('stepPaid'\); await showPaid\(\); \}/);
  assert.match(h, /Advance of "\+inr\(ps\.paid\)\+" received"/); assert.match(h, /Paid in full/);
  assert.match(store, /paidStatus: \(token\) => mode === "supabase" \? rpc\("public_quote_paid_status"/);
  const m = read('supabase/migrations/0098_public_paid_status.sql');
  assert.match(m, /perform public\.public_get_quote\(p_token\)/); assert.match(m, /status = 'paid'/);
  assert.doesNotMatch(m, /\b(delete|update|insert|drop|alter)\b/i);
  assert.match(read('supabase/migrations/MANIFEST'), /0098_public_paid_status\.sql/);
});
t('portal + booklet + razorpay email: no "paid" wording when only an advance is in', () => {
  assert.match(read('public/portal.html'), /ps\.full\?"Paid in full":"Advance received"/);
  assert.match(read('public/booklet-pkg.js'), /paid: num\(t\.balance\) > 0 \? "Advance received — balance due" : "Paid in full"/);
  const w = read('supabase/functions/razorpay-webhook/index.ts');
  assert.match(w, /Amount received:/); assert.match(w, /Balance due:/); assert.doesNotMatch(w, /Amount: <b>\$\{total\}/);
});
t('dashboard row formats a quote total in the QUOTE currency', () => {
  const h = read('public/dashboard.html');
  assert.match(h, /esc\(BPStore\.quoteMoney\(s\.total, s\)\)/); assert.doesNotMatch(h, /" · " \+ inr\(s\.total\)/);
  assert.equal(B().quoteMoney(306800, { pricing: { taxCountry: 'IN' } }), '₹3,06,800');
});
t('dates: dd/mm/yyyy, local (IST) today, no browser-default toLocaleString', () => {
  const b = B();
  assert.equal(b.fmtDateIN('2026-12-20'), '20/12/2026');
  assert.equal(b.todayLocal(new Date(2026, 9, 10, 1, 30)), '2026-10-10');
  assert.match(b.fmtDay('2026-12-20T10:00:00'), /^20\/12\/2026$/);
  const n = read('public/nurture.html'); assert.doesNotMatch(n, /toISOString\(\)\.slice\(0,10\)/);
  for (const f of ['public/dashboard.html', 'public/approve.html', 'public/builder.js', 'public/inventory.html', 'public/quotes.html'])
    assert.doesNotMatch(read(f), /toLocale(Date)?String\(\)/, f);
});
t('flow keeps / derives GST place of supply (inter-state -> IGST), never forces intra', () => {
  const f = read('public/flow.html');
  assert.doesNotMatch(f, /placeOfSupply:"intra"/); assert.match(f, /placeOfSupply:flowPos\(\)/);
  assert.equal(B().tax.placeOfSupply('Telangana', 'Karnataka'), 'inter');
});
t('invoice: Place of supply row, discount before GST, dd/mm/yyyy dates', () => {
  const q = read('public/quotes.html');
  assert.match(q, /Place of supply<\/td>/);
  assert.ok(q.indexOf('<td>Discount</td>') < q.indexOf('${tax}`:""}'));
  assert.match(q, /BPStore\.fmtDateIN\(terms\.balanceDue\)/);
});
t('amount in words: Indian numbering', () => {
  assert.equal(B().amountInWords(306800), 'Rupees Three Lakh Six Thousand Eight Hundred only');
  assert.equal(B().amountInWords(12500000), 'Rupees One Crore Twenty Five Lakh only');
});

let fail = 0;
for (const [n, f] of tests) { try { await f(); console.log('  ✓ ' + n); } catch (e) { fail++; console.error('  ✗ ' + n + '\n    ' + e.message); } }
console.log(fail ? `${fail} failed` : `india-polish: ${tests.length} passed`); if (fail) process.exit(1);
