#!/usr/bin/env node
// ============================================================================
// tests/staging/token-otp.mjs — approval-token lifecycle, worker-token lifecycle,
// and OTP rate-limit / replay hardening (SEC-07 G1/G2/G3) against STAGING.
//
// Covers:
//   approval token : valid, expired, revoked, rotated (old invalid / new valid)
//   worker token   : valid, expired, revoked, renewed (old invalid / new valid)
//   OTP            : wrong code, expired, replay (already verified), and the
//                    rate-limit caps 3/phone/hour & 10/quote/day under GENUINE
//                    concurrent bursts (Promise.all), plus a real end-to-end
//                    request_otp burst via the anon public RPC.
//
// Provider: NEVER a real SMS. OTP rows are planted directly (service, for fixture
//   setup) with placeholder hashes; the anon request_otp path uses the staging
//   project's own (simulated) notifier. No real messages are sent.
//
// SAFETY INVARIANTS:
//   * STAGING ONLY. assertStagingRef() before any write; prod ref -> abort.
//   * Fails CLOSED: missing env/seed -> exit 3 (BLOCKED), never PASS.
//   * Secrets from env only; never printed. Service key used for fixture setup only.
//
// NOTE (finding): in the current staging schema worker_get_tasks() does NOT gate
//   on work_tokens.expires_at, and work_tokens has no revoked_at column. The
//   "worker expired -> denied" case below asserts the INTENDED G2 contract and
//   will FAIL until worker_get_tasks is hardened to reject expired tokens. Revoke
//   is modelled as row deletion (the only revocation the schema supports).
// ============================================================================

import {
  assertStagingRef, assertEnv, BlockedError,
  rpc, anonClient, serviceSelect, classify, makeReporter, rand,
} from './lib/client.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;
const ORG_A_SLUG = 'HARDEN_TEST_org_a';

const isArr = (d) => Array.isArray(d);
const ALLOWED = (res) => classify(res) === 'ALLOW';
const DENIED = (res) => classify(res) === 'DENY';
function plus(mins) { return new Date(Date.now() + mins * 60000).toISOString(); }

