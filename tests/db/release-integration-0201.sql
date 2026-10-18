-- release-integration-0201.sql -- 0201 (release integration). A) the free-trial entry point AS INSTALLED by the
-- canonical manifest (nothing is re-applied here) is the 0186 one-trial wrapper over the 0180 sign-up body,
-- even though 0190 (written on the 0119 body) replaced start_self_serve_trial after 0186.
-- Proves: the chain markers; no function in the chain reads pg_timezone_names (0190's speed-up kept);
-- privileges as 0186 left them; a sign-up starts WITH the sample data on INR / Asia/Kolkata with the
-- welcome flag (0180); the same e-mail written another way (Gmail dots / +tag / case) cannot start a
-- second free trial (0186, 22023 hint trial_used). B) 0194's chat_group_contacts is on the 0184 purge list
-- and no org table is left unclassified. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _r201(name text, result text); grant all on _r201 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r201 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; h text; begin
  execute p_sql into v; return 'ok:' || coalesce(v, '');
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return 'err:' || sqlstate || ':' || coalesce(h, '') || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_tz text, p_cur text, p_mode text) returns text language plpgsql as $$
declare r text; begin
  perform pg_temp.login(p_email);
  r := pg_temp.try(format('select public.start_self_serve_trial(%L, %L, %L, %L)::text', 'R201 Studio', p_tz, p_cur, p_mode));
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.src(p regprocedure) returns text language sql as $$ select prosrc from pg_proc where oid = p $$;

-- ---- 0x: the installed chain ----------------------------------------------------------------------
do $$ declare w text := pg_temp.src('public.start_self_serve_trial(text,text,text,text)');
              b text := pg_temp.src('public.start_self_serve_trial__pre0186(text,text,text,text)'); begin
  perform pg_temp.res('01 entry point is the 0186 one-trial wrapper',
    position('one-trial-0186' in w) > 0 and position('start_self_serve_trial__pre0186' in w) > 0 and position('trial_used' in w) > 0, left(w, 200));
  perform pg_temp.res('02 the body behind it is the 0180 sign-up (sample data + India + welcome)',
    position('trial-signup-0180' in b) > 0 and position('trial_welcome_pending = true' in b) > 0 and position('_demo_seed' in b) > 0, left(b, 200));
  perform pg_temp.res('03 no function in the chain reads pg_timezone_names (0190 speed-up kept)',
    position('pg_timezone_names' in w) = 0 and position('pg_timezone_names' in b) = 0);
  perform pg_temp.res('04 0190 faster clone still installed',
    position('trial-clone-0190' in pg_temp.src('public._sample_clone_into__pre0168(uuid)')) > 0);
  perform pg_temp.res('05 privileges: app can start a trial, never call the inner body; anon neither',
    has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.start_self_serve_trial__pre0186(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.start_self_serve_trial__pre0186(text,text,text,text)', 'execute'));
  perform pg_temp.res('06 trial retention: chat_group_contacts (0194) is purged with the chat records',
    'chat_group_contacts' = any(public._tr184_purge_tables()) and not ('chat_group_contacts' = any(public._tr184_keep_tables()))
    and array_position(public._tr184_purge_tables(), 'chat_group_contacts') < array_position(public._tr184_purge_tables(), 'chat_conversations'));
  perform pg_temp.res('07 trial retention: every org table is classified purge / keep',
    not exists (select 1 from unnest(public._tr184_org_tables()) t
                 where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())),
    (select string_agg(t, ', ') from unnest(public._tr184_org_tables()) t
      where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())));
end $$;

-- ---- 1x: behaviour ----------------------------------------------------------------------------------
do $$ declare r text; j jsonb; o public.organizations; begin
  perform pg_temp.newuser('r201.jane@gmail.com'); perform pg_temp.newuser('R201Jane+second@GoogleMail.com');
  perform pg_temp.newuser('r201_other@d.test');
  -- visitor asks for own data in New York dollars: 0180 still starts the India trial WITH the sample data
  r := pg_temp.trial('r201.jane@gmail.com', 'America/New_York', 'USD', 'own');
  perform pg_temp.res('10 first trial starts', r like 'ok:%' and (substr(r, 4)::jsonb ->> 'result') = 'started', r);
  if r like 'ok:%' then
    j := substr(r, 4)::jsonb; select * into o from public.organizations where id = (j ->> 'org_id')::uuid;
    perform pg_temp.res('11 0180 rules: INR / Asia/Kolkata / demo mode / welcome flag',
      o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.trial_mode = 'demo' and o.trial_welcome_pending is true
      and j ->> 'mode' = 'demo', row_to_json(o)::text);
  end if;
  r := pg_temp.trial('R201Jane+second@GoogleMail.com', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.res('12 same e-mail another way (dots / +tag / case / googlemail): refused trial_used',
    r like 'err:22023:trial_used:%', r);
  r := pg_temp.trial('r201_other@d.test', '+05:30', 'INR', 'demo');
  perform pg_temp.res('13 a different e-mail still starts (odd time zone falls back)',
    r like 'ok:%' and (substr(r, 4)::jsonb ->> 'result') = 'started', r);
exception when others then perform pg_temp.su(); insert into _r201 values ('1x behaviour', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _r201 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'RELEASE-INTEGRATION-0201: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'RELEASE-INTEGRATION-0201: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _r201;
rollback;
