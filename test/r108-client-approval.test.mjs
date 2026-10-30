// r108-client-approval.test.mjs - R108 (owner, live client approval page):
//   * consent clause is channel-neutral ("the one-time code we sent you"), terms id bumped to v2-2026-10;
//   * a quote with no price shows "Quote not priced yet - please contact <Studio>" instead of the Approve steps,
//     the grand total says "Not priced yet", send-otp sends no code for it, the database refuses its approval (0318);
//   * a failed code send is always said out loud ("We couldn't send the code. Try again in a minute or contact <Studio>.");
//   * WhatsApp / SMS buttons are left as they are (owner: set up later).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AP = read('public/approve.html'), API = read('public/store-api.js'), OTP = read('supabase/functions/send-otp/index.ts');
const MIG = read('supabase/migrations/0318_r108_unpriced_approval.sql'), APPLY = read('supabase/APPLY-0318.sql');
const MAN = read('supabase/migrations/MANIFEST'), RUN = read('scripts/db-test/run-all.sh');
const tests = []; const t = (n, f) => tests.push([n, f]);

// the page helpers, evaluated (terms block .. setMsg)
const s = AP.indexOf('  const TERMS_VERSION='), e = AP.indexOf('\n  function setMsg(', s);
function page(studio) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { hidden: true, textContent: '' });
  const ctx = { $: (q) => el(q), window: { HELM_IS_PROD_HOST: true }, els };
  vm.createContext(ctx);
  vm.runInContext(AP.slice(s, e) + `\napStudio=${JSON.stringify(studio || '')};\nthis.P={isPriced,showNotPriced,sendFail,contactWho,AP_PROD,TERMS_BY_COUNTRY};`, ctx);
  return ctx;
}

