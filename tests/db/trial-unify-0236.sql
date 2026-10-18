-- trial-unify-0236.sql -- 0236: one meaning of "in the free trial" (B1), more trial-locked settings + no sample
-- clear / reset / switch in the trial (B12), the admin's login-linked staff row is not a staff slot (B13).
-- A self-serve trial, a trial started from the plan / checkout page (organizations.trial_ends_at empty), an
-- ended checkout trial and a paid studio. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR ' || sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.demo_rows(p_org uuid) returns bigint language sql as $$
  select (select count(*) from public.quotes where org_id = p_org and is_demo)
       + (select count(*) from public.leads where org_id = p_org and is_demo)
       + (select count(*) from public.menu_templates where org_id = p_org and is_demo);
$$;

-- earlier suites in run-all re-apply older migrations (0032 anon allowlist, 0069 / 0078 / 0128 / 0173 / 0181 / 0183)
-- over the 0176 / 0236 bodies: re-run both (also proves a re-run is safe)
\ir ../../supabase/migrations/0176_trial_client_flow.sql
\ir ../../supabase/migrations/0236_trial_definition_unify.sql

-- ---- B1: self-serve trial (both dates) and a checkout-started trial (organizations.trial_ends_at empty) ---------
do $$ declare a uuid; c uuid; v jsonb; tok uuid; q uuid; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  a := pg_temp.trial('tu_a@t.test'); perform pg_temp.put('A', a::text);
  perform pg_temp.res('01 self-serve sign-up still sets BOTH trial dates (organizations + subscription)',
    (select trial_ends_at is not null from public.organizations where id = a)
    and (select status = 'trial' and trial_ends_at is not null from public.studio_subscriptions where org_id = a));
  perform pg_temp.login('tu_a@t.test');
  v := public.my_trial_org();
  perform pg_temp.su();
  perform pg_temp.res('02 self-serve trial: my_trial_org is_trial_org + test mode on', (v ->> 'is_trial_org')::boolean
    and not (v ->> 'locked')::boolean and public._trial_test_mode_ok(a), v::text);

  -- the 0056 / 0058 checkout path: the subscription says trial, organizations.trial_ends_at stays empty
  c := pg_temp.trial('tu_c@t.test'); perform pg_temp.put('C', c::text);
  update public.organizations set trial_ends_at = null where id = c;
  update public.studio_subscriptions set trial_ends_at = current_date + 11 where org_id = c;
  perform pg_temp.login('tu_c@t.test');
  v := public.my_trial_org();
  perform pg_temp.res('03 checkout trial: caps + lockdown apply (my_trial_limits trial)', (public.my_trial_limits() ->> 'trial')::boolean);
  perform pg_temp.res('04 checkout trial: my_trial_org is_trial_org, ends at the end of the subscription day, not locked',
    (v ->> 'is_trial_org')::boolean and (v ->> 'ends_at')::timestamptz = ((current_date + 12)::timestamp at time zone 'UTC')
    and (v ->> 'days_left')::int between 11 and 13 and not (v ->> 'ended')::boolean and not (v ->> 'locked')::boolean, v::text);
  v := public.my_trial_access();
  perform pg_temp.res('05 checkout trial: my_trial_access is_trial_org', (v ->> 'is_trial_org')::boolean, v::text);
  perform pg_temp.su();
  perform pg_temp.res('06 checkout trial: test mode on (same definition as the caps)', public._trial_test_mode_ok(c) and public._tl173_trial_locked(c));
  select id into q from public.quotes where org_id = c and approval_token is not null limit 1;
  if q is null then select id into q from public.quotes where org_id = c and deleted_at is null limit 1; end if;
  tok := gen_random_uuid();
  update public.quotes set approval_token = tok, approval_token_expires_at = now() + interval '7 days', approval_token_revoked_at = null where id = q;
  perform pg_temp.put('CT', tok::text);
  perform pg_temp.anon();
  perform pg_temp.res('07 checkout trial: the client approval page offers Test mode confirm', public.trial_test_mode_for_token(tok));
  perform pg_temp.su();
  perform pg_temp.res('08 no back-fill: organizations.trial_ends_at stays empty, not read-only, retention not eligible',
    (select trial_ends_at is null from public.organizations where id = c) and not public._trial_locked(c)
    and public._trial_retention_block(c) is not null);
