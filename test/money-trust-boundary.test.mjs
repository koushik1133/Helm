#!/usr/bin/env node
/* ============================================================================
 * money-trust-boundary.test.mjs — regression protection for PR-MONEY-01.
 *
 * READ-ONLY source characterization test (no DB, no network). It does NOT
 * invent pricing/tax/rounding formulas or expected totals — none are documented
 * as authoritative, so server-side recomputation is BLOCKED — PRODUCT DECISION
 * REQUIRED. Instead this test PINS the current money trust boundary so it cannot
 * change silently:
 *
 *   1. Records that confirm_quote / save_quotation_version / record_payment
 *      currently persist CLIENT-SUPPLIED pricing/total verbatim (no server
 *      recompute). If someone edits those RPC bodies, this test fails and forces
 *      a conscious re-review of the trust boundary (and an update to this test).
 *   2. Asserts the one real server-side money guard that DOES exist today:
 *      record_payment rejects a non-positive amount.
 *
 * When the product decision lands and server recomputation is added, replace the
 * "still trusts client total" assertions with rejection/consistency assertions
 * and run them against an approved staging DB (see docs).
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const confirm = read('supabase/phase73-definer-org-isolation-final.sql');
const version = read('supabase/phase77-quotation-versions.sql');
const payment = read('supabase/phase76-advance-payment.sql');

// --- 1. Characterization: RPCs still trust client-supplied totals (PR-MONEY-01 open) ---
t('confirm_quote persists client-supplied p_pricing verbatim (trust boundary pinned)', () => {
  assert.match(confirm, /pricing\s*=\s*coalesce\(\s*p_pricing/i,
    'confirm_quote no longer stores p_pricing verbatim — trust boundary CHANGED; re-review PR-MONEY-01 and update this test');
});

t('save_quotation_version derives total from client p_pricing->>total (trust boundary pinned)', () => {
  assert.match(version, /p_pricing\s*->>\s*'total'/i,
    'save_quotation_version no longer reads total from client p_pricing — trust boundary CHANGED; re-review PR-MONEY-01');
});

// --- 2. Real server-side guard that exists today ---
t('record_payment rejects a non-positive amount (real guard)', () => {
  assert.match(payment, /coalesce\(\s*p_amount\s*,\s*0\s*\)\s*<=\s*0/i,
    'record_payment lost its non-positive-amount guard — regression');
});

// --- 3. Explicit BLOCKED marker so the gap is not silently "closed" ---
t('no false claim of server-side pricing recomputation exists in these RPCs', () => {
  // A genuine fix would introduce a server recompute (e.g. a call to an
  // authoritative pricing function). Assert it is NOT yet present so status
  // cannot drift to "fixed" without a real change + staging verification.
  const recomputed = /recompute|server_price|authoritative_total|compute_quote_total/i;
  assert.ok(!recomputed.test(confirm + version + payment),
    'A server-side recompute marker appeared: PR-MONEY-01 may now be addressed — convert these characterization tests into rejection/consistency tests and verify on staging.');
});

console.log(`\nmoney-trust-boundary: ${passed} assertion(s) passed.`);
console.log('NOTE: PR-MONEY-01 server-side recomputation is BLOCKED — PRODUCT DECISION REQUIRED.');
console.log('These are source characterization checks, NOT runtime proof of money integrity.');
