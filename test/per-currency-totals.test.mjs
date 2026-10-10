// per-currency-totals.test.mjs — 0094: money summed across many quotes is shown PER CURRENCY
// (never ₹ + AED added together). One-currency studios look exactly as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const H = require('../public/country-profile.js');
const store = read('public/store-api.js');

function storeCtx(studioCC) {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(store.slice(ti, te) + ['quoteTaxCfg', 'quoteTax', 'quoteMoney', 'studioMoney', 'quoteCurrency', 'studioCurrency', 'moneyIn', 'sumByCurrency', 'formatByCurrency'].map(pick).join('\n'), ctx);
  const st = ctx.BPStore.tax.resolve({ taxCountry: studioCC || 'IN' });
  ctx.BPStore.studioTax = () => st;
  return ctx.BPStore;
}
const MIXED = [
  { code: 'A', currency: 'INR', total: 1000000 }, { code: 'B', currency: 'AED', total: 400000 },
  { code: 'C', pricing: { total: 215300, taxCountry: 'AE' } }, { code: 'D', pricing: { total: 266494 } },
  { code: 'E', pricing: { total: 5000, taxCountry: 'US' } },
];
const amt = (q) => q.total != null ? q.total : q.pricing.total;

t('quoteCurrency: column > own pricing snapshot > INR', () => {
  const B = storeCtx('IN');
  assert.deepEqual(MIXED.map((q) => B.quoteCurrency(q)), ['INR', 'AED', 'AED', 'INR', 'USD']);
  assert.equal(B.quoteCurrency({}), 'INR'); assert.equal(B.quoteCurrency(null), 'INR');
});

t('single-currency studio: one group, formatted exactly like studioMoney', () => {
  const B = storeCtx('IN');
  const rows = [{ pricing: { total: 100000 } }, { pricing: { total: 266494 } }, { currency: 'INR', pricing: { total: 900000 } }];
  const g = B.sumByCurrency(rows, (q) => q.pricing.total);
  assert.equal(g.length, 1); assert.equal(g[0].currency, 'INR'); assert.equal(g[0].total, 1266494); assert.equal(g[0].count, 3);
  assert.equal(B.formatByCurrency(g), B.studioMoney(1266494));
  assert.equal(B.formatByCurrency(g), '₹' + (1266494).toLocaleString('en-IN'));
  assert.equal(B.moneyIn(1266494, 'INR', { round: true }), B.studioMoney(1266494, { round: true }));
  assert.equal(B.formatByCurrency([]), '₹0');
});

t('mixed INR + AED + USD: separate totals, studio currency first, no FX', () => {
  const B = storeCtx('IN');
  const g = B.sumByCurrency(MIXED, amt);
  assert.deepEqual(JSON.parse(JSON.stringify(g.map((x) => [x.currency, x.total, x.count]))), [['INR', 1266494, 2], ['AED', 615300, 2], ['USD', 5000, 1]]);
  const s = B.formatByCurrency(g);
  assert.equal(s, '₹12,66,494 · AED 615,300 · $5,000');
  assert.ok(!s.includes('1,886,794') && !s.includes('18,86,794'), 'never added across currencies');
});

t('UAE studio: AED listed first and formatted like its studioMoney', () => {
  const B = storeCtx('AE');
  const g = B.sumByCurrency(MIXED, amt);
  assert.equal(g[0].currency, 'AED');
  assert.equal(B.moneyIn(615300, 'AED'), B.studioMoney(615300));
  assert.equal(B.moneyIn(1266494, 'INR'), '₹12,66,494');
  assert.equal(B.moneyIn(5, 'XYZ'), 'XYZ 5');
});

t('averages per currency (server rows), never a blended average', () => {
  const B = storeCtx('IN');
  const rows = [{ currency: 'AED', revenue: 80000, events: 2 }, { currency: 'INR', revenue: 100000, events: 1 }];
  const g = B.sumByCurrency(rows, (r) => r.revenue / r.events, (r) => r.currency);
  assert.deepEqual(JSON.parse(JSON.stringify(g.map((x) => [x.currency, x.total]))), [['INR', 100000], ['AED', 40000]]);
});

t('client page: totals.by_currency -> one figure per currency', () => {
  const B = storeCtx('IN');
  const ctx = { window: { BPStore: B } }; ctx.window.window = ctx.window; vm.createContext(ctx);
  vm.runInContext(read('public/client.js').replace('(typeof window !== "undefined" ? window : globalThis)', '(window)'), ctx);
  const C = ctx.window.HelmClient360;
  const bc = [{ currency: 'AED', quoted: 80000, paid: 10000, due: 70000 }, { currency: 'INR', quoted: 100000, paid: 40000, due: 60000 }, { currency: 'USD', quoted: 20000 }];
  assert.equal(C.moneyByCurrency(bc, 'quoted'), '₹1,00,000 · AED 80,000 · $20,000');
  assert.equal(C.moneyByCurrency(bc, 'paid'), '₹40,000 · AED 10,000');
  assert.equal(C.moneyByCurrency([], 'due'), '—');
  const src = read('public/client.js');
  assert.match(src, /t\.by_currency\.length > 1 \? t\.by_currency : null/);
  assert.match(src, /bc \? moneyByCurrency\(bc, k\) : \(t\[k\] != null \? money\(t\[k\]\) : "—"\)/);
});

