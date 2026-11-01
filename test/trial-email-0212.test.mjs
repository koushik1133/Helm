// 0212 free-trial client e-mail (owner decision 2026-10-18): an ACTIVE trial really e-mails its clients (approval /
// booklet / invitation link, approval code by e-mail) under caps; WhatsApp / SMS / payment links stay off and their
// options are hidden in the trial UI; terms + trial facts say so (new terms version). Static + small runtime checks.
// Behaviour: tests/db/trial-email-0212.sql (local PG), tests/edge/trial-email.test.ts (Deno, mocked).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const ascii = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
const M = read('supabase/migrations/0212_trial_client_email.sql');
const A = read('supabase/APPLY-0212.sql');
const code = M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

await t('migration: ASCII, additive (no drop / truncate / delete / update of existing rows), idempotent guards', () => {
  assert.ok(ascii(M), 'ASCII');
  assert.doesNotMatch(code, /\b(drop\s+(table|function|column|policy|trigger|index)|truncate|delete\s+from)\b/i);
  assert.doesNotMatch(code, /^\s*update\s+public\./im, 'no row of an existing table is updated');
  assert.match(code, /create table if not exists public\.trial_email_settings/);
  assert.match(code, /create table if not exists public\.trial_email_sends/);
  assert.match(code, /insert into public\.trial_email_settings\(id\) values \(true\) on conflict \(id\) do nothing;/);
  assert.match(code, /recipient_hash text\s+not null check \(recipient_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/, 'only a fingerprint of the address');
  assert.match(code, /per_studio_day\s+integer\s+not null default 30/); assert.match(code, /per_recipient_day integer\s+not null default 5/);
});
await t('only an ACTIVE trial (switch on, not sample master) may e-mail; caps per studio and per address', () => {
  assert.match(code, /coalesce\(\(select s\.enabled from public\.trial_email_settings s where s\.id\), false\)\s*\n\s*and coalesce\(public\._trial_test_mode_ok\(p_org\), false\)/);
  assert.match(code, /not coalesce\(\(select o\.is_sample_master from public\.organizations o where o\.id = p_org\), false\)/);
  assert.match(code, /if v_n >= coalesce\(s\.per_studio_day, 30\) then return 'cap_studio'; end if;/);
  assert.match(code, /if v_n >= coalesce\(s\.per_recipient_day, 5\) then return 'cap_recipient'; end if;/);
  assert.match(code, /interval '24 hours'/);
  assert.match(code, /pg_advisory_xact_lock\(hashtextextended\('helm:trial-email:' \|\| p_org::text, 0\)\)/, 'caps race-safe per studio');
});
await t('outbox guard: only invitation / booklet link e-mails of an active trial stay pending; the mark cannot be forged', () => {
  const g = code.slice(code.indexOf('create or replace function public._ts166_tg_outbox_skip()'), code.indexOf('-- ---- 4)'));
  assert.match(g, /\(v_row -> 'payload'\) - 'trial_email'/, 'a caller-supplied mark is removed');
  assert.match(g, /tg_op = 'INSERT' and tg_table_name = 'comms_outbox'\s*\n\s*and v_row ->> 'channel' = 'email' and v_row ->> 'purpose' in \('invite_site', 'booklet_link'\)/);
  assert.match(g, /not coalesce\(\(select q\.is_demo from public\.quotes q/, 'demo events never');
  assert.match(g, /new\.status := 'skipped';/);
  assert.match(code, /insert into public\.tr212_saved_defs\(fn, def\) values \('public\._ts166_tg_outbox_skip\(\)'/, 'old body saved first');
  const c = code.slice(code.indexOf('create or replace function public._tr212_claim_blocked'), code.indexOf('-- ---- 3)'));
  assert.match(c, /p_channel = 'email' and p_purpose in \('invite_site', 'booklet_link'\)/);
  assert.match(c, /coalesce\(p_payload ->> 'trial_email', ''\) = 'true'/);
  assert.match(c, /public\._tr212_email_ok\(p_org\)/, 're-checked at claim time');
  assert.match(code, /c_old constant text := 'not public\._sample_outbound_blocked\(r\.org_id, r\.recipient\)';/);
  assert.match(code, /insert into public\.tr212_saved_defs\(fn, def\) values \(r\.sig, v_def\) on conflict \(fn\) do nothing;\s*\n\s*execute replace\(v_def, c_old, c_new\);/);
});
await t('wrappers keep the originals; WhatsApp / SMS / payment-link guards are not touched', () => {
  assert.match(code, /alter function public\.%I\(uuid, text, text, boolean, text\) rename to %I', f, f \|\| '__pre0212'/);
  assert.match(code, /return public\._tr212_send_answer\(public\.booklet_send__pre0212\(/);
  assert.match(code, /return public\._tr212_send_answer\(public\.event_site_send__pre0212\(/);
  for (const f of ['wa_otp_begin', 'otp_send_authorize', 'request_otp', 'whatsapp_authorize', 'wa_proposal_prepare', 'payment_link_begin', 'trial_send_blocked', '_sample_outbound_blocked'])
    assert.doesNotMatch(code, new RegExp('create or replace function public\\.' + f + '\\('), f + ' unchanged');
  const otp = code.slice(code.indexOf('create or replace function public.trial_email_otp_begin'), code.indexOf('-- ---- 8)'));
  assert.match(otp, /wa_otp_begin__pre0179\(p_token, 'email', p_user_agent\)/, 'e-mail channel only');
  assert.match(otp, /otp_send_authorize__pre0179\(p_token, v ->> 'phone_key'\)/, 'demo + studio daily cap checks kept');
  assert.match(otp, /errcode = 'HL429', hint = 'trial_email_cap'/);
});
await t('grants: gate + OTP begin service role only; my_trial_messaging for signed-in members; helpers internal', () => {
  assert.match(code, /grant execute on function public\.trial_email_gate\(uuid, uuid, uuid, text, text\) to service_role;/);
  assert.match(code, /grant execute on function public\.trial_email_otp_begin\(uuid, text\) to service_role;/);
  assert.match(code, /grant execute on function public\.my_trial_messaging\(\) to authenticated;/);
  assert.doesNotMatch(code, /grant execute on function public\.(trial_email_gate|trial_email_otp_begin|_tr212_take|_tr212_email_ok)[^;]*to (anon|authenticated)/);
});
await t('terms version: 0212 = public/trial-facts.js VERSION (0207 format); MANIFEST + suite + paste file', () => {
  const F = require('../public/trial-facts.js');
  // 0212 shipped 'trial-2026-10-19'; the CURRENT version (= trial-facts.js) is re-issued by the latest migration (0238)
  assert.match(code, /select 'trial-2026-10-19'::text;/);
  assert.match(read('supabase/migrations/0325_r117_trial_terms_proposal.sql'), new RegExp("select '" + F.VERSION + "'::text;"));   // R117: 0325 is the latest version
  assert.match(F.VERSION, /^trial-[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  assert.notEqual(F.VERSION, 'trial-2026-10-18', 'new wording = new version');
  const man = read('supabase/migrations/MANIFEST');
  { const ns = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);   // release/1019: 0210 / 0211 / 0213+ sit around it
    assert.ok(ns.indexOf('0212') > ns.indexOf('0211') && ns.indexOf('0212') < ns.indexOf('0236'), '0212 in numeric order'); assert.deepEqual(ns.filter((n) => +n > 205), [...ns.filter((n) => +n > 205)].sort()); }
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-email-0212" "TRIAL-EMAIL-0212: ALL PASS \\\(46\/46\\\)" psql -q -f tests\/db\/trial-email-0212\.sql/);
  assert.ok(ascii(A)); assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m); assert.match(A, /-- VERIFY/);
  assert.ok(A.includes(M.trim()), 'APPLY carries the migration unchanged');
  assert.doesNotMatch(A, /\bcreate\s+(temp|temporary)\s+table\b/i); assert.doesNotMatch(A, /^\s*\\/m);
  // older suites keep checking the "nothing sent" path with the 0212 switch off
  for (const f of ['tests/db/booklet-send-0200.sql', 'tests/db/invite-share-0195.sql'])
    assert.match(read(f), /update public\.trial_email_settings set enabled = false where id/, f);
  assert.match(read('tests/db/trial-retention-0184.sql'), /\\ir \.\.\/\.\.\/supabase\/migrations\/0212_trial_client_email\.sql/);
});
await t('edge functions: client-mailer + send-otp ask the 0212 gates; comms-dispatch re-checks trial rows', async () => {
  const cm = read('supabase/functions/client-mailer/index.ts'), so = read('supabase/functions/send-otp/index.ts');
  const cd = read('supabase/functions/comms-dispatch/index.ts'), tg = read('supabase/functions/_shared/trial-guard.ts');
  assert.match(cm, /const g = await trialEmailGate\(admin, \{ org: String\(q\.org_id \|\| ""\) \|\| null, quote: quoteId \}, to, logKind\);/);
  assert.match(cm, /const gate = g \? \{ blocked: false, unknown: false \} : await outboundBlocked\(/, 'pre-0212 gates when the gate gives no answer');
  assert.match(cm, /if \(!g && await trialSendBlocked\(/);
  assert.match(tg, /admin\.rpc\("trial_email_gate"/);
  assert.match(tg, /if \(error \|\| !data \|\| typeof data !== "object" \|\| typeof data\.allowed !== "boolean"\) return null;/);
  // R113 (0322): send-otp no longer e-mails a code in a trial (test mode, code 000000) - every channel refused
  assert.match(so, /if \(await trialSendBlocked\(admin, \{ token \}\)\) return json\(\{ error: TRIAL_OTP_MSG, trial: true, test_mode: true \}, 403\);/);
  assert.doesNotMatch(so, /admin\.rpc\("trial_email_otp_begin"/);
  assert.match(cd, /import \{ trialRowAllowed \} from "\.\/trial-row\.mjs";/);
  assert.match(cd, /if \(!trialRowAllowed\(purpose, channel, payload\)\) res = "skipped";/);
  const { trialRowAllowed } = await import('../supabase/functions/comms-dispatch/trial-row.mjs');
  assert.equal(trialRowAllowed('booklet_link', 'email', { trial_email: true }), true);
  assert.equal(trialRowAllowed('invite_site', 'whatsapp', { trial_email: true }), false);
  assert.equal(trialRowAllowed('pay_reminder', 'email', { trial_email: true }), false);
  assert.equal(trialRowAllowed('pay_reminder', 'email', { text: 'x' }), true);
});
await t('UI: R114 - any trial is a simulation (preview, nothing sent), WhatsApp / SMS options hidden', () => {
  // email-send.js: my_trial_messaging -> test mode only when e-mail does not reach clients
  const src = read('public/email-send.js'); const ctx = { window: {}, document: {} }; vm.runInNewContext(src, ctx);
  const E = ctx.window.HelmEmailSend;
  assert.equal(E.trialState(null), null, 'before 0212: older rule');
  assert.deepEqual(JSON.parse(JSON.stringify(E.trialState({ trial: false, email: true }))), { testMode: false, note: '' });
  // R114 (0323): ANY free trial is a simulation - even an older database that still says email:true
  const s = E.trialState({ trial: true, email: true, email_per_day: 30 });
  assert.equal(s.testMode, true);
  assert.equal(E.trialState({ trial: true, email: false }).testMode, true, 'ended trial / switch off: test mode');
  assert.match(E.resultText({ status: 'limit', reason: 'Free trial e-mail limit reached' }), /^Not sent: Free trial e-mail limit/);
  assert.match(E.resultText({ status: 'demo' }), /sample \(demo\) event/);
  // invitation / booklet send box
  const is = read('public/invite-site-share.js');
  assert.match(is, /radioLabs\.whatsapp\.hidden = trialEmail && !isTrial;/);
  assert.match(is, /if \(st === "skipped" && r\.reason === "trial_email_cap"\) return TRIAL_CAP;/);
  assert.match(is, /trialEmail = false;\n\s*isTrial = m\.trial === true;/);   // R114: any trial = simulation
  // proposal WhatsApp box hidden in the trial
  assert.match(read('public/wa-proposal.js'), /box\.hidden = isTrial === true;/);
  // client approval page - R113 (0322): in the trial NO code is sent (no e-mail / SMS / WhatsApp buttons); test mode with
  // the test code 000000 + "Simulate approval" (approve-test-mode.js)
  const ap = read('public/approve.html'), tm = read('public/approve-test-mode.js');
  assert.match(tm, /\["#sendEmailOtp", "#sendWa", "#sendOtp", "#waNote"\]\.forEach\(hide\)/);
  assert.match(ap, /id="trialSkipBtn" type="button">Simulate approval<\/button>/);
  assert.match(ap, /No code is sent to you; use the test code 000000\./);
  // store: my_trial_messaging, signed-in only, null on error
  assert.match(read('public/store-api.js'), /messaging: \(\) => \(supa \? trialSignedIn\(\)\.then\(\(ok\) => \(ok \? rpc\("my_trial_messaging"\)\.catch\(\(\) => null\) : null\)\) : Promise\.resolve\(null\)\),/);
});
await t('copy: trial facts, terms, landing FAQ and checklist say e-mail works, WhatsApp / SMS unlock on a plan', () => {
  const F = require('../public/trial-facts.js');
  const all = JSON.stringify([F.SECTIONS, F.NOTICE, F.SIGNUP_KEY, F.SIGNUP_ALL]);
  assert.doesNotMatch(all, /no real e-mails|Real messages to clients|nothing is sent to anyone/);
  assert.match(all, /Try sending to clients \(simulation\)/); assert.match(all, /WhatsApp, SMS and online payment links/);   // R117 (0325): the trial is a simulation
  assert.equal(F.EMAIL_PER_DAY, 30); assert.equal(F.EMAIL_PER_RECIPIENT, 5);
  const terms = read('public/terms.html');
  assert.doesNotMatch(terms, /no real e-mails, WhatsApp or SMS messages are sent/);
  assert.match(terms, /<b>Client messages:<\/b> the trial is a simulation/);   // R117 (0325)
  const idx = read('public/index.html');
  assert.equal((idx.match(/sending to your clients is a simulation \(previews and the test code 000000; real e-mail, WhatsApp and SMS unlock on a paid plan\)/g) || []).length, 2, 'FAQ + JSON-LD (R117)');
  assert.doesNotMatch(idx, /messages to clients stay in test mode/);
  assert.doesNotMatch(read('public/getting-started.js'), /Send a quote in test mode/);
});

console.log('trial-email-0212: ' + n + ' passed');
