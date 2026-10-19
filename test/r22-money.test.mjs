// r22-money.test.mjs - r22 live QA, money consistency (fix/r22-money-consistency):
//  1  Insights: the per-event profit table and the Money tiles use the 0246 ledger rows (insights_event_costs =
//     event_pnl, crew wages counted) - the same margin as "Event costs & profit", Benchmarks and Business
//  2  Budget: the cost lines' "Planned margin" = the shared P&L planned margin (Budget & margin card)
//  3  Staff on the event = crew wage lines: ONE rule (a crew task counts unless rejected / cancelled, also while
//     "unassigned") on the screens (store-api) and the server (0252, proven on Postgres in tests/db/r22-money-0252.sql)
//  4  phones: stacked-table labels skip hidden columns and stay readable while amounts are hidden; long titles "..."
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const J = (v) => JSON.parse(JSON.stringify(v));

const INS = read('public/insights.html'), IC = read('public/insights-costs.js'), ICSS = read('public/insights-polish.css');
const STORE = read('public/store-api.js'), BUD = read('public/budget.html'), BP = read('public/budget-plan.js');
const TMJS = read('public/tables-mobile.js'), TMCSS = read('public/tables-mobile.css');
const SQL = read('supabase/migrations/0252_crew_wages_unassigned.sql'), APPLY = read('supabase/APPLY-0252.sql');
const S0246 = read('supabase/migrations/0246_event_money_ledger.sql'), MANIFEST = read('supabase/migrations/MANIFEST');
const RUNALL = read('scripts/db-test/run-all.sh'), DBT = read('tests/db/r22-money-0252.sql');

const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(IC, ctx);
const X = ctx.window.HelmInsightsCosts;

console.log('r22 money - Insights on the ledger:');
// the live QA case: SMP-1001 old table 100% (no wages), ledger 98%
const pe = [{ id: 'e1', code: 'SMP-1001', date: '2026-10-19', currency: 'INR', revenue: 590000, revenue_ex_tax: 500000, cost: 0, profit: 500000, profit_ex_tax: 500000, margin_pct: 100, margin_pct_ex_tax: 100, collected: 1, outstanding: 2 },
            { id: 'e9', code: 'OLD-1', date: '2026-10-19', currency: 'INR', revenue_ex_tax: 1000, cost: 100, profit_ex_tax: 900, margin_pct_ex_tax: 90 }];
const led = [{ id: 'e1', code: 'SMP-1001', date: '2026-10-19', currency: 'INR', revenue: 500000, cost_total: 10000, crew: 10000, expense_claims: 0, profit: 490000, margin_pct: 98, collected: 200000, outstanding: 390000 },
             { id: 'e2', code: 'SMP-1002', date: '2026-10-20', currency: 'INR', revenue: 200000, cost_total: 47000, expense_claims: 2000, profit: 153000, collected: 236000, outstanding: 0 },
             { id: 'e3', code: 'SMP-0900', date: '2026-09-01', currency: 'INR', revenue: 100000, cost_total: 0, profit: 100000 },        // benchmark window only
             { id: 'e4', code: 'DXB-1', date: '2026-10-10', currency: 'aed', revenue: 10000, cost_total: 2500, expense_claims: 500, profit: 7500 }];

