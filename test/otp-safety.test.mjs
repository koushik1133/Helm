#!/usr/bin/env node
/* ============================================================================
 * otp-safety.test.mjs — positive regression test for PR-AUTH-01.
 *
 * READ-ONLY (no DB, no network). Complements scripts/check-otp-safety.mjs
 * (which forbids a hardcoded PIN) by asserting the SAFE random-code pattern is
 * present in the CANONICAL request_otp (MANIFEST path; since migration 0026 the
 * code comes from extensions.gen_random_bytes, never random()).
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

// Historical / mirror SQL files: must never assign a fixed PIN.
const legacy = [
  'supabase/otp-payments.sql',
  'supabase/otp-dev-pin.sql',
  'supabase/full-schema/complete-setup.sql',
  'supabase/full-schema/07-otp-dev-pin.sql',
];
const HARDCODED = /\bcode\s*:=\s*'[0-9]+'/i;
const activeSql = (src) => src.split('\n').map((l) => l.split('--')[0]).join('\n');

for (const f of legacy) {
  t(`${f}: request_otp never assigns a fixed PIN`, () => {
    assert.ok(!HARDCODED.test(activeSql(read(f))), `${f}: a hardcoded OTP code assignment is present`);
  });
}

// The CANONICAL request_otp is the LAST definition on the MANIFEST path (base +
// forward migrations, in order). Since 0026 it must draw the code from pgcrypto's
// CSPRNG (gen_random_bytes) — never from random(), which is not cryptographically
// secure — and must not be a fixed PIN.
const manifest = read('supabase/migrations/MANIFEST').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[1]);
let canonical = null;
for (const f of manifest) {
  const body = activeSql(read(f));
  const m = body.match(/create\s+or\s+replace\s+function\s+public\.request_otp\s*\([\s\S]*?\$function\$;/gi);
  if (m) canonical = { file: f, body: m[m.length - 1] };
}
t('canonical request_otp found on the MANIFEST path', () => assert.ok(canonical, 'no request_otp on the canonical path'));
t(`canonical request_otp (${canonical && canonical.file}) uses gen_random_bytes, not random()`, () => {
  assert.ok(/extensions\.gen_random_bytes\s*\(/i.test(canonical.body), 'secure generator (extensions.gen_random_bytes) missing');
  assert.ok(!/\brandom\s*\(\s*\)/i.test(canonical.body), 'random() is still used to build the OTP');
  assert.ok(!HARDCODED.test(canonical.body), 'a hardcoded OTP code assignment is present');
});

console.log(`\notp-safety: ${passed} assertion(s) passed.`);
console.log('NOTE: source-level only. Verify the DEPLOYED request_otp body on staging.');