exception when others then perform pg_temp.su(); insert into _uf values ('0x B1', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- B1: ended checkout trial, paid studio ------------------------------------------------------------------
do $$ declare c uuid := pg_temp.get('C')::uuid; v jsonb; begin
  update public.studio_subscriptions set trial_ends_at = current_date - 2 where org_id = c;
  perform pg_temp.login('tu_c@t.test');
  v := public.my_trial_org();
  perform pg_temp.su();
  perform pg_temp.res('10 checkout trial past its end day: test mode off, banner says ended',
    not public._trial_test_mode_ok(c) and (v ->> 'is_trial_org')::boolean and (v ->> 'ended')::boolean, v::text);
  perform pg_temp.anon();
  perform pg_temp.res('11 ended checkout trial: approval page shows no Test mode', not public.trial_test_mode_for_token(pg_temp.get('CT')::uuid));
  perform pg_temp.su();
  update public.studio_subscriptions set trial_ends_at = current_date + 11 where org_id = c;
  -- paid: fixture studio A (no trial)
  perform pg_temp.login('a_admin@a.test');
  v := public.my_trial_org();
  perform pg_temp.su();
  perform pg_temp.res('12 paid studio: not a trial, no test mode', not (v ->> 'is_trial_org')::boolean
    and not public._trial_test_mode_ok((select org_id from public.profiles where email = 'a_admin@a.test')), v::text);
  -- a trial that became active (paid) keeps its old dates but is no longer a trial
  update public.studio_subscriptions set status = 'active', current_period_start = now(), current_period_end = now() + interval '30 days'
   where org_id = c;
  perform pg_temp.login('tu_c@t.test');
  v := public.my_trial_org();
  perform pg_temp.su();
  perform pg_temp.res('13 converted (active) studio: not a trial, no test mode', not (v ->> 'is_trial_org')::boolean and not public._trial_test_mode_ok(c), v::text);
exception when others then perform pg_temp.su(); insert into _uf values ('1x B1 paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- B12: locked settings + sample clear / reset / switch refused in the trial ----------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; e text; n0 bigint; n1 bigint; f text; begin
  n0 := pg_temp.demo_rows(a);
  perform pg_temp.login('tu_a@t.test');
  e := pg_temp.try('select public.pkg_settings_set(public.pkg_settings_get())');
  perform pg_temp.res('20 trial: package flow settings save refused', e like '42501%Not available in the free trial. Upgrade to use this.%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"low_stock_enabled":true}''::jsonb)');
  perform pg_temp.res('21 trial: automatic messages settings save refused', e like '42501%Not available in the free trial%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"fu_enabled":true}''::jsonb)');
  perform pg_temp.res('22 trial: switching follow-ups on refused', e like '42501%Not available in the free trial%', e);
  foreach f in array array['select public.clear_demo_data()', 'select public.clear_sample_data()', 'select public.reset_demo_data()',
                           'select public.set_trial_mode(''own'')', 'select public.trial_demo_choice(''fresh'')',
                           'select public.delete_all_sample_data()'] loop
    e := pg_temp.try(f);
    perform pg_temp.res('23 trial: refused - ' || f, e like '42501%Not available in the free trial%', e);
  end loop;
  e := pg_temp.try('select public.pkg_settings_get()');
  perform pg_temp.res('24 trial: reading the settings still works', e = '', e);
  perform pg_temp.su();
  n1 := pg_temp.demo_rows(a);
  perform pg_temp.res('25 trial: no sample row removed', n1 = n0 and n0 > 0, n0 || ' -> ' || n1);
  perform pg_temp.res('26 trial: trial_mode unchanged (demo)', (select trial_mode from public.organizations where id = a) = 'demo');
exception when others then perform pg_temp.su(); insert into _uf values ('2x B12 trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.pkg_settings_set(public.pkg_settings_get())');
  perform pg_temp.res('30 paid studio: package flow settings save works', e = '', e);
  e := pg_temp.try('select public.comms_settings_set(''{"low_stock_enabled":true}''::jsonb)');
  perform pg_temp.res('31 paid studio: automatic messages settings save works', e = '', e);
  e := pg_temp.try('select public.set_trial_mode(''own'')');
  perform pg_temp.res('32 paid studio: sample switch not trial-locked', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('33 wrappers granted like the originals (signed-in only), kept originals not callable by the app',
    has_function_privilege('authenticated', 'public.pkg_settings_set(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.comms_settings_set(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.clear_sample_data()', 'execute')
    and not has_function_privilege('anon', 'public.pkg_settings_set(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.clear_demo_data()', 'execute')
    and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0236'
                     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
    and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0236') = 8);
  perform pg_temp.res('34 seed_demo_data (fill-only) is not wrapped', to_regprocedure('public.seed_demo_data__pre0236()') is null);
exception when others then perform pg_temp.su(); insert into _uf values ('3x B12 paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- B13: the admin's own login-linked staff row is not one of the 2 staff slots ---------------------------------
do $$ declare s uuid; e1 text; e2 text; e3 text; u1 text; u2 text; adm uuid; begin
  s := pg_temp.trial('tu_s@t.test');
  adm := (select id from auth.users where email = 'tu_s@t.test');
  -- the 0041 member sync gives the admin a linked staff row; make sure one is there for the test
  if not exists (select 1 from public.crew_members where org_id = s and profile_id = adm) then
    insert into public.crew_members(name, phone, org_id, profile_id) values ('TU Admin', '+919811100236', s, adm);
    insert into public.trial_create_log(org_id, entity, row_id)
      select s, 'crew_members', id::text from public.crew_members where org_id = s and profile_id = adm on conflict do nothing;
  end if;
  perform pg_temp.res('40 setup: the trial admin has a login-linked staff row', exists (select 1 from public.crew_members where org_id = s and profile_id = adm));
  perform pg_temp.login('tu_s@t.test');
  u1 := public.my_trial_limits() #>> '{used,crew_members}';
  perform pg_temp.res('41 fresh trial: staff used = 0 (the linked admin row is not counted)', u1 = '0', u1);
  e1 := pg_temp.try('insert into public.crew_members(name, phone) values (''TU Staff One'', ''+919811102361'')');
  e2 := pg_temp.try('insert into public.crew_members(name, phone) values (''TU Staff Two'', ''+919811102362'')');
  perform pg_temp.res('42 trial: 2 staff members can be added', e1 = '' and e2 = '', e1 || ' | ' || e2);
  e3 := pg_temp.try('insert into public.crew_members(name, phone) values (''TU Staff Three'', ''+919811102363'')');
  perform pg_temp.res('43 trial: the 3rd is refused (cap 2)', e3 like '42501%Free trial limit reached (2)%', e3);
  u2 := public.my_trial_limits() #>> '{used,crew_members}';
  perform pg_temp.res('44 trial: staff used = 2', u2 = '2', u2);
  e3 := pg_temp.try('insert into public.crew_members(name, phone, profile_id) values (''TU Fake Link'', ''+919811102364'', auth.uid())');
  perform pg_temp.res('45 trial: the app cannot link a staff row to a login itself (0041 guard)', e3 like '42501%', e3);
  perform pg_temp.su();
  perform pg_temp.res('46 other lists unchanged: leads cap still counts every own row',
    public._tl181_used(s, 'leads') = (select count(*) from public.leads where org_id = s and not is_demo));
exception when others then perform pg_temp.su(); insert into _uf values ('4x B13', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.res('90 internal helpers not callable by the app',
    not has_function_privilege('authenticated', 'public._tu236_trial_end(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._trial_test_mode_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tl181_used(uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_trial_org()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_org()', 'execute'));
  perform pg_temp.res('91 bodies tagged trial-unify-0236',
    position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._trial_test_mode_ok(uuid)'))) > 0
    and position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_org()'))) > 0
    and position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl181_used(uuid,text)'))) > 0
    and position('trial-unify-0236' in (select prosrc from pg_proc where oid = to_regprocedure('public._tl173_tg_create_cap()'))) > 0);
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-UNIFY-0236: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-UNIFY-0236: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
