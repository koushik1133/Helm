// r121-trial-edge-fixes.test.mjs - R121 (owner: free-trial edge cases):
//  1  A5 an invitation opened after the studio's free trial ended is PAUSED: 0329 wraps invitation_preview (trial_paused +
//     owner + sentence), accept_invitation (refused, hint trial_paused), invite_email_outbox_claim (no e-mail),
//     invite_open_for_email; invite-signup answers 409 trial_paused before any login / link; store-api peek + login.html
//     show the paused card (no create-account form)
//  2  B8 trial reminder + retention e-mails: studio_billing_email (current owner), never organizations.created_by
//  3  C18 client invitations refused in a trial (trigger a329_trial_client_invite, plain sentence)
//  4  HQ rename + business details need a fresh two-step code (_hq_fresh_code_action) - hq.js says so
//  5  bell kind plan_active ("Plan active"), muted separately from billing_trial
//  6  event.html: "Approval link ready (trial preview - not sent to the client)" in a trial; paid unchanged
//  7  trial.js: the dead post-trial teammate screen is gone
// Static + pure-function checks; the database side: tests/db/r121-trial-edge-0329.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0329_r121_trial_edge_fixes.sql'), AP = rd('supabase/APPLY-0329.sql');
const API = rd('public/store-api.js'), HQ = rd('public/hq.js'), MAN = rd('supabase/migrations/MANIFEST');
const LOGIN = rd('public/login.html'), EV = rd('public/event.html'), TJS = rd('public/trial.js');
const SIGN = rd('supabase/functions/invite-signup/index.ts'), RUN = rd('scripts/db-test/run-all.sh');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}

