// r128: the open security list. Static + wiring checks; behaviour: tests/db/r128-security-fixes-0336.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = r('supabase/migrations/0336_r128_security_fixes.sql'), APPLY = r('supabase/APPLY-0336.sql');
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

t('0336 is in the manifest, after 0335', () => {
  const mf = r('supabase/migrations/MANIFEST');
  assert.match(mf, /forward\s+supabase\/migrations\/0336_r128_security_fixes\.sql/);
  assert.ok(mf.indexOf('0335_r126_hq_fixes.sql') < mf.indexOf('0336_r128_security_fixes.sql'));
});
t('APPLY-0336 carries the same body in one transaction, then VERIFY', () => {
  assert.ok(APPLY.includes(SQL.trim()));
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'));
});
t('both files are ASCII', () => { for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7F]*$/.test(s)); });
t('additive: no table, column, policy or schema object is dropped; only expired counters are deleted', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|policy|schema|view)\b/i);
  assert.doesNotMatch(code, /\btruncate\s+(table\s+)?public\./i);
  const dels = code.match(/delete\s+from\s+public\.[a-z0-9_]+/gi) || [];
  assert.deepEqual(dels, ['delete from public.a154_link_hits']);
  assert.match(code, /window_start < now\(\) - interval '2 days'/);
});
t('the cancel uses the same columns as Revoke and runs after the save', () => {
  assert.match(code, /create trigger zzzzz_r128_contact_cancels_link after update of client on public\.quotes/);
  assert.match(code, /set approval_token = null, approval_token_revoked_at = now\(\)/);
  assert.match(code, /not in \('approved', 'paid'\)/);
});
t('approval page asks about the total on screen before approving, and stops if it changed', () => {
  const h = r('public/approve.html');
  const i = h.indexOf('checkShown(token, shown)'), j = h.indexOf('BPStore.approval.verifyConsent(token, phone');
  assert.ok(i > 0 && i < j, 'check comes first');
  assert.match(h, /if\(same && same\.ok===false\)\{[^}]*return; \}/);
});
t('store-api: a database without 0336 or a network slip does not block an approval', () => {
  assert.match(r('public/store-api.js'), /checkShown: \(token, total\) => mode === "supabase" \? rpc\("approval_check_shown", \{ p_token: token, p_total: total \}\)\.catch\(\(\) => \(\{ ok: true \}\)\)/);
});
t('the trial preview answers the new call without the network', () => {
  assert.match(r('public/trial-preview.js'), /approval_check_shown: function \(\) \{ return val\(\{ ok: true \}\); \}/);
});
t('the DB suite is registered', () => {
  assert.match(r('scripts/db-test/run-all.sh'), /r128-security-fixes-0336\.sql/);
});
console.log(n + ' r128 checks passed');