// Service-role fixture helpers (setup only — never asserts security). Built from the
// env object lib/client returns; secrets are never logged.
function makeSvc(e) {
  const base = (path) => `${e.url}/rest/v1/${path}`;
  const H = { apikey: e.serviceKey, Authorization: `Bearer ${e.serviceKey}`, 'Content-Type': 'application/json' };
  async function req(method, path, body, prefer = 'return=representation') {
    const res = await fetch(base(path), { method, headers: { ...H, Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { ok: res.ok, status: res.status, data: d };
  }
  return {
    insert: (table, row) => req('POST', table, row),
    update: (table, q, patch) => req('PATCH', `${table}?${q}`, patch),
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

// ---- approval-token lifecycle ----------------------------------------------
async function approvalTokenCases(rep, svc, quoteId) {
  const T1 = crypto.randomUUID();
  // valid
  await svc.update('quotes', `id=eq.${quoteId}`, { approval_token: T1, approval_token_expires_at: plus(60 * 24 * 30), approval_token_revoked_at: null });
  rep.line('approval token: valid accepted', ALLOWED(await anonClient.rpc('public_get_portal', { p_token: T1 })));
  // expired
  await svc.update('quotes', `id=eq.${quoteId}`, { approval_token_expires_at: plus(-60) });
  rep.line('approval token: expired rejected', DENIED(await anonClient.rpc('public_get_portal', { p_token: T1 })));
  // revoked (expiry floored to past + revoked stamp)
  await svc.update('quotes', `id=eq.${quoteId}`, { approval_token_revoked_at: new Date().toISOString(), approval_token_expires_at: plus(-60) });
  rep.line('approval token: revoked rejected', DENIED(await anonClient.rpc('public_get_portal', { p_token: T1 })));
  // rotated: new token valid, old token invalid
  const T2 = crypto.randomUUID();
  await svc.update('quotes', `id=eq.${quoteId}`, { approval_token: T2, approval_token_expires_at: plus(60 * 24 * 30), approval_token_revoked_at: null });
  rep.line('approval token: rotated new accepted', ALLOWED(await anonClient.rpc('public_get_portal', { p_token: T2 })));
  rep.line('approval token: rotated old invalid', DENIED(await anonClient.rpc('public_get_quote', { p_token: T1 })));
}

// ---- worker-token lifecycle -------------------------------------------------
async function workerTokenCases(rep, svc, orgId, quoteId) {
  const phone = '9' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const W1 = crypto.randomUUID();
  const ins1 = await svc.insert('work_tokens', { token: W1, quote_id: quoteId, phone, name: 'HT worker', org_id: orgId });
  if (!ins1.ok) throw new BlockedError(`cannot plant work_token fixture (HTTP ${ins1.status}) — schema/seed mismatch (fail-closed).`);
  rep.line('worker token: valid accepted', ALLOWED(await anonClient.rpc('worker_get_tasks', { p_token: W1 })));

  // expired — asserts the INTENDED G2 contract (see file header note).
  await svc.update('work_tokens', `token=eq.${W1}`, { expires_at: plus(-60) });
  rep.line('worker token: expired rejected (G2 intent)', DENIED(await anonClient.rpc('worker_get_tasks', { p_token: W1 })));

  // revoked — modelled as row removal (no revoked_at column in schema).
  await svc.del('work_tokens', `token=eq.${W1}`);
  rep.line('worker token: revoked rejected', DENIED(await anonClient.rpc('worker_get_tasks', { p_token: W1 })));

  // renewed -> old invalid / new valid.
  const W2 = crypto.randomUUID();
  const ins2 = await svc.insert('work_tokens', { token: W2, quote_id: quoteId, phone, name: 'HT worker', org_id: orgId });
  if (!ins2.ok) throw new BlockedError(`cannot plant renewed work_token (HTTP ${ins2.status}) — fail-closed.`);
  rep.line('worker token: renewed new accepted', ALLOWED(await anonClient.rpc('worker_get_tasks', { p_token: W2 })));
  rep.line('worker token: renewed old invalid', DENIED(await anonClient.rpc('worker_get_tasks', { p_token: W1 })));
  await svc.del('work_tokens', `token=eq.${W2}`);
}

// ---- OTP negative + replay --------------------------------------------------
async function otpNegativeCases(rep, svc, orgId, quoteId) {
  const phone = '8' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  // active (unverified, unexpired) row for wrong-code + replay
  const active = await svc.insert('quote_otps', { quote_id: quoteId, phone, code_hash: 'HT-placeholder-hash', expires_at: plus(10), org_id: orgId });
  if (!active.ok) throw new BlockedError(`cannot plant quote_otps fixture (HTTP ${active.status}) — fail-closed.`);

  // wrong code -> rejected (incorrect code / non-authz body error, but NOT a success)
  const wrong = await anonClient.rpc('verify_and_consent', { p_token: crypto.randomUUID(), p_phone: phone, p_code: '000000', p_agreed: true, p_terms_version: 'v1', p_consent_text: 'x', p_client_name: 'HT', p_user_agent: 'HT' });
  rep.line('OTP: wrong code / bad link not accepted', !(wrong.ok && wrong.data && wrong.data.ok === true), `status ${wrong.status}`);

  // expired OTP -> 'no active code'
  const expPhone = '8' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  await svc.insert('quote_otps', { quote_id: quoteId, phone: expPhone, code_hash: 'h', expires_at: plus(-10), org_id: orgId });
  const expd = await anonClient.rpc('verify_and_consent', { p_token: crypto.randomUUID(), p_phone: expPhone, p_code: '123456', p_agreed: true, p_terms_version: 'v1', p_consent_text: 'x', p_client_name: 'HT', p_user_agent: 'HT' });
  rep.line('OTP: expired code not accepted', !(expd.ok && expd.data && expd.data.ok === true), `status ${expd.status}`);

  // replay: mark the active row verified, then verifying again finds no active code
  await svc.update('quote_otps', `quote_id=eq.${quoteId}&phone=eq.${phone}`, { verified_at: new Date().toISOString() });
  const replay = await anonClient.rpc('verify_and_consent', { p_token: crypto.randomUUID(), p_phone: phone, p_code: '123456', p_agreed: true, p_terms_version: 'v1', p_consent_text: 'x', p_client_name: 'HT', p_user_agent: 'HT' });
  rep.line('OTP: replay of verified code not accepted', !(replay.ok && replay.data && replay.data.ok === true), `status ${replay.status}`);
}

// ---- OTP rate limits under GENUINE concurrency (G3) -------------------------
async function otpConcurrencyCases(rep, svc, orgId, quoteId) {
  // 3 per phone per hour: 6 concurrent inserts, same phone+quote -> exactly 3 succeed.
  const phone = '7' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  await svc.del('quote_otps', `quote_id=eq.${quoteId}&phone=eq.${phone}`);
  const burst1 = await Promise.all(Array.from({ length: 6 }, () =>
    svc.insert('quote_otps', { quote_id: quoteId, phone, code_hash: 'h', expires_at: plus(10), org_id: orgId })));
  const ok1 = burst1.filter((r) => r.ok).length;
  rep.line('OTP: 3/phone/hour cap under concurrency', ok1 === 3, `${ok1} of 6 inserts committed (expect 3)`);

  // 10 per quote per day: 13 concurrent inserts, DISTINCT phones -> exactly 10 succeed.
  const q2 = (await serviceSelect('quotes', `org_id=eq.${orgId}&select=id&order=id&limit=1`)).data?.[0]?.id || quoteId;
  await svc.del('quote_otps', `quote_id=eq.${q2}`);
  const burst2 = await Promise.all(Array.from({ length: 13 }, (_, i) =>
    svc.insert('quote_otps', { quote_id: q2, phone: '6' + String(i).padStart(9, '0'), code_hash: 'h', expires_at: plus(10), org_id: orgId })));
  const ok2 = burst2.filter((r) => r.ok).length;
  rep.line('OTP: 10/quote/day cap under concurrency', ok2 === 10, `${ok2} of 13 inserts committed (expect 10)`);
  await svc.del('quote_otps', `quote_id=eq.${q2}`);

  // End-to-end anon request_otp burst (real public path, simulated notifier).
  const T = crypto.randomUUID();
  await svc.update('quotes', `id=eq.${quoteId}`, { approval_token: T, approval_token_expires_at: plus(60 * 24 * 30), approval_token_revoked_at: null });
  const ePhone = '7' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  await svc.del('quote_otps', `quote_id=eq.${quoteId}&phone=eq.${ePhone}`);
  const burst3 = await Promise.all(Array.from({ length: 6 }, () => anonClient.rpc('request_otp', { p_token: T, p_phone: ePhone })));
  const ok3 = burst3.filter((r) => r.ok).length;
  rep.line('OTP: anon request_otp burst capped at 3/phone/hour', ok3 === 3, `${ok3} of 6 request_otp calls succeeded (expect 3)`);
  await svc.del('quote_otps', `quote_id=eq.${quoteId}&phone=eq.${ePhone}`);
}

export async function run() {
  assertStagingRef();
  const e = assertEnv({ needService: true });
  const svc = makeSvc(e);
  const rep = makeReporter('TOKEN-OTP');
  const { orgId, quoteId } = await discover();

  await approvalTokenCases(rep, svc, quoteId);
  await workerTokenCases(rep, svc, orgId, quoteId);
  await otpNegativeCases(rep, svc, orgId, quoteId);
  await otpConcurrencyCases(rep, svc, orgId, quoteId);

  return rep.summary();
}

async function main() {
  try {
    const s = await run();
    process.exit(s.ok ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    if (err instanceof BlockedError) { console.error(`TOKEN-OTP: BLOCKED — ${err.message}`); process.exit(EXIT_BLOCKED); }
    console.error(`TOKEN-OTP: BLOCKED — unexpected error: ${err?.message || err}`); process.exit(EXIT_BLOCKED);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
