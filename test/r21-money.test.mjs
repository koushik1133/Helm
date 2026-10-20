// r21-money.test.mjs - r21 owner, EVENT-MONEY-CLOSURE-PLAN.md Phase 1 "correct margin" (0246):
//  * one server cost ledger per event (Estimated / Committed / Actual per category), staff wages counted,
//    GST split on vendor bills, refunds ex-GST, legacy closed events keep their numbers
//    (behaviour proven on a real Postgres in tests/db/r21-money-0246.sql; here: the repo wiring + pure helpers)
//  * the migration is additive + idempotent, ASCII, in the MANIFEST, and APPLY-0246.sql is the same body
//  * the Budget & margin card (money-ledger-ui.js) on Budget + Closure: DOM-only, every amount masked,
//    replaces the older profit cards only when the server answers, keeps day rates admin-only
//  * vendor bills: optional "of which GST" + "we can claim this GST" (not in WhatsApp quick add)
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const SQL = read('supabase/migrations/0246_event_money_ledger.sql');
const APPLY = read('supabase/APPLY-0246.sql');
const MANIFEST = read('supabase/migrations/MANIFEST');
const STORE = read('public/store-api.js');
const UI = read('public/money-ledger-ui.js');
const CSS = read('public/money-ledger.css');
const VB = read('public/vendor-bills-ui.js');
const CLOSURE = read('public/closure.html');
const BUDGET = read('public/budget.html');

// pure helpers from store-api.js, evaluated as written
const grab = (re, what) => { const m = re.exec(STORE); assert.ok(m, what + ' found in store-api.js'); return m[0]; };
const helpers = [
  grab(/const vbNum = \(v\) => [^\n]+\n/, 'vbNum'),
  grab(/function vbGstPart\(v, amount\) \{[\s\S]*?\n  \}\n/, 'vbGstPart'),
  grab(/const ML_CATS = \[[\s\S]*?\]\];\n/, 'ML_CATS'),
  grab(/const mlCatLabel = [^\n]+\n/, 'mlCatLabel'),
  grab(/function mlVarianceFlag\(row, o\) \{[\s\S]*?\n  \}\n/, 'mlVarianceFlag'),
  grab(/function mlStage\(line\) \{[\s\S]*?\n  \}\n/, 'mlStage'),
].join('');
const H0 = vm.runInNewContext(helpers + '({ vbGstPart, ML_CATS, mlCatLabel, mlVarianceFlag, mlStage })');
// plain objects of this realm (deepEqual compares prototypes)
const plain = (v) => JSON.parse(JSON.stringify(v));
const H = { ML_CATS: plain(H0.ML_CATS), mlCatLabel: H0.mlCatLabel, mlVarianceFlag: H0.mlVarianceFlag, mlStage: H0.mlStage, vbGstPart: (v, a) => plain(H0.vbGstPart(v, a)) };

