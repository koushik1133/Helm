// "Start free trial" -> "Demo N" studio (0116).
//  * SQL additivity: no DROP / DELETE / TRUNCATE; new column nullable default null; idempotent DDL
//  * start_trial goes through create_studio, advisory lock, never touches an existing studio
//  * read-only guard keeps the 0045 suspended rule and only locks studios with trial_ends_at
//  * Demo N increment logic (JS mirror of _trial_next_demo_number) + banner / intent helpers
//  * CSP: new files build DOM without innerHTML / inline styles; login.html adds no inline style
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/0116_trial_orgs.sql');
const APPLY = read('supabase/APPLY-0116.sql');
const VERIFY = read('supabase/VERIFY-0116.sql');
const LOGIN = read('public/login.html'), API = read('public/store-api.js');
const TJS = read('public/trial.js'), TSU = read('public/trial-signup.js');
const trial = require('../public/trial.js');
const signup = require('../public/trial-signup.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fnBody = (sql, name) => { const at = sql.indexOf(`function public.${name}(`); assert.ok(at >= 0, name); return sql.slice(at, sql.indexOf('end $$;', at)); };

t('SQL is additive: no drop / delete / truncate / destructive alter', () => {
  const c = code(MIG).toLowerCase();
  assert.ok(!/\bdrop\s+(table|column|function|trigger|index|policy|view|schema)\b/.test(c), 'no DROP');
  assert.ok(!/\bdelete\s+from\b/.test(c), 'no DELETE');
  assert.ok(!/\btruncate\b/.test(c), 'no TRUNCATE');
  assert.ok(!/alter\s+table[^;]*\b(drop|rename|alter\s+column|type)\b/.test(c), 'no destructive ALTER');
  assert.ok(!/alter\s+function[^;]*rename/.test(c), 'no renames');
});
t('new column is nullable, default null, idempotent', () => {
  assert.match(MIG, /alter table public\.organizations add column if not exists trial_ends_at timestamptz default null;/);
  assert.match(MIG, /create index if not exists organizations_trial_ends_idx116/);
  assert.ok(!/trial_ends_at\s+timestamptz\s+not null/i.test(MIG));
});
t('every UPDATE is scoped to the new studio and fill-only', () => {
  const ups = code(MIG).match(/update public\.[a-z_]+ set[^;]*;/gi) || [];
  assert.ok(ups.length >= 1);
  for (const u of ups) assert.match(u, /where .*(id = v_org|org_id = p_org)/s, u);
  assert.match(MIG, /update public\.organizations set trial_ends_at = v_end where id = v_org and trial_ends_at is null;/);
  assert.match(MIG, /on conflict \(org_id\) do nothing/);
});
t('start_trial: create_studio path, advisory lock, has_studio short-circuit, grants', () => {
  const b = fnBody(MIG, 'start_trial');
  assert.match(b, /public\.create_studio\(v_name/);
  assert.match(b, /pg_advisory_xact_lock\(hashtextextended\('helm:start_trial:demo_n'/);
  assert.ok(b.indexOf("'has_studio'") < b.indexOf('pg_advisory_xact_lock'), 'existing studio returned before anything is created');
  assert.match(b, /o\.created_by is distinct from v_uid/);
  assert.match(b, /interval '8 days'/);
  assert.match(b, /security definer set search_path = ''/);
  assert.match(MIG, /revoke all on function public\.start_trial\(\) from public, anon;/);
  assert.match(MIG, /grant execute on function public\.start_trial\(\) to authenticated, service_role;/);
  assert.match(MIG, /revoke all on function public\._trial_seed_extra\(uuid\) from public, anon, authenticated;/);
  assert.match(MIG, /revoke all on function public\._trial_next_demo_number\(\) from public, anon, authenticated;/);
});
t('seed failures never block the trial; every sample row is is_demo + "Demo ·"', () => {
  const b = fnBody(MIG, 'start_trial');
  assert.match(b, /begin v_seed := public\._demo_seed\(v_org\);\s*exception when others/);
  const x = fnBody(MIG, '_trial_seed_extra');
  for (const tbl of ['inventory_items', 'vendors', 'crew_members', 'leads', 'quotes']) assert.match(x, new RegExp(`insert into public\\.${tbl}\\(`));
  const names = x.match(/E'Demo (·|\\u00b7) [^']+'/g) || [];
  assert.ok(names.length >= 15, 'demo names');
  assert.ok(!/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(x.replace(/demo\.[a-z]+@example\.com/g, '')), 'only example.com e-mails');
});
t('read-only guard: 0045 suspended rule kept, trial lock only for trial_ends_at studios', () => {
  const g = fnBody(MIG, 'tg_studio_read_only');
  assert.match(g, /not public\._studio_writable\(o\)/);
  assert.match(g, /hint = 'studio_suspended'/);
  assert.match(g, /public\._trial_locked\(o\)/);
  assert.match(g, /'studio_account', 'profiles'/);
  assert.match(g, /errcode = '25006', hint = 'trial_ended'/);
  const l = MIG.slice(MIG.indexOf('function public._trial_locked('), MIG.indexOf('revoke all on function public._trial_locked'));
  assert.match(l, /o\.trial_ends_at is not null and o\.trial_ends_at <= now\(\)/);
  assert.match(l, /<> 'active'/);
  assert.match(l, /not public\._trial_paid\(p_org\)/);
});
t('APPLY = migration body + verify; VERIFY is read-only', () => {
  assert.ok(APPLY.includes(MIG.trim().slice(0, 2000)));
  assert.ok(APPLY.includes('0116 start_trial exists'));
  const v = code(VERIFY).toLowerCase();
  assert.ok(!/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/.test(v), 'VERIFY changes nothing');
});
t('Demo N increment: empty → 1, max + 1, gaps not reused, collisions skipped', () => {
  assert.equal(trial.nextDemoNumber([], []), 1);
  assert.equal(trial.nextDemoNumber(['Demo 1', 'Demo 2'], []), 3);
  assert.equal(trial.nextDemoNumber(['Demo 1', 'Demo 7', 'Acme Events'], []), 8);
  assert.equal(trial.nextDemoNumber(['Demo 3', 'demo 4'], []), 5, 'a case-different "demo 4" name is taken');
  assert.equal(trial.nextDemoNumber(['Demo 2'], ['demo-3', 'demo-4']), 5, 'public link names taken');
  assert.equal(trial.nextDemoNumber(['Demo 01x', 'Demo', 'Demo -1', 'My Demo 9'], []), 1, 'only exact "Demo N" counts');
  assert.equal(trial.nextDemoNumber(['Demo 10', 'Demo 9'], []), 11, 'numeric, not text, max');
});
t('SQL increment matches the JS mirror (same regexp + slug check)', () => {
  const f = MIG.slice(MIG.indexOf('function public._trial_next_demo_number'), MIG.indexOf('revoke all on function public._trial_next_demo_number'));
  assert.match(f, /regexp_match\(o\.name, '\^Demo \(\[0-9\]\{1,9\}\)\$'\)/);
  assert.match(f, /max\(\(m\[1\]\)::bigint\), 0\) \+ 1/);
  assert.match(f, /o\.public_slug = 'demo-' \|\| n::text/);
  assert.match(f, /lower\(btrim\(o\.name\)\) = 'demo ' \|\| n::text/);
});
t('banner spec: days left, ending soon, ended read-only, members get no CTA', () => {
  assert.equal(trial.bannerSpec(null), null);
  assert.equal(trial.bannerSpec({ is_trial_org: false }), null);
  const a = trial.bannerSpec({ is_trial_org: true, days_left: 6, is_admin: true });
  assert.equal(a.title, 'Free trial · 6 days left'); assert.equal(a.cta, 'Choose a plan'); assert.equal(a.locked, false);
  assert.equal(trial.bannerSpec({ is_trial_org: true, days_left: 1, is_admin: true }).tone, 'soon');
  assert.equal(trial.bannerSpec({ is_trial_org: true, days_left: 0 }).title, 'Free trial · ends today');
  const e = trial.bannerSpec({ is_trial_org: true, ended: true, locked: true, is_admin: false });
  assert.equal(e.locked, true); assert.equal(e.cta, null); assert.match(e.body, /data is preserved and available in read-only mode/);   // 0183
});
t('trial intent: ?trial=1 on, ?trial=0 off, stored for 2 days', () => {
  const now = 1_000_000_000_000;
  assert.equal(signup.intentFrom('?trial=1', null, now), true);
  assert.equal(signup.intentFrom('?trial=0', String(now), now), false);
  assert.equal(signup.intentFrom('', String(now - 3600e3), now), true);
  assert.equal(signup.intentFrom('?code=abc', String(now - 3 * 86400e3), now), false);
  assert.equal(signup.intentFrom('', 'junk', now), false);
});
t('login wiring: trial-signup.js loaded, every studio creation goes through makeStudio', () => {
  assert.match(LOGIN, /<script src="\/trial-signup\.js\?v=3"><\/script>/);
  assert.ok(!/BPStore\.org\.createStudio\((studio|name),\s*\{/.test(LOGIN), 'no direct createStudio left');
  assert.equal((LOGIN.match(/await makeStudio\(/g) || []).length, 3);
  assert.match(LOGIN, /BPTrialSignup\.apply\(m, JOINING\)/);
});
t('store-api: trialOrg namespace + banner loader', () => {
  assert.match(API, /start: \(loc\) => \(loc && \(loc\.timezone \|\| loc\.currency\) \? rpc\("start_trial", \{ p_timezone: loc\.timezone \|\| null, p_currency: loc\.currency \|\| null \}\) : rpc\("start_trial", \{\}\)\)/);
  // 0118: the sign-up page sends the visitor's zone + a currency guessed from it
  const SIGN = readFileSync(new URL('../public/trial-signup.js', import.meta.url), 'utf8');
  // 0119: the unified trial sends the visitor's zone + currency to startSelfServe
  assert.match(SIGN, /trialOrg\.startSelfServe\(\{/); assert.match(SIGN, /timezone: opts\.timezone \|\| loc\.timezone, currency: opts\.currency \|\| loc\.currency/);
  const M118 = readFileSync(new URL('../supabase/migrations/0118_trial_locale.sql', import.meta.url), 'utf8');
  assert.match(M118, /pg_timezone_names/);
  assert.match(M118, /revoke all on function public\.start_trial\(text, text\) from public, anon;/);
  assert.match(API, /rpc\("my_trial_org", \{\}\)/);
  assert.match(API, /vendorUrl\("trial\.js\?v=" \+ TRIAL_BANNER_VERSION\)/);
});
t('CSP-safe front end: no innerHTML / inline style / eval in new files', () => {
  for (const [nm, s] of [['trial.js', TJS], ['trial-signup.js', TSU]]) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"|eval\(|new Function/.test(s), nm);
  }
});
console.log(`\n${n} passed`);