// reports.html perCurrency(): CSV currency column + per-currency subtotal rows
function reportsPerCurrency(studioCC) {
  const h = read('public/reports.html'); const s = h.indexOf('  function perCurrency('), e = h.indexOf('\n  }\n', s) + 4;
  const ctx = { BPStore: storeCtx(studioCC) }; vm.createContext(ctx); vm.runInContext(h.slice(s, e) + ';this.perCurrency=perCurrency;', ctx);
  return ctx.perCurrency;
}
t('exports: one currency = the old CSV rows unchanged', () => {
  const pc = reportsPerCurrency('IN');
  const rows = [{ code: 'A', total: 10 }, { code: 'B', total: 20 }];
  assert.equal(pc(rows, ['INR', 'INR'], ['total'], 'code'), rows);
});
t('exports: mixed currencies get a currency column + one subtotal row each', () => {
  const pc = reportsPerCurrency('IN');
  const out = pc([{ code: 'A', revenue: 100, profit: 10 }, { code: 'B', revenue: 50, profit: 5 }, { code: 'C', revenue: 30, profit: 3 }, { code: 'D', revenue: 7, profit: 1 }],
    ['INR', 'AED', 'AED', 'USD'], ['revenue', 'profit'], 'code');
  assert.deepEqual(Object.keys(out[0]), ['code', 'currency', 'revenue', 'profit']);
  assert.deepEqual(out.slice(0, 4).map((r) => r.currency), ['INR', 'AED', 'AED', 'USD']);
  assert.deepEqual(out.slice(4).map((r) => [r.code, r.currency, r.revenue, r.profit]),
    [['Subtotal INR', 'INR', 100, 10], ['Subtotal AED', 'AED', 80, 8], ['Subtotal USD', 'USD', 7, 1]]);
});

t('reports: P&L print totals per currency; all three CSV builders route through perCurrency', () => {
  const h = read('public/reports.html');
  assert.equal((h.match(/return perCurrency\(/g) || []).length, 3);
  assert.match(h, /BPStore\.sumByCurrency\(evs,e=>e\.revenue\|\|0,e=>e\.currency\|\|"INR"\)/);
  assert.match(h, /esc\(multi\?"Total "\+t\.currency:"Total"\)/);
  assert.ok(!/inr\(tot\.rev\)/.test(h), 'old blended total removed');
});

t('insights: per-currency KPIs, chart switcher, per-event currency column (single = unchanged)', () => {
  const h = read('public/insights.html');
  assert.match(h, /if\(canFin && m && bc && bc\.length>1\)\{ \$\("#moneyWrap"\)\.hidden=false; renderMoneyMulti\(bc,d\); \}/);
  assert.match(h, /function renderMoneyMulti\(bc,d\)/);
  assert.match(h, /event\(s\) in other currencies not shown in the bar/);
  assert.match(h, /event\(s\) in other currencies not shown"/);
  assert.match(h, /<th scope="col" id="peCurTh" aria-sort="none" hidden>/);
  assert.match(h, /\$\("#peCurTh"\)\.hidden=!peMulti;/);
  assert.match(h, /function renderMarginsMulti\(mw,mz,byC\)/);
  assert.match(h, /margin "\+bc\.map\(x=>x\.currency\+" "/);   // margin % per currency
  // the single-currency branch keeps the old studioMoney formatting
  assert.match(h, /inr=\(n\)=>one\?curM\(n,one\):BPStore\.studioMoney\(n,\{round:true\}\)/);
});

t('store-api: closed-event margins carry currency; profit + average margin per currency', () => {
  assert.match(store, /revenue: pl\.revenue, currency: BPStore\.quoteCurrency\(e\) \}\)\)/);
  assert.match(store, /margins: \{ events: mlist, withRevenue, noRevenue, totalProfit, avgMargin, byCurrency \}/);
  assert.match(store, /avgMargin: w\.length \? Math\.round\(w\.reduce\(\(a, x\) => a \+ \(x\.marginPct \|\| 0\), 0\) \/ w\.length\) : null/);
});

t('0094 SQL: additive, manifest, paste-ready APPLY with verify rows', () => {
  const m = read('supabase/migrations/0094_per_currency_totals.sql'), a = read('supabase/APPLY-0094.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward {2}supabase\/migrations\/0094_per_currency_totals\.sql/);
  assert.ok(!/drop |delete from|truncate|alter table/i.test(m.replace(/^--.*$/gm, '')), 'functions only');
  assert.equal((m.match(/security definer set search_path = ''/g) || []).length, 3);
  for (const k of ["'money_by_currency'", "'types_by_currency'", "'cash_by_currency'", "'currency', cur,", "'by_currency'"]) assert.ok(m.includes(k), k);
  assert.ok(/^[\x00-\x7f]*$/.test(a), 'APPLY is ASCII');
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m);
  assert.match(a, /\) v\(item, ok\)\norder by item;\s*$/);
  assert.equal((a.match(/\('0094 0\d /g) || []).length, 6);
  assert.match(read('scripts/db-test/run-all.sh'), /PER-CURRENCY-0094: ALL PASS \\\(12\/12\\\)/);
});

let pass = 0; for (const [n, f] of tests) { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { console.log('  ✗ ' + n + '\n    ' + e.message); process.exitCode = 1; } }
console.log('per-currency-totals: ' + pass + '/' + tests.length + ' passed');
