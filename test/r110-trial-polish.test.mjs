// r110-trial-polish.test.mjs - R110 (free-trial E2E run, testing/phase2/TRIAL-E2E-REPORT.md): trial leads made from a
// quote are not lead slots (0320), the billing currency follows the studio's country (0320 + the sign-up plan cards),
// the trial welcome prefills the SAVED location and clears its error, toasts wrap, the privacy hint waits for dialogs,
// the referral block keeps its height, Chat shows the sign-up name (0320), "Save quotation" clears the leave prompt,
// the checkout steps match the sign-up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const SQL = read('supabase/migrations/0320_r110_trial_polish.sql'), MAN = read('supabase/migrations/MANIFEST');
const APPLY = read('supabase/APPLY-0320.sql'), RUNALL = read('scripts/db-test/run-all.sh');
const TD = read('public/trial-demo.js'), API = read('public/store-api.js'), PRIV = read('public/shell-b-privacy.js');
const REF = read('public/referral-signup.js'), FLOW = read('public/flow.html'), CO = read('public/checkout.html');
const SF = read('public/signup-flow.js'), LOGIN = read('public/login.html');
const P = require('../public/plan-cards.js');

t('0320 in MANIFEST once, right after 0319; APPLY-0320 carries the migration verbatim; run-all runs its suite', () => {
  const nums = [...MAN.matchAll(/^forward {2}supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.equal(nums.filter((x) => x === '0320').length, 1);
  assert.equal(nums[nums.indexOf('0320') - 1], '0319');
  assert.ok(APPLY.includes(SQL.trim()), 'APPLY-0320.sql embeds the canonical file unchanged');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.match(RUNALL, /run "r110-trial-polish-0320" "R110-TRIAL-POLISH-0320: ALL PASS \\\(24\/24\\\)"/);
  assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'migration is ASCII only');
});
t('0320 (B2): a lead made from a quote is exempt in the count, the refusals and the log - nothing else', () => {
  assert.match(SQL, /create or replace function public\._r320_quote_lead\(p_org uuid, p_lead uuid, p_source text, p_quote uuid\)/);
  assert.match(SQL, /coalesce\(p_source, ''\) = 'quote'/);
  assert.match(SQL, /not coalesce\(q\.is_demo, false\)/);
  for (const f of ['_tl181_used', '_tl181_tg_cap_check', '_tl181_tg_cap_log', '_tl173_tg_create_cap']) {
    const at = SQL.indexOf('create or replace function public.' + f + '(');
    assert.ok(at > 0, f);
    const body = SQL.slice(at, SQL.indexOf('end $$;', at));
    assert.match(body, /_r320_quote_lead\(/, f + ' uses the exemption');
    assert.match(body, /trial-unify-0236/, f + ' keeps the 0236 marker');
  }
  assert.ok(!/drop (table|column|policy|index|function)/i.test(SQL), 'nothing dropped');
  assert.ok(!/delete from/i.test(SQL), 'no row deleted');
});
t('0320 (B3): never-paid studios follow the country; paying studios never change; welcome fills IN; one-time fix audited', () => {
  assert.match(SQL, /create trigger zzzz_r320_currency_country before insert or update on public\.studio_account/);
  assert.match(SQL, /if not public\._r320_never_paid\(new\.org_id\) then return new; end if;/);
  assert.match(SQL, /sp\.voided_at is null/); assert.match(SQL, /s\.status in \('active', 'past_due'\)/);
  assert.match(SQL, /if new\.billing_currency is distinct from old\.billing_currency then return new; end if;/);
  assert.match(SQL, /alter function public\.trial_welcome_save\(text, text, text, text, text\) rename to trial_welcome_save__pre0320;/);
  assert.match(SQL, /_studio_account_apply\(v_org, jsonb_build_object\('country', 'IN'\)\)/);
  assert.match(SQL, /where a\.billing_currency = 'USD'[\s\S]{0,300}= 'IN'\n\s+and public\._r320_never_paid\(a\.org_id\)/);
  assert.match(SQL, /'reason', 'r110-0320 India studio, never paid'/);
});
t('sign-up plan cards: the step-3 country decides the currency, not the browser clock', () => {
  assert.equal(P.zoneForCountry('IN', 'America/Chicago'), 'Asia/Kolkata');
  assert.equal(P.currencyFor(P.zoneForCountry('IN', 'America/Chicago')), 'INR');
  assert.equal(P.zoneForCountry('US', 'Asia/Kolkata'), 'Etc/UTC');
  assert.equal(P.currencyFor(P.zoneForCountry('US', 'Asia/Kolkata')), 'USD');
  assert.equal(P.zoneForCountry('AE', 'Asia/Dubai'), 'Asia/Dubai');
  assert.equal(P.zoneForCountry('', 'America/Chicago'), 'America/Chicago');
  assert.equal(P.zoneForCountry(null, ''), '');
  assert.match(SF, /if \(P\.zoneForCountry && st\.details && st\.details\.country\) tz = P\.zoneForCountry\(st\.details\.country, tz\);/);
  assert.ok(SF.indexOf('tz = P.zoneForCountry(') < SF.indexOf('B.signup.planOptions(tz)'), 'before the server is asked');
});
t('trial welcome (B4 / B5): fresh saved location; the location error clears and reads as an error', () => {
  assert.match(TD, /BPStore\.org\.current\(\{ fresh: true \}\)/);
  assert.match(TD, /op\.value\.toLowerCase\(\) === stv\.toLowerCase\(\)/);
  assert.match(TD, /fs\.input\.addEventListener\("change", clearLocErr\)/);
  assert.match(TD, /fc\.input\.addEventListener\("input", clearLocErr\)/);
  assert.match(TD, /"\.td-dlg \.td-err\{color:var\(--danger-text,var\(--danger,#b42318\)\);font-weight:600\}"/);
});
t('toasts (B6): a titled toast message wraps instead of being cut off', () => {
  assert.match(API, /"\.bpui-toast\.has-title \.bpui-toast-msg\{white-space:normal;overflow-wrap:anywhere\}"/);
  assert.ok(!/\.bpui-toast\.has-title \.bpui-toast-msg\{overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/.test(API));
});
t('referral (B7): the block keeps its height until the code is typed again', () => {
  assert.match(REF, /function settle\(\) \{[^\n]*row\.style\.minHeight = heldH \+ "px"/);
  assert.match(REF, /inp\.addEventListener\("input", function \(\) \{ release\(\);/);
  assert.equal((REF.match(/settle\(\); return;/g) || []).length, 4, 'every early return settles');
  assert.match(LOGIN, /id="rfsMsg"/);
});
t('privacy hint (B9): waits while a dialog is open, hides when one opens', () => {
  assert.match(PRIV, /function dialogOpen\(\) \{[^\n]*dialog\[open\]/);
  assert.match(PRIV, /if \(dialogOpen\(\)\) \{ if \(hintWait\+\+ < 120\) setTimeout\(hint, 1500\); return; \}\n\s+ls\(HINT_K, "1"\);/);
  assert.match(PRIV, /if \(dialogOpen\(\)\) gone\(\);/);
});
t('chat (B10a): the sign-up name before the e-mail prefix (0320 chat_directory)', () => {
  assert.match(SQL, /coalesce\(nullif\(btrim\(b\.full_name\), ''\), public\._r320_signup_name\(b\.id\)\) end,/);
  assert.match(SQL, /raw_user_meta_data ->> 'full_name'/);
  assert.match(SQL, /'\[\\x00-\\x1f\\x7f<>\]', ' ', 'g'\), '\\s\+', ' ', 'g'\)\), 50\)/);
});
t('quote flow (B10b): a successful Save quotation clears the leave prompt unless another card is unsaved', () => {
  assert.match(FLOW, /let dirtyOther=false;/);
  assert.match(FLOW, /if\(!\(card && card\.querySelector\("#sv-quote"\)\)\) dirtyOther=true;/);
  assert.match(FLOW, /renderReprice\(\);\n\s+if\(!dirtyOther\) dirty=false;/);
  assert.match(FLOW, /if\(ok\)\{ dirty=false; dirtyOther=false;/);
});
t('checkout steps (B10c) = the sign-up steps', () => {
  const labels = [...CO.matchAll(/<span class="lbl">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Account', 'Verify', 'Studio', 'How to start']);
  assert.match(LOGIN, /Step 4 of 4 &middot; How to start/);
});
t('sign-up (staging admin run): step-3 answers survive a reload (name too); a reload on step 4 returns to step 4', () => {
  assert.match(SF, /if \(s\.name && \$\("#ob_name"\) && !\$\("#ob_name"\)\.value\) \$\("#ob_name"\)\.value = String\(s\.name\)\.slice\(0, 80\);/);
  assert.match(SF, /f\.addEventListener\("input", function \(\) \{ draftSave\(\{ at4: false \}\); \}\);/);
  assert.match(SF, /ssSet\(DETAILS_KEY, JSON\.stringify\(Object\.assign\(\{\}, v\.clean, \{ at4: true \}\)\)\);/);
  assert.match(SF, /if \(saved && saved\.at4 === true && st\.termsOk\) \{/);
  assert.match(SF, /d0\.at4 = false;/);
});
t('client approval terms (India): no "payment link" wording; terms id v3-2026-10', () => {
  const AP = read('public/approve.html');
  assert.match(AP, /const TERMS_VERSION="v3-2026-10";/);
  assert.ok(!/against the payment link/.test(AP));
  assert.match(AP, /Your booking is confirmed only once your payment is received \(paid online, or recorded by your planner\)\./);
});
console.log('r110-trial-polish: ' + n + ' passed');
