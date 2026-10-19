// r21 Insights: one page title, neat masked amounts, per-event cost charts + benchmarks (insights-costs.js, 0240).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const INS = read('public/insights.html'), JS = read('public/insights-costs.js'), CSS = read('public/insights-polish.css'), API = read('public/store-api.js');
const M = read('supabase/migrations/0240_insights_event_costs.sql'), A = read('supabase/APPLY-0240.sql');
let n = 0, fail = 0; const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } };
const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(JS, ctx);
const X = ctx.window.HelmInsightsCosts;
const J = (v) => JSON.parse(JSON.stringify(v));
const ev = (id, type, rev, profit, extra) => Object.assign({ id, code: id, event_type: type, currency: 'INR', revenue: rev, profit, cost_total: rev - profit, vendors: rev - profit, date: '2026-10-10' }, extra || {});

t('page: one title (top bar) - no H2 "Insights", breadcrumb hidden, intro kept', () => {
  assert.doesNotMatch(INS, /<h2>Insights<\/h2>/);
  assert.match(INS, /<header>[\s\S]*<h1>Insights<\/h1>/);
  assert.match(CSS, /html\[data-shell\] #helmTrail \{ display: none !important; \}/);
  assert.match(INS, /class="sub ins-intro"/);
});
t('page: masked amounts have no grey box, show the mask text at the number size (mask span only)', () => {
  assert.match(CSS, /html\.hb-priv-on #main \.hbp-m:not\(svg \*\), html\.hb-priv-on #main \[data-money\]:not\(svg\):not\(svg \*\) \{\s*background: none !important;/);
  assert.match(CSS, /html\.hb-priv-on #main \.hbp-m > \.hbp-mask/);
  assert.doesNotMatch(CSS, /#main \.hbp-m:not\(svg \*\) \{[^}]*color: var\(--ink/);   // never reveals the element's own text
});
t('page: cost cards wired (finance only), loaded with the 12-month benchmark window, CSP-safe', () => {
  assert.match(INS, /<script src="insights-costs\.js\?v=\d+"><\/script>/);
  assert.match(INS, /if\(canFin && window\.HelmInsightsCosts\) costsUI=HelmInsightsCosts\.mount\(\$\("#costsBody"\),\$\("#benchBody"\)/);
  assert.match(INS, /BPStore\.insights\.costs\(benchFrom\(r\),r\.to\)/);
  assert.match(INS, /insights_costs_missing/);
  assert.match(INS, /id="costsCard"[\s\S]*id="benchCard"[\s\S]*id="perEventCard"/);
  assert.doesNotMatch(INS, /style="/);
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|setAttribute\("style"/);
});
t('store-api: insights.costs -> insights_event_costs, friendly 0240 message', () => {
  assert.match(API, /rpc\("insights_event_costs", \{ p_from: from \|\| null, p_to: to \|\| null \}\)/);
  assert.match(API, /APPLY-0240\.sql/);
});
t('privacy: amounts masked in charts / tooltips while hidden; percent input not treated as money', () => {
  assert.match(JS, /var M = function \(n, c\) \{ return hidden\(\) \? MASK : ctx\.money\(n, c\); \}/);
  assert.match(JS, /if \(!hidden\(\)\) S\("text"/);
  assert.match(JS, /attributeFilter: \["class"\]/);
  assert.match(JS, /"ic-f ic-target hbp-skip"/);
});
t('median + totals + mix', () => {
  assert.equal(X.median([3, 1, 2]), 2); assert.equal(X.median([4, 1, 2, 3]), 2.5); assert.equal(X.median([null, undefined]), null);
  const tt = X.totals([{ revenue: 100, profit: 30, cost_total: 70, vendors: 50, crew: 20, collected: 40, outstanding: 78 }, { revenue: 0, profit: -10, cost_total: 10, other_costs: 10 }]);
  assert.equal(tt.revenue, 100); assert.equal(tt.cost, 80); assert.equal(tt.profit, 20); assert.equal(tt.margin, 20); assert.equal(tt.vendors, 50); assert.equal(tt.other_costs, 10);
  assert.equal(X.mixOf({ revenue: 200, vendors: 97 }).vendors, 48.5); assert.equal(X.mixOf({ revenue: 0, vendors: 5 }).vendors, null);
});
t('badges: on target / watch (<=10 pts below) / below / no revenue', () => {
  assert.equal(X.badgeFor(30, 30), 'good'); assert.equal(X.badgeFor(20, 30), 'watch'); assert.equal(X.badgeFor(19, 30), 'poor');
  assert.equal(X.badgeFor(-2, 5), 'poor'); assert.equal(X.badgeFor(null, 30), 'na');
});
t('benchmarks: same type + currency peers (2+), else studio, else target only; why line names the cost driver', () => {
  const rows = [ev('W1', 'Wedding', 1000, 400, { vendors: 350, cost_total: 600, guests: 100 }), ev('W2', 'wedding ', 1000, 350, { vendors: 400, cost_total: 650, guests: 100 }),
    ev('W3', 'Wedding', 1000, 100, { vendors: 700, cost_total: 900, guests: 100 }), ev('C1', 'Corporate', 500, 200), ev('D1', 'Wedding', 900, 300, { currency: 'AED' })];
  const b = X.benchmarks(rows, { target: 30, money: (v) => 'Rs' + Math.round(v) }), by = {}; b.forEach((x) => { by[x.id] = x; });
  assert.equal(by.W3.peer.basis, 'type'); assert.equal(by.W3.peer.n, 2); assert.equal(by.W3.peer.margin, 37.5);
  assert.equal(by.W3.badge, 'poor'); assert.match(by.W3.why, /^Vendors 70% of revenue vs 37\.5% typical for Wedding events\.$/);
  assert.equal(by.W1.badge, 'good'); assert.match(by.W1.why, /^Margin 40% - 10 pts above your 30% target/);
  assert.equal(by.C1.peer.basis, 'studio');                       // only one corporate: all other INR events
  assert.equal(by.D1.peer, null); assert.match(by.D1.why, /^Margin 33% - 3 pts above your 30% target\.$/);   // AED never compared with INR
  assert.equal(by.W1.costPerGuest, 6); assert.equal(by.W1.revPerGuest, 10);
  assert.equal(X.benchmarks([ev('Z', 'X', 0, -5)], {})[0].badge, 'na');
});
t('benchmarks: high cost per guest named when no category stands out; masked money stays masked', () => {
  const rows = [ev('A', 'Party', 1000, 100, { guests: 10 }), ev('B', 'Party', 1000, 300, { guests: 40 }), ev('C', 'Party', 1000, 300, { guests: 40 })];
  rows.forEach((r) => { r.vendors = 0; r.other_costs = r.cost_total; });
  rows[1].other_costs = rows[2].other_costs = 700;   // same mix share (the 900 vs 700 gap is < 5 pts? no: 90 vs 70) -> category wins
  const w = X.benchmarks(rows, { target: 30, money: () => '••••' })[0].why;
  assert.match(w, /Miscellaneous 90% of revenue vs 70%/);
  rows[0].other_costs = 720; rows[0].cost_total = 720; rows[0].profit = 280;
  const w2 = X.benchmarks(rows, { target: 30, money: () => '••••' })[0].why;
  assert.match(w2, /^Cost per guest •••• vs •••• typical for Party events\.$/);
});
t('trend: weeks up to 62 days, months beyond, empty buckets kept', () => {
  const r = [{ date: '2026-10-03', revenue: 10, profit: 4, cost_total: 6 }, { date: '2026-10-20', revenue: 5, profit: 1, cost_total: 4 }];
  const w = X.trend(r, '2026-10-01', '2026-10-31');
  assert.equal(w.unit, 'week'); assert.equal(w.buckets[0].key, '2026-09-28'); assert.equal(w.buckets.length, 5);
  assert.equal(w.buckets[0].revenue, 10); assert.equal(w.buckets[1].n, 0);
  const m = X.trend(r, '2026-01-01', '2026-12-31');
  assert.equal(m.unit, 'month'); assert.equal(m.buckets.length, 12); assert.equal(m.buckets[9].label, 'Oct 26'); assert.equal(m.buckets[9].cost, 10);
});
t('axis: nice ticks + compact INR labels', () => {
  assert.deepEqual(J(X.ticks(-60000, 1900000).list), [-500000, 0, 500000, 1000000, 1500000, 2000000]);
  assert.equal(X.compact(1250000, 'INR'), '12.5L'); assert.equal(X.compact(23000000, 'INR'), '2.3Cr'); assert.equal(X.compact(-50000, 'AED'), '-50K');
});
t('0240 SQL: one read-only function, gated + org scoped, profit from _vb_event_pnl; ASCII; APPLY verbatim; MANIFEST; DB suite', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(M) && /^[\x00-\x7F]*$/.test(A));
  assert.match(M, /create or replace function public\.insights_event_costs\(p_from date, p_to date\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(M, /has_area\('insights', 'view'\)/); assert.match(M, /has_area\('finance', 'view'\)/); assert.match(M, /public\._vb_event_pnl\(q\.id, v_org\)/);
  assert.doesNotMatch(M.replace(/--[^\n]*/g, ''), /\b(insert into|update public|delete from|drop |alter table|truncate)\b/i);
  assert.match(M, /revoke all on function public\.insights_event_costs\(date, date\) from anon/);
  assert.ok(A.includes(M)); assert.match(A, /-- PREVIEW/); assert.match(A, /-- VERIFY/); assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0240_insights_event_costs\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /INSIGHTS-COSTS-0240: ALL PASS \\\(18\/18\\\)/);
});
if (fail) { console.log('insights-costs-r21: ' + fail + ' FAILED'); process.exit(1); }
console.log('insights-costs-r21: ok (' + n + ')');