t('0329: MANIFEST + run-all + APPLY with begin/commit, the 0328 STOP guard and 12 VERIFY rows', () => {
  assert.match(MAN, /forward  supabase\/migrations\/0329_r121_trial_edge_fixes\.sql/);
  assert.match(RUN, /R121-TRIAL-EDGE-0329: ALL PASS \\\(36\/36\\\)/);
  assert.match(AP, /^begin;$/m); assert.match(AP, /^commit;$/m);
  assert.match(SQL, /STOP 0329: 0328 \(R120\) is not applied/);
  const rows = AP.slice(AP.indexOf('-- VERIFY')).match(/^\s+\('\d\d /gm) || [];
  assert.equal(rows.length, 12);
  assert.ok(AP.includes(SQL.trim()), 'APPLY carries the migration body unchanged');
});
t('0329: zero data loss - no drop table / delete / truncate / drop column; ASCII only', () => {
  for (const s of [SQL, AP]) {
    assert.ok(!/^\s*(drop\s+table|delete\s+from|truncate|alter\s+table[^;]*drop\s+column)/im.test(s));
    assert.ok(!/[^\x00-\x7f]/.test(s), 'ASCII only');
  }
});
t('0329: house wrapper pattern - nine bodies kept once as __pre0329 with no app privilege', () => {
  for (const f of ['invitation_preview', 'accept_invitation', 'invite_email_outbox_claim', 'invite_open_for_email',
    'trial_reminder_email_claim', 'trial_retention_email_claim', 'notification_catalog', 'notification_type_of', 'notify_default'])
    assert.ok(SQL.includes("('" + f + "', "), f);
  assert.match(SQL, /position\('r121-0329' in/);
  assert.match(SQL, /revoke all on function ' \|\| v_pre::text \|\| ' from service_role/);
});
t('A5: paused invitation - preview flag + sentence, accept refused, row untouched, no e-mail, no sign-up offer', () => {
  assert.match(SQL, /'trial_paused', true, 'owner_name'/);
  assert.match(SQL, /This studio''s free trial has ended\. Ask ' \|\| coalesce\(public\._r329_owner_name\(p_org\), 'the studio owner'\)/);
  assert.match(SQL, /hint = 'trial_paused'/);
  assert.ok(!/update public\.invitations/i.test(SQL), 'the invitation row is never changed');
  assert.match(SQL, /update public\.invite_email_outbox o set status = 'skipped'/);
  assert.match(SQL, /not public\._trial_locked\(i\.org_id\)/);
});
t('A5: invite-signup refuses every mode with 409 trial_paused BEFORE any login / link (asks invitation_preview)', () => {
  const i = SIGN.indexOf('const paused = await pausedOf(admin, token);');
  assert.ok(i > 0 && i < SIGN.indexOf('if (peek) {') && i < SIGN.indexOf('admin.auth.admin.createUser') && i < SIGN.indexOf('if (resend) {\n      const st'));
  assert.match(SIGN, /code: "trial_paused"/); assert.match(SIGN, /admin\.rpc\("invitation_preview"/);
});
t('A5: store-api peek + login.html show the paused card (no form, no resend button) and the accept refusal', () => {
  assert.match(API, /j\.code === "trial_paused"\)\s*\n\s*return \{ invalid: true, reason: "trial_ended"/);
  assert.match(LOGIN, /pre\.trial_paused===true\) INV=\{ valid:false, reason:"trial_ended"/);
  assert.match(LOGIN, /else if\(r==="trial_ended"\)\{ w\.textContent=[^;]*; b\.hidden=true; \}/);
  assert.match(LOGIN, /err\.hint==="trial_paused"/);
  assert.match(LOGIN, /if\(x&&x\.code==="trial_paused"\)\{ showErr\(\$\("#err"\),x\.message\); return "done"; \}/);
});
t('B8: trial reminder + retention e-mails go to studio_billing_email (current owner), not created_by', () => {
  for (const f of ['trial_reminder_email_claim', 'trial_retention_email_claim']) {
    const body = SQL.slice(SQL.indexOf('create or replace function public.' + f + '('));
    const fn = body.slice(0, body.indexOf('end $$;'));
    assert.match(fn, /v_to := public\.studio_billing_email\(r\.org_id\);/, f);
    assert.ok(!/created_by/.test(fn), f + ' no created_by');
  }
});
t('C18: client invitations refused in a trial, for app callers only, plain sentence', () => {
  assert.match(SQL, /create trigger a329_trial_client_invite before insert or update of role, status, org_id on public\.invitations/);
  assert.match(SQL, /if not public\._r282_api_caller\(\) then return new; end if;/);
  assert.match(SQL, /'Client invitations are switched off during the free trial - share the preview instead\.'/);
});
t('fresh code: rename + business details join Extend trial; hq.js says so and uses call() (asks + retries)', () => {
  assert.match(SQL, /in \('hq\.trial\.extend', 'hq\.studio\.identity', 'hq\.studio_account\.set'\)/);
  assert.match(HQ, /call\("hq_set_studio_identity"/); assert.match(HQ, /call\("hq_set_studio_account"/);
  assert.match(HQ, /Saving asks for a fresh two-step code \(like Extend trial\)\./);
  assert.match(HQ, /Asks for a fresh two-step code \(like Extend trial\)\./);
  assert.match(HQ, /if \(k === "reauth"\) return askCode\(\)/);
});
t('plan_active: own kind in SQL (catalog "Plan active", admin-only, 4 policies) and in the bell (type, label, href, mute name)', () => {
  assert.match(SQL, /"type":"plan_active","group":"Billing","label":"Plan active"/);
  assert.match(SQL, /values \(null, 'in_app', 'plan_active', 'simulated'/);
  assert.match(SQL, /n\.kind in \('plan_active', 'trial_reminder'\)/);
  for (const p of ['read', 'ins', 'upd', 'del']) assert.match(SQL, new RegExp('policy r329_plan_' + p));
  const ctx = vm.createContext({});
  vm.runInContext(fnSrc(API, 'bellTypeOf') + fnSrc(API, 'bellLabel') + ';this.X={bellTypeOf,bellLabel};', ctx);
  assert.equal(ctx.X.bellTypeOf({ kind: 'plan_active' }), 'plan_active');
  assert.equal(ctx.X.bellTypeOf({ kind: 'trial_reminder' }), 'billing_trial');
  assert.equal(ctx.X.bellLabel({ kind: 'plan_active', detail: { label: 'Your Studio plan is active - thank you.' } }).text, 'Your Studio plan is active - thank you.');
  assert.match(API, /plan_active: "Plan active"/);
  assert.match(API, /if \(k === "plan_active"\) return "checkout\.html";/);
});
t('event.html: trial approval card says "ready (trial preview - not sent to the client)"; paid text unchanged', () => {
  assert.match(EV, /trialNow\(\)\s*\n\s*\? 'Approval link ready \(trial preview - not sent to the client\)\./);
  assert.match(EV, /: 'Approval link sent — waiting for the client\. Record the advance once it arrives\.'\)/);
  assert.match(EV, /window\.addEventListener\("helm:trial",\(\)=>\{ try\{ if\(ev\) render\(\); \}catch\(_\)\{ \} \}\);/);
});
t('trial.js: the dead blocked-teammate screen is gone; stale comment fixed in store-api', () => {
  assert.ok(!/blockedSpec|renderBlocked|helmTrialBlocked|\.htb\{/.test(TJS));
  assert.ok(!/works for a member blocked after an unpaid trial ends/.test(API));
});
console.log(n + ' r121-trial-edge-fixes checks passed');
