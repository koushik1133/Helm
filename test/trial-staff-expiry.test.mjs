// Trial staff + after-trial access (0126; 0183: staff keep read-only access instead of being blocked).
//  * SQL additive + idempotent; current_org_id keeps the 0043 2FA gate and only adds the trial gate
//  * owner (organizations.created_by) is never blocked; gate depends on _trial_locked (pay -> unlock)
//  * my_trial_access granted to authenticated, not anon; APPLY = migration + VERIFY
//  * trial.js: staff note + blocked screen specs; CSP-safe DOM (no innerHTML / inline style)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/0126_trial_staff_and_expiry.sql');
const APPLY = read('supabase/APPLY-0126.sql'), VERIFY = read('supabase/VERIFY-0126.sql');
const TJS = read('public/trial.js'), API = read('public/store-api.js'), DOC = read('docs/product/TRIAL-POLICY.md');
const trial = require('../public/trial.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

t('SQL is additive: no drop / delete / truncate / update / rename', () => {
  const c = code(MIG).toLowerCase();
  assert.ok(!/\bdrop\s+(table|column|function|trigger|index|policy|view|schema)\b/.test(c));
  assert.ok(!/\bdelete\s+from\b/.test(c)); assert.ok(!/\btruncate\b/.test(c));
  assert.ok(!/\bupdate\s+public\./.test(c), 'no row updates (memberships untouched)');
  assert.ok(!/alter\s+(table|function)/.test(c));
  assert.ok(!/[^\x00-\x7f]/.test(MIG + APPLY + VERIFY), 'ASCII only');
});
t('current_org_id keeps 0043 shape and adds the trial gate', () => {
  const at = MIG.indexOf('function public.current_org_id()'); const body = MIG.slice(at, MIG.indexOf('$$;', MIG.indexOf('$$', at) + 2));
  assert.match(body, /returns uuid language sql stable security definer set search_path = ''/);
  assert.match(body, /public\.mfa_ok\(\)/); assert.match(body, /current_org_id__pre0043\(\)/);
  assert.match(body, /_trial_member_blocked\(x\.org\)/);
});
t('blocked = non-owner + ended trial + _trial_locked (paying unlocks)', () => {
  const at = MIG.indexOf('function public._trial_member_blocked'); const body = MIG.slice(at, MIG.indexOf('$$;', at + 200));
  assert.match(body, /trial_ends_at is not null and o\.trial_ends_at <= now\(\)/);
  assert.match(body, /o\.created_by is not null and o\.created_by <> auth\.uid\(\)/);
  assert.match(body, /public\._trial_locked\(p_org\)/);
  assert.match(body, /auth\.uid\(\) is not null/);
  assert.match(MIG, /revoke all on function public\._trial_member_blocked\(uuid\) from authenticated/);
});
t('my_trial_access: not via current_org_id, granted to authenticated only', () => {
  const at = MIG.indexOf('function public.my_trial_access'); const body = MIG.slice(at, MIG.indexOf('end $$;', at));
  assert.ok(!/public\.current_org_id\(\)/.test(body)); assert.match(body, /current_org_id__pre0043\(\)/);
  assert.match(MIG, /grant execute on function public\.my_trial_access\(\) to authenticated/);
  assert.match(MIG, /revoke all on function public\.my_trial_access\(\) from anon/);
});
t('APPLY wraps migration + verify in one transaction', () => {
  assert.ok(APPLY.includes(MIG.trim())); assert.ok(APPLY.includes(VERIFY.trim()));
  assert.match(APPLY, /^-- APPLY 0126[^\n]*\nbegin;/); assert.match(APPLY, /\ncommit;\n/);
});
t('store-api exposes trialOrg.access -> my_trial_access', () => assert.match(API, /access: \(\) => \(supa \? rpc\("my_trial_access", \{\}\)/));
t('staff note: active trial shows end date; ended says read-only for everyone (0183)', () => {
  const a = trial.staffNoteSpec({ is_trial_org: true, ends_at: '2026-10-24T10:00:00Z', ended: false, locked: false, timezone: 'Asia/Kolkata' });
  assert.match(a.text, /^Trial: when the trial ends on .*, your staff keep read-only access until you upgrade\./);
  assert.match(trial.staffNoteSpec({ is_trial_org: true, ended: true, locked: true }).text, /including invited staff, can still sign in and view everything in read-only mode/);
  assert.equal(trial.staffNoteSpec({ is_trial_org: false }), null); assert.equal(trial.staffNoteSpec(null), null);
  assert.equal(trial.staffNoteSpec({ is_trial_org: true, ended: true, locked: true }).tone, 'ended');
});
t('blocked screen only for blocked non-owners', () => {
  const s = trial.blockedSpec({ is_trial_org: true, blocked: true, is_owner: false, name: 'Demo 3' });
  assert.equal(s.title, "This studio's trial has ended"); assert.match(s.body, /Ask the studio owner to subscribe to Demo 3/);
  assert.equal(trial.blockedSpec({ is_trial_org: true, blocked: true, is_owner: true }), null);
  assert.equal(trial.blockedSpec({ is_trial_org: true, blocked: false }), null);
  assert.equal(trial.blockedSpec(null), null);
});
t('trial.js stays CSP-safe', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"/.test(TJS));
});
t('policy doc covers read-only owner + read-only staff (0183), no auto-delete, instant unlock', () => {
  for (const re of [/read-only/i, /keep read-only access/i, /never deleted automatically|No data is ever deleted automatically/i, /instantly/i]) assert.match(DOC, re);
});
console.log(`\n${n} trial-staff-expiry checks passed`);
