// r21 trial -> paid (TRIAL-TO-PAID-PLAN.md phase A, migration 0244):
//  * HQ "Activate plan" = ONE server step (hq_activate_plan): payment + GST invoice + plan ACTIVE + period; the
//    dormant subscription webhook activates through the same database step (passes the subscription id)
//  * Contact sales is saved in Helm (request_plan_activation) + HQ "Requests" tab + e-mail alert lane; mailto = fallback link only
//  * checkout shows UPI / bank transfer details from window.HELM_PAY_MANUAL (config.js) while online payment is off
//  * read-only banner: "Talk to us" (admins) / "Ask my admin to upgrade" (teammates, ask_admin_upgrade)
//  * ONE retention promise everywhere; no stale "14-day" trial copy
// Behaviour of the SQL: tests/db/r21-trial-paid-0244.sql (local PG).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const PROMISE = 'Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.';
const SQL = read('supabase/migrations/0244_trial_to_paid_activation.sql');
const CO = read('public/checkout.js'), COH = read('public/checkout.html'), API = read('public/store-api.js');
const HQ = read('public/hq.js'), HQH = read('public/hq.html'), TJS = read('public/trial.js');

/* ---------------- the one retention promise ---------------- */
await t('retention: the same promise in the app, the e-mails, billing-reminder and the policy pages', () => {
  for (const f of ['public/trial.js', 'public/auth-ui.js', 'public/checkout.js', 'public/privacy.html', 'public/data-deletion.html',
    'supabase/functions/comms-dispatch/trial-reminders.mjs', 'supabase/functions/comms-dispatch/helm-notices.mjs',
    'supabase/functions/billing-reminder/trial-email.ts', 'docs/product/TRIAL-POLICY.md'])
    assert.ok(read(f).includes(PROMISE), f);
  assert.doesNotMatch(read('docs/product/TRIAL-POLICY.md'), /never auto-deleted/);
  assert.doesNotMatch(read('public/privacy.html'), /Workspace after cancellation or trial expiry/);
  assert.match(read('public/trial-facts.js'), /KEEP_DAYS = 60/, 'the trial terms already say 60 days');
});
await t('stale copy: no "14-day" trial wording left in the trial e-mails', () => {
  for (const f of ['supabase/functions/billing-reminder/trial-email.ts', 'supabase/functions/comms-dispatch/trial-reminders.mjs'])
    assert.doesNotMatch(read(f), /14[- ]day/, f);
  assert.match(read('supabase/functions/billing-reminder/trial-email.ts'), /Your 8-day free trial of Helm ends/);
});
await t('retention: the countdown e-mails use the promise while deletion is switched off', async () => {
  const m = await import('../supabase/functions/comms-dispatch/trial-reminders.mjs');
  assert.equal(m.RETENTION_PROMISE, PROMISE);
  const off = m.trialReminderEmail('d5', 'Demo 7', '2026-10-27T18:30:00Z', 'Asia/Kolkata', '').text;
  assert.ok(off.includes(PROMISE)); assert.doesNotMatch(off, /Nothing is deleted/);
  const x7 = m.trialRetentionEmail('x7', 'Demo 7', { expiredAt: '2026-10-20T18:30:00Z', timeZone: 'Asia/Kolkata' }, '');
  assert.ok(x7.text.includes(PROMISE));
});

