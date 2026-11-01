// r114-trial-simulation.test.mjs - R114 (owner decision 2026-10-31, database 0323): a FREE TRIAL studio is a full
// SIMULATION. Nothing real leaves Helm to a client (no e-mail / WhatsApp / SMS / OTP / payment link); the owner sees
// previews under a red "Trial simulation" banner; the client page offers "Simulate payment" (a TEST row only).
// Paid studios: unchanged. Static + pure-function checks (the database behaviour: tests/db/r114-trial-sim-0323.sql).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const TS = require('../public/trial-sim.js');
const SQL = read('supabase/migrations/0323_r114_trial_simulation.sql');
const APPLY = read('supabase/APPLY-0323.sql');
const AP = read('public/approve.html'), API = read('public/store-api.js'), CM = read('supabase/functions/client-mailer/index.ts');

t('banner text: one consistent red disclaimer (nothing sent, no real payment)', () => {
  assert.equal(TS.TITLE, 'Trial simulation');
  assert.match(TS.BANNER, /^Nothing is sent to your client, and no real payment is taken\./);
  assert.match(TS.PREVIEW_TITLE, /This is what your client would receive - not sent \(trial simulation\)/);
  const css = read('public/trial-sim.css');
  assert.match(css, /\.trial-sim-banner\{[^}]*background:#fdecec;color:#9b1c1c/);
});
t('payStep(): only for a trial answer; never more than amount + label; paid studio / unknown -> null', () => {
  assert.equal(TS.payStep(null), null); assert.equal(TS.payStep({ simulation: false }), null); assert.equal(TS.payStep('x'), null);
  const s = TS.payStep({ simulation: true, approved: true, can_pay: true, amount: 41772, currency: 'INR', label: 'Advance (30%)', paid: false });
  assert.equal(s.canPay, true); assert.equal(s.approved, true); assert.equal(s.label, 'Advance (30%)');
  assert.match(s.amountText, /41,772/); assert.match(s.next, /^Next step \(simulated\): your client would now pay/);
  assert.match(s.next, /no link is created and no money moves/);
  const e = TS.payStep({ simulation: true, approved: true, can_pay: false, ended: true, amount: 0 });
  assert.equal(e.canPay, false); assert.equal(e.ended, true); assert.equal(e.amountText, ''); assert.match(e.endedText, /trial has ended/);
});
t('payResult(): TEST receipt wording; already; refusal message passed through', () => {
  const ok = TS.payResult({ simulated: true, amount: 1000, currency: 'INR', receipt: 'TEST-ABCD1234', more_due: true });
  assert.equal(ok.ok, true); assert.equal(ok.more, true); assert.match(ok.text, /recorded as a TEST \(receipt TEST-ABCD1234\)\. No real money moved\./);
  assert.equal(TS.payResult({ simulated: true, already: true, message: 'Every payment on this quote has already been simulated.' }).ok, true);
  const no = TS.payResult({ simulated: false, error: 'trial_only', message: 'Simulated payments are only for studios on a Helm free trial' });
  assert.equal(no.ok, false); assert.match(no.text, /only for studios on a Helm free trial/);
  assert.equal(TS.payResult(null).ok, false);
});
t('refFrom(): approval token / booklet token / invitation slug from the page URL; anything odd -> ""', () => {
  const tok = 'b0000000-0000-4000-8000-0000000000bb';
  assert.equal(TS.refFrom('quote', { pathname: '/approve.html', search: '?token=' + tok }), tok);
  assert.equal(TS.refFrom('quote', { pathname: '/sparkle/quote/' + tok, search: '' }), tok);
  assert.equal(TS.refFrom('quote', { pathname: '/sparkle/portal/' + tok, search: '' }), tok);
  assert.equal(TS.refFrom('quote', { pathname: '/approve.html', search: '?token=nope' }), '');
  assert.equal(TS.refFrom('booklet', { pathname: '/booklet', search: '?t=' + tok }), tok);
  assert.equal(TS.refFrom('booklet', { pathname: '/booklet', search: '?t=<x>' }), '');
  assert.equal(TS.refFrom('site', { pathname: '/i/asha-weds-rohan', search: '' }), 'asha-weds-rohan');
  assert.equal(TS.refFrom('site', { pathname: '/sparkle/invite/Asha-Weds', search: '' }), 'asha-weds');
  assert.equal(TS.refFrom('site', { pathname: '/invite', search: '?s=a%22b' }), '');
  assert.equal(TS.refFrom('other', { pathname: '/', search: '' }), '');
});
t('client pages load the banner (approve / portal = quote, booklet, invitation = site) + the red CSS', () => {
  for (const [p, kind] of [['public/approve.html', 'quote'], ['public/portal.html', 'quote'], ['public/booklet.html', 'booklet'], ['public/invite.html', 'site']]) {
    const h = read(p);
    assert.match(h, new RegExp('<script src="/trial-sim\\.js\\?v=\\d+" data-trial-sim="' + kind + '"></script>'), p);
    assert.match(h, /<link rel="stylesheet" href="\/trial-sim\.css\?v=\d+">/, p);
    assert.ok(h.indexOf('trial-sim.js') > h.indexOf('store-api.js'), p + ': after store-api');
  }
  for (const p of ['public/client.html', 'public/event.html', 'public/flow.html', 'public/invite-studio.html']) {
    const h = read(p); assert.match(h, /<script src="\/trial-sim\.js\?v=\d+"><\/script>/, p); assert.match(h, /trial-sim\.css\?v=\d+/, p);
  }
});
t('approve.html: simulated payment step after the test approval; no real payment button in a trial', () => {
  assert.match(AP, /<div class="trial-sim-pay" id="simPay" hidden>\s*<h3>Next step \(simulated\): payment<\/h3>/);
  assert.match(AP, /<button class="btn primary" id="simPayBtn" type="button">Simulate payment<\/button>/);
  assert.match(AP, /BPStore\.approval\.trialSimulatePayment\(token, \$\("#c_name"\)\.value\.trim\(\), navigator\.userAgent\)/);
  assert.match(AP, /HelmApproveTestMode\.APPROVED; \$\("#payManual"\)\.hidden=false; setMsg\(\); showSimPay\(\); \}/);
  assert.match(AP, /\$\("#payBtn"\)\.hidden=true; \$\("#payBtn"\)\.style\.display="none";\n\s*\$\("#payManual"\)\.textContent="Trial simulation: no real payment is taken here and no payment link is sent\./);
  assert.ok(!/innerHTML/.test(read('public/trial-sim.js')), 'trial-sim.js: textContent only');
});
t('store-api: the four 0323 RPCs; client calls fail soft (null / []), the simulate call throws to the page', () => {
  assert.match(API, /trialSimPage: \(kind, ref\) => mode === "supabase" && ref \? rpc\("public_trial_simulation", \{ p_kind: String\(kind \|\| ""\), p_ref: String\(ref\)\.slice\(0, 200\) \}\)\.catch\(\(\) => null\)/);
  assert.match(API, /trialPaymentSim: \(token\) => mode === "supabase" && token \? rpc\("public_trial_payment_sim", \{ p_token: token \}\)\.catch\(\(\) => null\)/);
  assert.match(API, /trialSimulatePayment: \(token, clientName, ua\) => rpc\("trial_simulate_payment", \{ p_token: token, p_client_name: clientName \|\| null, p_user_agent: ua \|\| null \}\),/);
  assert.match(API, /trialSimPayments: \(quoteId\) => mode === "supabase" && quoteId \? rpc\("trial_sim_payments_for_quote", \{ p_quote: quoteId \}\)\.catch\(\(\) => \[\]\)/);
});
t('studio send boxes: a trial PREVIEWS (email-send + Send to client), never asks the server to send', () => {
  const es = read('public/email-send.js'); const ctx = { window: {}, document: {} }; vm.runInNewContext(es, ctx);
  const E = ctx.window.HelmEmailSend;
  assert.equal(E.trialState({ trial: true, email: true, email_per_day: 30 }).testMode, true, 'even an old 0212 "email:true" -> simulation');
  assert.equal(E.trialState({ trial: false, email: true }).testMode, false, 'paid: unchanged');
  assert.equal(E.SIM_LABEL, 'Preview e-mail (trial)');
  assert.match(es, /if \(trial\) \{ btn\.disabled = false; btn\.textContent = SIM_LABEL; to\.textContent = SIM_LINE;/);
  assert.match(es, /if \(r\.preview && TS && TS\.preview\) TS\.preview\(box, r\.preview\);/);
  const is = read('public/invite-site-share.js');
  assert.match(is, /isTrial = m\.trial === true;/);
  assert.match(is, /send\.textContent = isTrial \? "Preview \(trial \\u2014 not sent\)"/);
  // the trial branch returns before any send call
  const i = is.indexOf('if (isTrial) {\n        var TS = window.HelmTrialSim'), j = is.indexOf('var go = opts.send ? opts.send(');
  assert.ok(i > 0 && j > i && is.slice(i, j).includes('return;'), 'trial returns before opts.send / S.sites.send');
});
t('client-mailer: any trial answer -> simulated preview (status test_mode, simulated), never sendMail', () => {
  assert.match(CM, /if \(g && g\.trial && g\.reason !== "demo"\) return await simulated\(\);/);
  assert.match(CM, /if \(gate\.blocked && !gate\.unknown\) return await simulated\(\);/);
  assert.match(CM, /return json\(\{ status: "test_mode", trial: true, simulated: true, masked, reason: TRIAL_SIM_TEXT, preview, \.\.\.extra \}\);/);
  const sim = CM.indexOf('if (g && g.trial && g.reason !== "demo")'), send = CM.indexOf('await sendMail(');
  assert.ok(sim > 0 && send > sim, 'the trial exit comes before the only sendMail');
  assert.ok(!/\btrialEmail\b/.test(CM), 'the 0212 "trial e-mail really goes out" flag is gone');
});
t('0323 SQL: additive + idempotent; house wrapper keeps the 0212 body; no DROP / DELETE / destructive UPDATE', () => {
  assert.match(SQL, /alter function public\._tr212_email_ok\(uuid\) rename to _tr212_email_ok__pre0323;/);
  assert.match(SQL, /if to_regprocedure\('public\._tr212_email_ok__pre0323\(uuid\)'\) is null then/);
  assert.match(SQL, /create table if not exists public\.trial_sim_payments/);
  assert.match(SQL, /constraint trial_sim_payments_test_only check \(test_mode\)/);
  assert.match(SQL, /create unique index if not exists trial_sim_payments_once/);
  assert.match(SQL, /'payment\.simulated'/);
  const code = SQL.replace(/^--.*$/gm, '');
  assert.ok(!/\bdrop\s+(table|column|function|trigger|policy|index)\b/i.test(code), 'no DROP');
  assert.ok(!/\bdelete\s+from\b/i.test(code), 'no DELETE');
  assert.ok(!/\bupdate\s+public\.\w+\s+set\b/i.test(code), 'no UPDATE of rows');
  assert.ok(!/\btruncate\b/i.test(code), 'no TRUNCATE');
  assert.ok(!/[^\x00-\x7F]/.test(SQL), 'ASCII only');
  assert.ok(!/quote_payments\s*\(|insert into public\.quote_payments|insert into public\.payment_milestones/i.test(code), 'never writes the money ledger');
});
t('APPLY-0323: begin/commit, STOP guards (0322 first), VERIFY rows, no temp tables / session state', () => {
  assert.match(APPLY, /^-- APPLY-0323\.sql/);
  assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n/);
  assert.match(APPLY, /STOP 0323: 0322 \(trial approval test mode\) missing - run APPLY-0322\.sql first/);
  assert.match(APPLY, /select item, ok from \(values/);
  assert.ok(!/temp(orary)? table|set session|set role|set_config\('request/i.test(APPLY), 'no temp tables / session state');
  assert.ok(APPLY.includes(SQL.trim().split('\n').slice(-3).join('\n')), 'the migration body is inside');
  assert.ok(!/[^\x00-\x7F]/.test(APPLY), 'ASCII only');
});
t('MANIFEST / db test runner / release lists know 0323 (after 0322)', () => {
  const man = read('supabase/migrations/MANIFEST');
  const a = man.indexOf('forward  supabase/migrations/0322_'), b = man.indexOf('forward  supabase/migrations/0323_r114_trial_simulation.sql');
  assert.ok(a > 0 && b > a, 'MANIFEST: 0323 after 0322');
  assert.match(read('scripts/db-test/run-all.sh'), /run "r114-trial-sim-0323" "R114-TRIAL-SIM-0323: ALL PASS \\\(35\/35\\\)" psql -q -f tests\/db\/r114-trial-sim-0323\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0322', '0323'\]/, f);
  assert.ok(existsSync(new URL('../tests/db/r114-trial-sim-0323.sql', import.meta.url)));
});
t('audit document exists with the action table', () => {
  const a = read('testing/phase2/TRIAL-SIMULATION-AUDIT.md');
  assert.match(a, /\| Action \| Today in trial \| After fix \| File:line \|/);
});
t('studio step 10 (trial-test-note): red SIMULATION banner + the client simulated payments (TEST receipts only)', () => {
  const N = require('../public/trial-test-note.js');
  assert.equal(N.paySimSpec(null), null); assert.equal(N.paySimSpec({ is_trial_org: false }), null);
  assert.match(N.paySimSpec({ is_trial_org: true, ended: true }).text, /^SIMULATION - no real payment\./);
  const l = N.simLines([{ amount: 41772, currency: 'INR', label: 'Advance (30%)', receipt: 'TEST-ABCD1234' }]);
  assert.equal(l.length, 1); assert.match(l[0], /Advance \(30%\) - INR 41,772 \(receipt TEST-ABCD1234, TEST - no real money\)/);
  assert.deepEqual(N.simLines(null), []);
  const js = read('public/trial-test-note.js');
  assert.match(js, /trialSimPayments\(id\)/); assert.doesNotMatch(js, /innerHTML/);
});
t('payment schedule: in a trial the reminder line says reminders are not sent (simulation)', () => {
  const js = read('public/payment-schedule.js');
  assert.match(js, /Trial simulation - reminders are not sent to your client in the free trial\./);
  assert.match(js, /HelmTrialLock\.isTrial\(\)\) line \+= " " \+ TRIAL_SIM_REMIND/);
});
console.log(`r114-trial-simulation: ${n} passed`);
