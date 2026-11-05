-- r126-hq-fixes-0335.sql -- R126: the HQ walkthrough fixes (read functions only).
-- Proves: (1) structure - nine functions carry the marker, old bodies kept once with no app privilege, helper private;
-- (2) the sample-data master is left out of hq_overview + hq_studios, so tile, list and Studios by plan status agree, and it
-- still opens by id; (3) People: a studio's client logins are not listed, not found by a search, not counted; HQ staff read
-- "HQ Owner" under Helm HQ, a login with no studio reads No studio yet, a team member is unchanged; (4) a studio's People and
-- team size leave client logins out; (5) Show refuses a client login, works for a team member, no log row when refused;
-- (6) Needs attention sends the same exact end + zone as hq_trial_info; (7) job history says why (not_installed, no_history);
-- (8) the activity log names the studio; (9) someone removed from HQ leaves two-step readiness, the allowlist says so;
-- (10) role gates unchanged, nothing written but the HQ view log; (11) re-run safe.
-- Re-applies 0335 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0335_r126_hq_fixes.sql
\ir ../../supabase/migrations/0335_r126_hq_fixes.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.hq(p_email text, p_aal text default 'aal2') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return ''; exception when others then
  get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.staff(p_email text, p_role text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r126 test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
-- a login with a profile in a studio (or none)
create or replace function pg_temp.login(p_email text, p_org uuid, p_role text) returns uuid language plpgsql as $$
declare u uuid; begin
  u := auth.seed_user(p_email);
  insert into public.profiles(id, email, role, org_id) values (u, p_email, p_role, p_org)
    on conflict (id) do update set email = excluded.email, role = excluded.role, org_id = excluded.org_id;
  return u;
end $$;

-- ---- setup ---------------------------------------------------------------------------------------------------------------
do $$ declare o uuid := 'c1260000-0000-4000-8000-000000000001'::uuid; m uuid; begin
  perform pg_temp.staff('r126_owner@hqstaff.test', 'owner');
  perform pg_temp.staff('r126_viewer@hqstaff.test', 'viewer');
  perform pg_temp.staff('r126_gone@hqstaff.test', 'owner');
  perform pg_temp.su();
  update public.platform_admins set status = 'removed', removed_at = now() where email = 'r126_gone@hqstaff.test';
  insert into public.staff_email_allowlist(email, note, added_by) values ('r126_gone@hqstaff.test', 'r126 test', 'r126 test') on conflict do nothing;
  update public.helm_hq_settings set hq_idle_minutes = 30, hq_max_hours = 12, hq_reauth_minutes = 15, hq_ip_allowlist_on = false where id;
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, trial_ends_at)
    values (o, 'R126 Studio', 'INR', 'Asia/Singapore', '{}'::jsonb, 'trial', now() - interval '1 day', date_trunc('day', now()) + interval '3 days 18 hours');
  -- the subscription keeps a bare UTC day, a day behind the exact moment read in the studio's zone: the 7 vs 8 Nov case
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (o, 'trial', (now() + interval '3 days')::date)
    on conflict (org_id) do update set status = 'trial', trial_ends_at = excluded.trial_ends_at;
  perform pg_temp.put('team', pg_temp.login('r126_team@studio.test', o, 'admin')::text);
  perform pg_temp.put('client', pg_temp.login('r126_client@studio.test', o, 'client')::text);
  perform pg_temp.put('nostudio', pg_temp.login('r126_new@studio.test', null, 'client')::text);
  perform pg_temp.put('org', o::text);
  -- the sample master of 0166 exists in every database; make sure of it here
  select id into m from public.organizations where is_sample_master limit 1;
  if m is null then
    insert into public.organizations(id, name, currency, timezone, brand, plan, is_sample_master)
      values ('c1260000-0000-4000-8000-00000000000f'::uuid, 'R126 Master', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'trial', true) returning id into m;
  end if;
  perform pg_temp.put('master', m::text);
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure --------------------------------------------------------------------------------------------------------
do $$ declare f text; n int := 0; bad text := ''; begin
  perform pg_temp.su();
  foreach f in array array['hq_metrics()', 'hq_overview()', 'hq_users(text,integer,integer)', 'hq_studios(text,text,integer,integer)', 'hq_studio_detail(uuid)',
      'hq_reveal(text,text,text)', 'hq_audit(date,date)', 'hq_mfa_readiness()', 'hq_staff_access()'] loop
    if position('r126-0335' in (select prosrc from pg_proc where oid = to_regprocedure('public.' || f))) > 0
       and to_regprocedure('public.' || replace(f, '(', '__pre0335(')) is not null
       and not has_function_privilege('authenticated', to_regprocedure('public.' || replace(f, '(', '__pre0335(')), 'execute')
       and not has_function_privilege('anon', to_regprocedure('public.' || replace(f, '(', '__pre0335(')), 'execute')
       and not has_function_privilege('anon', to_regprocedure('public.' || f), 'execute')
       and has_function_privilege('authenticated', to_regprocedure('public.' || f), 'execute') then n := n + 1; else bad := bad || ' ' || f; end if;
  end loop;
  perform pg_temp.res('01 nine functions carry the marker, kept bodies have no app privilege, entry points signed-in only', n = 9, bad);
  perform pg_temp.res('02 the helper is private',
    not has_function_privilege('authenticated', 'public._r335_cron_state()', 'execute') and not has_function_privilege('anon', 'public._r335_cron_state()', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) one studio count ---------------------------------------------------------------------------------------------------
do $$ declare o jsonb; m jsonb; tot bigint; real_n bigint; st_sum bigint; has_master boolean; d jsonb; begin
  perform pg_temp.su(); select count(*) into real_n from public.organizations where not is_sample_master;
  perform pg_temp.hq('r126_owner@hqstaff.test');
  o := public.hq_overview(); m := public.hq_metrics();
  select max(total_count), bool_or(org_id = pg_temp.get('master')::uuid) into tot, has_master from public.hq_studios(null, null, 200, 0);
  select sum(v::bigint) into st_sum from jsonb_each_text(o #> '{studios,by_status}') x(k, v);
  perform pg_temp.res('03 tile, list and overview agree on real studios only', (m #>> '{studios,total}')::bigint = real_n and tot = real_n and (o #>> '{studios,total}')::bigint = real_n,
    format('metrics %s list %s overview %s real %s', m #>> '{studios,total}', tot, o #>> '{studios,total}', real_n));
  perform pg_temp.res('04 Studios by plan status adds up to the same number', st_sum = real_n, st_sum::text);
  perform pg_temp.res('05 the sample master is not in the list', not coalesce(has_master, false));
  perform pg_temp.res('06 no search finds the sample master in the list',
    not exists (select 1 from public.hq_studios((select left(name, 12) from public.organizations where id = pg_temp.get('master')::uuid), null, 200, 0) x where x.org_id = pg_temp.get('master')::uuid));
  d := public.hq_studio_detail(pg_temp.get('master')::uuid);
  perform pg_temp.res('07 it still opens by its id (nothing hidden for good)', d ->> 'org_id' = pg_temp.get('master'), left(d::text, 120));
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) People -----------------------------------------------------------------------------------------------------------------
do $$ declare r record; n int; begin
  perform pg_temp.hq('r126_owner@hqstaff.test');
  perform pg_temp.res('08 a client login is not in the list', not exists (select 1 from public.hq_users(null, 200, 0) u where u.user_id = pg_temp.get('client')::uuid));
  perform pg_temp.res('09 searching the full address finds nobody (no "has an account" answer)', not exists (select 1 from public.hq_users('r126_client@studio.test', 200, 0)));
  perform pg_temp.res('10 searching by studio finds the team, not the client login',
    (select count(*) = 1 and bool_and(u.user_id = pg_temp.get('team')::uuid) from public.hq_users('R126 Studio', 200, 0) u));
  perform pg_temp.res('11 the count leaves it out too',
    (select max(total_count) from public.hq_users(null, 200, 0)) = (select count(*) from public.hq_users(null, 200, 0)));
  select * into r from public.hq_users('r126_owner@hqstaff.test', 200, 0);
  perform pg_temp.res('12 an HQ Owner reads HQ Owner under Helm HQ, never client', r.role = 'HQ Owner' and r.studio = 'Helm HQ', r.role || '/' || r.studio);
  select * into r from public.hq_users('r126_new@studio.test', 200, 0);
  perform pg_temp.res('13 a login with no studio reads No studio yet and stays listed', r.role = 'No studio yet' and r.org_id is null, coalesce(r.role, 'null'));
  select * into r from public.hq_users('r126_team@studio.test', 200, 0);
  perform pg_temp.res('14 a team member is unchanged and still masked', r.role = 'admin' and r.studio = 'R126 Studio' and r.email not like 'r126_team%', r.email);
  perform pg_temp.res('15 team size in the list leaves the client login out',
    (select users_count from public.hq_studios('R126 Studio', null, 5, 0)) = 1);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4 + 5) a studio's People + Show -------------------------------------------------------------------------------------------
do $$ declare d jsonb; e text; n bigint; v jsonb; begin
  perform pg_temp.hq('r126_owner@hqstaff.test');
  d := public.hq_studio_detail(pg_temp.get('org')::uuid);
  perform pg_temp.res('16 the studio page lists its team only', jsonb_array_length(d -> 'members') = 1 and d #>> '{members,0,role}' = 'admin', left(d -> 'members' #>> '{}', 200));
  perform pg_temp.res('17 team size matches', (d ->> 'users_count')::int = 1, d ->> 'users_count');
  perform pg_temp.su(); select count(*) into n from public.audit_log where action = 'hq.reveal' and entity_id = pg_temp.get('client');
  perform pg_temp.hq('r126_owner@hqstaff.test');
  e := pg_temp.try(format('select public.hq_reveal(%L, %L, %L)', 'person', pg_temp.get('client'), 'email'));
  perform pg_temp.res('18 Show refuses a client login (person)', e like '22023%client login%', e);
  e := pg_temp.try(format('select public.hq_reveal(%L, %L, %L)', 'member', pg_temp.get('client'), 'email'));
  perform pg_temp.res('19 Show refuses a client login (member)', e like '22023%', e);
  v := public.hq_reveal('person', pg_temp.get('team'), 'email');
  perform pg_temp.res('20 Show still works for a team member', v ->> 'value' = 'r126_team@studio.test', v::text);
  perform pg_temp.su();
  perform pg_temp.res('21 a refused Show writes no log row', (select count(*) from public.audit_log where action = 'hq.reveal' and entity_id = pg_temp.get('client')) = n);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) one trial day -----------------------------------------------------------------------------------------------------------
do $$ declare m jsonb; t jsonb; a jsonb; begin
  perform pg_temp.hq('r126_owner@hqstaff.test');
  m := public.hq_metrics(); t := public.hq_trial_info(pg_temp.get('org')::uuid);
  select x.e into a from jsonb_array_elements(m #> '{attention,trials_ending}') x(e) where x.e ->> 'org_id' = pg_temp.get('org');
  perform pg_temp.res('22 the studio is in Needs attention', a is not null, left(m #>> '{attention,trials_ending}', 200));
  perform pg_temp.res('23 same exact moment as the studio page', (a ->> 'ends_at')::timestamptz = (t ->> 'trial_ends_at')::timestamptz, (a ->> 'ends_at') || ' vs ' || (t ->> 'trial_ends_at'));
  perform pg_temp.res('24 same time zone as the studio page', a ->> 'timezone' = t ->> 'timezone' and a ->> 'timezone' = 'Asia/Singapore', a ->> 'timezone');
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) job history says why --------------------------------------------------------------------------------------------------
do $$ declare m jsonb; had boolean := to_regclass('cron.job') is not null; begin
  perform pg_temp.hq('r126_owner@hqstaff.test');
  m := public.hq_metrics();
  if had then perform pg_temp.res('25 not readable never without a reason', (m #>> '{health,cron,readable}')::boolean or (m #>> '{health,cron,reason}') is not null, m #>> '{health,cron}');
  else perform pg_temp.res('25 no pg_cron here: reason not_installed', m #>> '{health,cron,reason}' = 'not_installed' and (m #>> '{health,cron,readable}')::boolean = false, m #>> '{health,cron}'); end if;
  if not had then
    perform pg_temp.su();
    create schema cron;
    create table cron.job (jobid bigint, jobname text, schedule text, active boolean);
    insert into cron.job values (1, 'helm_comms_tick', '*/15 * * * *', true), (2, 'other', '* * * * *', true);
    perform pg_temp.hq('r126_owner@hqstaff.test');
    m := public.hq_metrics();
    perform pg_temp.res('26 a job list but no run history: reason no_history + the count', m #>> '{health,cron,reason}' = 'no_history' and (m #>> '{health,cron,job_count}')::int = 1, m #>> '{health,cron}');
    perform pg_temp.su(); drop schema cron cascade;
  else perform pg_temp.res('26 (skipped: pg_cron is present)', true); end if;
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) the activity log names the studio -----------------------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.su();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    values (null, 'r126_owner@hqstaff.test', 'hq.trial.extend', 'organization', pg_temp.get('org'), null, now());
  perform pg_temp.hq('r126_owner@hqstaff.test');
  r := public.hq_audit(null, null);
  perform pg_temp.res('27 a row about a studio carries its name',
    exists (select 1 from jsonb_array_elements(r -> 'rows') x(e) where x.e ->> 'action' = 'hq.trial.extend' and x.e ->> 'studio' = 'R126 Studio'), left(r::text, 200));
  perform pg_temp.res('28 a row about something else has no studio',
    not exists (select 1 from jsonb_array_elements(r -> 'rows') x(e) where x.e ->> 'action' = 'hq.view' and x.e ->> 'entity' = 'hq_audit' and x.e ? 'studio'));
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) someone removed from HQ -----------------------------------------------------------------------------------------------------
do $$ declare r jsonb; a jsonb; begin
  perform pg_temp.hq('r126_owner@hqstaff.test');
  r := public.hq_mfa_readiness();
  perform pg_temp.res('29 removed from HQ = not in two-step readiness', not exists (select 1 from jsonb_array_elements(r -> 'operators') x(e) where x.e ->> 'email' = 'r126_gone@hqstaff.test'), left(r::text, 200));
  perform pg_temp.res('30 a current HQ person still is', exists (select 1 from jsonb_array_elements(r -> 'operators') x(e) where x.e ->> 'email' = 'r126_owner@hqstaff.test'));
  a := public.hq_staff_access();
  perform pg_temp.res('31 the allowlist says removed', exists (select 1 from jsonb_array_elements(a -> 'allowlist') x(e) where x.e ->> 'email' = 'r126_gone@hqstaff.test' and x.e ->> 'hq_status' = 'removed'), left(a -> 'allowlist' #>> '{}', 200));
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 10) gates unchanged; nothing stored changes -------------------------------------------------------------------------------------
do $$ declare e text; p text; n text; begin
  perform pg_temp.su(); select md5(string_agg(id::text || role || coalesce(org_id::text, ''), ',' order by id)) into p from public.profiles;
  select md5(string_agg(id::text || name, ',' order by id)) into n from public.organizations;
  perform pg_temp.hq('r126_viewer@hqstaff.test');
  e := pg_temp.try('select * from public.hq_users(null, 5, 0)'); perform pg_temp.res('32 Viewer refused People', e like '42501%', e);
  e := pg_temp.try('select * from public.hq_studios(null, null, 5, 0)'); perform pg_temp.res('33 Viewer refused Studios', e like '42501%', e);
  e := pg_temp.try(format('select public.hq_reveal(%L, %L, %L)', 'person', pg_temp.get('team'), 'email')); perform pg_temp.res('34 Viewer refused Show', e like '42501%', e);
  perform pg_temp.hq('r126_owner@hqstaff.test', 'aal1');
  e := pg_temp.try('select public.hq_metrics()'); perform pg_temp.res('35 no two-step = refused', e <> '', e);
  perform pg_temp.hq('a_admin@a.test');
  e := pg_temp.try('select public.hq_overview()'); perform pg_temp.res('36 a studio admin is refused', e like '42501%', e);
  perform pg_temp.su(); perform set_config('role', 'anon', false);
  e := pg_temp.try('select public.hq_audit(null, null)'); perform pg_temp.res('37 anon refused', e like '42501%', e);
  perform pg_temp.hq('r126_owner@hqstaff.test');
  perform public.hq_metrics(); perform public.hq_overview(); perform public.hq_audit(null, null); perform public.hq_mfa_readiness(); perform public.hq_staff_access();
  perform count(*) from public.hq_users(null, 200, 0); perform count(*) from public.hq_studios(null, null, 200, 0);
  perform pg_temp.su();
  perform pg_temp.res('38 reading HQ changes no profile or studio row',
    (select md5(string_agg(id::text || role || coalesce(org_id::text, ''), ',' order by id)) from public.profiles) = p
    and (select md5(string_agg(id::text || name, ',' order by id)) from public.organizations) = n);
exception when others then perform pg_temp.su(); insert into _rs values ('10x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 11) re-run safety --------------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('39 re-run safe: nine kept bodies, none wrapped twice',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0335') = 9
    and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0335\_\_pre0335') = 0
    and position('r126-0335' in (select prosrc from pg_proc where oid = 'public.hq_metrics__pre0335()'::regprocedure)) = 0);
exception when others then perform pg_temp.su(); insert into _rs values ('11x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R126-HQ-FIXES-0335: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R126-HQ-FIXES-0335: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
