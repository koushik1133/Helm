#!/usr/bin/env node
// ============================================================================
// tests/staging/run-security.mjs — orchestrator for the Helm STAGING runtime
// SECURITY harness. Runs the four suites in-process and emits a combined gate.
//
//   1. authz-matrix     role × mutating-RPC authorization
//   2. tenant-idor      cross-tenant (ORG_A <-> ORG_B) isolation / IDOR
//   3. token-otp        approval/worker token lifecycle + OTP rate-limit/replay
//   4. payment-redteam  money tampering + concurrency invariants
//
// Exit codes: 0 = all suites PASS; 1 = at least one suite FAILED a check;
//             3 = BLOCKED (env/seed/fixtures missing, or wrong project ref) —
//                 never reported as PASS.
//
// SAFETY: each suite independently asserts the STAGING ref and fails CLOSED.
// Secrets are read from env by lib/client.mjs only; nothing is printed here.
// ============================================================================

import { assertStagingRef, BlockedError } from './lib/client.mjs';
import { run as runAuthz } from './authz-matrix.mjs';
import { run as runTenant } from './tenant-idor.mjs';
import { run as runToken } from './token-otp.mjs';
import { run as runPayment } from './payment-redteam.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;

const SUITES = [
  { name: 'authz-matrix', run: runAuthz },
  { name: 'tenant-idor', run: runTenant },
  { name: 'token-otp', run: runToken },
  { name: 'payment-redteam', run: runPayment },
];

async function main() {
  // One hard staging assertion up front; each suite re-asserts before writing.
  try {
    assertStagingRef();
  } catch (err) {
    console.error(`[run-security] BLOCKED — ${err.message}`);
    process.exit(EXIT_BLOCKED);
  }

  const results = [];
  let blocked = false, failed = false;

  for (const s of SUITES) {
    console.log(`\n========== ${s.name} ==========`);
    try {
      const summary = await s.run();
      results.push({ name: s.name, status: summary.ok ? 'PASS' : 'FAIL', pass: summary.pass, fail: summary.fail });
      if (!summary.ok) failed = true;
    } catch (err) {
      const isBlock = err instanceof BlockedError;
      results.push({ name: s.name, status: isBlock ? 'BLOCKED' : 'ERROR', detail: err?.message || String(err) });
      if (isBlock) blocked = true; else failed = true;
      console.error(`[${s.name}] ${isBlock ? 'BLOCKED' : 'ERROR'} — ${err?.message || err}`);
    }
  }

  console.log('\n========== SECURITY HARNESS SUMMARY ==========');
  for (const r of results) {
    const detail = r.detail ? ` — ${r.detail}` : (r.pass != null ? ` (${r.pass} pass / ${r.fail} fail)` : '');
    console.log(`  ${r.status.padEnd(8)} ${r.name}${detail}`);
  }

  if (blocked) {
    console.log('\n[run-security] GATE: BLOCKED (fail-closed) — fix env/seed and re-run.');
    process.exit(EXIT_BLOCKED);
  }
  if (failed) {
    console.log('\n[run-security] GATE: FAIL');
    process.exit(EXIT_FAIL);
  }
  console.log('\n[run-security] GATE: PASS');
  process.exit(EXIT_PASS);
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) main();

export { SUITES };
