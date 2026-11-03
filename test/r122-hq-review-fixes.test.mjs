// r122-hq-review-fixes.test.mjs - R122 HQ code-review fixes, front-end half (items A-I).
//  A  Activate plan / Record payment: currency (the studio's billing currency by default) + an INR rate for others
//  B  "Paid to Helm": per-currency list in the drawer, INR equivalent in the list - no made-up paid_currency
//  C  top search -> People: the TYPED query goes into the People search (never the masked e-mail)
//  D  refreshAfterWrite reloads only the tabs the HQ role can see
//  E  idle sign-out: last input shared by every HQ tab (localStorage + storage event, guarded)
//  F  tax rate / sign-in rules: blank or out-of-range is an error, never a silent default; a 0% tax rule asks first
//  G  no double submit (disable while running) on every HQ write button + the code dialog Enter
//  H  plan / invoice-settings saves say which step failed and what was already saved
//  I  small fixes: alerts card, Invoice + PAN for billing roles, "appears after SQL" only when missing, stale replies,
//     retry error mapping, focus trap / restore, CSV after the log row, invoice pop-up opened in the click, realised date,
//     the three missing tax regimes; plus the "change by hand" subscription form (0330: no trial, reason, active needs an end)
// Static + pure-function checks; the database side: tests/db/r122-hq-review-0330.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), RJ = rd('public/hq-referrals.js'), INV = rd('public/hq-invoice.js');
let n = 0;
const fail = (name, e) => { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; };
const t = (name, fn) => { try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { n++; console.log('  ok ' + name); }, (e) => fail(name, e)); n++; console.log('  ok ' + name); } catch (e) { fail(name, e); } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const ORG = 'a0000000-0000-4000-8000-000000000001';
const pure = (names, extra = {}) => { const cx = { String, Number, isFinite, Math, Date, Error, ...extra }; vm.createContext(cx);
  vm.runInContext(names.map((x) => fnSrc(J, x)).join('\n') + '\n' + names.map((x) => 'this.' + x + ' = ' + x + ';').join('\n'), cx); return cx; };

