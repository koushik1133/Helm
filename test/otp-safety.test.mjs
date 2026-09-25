#!/usr/bin/env node
/* ============================================================================
 * otp-safety.test.mjs — positive regression test for PR-AUTH-01.
 *
 * READ-ONLY (no DB, no network). Complements scripts/check-otp-safety.mjs
 * (which forbids a hardcoded PIN) by asserting the SAFE random-code pattern is
 * actually present in every request_otp definition in the repo.
 *
 * NOT runtime proof: this checks source. The deployed function body must be
 * verified separately on an approved staging DB (see docs).
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const files = [
  'supabase/otp-payments.sql',
  'supabase/otp-dev-pin.sql',
  'supabase/full-schema/complete-setup.sql',
  'supabase/full-schema/07-otp-dev-pin.sql',
];

const RANDOM = /code\s*:=\s*lpad\(\(floor\(random\(\)\s*\*\s*1000000\)\)/i;
const HARDCODED = /\bcode\s*:=\s*'[0-9]+'/i;

for (const f of files) {
  const src = read(f);
  t(`${f}: request_otp uses a random code, not a fixed PIN`, () => {
    assert.ok(RANDOM.test(src), `${f}: safe random-code pattern missing from request_otp`);
    // ensure no active (non-comment) hardcoded assignment survives
    const active = src.split('\n').map((l) => l.split('--')[0]).join('\n');
    assert.ok(!HARDCODED.test(active), `${f}: a hardcoded OTP code assignment is present`);
  });
}

console.log(`\notp-safety: ${passed} assertion(s) passed.`);
console.log('NOTE: source-level only. Verify the DEPLOYED request_otp body on staging.');
