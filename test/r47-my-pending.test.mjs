// r47-my-pending.test.mjs - r47: production 500 on POST /rest/v1/rpc/my_pending (26 Oct 2026, statement timeout:
// the hidden notification types were worked out again for every unread row). The browser / repo side:
//  * dashboard.html: a my_pending failure (500 / time-out) hides "My events & tasks" quietly (diagnostic only, no error
//    card, no stale unread badge) and never turns "Your workspace" into an error (Upcoming shows "-" instead);
//    a degraded answer ({upcoming: [], unread: 0, degraded: true}) renders like any other answer
//  * shell-b-dash.js keeps calling it through safe(..., null) (a failure is "no data")
//  * SQL 0292: MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard, the
//    hidden types worked out once (materialized group step), empty answer for no studio, failing parts degrade
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const DASH = rd('public/dashboard.html'), SHELL = rd('public/shell-b-dash.js');
const SQL = rd('supabase/migrations/0292_r47_my_pending_speed.sql'), APPLY = rd('supabase/APPLY-0292.sql');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };

// a tiny DOM stand-in for the renderPending widget
function el(hidden) { return { hidden, innerHTML: '', textContent: '', firstElementChild: null, style: {}, addEventListener() {}, querySelectorAll: () => [] }; }
function runRenderPending(pendingImpl) {
  const els = { '#myworkSection': el(true), '#mywork': el(false), '#unreadBadge': el(false) };
  els['#unreadBadge'].textContent = '5 unread';
  const logs = [], loadErrors = [];
  const ctx = {
    $: (s) => els[s] || null, logs, loadErrors, console,
    BPStore: { pending: pendingImpl, fmtDateIN: (d) => d },
    BPUI: { isPermissionError: () => false, isMissingFunction: () => false, isMissingTable: () => false, isAuthError: () => false,
            isRpcMissing: () => false, loadError: (h, e) => loadErrors.push(e) },
    esc: (s) => String(s), fmtDate: (s) => s, qName: (e) => e.title, stg: (s) => s || '', encodeURIComponent,
  };
  const src = [
    between(DASH, 'const DIAG = {', '\n  function setBadge'),
    'let _feed = {};', 'function clearFeed(){ _feed = {}; }',
    between(DASH, 'const getPending =', '\n  const getMyTasks'),
    between(DASH, 'const softFail =', '\n  // Phase 3'),
    between(DASH, 'async function renderPending', '\n  // Build 2 '),
    'globalThis.go = renderPending;',
  ].join('\n').replace(/console\.error\(/g, 'logs.push(');
  vm.runInNewContext(src, ctx);
  return { ctx, els, done: ctx.go() };
}

await t('dashboard: a 500 / time-out on my_pending hides the widget quietly (diagnostic only, no error card)', async () => {
  const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', status: 500 });
  const { ctx, els, done } = runRenderPending(() => Promise.reject(err));
  await done;
  assert.equal(els['#myworkSection'].hidden, true, 'widget hidden');
  assert.equal(els['#unreadBadge'].hidden, true, 'no stale unread badge');
  assert.equal(ctx.loadErrors.length, 0, 'no error card');
  assert.ok(ctx.logs.some((l) => /HELM-DASH-PENDING-FAILED/.test(String(l))), 'diagnostic logged');
  assert.equal(els['#mywork'].innerHTML, '', 'nothing raw rendered');
});

await t('dashboard: a degraded answer renders like any other answer (no crash, badge follows unread)', async () => {
  const { els, done } = runRenderPending(() => Promise.resolve({ upcoming: [], unread: 0, degraded: true, as_of: 'x' }));
  await done;
  assert.equal(els['#myworkSection'].hidden, true);
  assert.equal(els['#unreadBadge'].hidden, true);
  const r2 = runRenderPending(() => Promise.resolve({ upcoming: [{ id: 'q1', code: 'A-1', title: 'Wedding', event_date: '2026-11-02', open_tasks: 2 }], unread: 3 }));
  await r2.done;
  assert.equal(r2.els['#myworkSection'].hidden, false);
  assert.equal(r2.els['#unreadBadge'].textContent, '3 unread');
  assert.match(r2.els['#mywork'].innerHTML, /Wedding/);
});

await t('dashboard: "Your workspace" never becomes an error card because of my_pending (Upcoming shows "-")', () => {
  const rb = between(DASH, 'async function renderRoleBoard', 'const CFG = {');
  assert.match(rb, /try \{ pend = \(await getPending\(\)\) \|\| pend; \} catch\(e\)\{ pendOk = false; \}/);
  assert.doesNotMatch(rb, /getPending\(\)\)[^\n]*hardErr/, 'a pending failure does not set hardErr');
  assert.match(rb, /const up = pendOk \?/);
});

