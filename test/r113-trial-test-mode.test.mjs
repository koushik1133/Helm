// r113-trial-test-mode.test.mjs - R113 (owner decision, 0322): the client approval in a FREE TRIAL studio is a TEST.
// No code is ever sent (e-mail / WhatsApp / SMS); the approval page shows a "Test mode" banner, marks the terms as a
// trial preview and offers the test code 000000 + "Simulate approval" - ONLY for a trial studio. Paid: unchanged.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const TM = require('../public/approve-test-mode.js');
const NOTE = require('../public/trial-test-note.js');
const AP = read('public/approve.html'), API = read('public/store-api.js'), OTP = read('supabase/functions/send-otp/index.ts');
const SQL = read('supabase/migrations/0322_r113_trial_approval_test_mode.sql');

t('spec(): banner + terms preview + simulate ONLY for a trial studio; null for paid / unknown', () => {
  const s = TM.spec({ test_mode: true, can_approve: true, ended: false });
  assert.equal(s.banner, 'Test mode — this studio is on a Helm free trial. No code is sent. Use code 000000 to try the approval.');
  assert.equal(s.termsNote, 'This is a trial preview: nothing here is a binding booking, no payment is taken, and no messages are sent.');
  assert.equal(s.simulate, true); assert.equal(s.hideSend, true); assert.equal(s.ended, false);
  assert.equal(TM.spec({ test_mode: false, can_approve: false, ended: false }), null, 'paid studio: nothing');
  assert.equal(TM.spec(null), null); assert.equal(TM.spec(undefined), null); assert.equal(TM.spec(false), null);
  assert.equal(TM.spec({}), null); assert.equal(TM.spec('yes'), null);
  assert.equal(TM.spec(true).simulate, true, 'pre-0322 boolean answer (active trial) still shows test mode');
});
t('spec(): an ENDED trial still shows test mode (no code) but no Simulate button', () => {
  const s = TM.spec({ test_mode: true, can_approve: false, ended: true });
  assert.ok(s && s.banner && s.termsNote); assert.equal(s.simulate, false); assert.equal(s.ended, true); assert.match(s.endedText, /trial has ended/);
  assert.equal(TM.spec({ test_mode: true, can_approve: false, ended: false }).simulate, false, 'signed in to another studio');
});
t('checkCode(): only 000000 (spaces ignored); anything else -> friendly error', () => {
  assert.equal(TM.checkCode('000000'), null); assert.equal(TM.checkCode(' 000 000 '), null);
  assert.match(TM.checkCode('123456'), /not the test code.*000000/);
  assert.match(TM.checkCode(''), /Enter the test code 000000/); assert.match(TM.checkCode(null), /000000/);
  assert.match(TM.checkCode('00000'), /not the test code/);
});
t('approve.html: banner / terms note / code box + Simulate approval exist, hidden by default, wired to the module', () => {
  assert.match(AP, /<div id="testModeBanner" class="msg dev test-banner" role="status" hidden><\/div>/);
  assert.match(AP, /<p class="msg dev" id="termsTrialNote" hidden><\/p>\n\s*<div class="terms" id="terms"><\/div>/);
  assert.match(AP, /<div id="trialSkip" hidden>/);
  assert.match(AP, /<input id="t_code" maxlength="6" inputmode="numeric"/);
  assert.match(AP, /<button class="btn primary" id="trialSkipBtn" type="button">Simulate approval<\/button>/);
  assert.match(AP, /<script src="\/approve-test-mode\.js\?v=\d+"><\/script>/);
  assert.match(AP, /BPStore\.approval\.trialMode\(token\)/);
  assert.match(AP, /const tm=HelmApproveTestMode\.spec\(m\); if\(!tm\) return;/, 'nothing changes for a paid studio');
  assert.match(AP, /HelmApproveTestMode\.checkCode\(code\)/);
  assert.match(AP, /BPStore\.approval\.trialTestApproveCode\(token, code,/);
  assert.match(AP, /"Approved \(test mode\)"/);
  assert.ok(!/BPStore\.approval\.trialTestApprove\(/.test(AP), 'the page no longer confirms without the test code');
  // paid flow untouched: the real send buttons are still on the page
  for (const id of ['sendEmailOtp', 'sendWa', 'sendOtp', 'confirmBtn']) assert.match(AP, new RegExp('id="' + id + '"'));
});
t('approve-test-mode.js: DOM via textContent / hidden only (CSP + HTML-sink safe)', () => {
  const src = read('public/approve-test-mode.js');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src));
  assert.match(src, /\["#sendEmailOtp", "#sendWa", "#sendOtp", "#waNote"\]\.forEach\(hide\)/);
});
t('store-api: trialMode + trialTestApproveCode (falls back to the 0176 confirm only when 0322 is missing)', () => {
  assert.match(API, /trialMode: \(token\) => mode === "supabase" && token \? rpc\("public_trial_approval_mode", \{ p_token: token \}\)\.catch\(\(\) => null\)/);
  assert.match(API, /rpc\("trial_test_approve_code", \{ p_token: token, p_code: code,/);
  assert.match(API, /\.catch\(\(e\) => \{ if \(!isMissingFn\(e\)\) throw e;/);
});
t('send-otp: a free trial gets NO code on any channel (no trial_email_otp_begin), store refusal mapped; paid path intact', () => {
  assert.ok(!/admin\.rpc\("trial_email_otp_begin"/.test(OTP), '0212 trial e-mail code path removed');
  assert.match(OTP, /if \(await trialSendBlocked\(admin, \{ token \}\)\) return json\(\{ error: TRIAL_OTP_MSG, trial: true, test_mode: true \}, 403\);/);
  assert.equal((OTP.match(/trialSendBlocked\(admin, \{ token \}\)/g) || []).length, 2, 'channel + SMS paths');
  assert.equal((OTP.match(/if \(isTrialNoSend\(error\)\) return json\(\{ error: TRIAL_OTP_MSG/g) || []).length, 2, 'store refusal (0322 trigger) -> 403 trial');
  assert.match(OTP, /Use the test code 000000 on this page/);
  assert.match(OTP, /admin\.rpc\("wa_otp_begin", \{ p_token: token, p_channel: channel, p_user_agent: ua \}\)/);
  assert.match(OTP, /const res = await sendMail\(/);
  assert.match(OTP, /fetch\("https:\/\/control\.msg91\.com\/api\/v5\/flow\/"/);
});
t('studio side: share panel note + "Approved (test mode)" only for a trial studio', () => {
  assert.equal(NOTE.shareSpec({ is_trial_org: true }).note, 'Trial: your client sees a test-mode approval page (no code is sent).');
  assert.ok(NOTE.shareSpec({ is_trial_org: true, ended: true, locked: true }), 'ended trial too');
  assert.equal(NOTE.shareSpec({ is_trial_org: false }), null); assert.equal(NOTE.shareSpec(null), null);
  assert.equal(NOTE.approvedLabel('Approved ✓ on 30 Oct 2026', true), 'Approved (test mode) ✓ on 30 Oct 2026');
  assert.equal(NOTE.approvedLabel('Approved ✓', false), 'Approved ✓');
  assert.equal(NOTE.approvedLabel('Approved (test mode) ✓', true), 'Approved (test mode) ✓', 'never doubled');
  const FLOW = read('public/flow.html');
  assert.match(FLOW, /T\.approvedLabel\(txt, T\.approvalTestMode===true\)/);
  assert.match(FLOW, /window\.addEventListener\("helm:approval-test-mode"/);
  const BS = read('public/booklet-share.js');
  assert.match(BS, /const TRIAL_NOTE = "Trial: your client sees a test-mode approval page \(no code is sent\)\.";/);
  assert.match(BS, /t\.is_trial_org !== true/);
});
t('0322: listed, APPLY file carries it verbatim, DB suite in run-all; additive only', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0322_r113_trial_approval_test_mode\.sql\n/);
  assert.ok(existsSync(new URL('../supabase/APPLY-0322.sql', import.meta.url)));
  const apply = read('supabase/APPLY-0322.sql');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY/);
  assert.ok(apply.includes(SQL.trim()), 'APPLY carries the migration body unchanged');
  assert.match(read('scripts/db-test/run-all.sh'), /R113-TRIAL-TEST-MODE-0322: ALL PASS/);
  assert.ok(!/\b(delete from|truncate|drop table|drop policy|drop function|create policy|grant (insert|update|all) on)\b/i.test(SQL));
  assert.match(SQL, /add column if not exists test_mode boolean not null default false/);
  assert.match(SQL, /'approval\.test_mode'/);
  assert.match(SQL, /<> '000000'/);
  assert.ok(/^[\x00-\x7F]*$/.test(SQL), 'ASCII only');
});
console.log(`r113-trial-test-mode: ${n} passed`);
