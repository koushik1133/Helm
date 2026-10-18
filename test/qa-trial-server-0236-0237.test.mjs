// QA of the release build (local, staging data) - free-trial server fixes, one guard per bug:
//   B1  one meaning of "in the free trial": _trial_test_mode_ok / my_trial_org / my_trial_access follow the subscription
//       (_tl173_trial_locked) and fall back to the subscription's trial day when organizations.trial_ends_at is empty;
//       organizations.trial_ends_at is NOT back-filled (0183 read-only lock + 0184 retention stay keyed on it)
//   B11 sample data complete: layout v1 for every sample event, floor plans seat the guests, event plans, layout rules,
//       chair / plate types, clone list, my_demo_status counts the sample templates, insert-only for existing trials
//   B12 pkg_settings_set + comms_settings_set + sample clear / reset / switch wrapped with the trial guard; the
//       Control Center sample card offers no Reset / Clear during the trial
//   B13 the staff cap does not count a crew_members row linked to a login (the admin's own row)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const ascii = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
const M36 = read('supabase/migrations/0236_trial_definition_unify.sql');
const M37 = read('supabase/migrations/0237_trial_seed_completeness.sql');
const body = (src, fn) => { const m = src.match(new RegExp('create or replace function public\\.' + fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\([\\s\\S]*?\\n\\$\\$;|create or replace function public\\.' + fn + '\\([\\s\\S]*?end \\$\\$;')); assert.ok(m, fn + ' not found'); return m[0]; };

t('both migrations: ASCII, additive (no drop / truncate / delete / alter table)', () => {
  for (const s of [M36, M37]) {
    assert.ok(ascii(s), 'ASCII only');
    const code = s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');   // ROLLBACK notes are comments
    assert.doesNotMatch(code, /\b(drop\s+(table|function|column|policy|trigger)|truncate|delete\s+from|alter\s+table)\b/i);
  }
});

t('B1: test mode = the caps / lockdown definition (subscription), with the trial end incl. checkout-started trials', () => {
  const f = body(M36, '_trial_test_mode_ok');
  assert.match(f, /public\._tl173_trial_locked\(p_org\)/);
  assert.match(f, /not public\._trial_locked\(p_org\)/);
  assert.match(f, /coalesce\(public\._tu236_trial_end\(p_org\) > now\(\), true\)/);
  assert.doesNotMatch(f, /o\.trial_ends_at is not null and o\.trial_ends_at > now\(\)/, 'no longer keyed on organizations.trial_ends_at');
  const e = body(M36, '_tu236_trial_end');
  assert.match(e, /coalesce\(public\._trial_effective_end\(p_org\),[\s\S]*s\.trial_ends_at \+ 1\)::timestamp at time zone 'UTC'/);
});
t('B1: my_trial_org / my_trial_access: a studio without organizations.trial_ends_at is a trial when its subscription is', () => {
  for (const fn of ['my_trial_org', 'my_trial_access']) {
    const f = body(M36, fn);
    assert.match(f, /\(o\.trial_ends_at is null and not public\._tl173_trial_locked\(v_org\)\)/, fn);
    assert.match(f, /v_end := public\._tu236_trial_end\(v_org\);/, fn);
    assert.match(f, /'ended', coalesce\(v_end <= now\(\), false\)/, fn);
  }
});
t('B1: no back-fill of organizations.trial_ends_at; the read-only lock / retention functions are not re-issued', () => {
  assert.doesNotMatch(M36, /update\s+public\.organizations/i);
  for (const fn of ['_trial_effective_end', '_trial_locked', '_trial_expired_at', '_trial_retention_block'])
    assert.doesNotMatch(M36, new RegExp('create or replace function public\\.' + fn + '\\('), fn + ' unchanged');
});

t('B12: 8 RPCs wrapped with the 0173 guard, originals kept as __pre0236 without app grants', () => {
  for (const f of ['public.pkg_settings_set(jsonb)', 'public.comms_settings_set(jsonb)', 'public.clear_demo_data()', 'public.clear_sample_data()',
                   'public.reset_demo_data()', 'public.set_trial_mode(text)', 'public.trial_demo_choice(text)', 'public.delete_all_sample_data()'])
    assert.ok(M36.includes("'" + f + "'"), f);
  assert.doesNotMatch(M36, /'public\.seed_demo_data\(\)'/, 'fill-only seed stays available');
  assert.match(M36, /perform public\._tl173_guard\(\);\n  return public\.%I\(%s\);/);
  assert.match(M36, /revoke all on function public\.%I\(%s\) from authenticated', v_name \|\| '__pre0236'/);
});
t('B12: Control Center sample card: no Reset / Clear during the trial; no ?demo=switch clear in the trial', () => {
  const td = read('public/trial-demo.js');
  assert.match(td, /if \(admin && inTrial\) \{ host\.appendChild\(el\("p", "td-safe", TRIAL_KEEP\)\); return; \}/);
  assert.match(td, /if \(inTrial\) \{ host\.appendChild\(el\("p", "td-safe", TRIAL_KEEP\)\); return; \}/);
  assert.match(td, /if \(!inTrial && d\.is_admin && d\.has_demo && \/\[\?&\]demo=\(switch\|fresh\)\\b\/\.test\(q\)\) startFresh\(\{\}\);/);
  for (const p of ['public/control.html', 'public/dashboard.html', 'public/onboarding.html'])
    assert.match(read(p), /<script src="trial-demo\.js\?v=12"><\/script>/, p + ' pin');
});

t('B13: staff cap ignores crew rows linked to a login (count, check, log, 0173 trigger)', () => {
  const u = body(M36, '_tl181_used');
  assert.match(u, /if p_table = 'crew_members' then/);
  assert.match(u, /c\.profile_id is not null/);
  assert.match(u, /x\.profile_id is null/);
  for (const fn of ['_tl181_tg_cap_check', '_tl181_tg_cap_log', '_tl173_tg_create_cap'])
    assert.match(body(M36, fn), /if tg_table_name = 'crew_members' and \(to_jsonb\(new\) ->> 'profile_id'\) is not null then return (new|null); end if;/, fn);
});

t('B11: clone list + settings lists + event plan; one guarded publish; master-only updates; fit keeps other plans', () => {
  assert.match(M37, /'studio_layout_templates',\n\s*'layout_rules', 'chair_types', 'plate_types',\n\s*'leads', 'quotes', 'quote_versions', 'event_discovery', 'event_requirements', 'event_plan',/);
  assert.match(M37, /if exists \(select 1 from public\.helm_trial_seed_manifest m where m\.notes = N\) then return; end if;/);
  assert.equal((M37.match(/perform public\.publish_sample_manifest\(N\)/g) || []).length, 1);
  // every UPDATE is the sample master's (existing trials: insert only)
  for (const m of M37.matchAll(/^\s*update public\.(\w+)[\s\S]*?;$/gm)) assert.match(m[0], /org_id = M\b/, 'update scoped to the master: ' + m[1]);
  assert.match(M37, /'"rows":8,"cols":25'|\{"rows":8,"cols":25\}/);
  assert.match(M37, /\{"rows":8,"cols":22\}/);
  assert.match(M37, /\{"seats":9\}/);
  assert.match(M37, /else p end;/, 'any other plan comes back unchanged');
  assert.equal((M37.match(/'a5a5a5a5-0237-4000-8000-0000000\d{5}'/g) || []).length, 14, '8 layout rules + 3 chair + 3 plate types');
});
t('B11: existing trials get missing rows only (where not exists / empty list); my_demo_status counts sample templates', () => {
  const tr = M37.slice(M37.indexOf('-- ---- 8) existing free-trial studios'));
  assert.match(tr, /join public\.studio_subscriptions s on s\.org_id = x\.id and s\.status = 'trial'/);
  assert.match(tr, /x\.sample_cloned_at is not null/);
  assert.match(tr, /not exists \(select 1 from public\.quote_versions v where v\.quote_id = q\.id\)/);
  assert.match(tr, /not exists \(select 1 from public\.event_plan p where p\.quote_id = q\.id\)/);
  for (const tb of ['layout_rules', 'chair_types', 'plate_types']) assert.ok(tr.includes('if not exists (select 1 from public.' + tb + ' x where x.org_id = o.id) then'), tb);
  assert.doesNotMatch(tr, /\bupdate public\./, 'no trial row updated');
  const d = body(M37, 'my_demo_status');
  assert.match(d, /'layouts',   \(select count\(\*\) from public\.layouts where org_id = v_org and is_demo\) \+ v_tpl\);/);
  assert.match(d, /not t\.archived and t\.name like E'Demo \\u00b7 %'/);
  // review: a sample template alone never turns has_demo / demo_rows on (0175 gave every trial studio one)
  const sum = d.slice(d.indexOf('  select (select count(*) from public.quotes'), d.indexOf('into v_rows'));
  assert.doesNotMatch(sum, /v_tpl/, 'templates are not added to demo_rows / has_demo');
});

t('MANIFEST: 0236 then 0237 (each once); suites registered; paste files carry the migrations; release bundle has them', () => {
  const man = read('supabase/migrations/MANIFEST');
  assert.match(man, /forward  supabase\/migrations\/0236_trial_definition_unify\.sql\n#[^\n]*\nforward  supabase\/migrations\/0237_trial_seed_completeness\.sql\n/);
  const ra = read('scripts/db-test/run-all.sh');
  assert.match(ra, /run "trial-unify-0236" "TRIAL-UNIFY-0236: ALL PASS \\\(38\/38\\\)" psql -q -f tests\/db\/trial-unify-0236\.sql/);
  assert.match(ra, /run "trial-seed-0237" "TRIAL-SEED-0237: ALL PASS \\\(27\/27\\\)" psql -q -f tests\/db\/trial-seed-0237\.sql/);
  for (const [a, m] of [['APPLY-0236.sql', M36], ['APPLY-0237.sql', M37]]) {
    const ap = read('supabase/' + a);
    assert.ok(ascii(ap), a + ' ASCII');
    assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m); assert.match(ap, /-- VERIFY/);
    assert.ok(ap.includes(m.trim()), a + ' carries the migration unchanged');
    assert.doesNotMatch(ap, /\bcreate\s+(temp|temporary)\s+table\b/i); assert.doesNotMatch(ap, /^\s*\\/m);
  }
  // release 1018-b (APPLY-RELEASE-1018.sql, ends at 0205) is in production; 0236 + 0237 ship in APPLY-RELEASE-1018-C.sql
  const rel = read('supabase/APPLY-RELEASE-1018-C.sql');
  assert.ok(rel.indexOf('RELEASE SECTION 03/4: APPLY-0236.sql') > 0 && rel.indexOf('RELEASE SECTION 04/4: APPLY-0237.sql') > rel.indexOf('APPLY-0236.sql'), '0236 then 0237 in the 1018-c paste');
  // older VERIFY rows follow the change (clone list longer; delete_all_sample_data body behind the wrapper)
  assert.match(read('supabase/APPLY-0202.sql'), /array_length\(public\._sample_clone_tables\(\), 1\) >= 25\)/);
  assert.match(read('supabase/APPLY-0185.sql'), /coalesce\(to_regprocedure\('public\.delete_all_sample_data__pre0236\(\)'\), 'public\.delete_all_sample_data\(\)'::regprocedure\)/);
});

console.log('qa-trial-server-0236-0237: ' + n + ' passed');