await t('dashboard: the existing "not installed / no access" fallback and diagnostics are unchanged', () => {
  assert.match(DASH, /if \(softFail\(e\)\) \{ if \(BPUI\.isRpcMissing\(e\)\) diag\(DIAG\.DASH_FALLBACK, e\); sec\.hidden = true; return; \}/);
  assert.match(DASH, /DASH_FALLBACK: "HELM-DASH-FALLBACK", PENDING_FAILED: "HELM-DASH-PENDING-FAILED"/);
  assert.ok(!/(textContent|innerHTML)\s*=\s*[^;]*HELM-DASH-PENDING-FAILED/.test(DASH), 'diagnostic never rendered');
});

await t('shell dashboard keeps my_pending best-effort (safe(..., null))', () => {
  assert.match(SHELL, /pend: signedOut \? Promise\.resolve\(null\) : safe\(function \(\) \{ return S\(\)\.pending\(\); \}, null\)/);
  assert.match(SHELL, /async function safe\(fn, dflt\) \{ try \{[^}]*\} catch \(e\) \{ return dflt; \} \}/);
});

await t('SQL 0292: hidden types once per call, grouped + materialized, empty answer for no studio, parts degrade', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.match(code, /create or replace function public\.my_pending\(\)\s*returns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.equal((code.match(/_notify_hidden_types\(v_org, v_uid\)/g) || []).length, 1, 'one call, into a variable');
  assert.match(code, /with g as materialized \(/);
  assert.match(code, /group by n\.kind, n\.channel/);
  assert.match(code, /if v_uid is null or v_org is null then\s*return jsonb_build_object\('upcoming', '\[\]'::jsonb, 'unread', 0, 'as_of', now\(\)\);/);
  assert.match(code, /public\.has_area\('quotes', 'view'\)/);
  assert.match(code, /where q\.org_id = v_org/);
  assert.equal((code.match(/exception when others then/g) || []).length, 3, 'token / upcoming / unread parts each degrade');
  assert.doesNotMatch(code, /query_canceled/, 'a cancel / statement timeout is never swallowed');
  assert.match(code, /jsonb_build_object\('degraded', true\)/);
  assert.match(code, /alter function public\.my_pending\(\) rename to my_pending__pre0292/);
  assert.match(code, /revoke all on function public\.my_pending__pre0292\(\) from authenticated/);
  assert.match(code, /grant execute on function public\.my_pending\(\) to authenticated/);
  assert.match(code, /revoke all on function public\.my_pending\(\) from anon/);
  assert.match(code, /STOP 0292:/);
});

await t('SQL 0292: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0292_r47_my_pending_speed\.sql$/m);
  assert.ok(man.indexOf('0283_r33_team_safety.sql') < man.indexOf('0292_r47_my_pending_speed.sql'), '0292 after 0283');
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r47-my-pending-0292" "R47-MY-PENDING-0292: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r47-my-pending-0292\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0283'(, '02\d\d')*, '0292'(, '02\d\d')*\]/, f);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 10, 'VERIFY rows');
  for (const s of [SQL, APPLY, rd('tests/db/r47-my-pending-0292.sql')]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index|trigger)\b/i, 'no drops');
  assert.doesNotMatch(code, /\b(delete\s+from|update\s+public\.|insert\s+into|truncate)\b/i, 'no data touched');
  assert.doesNotMatch(APPLY, /create\s+temp|pg_temp/i, 'no temp tables / session state in the paste file');
  assert.match(rd('package.json'), /node test\/r47-my-pending\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0292.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

console.log(`r47-my-pending: ${n} test(s) passed.`);
