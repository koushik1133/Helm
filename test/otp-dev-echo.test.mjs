#!/usr/bin/env node
/* otp-dev-echo.test.mjs — OTP-01 regression (READ-ONLY, source).
 * Asserts request_otp echoes the code ONLY behind the explicit otp_dev_echo
 * flag (default false → prod fails closed), not merely when sms_live is false.
 * NOT runtime proof — verify the deployed body on staging. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

const canonical = read('supabase/otp-payments.sql');
t('channels seed defines otp_dev_echo=false', () => {
  assert.ok(/"otp_dev_echo"\s*:\s*false/.test(canonical), 'otp_dev_echo:false not seeded');
});

// EVERY request_otp definition in the repo (canonical + dev-pin mirrors) must
// gate dev_code on otp_dev_echo and expose the fail-closed 'unavailable' branch,
// so re-running any of them cannot reintroduce the sms_live=false echo bypass.
const otpFiles = [
  'supabase/otp-payments.sql',
  'supabase/otp-dev-pin.sql',
  'supabase/full-schema/07-otp-dev-pin.sql',
];
for (const f of otpFiles) {
  const src = read(f);
  t(`${f}: dev_code gated on otp_dev_echo`, () =>
    assert.ok(/_flag\('otp_dev_echo'\)/.test(src), 'dev_code not gated on otp_dev_echo'));
  t(`${f}: has a fail-closed 'unavailable' branch`, () =>
    assert.ok(/'unavailable'/.test(src), "no fail-closed 'unavailable' branch"));
  t(`${f}: legacy "case when live then null else code" echo is gone`, () =>
    assert.ok(!/dev_code'?\s*,\s*case when live then null else code end/.test(src),
      'legacy ungated echo still present'));
}

console.log(`\notp-dev-echo: ${passed} assertion(s) passed.`);
