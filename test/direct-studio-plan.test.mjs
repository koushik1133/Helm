// 0159 - "Create studio" directly (not a trial) must pick a plan and pay before using Helm.
// Static checks on the migration, APPLY file, checkout page and styles (the behaviour is proven
// against a real Postgres in tests/db/direct-studio-0159.sql and in onboarding-checkout.test.mjs).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = read('supabase/migrations/0159_direct_studio_plan_gate.sql');
const APPLY = read('supabase/APPLY-0159.sql');
const CO = read('public/checkout.js'), COH = read('public/checkout.html'), CSS = read('public/checkout-v2.css');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

t('migration: ASCII, additive, no destructive statements, canonical header', () => {
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
  assert.ok(!/\b(drop\s+(table|column|function|trigger)|truncate|delete\s+from)\b/i.test(SQL.replace(/--[^\n]*/g, '')), 'nothing dropped / deleted');
  assert.match(SQL, /^-- 0159_direct_studio_plan_gate\.sql - CANONICAL forward-only\./);
  assert.match(SQL, /create table if not exists public\.studio_payment_gate/);
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /NO backfill/);
  assert.ok(!/insert into public\.studio_payment_gate[\s\S]{0,200}from public\.organizations o\s*\n\s*on conflict/.test(SQL), 'no backfill of existing studios');
});
t('migration: only NEW direct studios get the marker; the trial path lifts it in the same call', () => {
  const cs = SQL.slice(SQL.indexOf('create or replace function public.create_studio('), SQL.indexOf('-- ---- 2)'));
  assert.match(cs, /if v_had is null and v_org is not null then/);
  assert.match(cs, /o\.created_at = now\(\) and o\.trial_ends_at is null/);
  assert.match(SQL, /alter function public\.create_studio\(text, text, text, text\) rename to create_studio__pre0159/);
  const pend = SQL.slice(SQL.indexOf('function public._studio_payment_pending'), SQL.indexOf('-- ---- 3)'));
  assert.match(pend, /o\.trial_ends_at is null/);
  assert.match(pend, /s\.status = 'trial' and coalesce\(s\.trial_source, ''\) <> 'checkout'/);
  assert.match(pend, /not public\._trial_paid\(p_org\)/);
});
t('migration: the read-only guard keeps the suspended + trial branches and adds payment_pending', () => {
  const g = SQL.slice(SQL.indexOf('create or replace function public.tg_studio_read_only()'), SQL.indexOf('-- ---- 4)'));
  assert.match(g, /hint = 'studio_suspended'/); assert.match(g, /hint = 'trial_ended'/); assert.match(g, /hint = 'payment_pending'/);
  assert.match(g, /'studio_account', 'profiles', 'user_dashboard_prefs', 'notifications', 'organizations'/);
  assert.match(g, /x\.created_at = now\(\)/, 'rows written while the studio is created still go in');
});
t('migration: switch to trial only while payment is off; never creates a payment', () => {
  const f = SQL.slice(SQL.indexOf('function public.my_pending_start_trial()'), SQL.indexOf('-- ---- 7)'));
  assert.match(f, /if coalesce\(b\.online_payments_live, false\) then/);
  assert.match(f, /trial_mode = coalesce\(trial_mode, 'own'\)/);
  assert.ok(!/subscription_payments/.test(f.replace(/--[^\n]*/g, '')), 'no payment rows');
  assert.match(SQL, /grant execute on function public\.my_pending_start_trial\(\) to authenticated;/);
});
t('migration: plans added only when there is no active plan (never changes an existing one)', () => {
  const p = SQL.slice(SQL.indexOf('-- ---- 7)'));
  assert.match(p, /if not exists \(select 1 from public\.helm_plans where active\) then/);
  assert.match(p, /on conflict \(code\) do nothing/); assert.match(p, /on conflict \(plan_id, currency\) do nothing/);
  assert.ok(!/update public\.helm_plan/.test(p));
});
t('APPLY: one transaction around the exact migration + read-only VERIFY; MANIFEST + DB suite listed', () => {
  assert.match(APPLY, /^-- APPLY-0159\.sql[^\n]*\n[^\n]*\nbegin;\n/);
  assert.ok(APPLY.includes(SQL.trim()));
  assert.match(APPLY, /commit;\s*\n\s*-- VERIFY \(read-only\)/);
  assert.match(APPLY, /select item, ok from \(values/);
  assert.ok(!/[^\x00-\x7f]/.test(APPLY));
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0159_direct_studio_plan_gate\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /DIRECT-STUDIO-0159: ALL PASS/);
});
t('checkout: waiting studio sees the team-activation note, Contact sales + free-trial switch (r20: no "being set up" panel)', () => {
  assert.match(COH, /<div class="sales-note" id="coSetup" role="status" hidden>/);
  assert.doesNotMatch(COH, /Payments are being set up/);
  assert.match(COH, /href="mailto:sales@helm\.events\?subject=Activate%20my%20Helm%20plan"/);
  assert.match(CO, /st\.sales = st\.catalog \|\| \(!st\.live && \(st\.upgrade \|\| st\.pending\)\);/);
  assert.match(COH, /id="coSwitchWrap" hidden/); assert.match(COH, /id="coSwitch"/);
  assert.match(CO, /st\.pending = st\.opts\.pending_payment === true;/);
  assert.match(CO, /\$\("#coSwitchWrap"\)\.hidden = !\(st\.pending && !st\.live\);/);
  assert.match(CO, /if \(st\.catalog \|\| \(st\.pending && !st\.live\)\) \{ b\.disabled = true; b\.textContent = "Online payment coming soon"; return; \}/);
  assert.match(CO, /await S\.checkout\.switchToTrial\(\);/);
  assert.match(CO, /if \(st\.busy \|\| !st\.preview \|\| st\.catalog \|\| \(st\.pending && !st\.live\)\) return;/);
});
t('checkout: never "No plans available" when the server has none - display-only catalog, not payable', () => {
  assert.match(CO, /st\.catalog = !\(Array\.isArray\(st\.opts\.plans\) && st\.opts\.plans\.length\);/);
  assert.match(CO, /return l\.length \? l : \(st\.catalog \? CATALOG : l\);/);
  assert.match(CO, /if \(st\.catalog \|\| onRequest\(planBy\(st\.plan\)\)\) \{ st\.preview = null; renderSummary\(\); return; \}/, 'no server preview for catalog / on-request plans');
});
t('checkout: CSP-safe (no inline handlers / styles / HTML sinks), polished sheet loaded last', () => {
  assert.doesNotMatch(COH, /\sstyle="/); assert.doesNotMatch(COH, /\son[a-z]+=/i);
  assert.doesNotMatch(CO, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\./);
  assert.ok(COH.indexOf('/public-pages-v2.css') < COH.indexOf('/checkout-v2.css'), 'loaded after the shared restyle');
  assert.match(COH, /<script src="\/marketing-theme\.js\?v=3"><\/script>/, 'light emerald, no dark mode');
  assert.doesNotMatch(CSS, /prefers-color-scheme: ?dark|data-theme="dark"/, 'no dark mode styles');
  assert.match(CSS, /backdrop-filter/); assert.match(CSS, /-apple-system/);
});
t('sign-in: "Create studio" directly is back (?direct=1), the free trial stays the default', () => {
  const signup = createRequire(import.meta.url)('../public/trial-signup.js');
  const now = Date.now();
  assert.equal(signup.directFrom('?direct=1', null, now), true);
  assert.equal(signup.directFrom('?trial=1', String(now), now), false, 'the trial link wins');
  assert.equal(signup.directFrom('', String(now - 3600e3), now), true, 'remembered across the e-mail confirm');
  assert.equal(signup.directFrom('', String(now - 3 * 86400e3), now), false, 'expires');
  assert.equal(signup.directFrom('', null, now), false, 'default = free trial');
  const TSU = read('public/trial-signup.js'), LOGIN = read('public/login.html');
  assert.match(TSU, /wanted: function \(\) \{ return !direct; \}/);
  assert.match(TSU, /a\.href = direct \? "login\.html\?trial=1#signup" : "login\.html\?direct=1#signup";/);
  assert.match(TSU, /setText\("#formTitle", "Create your studio"\);/);
  assert.match(LOGIN, /BPStore\.org\.createStudio\(name,opts\|\|\{\}\)\.then\(\(r\)=>\{ try\{ if\(window\.BPTrialSignup&&BPTrialSignup\.clearDirect\) BPTrialSignup\.clearDirect\(\); \}catch\(e\)\{\} return r; \}\)/);
  assert.match(LOGIN, /if\(oid && BPStore\.checkout && await BPStore\.checkout\.routeIfRequired\(nextUrl\(\)\)\) return;/, 'new studio → /checkout after sign-up');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\./.test(TSU));
});
console.log(n + ' passed');