t('alignEvents: a row with a ledger twin gets its revenue / cost / profit / margin / collected / outstanding (98%, not 100%)', () => {
  const a = J(X.alignEvents(pe, led));
  assert.equal(a[0].margin_pct_ex_tax, 98); assert.equal(a[0].margin_pct, 98);
  assert.equal(a[0].profit_ex_tax, 490000); assert.equal(a[0].cost, 10000); assert.equal(a[0].revenue_ex_tax, 500000);
  assert.equal(a[0].collected, 200000); assert.equal(a[0].outstanding, 390000); assert.equal(a[0].ledger, true);
  assert.equal(a[0].code, 'SMP-1001'); assert.equal(a[0].revenue, 590000, 'other keys kept');
});
t('alignEvents: rows without a ledger twin stay exactly as they came; the input is never changed', () => {
  const before = J(pe); const a = X.alignEvents(pe, led);
  assert.deepEqual(J(a[1]), before[1]); assert.deepEqual(J(pe), before);
  assert.deepEqual(J(X.alignEvents(pe, null)), before); assert.deepEqual(J(X.alignEvents(null, led)), []);
});
t('alignEvents: margin = the card\'s own marginOf (same rounding as Event costs & profit / Benchmarks)', () => {
  const r = { id: 'x', revenue: 200000, profit: 153000, cost_total: 47000 };
  assert.equal(X.alignEvents([{ id: 'x' }], [r])[0].margin_pct_ex_tax, X.marginOf(r));
  assert.equal(X.alignEvents([{ id: 'x' }], [{ id: 'x', revenue: 0, profit: -10 }])[0].margin_pct_ex_tax, null);
});
t('moneyByCurrency: only events dated in the range, per currency; margin = the card\'s all-events totals', () => {
  const m = J(X.moneyByCurrency(led, '2026-10-01', '2026-10-31'));
  assert.deepEqual(Object.keys(m).sort(), ['AED', 'INR']);
  const i = m.INR, tot = J(X.totals(led.filter((r) => r.currency === 'INR' && r.date >= '2026-10-01')));
  assert.equal(i.events, 2); assert.equal(i.revenue_ex_tax, 700000); assert.equal(i.profit_ex_tax, 643000);
  assert.equal(i.margin_pct_ex_tax, tot.margin); assert.equal(i.margin_pct_ex_tax, 92);
  assert.equal(i.cost + i.expenses, tot.cost, 'Costs tile (delivery + expenses) = the card\'s Cost');
  assert.equal(i.expenses, 2000); assert.equal(i.collected, 436000); assert.equal(i.outstanding, 390000);
  assert.equal(m.AED.events, 1); assert.equal(m.AED.margin_pct_ex_tax, 75);
  assert.deepEqual(J(X.moneyByCurrency([], null, null)), {});
});
t('page: the ledger rows feed the per-event table and the Money tiles (one source), older DB keeps the old numbers', () => {
  assert.match(INS, /const ledger=\(costsUI && costRes\.status==="fulfilled"[^\n]*costRes\.value\.events : null;/);
  assert.match(INS, /peRows=ledger\?HelmInsightsCosts\.alignEvents\(raw,ledger\):raw;/);
  assert.match(INS, /renderRange\(rangeRes\.value, ledger\?HelmInsightsCosts\.moneyByCurrency\(ledger,r\.from,r\.to\):null\)/);
  assert.match(INS, /function renderRange\(d, led\)\{/);
  assert.match(INS, /if\(led\)\{ if\(bc\) bc=bc\.map\(x=>onLedger\(x,led\)\);/);
  assert.match(INS, /if\(m\) m=onLedger\(Object\.assign\(\{\},m,\{currency:k1\}\),led\); \}/);
  assert.match(INS, /the same cost and profit as Event costs &amp; profit above/);
  assert.doesNotMatch(INS, /Cost includes paid expense claims\./);
});
t('page: the per-event link carries the full title (shown on hover when "..." cuts it)', () => {
  assert.match(INS, /a\.title=a\.textContent; first\.appendChild\(a\);/);
});

console.log('r22 money - Budget planned margin on the shared P&L:');
const P = require('../public/budget-plan.js');
const costs = [{ id: 'c1', description: 'Décor', kind: 'vendor', estimated: 1000, quoted: 100000 }];
t('ledgerPlan: r21 server P&L -> its planned margin (revenue - every estimated cost incl. wages), Postgres rounding', () => {
  assert.deepEqual(J(P.ledgerPlan({ source: 'server', rules: 'r21', margin_estimated: 196000, net_revenue: 200000, cost_estimated: 4000 })), { margin: 196000, pct: 98, cost: 4000 });
  assert.equal(P.ledgerPlan({ source: 'server', rules: 'r21', margin_estimated: -2500, net_revenue: 10000 }).pct, -25);
  assert.equal(P.ledgerPlan({ source: 'server', rules: 'r21', margin_estimated: -50, net_revenue: 1000 }).pct, -5);
  assert.equal(P.ledgerPlan({ source: 'server', rules: 'r21', margin_estimated: 5, net_revenue: 0 }).pct, null);
  assert.equal(P.ledgerPlan({ source: 'server', rules: 'legacy', margin_estimated: 1, net_revenue: 2 }), null, 'legacy events keep the lines margin');
  assert.equal(P.ledgerPlan({ source: 'client', margin_estimated: 1 }), null);
  assert.equal(P.ledgerPlan(null), null);
});
t('build: with the ledger the cost lines\' Planned margin = the shared P&L (98%), the lines\' own margin is kept aside', () => {
  const m = P.build(costs, [], {}, [], { pnl: { source: 'server', rules: 'r21', margin_estimated: 196000, net_revenue: 200000 } });
  assert.equal(m.totals.margin, 196000); assert.equal(m.totals.pct, 98); assert.equal(m.totals.ledger, true);
  assert.equal(m.totals.lineMargin, 99000); assert.equal(m.totals.linePct, 99);
  const old = P.build(costs, [], {}, [], {});
  assert.equal(old.totals.pct, 99); assert.equal(old.totals.ledger, undefined, 'no ledger -> unchanged behaviour');
});
t('build: low / negative planned-margin warnings follow the shared P&L', () => {
  const low = P.build(costs, [], {}, [], { pnl: { source: 'server', rules: 'r21', margin_estimated: 10000, net_revenue: 200000 } });
  assert.ok(low.warnings.some((w) => w.kind === 'low' && /5%/.test(w.text)));
  const neg = P.build(costs, [], {}, [], { pnl: { source: 'server', rules: 'r21', margin_estimated: -1, net_revenue: 200000 } });
  assert.ok(neg.warnings.some((w) => w.kind === 'neg' && /incl\. crew wages/.test(w.text)));
});
t('page: one event_pnl read feeds the top tiles AND the cost lines (render gets pnl), label says incl. crew wages', () => {
  assert.match(BUD, /let pnl=null; try\{ pnl=BPStore\.vendorBills\?await BPStore\.vendorBills\.pnl\(id\):null; \}catch\(_\)\{ pnl=null; \}/);
  assert.match(BUD, /reload:load, pnl \}\); \}/);
  assert.match(BUD, /pnlTiles\(pnl\);/);
  assert.match(BUD, /function pnlTiles\(p\)\{ if\(!p\) return;/);
  assert.equal((BUD.match(/vendorBills\.pnl\(id\)/g) || []).length, 1, 'one P&L read per load');
  assert.match(BP, /\{ dismissed: dismissed, pnl: ctx\.pnl \}/);
  assert.match(BP, /all estimated costs incl\. crew wages - same as Budget &amp; margin/);
});

