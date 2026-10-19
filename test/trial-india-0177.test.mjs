// 0177: free trial is India only (INR / Asia/Kolkata) + 2-step welcome; no full studio setup for trials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok ' + n); } catch (e) { fail++; console.log('  FAIL ' + n); console.log(e.message); } };
const TS = read('public/trial-signup.js'), TD = read('public/trial-demo.js'), API = read('public/store-api.js');
t('trial-signup: India locale constants, browser time zone not used', () => {
  const m = require('../public/trial-signup.js');
  assert.equal(m.TRIAL_TZ, 'Asia/Kolkata'); assert.equal(m.TRIAL_CUR, 'INR');
  assert.ok(!/resolvedOptions/.test(TS), 'no browser time zone');
  assert.match(TS, /timezone: loc\.timezone, currency: loc\.currency \}/);
});
t('trial-signup: welcome flag for every mode', () => {
  assert.ok(!/if \(mode === "demo"\) global\.localStorage\.setItem\("bp_trial_welcome"/.test(TS));
  assert.match(TS, /global\.localStorage\.setItem\("bp_trial_welcome", String\(Date\.now\(\)\)\)/);
});
t('login: Google trial onboarding hides currency / time zone and pins INR / Kolkata', () => {
  // r22: the studio step never asks currency / time zone (the trial is pinned to INR / Kolkata by the server; a paid studio sets them in the setup wizard)
  assert.match(read('public/login.html'), /<div class="s-8aed95a" id="obLegacy" hidden>/);
  assert.match(read('public/trial-signup.js'), /var TRIAL_TZ = "Asia\/Kolkata", TRIAL_CUR = "INR";/);
});
t('trial-demo: trial paths go to the dashboard welcome, never onboarding.html', () => {
  assert.ok(!/setMode\("own"\); global\.location\.assign\("onboarding\.html"\)/.test(TD));
  assert.match(TD, /function toWelcome\(\)/);
});
t('onboarding + nav: trial studios redirected / no Studio setup item', () => {
  assert.match(API, /async inTrial\(\)/);
  assert.match(read('public/onboarding.js'), /inTrial\(\)\)\) \{ location\.replace\("dashboard\.html"\)/);
  assert.match(read('public/shell-b.js'), /\[ctl && !inTrial, "setup", "Studio setup"/);
  assert.match(read('public/onboarding-wizard.js'), /S\.trialOrg\.inTrial\(\)\)\) return;/);
});
t('0177 SQL: ASCII, additive, in MANIFEST, APPLY carries the migration verbatim + VERIFY', () => {
  const m = read('supabase/migrations/0177_trial_india_defaults.sql'), a = read('supabase/APPLY-0177.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(m) && /^[\x00-\x7F]*$/.test(a));
  assert.ok(!/\b(drop table|delete from|truncate)\b/i.test(m.replace(/--.*/g, "")));
  assert.ok(a.includes(m)); assert.match(a, /-- VERIFY/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0177_trial_india_defaults\.sql/);
});
if (fail) { console.log('trial-india-0177: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-india-0177: ok');
