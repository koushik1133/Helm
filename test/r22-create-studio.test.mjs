// r22 - ONE sign-up flow (owner: "like Slack / Notion / Zoho"): sign-in-only login page with "Create your studio",
// step 1 account + Terms (recorded), step 2 verify e-mail, step 3 studio, step 4 plan cards (Pay now / Try free /
// Contact sales) -> checkout (payment pending until HQ activates) or the trial -> onboarding. Static + pure checks;
// the database behaviour is proven in tests/db/r22-create-studio-0255.sql (scripts/db-test/run-all.sh).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const LOGIN = read('public/login.html'), CO = read('public/checkout.js'), COH = read('public/checkout.html');
const API = read('public/store-api.js'), TSU = read('public/trial-signup.js');
const SQL = read('supabase/migrations/0255_create_studio_signup.sql'), APPLY = read('supabase/APPLY-0255.sql');
const PC = require('../public/plan-cards.js'), SF = require('../public/signup-flow.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

/* ---------------- plan cards ---------------- */
t('plan cards: server plans cleaned (no ids / provider ids), catalog only as a fallback, same prices as pricing page', () => {
  const l = PC.normalize([{ id: 'x', code: 'studio', name: 'Studio', monthly: '4999', yearly: 49990, rzp_monthly: 'plan_1', features: ['a'] }, { code: 'BAD CODE' }, null]);
  assert.equal(l.length, 1); assert.equal(l[0].monthly, 4999); assert.equal(l[0].id, undefined); assert.equal(l[0].rzp_monthly, undefined);
  assert.deepEqual(PC.plansOr([]).map((p) => p.code), ['starter', 'studio', 'enterprise']);
  const cat = PC.CATALOG; assert.equal(cat[0].monthly, 1999); assert.equal(cat[0].yearly, 19990); assert.equal(cat[1].monthly, 4999); assert.equal(cat[1].yearly, 49990);
  assert.equal(cat[2].monthly, null);
  assert.match(read('public/pricing.html'), /&#8377;1,999<\/b>/); assert.match(read('public/pricing.html'), /&#8377;4,999<\/b>/);   // the pricing page shows the same numbers
  assert.match(CO, /monthly: 1999, yearly: 19990/); assert.match(CO, /monthly: 4999, yearly: 49990/);
});
t('plan cards: Pay now is the primary; an on-request plan gets Contact sales as primary; trial only when offered', () => {
  const studio = PC.plansOr([])[1], ent = PC.plansOr([])[2];
  assert.deepEqual(PC.actionsFor(studio, { interval: 'monthly', trial: true }), { pay: true, trial: true, sales: true, primary: 'pay' });
  assert.deepEqual(PC.actionsFor(ent, { interval: 'monthly', trial: false }), { pay: false, trial: false, sales: true, primary: 'sales' });
  assert.equal(PC.actionsFor({ code: 'm', monthly: 10, yearly: null, features: [] }, { interval: 'yearly' }).pay, false, 'not offered yearly');
  assert.equal(PC.priceText(studio, 'monthly').unit, '/month'); assert.match(PC.priceText(studio, 'yearly').sub, /a month, plus GST/);
  assert.equal(PC.priceText(ent, 'monthly').main, 'Price on request');
  assert.equal(PC.pickPlan(PC.plansOr([]), 'starter'), 'starter'); assert.equal(PC.pickPlan(PC.plansOr([]), 'nope'), 'studio', 'recommended = middle');
  const src = read('public/plan-cards.js');
  assert.match(src, /btn\("pc-btn pc-pay", o\.payLabel \|\| "Pay now"/); assert.match(src, /"pc-btn pc-trial", "Try free for "/); assert.match(src, /btn\("pc-link", "Contact sales"/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\./.test(src), 'CSP-safe DOM');
  const css = read('public/plan-cards.css');
  assert.match(css, /\.plan-acts \.pc-pay\{background:var\(--accent/); assert.match(css, /min-height:46px/); assert.match(css, /\.pc-link\{[^}]*min-height:44px/);
});

/* ---------------- sign-up flow (pure) ---------------- */
t('intent: ?plan&mode deep links, the old ?trial=1 / ?direct=1 links, a remembered choice (2 days)', () => {
  const now = Date.now();
  assert.deepEqual(SF.intentFrom('?plan=studio&mode=paid', '', null, now), { plan: 'studio', mode: 'paid', signup: true, fromUrl: true });
  assert.equal(SF.intentFrom('?trial=1', '#signup', null, now).mode, 'trial');
  assert.equal(SF.intentFrom('?direct=1', '#signup', null, now).mode, 'paid');
  assert.equal(SF.intentFrom('?plan=<x>&mode=evil', '', null, now).plan, '');
  assert.equal(SF.intentFrom('?plan=<x>&mode=evil', '', null, now).mode, '');
  const st = JSON.stringify({ plan: 'starter', mode: 'sales', t: now - 3600e3 });
  assert.deepEqual(SF.intentFrom('', '', st, now), { plan: 'starter', mode: 'sales', signup: false, fromUrl: false });
  assert.equal(SF.intentFrom('', '', JSON.stringify({ plan: 'starter', mode: 'paid', t: now - 3 * 86400e3 }), now).plan, '', 'expires');
  assert.equal(SF.intentFrom('', '#signup', null, now).signup, true);
});
t('studio step: name required (2-80), link preview follows the server slug rule, team size / event types whitelisted', () => {
  assert.equal(SF.slugify('Aurora Events!'), 'aurora-events'); assert.equal(SF.slugify('A'), 'a-studio'); assert.equal(SF.slugify('***'), 'studio');
  assert.equal(SF.slugify('x'.repeat(60)).length, 36);
  const v = SF.detailsCheck({ name: '  Aurora  Events ', city: ' Hyderabad ', teamSize: '2-5', eventTypes: ['wedding', 'rave', 'wedding', 'corporate'] });
  assert.equal(v.ok, true); assert.deepEqual(v.clean, { name: 'Aurora Events', city: 'Hyderabad', teamSize: '2-5', eventTypes: ['wedding', 'corporate'] });
  assert.equal(SF.detailsCheck({ name: 'A' }).ok, false); assert.equal(SF.detailsCheck({ name: 'x'.repeat(81) }).ok, false);
  assert.equal(SF.detailsCheck({ name: 'Ok name', teamSize: '7' }).clean.teamSize, '');
  // the same codes as the database check (studio_account_event_types_ck = venues.event_types)
  SF.EVENT_TYPES.forEach(([c]) => assert.ok(SQL.includes("'" + c + "'"), c));
  SF.TEAM_SIZES.forEach(([c]) => assert.ok(SQL.includes("'" + c + "'"), c));
});
t('Terms: agreed in this browser (stash) or on the account (sign-up note) -> recorded silently; else asked again', () => {
  const now = Date.now();
  assert.equal(SF.agreedEarlier(JSON.stringify({ t: now - 1000, src: 'google' }), {}, now), 'google');
  assert.equal(SF.agreedEarlier(null, { helm_terms_agreed_at: new Date(now - 3600e3).toISOString() }, now), 'signup');
  assert.equal(SF.agreedEarlier(null, {}, now), '');
  assert.equal(SF.agreedEarlier(JSON.stringify({ t: now - 3 * 86400e3 }), {}, now), '');
});
t('first run: a PAID studio opens the setup wizard once (never a trial, never after the wizard started)', () => {
  const org = { brand: {} }, paid = { signup_source: 'direct' };
  assert.equal(SF.firstRun(org, paid, false), 'onboarding.html?fresh=1');
  assert.equal(SF.firstRun(org, paid, true), null);
  assert.equal(SF.firstRun(org, { signup_source: null }, false), null);
  assert.equal(SF.firstRun({ brand: { onboarding: { step: 'billing' } } }, paid, false), null);
  assert.equal(SF.firstRun({ brand: { onboarding: { completed_at: 'x' } } }, paid, false), null);
  assert.equal(SF.checkoutHref('studio', 'yearly', false), '/checkout?next=onboarding.html%3Ffresh%3D1&plan=studio&interval=yearly');
  assert.match(SF.checkoutHref('enterprise', 'monthly', true), /&sales=signup$/);
  assert.ok(!/plan=/.test(SF.checkoutHref('<x>', 'monthly', false)));
  assert.match(API, /"onboarding", "ops", "plan",/, 'safeNext allows the wizard as ?next=');
});
t('server answers in plain words: trial already used (auditor #3), limit, Terms, operator', () => {
  assert.equal(SF.startError({ hint: 'trial_used', message: 'x' }).kind, 'trial_used');
  assert.match(SF.startError({ message: 'You have already used your free Helm trial with this email.' }).text, /Pay now/);
  assert.equal(SF.startError({ hint: 'rate_limited' }).kind, 'rate_limited');
  assert.equal(SF.startError({ hint: 'terms_required' }).kind, 'terms');
  assert.equal(SF.startError({ message: "Helm HQ accounts can't create or join a studio." }).kind, 'operator');
  const src = read('public/signup-flow.js');
  assert.match(src, /if \(x\.kind === "trial_used"\)/, 'the trial button is switched off, Pay now stays');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\./.test(src), 'CSP-safe DOM');
});

/* ---------------- login page ---------------- */
t('login: sign in only - no tab switcher; "New to Helm? Create your studio" link; old links open the sign-up', () => {
  assert.doesNotMatch(LOGIN, /class="modetabs"/); assert.doesNotMatch(LOGIN, /data-mode="signup"/);
  assert.match(LOGIN, /New to Helm\? <a href="\/signup" id="createLink">Create your studio &rarr;<\/a>/);
  assert.match(LOGIN, /id="haveAcct" hidden>Already have a Helm account\?/);
  assert.match(LOGIN, /BPSignupFlow\.intent\(\)\.signup\)\)\{ setMode\("signup"\); \}/);
  assert.match(LOGIN, /<script src="\/plan-cards\.js\?v=\d+"><\/script>\n<script src="\/signup-flow\.js\?v=\d+"><\/script>/);
  assert.match(LOGIN, /<link rel="stylesheet" href="\/plan-cards\.css\?v=\d+">/);
  assert.match(TSU, /setText\("#formTitle", "Create your Helm account"\);/);
});
t('login step 1: Terms checkbox required (e-mail and Google), the account carries the "agreed" note, no studio name', () => {
  assert.match(LOGIN, /<input type="checkbox" id="agree" aria-describedby="agree_err"><span>I agree to the <a href="\/terms"[^>]*>Terms of Service<\/a> and the <a href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  assert.match(LOGIN, /if\(!agreeOk\(\)\) return;\n          const existing=BPStore\.auth\.user\(\);/);
  assert.match(LOGIN, /if\(mode==="signup" && !J\(\)\)\{ if\(!agreeOk\(\)\) return; if\(window\.BPSignupFlow\) BPSignupFlow\.stashTerms\("google"\); \}/);
  assert.match(LOGIN, /termsAgreed:true, plan:want\.plan, mode:want\.mode\}\);/);
  assert.match(API, /if \(opts && opts\.termsAgreed === true\) so\.data = Object\.assign\(\{\}, so\.data \|\| \{\}, \{ helm_terms_agreed_at: new Date\(\)\.toISOString\(\) \}\);/);
  assert.match(LOGIN, /const ids = mode==="signup" \? \["fullname","email","pw"\] : \["email","pw"\];/);
  assert.match(LOGIN, /\$\("#studioField"\)\.hidden = true;/);
});
t('login: a confirm link never creates a studio by itself (auditor #1) - steps 3 + 4 decide paid / trial', () => {
  assert.match(LOGIN, /async function finishPendingStudio\(\)\{ return; \}/);
  assert.doesNotMatch(LOGIN, /helm_signup_intent==="trial"\) name=/);
  assert.match(LOGIN, /Step 2 of 4 &middot; Verify your e-mail/); assert.match(LOGIN, /Step 3 of 4 &middot; Your studio/); assert.match(LOGIN, /Step 4 of 4 &middot; How to start/);
  assert.match(LOGIN, /<p class="hint slugline" id="ob_slug_l">Your studio link: <b id="ob_slug">/);
  assert.match(LOGIN, /<select id="ob_team"><\/select>/); assert.match(LOGIN, /<div class="chips" id="ob_types"><\/div>/);
  assert.match(LOGIN, /<section class="card start" id="startCard" hidden/);
  assert.match(LOGIN, /\["#loginForm","#forgotForm","#mfaForm","#mfaSetupForm","#onboardForm","#startCard",/);
  assert.match(LOGIN, /const first=oid \? await firstRunPage\(\) : null;/);
  assert.match(LOGIN, /routeIfRequired\(first\|\|nextUrl\(\)\)\) return;/);
  assert.match(LOGIN, /body\.su-wide\{grid-template-columns:1fr\} body\.su-wide \.brandpane\{display:none\}/);
});
t('sign-up step 4 actions: Try free = the ONE trial; Pay now / Contact sales = paid studio -> /checkout', () => {
  const src = read('public/signup-flow.js');
  assert.match(src, /await global\.BPTrialSignup\.start\(d\.name\);/);
  assert.match(src, /B\.signup\.createDirect\(\{ name: d\.name, plan: p\.code, interval: st\.interval, termsVersion: st\.termsVersion \}\)/);
  assert.match(src, /global\.location\.replace\(checkoutHref\(p\.code, st\.interval, kind === "sales"\)\);/);
  assert.match(src, /if \(await B\.auth\.operatorToHq\(\)\) return;/);
  assert.match(API, /rpc\("create_direct_studio", \{ p_name: name/); assert.match(API, /rpc\("accept_account_terms", \{ p_version:/);
  assert.match(API, /rpc\("signup_plan_options", \{\}\)/); assert.match(API, /rpc\("my_studio_signup_details", \{/);
  assert.match(API, /rpc\("studio_slug_pick", \{ p_name:/);
});

/* ---------------- checkout ---------------- */
t('checkout: every card has Pay now / (Try free) / Contact sales; the plan from the sign-up is pre-picked', () => {
  assert.match(CO, /window\.HelmPlanCards\.actions\(p, \{ interval: st\.interval,\n\s+trial: st\.pending && !st\.live && !st\.upgrade/);
  assert.match(CO, /var pick = pickFrom\(location\.search, list\);/);
  assert.match(CO, /sales=signup/);
  assert.match(COH, /<script src="\/plan-cards\.js\?v=\d+"><\/script>\n<script src="trial-upgrade\.js\?v=\d+"><\/script>\n<script src="checkout\.js/);
});
t('checkout: Pay now = online payment when live, else UPI / bank + "Payment pending" (never a fake success)', () => {
  assert.match(CO, /if \(st\.live && !st\.catalog\) \{ submit\(\); return; \}/);
  assert.match(COH, /<div class="alert info" id="coPayPending" role="status" hidden><b>Payment pending\.<\/b>/);
  assert.match(COH, /id="coPaid">I've paid &mdash; send the payment reference<\/button>/);
  assert.match(CO, /Payment reference \(UTR\)/);
  assert.match(COH, /id="coPendingNote" role="status" hidden>Your studio is ready and waiting for its first payment\./);
  assert.doesNotMatch(CO, /Payment received[^"]*"\s*,\s*"ok"\);\s*\n\s*\/\/ r22/);
});
t('checkout: Terms always shown + recorded before Pay now / Contact sales / trial (auditor #4)', () => {
  assert.match(CO, /\$\("#coTermsCard"\)\.hidden = false;/);
  assert.match(CO, /await S\.subscription\.updateAccount\(\{ terms_version_accepted: v \}\);/);
  assert.match(CO, /if \(!\(await recordTerms\(\)\)\) \{ showErr\("Please accept the Terms to continue\."\); return; \}\n    openSales\(\);/);
  assert.match(CO, /if \(!\(await recordTerms\(\)\)\) \{ \$\("#coSwitchMsg"\)\.textContent = "Please accept the Terms first\."; return; \}\n    switchToTrial\(\);/);
});
t('deep links: /signup?plan=<plan>&mode=trial|paid|sales (the pricing / landing contract) keeps its query and opens the sign-up', () => {
  const now = Date.now();
  assert.deepEqual(SF.intentFrom('?signup=1&plan=studio&mode=paid', '', null, now), { plan: 'studio', mode: 'paid', signup: true, fromUrl: true });
  assert.deepEqual(SF.intentFrom('?plan=enterprise&mode=sales&signup=1', '', null, now), { plan: 'enterprise', mode: 'sales', signup: true, fromUrl: true });
  assert.equal(SF.intentFrom('?signup=1', '', null, now).signup, true);
  // /signup is a REAL page: Vercel rewrites it to the sign-in page (same CSP / no-store headers), the query stays put
  assert.equal(SF.onSignupPath('/signup'), true); assert.equal(SF.onSignupPath('/login'), false);
  const V = JSON.parse(read('vercel.json'));
  assert.ok(V.rewrites.some((r) => r.source === '/signup' && r.destination === '/login'));
  assert.ok(!(V.redirects || []).some((r) => r.source === '/signup'), 'no redirect any more');
  assert.ok(V.headers.some((h) => h.source === '/(login|reset-password|signup)'), 'the login CSP covers /signup');
  assert.match(read('public/_headers'), /\n\/signup\n  ! Content-Security-Policy\n/);
  assert.match(read('server.js'), /if \(rel === '\/signup'\) return serveFile\(res, req, path\.join\(PUBLIC_DIR, 'login\.html'\)\);/);
  assert.match(read('scripts/csp-hashes.cjs'), /const AUTH_ROUTE = \/\(\^\|\\\/\|\\\(\)\(login\|reset\|signup\)\//);
  // mode=sales: one clear "Contact sales about <plan>" button on step 4 -> the saved contact-sales form
  assert.match(read('public/signup-flow.js'), /if \(m === "sales"\) salesPrompt\(\);/);
  assert.match(read('public/signup-flow.js'), /b\.addEventListener\("click", function \(\) \{ go\("sales", plan, null\); \}\);/);
  assert.match(read('public/config.js'), /allowPaymentBypass: !\/\^\(www\\\.\)\?helm\\\.events\$\//, 'auditor #10: the testing bypass is never on helm.events');
});

/* ---------------- SQL 0255 ---------------- */
t('0255: ASCII, additive (no DROP / DELETE / TRUNCATE), canonical header, wrappers renamed once, VERIFY rows', () => {
  assert.ok(!/[^\x00-\x7f]/.test(SQL)); assert.ok(!/[^\x00-\x7f]/.test(APPLY));
  assert.ok(!/\b(drop\s+(table|column|function|trigger)|truncate|delete\s+from)\b/i.test(SQL.replace(/--[^\n]*/g, '')));
  assert.match(SQL, /^-- 0255_create_studio_signup\.sql - CANONICAL forward-only\./);
  for (const f of ['create_studio', 'start_self_serve_trial', 'my_pending_start_trial', 'request_plan_activation'])
    assert.match(SQL, new RegExp("if to_regprocedure\\('public\\." + f + "__pre0255\\("), f);
  assert.match(SQL, /create table if not exists public\.account_terms_acceptances/); assert.match(SQL, /enable row level security/);
  assert.match(SQL, /hint = 'terms_outdated'/); assert.match(SQL, /hint = 'terms_required'/);
  assert.match(SQL, /v_consent := tg_table_name = 'studio_consent_log' and tg_op = 'INSERT' and v_uid is not null and v_new ->> 'actor' = v_uid;/);
  assert.match(SQL, /if tg_op = 'INSERT' and new\.trial_ends_at is null and new\.trial_source is null\n\s+and new\.current_period_start is null and new\.current_period_end is null then return null; end if;/);
  assert.match(SQL, /'Helm HQ accounts can''t create or join a studio\.'/);
  assert.match(SQL, /x - 'id' - 'rzp_monthly' - 'rzp_yearly'/, 'no Razorpay ids to the sign-up page');
  assert.match(APPLY, /^-- APPLY-0255\.sql[\s\S]*?\nbegin;\n/); assert.ok(APPLY.includes(SQL.trim())); assert.match(APPLY, /commit;\s*\n\s*-- VERIFY/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0255_create_studio_signup\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /R22-CREATE-STUDIO-0255: ALL PASS/);
  assert.match(read('package.json'), /node test\/r22-create-studio\.test\.mjs/);
});
console.log(n + ' passed');
