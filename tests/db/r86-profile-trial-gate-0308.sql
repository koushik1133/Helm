-- r86-profile-trial-gate-0308.sql - 0308: "Complete your profile" works for a member of an ENDED trial studio,
-- while every studio record (crew_members) in that studio stays read-only.
-- Proves: (1) before expiry the profile save syncs the Staff row as before; (2) after expiry complete_my_profile
-- succeeds (no trial_ended), the personal rows are saved and NO crew_members write happens; (3) a direct crew_members
-- write in the ended trial is still refused with trial_ended (guard not weakened); (4) a never-in-a-studio account
-- saves too; (5) grants + marker + __pre0308 kept. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0308_r86_profile_trial_gate.sql
\ir ../../supabase/migrations/0308_r86_profile_trial_gate.sql
set client_min_messages = warning;
begin;
create temp table _t308(name text, result text); grant all on _t308 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t308 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;

do $$
declare o uuid; u uuid; u2 uuid; e text; n0 int; r jsonb;
begin
  -- an owner starts a free trial
  u := pg_temp.newuser('r308-owner@synthetic.helm'); perform pg_temp.login('r308-owner@synthetic.helm');
  r := public.start_self_serve_trial('R308 Studio', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); o := (r ->> 'org_id')::uuid;
  perform pg_temp.res('00 trial studio created', o is not null, coalesce(r::text, ''));

  -- (1) active trial: profile save works and the Staff row is synced as before
  perform pg_temp.login('r308-owner@synthetic.helm');
  e := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Rao Owner","phone":"+919876511111","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('01 active trial: profile saves', e = '', e);
  perform pg_temp.res('02 active trial: Staff row synced',
    exists (select 1 from public.crew_members c where c.profile_id = u and c.org_id = o), '');

  -- the trial ends
  update public.organizations set trial_ends_at = now() - interval '1 hour' where id = o;
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = o;
  perform pg_temp.res('03 studio is trial-locked', public._trial_locked(o), '');

  -- (2) ended trial: the member's own profile still saves; no studio record is written
  delete from public.crew_members where profile_id = u and org_id = o;    -- (superuser, setup only) force a would-be insert
  select count(*) into n0 from public.crew_members where org_id = o;
  perform pg_temp.login('r308-owner@synthetic.helm');
  e := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Rao Owner Two","phone":"+919876522222","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('04 ended trial: complete_my_profile succeeds (was trial_ended)', e = '', e);
  perform pg_temp.res('05 ended trial: name + phone saved',
    (select full_name from public.profiles where id = u) = 'Rao Owner Two'
    and (select phone from public.member_profiles where user_id = u) = '+919876522222', '');
  perform pg_temp.res('06 ended trial: no crew_members write', (select count(*) from public.crew_members where org_id = o) = n0, '');

  -- (3) the guard is not weakened: a direct Staff insert in the ended trial is still refused
  perform pg_temp.login('r308-owner@synthetic.helm');
  e := pg_temp.try(format($q$insert into public.crew_members(name, org_id, active) values ('X', %L, true)$q$, o));
  perform pg_temp.su();
  perform pg_temp.res('07 ended trial: direct crew_members insert still trial_ended', e like '25006 trial_ended%', e);

  -- (4) an account with no studio saves its profile
  u2 := pg_temp.newuser('r308-fresh@synthetic.helm');
  update public.profiles set role = 'client' where id = u2;
  perform pg_temp.login('r308-fresh@synthetic.helm');
  e := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Fresh Person","phone":"+919876533333","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('08 no-studio account: profile saves', e = '', e);

  -- (5) shape
  perform pg_temp.res('09 live _mp_sync_staff: marker, empty search_path; app cannot call any layer',
    coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r86-profile-trial-0308' in p.prosrc) > 0
       from pg_proc p where p.oid = 'public._mp_sync_staff(uuid,jsonb)'::regprocedure), false)
    and to_regprocedure('public._mp_sync_staff__pre0308(uuid,jsonb)') is not null
    and not has_function_privilege('authenticated', 'public._mp_sync_staff(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._mp_sync_staff__pre0308(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r308_sync_staff(uuid,jsonb)', 'execute'), '');
end $$;

select name, result from _t308 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R86-PROFILE-TRIAL-0308: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R86-PROFILE-TRIAL-0308: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t308;
rollback;
