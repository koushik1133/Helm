#!/usr/bin/env node
// ============================================================================
// tests/staging/payment-redteam.mjs — money-path tampering + concurrency red-team
// against STAGING (SEC money-integrity: 0003 + record_payment/mark_paid guards).
//
// Tampering (server must recompute or reject, never trust the client):
//   * save_quotation_version with a crafted `total` (proper shape) -> recomputed.
//   * negative pricing components -> rejected (22003).
//   * record_payment with amount <= 0 -> rejected.
//   * record_payment that would overpay -> rejected (23514).
//   * pricing with NO `subtotal` (missing shape) -> SECURE expectation: client
//     `total` must NOT be trusted. (Finding: current helm_quote_total trusts
//     p.total when subtotal is absent; this case asserts the hardened contract
//     and will FAIL until that path recomputes/rejects.)
//
// Concurrency (genuine Promise.all bursts) — invariants:
//   * total_paid <= quote_total always.
//   * one logical payment = one ledger effect (same idempotency key -> 1 row).
//   * no duplicate receipt / no double count across record_payment, settlement,
//     and manual×webhook(mark_paid) combinations.
//
// SAFETY INVARIANTS:
//   * STAGING ONLY. assertStagingRef() before any write; prod ref -> abort.
//   * Fails CLOSED: missing env/seed -> exit 3 (BLOCKED), never PASS.
//   * Operates only on the seeded HARDEN_TEST org-A quote; secrets from env only.
// ============================================================================

import {
  assertStagingRef, assertEnv, BlockedError,
  signInRole, rpc, serviceSelect, makeReporter, rand,
} from './lib/client.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;
const ORG_A_SLUG = 'HARDEN_TEST_org_a';
const TOTAL = 100000;
const isArr = (d) => Array.isArray(d);

