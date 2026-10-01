#!/usr/bin/env node
/* ============================================================================
 * capability-aware-errors.test.mjs — production-hardening regression for the
 * "missing RPC capability" handling on the finance surfaces.
 *
 * READ-ONLY source characterization (no DB, no network), in the house style:
 * it parses the shipped HTML/JS and asserts on the wiring, plus a pure-logic
 * replica of the RPC-missing classifier. It proves:
 *
 *   A. settlement.html handles an RPC-missing (PGRST202 / 42883 / 404+message)
 *      response by flipping to a controlled "unavailable" state that DISABLES
 *      submit and NEVER reaches the "Recorded ✓" success path.
 *   B. dashboard.html's my_pending-missing path shows a controlled fallback
 *      (hides the widget) and does NOT introduce an un-org-scoped client query.
 *   C. No raw PostgREST error / migration filename is rendered to the DOM on
 *      these paths — error text goes through friendlyError + a diagnostic code.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SETTLE = read('public/settlement.html');
const DASH = read('public/dashboard.html');
const STORE = read('public/store-api.js');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

/* ---- Pure-logic replica of BPUI.isMissingFunction (the RPC-missing classifier) ---- */
const errStatus = (e) => { if (!e || typeof e !== 'object') return 0; let s = +(e.status || e.statusCode || 0);
  if (!s) { const m = /^HTTP (\d{3})\b/.exec(String(e.message || '')); if (m) s = +m[1]; } return s; };
const isRpcMissing = (e) => { const c = (e && e.code) || '', m = String((e && e.message) || '');
  if (c === 'PGRST202' || c === '42883') return true;
  if (/could not find the function|function \S+ does not exist/i.test(m)) return true;
  if (errStatus(e) === 404 && /function|schema cache/i.test(m)) return true;
  return false; };

/* =========================== classifier semantics =========================== */
t('classifier: PGRST202 (PostgREST missing RPC) → true', () =>
  assert.equal(isRpcMissing({ code: 'PGRST202', message: 'Could not find the function public.record_settlement_payment in the schema cache', status: 404 }), true));
t('classifier: 42883 (Postgres undefined_function) → true', () =>
  assert.equal(isRpcMissing({ code: '42883', message: 'function record_settlement_payment(...) does not exist' }), true));
t('classifier: bare message match → true', () =>
  assert.equal(isRpcMissing({ message: 'Could not find the function foo' }), true));
t('classifier: HTTP 404 that names a function/schema cache → true', () =>
  assert.equal(isRpcMissing({ message: 'HTTP 404 — not found in the schema cache' }), true));
t('classifier: plain 404 (missing row/route, no function hint) → false', () =>
  assert.equal(isRpcMissing({ status: 404, message: 'Not Found' }), false));
t('classifier: PGRST116 (0 rows) → false', () =>
  assert.equal(isRpcMissing({ code: 'PGRST116', message: '0 rows' }), false));
