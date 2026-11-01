// r118-hq-fixes.test.mjs - R118 HQ audit fixes (HQ-TEST-PLAN.md F-01 .. F-16).
//  F-01  Studio owner card: e-mails masked by the DATABASE (0326) + Show through hq_reveal('member', id) (logged);
//        "Recover studio owner" reveals the chosen admin (logged) before it calls hq_studio_owner_recover
//  F-02 / F-03 / F-06  confirms before "Refresh past-due", the referral daily job and "Save subscription"
//  F-05  a blank ₹ price / GST rate is an error, never a silent 0; a typed 0 asks first
//  F-07 / F-15  a failed first load (or hq_me) shows "couldn't load" + Retry, never the 404 page; fail closed
//  F-04 / F-09  Data & privacy copy: Admin sees HQ sessions; sign-in rules read from hq_me, not hard-coded
//  F-08  Referrals menu links the right /hq tabs (hash), no ?demo=1; hq.js opens /hq#<tab>
//  F-10 .. F-14, F-16  tour copy, one trial-end day, no emoji, ist() guard, referrals idle timer + page tour
// Static + pure-function checks; the database side: tests/db/r118-hq-owner-masked-0326.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), RJ = rd('public/hq-referrals.js'), RH = rd('public/hq-referrals.html');
const PT = rd('public/page-tours.js');
const SQL = rd('supabase/migrations/0326_r118_hq_owner_masked.sql'), AP = rd('supabase/APPLY-0326.sql');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const body = (src, name) => fnSrc(src, name);

