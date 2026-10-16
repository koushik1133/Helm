// 0119 — ONE 8-day self-serve trial + the sign-up / theme / menu / redirect fixes that ship with it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/0119_unified_trial.sql');
const APPLY = read('supabase/APPLY-0119.sql'), VERIFY = read('supabase/VERIFY-0119.sql');
const LOGIN = read('public/login.html'), API = read('public/store-api.js'), AUI = read('public/auth-ui.js');
const TSU = read('public/trial-signup.js'), SHELL = read('public/shell-b.css');
const signup = require('../public/trial-signup.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fnBody = (sql, name) => { const at = sql.indexOf(`function public.${name}(`); assert.ok(at >= 0, name); return sql.slice(at, sql.indexOf('end $$;', at)); };

t('SQL additive: no drop / delete / truncate / rename / destructive alter; existing rows untouched', () => {
  const c = code(MIG).toLowerCase();
  assert.ok(!/\bdrop\s+(table|column|function|trigger|index|policy|view|schema|constraint)\b/.test(c), 'no DROP');
  assert.ok(!/\bdelete\s+from\b/.test(c) && !/\btruncate\b/.test(c), 'no DELETE / TRUNCATE');
  assert.ok(!/alter\s+function[^;]*rename/.test(c), 'no renames');
  assert.ok(!/alter\s+table[^;]*\b(drop|rename|alter\s+column|type)\b/.test(c), 'no destructive ALTER');
  for (const u of c.match(/update public\.[a-z_]+ [a-z]* ?set[^;]*;/g) || []) assert.match(u, /where\s+(o\.)?id = v_org/, u);
  assert.match(MIG, /add column if not exists trial_days integer not null default 8;/);
  assert.match(MIG, /check \(trial_days between 1 and 60\)/);
  assert.ok(!/update public\.helm_billing_settings/i.test(code(MIG)), 'trial length comes from the column default only');
});
t('start_self_serve_trial: has_studio first, own name or Demo N, validated locale, 8 days, demo seed only for demo', () => {
  const b = fnBody(MIG, 'start_self_serve_trial');
  assert.ok(b.indexOf("'has_studio'") < b.indexOf('create_studio('), 'existing studio returned before anything is created');
  assert.match(b, /v_mode not in \('demo', 'own'\)/);
  assert.match(b, /char_length\(v_name\) < 2 or char_length\(v_name\) > 80/);
  assert.match(b, /if v_name is null then[\s\S]*pg_advisory_xact_lock\(hashtextextended\('helm:start_trial:demo_n'[\s\S]*_trial_next_demo_number\(\)/);
  assert.match(b, /pg_timezone_names/);
  assert.match(b, /make_interval\(days => public\._trial_days\(\)\)/);
  assert.match(b, /o\.created_by is distinct from v_uid or o\.trial_ends_at is not null/);
  assert.match(b, /if v_mode = 'demo' then[\s\S]*_demo_seed\(v_org\)[\s\S]*_trial_seed_extra\(v_org\)[\s\S]*end if;/);
  assert.match(b, /on conflict \(org_id\) do nothing/);
  assert.match(MIG, /revoke all on function public\.start_self_serve_trial\(text, text, text, text\) from public, anon;/);
  assert.match(MIG, /revoke all on function public\._trial_days\(\) from public, anon, authenticated;/);
});
t('old entry points + checkout use the one length (no hard-coded 14 left)', () => {
  assert.match(fnBody(MIG, 'start_trial'), /start_self_serve_trial\(null, 'Asia\/Kolkata', 'INR', 'demo'\)/);
  assert.match(MIG, /start_self_serve_trial\(null, p_timezone, p_currency, 'demo'\)/);
  assert.ok(!/\+ 14\b|'14 days'|'trial_days', 14/.test(code(MIG)));
  assert.match(fnBody(MIG, 'my_start_trial'), /v_days integer := public\._trial_days\(\)/);
  assert.match(fnBody(MIG, 'my_start_trial'), /o\.created_at >= b\.checkout_required_after/);
  assert.match(fnBody(MIG, 'checkout_attach_subscription'), /current_date \+ public\._trial_days\(\)/);
  assert.match(fnBody(MIG, 'my_checkout_options'), /'trial_days', public\._trial_days\(\)/);
  assert.match(fnBody(MIG, 'my_trial_org'), /'trial_mode', o\.trial_mode/);
});
t('security alert: no "Member role changed" for a first role (studio creation / joining)', () => {
  const b = fnBody(MIG, 'tg_sa54_profile');
  assert.match(b, /old\.org_id is not null and old\.org_id = new\.org_id\s+and old\.role is distinct from new\.role/);
  assert.match(b, /'member_removed'/);
});
t('APPLY = migration + verify; VERIFY read-only', () => {
  assert.ok(APPLY.includes(MIG.trim()));
  assert.ok(APPLY.includes(VERIFY.trim()));
  assert.ok(!/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i.test(code(VERIFY)));
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0119_unified_trial\.sql/);
});
t('front end: every sign-up = the trial; choice first; optional name; old copy gone', () => {
  assert.match(API, /rpc\("start_self_serve_trial", \{ p_name: name, p_timezone: o\.timezone \|\| null, p_currency: o\.currency \|\| null, p_mode: mode \}\)/);
  assert.match(LOGIN, /BPTrialSignup\.start\(name,opts\|\|\{\}\)/);
  assert.match(LOGIN, /if\(!n && TRIAL\(\)\) return null;/);
  assert.match(TSU, /How would you like to start\?/);
  assert.match(TSU, /Try with demo data/); assert.match(TSU, /Start with my own data/);
  assert.ok(TSU.indexOf('await chooseStart()') < TSU.indexOf('startSelfServe('), 'choice before the studio is created');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"|eval\(|new Function/.test(TSU));
  for (const f of ['public/checkout.js', 'public/checkout.html', 'public/trial-demo.js', 'public/hq.html']) assert.ok(!/14-day/.test(read(f)), f);
  assert.equal(signup.localeFor('Asia/Kolkata'), 'INR'); assert.equal(signup.localeFor('Nowhere/X'), 'USD');
});
t('pre-dashboard pages are the light emerald sign-in look', () => {
  for (const f of ['profile-setup.html', 'onboarding.html', 'checkout.html']) {
    const h = read('public/' + f);
    assert.match(h, /<script src="\/marketing-theme\.js\?v=3"><\/script>/, f);
    assert.ok(!/public-theme\.js/.test(h), f);
  }
});
t('emergency contact hidden for the studio owner / admin on first setup only', () => {
  assert.match(read('public/profile-setup.html'), /hideEmergency=\/\^\(admin\|owner\)\$\/i\.test\(role\)/);
  assert.match(AUI, /var noEmerg = !!o\.hideEmergency && !eFilled;/);
});
t('another studio\'s link silently opens your own dashboard', () => {
  const ns = API.slice(API.indexOf('function notYourStudio'), API.indexOf('async function refToId'));
  assert.match(ns, /if \(own\) \{ try \{ location\.replace\(HelmUrl\.build\("dashboard", \{ studio: own \}\)\); return; \}/);
});
t('account menu: opaque, above the floating notes, and a press inside it never closes it first', () => {
  assert.match(AUI, /\(menu\.pop && menu\.pop\.contains\(t\)\) \|\| \(menu\.btn && menu\.btn\.contains\(t\)\)/);
  assert.match(AUI, /classList\.add\("hau-menu-open"\)/); assert.match(AUI, /classList\.remove\("hau-menu-open"\)/);
  assert.match(SHELL, /html\[data-shell="b"\]\.hau-menu-open \.hb-rail, html\[data-shell="b"\] \.hb-rail:has\(\.hau-menu:not\(\[hidden\]\)\) \{ z-index: 2000 !important; \}/);
});
console.log(`\n${n} passed`);