t('A activateArgs: INR by default (old callers unchanged), other currency needs a rate 0 < r <= 100000', () => {
  const c = pure(['fxRate', 'activateArgs']);
  const a = c.activateArgs(ORG, 'starter', 'monthly', '100', 'upi', '', '', '');
  assert.equal(a.p_currency, 'INR'); assert.equal(a.p_fx_rate_to_inr, null);
  const u = c.activateArgs(ORG, 'starter', 'monthly', '50', 'bank', '', '', 'X', 'usd', '84.5');
  assert.equal(u.p_currency, 'USD'); assert.equal(u.p_fx_rate_to_inr, 84.5);
  assert.throws(() => c.activateArgs(ORG, 'starter', 'monthly', '50', 'bank', '', '', '', 'USD', ''), /exchange rate/);
  assert.throws(() => c.activateArgs(ORG, 'starter', 'monthly', '50', 'bank', '', '', '', 'USD', '0'), /exchange rate/);
  assert.throws(() => c.activateArgs(ORG, 'starter', 'monthly', '50', 'bank', '', '', '', 'USD', '100001'), /exchange rate/);
  assert.throws(() => c.activateArgs(ORG, 'starter', 'monthly', '50', 'bank', '', '', '', 'US', '1'), /3-letter/);
  assert.ok(!/p_currency: "INR", p_fx_rate_to_inr: null/.test(J), 'no hard-coded INR');
});
t('A activate form: currency select defaults to the studio billing currency; rate field hidden for INR; Record payment validated', () => {
  assert.match(J, /var studioCur = billCur\(\{ billing_currency: acc\.billing_currency \|\| d\.billing_currency, country: acc\.country \}\)/);
  assert.match(J, /activateBox\(org, d\.name, sub, studioCur\)/);
  assert.match(J, /function activateBox\(org, name, sub, billCurrency\)/);
  assert.match(J, /fxFld\.hidden = selCur\.value === "INR"/);
  assert.match(J, /activateArgs\(org, selPlan\.value, selIv\.value, amt\.value, meth\.value, start\.value, paid\.value, ref\.value, selCur\.value, fxIn\.value\)/);
  assert.match(J, /\$\("#rCur"\)\.value = studioCur/);
  const rp = fnSrc(J, 'recordPayment');
  assert.match(rp, /if \(cur !== "INR"\) \{ try \{ fx = fxRate\(\$\("#rFx"\)\.value, cur\); \}/);
  assert.match(rp, /p_currency: cur, p_fx_rate_to_inr: fx/);
  assert.match(rp, /if \(b\.disabled\) return;/);
});
t('B Paid to Helm: per-currency list in the drawer, INR equivalent in the list, paid_currency gone from hq.js', () => {
  assert.ok(!/paid_currency/.test(J));
  assert.match(J, /fact\("Paid to Helm", Array\.isArray\(d\.paid_by_currency\) && d\.paid_by_currency\.length \? moneyList\(d\.paid_by_currency\) : money\(d\.total_paid, "INR"\)\)/);
  assert.match(J, /money\(r\.total_paid, "INR"\) : "—", title: "INR equivalent of all payments: "/);
});
t('C top search -> People search gets the typed query, not the masked e-mail', () => {
  const rs = fnSrc(J, 'runSearch');
  assert.match(rs, /\$\("#qUsers"\)\.value = q;/);
  assert.ok(!/\$\("#qUsers"\)\.value = u\.email/.test(J));
});
t('D refreshAfterWrite loads only the tabs the role can see', () => {
  const r = fnSrc(J, 'refreshAfterWrite');
  assert.match(r, /if \(canTab\("studios"\)\) loadStudios/); assert.match(r, /if \(canTab\("billing"\)\) loadBilling/); assert.match(r, /if \(canTab\("overview"\)\) loadOverview/);
  // behaviour: a role without billing / overview never calls those loaders
  const calls = [];
  const cx = { canTab: (x) => x === 'studios', openOrg: null, curDTab: 'overview', showErr() {},
    loadDetail() { calls.push('detail'); return Promise.resolve(); }, loadStudios() { calls.push('studios'); return Promise.resolve(); },
    loadBilling() { calls.push('billing'); return Promise.resolve(); }, loadOverview() { calls.push('overview'); return Promise.resolve(); }, sOff: 0 };
  vm.createContext(cx); vm.runInContext(r + '\nrefreshAfterWrite(null);', cx);
  assert.deepEqual(calls, ['studios']);
});
t('E idle sign-out shares the last input across HQ tabs (hq.js + hq-referrals.js, same key, guarded)', () => {
  for (const src of [J, RJ]) {
    assert.match(src, /var LAST_KEY = "helm\.hq\.lastInput"/);
    assert.match(src, /function sharedRead\(\) \{ try \{ var v = Number\(localStorage\.getItem\(LAST_KEY\)\);/);
    assert.match(src, /try \{ localStorage\.setItem\(LAST_KEY, String\(lastInput\)\); \} catch \(e\) \{\}/);
    assert.match(src, /window\.addEventListener\("storage", function \(e\) \{ if \(e && e\.key === LAST_KEY\)/);
    assert.match(src, /lastInput = Math\.max\(lastInput, sharedRead\(\)\);/);
  }
  // behaviour: another tab's recent input keeps this tab signed in; storage throwing = this tab only
  const store = {}; let now = 1e12;
  const cx = { Number, isFinite, String, Math, Date: { now: () => now }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, lastInput: 0, lastShared: 0, LAST_KEY: 'helm.hq.lastInput' };
  vm.createContext(cx); vm.runInContext(fnSrc(J, 'sharedRead') + fnSrc(J, 'touchInput'), cx);
  vm.runInContext('touchInput();', cx); assert.equal(store['helm.hq.lastInput'], String(1e12));
  now += 3600e3; store['helm.hq.lastInput'] = String(now - 1000);
  assert.equal(vm.runInContext('sharedRead()', cx), now - 1000);
  cx.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(vm.runInContext('sharedRead()', cx), 0); vm.runInContext('lastShared = 0; touchInput();', cx);
});
t('F tax rule rate uses requiredNumber(0..50) + confirm at 0; sign-in rules validated to the database limits', () => {
  const tr = fnSrc(J, 'saveTaxRule');
  assert.match(tr, /requiredNumber\(\$\("#txRate"\)\.value, "Rate %", 0, 50\)/); assert.match(tr, /rate === 0 && !window\.confirm/);
  assert.ok(!/p_rate: Number\(\$\("#txRate"\)\.value\)/.test(J));
  const c = pure(['requiredNumber', 'teamSettingsArgs']);
  assert.deepEqual(JSON.parse(JSON.stringify(c.teamSettingsArgs('30', '12', '15', true, ['1.2.3.4']))), { p_idle_minutes: 30, p_max_hours: 12, p_reauth_minutes: 15, p_ip_allowlist_on: true, p_ip_allowlist: ['1.2.3.4'] });
  assert.throws(() => c.teamSettingsArgs('', '12', '15'), /empty/);
  assert.throws(() => c.teamSettingsArgs('4', '12', '15'), /5 or more/);
  assert.throws(() => c.teamSettingsArgs('30', '25', '15'), /24 or less/);
  assert.throws(() => c.teamSettingsArgs('30', '12', '241'), /240 or less/);
  assert.throws(() => c.teamSettingsArgs('30.5', '12', '15'), /whole number/);
  assert.ok(!/Number\(\$\("#tmIdle"\)\.value\) \|\| 30/.test(J));
});
t('G no double submit: every listed write runs through busy() / a disabled guard', () => {
  assert.match(fnSrc(J, 'busy'), /if \(btn && btn\.disabled\) return Promise\.resolve\(null\);/);
  for (const k of ['busy(v, function () { return call("hq_void_payment"', 'busy(sus, function () { return call("hq_reactivate_studio"', 'busy(sus, function () { return call("hq_suspend_studio"',
      'busy(b, function () { return call("hq_set_sales_request_status"', 'busy(b, function () { return call(fn, { p_id: x.id, p_status: k', 'busy(n, function () { return call(fn, { p_id: x.id, p_status: null',
      'busy($("#btnSeSet")', 'busy($("#btnSettings")', 'busy($("#btnPlan")', 'busy($("#btnTax")', 'busy(sel, function () { return call("hq_staff_set_role"',
      'run(function () { return call("hq_staff_suspend"', 'run(function () { return call("hq_staff_signout"', 'run(function () { return call("hq_staff_restore"',
      'run(function () { return call("hq_staff_remove"', 'busy($("#btnTmAdd")', 'busy($("#btnStAdd")', 'busy($("#btnStDom")', 'busy(rb, function () { return call("hq_refresh_billing_status"',
      'busy(b, function () { return call("hq_record_realisation"', 'busy(save, function () { return call("hq_set_subscription"', 'busy($("#btnTmSet")'])
    assert.ok(J.includes(k), k);
  assert.match(fnSrc(J, 'teamAction'), /if \(b\.disabled\) return; fn\(function \(job\) \{ return busy\(b, job\); \}\);/);
  assert.match(J, /if \(e\.key === "Enter" && !go\.disabled\) go\.onclick\(\);/);
  assert.match(J, /if \(go\.disabled\) return;   \/\/ r122 \(G\)/);
  assert.match(RJ, /ev\.preventDefault\(\); if \(sending\) return; sending = true;/);
  assert.match(RJ, /if \(\$\("fc_save"\)\.disabled\) return;/);
});
await t('H saveSteps: a later failure names what was saved and what was not; the first failure is passed through', async () => {
  const c = pure(['saveSteps'], { Promise });
  await assert.rejects(c.saveSteps([['one', () => Promise.reject(new Error('boom'))]]), /^Error: boom$/);
  await assert.rejects(c.saveSteps([['the plan', () => 1], ['the USD prices', () => Promise.reject(new Error('bad price'))], ['x', () => 1]]),
    /Saved: the plan\. NOT saved: the USD prices - bad price\. Fix it and press Save again \(what was saved stays saved\)\./);
  assert.match(fnSrc(J, 'savePlan'), /saveSteps\(st\)/); assert.match(fnSrc(J, 'saveSettings'), /saveSteps\(\[/);
});
t('I alerts card: clickable only for settings.write; Invoice + PAN only for billing.read', () => {
  assert.match(J, /can\("settings\.write"\) \? function \(\) \{ reqTab\("alerts"\); \} : null/);
  assert.match(fnSrc(J, 'paymentRows'), /if \(can\("billing\.read"\)\) \{   \/\/ r122 \(I\)/);
  assert.match(J, /\["PAN", can\("billing\.read"\) \? masked\(acc\.pan, "id", "studio", org, "pan"\) : null\]/);
});
t('I "appears after SQL" only when the function is missing; other failures say they failed', () => {
  const c = pure(['meMissing', 'partFailed'], { RegExp });
  assert.equal(c.partFailed({ message: 'Could not find the function public.hq_trial_info in the schema cache' }, 'soon'), 'soon');
  assert.match(c.partFailed({ message: 'network down' }, 'soon'), /^Couldn't load this part: network down/);
  for (const s of ['Trial details appear after migration 0186', 'Credits appear after SQL 0280', 'The studio owner appears after SQL 0283', 'Activity appears after SQL 0272'])
    assert.ok(J.includes('partFailed(e, "' + s), s);
});
t('I stale replies: loadDetail / loadTrialInfo drop an answer for a studio that is no longer open', () => {
  const ld = fnSrc(J, 'loadDetail');
  assert.match(ld, /var my = \+\+detailSeq;\s*var d = await call\("hq_studio_detail", \{ p_org: org \}\);\s*if \(my !== detailSeq\) return;/);
  assert.match(ld, /loadTrialInfo\(org, d\.name, trialBox, my\)/);
  assert.match(fnSrc(J, 'loadTrialInfo'), /if \(seq != null && seq !== detailSeq\) return;/);
});
t('I the retry after a fresh code goes through the same error mapping (hq.js + hq-referrals.js)', () => {
  for (const src of [J, RJ]) {
    assert.match(src, /return askCode\(\)\.then\(function \(\) \{ return BPStore\.hq\(fn, args\)\.catch\(function \(e2\) \{ return mapCallErr\(e2, true\); \}\); \}\);/);
    assert.match(src, /return mapCallErr\(e, false\);/);
  }
  const sessions = []; const S = { errKind: (e) => e.k, friendly: (k) => 'F:' + k };
  const cx = { S, ME: { role_label: 'Viewer' }, Error, sessionOver: (x) => sessions.push(x) }; vm.createContext(cx); vm.runInContext(fnSrc(J, 'mapCallErr'), cx);
  assert.throws(() => cx.mapCallErr({ k: 'idle' }, true), /F:idle/); assert.deepEqual(sessions, ['F:idle']);
  assert.throws(() => cx.mapCallErr({ k: 'role' }, true), /F:role/);
  assert.throws(() => cx.mapCallErr({ k: 'reauth' }, true), /not accepted/);
});
t('I focus: code dialog traps Tab and gives focus back; the drawer traps Tab', () => {
  assert.match(J, /function trapTab\(box, e\)/);
  assert.match(fnSrc(J, 'askCode'), /var back = document\.activeElement;[\s\S]*box\.addEventListener\("keydown", trap\);[\s\S]*back\.focus\(\)/);
  assert.match(fnSrc(J, 'openDrawer'), /dr\.addEventListener\("keydown", function \(e\) \{ trapTab\(dr, e\); \}\)/);
});
t('I CSV export waits for the HQ log row; invoice pop-up opened in the click, closed on failure', () => {
  assert.match(fnSrc(J, 'exportCsv'), /logReveal\("billing", "payments", "csv_export"\)\.then\(writeCsv\)/);
  assert.ok(!/csv_export"\)\.catch\(function \(\) \{\}\)/.test(J));
  const oi = fnSrc(J, 'openInvoice');
  assert.ok(oi.indexOf('H.openBlank()') >= 0 && oi.indexOf('H.openBlank()') < oi.indexOf('call(fn'), 'window opened before the call');
  assert.match(oi, /H\.open\(data, win\)/); assert.match(oi, /win\.close\(\)/);
  assert.match(INV, /function openBlank\(\)/); assert.match(INV, /function open\(data, win\)/); assert.match(INV, /openBlank: openBlank/);
});
t('I Mark realised: a real day, not in the future, not before the payment', () => {
  const c = pure(['realisedDateProblem']);
  assert.equal(c.realisedDateProblem('2026-11-01', '2026-10-01', '2026-11-03'), '');
  assert.match(c.realisedDateProblem('01/11/2026', null, '2026-11-03'), /date like/);
  assert.match(c.realisedDateProblem('2026-02-30', null, '2026-11-03'), /real day/);
  assert.match(c.realisedDateProblem('2026-11-04', null, '2026-11-03'), /future/);
  assert.match(c.realisedDateProblem('2026-09-30', '2026-10-01T00:00:00Z', '2026-11-03'), /before the payment/);
});
t('I tax regime dropdown has all seven server regimes with plain labels', () => {
  for (const r of ['LOCAL_REGISTERED', 'NO_TAX', 'IN_GST_INTRA', 'IN_GST_INTER', 'EXPORT_LUT_ZERO', 'EXPORT_IGST_PAID', 'REVERSE_CHARGE'])
    assert.ok(H.includes('<option value="' + r + '">'), r);
  assert.match(H, /Export under LUT - 0% \(no GST\)/); assert.match(H, /Reverse charge \(the buyer pays the tax\)/);
});
t('0330 "change by hand": no trial status / trial date, reason required, active needs a period end', () => {
  const c = pure(['subscriptionArgs']);
  const a = c.subscriptionArgs(ORG, 'starter', 'active', '2026-11-01', '2026-11-30', ' customer paid by bank ', null);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), { p_org: ORG, p_plan_code: 'starter', p_status: 'active', p_trial_ends_at: null,
    p_period_start: '2026-11-01', p_period_end: '2026-11-30', p_notes: null, p_reason: 'customer paid by bank' });
  assert.throws(() => c.subscriptionArgs(ORG, '', 'trial', '', '', 'reason ok'), /Extend trial/);
  assert.throws(() => c.subscriptionArgs(ORG, '', 'active', '', '', 'reason ok', null), /needs a period end/);
  assert.equal(c.subscriptionArgs(ORG, '', 'active', '', '', 'reason ok', '2026-12-01').p_status, 'active');
  assert.throws(() => c.subscriptionArgs(ORG, '', 'cancelled', '', '', 'abc'), /at least 5/);
  assert.throws(() => c.subscriptionArgs(ORG, '', '', '', '', 'reason ok'), /Nothing to change/);
  assert.throws(() => c.subscriptionArgs(ORG, '', '', '2026-11-05', '2026-11-01', 'reason ok'), /before period start/);
  assert.ok(!/\["trial", "trial"\]/.test(J), 'no trial option'); assert.ok(!/field\("Trial ends", te\)/.test(J), 'no Trial ends field');
  assert.match(J, /call\("hq_set_subscription", a\)/);
});
t('front-end stays textContent-only (no innerHTML) in the edited files', () => {
  for (const s of [J, RJ, INV]) assert.doesNotMatch(s, /\.innerHTML\s*=|insertAdjacentHTML|document\.write\(/);
});
console.log(n + ' r122-hq-review-fixes checks passed');
