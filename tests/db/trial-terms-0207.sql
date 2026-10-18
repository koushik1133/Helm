-- trial-terms-0207.sql -- 0207: the free-trial terms "I agree" (welcome step 1 / one-time window) and the
-- teammate notice are recorded server-side per studio + person + terms version; paid studios, ended trials,
-- clients and signed-out callers are never asked and cannot record anything; the record is kept by the
-- 0184 trial-data deletion. Also checks the sample counts the terms quote (public/trial-facts.js SAMPLE).
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites may re-apply 0184 (keep list) / 0180 bodies: re-apply 0207 inside this rolled-back tx (also proves a re-run is safe)
\ir ../../supabase/migrations/0207_trial_terms_acceptance.sql
\ir ../../supabase/migrations/0207_trial_terms_acceptance.sql
create temp table _ts(name text, result text); grant all on _ts to anon, authenticated, service_role;
create temp table _tkv(k text primary key, v text); grant all on _tkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ts values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, null, false, now())
    on conflict (id) do update set org_id = null, role = p_role;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial(null, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.member(p_email text, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform pg_temp.newuser(p_email, p_role); update public.profiles set org_id = p_org where email = p_email; end $$;
create or replace function pg_temp.rows(p_org uuid) returns int language sql as $$
  select count(*)::int from public.trial_terms_acceptances where org_id = p_org $$;

-- ---- 0x: structure ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 table exists with RLS on and no permissive policy (restrictive gates from other files are fine)',
    (select relrowsecurity from pg_class where oid = 'public.trial_terms_acceptances'::regclass)
    and not exists (select 1 from pg_policy where polrelid = 'public.trial_terms_acceptances'::regclass and polpermissive));
  perform pg_temp.res('02 the app cannot touch the table directly (anon / authenticated: no privilege)',
    not has_table_privilege('anon', 'public.trial_terms_acceptances', 'select')
    and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'select')
    and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'insert')
    and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'update')
    and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'delete'));
  perform pg_temp.res('03 the studio read-only guard is attached',
    exists (select 1 from pg_trigger where tgrelid = 'public.trial_terms_acceptances'::regclass and tgname = 'zzz_studio_read_only'));
  perform pg_temp.res('04 functions: SECURITY DEFINER with an empty search_path',
    (select bool_and(prosecdef and 'search_path=""' = any(proconfig)) from pg_proc
      where oid in (to_regprocedure('public.my_trial_terms_status()'), to_regprocedure('public.accept_trial_terms(text,text)'),
                    to_regprocedure('public._tt207_ctx()'))));
  perform pg_temp.res('05 grants: signed-in app may call status + accept; anon nothing; internal helpers not callable',
    has_function_privilege('authenticated', 'public.my_trial_terms_status()', 'execute')
    and has_function_privilege('authenticated', 'public.accept_trial_terms(text,text)', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_terms_status()', 'execute')
    and not has_function_privilege('anon', 'public.accept_trial_terms(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._tt207_ctx()', 'execute')
    and not has_function_privilege('anon', 'public._tt207_ctx()', 'execute'));
  perform pg_temp.res('06 terms version = public/trial-facts.js VERSION', public._trial_terms_version() = 'trial-2026-10-18');
  perform pg_temp.res('07 trial-data deletion KEEPS the record (consent), listed once, never purged',
    'trial_terms_acceptances' = any(public._tr184_keep_tables())
    and array_length(array_positions(public._tr184_keep_tables(), 'trial_terms_acceptances'), 1) = 1
    and not ('trial_terms_acceptances' = any(public._tr184_purge_tables())));
  perform pg_temp.res('08 every org table is still classified purge / keep',
    not exists (select 1 from unnest(public._tr184_org_tables()) t
                 where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())),
    (select string_agg(t, ', ') from unnest(public._tr184_org_tables()) t
      where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())));
end $$;

-- ---- 1x: the trial owner ------------------------------------------------------------------------------------
do $$ declare r jsonb; o uuid; c jsonb; e text; n int; t text;
  -- SAMPLE-COUNTS: the numbers the trial terms quote (public/trial-facts.js SAMPLE; test/trial-terms-agree.test.mjs compares)
  v_want jsonb := '{"leads":16,"events":7,"requirements":41,"inventory":165,"vendors":16,"staff":12,"venues":4,"menus":6,"dishes":145,"layouts":3,"coupons":3}'::jsonb;
  v_got jsonb := '{}'::jsonb;
begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  r := pg_temp.trial('tt207_owner@t.test');
  o := (r ->> 'org_id')::uuid; perform pg_temp.put('A', o::text);
  perform pg_temp.res('10 trial started (sample studio cloned)', r ->> 'result' = 'started', left(r::text, 200));
  -- the sample data the terms describe = what a new trial really gets
  foreach t in array array['leads', 'quotes', 'event_requirements', 'inventory_items', 'vendors', 'crew_members', 'venues', 'menu_templates', 'dish_catalog', 'coupons'] loop
    execute format('select count(*) from public.%I where org_id = $1', t) into n using o;
    v_got := v_got || jsonb_build_object(case t when 'quotes' then 'events' when 'event_requirements' then 'requirements' when 'inventory_items' then 'inventory'
      when 'crew_members' then 'staff' when 'menu_templates' then 'menus' when 'dish_catalog' then 'dishes' else t end, n);
  end loop;
  select count(*) into n from public.studio_layout_templates s where s.org_id = o and not s.archived;
  v_got := v_got || jsonb_build_object('layouts', n);
  perform pg_temp.res('11 sample counts on a new trial = the numbers in the trial terms', v_got = v_want, v_got::text);

  perform pg_temp.login('tt207_owner@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('12 owner, new trial: must agree, welcome pending, nothing recorded yet',
    c ->> 'trial' = 'true' and c ->> 'owner' = 'true' and c ->> 'must_agree' = 'true' and c ->> 'notice' = 'false'
    and c ->> 'accepted' = 'false' and c ->> 'welcome_pending' = 'true' and c ->> 'version' = 'trial-2026-10-18', c::text);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2020-01-01')$q$);
  perform pg_temp.res('13 a stale page (other version) is refused', e like '22023%', e);
  e := pg_temp.try($q$select public.accept_trial_terms(null)$q$);
  perform pg_temp.res('14 no version is refused', e like '22023%', e);
  -- finishing the welcome without agreeing (an old cached page) does not count as agreeing
  perform public.trial_welcome_set(false);
  c := public.my_trial_terms_status();
  perform pg_temp.res('15 welcome finished but not agreed: still must agree (one-time window)',
    c ->> 'must_agree' = 'true' and c ->> 'welcome_pending' = 'false', c::text);
  perform set_config('request.headers', '{"user-agent":"Mozilla/5.0 (Macintosh) été ' || repeat('x', 300) || '"}', false);
  r := public.accept_trial_terms('trial-2026-10-18', 'ignored when the header is there');
  perform pg_temp.res('16 owner agrees: recorded as agree', r ->> 'result' = 'ok' and r ->> 'kind' = 'agree' and r ->> 'accepted_at' is not null, r::text);
  r := public.accept_trial_terms('trial-2026-10-18');
  perform pg_temp.res('17 agreeing twice changes nothing', r ->> 'result' = 'already' and r ->> 'kind' = 'agree', r::text);
  c := public.my_trial_terms_status();
  perform pg_temp.res('18 status after agreeing (any device): accepted, nothing more to ask',
    c ->> 'accepted' = 'true' and c ->> 'must_agree' = 'false' and c ->> 'notice' = 'false' and c ->> 'kind' = 'agree', c::text);
  e := pg_temp.try($q$select count(*) from public.trial_terms_acceptances$q$);
  perform pg_temp.res('19 the owner cannot read the table directly', e like '42501%', e);
  perform set_config('request.headers', '', false);
  perform pg_temp.su();
  perform pg_temp.res('20 exactly one row; the user agent is printable ASCII, 160 characters max',
    pg_temp.rows(o) = 1 and (select char_length(user_agent) <= 160 and user_agent ~ '^[ -~]+$' and user_agent like 'Mozilla/5.0 (Macintosh)%'
                              from public.trial_terms_acceptances where org_id = o),
    (select user_agent from public.trial_terms_acceptances where org_id = o));
  perform pg_temp.res('21 one audit row for the owner''s agreement',
    (select count(*) from public.audit_log a where a.org_id = o and a.action = 'trial.terms_accepted' and a.changed ->> 'version' = 'trial-2026-10-18') = 1);
