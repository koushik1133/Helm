// r120-hq-notify-trial-wording.test.mjs - R120 (owner):
//  1  HQ "Activate plan" tells the studio: 0328 wraps hq_activate_plan (house pattern, __pre0328 no privilege), one
//     admin-only bell row + one helm_notice_outbox 'plan_active' e-mail per plan period (dedupe), recipients resolved in
//     the claim (_r120_plan_mail: owner + admins, not unsubscribed), never blocks the activation; comms-dispatch template
//     (helm-notices.mjs) incl. the trial wording (test mode off + sample-data choice); /hq says the studio was told
//  2  HQ "Extend trial" needs a fresh two-step code: _hq_wgate wrapped, _hq_fresh_code_action lists hq.trial.extend only;
//     /hq call() answers HQ_REAUTH by asking for the code
//  3  event activity in a free trial: event_activity marks trial previews (trial_preview); activityText words them with
//     the bell's own label function (bellLabel) - "Approval link ready (trial preview — not sent)"; paid unchanged
// Static + pure-function checks; the database side: tests/db/r120-hq-notify-0328.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { helmNoticeEmail, NOTICE_KINDS, NOTICE_TX_REASON } from '../supabase/functions/comms-dispatch/helm-notices.mjs';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0328_r120_hq_notify_trial_wording.sql'), AP = rd('supabase/APPLY-0328.sql');
const API = rd('public/store-api.js'), HQ = rd('public/hq.js'), MAN = rd('supabase/migrations/MANIFEST');
const RUN = rd('scripts/db-test/run-all.sh');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const ctx = vm.createContext({});
vm.runInContext(['auditHuman', 'auditEventText', 'auditDescribe', 'bellLabel', 'activityText'].map((f) => fnSrc(API, f)).join('\n')
  + '\nthis.X = { auditDescribe, bellLabel, activityText };', ctx);
const X = ctx.X;

