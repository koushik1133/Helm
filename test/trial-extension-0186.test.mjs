// 0186: one free trial per studio / e-mail + one HQ-approved trial extension (1-7 days, reason required).
// Pure HQ arg builder is extracted from public/hq.js and run in a vm; static checks pin the HQ wiring,
// the friendly "already used" text (shown as-is by the sign-up page and /checkout) and the SQL hygiene.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok ' + n); } catch (e) { fail++; console.log('  FAIL ' + n); console.log(e.message); } };
const JS = read('public/hq.js'), HTML = read('public/hq.html'), API = read('public/store-api.js');
const MIG = read('supabase/migrations/0186_trial_one_per_email_extension.sql'), APPLY = read('supabase/APPLY-0186.sql');
function fn(name) {
  const i = JS.indexOf('  function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = JS.indexOf('\n  }\n', i);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(JS.slice(i, j + 4) + '\nthis.f = ' + name + ';', ctx);
  return ctx.f;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const ORG = 'a0000000-0000-4000-8000-000000000001';

t('HQ: extension args are validated (1-7 whole days, reason 5-500 chars, a studio id)', () => {
  const f = fn('trialExtendArgs');
  assert.deepEqual(plain(f(ORG, '7', '  customer   asked for\nmore time ')), { p_org: ORG, p_days: 7, p_reason: 'customer asked for more time' });
  assert.equal(f(ORG, 1, 'needs a week').p_days, 1);
  assert.throws(() => f(ORG, 0, 'needs a week'), /1 to 7/);
  assert.throws(() => f(ORG, 8, 'needs a week'), /1 to 7/);
  assert.throws(() => f(ORG, 2.5, 'needs a week'), /1 to 7/);
  assert.throws(() => f(ORG, 'x', 'needs a week'), /1 to 7/);
  assert.throws(() => f(ORG, 3, ' ok '), /reason/);
  assert.throws(() => f(ORG, 3, 'x'.repeat(501)), /500/);
  assert.throws(() => f('', 3, 'needs a week'), /studio/);
  assert.throws(() => f('not-a-uuid', 3, 'needs a week'), /studio/);
});
t('HQ: studio page reads hq_trial_info and grants through hq_extend_trial only (confirm first)', () => {
  assert.match(JS, /call\("hq_trial_info", \{ p_org: org \}\)/);
  assert.match(JS, /a = trialExtendArgs\(org, sel\.value, why\.value\)/);
  assert.match(JS, /window\.confirm\("Extend the free trial of "/);
  assert.match(JS, /call\("hq_extend_trial", a\)/);
  assert.match(JS, /loadTrialInfo\(org, d\.name, trialBox\)/);
  assert.match(JS, /Only one extension is allowed per studio\./);
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // the HQ call wrapper only lets hq_* names through - both new RPCs qualify
  assert.match(API, /hq: \(fn, args\) => \(\/\^hq_\[a-z_\]\+\$\/\.test\(fn\)/);
  assert.ok(/^hq_[a-z_]+$/.test('hq_trial_info') && /^hq_[a-z_]+$/.test('hq_extend_trial'));
});
t('HQ page loads the new hq.js (cache pin bumped), no inline handlers / styles', () => {
  assert.match(HTML, /<script src="hq\.js\?v=29"><\/script>/);
  assert.doesNotMatch(HTML, /\sstyle="/); assert.doesNotMatch(HTML, /\son[a-z]+="/i);
});
t('"already used" messages are friendly sentences the app shows as-is (login: friendlyError r9 rule; checkout: 160 chars)', () => {
  const tech = new RegExp(API.match(/var TECHNICAL = \/(.+)\/i;/)[1], 'i');
  const msgs = [...MIG.matchAll(/raise exception '([^']+)'\s*using errcode = '22023', hint = 'trial_used'/g)].map((m) => m[1]);
  assert.equal(msgs.length, 3, 'three entry points refuse with hint trial_used');
  for (const m of msgs) {
    assert.match(m, /^[A-Z][^]*[.!?]$/); assert.doesNotMatch(m, tech);
    assert.doesNotMatch(m, /permission denied|not authori[sz]ed|row-level security|insufficient privilege/i);
    assert.ok(m.length <= 160, 'fits the checkout message limit: ' + m.length);
    assert.match(m, /already used your free Helm trial/);
  }
});
t('0186 SQL: ASCII, additive, wrappers keep grants, old bodies not callable, in MANIFEST + run-all, APPLY = migration + VERIFY', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY), 'ASCII only');
  assert.ok(!/\b(drop table|drop column|delete from|truncate)\b/i.test(MIG.replace(/--.*/g, '')), 'no destructive statements');
  for (const f of ['start_self_serve_trial__pre0186(text, text, text, text)', 'my_pending_start_trial__pre0186()', 'my_start_trial__pre0186(text, text)'])
    assert.ok(MIG.includes('revoke all on function public.' + f + ' from public, anon, authenticated;'), f);
  assert.match(MIG, /grant execute on function public\.start_self_serve_trial\(text, text, text, text\) to authenticated, service_role;/);
  assert.match(MIG, /grant execute on function public\.my_pending_start_trial\(\) to authenticated;/);
  assert.match(MIG, /grant execute on function public\.my_start_trial\(text, text\) to authenticated;/);
  assert.match(MIG, /perform public\._hq_wgate\('hq\.trial\.extend'/);
  assert.match(MIG, /days\s+integer not null check \(days between 1 and 7\)/);
  assert.match(MIG, /org_id\s+uuid primary key,/);       // trial_extensions: one per studio, ever
  assert.match(MIG, /alter table public\.trial_grants enable row level security;/);
  assert.match(MIG, /alter table public\.trial_extensions enable row level security;/);
  assert.ok(!/create policy/i.test(MIG), 'no policies: only definer code reads the new tables');
  assert.ok(APPLY.includes(MIG)); assert.match(APPLY, /-- VERIFY/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0186_trial_one_per_email_extension\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-extension-0186" "TRIAL-EXTENSION-0186: ALL PASS \\\(55\/55\\\)"/);
});
if (fail) { console.log('trial-extension-0186: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-extension-0186: ok');