console.log('r22 money - staff on the event = wage lines (one rule):');
const crewLive = vm.runInNewContext(/const crewTaskLive = ([^\n]+);\n/.exec(STORE)[1]);
t('store-api: a crew task counts unless rejected / cancelled - also while "unassigned"; no crew = not staff', () => {
  assert.equal(crewLive({ crew_id: 'c', status: 'unassigned' }), true);
  assert.equal(crewLive({ crew_id: 'c', status: 'assigned' }), true);
  assert.equal(crewLive({ crew_id: 'c', status: 'accepted' }), true);
  assert.equal(crewLive({ crew_id: 'c', status: 'completed' }), true);
  assert.equal(crewLive({ crew_id: 'c', status: 'rejected' }), false);
  assert.equal(crewLive({ crew_id: 'c', status: 'cancelled' }), false);
  assert.equal(crewLive({ crew_id: null, status: 'assigned' }), false);
  assert.equal(crewLive(null), false);
});
t('store-api: workspace / Staff (staff.forEvent), Readiness and the arrival roster all use the rule', () => {
  assert.match(STORE, /\(data \|\| \[\]\)\.filter\(crewTaskLive\)\.forEach\(\(t\) => \{ const k = t\.crew_id;/);
  assert.equal((STORE.match(/select\("crew_id,status"\)\.eq\("quote_id", quoteId\)\.not\("crew_id", "is", null\);\n\s+if \(error\) throw error; return \(data \|\| \[\]\)\.filter\(crewTaskLive\); \}\)/g) || []).length, 2);
  assert.doesNotMatch(STORE, /select\("crew_id"\)\.eq\("quote_id", quoteId\)/);
});
t('0252: only _r21_cost_lines, same signature; the two task filters drop "unassigned", the rest is the 0246 body', () => {
  const body = (s) => /create or replace function public\._r21_cost_lines[\s\S]*?\nend \$\$;/.exec(s)[0];
  const a = body(S0246), b = body(SQL);
  assert.equal((SQL.match(/create or replace function/g) || []).length, 1);
  assert.match(b, /^create or replace function public\._r21_cost_lines\(p_quote uuid, p_org uuid\)\nreturns jsonb language plpgsql stable security definer set search_path = '' as \$\$/);
  assert.doesNotMatch(b, /'unassigned'/);
  assert.equal((a.match(/'rejected', 'cancelled', 'unassigned'/g) || []).length, 2, 'the 0246 body skipped unassigned in 2 filters');
  const norm = (s) => s.replace(/'rejected', 'cancelled', 'unassigned'/g, "'rejected', 'cancelled'").replace(/^-- r21-money-0246.*$/m, '');
  assert.equal(norm(b), norm(a), 'every other line unchanged');
  assert.match(b, /-- r21-money-0246 \(r22-money-0252:/);
});
t('0252: additive + safe (no drop / delete / update / truncate / alter table / policy), grants stay internal, ASCII', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\b(drop|delete\s+from|truncate|alter\s+table|create\s+policy|update\s+public\.)/i);
  assert.match(SQL, /revoke all on function public\._r21_cost_lines\(uuid, uuid\) from authenticated/);
  assert.doesNotMatch(SQL, /grant execute/i);
  assert.doesNotMatch(SQL + APPLY, /[^\x00-\x7F]/);
});
t('APPLY-0252: STOP guard before any change, the migration body unchanged in one transaction, VERIFY rows', () => {
  assert.ok(APPLY.indexOf('STOP 0252') < APPLY.indexOf('begin;'));
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  ['01 _r21_cost_lines is the 0252 body', '02 still internal', '03 the read RPCs are unchanged', '04 every event with crew: wage lines = people on the event']
    .forEach((s) => assert.ok(APPLY.includes(s), s));
  assert.doesNotMatch(APPLY, /create temp|temporary table|set_config/i, 'paste-safe: no temp tables / session state');
});
t('MANIFEST + DB suite: 0252 forward after 0246; run-all runs r22-money-0252 (17 checks) after r21-money-0246', () => {
  assert.ok(MANIFEST.indexOf('forward  supabase/migrations/0252_crew_wages_unassigned.sql') > MANIFEST.indexOf('forward  supabase/migrations/0246_event_money_ledger.sql'));
  assert.ok(RUNALL.indexOf('r22-money-0252') > RUNALL.indexOf('"r21-money-0246"'));
  assert.match(RUNALL, /R22-MONEY-0252: ALL PASS \\\(17\/17\\\)/);
  assert.equal((DBT.match(/perform pg_temp\.res\('\d\d /g) || []).length, 17);
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0252_crew_wages_unassigned\.sql\n\\ir \.\.\/\.\.\/supabase\/migrations\/0252_crew_wages_unassigned\.sql/);
  assert.match(DBT, /\nrollback;\s*$/);
});

console.log('r22 money - phone cards:');
// tables-mobile.js on a tiny fake DOM
function cell(tag, text, o) {
  const attrs = {}, cls = new Set();
  return Object.assign({ tagName: tag, textContent: text, colSpan: 1, hidden: false,
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); },
    classList: { add: (c) => cls.add(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, has: (c) => cls.has(c) },
    querySelector: () => null }, o || {});
}
function table(heads, rows) {
  const t0 = cell('TABLE', '');
  t0.tHead = { rows: [{ cells: heads }] };
  t0.tBodies = [{ rows: rows.map((cs) => ({ cells: cs, classList: { toggle() {} } })) }];
  return t0;
}
const dctx = { window: {}, requestAnimationFrame: (f) => f(), MutationObserver: function () { this.observe = () => {}; },
  document: { readyState: 'complete', querySelector: () => null, body: { tagName: 'BODY', querySelectorAll: () => [] } } };
dctx.globalThis = dctx; vm.createContext(dctx); vm.runInContext(TMJS, dctx);
const TM = dctx.window.HelmTablesMobile;
t('stacked labels skip a hidden header (Insights Currency column): Profit / Margin / Collected land on the right cells', () => {
  const names = ['Event', 'Date', 'Currency', 'Revenue', 'Cost', 'Profit', 'Margin', 'Collected', 'Outstanding'];
  const heads = names.map((x) => cell('TH', x, { hidden: x === 'Currency' }));
  const vals = ['SMP-1001 · Wedding', '19/10/2026', '₹5,00,000', '₹10,000', '₹4,90,000', '98%', '₹2,00,000', '₹3,90,000'];
  const tds = vals.map((v) => cell('TD', v));
  TM.refresh(table(heads, [tds]));
  assert.deepEqual(tds.map((c) => c.getAttribute('data-label')), ['Event', 'Date', 'Revenue', 'Cost', 'Profit', 'Margin', 'Collected', 'Outstanding']);
  assert.ok(tds[0].classList.has('tm-primary'));
});
t('with the Currency column shown (2+ currencies) every cell keeps its own label; a hidden cell is skipped too', () => {
  const heads = ['Event', 'Date', 'Currency', 'Revenue'].map((x) => cell('TH', x));
  const tds = ['E', 'D', 'AED', '1'].map((v) => cell('TD', v));
  TM.refresh(table(heads, [tds]));
  assert.deepEqual(tds.map((c) => c.getAttribute('data-label')), ['Event', 'Date', 'Currency', 'Revenue']);
  const heads2 = ['Event', 'Date', 'Currency', 'Revenue'].map((x) => cell('TH', x, { hidden: x === 'Currency' }));
  const tds2 = [cell('TD', 'E'), cell('TD', 'D'), cell('TD', 'INR', { hidden: true }), cell('TD', '1')];
  TM.refresh(table(heads2, [tds2]));
  assert.equal(tds2[3].getAttribute('data-label'), 'Revenue'); assert.equal(tds2[2].getAttribute('data-label'), null);
});
t('labels stay readable while amounts are hidden (the mask\'s transparent fill is not inherited by the label)', () => {
  assert.match(TMCSS, /html\.hb-priv-on table\.tm-stack > tbody > tr > td\[data-label\]::before \{\s*color: var\(--ink-3\) !important; -webkit-text-fill-color: var\(--ink-3\) !important; \}/);
  assert.ok(TMCSS.indexOf('html.hb-priv-on table.tm-stack') > TMCSS.indexOf('@media (max-width: 639.98px)'));
});
t('long titles in the phone cards end in "..." (per-event table card title)', () => {
  assert.match(ICSS, /@media \(max-width: 639\.98px\) \{\n  table\.pe\.tm-stack > tbody > tr > td\.tm-primary \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; \}/);
});

console.log(`r22-money: ${n} passed, ${fail} failed`);
if (fail) process.exit(1);
