// audit run 3, P2 low DB findings (0156) + the P0 legacy-bundle guard: static checks.
// The behaviour is tested against a local Postgres in tests/db/audit-p2-0156.sql (run-all.sh).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, p), 'utf8');
const mig = r('supabase/migrations/0156_audit_p2_db_low.sql');
const apply = r('supabase/APPLY-0156.sql');
const active = (s) => s.split('\n').map((l) => l.split('--')[0]).join('\n');
const tests = [];
const t = (n, f) => tests.push([n, f]);

t('0156 is in the MANIFEST after 0154', () => {
  const m = r('supabase/migrations/MANIFEST');
  assert.ok(m.includes('forward  supabase/migrations/0156_audit_p2_db_low.sql'));
  assert.ok(m.indexOf('0154_final_fixes.sql') < m.indexOf('0156_audit_p2_db_low.sql'));
});
t('migration and APPLY are ASCII; APPLY wraps the migration in one transaction', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(mig), 'migration ascii');
  assert.ok(/^[\x00-\x7F]*$/.test(apply), 'apply ascii');
  assert.ok(apply.includes(mig), 'APPLY carries the migration verbatim');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;\s*$/m);
});
t('zero data loss: no table/column drop, no delete, no truncate', () => {
  // the one 'drop table' is the realtime publication membership of chat_reactions (no data involved)
  const a = active(mig).toLowerCase().replace("alter publication supabase_realtime drop table public.chat_reactions", '');
  assert.equal((active(mig).match(/alter publication/gi) || []).length, 1);
  assert.ok(!/drop\s+table|drop\s+column|alter\s+table[^;]*\sdrop\s|truncate\s+(table\s+)?public|delete\s+from/.test(a));
  for (const m of a.matchAll(/\bdrop\s+(\w+)/g)) assert.ok(['policy', 'trigger', 'table'].includes(m[1]) && m[1] !== 'table', 'only drop policy / trigger: ' + m[0]);
});
t('VERIFY select lists 23 checks', () => {
  assert.equal((mig.match(/^\s+\('\d\d [^']+',/gm) || []).length, 23);
  assert.match(mig, /\) v\(item, ok\);\s*$/);
});
t('old bodies are kept (rename-and-wrap) for the wrapped functions', () => {
  for (const f of ['accept_invitation', 'create_invitation', 'record_vendor_payout', 'record_payment', 'record_settlement_payment',
                   'mark_paid', 'public_booklet_otp_request', 'public_booklet_choose', 'smart_import_batch', 'verify_and_consent']) {
    assert.match(mig, new RegExp('rename to ' + f + '__pre0156'), f);
    assert.match(mig, new RegExp('public\\.' + f + '__pre0156\\('), f + ' is called by its wrapper');
  }
});
t('every *__pre0156 copy is closed to anon / signed-in callers', () => {
  for (const f of ['accept_invitation', 'create_invitation', 'record_vendor_payout', 'smart_import_batch', 'verify_and_consent']) {
    assert.match(mig, new RegExp("revoke all on function public\\." + f + "__pre0156\\([^)]*\\) from authenticated"), f);
  }
  assert.match(mig, /'public\.public_booklet_choose__pre0156\(uuid, uuid, integer, text, text\)'\] loop/);
});
t('re-open is only through reopen_event (store-api no longer calls close_event(false))', () => {
  assert.match(mig, /helm\.a156_reopen/);
  const s = r('public/store-api.js');
  assert.match(s, /if \(!closed\) throw new Error\("Only an admin can re-open a closed event/);
  assert.ok(!/p_closed: !!closed/.test(s));
});
t('db-gates-0049 re-opens through reopen_event; run-all runs the 0156 suite first', () => {
  assert.match(r('tests/db/db-gates-0049.sql'), /public\.reopen_event\('a0000000-0000-4000-8000-00000000da01', 'g49 kit returned, re-open'\)/);
  const ra = r('scripts/db-test/run-all.sh');
  assert.ok(ra.indexOf('audit-p2-0156') > 0 && ra.indexOf('audit-p2-0156') < ra.indexOf('"pending-fixes"'));
});
t('legacy bundles that put back the NULL-OTP bypass now refuse to run', () => {
  for (const f of ['supabase/APPLY-0039.sql', 'supabase/wave10/WAVE-10-PROD-UPGRADE.sql', 'supabase/harden-2026-10/H02-otp-verify-row-lock.sql',
                   'supabase/full-schema/complete-setup.sql', 'supabase/wave5/WAVE-05-UPGRADE.sql', 'supabase/HELM-STAGING-SCHEMA.sql']) {
    const s = r(f);
    assert.ok(/^-- ==== SUPERSEDED - DO NOT RUN/.test(s), f + ' guard at the very top');
    assert.match(s.slice(0, 2000), /do \$a156guard\$ begin[\s\S]*raise exception 'superseded/, f);
  }
  assert.match(r('supabase/APPLY-0039.sql').slice(0, 2000), /verify_and_consent__pre0042/);
  assert.match(r('supabase/APPLY-0092-0093.sql').slice(0, 2000), /verify_and_consent__pre0156/);
});
t('complete-setup.sql seeds no published password and never resets an existing account', () => {
  const s = r('supabase/full-schema/complete-setup.sql');
  assert.ok(!/create_helm_user\(\s*'[^']*'\s*,\s*'helm'/i.test(active(s)));
  assert.match(s, /encode\(extensions\.gen_random_bytes\(18\), 'base64'\)/);
  assert.match(s, /where not exists \(select 1 from auth\.users u where u\.email = v\.email\)/);
  assert.ok(!/password `helm`/.test(r('supabase/full-schema/README.md')));
});
t('base OTP compare fix and the patch helper are idempotent text patches', () => {
  assert.match(mig, /p_code is null or extensions\.crypt\(p_code, rec\.code_hash\) is distinct from rec\.code_hash/);
  assert.match(mig, /if position\(p_new in d\) > 0 then return 'already'; end if;/);
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ' + n); } catch (err) { fail++; console.log('  FAIL ' + n + '\n       ' + err.message); } }
console.log(fail ? `audit-p2-0156: ${fail} FAILED` : `audit-p2-0156: all ${tests.length} passed`);
process.exit(fail ? 1 : 0);