/* ---------------- read-only banner ---------------- */
await t('banner: ended trial -> admins "Upgrade" + "Talk to us"; teammates "Ask my admin to upgrade"; promise for all', () => {
  const T = require('../public/trial.js');
  const a = T.bannerSpec({ is_trial_org: true, ended: true, locked: true, read_only: true, is_admin: true });
  assert.equal(a.cta, 'Upgrade'); assert.equal(a.talk, 'Talk to us'); assert.equal(a.ask, null); assert.equal(a.keep, PROMISE);
  const m = T.bannerSpec({ is_trial_org: true, ended: true, read_only: true, is_admin: false });
  assert.equal(m.cta, null); assert.equal(m.talk, null); assert.equal(m.ask, 'Ask my admin to upgrade'); assert.equal(m.note, 'Only a studio admin can upgrade.');
  const live = T.bannerSpec({ is_trial_org: true, days_left: 5, is_admin: true });
  assert.equal(live.talk, undefined); assert.equal(live.ask, undefined);
  assert.equal(T.talkHref('quotes'), 'checkout.html?next=quotes.html&sales=banner');
  assert.match(T.askResultText({ sent: true }), /has been asked/);
  assert.match(T.askResultText({ sent: false, already: true }), /already been asked today/);
  assert.match(T.askResultText(null), /couldn't send/);
  assert.match(T.reminderSpec({ is_trial_org: true, is_admin: true, ends_at: '2026-10-27T18:29:00Z', timezone: 'Asia/Kolkata' }, Date.parse('2026-10-24T06:00:00Z')).after, /kept for 60 days/);
});
await t('banner: the ask button calls the server once (disabled while busy / after it worked); DOM only, no HTML', () => {
  assert.match(TJS, /st\.trialOrg\.askAdmin\(\)/);
  assert.match(TJS, /if \(ab\.disabled \|\| !st \|\| !st\.trialOrg \|\| typeof st\.trialOrg\.askAdmin !== "function"\) return;/);
  assert.match(TJS, /tk\.href = talkHref\(page\(\)\);/);
  assert.doesNotMatch(TJS, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(API, /askAdmin: \(\) => \(supa \? rpc\("ask_admin_upgrade", \{\}\)/);
});

/* ---------------- checkout: Contact sales saved + UPI / bank ---------------- */
const ctx = {};
vm.runInNewContext(fnSrc(CO, 'salesSource') + '\n' + fnSrc(CO, 'payDetails') + '\nvar PAY_FIELDS = ' +
  CO.slice(CO.indexOf('var PAY_FIELDS = ') + 17, CO.indexOf(';', CO.indexOf('var PAY_FIELDS = '))) +
  ';\nglobalThis.src = salesSource; globalThis.pay = payDetails;', ctx);
await t('checkout: Contact sales saves the request FIRST; the e-mail app never opens by itself', () => {
  assert.match(API, /requestSales: \(c\) => \{[\s\S]{0,300}rpc\("request_plan_activation", \{ p_plan: String\(a\.plan \|\| ""\), p_interval:/);
  const body = fnSrc(CO, 'sendSales');
  assert.match(body, /r = await S\.checkout\.requestSales\(\{ plan: plan \? plan\.code : "",/);
  assert.doesNotMatch(body, /location\.href|location\.assign|window\.open/, 'no automatic mailto');
  assert.ok(body.indexOf('requestSales') < body.indexOf('$("#sdDone").hidden = false'), 'done only after the server said received');
  assert.match(body, /if \(!r \|\| r\.status !== "received"\) \{/);
  assert.match(CO, /var SALES_OK = "Request received — we'll contact you within one working day";/);
  assert.match(COH, /<p>Request received — we'll contact you within one working day\.<\/p>/);
  // mailto stays as a fallback LINK only (prefilled, hidden until needed)
  assert.match(COH, /<p class="sdlg-mail" id="sdMailWrap" hidden><a id="sdMail" href="mailto:sales@helm\.events">/);
  assert.match(fnSrc(CO, 'salesFallback'), /a\.href = salesMail\(c, SALES_TO\); \$\("#sdMailWrap"\)\.hidden = false;/);
  assert.doesNotMatch(COH, /Your email app is opening/);
});
await t('checkout: "Talk to us" from the banner opens Contact sales and is recorded as such', () => {
  assert.equal(ctx.src('?next=dashboard.html&sales=banner'), 'read_only_banner');
  assert.equal(ctx.src('?next=dashboard.html'), 'checkout');
  assert.equal(ctx.src('?sales=bannerx'), 'checkout');
  assert.match(CO, /if \(salesSource\(location\.search\) === "read_only_banner"\) openSales\(\);/);
});
await t('checkout: UPI / bank details come only from HELM_PAY_MANUAL; empty / [placeholder] values are never shown', () => {
  let d = ctx.pay({});
  assert.equal(d.rows.length, 0); assert.match(d.note, /Our team sends Helm's UPI ID and bank details/);
  d = ctx.pay({ upiId: 'helm@okaxis', payeeName: '[FILL ME]', accountNumber: ' 0012 3456 ', ifsc: 'HDFC0000001', note: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(d.rows)), [['UPI ID', 'helm@okaxis'], ['Account number', '0012 3456'], ['IFSC', 'HDFC0000001']]);
  assert.match(d.note, /UTR/);
  assert.match(CO, /if \(st\.sales\) renderPayDetails\(\);/);
  assert.match(COH, /<div class="paydet" id="coPayDetails" hidden>/);
  const cfg = read('public/config.js');
  assert.match(cfg, /window\.HELM_PAY_MANUAL = Object\.assign\(\{\s*upiId: "",/);
  for (const k of ['payeeName', 'accountName', 'accountNumber', 'ifsc', 'bankName', 'branch', 'note']) assert.match(cfg, new RegExp(k + ': ""'), k);
  assert.doesNotMatch(COH, /\sstyle="/); assert.doesNotMatch(COH, /\son[a-z]+=/i);
  assert.doesNotMatch(CO, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

/* ---------------- HQ ---------------- */
const hctx = {};
vm.runInNewContext(fnSrc(HQ, 'periodEnd') + '\n' + fnSrc(HQ, 'activateArgs') + '\nglobalThis.pe = periodEnd; globalThis.aa = activateArgs;', hctx);
const ORG = 'a0000000-0000-4000-8000-000000000001';
await t('HQ Activate plan: one call to hq_activate_plan with validated arguments; period mirrors the database', () => {
  assert.equal(hctx.pe('2026-10-19', 'monthly'), '2026-11-18');
  assert.equal(hctx.pe('2026-10-19', 'yearly'), '2027-10-18');
  assert.equal(hctx.pe('2026-01-31', 'monthly'), '2026-02-27');   // Postgres: 2026-01-31 + 1 month = 2026-02-28, minus a day
  assert.equal(hctx.pe('2028-02-29', 'yearly'), '2029-02-27');
  const a = hctx.aa(ORG, 'starter', 'monthly', '2358.824', 'upi', '2026-10-19', '', ' UTR 99 ');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), { p_org: ORG, p_plan_code: 'starter', p_interval: 'monthly', p_amount: 2358.82, p_method: 'upi',
    p_period_start: '2026-10-19', p_paid_on: null, p_reference: 'UTR 99', p_currency: 'INR', p_fx_rate_to_inr: null });
  assert.throws(() => hctx.aa('x', 'starter', 'monthly', 1, 'upi'), /Open a studio/);
  assert.throws(() => hctx.aa(ORG, 'starter', 'weekly', 1, 'upi'), /monthly or yearly/);
  assert.throws(() => hctx.aa(ORG, 'starter', 'monthly', 0, 'upi'), /more than 0/);
  assert.throws(() => hctx.aa(ORG, 'starter', 'monthly', 10, 'paypal'), /how they paid/);
  assert.match(HQ, /call\("hq_activate_plan", a\)/);
  assert.match(HQ, /if \(sub\.status !== "suspended"\) wrap\.appendChild\(activateBox\(org, d\.name, sub\)\);/);
  assert.match(HQ, /window\.confirm\("Activate "/);
});
await t('HQ Requests tab: list + mark contacted / won / lost + open the studio', () => {
  assert.match(HQH, /<button type="button" class="tab" id="tab-requests" aria-pressed="false">Requests<\/button>/);
  assert.match(HQH, /<section id="pane-requests" hidden>/);
  assert.match(HQ, /var TABS = \["overview", "studios", "billing", "requests", "plans", "people", "activity", "staff"\];/);
  assert.match(HQ, /call\("hq_sales_requests", \{ p_status: \$\("#fReq"\)\.value \|\| null \}\)/);
  assert.match(HQ, /call\("hq_set_sales_request_status", \{ p_id: x\.id, p_status: k, p_note: note \|\| null \}\)/);
  assert.match(API, /hq: \(fn, args\) => \(\/\^hq_\[a-z_\]\+\$\/\.test\(fn\)/, 'hq_* names pass the store gate');
  assert.doesNotMatch(HQ, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(HQH, /\son[a-z]+=/i);
});

/* ---------------- edge functions ---------------- */
await t('webhook: still dormant / fail-closed; passes the subscription id so the database can activate', () => {
  const W = read('supabase/functions/razorpay-subscription-webhook/index.ts');
  assert.match(W, /if \(Deno\.env\.get\("HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED"\) !== "true"\) return text\("dormant"\);/);
  assert.match(W, /if \(!secret \|\| !sig \|\| !timingSafeEqual\(await hmacHex\(secret, raw\), sig\)\) return text\("invalid signature", 401\);/);
  assert.match(W, /p_provider_subscription_id: subId,/);
});
await t('comms-dispatch: Helm notices lane (claim -> send -> mark), recipients never from the row', async () => {
  const D = read('supabase/functions/comms-dispatch/index.ts');
  assert.match(D, /admin\.rpc\("helm_notice_outbox_claim", \{ p_limit: batch \}\)/);
  assert.match(D, /admin\.rpc\("helm_notice_outbox_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.match(D, /filter\(\(x: string\) => EMAIL\.test\(x\)\)/);
  const m = await import('../supabase/functions/comms-dispatch/helm-notices.mjs');
  const s = m.helmNoticeEmail('sales_request', { studio: 'Spark\r\nBcc: x@y.z', account: 'Demo 7', plan: 'Studio', interval: 'yearly', name: 'Asha',
    email: 'asha@spark.in', phone: '+91 98765 43210', message: 'Two\r\nbranches', source: 'read_only_banner', subscription_status: 'past_due' }, 'https://www.helm.events');
  assert.equal(s.subject, 'Helm plan request: Studio (Yearly) - Spark Bcc: x@y.z');
  assert.ok(!/[\r\n]/.test(s.subject));
  for (const x of ['Studio: Spark Bcc: x@y.z (account: Demo 7)', 'Email: asha@spark.in', 'Billing: Yearly', 'Subscription now: past_due', 'Two\nbranches', '(read-only banner)'])
    assert.ok(s.text.includes(x), x);
  assert.equal(m.helmNoticeEmail('sales_request', { studio: 'S', plan: '' }, ''), null, 'incomplete -> skipped');
  const u = m.helmNoticeEmail('upgrade_ask', { who: 'Ravi', studio: 'Demo 7' }, 'https://app.example.com/');
  assert.equal(u.subject, 'Ravi asked you to choose a Helm plan');
  assert.ok(u.text.includes('https://app.example.com/checkout')); assert.ok(u.text.includes(PROMISE));
  assert.equal(m.helmNoticeEmail('other', {}, ''), null);
});

/* ---------------- migration shape ---------------- */
await t('0244: additive + idempotent, gated, never deletes; webhook RPC wrapped once; anonymous OFF', () => {
  assert.doesNotMatch(SQL, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column|policy)\b/i);
  assert.match(SQL, /create table if not exists public\.sales_requests/);
  assert.match(SQL, /create table if not exists public\.helm_notice_outbox/);
  assert.match(SQL, /if to_regprocedure\('public\.hq_settle_provider_payment__pre0244\(text,uuid,numeric,date,date,date,text,text,text,numeric\)'\) is null then\s+alter function/);
  assert.match(SQL, /perform public\._hq_wgate\('hq\.subscription\.activate'/);
  assert.match(SQL, /if v_uid is null or v_org is null or not coalesce\(public\.is_admin\(\), false\) then\s+raise exception 'Only a studio admin can request a plan'/);
  assert.doesNotMatch(SQL, /grant execute on function public\.\w+\([^)]*\) to anon/);
  assert.ok(/^[\x00-\x7F]*$/.test(SQL), 'ASCII only');
  const A = read('supabase/APPLY-0244.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(A), 'APPLY ASCII only');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m); assert.match(A, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0244_trial_to_paid_activation\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r21-trial-paid-0244" "R21-TRIAL-PAID-0244: ALL PASS \\\(56\/56\\\)" psql -q -f tests\/db\/r21-trial-paid-0244\.sql/);
});

console.log('r21-trial-paid: ' + n + ' passed');