exception when others then perform pg_temp.su(); insert into _ts values ('1x owner', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3x: invited teammates + a client -----------------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('A')::uuid; c jsonb; r jsonb; e text; begin
  perform pg_temp.member('tt207_coord@t.test', o, 'coordinator');
  perform pg_temp.login('tt207_coord@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('30 invited teammate: the short notice, no agreement asked',
    c ->> 'trial' = 'true' and c ->> 'owner' = 'false' and c ->> 'must_agree' = 'false' and c ->> 'notice' = 'true', c::text);
  r := public.accept_trial_terms('trial-2026-10-18');
  perform pg_temp.res('31 "Got it" is recorded as notice (not as an agreement)', r ->> 'result' = 'ok' and r ->> 'kind' = 'notice', r::text);
  c := public.my_trial_terms_status();
  perform pg_temp.res('32 notice seen: not shown again', c ->> 'notice' = 'false' and c ->> 'accepted' = 'true', c::text);
  -- an invited ADMIN is a teammate too (the person who started the trial agrees for the studio)
  perform pg_temp.member('tt207_admin2@t.test', o, 'admin');
  perform pg_temp.login('tt207_admin2@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('33 invited admin: notice, not must_agree', c ->> 'notice' = 'true' and c ->> 'must_agree' = 'false', c::text);
  perform pg_temp.member('tt207_client@t.test', o, 'client');
  perform pg_temp.login('tt207_client@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('34 client login: never asked', c ->> 'trial' = 'false' and c ->> 'must_agree' = 'false' and c ->> 'notice' = 'false', c::text);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-18')$q$);
  perform pg_temp.res('35 client login cannot record anything', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('36 rows: owner agree + teammate notice only; no audit row for a notice',
    pg_temp.rows(o) = 2 and (select count(*) from public.audit_log a where a.org_id = o and a.action = 'trial.terms_accepted') = 1);
exception when others then perform pg_temp.su(); insert into _ts values ('3x teammates', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4x: the person who started the trial left -> its admins stand in ------------------------------------------
do $$ declare o uuid; r jsonb; c jsonb; u uuid; begin
  r := pg_temp.trial('tt207_gone@t.test'); o := (r ->> 'org_id')::uuid;
  perform pg_temp.member('tt207_stand@t.test', o, 'admin');
  perform pg_temp.member('tt207_coord2@t.test', o, 'coordinator');
  -- the creator moves out of the studio (profile org cleared)
  update public.profiles set org_id = null where email = 'tt207_gone@t.test';
  perform pg_temp.login('tt207_stand@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('40 creator gone: a studio admin is asked to agree', c ->> 'owner' = 'true' and c ->> 'must_agree' = 'true', c::text);
  perform pg_temp.login('tt207_coord2@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('41 creator gone: a coordinator still only gets the notice', c ->> 'owner' = 'false' and c ->> 'notice' = 'true', c::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ts values ('4x stand-in', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5x: ended trial, paid studio, signed out -------------------------------------------------------------------
do $$ declare o uuid; p uuid; r jsonb; c jsonb; e text; begin
  -- ended, unpaid trial (read-only): nothing is asked, nothing is written
  r := pg_temp.trial('tt207_ended@t.test'); o := (r ->> 'org_id')::uuid;
  update public.organizations set trial_ends_at = now() - interval '2 days' where id = o;
  update public.studio_subscriptions set trial_ends_at = (now() - interval '2 days')::date where org_id = o;
  perform pg_temp.login('tt207_ended@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('50 ended trial: never asked', c ->> 'trial' = 'false' and c ->> 'must_agree' = 'false' and c ->> 'notice' = 'false', c::text);
  r := public.accept_trial_terms('trial-2026-10-18');
  perform pg_temp.res('51 ended trial: not_needed, nothing written', r ->> 'result' = 'not_needed', r::text);
  perform pg_temp.su();
  perform pg_temp.res('52 ended trial: no row', pg_temp.rows(o) = 0);
  -- a paid studio
  perform pg_temp.newuser('tt207_paid@t.test');
  perform pg_temp.login('tt207_paid@t.test');
  p := public.create_studio('TT207 Paid Studio', null, 'INR', 'Asia/Kolkata');
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values (p, 'active') on conflict (org_id) do update set status = 'active';
  perform pg_temp.login('tt207_paid@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('53 paid studio: never asked', c ->> 'trial' = 'false' and c ->> 'must_agree' = 'false' and c ->> 'notice' = 'false', c::text);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-18')$q$);
  perform pg_temp.res('54 paid studio cannot record trial terms', e like '22023%', e);
  perform pg_temp.su();
  perform pg_temp.res('55 paid studio: no row', pg_temp.rows(p) = 0);
  -- the trial studio becomes paid: nothing asked any more (an earlier record stays)
  update public.studio_subscriptions set status = 'active' where org_id = pg_temp.get('A')::uuid;
  perform pg_temp.login('tt207_coord@t.test');
  c := public.my_trial_terms_status();
  perform pg_temp.res('56 after upgrading: nobody is asked', c ->> 'trial' = 'false' and c ->> 'notice' = 'false' and c ->> 'must_agree' = 'false', c::text);
  perform pg_temp.su();
  perform pg_temp.res('57 after upgrading: the earlier record is kept', pg_temp.rows(pg_temp.get('A')::uuid) = 2);
  -- signed out
  set local role anon;
  e := pg_temp.try($q$select public.my_trial_terms_status()$q$);
  perform pg_temp.res('58 anon: status refused', e like '42501%', e);
  e := pg_temp.try($q$select public.accept_trial_terms('trial-2026-10-18')$q$);
  perform pg_temp.res('59 anon: accept refused', e like '42501%', e);
  reset role;
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ts values ('5x ended / paid / anon', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- report --------------------------------------------------------------------------------------------------
select name, result from _ts order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'TRIAL-TERMS-0207: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-TERMS-0207: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ts;
rollback;
