-- anon-grant-tidy-0204.sql -- 0204: with only the public (anon) key, a direct read of profiles / layouts /
-- venues / client_booklets / coupons / event_sites answers a plain "permission denied for table" (never the
-- name of current_org_id or another internal object), anon holds no privilege on them, the 14 studio-only
-- policies apply to signed-in callers only with their rules unchanged, signed-in members still read +
-- write exactly as before (own studio only), the public link RPCs stay callable by anon, and the
-- nurture_templates update stays scoped to the caller's studio. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ag(name text, result text); grant all on _ag to anon, authenticated, service_role;
create temp table _agkv(k text primary key, v text); grant all on _agkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ag values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return '';
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.cnt(p_sql text) returns int language plpgsql as $$
declare n int; begin execute p_sql into n; return n; exception when others then return -1; end $$;
grant execute on function pg_temp.cnt(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _agkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _agkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- what anon may call BEFORE 0204 runs here (0204 must not change any function grant)
insert into _agkv select 'anon_fns', coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text), '')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute');
-- earlier suites in run-all re-apply older migrations: re-run 0204 (also proves a re-run is safe)
\ir ../../supabase/migrations/0204_anon_grant_tidy.sql
\ir ../../supabase/migrations/0204_anon_grant_tidy.sql

-- ---- setup: one layout, coupon and nurture template per fixture studio (made by each studio's admin; the
-- org trigger stamps the caller's studio) ------------------------------------------------------------------
do $$ declare a uuid; b uuid; begin
  select org_id into a from public.profiles where email = 'a_admin@a.test';
  select org_id into b from public.profiles where email = 'b_admin@b.test';
  perform pg_temp.put('A', a::text); perform pg_temp.put('B', b::text);
  delete from public.nurture_templates where occasion_type = 'ag0203';
  perform pg_temp.login('a_admin@a.test');
  insert into public.layouts(name) values ('ag A layout');
  insert into public.coupons(code, kind, value) values ('AGA0203', 'percent', 5);
  insert into public.nurture_templates(occasion_type, subject, body) values ('ag0203', 'A subject', 'A body');
  perform pg_temp.login('b_admin@b.test');
  insert into public.layouts(name) values ('ag B layout');
  insert into public.coupons(code, kind, value) values ('AGB0203', 'percent', 5);
  insert into public.nurture_templates(occasion_type, subject, body) values ('ag0203', 'B subject', 'B body');
  perform pg_temp.su();
  perform pg_temp.res('00 setup: each studio has its own rows',
    (select count(*) from public.layouts where name in ('ag A layout', 'ag B layout') and org_id in (a, b)) = 2
    and (select count(distinct org_id) from public.nurture_templates where occasion_type = 'ag0203') = 2);
exception when others then perform pg_temp.su(); insert into _ag values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- anon: plain table errors, never an internal function name ---------------------------------------------
do $$ declare t text; e text; i int := 0; begin
  perform pg_temp.anon();
  foreach t in array array['profiles', 'layouts', 'venues', 'client_booklets', 'coupons', 'event_sites'] loop
    i := i + 1;
    e := pg_temp.try(format('select count(*) from public.%I', t));
    perform pg_temp.res(lpad(i::text, 2, '0') || ' anon read of ' || t || ': plain permission denied for the table',
      e like '42501%' and e like '%permission denied for table ' || t || '%' and e not like '%current_org_id%' and e not like '%function%', e);
  end loop;
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ag values ('0x anon reads', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try($q$insert into public.layouts(name, org_id) values ('anon', null)$q$);
  perform pg_temp.res('07 anon insert into layouts: plain permission denied', e like '42501%' and e not like '%current_org_id%', e);
  e := pg_temp.try($q$update public.coupons set value = 99$q$);
  perform pg_temp.res('08 anon update of coupons: plain permission denied', e like '42501%' and e not like '%current_org_id%', e);
  e := pg_temp.try($q$delete from public.event_sites$q$);
  perform pg_temp.res('09 anon delete from event_sites: plain permission denied', e like '42501%' and e not like '%current_org_id%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ag values ('0x anon writes', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.res('10 anon holds no privilege on the six tables',
  not exists (select 1 from unnest(array['profiles','layouts','venues','client_booklets','coupons','event_sites']) t
               where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
                  or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('anon', 'public.' || t, 'delete')));
select pg_temp.res('11 the 14 studio-only policies apply to authenticated only',
  (select count(*) from pg_policies where schemaname = 'public' and roles = array['authenticated']::name[]
     and (tablename, policyname) in (('profiles','profiles_select'), ('layouts','layouts_select'), ('layouts','layouts_ins'),
       ('layouts','layouts_upd'), ('layouts','layouts_del'), ('client_booklets','client_booklets_read'), ('coupons','coupons_select'),
       ('coupons','coupons_ins'), ('coupons','coupons_upd'), ('coupons','coupons_del'), ('event_sites','event_sites_select'),
       ('event_sites','event_sites_insert'), ('event_sites','event_sites_update'), ('event_sites','event_sites_delete'))) = 14);
select pg_temp.res('12 their studio rules are unchanged (still current_org_id)',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('profiles','layouts','client_booklets','coupons','event_sites')
               and policyname in ('profiles_select','layouts_select','layouts_ins','layouts_upd','layouts_del','client_booklets_read','coupons_select',
                                  'coupons_ins','coupons_upd','coupons_del','event_sites_select','event_sites_insert','event_sites_update','event_sites_delete')
               and (coalesce(qual,'') || coalesce(with_check,'')) !~ 'current_org_id\('));
select pg_temp.res('13 no policy that anon gets still calls current_org_id (whole public schema)',
  not exists (select 1 from pg_policies p join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace
               where p.schemaname = 'public' and p.roles && array['public','anon']::name[]
                 and (coalesce(p.qual,'') || coalesce(p.with_check,'')) ~ 'current_org_id\('
                 and has_table_privilege('anon', c.oid, 'select')),
  (select string_agg(p.tablename || '.' || p.policyname, ', ') from pg_policies p join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace
     where p.schemaname = 'public' and p.roles && array['public','anon']::name[] and (coalesce(p.qual,'') || coalesce(p.with_check,'')) ~ 'current_org_id\('
       and has_table_privilege('anon', c.oid, 'select')));
select pg_temp.res('14 restrictive policies untouched (layouts clean-archive rule still applies to everyone)',
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'layouts' and policyname = 'helm_clean_archive_185'
           and permissive = 'RESTRICTIVE' and roles = array['public']::name[]));
