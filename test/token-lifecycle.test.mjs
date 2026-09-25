#!/usr/bin/env node
/* token-lifecycle.test.mjs — TOKEN-01 regression (READ-ONLY, source).
 * Asserts approval tokens gained expiry columns, expiry-if-set enforcement in
 * consumers, and an explicit revocation RPC that nulls the token. NOT runtime
 * proof — verify on staging. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'supabase/otp-payments.sql'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('expiry + revocation columns added', () => {
  assert.ok(/add column if not exists approval_token_expires_at/.test(src));
  assert.ok(/add column if not exists approval_token_revoked_at/.test(src));
});
t('revoke_approval_token RPC exists, org-scoped, nulls the token', () => {
  const body = (src.match(/function public\.revoke_approval_token[\s\S]*?\$\$;/) || [''])[0];
  assert.ok(body, 'revoke_approval_token not defined');
  assert.ok(/assert_quote_org/.test(body) && /current_org_id/.test(body), 'not org-scoped');
  assert.ok(/approval_token\s*=\s*null/.test(body), 'does not null the token on revoke');
});
t('token lookups enforce expiry-if-set', () => {
  const enforced = (src.match(/approval_token_expires_at is null or approval_token_expires_at > now\(\)/g) || []).length;
  assert.ok(enforced >= 4, `expiry enforcement found in only ${enforced} lookups (expected the public consumers)`);
});
t('revoke_approval_token is not granted to anon', () => {
  assert.ok(/revoke all on function public\.revoke_approval_token\(uuid\) from anon/.test(src));
});

console.log(`\ntoken-lifecycle: ${passed} assertion(s) passed.`);
