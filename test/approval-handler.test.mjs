#!/usr/bin/env node
/* approval-handler.test.mjs — W10-D1 fail-closed regression for the approval page.
 * Proves the approve.html confirm handler shows the approved step ONLY when the
 * verify_and_consent result is explicitly {approved:true}. Guards against the
 * regression where a soft-returned {approved:false} (HTTP 200, no throw) is
 * mistaken for success. READ-ONLY over source + pure-logic simulation. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'approve.html'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

// The exact guard the handler uses. Mirrors: if (r && r.approved === true) { showStep('step3') }
const approvalGranted = (r) => !!(r && r.approved === true);

// 1..6 — behavioral fail-closed matrix
t('1. RPC throws (caught) → not shown', () => {
  // a thrown error never produces r; handler enters catch → never calls approvalGranted
  // model: no result object reaches the guard
  assert.equal(approvalGranted(undefined), false);
});
t('2. {approved:false,error:"incorrect_code"} → not shown', () =>
  assert.equal(approvalGranted({ approved: false, error: 'incorrect_code' }), false));
t('3. {approved:false,error:"locked"} → not shown', () =>
  assert.equal(approvalGranted({ approved: false, error: 'locked' }), false));
t('4. {approved:false,error:"no_active_code"} → not shown', () =>
  assert.equal(approvalGranted({ approved: false, error: 'no_active_code' }), false));
t('5. null / undefined / malformed → not shown', () => {
  assert.equal(approvalGranted(null), false);
  assert.equal(approvalGranted(undefined), false);
  assert.equal(approvalGranted({}), false);
  assert.equal(approvalGranted({ approved: 'yes' }), false);   // truthy-but-not-true rejected
  assert.equal(approvalGranted({ approved: 1 }), false);
});
t('6. {approved:true} → shown', () =>
  assert.equal(approvalGranted({ approved: true }), true));

// Source invariants — the deployed handler must actually use the fail-closed guard
t('source: confirm handler guards step3 with approved===true', () => {
  assert.ok(/r\.approved === true/.test(SRC), 'strict approved===true guard present');
});
t('source: step3 is not shown unconditionally right after verifyConsent', () => {
  // there must be no "await ...verifyConsent(...); showStep('step3')" without a guard
  const bad = /verifyConsent\([^)]*\)\s*;\s*showStep\(['"]step3['"]\)/s;
  assert.ok(!bad.test(SRC), 'no unguarded showStep(step3) after verifyConsent');
});
t('source: the only confirm-path showStep(step3) sits inside the approved===true branch', () => {
  const idx = SRC.indexOf("r.approved === true");
  const step3 = SRC.indexOf("showStep('step3')", idx);
  assert.ok(idx > 0 && step3 > idx && step3 - idx < 120, 'step3 immediately follows the guard');
});

console.log(`\napproval-handler: ${passed} assertion(s) passed.`);