t('classifier: generic error / null → false', () => {
  assert.equal(isRpcMissing({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isRpcMissing(null), false);
});

/* ===================== store-api.js: helper + export ======================== */
t('store-api: isMissingFunction catches PGRST202/42883 and a function-hinting 404', () => {
  assert.match(STORE, /c === "PGRST202" \|\| c === "42883"/);
  assert.match(STORE, /errStatus\(e\) === 404 && \/function\|schema cache\//);
});
t('store-api: exports isRpcMissing alias for pages to branch on', () =>
  assert.match(STORE, /isRpcMissing:\s*isMissingFunction/));
t('store-api: isNotFound still excludes missing-function (no 404 collision)', () =>
  assert.match(STORE, /if \(isMissingTable\(e\) \|\| isMissingFunction\(e\)\) return false;/));

/* ============== A. settlement.html — RPC-missing on record payment ========== */
t('A1. recordPayment catch branches on isRpcMissing → unavailable state, then returns', () => {
  assert.match(SETTLE, /if\(BPUI\.isRpcMissing\(e\)\)\{\s*markSettlementUnavailable\(e\);\s*return;\s*\}/,
    'the only RPC-missing branch must flip to unavailable and return before any fallthrough');
});
t('A2. markSettlementUnavailable disables submit (button + amount input)', () => {
  const fn = SETTLE.slice(SETTLE.indexOf('function markSettlementUnavailable'), SETTLE.indexOf('function markSettlementUnavailable') + 600);
  assert.match(fn, /pb\.disabled=true/, 'pay button disabled');
  assert.match(fn, /pa\.disabled=true/, 'pay amount input disabled');
  assert.match(fn, /settleUnavailable=true/, 'persistent unavailable flag set');
});
t('A3. a re-entry guard blocks submit once unavailable (never attempts the RPC again)', () => {
  assert.match(SETTLE, /if\(settleUnavailable\)\{\s*markSettlementUnavailable\(\);\s*return;\s*\}/);
});
t('A4. success ("Recorded ✓") is only inside the try, after the RPC resolves', () => {
  const call = SETTLE.indexOf('recordSettlement(id');
  const ok = SETTLE.indexOf('Recorded ✓');
  const catchAt = SETTLE.indexOf('catch(e){', call);
  const rpcMiss = SETTLE.indexOf('isRpcMissing(e)', catchAt);
  assert.ok(call > 0 && ok > call && catchAt > ok, 'order: await recordSettlement → success text → catch');
  assert.ok(rpcMiss > catchAt, 'isRpcMissing handling lives in the catch, after the success path');
});
t('A5. the catch clears the status region before branching (no stale "Recording…"/success)', () => {
  const catchAt = SETTLE.indexOf('catch(e){', SETTLE.indexOf('recordSettlement(id'));
  const seg = SETTLE.slice(catchAt, catchAt + 200);
  assert.match(seg, /msg\.textContent="";/, 'status cleared at the top of catch before any branch');
});
t('A6. the unavailable message region is an assertive alert', () => {
  assert.match(SETTLE, /id="pay_block"[^>]*role="alert"[^>]*aria-live="assertive"/);
});
t('A8. disabled state is re-asserted after BPUI.guard re-enables the button', () => {
  // guard.restore() flips disabled back to false when its callback resolves; the
  // page must re-apply the unavailable disable afterward so the control stays blocked.
  assert.match(SETTLE, /\}\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if\(settleUnavailable\) markSettlementUnavailable\(\);/,
    'post-guard re-assert of the unavailable state present');
});
t('A7. diagnostic code HELM-SETTLE-RPC-MISSING is defined and logged (not rendered)', () => {
  assert.match(SETTLE, /SETTLE_RPC_MISSING:"HELM-SETTLE-RPC-MISSING"/);
  // diag() goes to console + telemetry only
  assert.match(SETTLE, /console\.error\("\[Helm\] "\+code,err\)/);
  assert.match(SETTLE, /HelmTelemetry\.report\(code,err\)/);
  // the diagnostic code string is never written into a DOM sink
  assert.ok(!/(textContent|innerHTML)\s*=\s*[^;]*HELM-SETTLE-RPC-MISSING/.test(SETTLE),
    'diagnostic code must not be rendered to the DOM');
});

/* =========== B. dashboard.html — my_pending missing → safe fallback ========= */
t('B1. my_pending is called via the server-scoped BPStore.pending() (no client query)', () => {
  assert.match(STORE, /rpc\("my_pending"\)/);
  assert.match(DASH, /BPStore\.pending\(\)/);
});
t('B2. softFail treats a missing function as "not available", not a load error', () =>
  assert.match(DASH, /const softFail = \(e\) =>[^;]*BPUI\.isMissingFunction\(e\)/));
t('B3. renderPending hides the widget on softFail and logs the fallback diagnostic', () => {
  assert.match(DASH, /if \(softFail\(e\)\) \{ if \(BPUI\.isRpcMissing\(e\)\) diag\(DIAG\.DASH_FALLBACK, e\); sec\.hidden = true; return; \}/);
  assert.match(DASH, /DASH_FALLBACK: "HELM-DASH-FALLBACK"/);
});
t('B4. the pending catch introduces NO un-org-scoped client fallback query', () => {
  // isolate the renderPending catch block and prove it only hides / loadErrors — never
  // substitutes a raw table read that would bypass my_pending's server-side scoping.
  const start = DASH.indexOf('async function renderPending');
  const end = DASH.indexOf('async function renderRoleBoard');
  const body = DASH.slice(start, end);
  assert.ok(start > 0 && end > start, 'renderPending located');
  assert.ok(!/\.from\(|\.select\(|BPStore\.quotes\.list|supa\b/.test(body),
    'renderPending must not build a client-side quotes/table query as a fallback');
});

/* ================= C. no raw DB/migration text in the DOM =================== */
t('C1. settlement payment errors render friendlyError, not raw e.message', () => {
  // the non-capability error path feeds the block through friendlyError
  assert.match(SETTLE, /showBlock\(BPUI\.friendlyError\(e,\{action:"record the payment"\}\)\)/);
  // no raw error object is written to the pay regions
  assert.ok(!/pay_(msg|block)[\s\S]{0,40}(textContent|innerHTML)\s*=\s*[^;]*\be\.message/.test(SETTLE),
    'raw e.message must not reach the pay status/alert regions');
});
t('C2. no migration filename (*.sql) is rendered on the settlement payment path', () =>
  assert.ok(!/\.sql["'`]/.test(SETTLE), 'no .sql filename string present in settlement.html'));
t('C3. dashboard surfaces errors via friendlyError / loadError (never raw)', () => {
  assert.match(DASH, /BPUI\.friendlyError\(/);
  assert.match(DASH, /BPUI\.loadError\(/);
  assert.ok(!/\.sql["'`]/.test(DASH), 'no .sql filename string present in dashboard.html');
});

console.log(`\ncapability-aware-errors: ${passed} assertion(s) passed.`);
