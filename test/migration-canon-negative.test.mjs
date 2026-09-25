#!/usr/bin/env node
/* migration-canon-negative.test.mjs — proves DEPLOY-01 guard CATCHES a stale,
 * unmarked, non-org-scoped privileged mirror (READ-ONLY except a self-cleaning
 * temp fixture it writes into supabase/ and always deletes in finally).
 *
 * It drops a scratch .sql that defines a NON-org-scoped confirm_quote with NO
 * DEPRECATED marker, then asserts scripts/check-migration-canon.mjs FAILS. Then
 * it removes the fixture and asserts the guard PASSES again. This guarantees the
 * recursive section-E guard has teeth (not just that the repo currently passes).
 */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/check-migration-canon.mjs');
// place the fixture inside a full-schema-like subdir to also exercise recursion
const fixture = join(ROOT, 'supabase', 'full-schema', 'zz-wave4-negative-scratch.sql');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };
const runGuard = () => { try { execFileSync(process.execPath, [GUARD], { stdio: 'pipe' }); return 0; } catch { return 1; } };

// a NON-org-scoped confirm_quote with NO deprecated marker in the first 800 chars
const STALE = `-- scratch mirror (test fixture) — intentionally unmarked, non-org-scoped
create or replace function public.confirm_quote(p_quote_id uuid, p_client jsonb, p_pricing jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.quotes set status='confirmed', pricing=coalesce(p_pricing,pricing) where id = p_quote_id;
end; $$;
`;

try {
  // sanity: guard passes on the clean repo first
  t('guard passes on the clean repo', () => assert.equal(runGuard(), 0));
  // introduce the stale mirror → guard must FAIL
  writeFileSync(fixture, STALE);
  t('guard FAILS when an unmarked non-org-scoped mirror is added (recursion works)',
    () => assert.equal(runGuard(), 1, 'guard did NOT catch a stale full-schema mirror'));
} finally {
  if (existsSync(fixture)) unlinkSync(fixture);
}
// after cleanup the guard passes again
t('guard passes again after the fixture is removed', () => assert.equal(runGuard(), 0));

console.log(`\nmigration-canon-negative: ${passed} assertion(s) passed.`);