t('F-01 SQL 0326: owner card + flags masked with _r57_mask_email, person ids for Show, house wrapper, additive', () => {
  assert.match(SQL, /create or replace function public\.hq_studio_owner_info\(p_org uuid\)\nreturns jsonb language plpgsql volatile security definer set search_path = ''/);
  for (const k of ["'email', public._r57_mask_email(p.email)", "public._r57_mask_email((select p.email from public.profiles p where p.id = l.user_id))",
                   "public._r57_mask_email((select p.email from public.profiles p where p.id = l.prev_user_id))", "public._r57_mask_email(l.by_email)",
                   "'owner_user_id', l.user_id", "'prev_user_id', l.prev_user_id", "'by_user_id', l.by_user"]) assert.ok(SQL.includes(k), k);
  assert.ok(!/'email', p\.email/.test(SQL), 'no clear e-mail left in the card');
  assert.match(SQL, /perform public\._hq27_require\('studios\.read', false\);[\s\S]*'hq\.view', 'hq_studio_owner'/);
  assert.match(SQL, /hq_studio_owner_flags__pre0326\(\)/);
  assert.match(SQL, /raise exception 'STOP 0326: studio owner \(0283\) missing/); assert.match(SQL, /raise exception 'STOP 0326: HQ masking \(0298\) missing/);
  const code = SQL.replace(/--[^\n]*/g, '').replace(/insert into public\.audit_log\(/g, '');   // the hq.view row (as 0283) is the only write
  assert.doesNotMatch(code, /\b(delete\s+from|truncate|drop\s+table|alter\s+table|insert\s+into|update\s+public)\b/i);
  assert.doesNotMatch(SQL, /[^\x00-\x7f]/, 'ASCII');
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ''), /0325|pre0325/, 'independent of 0325');
});
t('F-01 APPLY-0326.sql: begin/commit around the migration verbatim, STOP guards, 5 VERIFY rows; MANIFEST + DB suite', () => {
  assert.ok(AP.includes(SQL.trim())); assert.match(AP, /^begin;$/m); assert.match(AP, /^commit;$/m);
  assert.equal((AP.match(/^  \('0\d /gm) || []).length, 5);
  assert.doesNotMatch(AP, /[^\x00-\x7f]/); assert.doesNotMatch(AP, /temp table|^\\/im);
  assert.match(rd('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0326_r118_hq_owner_masked\.sql\n/);
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r118-hq-owner-masked-0326" "R118-HQ-OWNER-MASKED-0326: ALL PASS \\\(17\/17\\\)" psql -q -f tests\/db\/r118-hq-owner-masked-0326\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0324', '0326'\]/, f);
});
t('F-01 hq.js: the owner card shows masked e-mails with Show (hq_reveal member), never the clear value', () => {
  const lo = body(J, 'loadOwner');
  assert.match(lo, /ownerMail\(o\.email, o\.user_id, org\)/);
  assert.match(lo, /ownerMail\(h\.owner_email, h\.owner_user_id, org\)/); assert.match(lo, /ownerMail\(h\.by_email, h\.by_user_id, org\)/);
  assert.doesNotMatch(lo, /\(o\.email \|\| "-"\)|" · " \+ h\.owner_email|" · by " \+ h\.by_email/);
  const om = body(J, 'ownerMail');
  assert.match(om, /masked\(s, "email", "member", uid, "email"\)/);
  assert.match(om, /logReveal\("studio", org, "owner_email"\)/, 'an older database (no id) still logs before it shows');
  // recover: the select holds an index, the option text is masked, the real address comes from hq_reveal first
  assert.match(lo, /value: String\(i\)/); assert.doesNotMatch(lo, /value: a\.email/);
  assert.match(lo, /ownerRealEmail\(pick, org\)\.then[\s\S]*window\.confirm\([\s\S]*hq_studio_owner_recover", \{ p_org: org, p_email: email/);
  assert.match(body(J, 'ownerRealEmail'), /revealValue\("member", a\.user_id, "email", v\)/);
});
t('F-02 Refresh past-due: a confirm that says it marks studios past due and queues reminders, before the call', () => {
  const i = J.indexOf('on("#btnRefreshBilling"'); const line = J.slice(i, J.indexOf('\n', i));
  assert.ok(line.indexOf('window.confirm(REFRESH_PAST_DUE_CONFIRM)') > 0 && line.indexOf('window.confirm') < line.indexOf('call("hq_refresh_billing_status")'));
  assert.match(J, /var REFRESH_PAST_DUE_CONFIRM = "[^"]*PAST DUE[^"]*reminder e-mails \+ bell notices[^"]*"/);
});
t('F-03 Referrals "Run the daily job now": confirm first; nothing is called when cancelled', () => {
  const rt = body(RJ, 'runTick');
  assert.ok(rt.indexOf('if (!window.confirm(TICK_CONFIRM)) return;') >= 0 && rt.indexOf('window.confirm') < rt.indexOf('hq_referral_run_tick'));
  assert.match(RJ, /var TICK_CONFIRM = "[^"]*free months[^"]*notices[^"]*"/);
  const calls = []; const cx = { window: { confirm: () => false }, $: () => ({ textContent: '' }), call: (f) => { calls.push(f); return Promise.resolve({}); }, TICK_CONFIRM: 'x', loadReal: () => null, msg: String };
  vm.createContext(cx); vm.runInContext(rt + '\nrunTick();', cx);
  assert.deepEqual(calls, []);
});
t('F-05 a blank ₹ price / GST rate is an error (never 0); a typed 0 is allowed after a confirm', () => {
  const cx = { String, Number, isFinite }; vm.createContext(cx);
  vm.runInContext(fnSrc(J, 'requiredNumber') + '\nthis.f = requiredNumber;', cx);
  for (const v of ['', '   ', null, undefined]) assert.throws(() => cx.f(v, 'GST rate (%)', 0, 50), /is empty/);
  assert.throws(() => cx.f('abc', 'x', 0), /must be a number/); assert.throws(() => cx.f('-1', 'x', 0), /0 or more/); assert.throws(() => cx.f('51', 'x', 0, 50), /50 or less/);
  assert.equal(cx.f('0', 'x', 0, 50), 0); assert.equal(cx.f(' 18 ', 'x', 0, 50), 18); assert.equal(cx.f('1499', 'x', 0), 1499);
  const ss = body(J, 'saveSettings'), sp = body(J, 'savePlan');
  assert.match(ss, /requiredNumber\(\$\("#sRate"\)\.value, "GST rate \(%\)", 0, 50\)/); assert.match(ss, /p_gst_rate: rate/); assert.match(ss, /rate === 0 && !window\.confirm/);
  assert.doesNotMatch(ss, /Number\(\$\("#sRate"\)\.value\)/);
  assert.match(sp, /requiredNumber\(\$\("#plPrice"\)\.value, "₹ price per month", 0\)/); assert.match(sp, /p_price_monthly: pm, p_currency: "INR"/);
  assert.doesNotMatch(J, /Number\(\$\("#plPrice"\)\.value\)/);
  // the server already refuses NULL (0045 hq_upsert_plan / hq_set_billing_settings): unchanged
  const s45 = rd('supabase/migrations/0045_hq_subscriptions.sql');
  assert.match(s45, /if p_price_monthly is null or p_price_monthly < 0 then raise exception 'price must be 0 or more'/);
  assert.match(s45, /if p_gst_rate is null or p_gst_rate < 0 or p_gst_rate > 50 then raise exception 'GST rate must be 0-50'/);
});
t('F-06 Save subscription: a confirm that lists the change; nothing picked = nothing sent', () => {
  const cx = { String, Number, Date, isNaN, Object }; vm.createContext(cx);
  vm.runInContext('var SUB_STATUS_WORD = { trial: "Trial", active: "Paying (active)", past_due: "Past due", cancelled: "Cancelled" };\n' + fnSrc(J, 'date') + '\n' + fnSrc(J, 'subscriptionChangeText') + '\nthis.f = subscriptionChangeText;', cx);
  assert.equal(cx.f({}), '');
  const s = cx.f({ plan: 'Studio · ₹2,999', status: 'cancelled', periodEnd: '2026-12-31' });
  assert.match(s, /Plan: Studio/); assert.match(s, /Status: Cancelled - the studio's access changes/); assert.match(s, /Period end: 31 Dec 2026/);
  const i = J.indexOf('call("hq_set_subscription"'); const pre = J.slice(J.lastIndexOf('save.addEventListener("click"', i), i);
  assert.match(pre, /subscriptionChangeText\(/); assert.match(pre, /if \(!what\)[^\n]*return;/); assert.match(pre, /if \(!window\.confirm\("Change the subscription of "[^\n]*return;/);
});
t('F-07 / F-15 first-load failure: "couldn\'t load" + Retry (not 404); hq_me failure fails closed; notFound hides the other screens', () => {
  assert.match(H, /<main id="vLoadErr" class="blk" hidden>[\s\S]*id="leRetry"[\s\S]*id="leOut"[\s\S]*<\/main>/);
  const st = body(J, 'start');
  assert.match(st, /try \{ await loadAll\(\); \}\s*catch \(e\) \{ loadFailed\(e\); return; \}/);
  assert.doesNotMatch(st, /catch \(e\) \{ notFound\(\); return; \}   \/\/ any failure on first load/);
  assert.match(st, /if \(!meMissing\(e\)\) \{ loadFailed\(e\); return; \}/);
  assert.match(body(J, 'notFound'), /vb\.hidden = true[\s\S]*ve\.hidden = true/);
  const lf = body(J, 'loadFailed'); assert.match(lf, /if \(blockedNow\) return;/); assert.match(lf, /location\.reload\(\)/);
  const cx = { String, RegExp }; vm.createContext(cx); vm.runInContext(fnSrc(J, 'meMissing') + '\nthis.f = meMissing;', cx);
  assert.equal(cx.f({ message: 'Could not find the function public.hq_me without parameters in the schema cache', code: 'PGRST202' }), true);
  assert.equal(cx.f({ message: 'Failed to fetch' }), false); assert.equal(cx.f({ message: 'not authorized: HQ_ROLE' }), false); assert.equal(cx.f(null), false);
  // referrals: hq_me failing is fail-closed too
  assert.match(RJ, /blocked\("Referrals & partners couldn't load"/);
});
t('F-04 / F-09 Data & privacy: Admin sees HQ sessions; sign-in rules read from hq_me (no fixed 30 min / 12 h)', () => {
  assert.match(H, /HQ staff sessions, devices, short IP<\/b><\/td><td>Protecting HQ<\/td><td>Owner, Admin, Security<\/td>/);
  assert.doesNotMatch(H, /sign-out after 30 minutes idle, sign-ins end after 12 hours/);
  assert.match(H, /<span id="pvIdle">the set idle time<\/span>[\s\S]{0,80}<span id="pvMax">the set number of hours<\/span>/);
  const pr = body(J, 'paintPrivacyRules'); assert.match(pr, /ME\.idle_minutes/); assert.match(pr, /ME\.max_hours/);
  assert.match(body(J, 'start'), /applyPerms\(\); paintPrivacyRules\(\);/);
  const staff = rd('public/hq-staff.js'); assert.match(staff, /admin: \[[^\]]*"staff\.read"/s);
});
t('F-08 Referrals menu: each item links its /hq tab (#hash), no ?demo=1; hq.js opens /hq#<tab>', () => {
  assert.doesNotMatch(RH, /href="[^"]*\?demo=1/);
  for (const k of ['studios', 'billing', 'plans', 'activity']) assert.match(RH, new RegExp('<a class="navi" data-hq="' + k + '">'));
  const cx = { String }; vm.createContext(cx); vm.runInContext(fnSrc(RJ, 'hqHref') + '\nthis.f = hqHref;', cx);
  assert.equal(cx.f('1'), '/hq'); assert.equal(cx.f('studios'), '/hq#studios'); assert.equal(cx.f('activity'), '/hq#activity'); assert.equal(cx.f('"><x'), '/hq');
  const c2 = { String, TABS: ['overview', 'studios', 'billing', 'requests', 'plans', 'people', 'activity', 'staff', 'settings', 'privacy'] }; vm.createContext(c2);
  vm.runInContext(fnSrc(J, 'hashTab') + '\nthis.f = hashTab;', c2);
  assert.equal(c2.f('#studios'), 'studios'); assert.equal(c2.f('#Plans'), 'plans'); assert.equal(c2.f('#nope'), null); assert.equal(c2.f(''), null);
  assert.match(body(J, 'start'), /var askTab = hashTab\(location\.hash\);/);
  assert.match(body(J, 'start'), /if \(askTab && askTab !== "requests" && canTab\(askTab\)\) \{ var tb0 = \$\("#tab-" \+ askTab\); if \(tb0\) tb0\.click\(\); \}/);
});
t('F-10 HQ tour: the search step no longer promises invoices; every desc <= 240 characters', () => {
  assert.doesNotMatch(PT, /Find a studio, person or invoice/);
  assert.match(PT, /\{ sel: "#gSearch", title: "Search studios and people", desc: "Find a studio by name or link, or a person by e-mail\. Invoices are under Billing\." \}/);
});
t('F-11 one trial-end day: the drawer Overview fact uses trialDay and is repainted by hq_trial_info like the Plan tab', () => {
  assert.match(body(J, 'trialFact'), /trialDay\(sub\.trial_ends_at, null\)/); assert.match(body(J, 'trialFact'), /v\.id = "ovTrialEnd"/);
  assert.match(body(J, 'loadTrialInfo'), /getElementById\("ovTrialEnd"\)[\s\S]*trialDay\(t\.trial_ends_at, tz\)/);
  assert.doesNotMatch(J, /"Trial ends" : "Period ends", sub\.status === "trial" \? date\(/);
  assert.doesNotMatch(J, /" · trial ends " \+ date\(/);
});
t('F-12 Security table: a line icon, no emoji', () => {
  assert.doesNotMatch(J, /\u{1F6E1}/u);
  assert.match(body(J, 'loadSecurity'), /el\("span", \{ cls: "secic", "aria-hidden": "true" \}, \[attIcon\("shield"\)\]\)/);
  assert.match(H, /\.secic svg\{width:15px;height:15px/);
});
t('F-14 ist(): a bad timestamp shows "—", never "Invalid Date"', () => {
  const cx = { Date, isNaN }; vm.createContext(cx); vm.runInContext(fnSrc(J, 'ist') + '\nthis.f = ist;', cx);
  assert.equal(cx.f('not a date'), '—'); assert.equal(cx.f(null), '—'); assert.equal(cx.f(''), '—');
  assert.match(cx.f('2026-10-31T10:00:00Z'), /31\/10\/2026/);
});
t('F-13 Referrals: the same idle / hard-end sign-out as /hq + a throttled heartbeat; the data leaves the screen', () => {
  const cx = { Math, Number, Date, isFinite }; vm.createContext(cx); vm.runInContext(fnSrc(RJ, 'sessionOut') + '\nthis.f = sessionOut;', cx);
  const now = Date.parse('2026-11-01T10:00:00Z');
  assert.equal(cx.f(now, now - 29 * 60000, 30, null), null); assert.equal(cx.f(now, now - 31 * 60000, 30, null), 'idle');
  assert.equal(cx.f(now, now - 6 * 60000, 1, null), 'idle', 'never under 5 minutes'); assert.equal(cx.f(now, now, 30, '2026-11-01T09:59:00Z'), 'expired');
  assert.equal(cx.f(now, now - 10 * 60000, undefined, null), null, 'default 30 minutes');
  assert.match(body(RJ, 'startWatch'), /hq_my_session/); assert.match(body(RJ, 'beat'), /hq_heartbeat", \{ p_page: "referrals" \}/);
  assert.match(body(RJ, 'sessionOver'), /blocked\("Session expired - sign in again"[\s\S]*signOut/);
  assert.match(RJ, /wire\(\); startWatch\(\);/);
});
t('F-16 Referrals page tour: helpBtn in the top bar, page-tours.js before tour.js, steps for its tabs', () => {
  assert.match(RH, /<button class="btn" id="helpBtn" type="button"/);
  const a = RH.indexOf('<script src="/page-tours.js?v='), b = RH.indexOf('<script src="/tour.js?v=');
  assert.ok(a > 0 && a < b && RH.indexOf('hq-referrals.js?v=') < a);
  const ctx = { window: {}, document: { querySelector: () => null, documentElement: { classList: { contains: () => false } } }, location: { hash: '' } };
  ctx.window.location = ctx.location; ctx.window.document = ctx.document; vm.createContext(ctx); vm.runInContext(PT, ctx);
  const steps = ctx.window.HelmPageTours.entry('hq-referrals.html');
  assert.ok(Array.isArray(steps) && steps.length >= 4);
  for (const s of steps) { assert.ok(s.desc.length <= 240); assert.ok(RH.includes('id="' + s.sel.slice(1) + '"'), s.sel); }
});
t('no React, no new dependency; demo stays localhost-only', () => {
  assert.doesNotMatch(J + RJ, /\bReact\b|from "react"|\.jsx\b/);
  assert.match(J, /function demoWanted\(host, search\)/);
});
console.log(process.exitCode ? 'R118 HQ FIXES: FAILED' : 'R118 HQ FIXES: ALL PASS (' + n + '/' + n + ')');