await t('migration: additive + idempotent (no drop table / delete / truncate / row update), ASCII, REQUIRES guard, rollback note', () => {
  assert.ok(!/[^\x00-\x7F]/.test(SQL), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.ok(!/\bdrop\s+table\b/i.test(code), 'no drop table');
  assert.ok(!/\bdelete\s+from\b/i.test(code), 'no delete');
  assert.ok(!/\btruncate\b/i.test(code), 'no truncate');
  assert.ok(!/\bupdate\s+public\./i.test(code), 'no row update');
  assert.ok(!/\bdrop\s+column\b/i.test(code), 'no drop column');
  assert.ok(!/create\s+temp/i.test(code), 'no temp tables (SQL editor paste)');
  assert.match(code, /add column if not exists crew_covered boolean not null default false/);
  assert.match(code, /add column if not exists gst_amount numeric;/);
  assert.match(code, /add column if not exists gst_claimable boolean;/);
  assert.match(code, /on conflict \(rule\) do nothing/, 'the rules marker is written once');
  assert.match(code, /if to_regprocedure\('public\._vb_event_pnl__pre0246\(uuid,uuid\)'\) is null then\s+alter function public\._vb_event_pnl\(uuid, uuid\) rename to _vb_event_pnl__pre0246;/, 'rename only once');
  assert.match(SQL, /raise exception 'STOP: _vb_event_pnl is not the 0146 body/);
  assert.match(SQL, /-- ROLLBACK \(manual/);
});

await t('MANIFEST lists 0246 once as forward; APPLY-0246.sql = begin + the migration body + commit + VERIFY rows', () => {
  assert.equal((MANIFEST.match(/^forward\s+supabase\/migrations\/0246_event_money_ledger\.sql$/mg) || []).length, 1);
  assert.ok(!/[^\x00-\x7F]/.test(APPLY), 'APPLY ASCII only');
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'), 'APPLY wraps the exact migration body');
  assert.equal((APPLY.match(/ ok\b/g) || []).length >= 1, true);
  assert.equal((APPLY.match(/^  \('0\d /mg) || []).length, 8, '8 VERIFY rows');
});

await t('server access: event_cost_breakdown = finance view + same studio; studio_cost_breakdown also needs business or insights; helpers closed', () => {
  const ecb = /create or replace function public\.event_cost_breakdown[\s\S]*?\nend \$\$;/.exec(SQL)[0];
  assert.match(ecb, /auth\.uid\(\) is null or v_org is null or not public\.has_area\('finance', 'view'\)/);
  assert.match(ecb, /public\._r21_event_money\(p_quote, v_org, true\)/, 'always the caller\'s own studio');
  assert.match(ecb, /if not public\.is_admin\(\) then/, 'per-person crew pay only for an admin');
  assert.match(ecb, /'pay_private', true/);
  const scb = /create or replace function public\.studio_cost_breakdown[\s\S]*?\nend \$\$;/.exec(SQL)[0];
  assert.match(scb, /has_area\('business', 'view'\) or public\.has_area\('insights', 'view'\)/);
  assert.match(scb, /q\.org_id = v_org/);
  for (const f of ['_r21_cost_lines(uuid, uuid)', '_r21_event_money(uuid, uuid, boolean)', '_vb_event_pnl__pre0246(uuid, uuid)'])
    assert.ok(SQL.includes("'public." + f + "'"), f + ' in the revoke list');
  assert.match(SQL, /grant execute on function public\.event_cost_breakdown\(uuid\) to authenticated/);
  const ins = /create or replace function public\.insights_event_costs[\s\S]*?\nend \$\$;/.exec(SQL)[0];
  assert.match(ins, /has_area\('insights', 'view'\)/); assert.match(ins, /has_area\('finance', 'view'\)/);
  assert.match(ins, /'crew', coalesce\(\(c ->> 'staff'\)::numeric, 0\)/, 'Insights crew = staff & crew wages category');
  for (const k of ['vendors', 'crew', 'logistics', 'rentals', 'change_orders', 'other_costs', 'expense_claims', 'refunds', 'cost_total', 'profit', 'margin_pct', 'collected', 'outstanding', 'guests', 'event_type'])
    assert.ok(ins.includes("'" + k + "'"), '0240 key kept: ' + k);
});

await t('server rules: staff wages from crew x day rate + attendance; ticked staff line replaced; contingency plan-only; legacy marker', () => {
  assert.match(SQL, /'c_fc', case when x\.arrived then coalesce\(x\.rate, 0\) when x\.no_show then 0 else coalesce\(x\.rate, 0\) end/);
  assert.match(SQL, /\(k\.crew_covered and v_has_crew\) as replaced/);
  assert.match(SQL, /when x\.cat = 'contingency' then coalesce\(x\.actual, 0\)/);
  assert.match(SQL, /v_rules := case when v_closed is not null and v_cut is not null and v_closed < v_cut then 'legacy' else 'r21' end/);
  assert.match(SQL, /vb\.amount - case when vb\.gst_amount is not null and z\.claim then vb\.gst_amount else 0 end/, 'claimable GST leaves the cost');
  assert.match(SQL, /v_ref_ex := case when v_rev \+ v_tax > 0 and v_tax > 0 then round\(v_ref \* v_rev \/ \(v_rev \+ v_tax\), 2\) else v_ref end/);
});

await t('categories: the UI list matches the server order (venue ... contingency)', () => {
  const sqlOrder = [...(/from \(values \('venue', 1\)[\s\S]*?\) o\(k, ord\)/.exec(SQL)[0]).matchAll(/\('([a-z]+)', \d+\)/g)].map((m) => m[1]);
  assert.deepEqual(H.ML_CATS.map((c) => c[0]), sqlOrder);
  assert.equal(H.mlCatLabel('staff'), 'Staff & crew wages');
  assert.equal(H.mlCatLabel('decor'), 'Décor & flowers');
  assert.equal(H.mlCatLabel('xyz'), 'xyz');
});

await t('GST part of a bill: empty = unknown, 0..below the amount, rounded; never the whole bill or negative', () => {
  assert.deepEqual(H.vbGstPart('', 1000), { value: null });
  assert.deepEqual(H.vbGstPart(null, 1000), { value: null });
  assert.deepEqual(H.vbGstPart('152.555', 1000), { value: 152.56 });
  assert.deepEqual(H.vbGstPart(0, 1000), { value: 0 });
  assert.ok(H.vbGstPart(-1, 1000).error);
  assert.ok(H.vbGstPart(1000, 1000).error, 'GST equal to the bill is refused (the DB check says the same)');
  assert.ok(H.vbGstPart('abc', 1000).error);
});

await t('variance flag (plan 3.6): over = more than 10% OR more than 10,000; small overrun = watch; new spend; under plan', () => {
  assert.equal(H.mlVarianceFlag({ estimated: 350000, variance: 32000 }), 'over', 'plan example: +32,000 (9%)');
  assert.equal(H.mlVarianceFlag({ estimated: 30000, variance: 4800 }), 'over', '16%');
  assert.equal(H.mlVarianceFlag({ estimated: 300000, variance: 12000 }), 'over', 'above 10,000');
  assert.equal(H.mlVarianceFlag({ estimated: 300000, variance: 5000 }), 'watch');
  assert.equal(H.mlVarianceFlag({ estimated: 0, variance: 2400 }), 'new');
  assert.equal(H.mlVarianceFlag({ estimated: 0, variance: 25000 }), 'over');
  assert.equal(H.mlVarianceFlag({ estimated: 5000, variance: -5000 }), 'under');
  assert.equal(H.mlVarianceFlag({ estimated: 5000, variance: 0 }), '');
});

await t('stage of a line: actual > committed > estimated (0 actual is still actual, e.g. a no-show)', () => {
  assert.equal(H.mlStage({ estimated: 1500, committed: 1500, actual: 0 }), 'actual');
  assert.equal(H.mlStage({ estimated: 1200, committed: 1200, actual: null }), 'committed');
  assert.equal(H.mlStage({ estimated: 25000 }), 'estimated');
  assert.equal(H.mlStage(null), 'estimated');
});

await t('store-api: moneyLedger exported; breakdown / studio fall back to null on an older database; vendor bill GST insert retries without the split', () => {
  assert.match(STORE, /settlement, closure, vendorBills, moneyLedger, bell,/);
  assert.match(STORE, /rpc\("event_cost_breakdown", \{ p_quote: quoteId \}\); \} catch \(e\) \{ if \(rpcMissing\(e\)\) return null; throw e; \}/);
  assert.match(STORE, /rpc\("studio_cost_breakdown", \{ p_from: from \|\| null, p_to: to \|\| null \}\)/);
  assert.match(STORE, /update\(\{ crew_covered: !!on \}\)\.eq\("id", costId\)/);
  assert.match(STORE, /if \(error && gst\.value != null && vbGstColMissing\(error\)\) \{/);
});

await t('money-ledger-ui.js: DOM only (no innerHTML / insertAdjacentHTML), every amount masked, legacy + pay-private wording', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(UI), 'no HTML strings');
  // every fmt( call result goes into a money() node or a plain helper that masks it
  const raw = UI.split('\n').filter((l) => /fmt\(/.test(l) && !/money\(|amountCell|tile\(|plRow\(|function \(n\)|return function|varianceCell|renderPnl\(|renderVariance\(|renderWarnings\(|fmtFor|function plRow|function tile/.test(l));
  assert.deepEqual(raw, [], 'unmasked amounts: ' + raw.join(' | '));
  assert.match(UI, /function money\(node\) \{ node\.setAttribute\("data-money", ""\); return node; \}/);
  assert.match(UI, /if \(!m\) \{ box\.hidden = true; return; \}/, 'no 0246 -> card hidden, older cards stay');
  assert.match(UI, /B\.auth\.canView\("finance"\)/);
  assert.match(UI, /Recorded numbers \(legacy\)/);
  assert.match(UI, /per-person pay is visible to the studio admin only/);
  assert.match(UI, /\["Estimated", "num"[\s\S]*\["Committed", "num"[\s\S]*\["Actual", "num"[\s\S]*\["Variance", "num"/);
  assert.match(UI, /Gross margin \(contribution\)/); assert.match(UI, /Net margin %/); assert.match(UI, /of the cost is actual/);
  assert.match(UI, /canEdit: canEdit && !legacy/, 'no toggles on a legacy (closed) event');
  assert.match(CSS, /\.ml-tiles\{/); assert.ok(!/#[0-9a-f]{3,6}(?![0-9a-f])/i.test(CSS.replace(/var\([^)]*\)/g, '')), 'colours only through theme tokens (with fallbacks)');
});

await t('pages: Budget + Closure mount the card (replacing the older profit cards), load the script + stylesheet', () => {
  assert.match(CLOSURE, /<div data-ml-mount="margin" data-ml-replaces="plCard netProfit" data-ml-tiles="off" id="moneyLedger" hidden><\/div>/);
  assert.match(BUDGET, /<div data-ml-mount="margin" data-ml-replaces="netProfit" data-ml-tiles="off" id="moneyLedger" hidden><\/div>/);
  for (const page of [CLOSURE, BUDGET]) {
    assert.match(page, /<script src="money-ledger-ui\.js\?v=\d+"><\/script>/);
    assert.match(page, /<link rel="stylesheet" href="money-ledger\.css\?v=\d+">/);
    assert.ok(page.indexOf('money-ledger-ui.js') > page.indexOf('store-api.js'), 'after store-api.js');
  }
  assert.match(BUDGET, /if\(p\.cost_actual!=null&&p\.rules==="r21"\)/);
  assert.ok(existsSync(new URL('../public/money-ledger.css', import.meta.url)));
});

await t('vendor bills: optional GST + claimable box (food unticked by default), hidden in WhatsApp quick add, shown on the bill', () => {
  assert.match(VB, /field\("of which GST", gst\)/);
  assert.match(VB, /We can claim this GST \(input credit\)/);
  assert.match(VB, /\[fBk, fNo, fBd, fDd, fDs, fGst, fCl\]\.forEach\(function \(n\) \{ n\.hidden = q; \}\)/);
  assert.match(VB, /claim\.checked = !foodLike\(/);
  assert.match(VB, /gst_amount: gp\.value, gst_claimable: gp\.value != null \? claim\.checked : undefined/);
  assert.match(VB, /incl\. GST /);
  assert.match(VB, /p\.rules === "r21" \? "Staff wages & expenses" : "Staff expenses"/);
});

console.log(`\nr21-money: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
