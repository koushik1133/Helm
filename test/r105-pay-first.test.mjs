// r105-pay-first.test.mjs - R105: sign-up "Contact sales" never creates a studio (0315 request_signup_sales);
// ONE free-trial button (not one per plan card); a returning account with a sales request sees the
// "our team will contact you" page; stuck waiting-for-payment studios get ONE trial button on /checkout.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const SF = read('public/signup-flow.js'), LOGIN = read('public/login.html'), API = read('public/store-api.js'), CO = read('public/checkout.js');
const SQL = read('supabase/migrations/0315_r105_signup_sales_no_studio.sql');

t('plan cards on the sign-up carry no trial button; ONE #stTrial below the cards', () => {
  assert.match(SF, /selected: st\.plan, trial: false, trialDays: st\.trialDays,/);
  assert.match(LOGIN, /<div id="stPlans" aria-live="polite"><\/div>\n\s+<!-- r105[^\n]*\n\s+<div class="st-trial" id="stTrialBox">\n\s+<button type="button" class="btn st-trial-btn" id="stTrial">Start your free 8-day trial<\/button>/);
  assert.match(LOGIN, /One free trial per account, not tied to a plan\./);
  assert.ok(!/Try free for/.test(SF), 'no per-card trial wording left in the sign-up flow');
  assert.match(SF, /tb\.addEventListener\("click", function \(\) \{ go\("trial", currentPlan\(\), tb\); \}\);/);
});
t('Contact sales on the sign-up saves a request - no createDirect before it', () => {
  const at = SF.indexOf('B.signup.requestSales({ plan: p.code, interval: st.interval, studio: d.name,');
  assert.ok(at > 0); assert.ok(at < SF.indexOf('B.signup.createDirect('), 'request first; the studio only on Pay now / set-up');
  assert.match(SF, /if \(kind === "sales" && B\.signup\.requestSales\) \{/);
  assert.match(SF, /showSalesDone\(\{ plan_code: p\.code, plan_name: p\.name, studio_name: d\.name \}\);\n\s+return;/);
  assert.match(API, /rpc\("request_signup_sales", \{ p_plan: String\(a\.plan \|\| ""\)/);
  assert.match(API, /rpc\("my_signup_sales_request"\)/);
});
t('the request-received page: one trial, set-up after sales, sign out; shown again on sign-in', () => {
  assert.match(LOGIN, /<section class="card" id="salesDoneCard" hidden aria-labelledby="sdTitle">/);
  for (const id of ['sdTrial', 'sdSetup', 'sd_signout', 'sdErr', 'sdEmail']) assert.match(LOGIN, new RegExp('id="' + id + '"'));
  assert.match(LOGIN, /"#onboardForm","#startCard","#salesDoneCard",/);
  assert.match(LOGIN, /if\(window\.BPSignupFlow && BPSignupFlow\.resumeSales && await BPSignupFlow\.resumeSales\(\)\) return;[^\n]*\n\s+showOnboarding\(\);/);
  assert.match(SF, /go\("setup", currentPlan\(\), sds\)/);
  assert.match(SF, /resumeSales: resumeSales/);
});
t('checkout: a waiting studio gets ONE trial button, not one per plan', () => {
  assert.match(CO, /trial: false, trialDays: trialDays\(\), onPay: cardPay/);
  assert.match(CO, /tb\.id = "coOneTrial";/);
});
t('0315 is additive: no studio insert, no delete / drop / alter', () => {
  assert.ok(!/insert into public\.organizations|\bdelete from\b|\bdrop (table|function|trigger|policy)\b|\balter table\b/i.test(SQL));
  assert.match(SQL, /values \(null, v_uid, 'checkout', v_plan/);
  assert.match(SQL, /hint = 'has_studio'/);
  assert.ok(existsSync(new URL('../supabase/APPLY-0315.sql', import.meta.url)));
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0315_r105_signup_sales_no_studio\.sql/);
});
t('location asked ONCE on step 3: country (default India) + state (India: list, required) + city', async () => {
  const require = (await import('node:module')).createRequire(import.meta.url);
  const SFm = require('../public/signup-flow.js'), H = require('../public/country-profile.js');
  const IN = H.get('IN').regions.map((r) => r.name);
  let v = SFm.detailsCheck({ name: 'Aurora', city: 'Hyderabad', state: 'Telangana' }, IN);
  assert.equal(v.ok, true); assert.equal(v.clean.country, 'IN'); assert.equal(v.clean.state, 'Telangana');
  assert.equal(SFm.detailsCheck({ name: 'Aurora', city: 'Hyderabad' }, IN).errors.state, 'Please choose your state (needed for GST).');
  assert.equal(SFm.detailsCheck({ name: 'Aurora', city: 'Hyderabad', state: 'Narnia' }, IN).ok, false);
  assert.equal(SFm.detailsCheck({ name: 'Aurora', city: 'Dubai', country: 'AE' }, IN).ok, true, 'outside India the region is optional');
  assert.equal(SFm.detailsCheck({ name: 'Aurora', state: 'Telangana' }, IN).errors.city, 'Please enter your city.');
  assert.equal(SFm.detailsCheck({ name: 'Aurora', city: 'X Y', state: 'Telangana', country: 'FR' }, IN).ok, false);
  assert.match(LOGIN, /<select id="ob_country" autocomplete="country" required><\/select>/);
  assert.match(LOGIN, /<select id="ob_state" autocomplete="address-level1"><\/select>/);
  assert.match(API, /rpc\("my_studio_signup_location", \{ p_country:/);
  assert.equal((SF.match(/B\.signup\.saveLocation\(d\)/g) || []).length, 2, 'trial + set-up paths save the location');
  const TD = read('public/trial-demo.js');
  assert.match(TD, /if \(fc\.input\.value\.trim\(\)\.length >= 2 && fs\.input\.value\) \{\n\s+loc\.hidden = true; fk\.box\.hidden = true;/);
  assert.match(SQL, /fills ONLY empty fields, never overwrites/);
});
console.log(`r105-pay-first: ${n} passed`);