t('consent clause is channel-neutral in every country; v1 "OTP sent to your mobile" wording gone', () => {
  const { P } = page();
  assert.ok(!/<p>By verifying the OTP sent to your mobile/.test(AP));
  for (const c of ['IN', 'AE', 'US']) {
    assert.match(P.TERMS_BY_COUNTRY[c].html, /By verifying the one-time code we sent you and accepting these terms/);
    assert.match(P.TERMS_BY_COUNTRY[c].v, /^v2-2026-10/);
  }
});
t('isPriced: total above zero only', () => {
  const { P } = page();
  for (const p of [null, {}, { total: 0 }, { total: '0' }, { total: -5 }, { total: 'abc' }]) assert.equal(P.isPriced(p), false, JSON.stringify(p));
  for (const p of [{ total: 236000 }, { total: '1180.5' }]) assert.equal(P.isPriced(p), true);
});
t('showNotPriced hides the approval steps and names the studio', () => {
  const ctx = page('SparkV'); ctx.els['#step1'] = { hidden: false }; ctx.els['#step2'] = { hidden: false };
  ctx.P.showNotPriced();
  assert.equal(ctx.els['#step1'].hidden, true); assert.equal(ctx.els['#step2'].hidden, true);
  assert.equal(ctx.els['#notPriced'].hidden, false);
  assert.match(ctx.els['#notPricedText'].textContent, /isn't ready yet - it has no price\. Please contact SparkV;/);
  const c2 = page(''); c2.P.showNotPriced(); assert.match(c2.els['#notPricedText'].textContent, /Please contact your planner;/);
});
t('sendFail: never silent - generic failure names the studio; server sentences kept; link problems explained', () => {
  const { P } = page('SparkV');
  assert.equal(P.sendFail(new Error('e-mail could not be sent')), "We couldn't send the code. Try again in a minute or contact SparkV.");
  assert.equal(P.sendFail(new Error('HTTP 502')), "We couldn't send the code. Try again in a minute or contact SparkV.");
  assert.equal(P.sendFail(null), "We couldn't send the code. Try again in a minute or contact SparkV.");
  assert.equal(P.sendFail(new Error('too many requests — please try again later')), 'Too many requests — please try again later.');
  assert.equal(P.sendFail(new Error("This quote isn't ready yet - please contact SparkV.")), "This quote isn't ready yet - please contact SparkV.");
  assert.match(P.sendFail(new Error('your planner has not saved your mobile number and e-mail address on file yet - please contact your planner')), /^Your planner has not saved/);
  assert.equal(P.sendFail(new Error('invalid link')), 'This approval link is no longer valid. Please contact SparkV for a new one.');
  assert.equal(page().P.AP_PROD, true);
});
t('page wiring: not-priced card, grand total, server check, failures visible, buttons kept', () => {
  assert.match(AP, /<div id="notPriced" hidden>/);
  assert.match(AP, /<span class="amt">Not priced yet<\/span>/);
  assert.match(AP, /if\(apOpen && !isPriced\(quote\.pricing\)\) showNotPriced\(\);/);
  assert.match(AP, /BPStore\.approval\.quoteReady\(token\)\.then/);
  assert.match(AP, /if\(AP_PROD && r && r\.simulated && !r\.dev_code\)\{ setMsg\("err","We couldn't send the code/);
  assert.match(AP, /\}catch\(e\)\{ setMsg\("err",sendFail\(e\)\);/);
  assert.match(AP, /e\.hint==="quote_not_priced"\) showNotPriced\(\)/);
  for (const id of ['sendEmailOtp', 'sendWa', 'sendOtp', 'c_phone']) assert.match(AP, new RegExp(`id="${id}"`), id);   // owner: kept
  assert.ok(!/style="/.test(AP.slice(AP.indexOf('id="notPriced"'), AP.indexOf('id="step2"'))), 'no inline style (CSP)');
  assert.match(API, /quoteReady: \(token\) => mode === "supabase" && token \? rpc\("public_quote_ready", \{ p_token: token \}\)\.catch\(\(\) => null\)/);
});
t('send-otp: no code for an unpriced quote (before anything is stored), on every channel; e-mail path otherwise unchanged', () => {
  assert.match(OTP, /rpc\("public_quote_ready", \{ p_token: token \}\)/);
  const iFn = OTP.indexOf('async function sendByChannel'), iNp = OTP.indexOf('notPricedMsg(admin, token)', iFn), iStore = OTP.indexOf('rpc("admin_store_otp"', iFn);
  assert.ok(iNp > iFn && iNp < iStore, 'checked before a code is stored (e-mail / WhatsApp)');
  const iSms = OTP.indexOf('const npS = await notPricedMsg(admin, token)'), iSmsStore = OTP.indexOf('rpc("admin_store_otp", { p_token: token, p_phone: phone');
  assert.ok(iSms > 0 && iSms < iSmsStore, 'checked before a code is stored (SMS)');
  assert.match(OTP, /return json\(\{ error: np, not_priced: true \}, 409\)/);
  assert.match(OTP, /const res = await sendMail\(\{ to: String\(dest\.email\), subject: m\.subject, html: m\.html, text: m\.text, studio, replyTo, txReason: "otp" \}\);/);
  assert.match(OTP, /default: return \[400, channel === "sms" \? "could not send the SMS — please try again later" : "could not send the code — please try again in a minute"\]/);
  assert.doesNotMatch(OTP, /op === "channels"/);
});
t('0318: trigger + RPC, additive, friendly HL409, no wrappers re-issued; listed + APPLY + DB suite', () => {
  assert.match(MIG, /create trigger zz_r318_consent_priced before insert on public\.quote_consents/);
  assert.match(MIG, /using errcode = 'HL409', hint = 'quote_not_priced'/);
  assert.match(MIG, /'priced', public\._r318_quote_priced\(v_pricing\), 'studio'/);
  assert.doesNotMatch(MIG, /\b(drop table|drop column|delete from|truncate|alter table)\b/i);
  assert.ok(!/function public\.(verify_and_consent|wa_verify_and_consent|trial_test_approve)\b/.test(MIG), 'approval functions not re-wrapped');
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY), 'ascii');
  assert.ok(APPLY.includes(MIG), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.equal((APPLY.match(/^\s+\('0\d /gm) || []).length, 4);
  assert.match(MAN, /^forward  supabase\/migrations\/0318_r108_unpriced_approval\.sql$/m);
  assert.match(RUN, /R108-UNPRICED-APPROVAL-0318: ALL PASS \\\(13\/13\\\)/);
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ' + n); } catch (err) { fail++; console.log('  FAIL ' + n + '\n       ' + err.message); } }
console.log(fail ? `r108-client-approval: ${fail} FAILED` : `r108-client-approval: all ${tests.length} passed`);
process.exit(fail ? 1 : 0);