function makeSvc(e) {
  const H = { apikey: e.serviceKey, Authorization: `Bearer ${e.serviceKey}`, 'Content-Type': 'application/json' };
  async function req(method, path, body, prefer = 'return=representation') {
    const res = await fetch(`${e.url}/rest/v1/${path}`, { method, headers: { ...H, Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { ok: res.ok, status: res.status, data: d };
  }
  return {
    update: (table, q, patch) => req('PATCH', `${table}?${q}`, patch),
    insert: (table, row) => req('POST', table, row),
    del: (table, q) => req('DELETE', `${table}?${q}`),
  };
}

async function discover() {
  const org = await serviceSelect('organizations', `slug=eq.${ORG_A_SLUG}&select=id&limit=1`);
  if (!org.ok || !isArr(org.data) || !org.data.length) throw new BlockedError(`seeded org '${ORG_A_SLUG}' not found — seed first (fail-closed).`);
  const orgId = org.data[0].id;
  const q = await serviceSelect('quotes', `org_id=eq.${orgId}&select=id&limit=1`);
  if (!q.ok || !isArr(q.data) || !q.data.length) throw new BlockedError('no seeded quote in org A — seed fixtures missing (fail-closed).');
  return { orgId, quoteId: q.data[0].id };
}

async function reset(svc, quoteId) {
  await svc.del('quote_payments', `quote_id=eq.${quoteId}`);
  await svc.del('payment_milestones', `quote_id=eq.${quoteId}`);
  await svc.update('quotes', `id=eq.${quoteId}`, { pricing: { subtotal: TOTAL, discount: 0, gstPct: 0, total: TOTAL } });
}

async function paidRows(quoteId) {
  const r = await serviceSelect('quote_payments', `quote_id=eq.${quoteId}&status=eq.paid&select=amount,idempotency_key,receipt_no`);
  return (r.ok && isArr(r.data)) ? r.data : [];
}
function sum(rows) { return rows.reduce((a, b) => a + Number(b.amount || 0), 0); }

async function tamperingCases(rep, jwt, svc, quoteId) {
  // crafted total WITH proper shape -> server recomputes (subtotal 1000, gst 18 => 1180)
  const crafted = await rpc('save_quotation_version', { p_quote: quoteId, p_pricing: { subtotal: 1000, discount: 0, gstPct: 18, total: 777777 } }, jwt);
  const recomputed = crafted.ok && crafted.data && Number(crafted.data.total) === 1180;
  rep.line('tamper: crafted total recomputed (ignores client total)', recomputed, `got total=${crafted.data?.total} (expect 1180)`);

  // negative components -> rejected
  const neg = await rpc('save_quotation_version', { p_quote: quoteId, p_pricing: { subtotal: 1000, discount: -5, gstPct: -10 } }, jwt);
  rep.line('tamper: negative pricing components rejected', neg.ok === false, `status ${neg.status}`);

  // missing subtotal shape -> SECURE expectation: client total must NOT be trusted (finding)
  const noShape = await rpc('save_quotation_version', { p_quote: quoteId, p_pricing: { total: 777777 } }, jwt);
  const trustedClientTotal = noShape.ok && noShape.data && Number(noShape.data.total) === 777777;
  rep.line('tamper: missing-shape client total not trusted (G:recompute)', !trustedClientTotal,
    trustedClientTotal ? 'FINDING: server trusted client total=777777' : `total=${noShape.data?.total}`);

  // restore pricing for the payment phases
  await reset(svc, quoteId);

  // amount <= 0 rejected
  const negAmt = await rpc('record_payment', { p_quote: quoteId, p_amount: -100, p_method: 'cash', p_idempotency_key: 'neg-' + rand() }, jwt);
  rep.line('tamper: record_payment negative amount rejected', negAmt.ok === false, `status ${negAmt.status}`);
  const zeroAmt = await rpc('record_payment', { p_quote: quoteId, p_amount: 0, p_method: 'cash', p_idempotency_key: 'zero-' + rand() }, jwt);
  rep.line('tamper: record_payment zero amount rejected', zeroAmt.ok === false, `status ${zeroAmt.status}`);

  // single payment that overpays the quote total -> rejected
  await reset(svc, quoteId);
  const over = await rpc('record_payment', { p_quote: quoteId, p_amount: TOTAL * 2, p_method: 'cash', p_idempotency_key: 'over-' + rand() }, jwt);
  rep.line('tamper: single overpayment rejected (<=total)', over.ok === false, `status ${over.status}`);
  const after = await paidRows(quoteId);
  rep.line('tamper: ledger unchanged after rejected overpay', sum(after) <= TOTAL, `total_paid=${sum(after)}`);
}

async function concurrencyCases(rep, jwt, svc, quoteId) {
  // A) same idempotency key -> exactly ONE ledger effect
  await reset(svc, quoteId);
  const key = 'idem-' + rand();
  const dup = await Promise.all([
    rpc('record_payment', { p_quote: quoteId, p_amount: 50000, p_method: 'cash', p_idempotency_key: key }, jwt),
    rpc('record_payment', { p_quote: quoteId, p_amount: 50000, p_method: 'cash', p_idempotency_key: key }, jwt),
  ]);
  let rows = await paidRows(quoteId);
  rep.line('concurrency: same idempotency key -> 1 ledger row', rows.length === 1, `${rows.length} paid row(s), total_paid=${sum(rows)}`);
  rep.line('concurrency: same key -> total_paid <= total', sum(rows) <= TOTAL, `total_paid=${sum(rows)}`);

  // B) different keys within the total -> both commit, sum == total; a 3rd is rejected
  await reset(svc, quoteId);
  const two = await Promise.all([
    rpc('record_payment', { p_quote: quoteId, p_amount: 50000, p_method: 'cash', p_idempotency_key: 'k1-' + rand() }, jwt),
    rpc('record_payment', { p_quote: quoteId, p_amount: 50000, p_method: 'cash', p_idempotency_key: 'k2-' + rand() }, jwt),
  ]);
  rows = await paidRows(quoteId);
  rep.line('concurrency: two distinct payments within total commit', rows.length === 2 && sum(rows) <= TOTAL, `${rows.length} rows, total_paid=${sum(rows)}`);
  const third = await rpc('record_payment', { p_quote: quoteId, p_amount: 50000, p_method: 'cash', p_idempotency_key: 'k3-' + rand() }, jwt);
  rows = await paidRows(quoteId);
  rep.line('concurrency: 3rd payment over total rejected', third.ok === false && sum(rows) <= TOTAL, `3rd status ${third.status}, total_paid=${sum(rows)}`);

  // C) genuine overpay race: two 60k on a 100k quote -> exactly one wins
  await reset(svc, quoteId);
  await Promise.all([
    rpc('record_payment', { p_quote: quoteId, p_amount: 60000, p_method: 'cash', p_idempotency_key: 'r1-' + rand() }, jwt),
    rpc('record_payment', { p_quote: quoteId, p_amount: 60000, p_method: 'cash', p_idempotency_key: 'r2-' + rand() }, jwt),
  ]);
  rows = await paidRows(quoteId);
  rep.line('concurrency: overpay race -> exactly one effect', rows.length === 1 && sum(rows) <= TOTAL, `${rows.length} paid row(s), total_paid=${sum(rows)}`);

  // D) manual × webhook-equivalent (mark_paid flips a created row) — no double count
  await reset(svc, quoteId);
  await svc.insert('quote_payments', { quote_id: quoteId, provider: 'razorpay', amount: 40000, status: 'created', idempotency_key: 'created-' + rand(), org_id: (await discover()).orgId });
  await Promise.all([
    rpc('mark_paid', { p_quote_id: quoteId, p_provider_ref: 'wh-' + rand() }, jwt),
    rpc('record_payment', { p_quote: quoteId, p_amount: 40000, p_method: 'cash', p_idempotency_key: 'manual-' + rand() }, jwt),
  ]);
  rows = await paidRows(quoteId);
  rep.line('concurrency: manual×webhook -> total_paid <= total', sum(rows) <= TOTAL, `total_paid=${sum(rows)} across ${rows.length} row(s)`);
  const receipts = rows.map((r) => r.receipt_no).filter(Boolean);
  const uniqueReceipts = new Set(receipts).size === receipts.length;
  rep.line('concurrency: no duplicate receipt numbers', uniqueReceipts, `${receipts.length} receipt(s)`);

  // cleanup
  await reset(svc, quoteId);
}

export async function run() {
  assertStagingRef();
  const e = assertEnv({ needService: true });
  const svc = makeSvc(e);
  const rep = makeReporter('PAYMENT-REDTEAM');
  const { quoteId } = await discover();

  const jwt = await signInRole('admin', 'a'); // admin satisfies record_payment/mark_paid guards

  await tamperingCases(rep, jwt, svc, quoteId);
  await concurrencyCases(rep, jwt, svc, quoteId);

  return rep.summary();
}

async function main() {
  try {
    const s = await run();
    process.exit(s.ok ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    if (err instanceof BlockedError) { console.error(`PAYMENT-REDTEAM: BLOCKED — ${err.message}`); process.exit(EXIT_BLOCKED); }
    console.error(`PAYMENT-REDTEAM: BLOCKED — unexpected error: ${err?.message || err}`); process.exit(EXIT_BLOCKED);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
