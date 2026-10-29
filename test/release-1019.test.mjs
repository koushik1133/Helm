// release-1019.test.mjs - the release/1019 paste file and migration numbering:
//  * MANIFEST: every migration number once, everything after 0205 in numeric order; the 1019 set = every migration
//    after 0205 that did not ship with release 1018-c (0206 / 0207 / 0208 / 0236 / 0237 are in production)
//  * supabase/APPLY-RELEASE-1019.sql is current (generator --check), one section per 1019 migration in order,
//    each paste file verbatim, ends with ONE combined VERIFY grid; pasteable (ASCII, no psql meta / temp table)
//  * the owner steps document names the paste file and every changed edge function
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

const SHIPPED_1018_C = ['0206', '0207', '0208', '0236', '0237'];
const REL = ['0210', '0211', '0212', '0213', '0220', '0222', '0223'];
const AFTER_1019 = ['0238', '0239', '0240', '0241', '0242', '0244', '0246', '0248', '0249', '0250', '0251', '0252', '0253', '0254', '0255', '0256', '0257', '0260', '0261', '0262', '0263', '0264', '0265', '0266', '0268', '0269', '0270', '0271', '0272', '0273', '0274', '0276', '0277', '0279', '0281', '0282', '0283', '0285', '0291', '0284', '0292', '0287', '0290', '0278', '0280', '0288', '0293', '0295', '0296', '0297', '0302', '0298', '0299', '0301'];   // r60 database hardening: APPLY-0301.sql;   // r61 quote validity undo: APPLY-0302.sql;   // r55 no accidental hard deletes: APPLY-0296.sql; r54 export lockdown: APPLY-0295.sql;   // r28 HQ v2: APPLY-0278.sql + APPLY-0280.sql; r39 staff Google-only: APPLY-0288.sql; r41 send window: APPLY-0290.sql; r37 studio time zone: APPLY-0287.sql; r34 invitation RSVP + privacy + themes: APPLY-0284.sql; r29 referral program: APPLY-0279.sql; r31 cyber (client ip): APPLY-0281.sql; r32 security review: APPLY-0282.sql; r33 team safety: APPLY-0283.sql; r35 payment-details safety: APPLY-0285.sql; r44 admin two-step: APPLY-0291.sql; r27 HQ staff roles: APPLY-0277.sql;   // r26 public-form captcha: APPLY-0276.sql; r25 currency: APPLY-0273.sql; r25 HQ redesign numbers: APPLY-0272.sql; r24 contact sales + suggestions: APPLY-0271.sql; r24 CI inbox speed: APPLY-0270.sql; r24 automation: APPLY-0269.sql; r24 stock one flow: APPLY-0268.sql; r23 quote validity: APPLY-0262.sql; r23 state machine: APPLY-0263.sql; r23 inbox: APPLY-0266.sql; r23 link views: APPLY-0261.sql; r23 crew: APPLY-0265.sql; r23 payment schedules: APPLY-0264.sql; r23 studio name & link lock: APPLY-0257.sql; r23 cancel expires links (+ restore): APPLY-0260.sql; r23 vendors: APPLY-0256.sql;   // r22 create-studio (one sign-up flow): APPLY-0255.sql; r22 closure checklist: APPLY-0254.sql; r22 mfa reset: APPLY-0253.sql; r22 money (crew wages = staff on the event): APPLY-0252.sql; r21 political layout: APPLY-0251.sql; r21 security notices: APPLY-0250.sql; r20: 0238 ships in release 1020 (supabase/APPLY-RELEASE-1020.sql); 0239 (Business area) its own APPLY-0239.sql; r21: 0240 (Insights event costs) its own APPLY-0240.sql; r21 reserved domain: APPLY-0248.sql; 0244 (r21 trial -> paid) its own APPLY-0244.sql; r21 0242 (studio target margin): APPLY-0242.sql; r21: 0240 (Insights event costs) APPLY-0240.sql; r21 reminders: APPLY-0241.sql; r21: 0246 (event money ledger) its own APPLY-0246.sql; r21 0249 (security readiness) APPLY-0249.sql
const man = read('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
const after = nums.filter((n) => +n > 205);
t('MANIFEST: each migration number once; after 0205 in numeric order; the 1019 set = everything not shipped in 1018-c', () => {
  assert.equal(new Set(nums).size, nums.length, 'duplicate migration number');
  assert.deepEqual([...after].sort(), after, 'numeric order after 0205');
  assert.deepEqual(after.filter((n) => !SHIPPED_1018_C.includes(n) && !AFTER_1019.includes(n)), REL);
});
t('APPLY-RELEASE-1019.sql is current', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-apply-release-1019.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
t('one section per 1019 migration, in order, each paste file verbatim; ONE combined VERIFY last', () => {
  const rel = read('supabase/APPLY-RELEASE-1019.sql');
  const heads = [...rel.matchAll(/^-- RELEASE SECTION (\d+)\/(\d+): (\S+)\n-- In plain words: \S/gm)].map((m) => m[3]);
  assert.deepEqual(heads, REL.map((n) => `APPLY-${n}.sql`));
  for (const n of REL) assert.ok(rel.includes(read(`supabase/APPLY-${n}.sql`).replace(/\s*$/, '\n')), n + ' verbatim');
  assert.equal((rel.match(/^begin;$/gm) || []).length, REL.length);
  assert.equal((rel.match(/^commit;$/gm) || []).length, REL.length);
  assert.match(rel, /-- COMBINED VERIFY[^\n]*\n-- #+\nselect item, ok from \(\n[\s\S]*\n\) z order by item;\n$/);
  for (const n of REL) assert.ok(rel.includes(`select '${n} ' || item as item, ok from (values`), n + ' VERIFY rows in the grid');
});
t('pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE', () => {
  const rel = read('supabase/APPLY-RELEASE-1019.sql');
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(rel), 'ASCII');
  assert.ok(!/^\s*\\/m.test(rel), 'psql meta');
  assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(rel), 'temp table');
  assert.ok(!/^\s*(drop\s+table|truncate)\b/im.test(rel), 'drop table / truncate');
});
t('every 1019 DB suite is in run-all.sh; generator --check is in npm run ci', () => {
  const ra = read('scripts/db-test/run-all.sh');
  for (const s of ['signup-invite-0210', 'trial-quotes-0211', 'trial-email-0212', 'sample-layouts-0213', 'start-blank-0220', 'trial-seed-0222', 'trial-dates-0223'])
    assert.match(ra, new RegExp('^run "' + s + '" ', 'm'), s);
  assert.match(JSON.parse(read('package.json')).scripts.ci, /node scripts\/gen-apply-release-1019\.mjs --check/);
});
t('owner steps: the paste file, every changed edge function (prod ref, --no-verify-jwt), the email templates', () => {
  const d = read('docs/release/RELEASE-1019-OWNER-STEPS.md');
  assert.match(d, /supabase\/APPLY-RELEASE-1019\.sql/);
  // the repo's JWT convention (release 1018): these run without the JWT check, the other four keep it
  for (const f of ['invite-signup', 'client-mailer', 'comms-dispatch', 'invite-mailer', 'welcome-mailer', 'pkg-client-notify', 'billing-reminder'])
    assert.match(d, new RegExp('supabase functions deploy ' + f + ' +--project-ref nqltzgiwznphugcfhmbm --no-verify-jwt\\n'), f);
  for (const f of ['send-otp', 'wa-proposal', 'create-payment-link', 'send-whatsapp'])
    assert.match(d, new RegExp('supabase functions deploy ' + f + ' +--project-ref nqltzgiwznphugcfhmbm\\n'), f);
  assert.match(d, /APPLY-0213-refresh-trial-layouts\.sql/);
  assert.match(d, /docs\/ops\/email-templates\//);
});
let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`release-1019: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