select pg_temp.res('15 current_org_id still not callable by anon; 0204 changed no function grant (public link RPCs as before)',
  not has_function_privilege('anon', 'public.current_org_id()', 'execute')
  and (select coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text), '') from pg_proc p
        where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')) = pg_temp.get('anon_fns')
  and exists (select 1 from pg_proc where proname = 'public_event_site' and pronamespace = 'public'::regnamespace and has_function_privilege('anon', oid, 'execute')));

-- ---- signed in: unchanged, own studio only ---------------------------------------------------------------
do $$ declare n int; e text; begin
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('16 admin A reads own profile + studio profiles, none of B',
    pg_temp.cnt($q$select count(*) from public.profiles where email = 'a_admin@a.test'$q$) = 1
    and pg_temp.cnt($q$select count(*) from public.profiles where email like '%@a.test'$q$) >= 2
    and pg_temp.cnt($q$select count(*) from public.profiles where email like '%@b.test'$q$) = 0);
  perform pg_temp.res('17 admin A reads A layouts, not B',
    pg_temp.cnt($q$select count(*) from public.layouts where name = 'ag A layout'$q$) = 1
    and pg_temp.cnt($q$select count(*) from public.layouts where name = 'ag B layout'$q$) = 0);
  e := pg_temp.try($q$insert into public.layouts(name) values ('ag A layout 2')$q$);
  perform pg_temp.res('18 admin A can still add a layout', e = '' and pg_temp.cnt($q$select count(*) from public.layouts where name = 'ag A layout 2'$q$) = 1, e);
  perform pg_temp.res('19 admin A reads A coupon, not B', pg_temp.cnt($q$select count(*) from public.coupons where code in ('AGA0203','AGB0203')$q$) = 1);
  e := pg_temp.try($q$update public.coupons set value = 7 where code in ('AGA0203','AGB0203')$q$);
  perform pg_temp.res('20 admin A coupon update reaches A only', e = '', e);
  -- nurture_templates: the store now sends .eq(org_id).eq(occasion_type); RLS keeps even a bare occasion filter in-studio
  e := pg_temp.try($q$update public.nurture_templates set subject = 'A edited' where occasion_type = 'ag0203'$q$);
  perform pg_temp.res('21 nurture template update (occasion only) changes A row only', e = '', e);
  e := pg_temp.try(format($q$update public.nurture_templates set body = 'A body 2' where org_id = %L and occasion_type = 'ag0203'$q$, pg_temp.get('A')));
  perform pg_temp.res('22 nurture template update with the studio filter works', e = '', e);
  perform pg_temp.res('23 B studio nurture template not visible to A', pg_temp.cnt($q$select count(*) from public.nurture_templates where occasion_type = 'ag0203'$q$) = 1);
  perform pg_temp.res('24 approval links: A sees only its own quotes (RLS), never B',
    pg_temp.cnt($q$select count(*) from public.quotes q join public.organizations o on o.id = q.org_id where o.id <> public.current_org_id()$q$) = 0);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ag values ('1x signed in', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.res('25 B data untouched by A (coupon value, nurture subject + body)',
  (select value from public.coupons where code = 'AGB0203') = 5
  and (select subject from public.nurture_templates where occasion_type = 'ag0203' and org_id = pg_temp.get('B')::uuid) = 'B subject'
  and (select body from public.nurture_templates where occasion_type = 'ag0203' and org_id = pg_temp.get('B')::uuid) = 'B body'
  and (select value from public.coupons where code = 'AGA0203') = 7
  and (select subject from public.nurture_templates where occasion_type = 'ag0203' and org_id = pg_temp.get('A')::uuid) = 'A edited');

do $$ begin
  perform pg_temp.anon();
  perform pg_temp.res('26 anon still reads no quote row (approval tokens never reach a signed-out caller)',
    pg_temp.cnt($q$select count(*) from public.quotes where approval_token is not null$q$) <= 0);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ag values ('26 anon quotes', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- la-fetch (store-api READ_RPCS): the RPCs the browser now treats as pure reads must be read-only in the database
select pg_temp.res('27 RPCs the app coalesces as reads are STABLE (never write)',
  not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and provolatile = 'v'
               and proname in ('my_trial_org','my_upgrade_status','my_trial_limits','my_trial_access','my_seat_usage','my_notification_prefs',
                               'my_notification_mutes','my_studio_route','my_tasks','list_quote_shelf','chat_my_mentions','privacy_pin_status',
                               'my_trial_status','my_demo_status','bell_feed','chat_directory','my_profile','my_profile_status'))
  and (select count(distinct proname) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('my_trial_org','my_upgrade_status','list_quote_shelf','chat_my_mentions','privacy_pin_status','bell_feed')) = 6,
  (select string_agg(proname, ', ') from pg_proc where pronamespace = 'public'::regnamespace and provolatile = 'v'
     and proname in ('my_trial_org','my_upgrade_status','my_trial_limits','my_trial_access','my_seat_usage','my_notification_prefs',
                     'my_notification_mutes','my_studio_route','my_tasks','list_quote_shelf','chat_my_mentions','privacy_pin_status',
                     'my_trial_status','my_demo_status','bell_feed','chat_directory','my_profile','my_profile_status')));

select pg_temp.su();
select name, result from _ag order by name;
select case when (select count(*) from _ag where result <> 'PASS') = 0
            then 'ANON-GRANT-TIDY-0204: ALL PASS (' || (select count(*) from _ag) || '/' || (select count(*) from _ag) || ')'
            else 'ANON-GRANT-TIDY-0204: FAILURES ' || (select count(*) from _ag where result <> 'PASS') end as verdict;
rollback;
