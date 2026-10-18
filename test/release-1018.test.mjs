// release/trial-and-fixes-1018 integration guards: the merge of the trial bundle + the parallel fix branches.
//   - 0201 (release integration SQL): ASCII, additive, last in the MANIFEST, suite registered, paste file shaped
//   - APPLY-RELEASE-1018.sql (one paste for the whole release) is generated and current
//   - client-mailer keeps BOTH free-trial gates (0166 outbox rule first, then 0179 trial_send_blocked) before a send
//   - the menu package editor keeps the trial-bundle "Sample" tag and the picker-review trial rules
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

const MIG = read('supabase/migrations/0201_release_integration.sql');
t('0201: ASCII, additive, re-issues the 0186 wrapper over the 0180 body, patches the 0184 purge list', () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(MIG), 'ASCII only');
  assert.doesNotMatch(MIG, /\b(drop\s+table|truncate|delete\s+from)\b/i);
  assert.match(MIG, /create or replace function public\.start_self_serve_trial__pre0186\(/);
  assert.match(MIG, /-- unified-trial-0119 trial-signup-0180:/);
  assert.match(MIG, /create or replace function public\.start_self_serve_trial\(p_name text[\s\S]*?-- one-trial-0186:[\s\S]*?return public\.start_self_serve_trial__pre0186\(/);
  assert.doesNotMatch(MIG, /pg_timezone_names/, 'the cheap 0190 path stays');
  assert.match(MIG, /'''chat_members'', ''chat_group_contacts'', ''chat_conversations'''/);
});
t('0201: last in the MANIFEST (after 0200), suite registered, paste file has begin / commit / VERIFY', () => {
  const man = read('supabase/migrations/MANIFEST');
  assert.match(man, /forward  supabase\/migrations\/0200_booklet_send\.sql\n#[^\n]*\nforward  supabase\/migrations\/0201_release_integration\.sql\n?$/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "release-integration-0201" "RELEASE-INTEGRATION-0201: ALL PASS \\\(11\/11\\\)" psql -q -f tests\/db\/release-integration-0201\.sql/);
  const ap = read('supabase/APPLY-0201.sql');
  assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m); assert.match(ap, /-- VERIFY/);
  assert.ok(ap.includes(MIG.trim()), 'the paste file carries the migration unchanged');
});
t('APPLY-RELEASE-1018.sql is current (trial bundle + 0189..0201 in MANIFEST order)', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-apply-release-1018.mjs', '--check'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const rel = read('supabase/APPLY-RELEASE-1018.sql');
  const order = ['APPLY-TRIAL-BUNDLE.sql', 'APPLY-0189.sql', 'APPLY-0190.sql', 'APPLY-0192.sql', 'APPLY-0194.sql', 'APPLY-0195.sql',
    'APPLY-0196.sql', 'APPLY-0197.sql', 'APPLY-0198.sql', 'APPLY-0199.sql', 'APPLY-0200.sql', 'APPLY-0201.sql'];
  let at = -1; for (const f of order) { const i = rel.indexOf('RELEASE SECTION', at + 1); assert.ok(i > at, f); assert.ok(rel.slice(i, i + 120).includes(f), f + ' in order'); at = i; }
});
t('client-mailer: 0166 outbox gate, then 0179 trial_send_blocked, both before the send', () => {
  const cm = read('supabase/functions/client-mailer/index.ts');
  const a = cm.indexOf('await outboundBlocked(admin'), b = cm.indexOf('await trialSendBlocked(admin'), c = cm.indexOf('await sendMail(');
  assert.ok(a > 0 && b > a && c > b, 'gate order');
  assert.match(cm, /return json\(\{ status: "test_mode", masked, reason: TEST_MODE_TEXT \}\);/);
  assert.match(cm, /return json\(\{ status: "not_configured", trial: true,/);
});
t('menu package editor: Sample tag (0185) + trial edits price and catalog dishes, never Active', () => {
  const m = read('public/menu-pkg-editor.js');
  assert.match(m, /if \(t\.is_demo\) title\.appendChild\(el\("span", "hs-tag hs-solo", "Sample"\)\);/);
  assert.match(m, /if \(!trial && v\.on !== st\.base\.active\) patch\.active = v\.on;/);
  assert.match(m, /if \(trial\) \{ addNote\("In the free trial you can add dishes from your Dishes catalog only/);
  assert.match(m, /var dr = trial && same\(st\.dishes, st\.base\.dishes\) \? \{ ok: true \} : checkDishes\(st\.dishes, \{ active: on \}\);/);
});
console.log(`release-1018: ${n} passed`);