t('1a SQL 0328: ASCII, preflight STOPs, house wrapper for the three functions (kept once, no privilege)', () => {
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'migration must be ASCII');
  assert.ok(!/[^\x00-\x7f]/.test(AP), 'paste file must be ASCII');
  assert.match(SQL, /raise exception 'STOP 0328: hq_activate_plan \(0244 \/ 0287\) is missing'/);
  assert.match(SQL, /\('hq_activate_plan', 'uuid,text,text,numeric,text,date,date,text,text,numeric'\),\n      \('_hq_wgate', 'text,text,text,jsonb'\),\n      \('event_activity', 'uuid'\)\)/);
  assert.match(SQL, /position\('r120-0328' in coalesce\(\(select p\.prosrc from pg_proc p where p\.oid = v_pub\), ''\)\) = 0 then\n      execute format\('alter function public\.%I\(%s\) rename to %I'/);
  for (const r of ['public', 'anon', 'authenticated', 'service_role']) assert.ok(SQL.includes("|| v_pre::text || ' from " + r + "'"), r);
  // no destructive statements
  assert.ok(!/\b(drop table|drop column|truncate|delete from)\b/i.test(SQL.replace(/^--.*$/gm, '')), 'no destructive SQL');
});
t('1b SQL 0328: hq_activate_plan = kept body + studio notice that never blocks the activation', () => {
  const f = SQL.slice(SQL.indexOf('create or replace function public.hq_activate_plan('), SQL.indexOf('-- the e-mail data + recipients'));
  assert.match(f, /v := public\.hq_activate_plan__pre0328\(p_org, p_plan_code, p_interval, p_amount, p_method, p_period_start, p_paid_on,/);
  assert.match(f, /begin\n    v_n := public\._r120_plan_active_notice\(p_org, v_was_trial, v\);\n  exception when others then/);
  assert.match(f, /return coalesce\(v, '\{\}'::jsonb\) \|\| jsonb_build_object\('studio_notice', v_n\);/);
  const nf = SQL.slice(SQL.indexOf('create or replace function public._r120_plan_active_notice('), SQL.indexOf('-- HQ "Activate plan": the kept body'));
  assert.match(nf, /coalesce\(p_res ->> 'result', ''\) <> 'activated'\n     or coalesce\(p_res -> 'activation' ->> 'result', ''\) <> 'activated'/);
  assert.match(nf, /'in_app', 'trial_reminder', 'simulated'/);
  assert.match(nf, /'source', 'r120_plan_active'/);
  assert.match(nf, /v_key := 'plan_active:' \|\| p_org::text \|\| ':' \|\| s\.current_period_start::text \|\| ':' \|\| s\.current_period_end::text;/);
  assert.match(nf, /on conflict \(dedupe_key\) do nothing/);
  assert.ok(!/amount/.test(nf), 'the notice never carries the amount');
});
t('1c SQL 0328: outbox kind widened to a superset, one claim branch, recipients from _r285_admins (not opted out)', () => {
  assert.match(SQL, /if position\('''plan_active''' in v_def\) > 0 then return; end if;/);
  assert.match(SQL, /unnest\(v_kinds \|\| array\['plan_active'\]\)/);
  assert.match(SQL, /if position\('r120-plan-0328' in v_def\) > 0 then return; end if;/);
  assert.match(SQL, /v_data := public\._r120_plan_mail\(r\.org_id, r\.payload\);/);
  const m = SQL.slice(SQL.indexOf('create or replace function public._r120_plan_mail('), SQL.indexOf('-- outbox kind'));
  assert.match(m, /where p\.id in \(select a from public\._r285_admins\(p_org\) a\)/);
  assert.match(m, /not public\.email_is_opted_out\(null, p\.email\)/);
  assert.match(m, /coalesce\(o\.is_sample_master, false\) then return null/);
});
t('1d e-mail template plan_active: trial (choice pending + sample), choices, paid, refusals', () => {
  assert.ok(NOTICE_KINDS.includes('plan_active') && NOTICE_TX_REASON.plan_active);
  const base = { studio: 'Aurora Events', plan: 'Studio', interval: 'yearly', period_start: '2026-11-01', period_end: '2027-10-31', renews_on: '2027-11-01' };
  const tr = helmNoticeEmail('plan_active', { ...base, was_trial: true, choice: null, has_sample: true }, 'https://app.example.test/');
  assert.equal(tr.subject, 'Your Helm Studio plan is active - thank you');
  assert.match(tr.text, /Thank you - the Studio plan for Aurora Events is now active\./);
  assert.match(tr.text, /Billing: {7}Yearly/);
  assert.match(tr.text, /Paid period: {3}1 Nov 2026 - 31 Oct 2027/);
  assert.match(tr.text, /Next renewal: {2}1 Nov 2027/);
  assert.match(tr.text, /test mode: from now on Helm really sends e-mails/);
  assert.match(tr.text, /The sample data from the trial is still in your studio\. The next time an admin opens the dashboard, Helm asks once/);
  assert.match(tr.text, /https:\/\/app\.example\.test\/dashboard/);
  assert.match(tr.text, /Plan and billing: https:\/\/app\.example\.test\/checkout/);
  assert.match(helmNoticeEmail('plan_active', { ...base, was_trial: true, choice: 'keep' }, '').text, /You chose to keep the sample data/);
  assert.match(helmNoticeEmail('plan_active', { ...base, was_trial: true, choice: 'remove_sample' }, '').text, /You chose to remove the sample data/);
  assert.match(helmNoticeEmail('plan_active', { ...base, was_trial: true, choice: 'clean' }, '').text, /archived, not deleted/);
  const paid = helmNoticeEmail('plan_active', { ...base, interval: 'monthly', was_trial: false, has_sample: true }, '');
  assert.match(paid.text, /Billing: {7}Monthly/);
  assert.ok(!/trial|sample/i.test(paid.text), 'paid studio: no trial / sample wording');
  assert.equal(helmNoticeEmail('plan_active', { ...base, plan: '' }, ''), null);
  assert.equal(helmNoticeEmail('plan_active', { ...base, renews_on: 'soon' }, ''), null);
  assert.equal(helmNoticeEmail('plan_active', { ...base, interval: 'weekly' }, ''), null);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(tr.text));
});
t('1e bell: the plan-active notice reads its label with a celebration icon and opens the plan page', () => {
  const b = X.bellLabel({ kind: 'trial_reminder', detail: { source: 'r120_plan_active', label: 'Your Studio plan is active - thank you. Billing: yearly, next renewal 1 Nov 2027.' } });
  assert.equal(b.icon, '🎉'); assert.match(b.text, /^Your Studio plan is active - thank you/);
  assert.equal(X.bellLabel({ kind: 'trial_reminder', detail: {} }).text, 'Free trial update');
  assert.match(API, /if \(k === "trial_reminder"\) return "checkout\.html";/);
});
t('1f /hq: the Activate plan message says the studio was told', () => {
  assert.match(HQ, /var told = r && r\.studio_notice && r\.studio_notice\.queued === true;/);
  assert.match(HQ, /The studio's admins got a bell notice and an e-mail\./);
});
t('2a SQL 0328: _hq_wgate = kept 0277 gate + a fresh code for the listed actions (hq.trial.extend only)', () => {
  assert.match(SQL, /select coalesce\(p_action, ''\) in \('hq\.trial\.extend'\);/);
  const g = SQL.slice(SQL.indexOf('create or replace function public._hq_wgate('), SQL.indexOf('-- ---- 4)'));
  assert.match(g, /perform public\._hq_wgate__pre0328\(p_action, p_entity, p_entity_id, p_changed\);/);
  assert.match(g, /v_mfa < now\(\) - make_interval\(mins => coalesce\(v_min, 15\)\)/);
  assert.match(g, /'not authorized: HQ_REAUTH enter a fresh two-step code to confirm this change' using errcode = '42501'/);
});
t('2b /hq: Extend trial goes through call(), which asks for the code on HQ_REAUTH and retries', () => {
  assert.match(HQ, /if \(k === "reauth"\) return askCode\(\)\.then\(function \(\) \{ return BPStore\.hq\(fn, args\); \}\);/);
  assert.match(HQ, /call\("hq_extend_trial", a\)/);
});
t('3a SQL 0328: event_activity marks only trial previews of this event / studio', () => {
  const e = SQL.slice(SQL.indexOf('create or replace function public.event_activity('), SQL.indexOf('-- ---- 5)'));
  assert.match(e, /v := public\.event_activity__pre0328\(p_quote\);/);
  assert.match(e, /n\.detail ->> 'suppressed_by' in \('trial_simulation', 'trial'\) or n\.detail ->> 'skipped' = 'free_trial'/);
  assert.match(e, /n\.quote_id = p_quote and n\.org_id = v_org/);
  assert.match(e, /then e\.i \|\| jsonb_build_object\('trial_preview', true\)/);
});
t('3b activityText: a trial preview reads like the bell; a real send / paid studio unchanged; server arrow "->" understood', () => {
  const c = { clientName: 'Priya' };
  assert.equal(X.activityText({ kind: 'notify', text: 'approval_link -> p@x.in', trial_preview: true }, c), 'Approval link ready (trial preview — not sent)');
  assert.equal(X.activityText({ kind: 'notify', text: 'booklet_link -> p@x.in', trial_preview: true }, c), 'Booklet link ready (trial preview — not sent)');
  assert.equal(X.activityText({ kind: 'notify', text: 'invite_site_link -> p@x.in', trial_preview: true }, c), 'Invitation link ready (trial preview — not sent)');
  assert.equal(X.activityText({ kind: 'notify', text: 'approval_link -> p@x.in' }, c), 'Approval link sent to Priya (p@x.in) by e-mail');
  assert.equal(X.activityText({ kind: 'notify', text: 'approval_link → email' }, c), 'Approval link sent to Priya by e-mail');
  // the same words as the bell / inbox (one label function)
  assert.equal(X.bellLabel({ kind: 'approval_link', detail: { suppressed_by: 'trial_simulation' } }).text, 'Approval link ready (trial preview — not sent)');
  assert.match(fnSrc(API, 'activityText'), /return bellLabel\(\{ kind: kind, status: "simulated", detail: \{ suppressed_by: "trial_simulation" \} \}\)\.text;/);
});
t('3c activity log (Settings -> Activity): free-trial link lines read "ready (trial preview — not sent)"', () => {
  assert.equal(X.auditDescribe({ action: 'booklet.link_sent', changed: { status: 'skipped', reason: 'free_trial', to: 'p@x.in' } }, {}),
    'Booklet link ready (trial preview — not sent)');
  assert.equal(X.auditDescribe({ action: 'event_site.link_sent', changed: { status: 'skipped', reason: 'free_trial' } }, {}),
    'Invitation link ready (trial preview — not sent)');
  assert.equal(X.auditDescribe({ action: 'booklet.link_sent', changed: { status: 'sent', channel: 'email' } }, {}), 'Booklet link sent by email');
  assert.equal(X.auditDescribe({ action: 'booklet.link_sent', changed: { status: 'skipped', reason: 'demo' } }, {}), 'Booklet link not sent (demo event)');
});
t('4 paste file, MANIFEST, DB suite wired', () => {
  assert.ok(AP.includes(SQL), 'APPLY-0328.sql carries the migration verbatim');
  assert.match(AP, /^begin;$/m); assert.match(AP, /^commit;$/m);
  assert.match(AP, /select item, ok from \(values/);
  assert.equal((AP.match(/^  \('\d\d /gm) || []).length, 10);
  assert.ok(!/\\ir|\\set|create temp table/i.test(AP), 'pasteable (no psql meta / temp table)');
  assert.match(MAN, /\nforward  supabase\/migrations\/0328_r120_hq_notify_trial_wording\.sql\n/);
  assert.match(RUN, /run "r120-hq-notify-0328" "R120-HQ-NOTIFY-0328: ALL PASS \\\(23\/23\\\)" psql -q -f tests\/db\/r120-hq-notify-0328\.sql/);
});

if (process.exitCode) { console.log('r120-hq-notify-trial-wording: FAILED'); process.exit(1); }
console.log(`r120-hq-notify-trial-wording: ALL PASS (${n})`);
