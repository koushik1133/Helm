-- r44-two-step-0291.sql -- r44 help studio admins set up two-step: studio_two_step_status() answers ONLY yes / no per
-- member of the caller's OWN studio and ONLY to studio admins; the optional one-time bell notice (two_step_intro_send)
-- is a dry run by default, goes once per admin without two-step, bell only (no e-mail), never to anyone else, and the
-- app cannot call it. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
-- re-run safe: the migration applied again inside the test (the clean install already ran it once)
set client_min_messages = error;
\ir ../../supabase/migrations/0291_r44_admin_two_step.sql
\ir ../../supabase/migrations/0291_r44_admin_two_step.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
-- sign in as p_email; p_aal2 = signed in WITH the two-step code (a member who has two-step is only in a studio at aal2)
create or replace function pg_temp.as_user(p_email text, p_aal2 boolean default false) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  if p_aal2 then perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', 'aal2', 'amr',
    jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())))))::text, false); end if;
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select v::uuid from _kv where k = 'uid:' || p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at, full_name)
    values (u, p_email, p_role, p_org, false, now(), initcap(split_part(p_email, '@', 1)))
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  return u;
end $$;
create or replace function pg_temp.factor(p_email text) returns void language plpgsql as $$
begin perform pg_temp.su();
  if not exists (select 1 from auth.mfa_factors where user_id = pg_temp.uid(p_email) and status = 'verified') then
    insert into auth.mfa_factors(user_id, status) values (pg_temp.uid(p_email), 'verified'); end if; end $$;
-- what the caller's status answer looks like: {user id: yes / no}
create or replace function pg_temp.status_map() returns jsonb language plpgsql as $$
declare v jsonb; begin
  select coalesce(jsonb_object_agg(s.user_id::text, s.two_step), '{}'::jsonb) into v from public.studio_two_step_status() s; return v;
exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.status_map() to anon, authenticated, service_role;
create or replace function pg_temp.intro_rows(p_org uuid) returns integer language sql as $$
  select count(*)::int from public.notifications n where n.org_id = p_org and n.kind = 'studio_security'
     and n.detail ->> 'event' = 'two_step_intro' $$;

-- ---- setup: Studio A = 2 admins + 1 sales; Studio B = 1 admin + 1 sales; nobody has two-step; nobody sent yet -----
do $$ begin
  perform pg_temp.su();
  perform pg_temp.member('a_admin2@a.test', 'admin', 'a0000000-0000-4000-8000-000000000001');
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u
   where u.email in ('a_admin@a.test', 'a_admin2@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test') on conflict (k) do nothing;
  delete from auth.mfa_factors where user_id in (select v::uuid from _kv where k like 'uid:%');   -- test only (rolled back)
  delete from public.two_step_intro_sent;                                                        -- test only (rolled back)
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) objects + grants ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 ledger table: RLS on, no API privilege (anon / authenticated)',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.two_step_intro_sent'::regclass)
    and not has_table_privilege('authenticated', 'public.two_step_intro_sent', 'select')
    and not has_table_privilege('authenticated', 'public.two_step_intro_sent', 'insert')
    and not has_table_privilege('anon', 'public.two_step_intro_sent', 'select'));
  perform pg_temp.res('02 grants: status for signed-in people only (checks admin inside); the notice sender never from the app',
    has_function_privilege('authenticated', 'public.studio_two_step_status()', 'execute')
    and not has_function_privilege('anon', 'public.studio_two_step_status()', 'execute')
    and not has_function_privilege('authenticated', 'public.two_step_intro_send(boolean)', 'execute')
    and not has_function_privilege('anon', 'public.two_step_intro_send(boolean)', 'execute')
    and has_function_privilege('service_role', 'public.two_step_intro_send(boolean)', 'execute'));
  perform pg_temp.res('03 the answer has exactly two columns: user_id + two_step (no names, e-mails, factor ids or times)',
    (select array_agg(a.attname::text order by a.attnum) from pg_proc p, unnest(p.proargnames) with ordinality a(attname, attnum)
      where p.oid = 'public.studio_two_step_status()'::regprocedure) = array['user_id', 'two_step']);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) studio_two_step_status: own studio only, admins only ------------------------------------------------------
do $$ declare m jsonb; e text; begin
  perform pg_temp.as_user('a_admin@a.test');
  m := pg_temp.status_map();
  perform pg_temp.su();
  perform pg_temp.res('04 a Studio A admin gets every Studio A member (and only them), all "not set up" yet',
    not (m ? 'err')
    and (select count(*) from jsonb_object_keys(m)) = (select count(*) from public.profiles where org_id = 'a0000000-0000-4000-8000-000000000001')
    and (m ->> pg_temp.uid('a_admin@a.test')::text) = 'false' and (m ->> pg_temp.uid('a_admin2@a.test')::text) = 'false'
    and (m ->> pg_temp.uid('a_staff@a.test')::text) = 'false', m::text);
  perform pg_temp.res('05 never a Studio B member in Studio A''s answer (tenant isolation)',
    not (m ? pg_temp.uid('b_admin@b.test')::text) and not (m ? pg_temp.uid('b_staff@b.test')::text)
    and not exists (select 1 from jsonb_object_keys(m) k join public.profiles p on p.id = k::uuid
                     where p.org_id is distinct from 'a0000000-0000-4000-8000-000000000001'), m::text);

  perform pg_temp.factor('a_admin@a.test');
  perform pg_temp.as_user('a_admin2@a.test');
  m := pg_temp.status_map();
  perform pg_temp.su();
  perform pg_temp.res('06 once an admin verifies an authenticator, the badge says yes for them only',
    (m ->> pg_temp.uid('a_admin@a.test')::text) = 'true' and (m ->> pg_temp.uid('a_admin2@a.test')::text) = 'false'
    and (m ->> pg_temp.uid('a_staff@a.test')::text) = 'false', m::text);

  -- an UNverified (half-finished) set-up is not two-step
  insert into auth.mfa_factors(user_id, status) values (pg_temp.uid('a_admin2@a.test'), 'unverified');
  perform pg_temp.as_user('a_admin@a.test', true); m := pg_temp.status_map(); perform pg_temp.su();
  perform pg_temp.res('07 a half-finished set-up (unverified factor) still counts as "not set up"',
    (m ->> pg_temp.uid('a_admin2@a.test')::text) = 'false', m::text);
  delete from auth.mfa_factors where user_id = pg_temp.uid('a_admin2@a.test') and status <> 'verified';

  perform pg_temp.as_user('a_staff@a.test'); e := pg_temp.try('select count(*) from public.studio_two_step_status()'); perform pg_temp.su();
  perform pg_temp.res('08 a non-admin (sales) is refused (42501), learns nothing', e like '42501%', e);

  perform pg_temp.anon(); e := pg_temp.try('select count(*) from public.studio_two_step_status()'); perform pg_temp.su();
  perform pg_temp.res('09 signed out (anon) is refused', e like '42501%', e);

  perform pg_temp.as_user('b_admin@b.test'); m := pg_temp.status_map(); perform pg_temp.su();
  perform pg_temp.res('10 a Studio B admin sees only Studio B (never the Studio A admin who has two-step)',
    not (m ? 'err') and (m ? pg_temp.uid('b_staff@b.test')::text) and not (m ? pg_temp.uid('a_admin@a.test')::text)
    and (select count(*) from jsonb_object_keys(m)) = (select count(*) from public.profiles where org_id = 'b0000000-0000-4000-8000-000000000001'), m::text);

  -- a member moved to another studio leaves the old studio's answer
  update public.profiles set role = 'admin' where id = pg_temp.uid('b_staff@b.test');
  perform pg_temp.as_user('b_staff@b.test'); m := pg_temp.status_map(); perform pg_temp.su();
  update public.profiles set role = 'sales' where id = pg_temp.uid('b_staff@b.test');
  perform pg_temp.res('11 the answer follows the caller''s studio (a new Studio B admin: Studio B only)',
    not (m ? pg_temp.uid('a_admin@a.test')::text) and (m ? pg_temp.uid('b_admin@b.test')::text), m::text);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) the optional one-time notice ------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v_nid uuid; n_before integer; begin
  perform pg_temp.su();
  -- like a real SQL-editor run: no claims, maintenance switch not forced (0164 would keep a system change quiet)
  perform set_config('request.jwt.claims', '', false); perform set_config('helm.maintenance', '', false);
  n_before := (select count(*) from public.notifications);
  r := public.two_step_intro_send();
  perform pg_temp.res('12 dry run by default: counts only (Studio A: a_admin2; Studio B: b_admin), nothing written',
    (r ->> 'dry_run')::boolean and (r ->> 'admins')::int >= 2 and (r ->> 'studios')::int >= 2
    and (select count(*) from public.notifications) = n_before and not exists (select 1 from public.two_step_intro_sent), r::text);

  r := public.two_step_intro_send(false);
  select n.id into v_nid from public.notifications n where n.org_id = 'a0000000-0000-4000-8000-000000000001'
     and n.kind = 'studio_security' and n.detail ->> 'event' = 'two_step_intro';
  perform pg_temp.put('nid', v_nid::text);
  perform pg_temp.res('13 sent: ONE bell row per studio, kind studio_security (admins only), the agreed words, bell only (via comms)',
    not (r ->> 'dry_run')::boolean and v_nid is not null and pg_temp.intro_rows('a0000000-0000-4000-8000-000000000001') = 1
    and pg_temp.intro_rows('b0000000-0000-4000-8000-000000000001') = 1
    and (select n.detail ->> 'label' from public.notifications n where n.id = v_nid) = 'New: two-step protects your payment details. Set it up in 2 minutes.'
    and (select n.detail ->> 'via' from public.notifications n where n.id = v_nid) = 'comms'
    and (select n.channel from public.notifications n where n.id = v_nid) = 'in_app', r::text);
  perform pg_temp.res('14 no e-mail: nothing queued in any outbox for it',
    not exists (select 1 from public.helm_notice_outbox o where o.ref_id = v_nid or o.payload ->> 'event' = 'two_step_intro')
    and (to_regclass('public.comms_outbox') is null
         or not exists (select 1 from public.comms_outbox c where c.created_at >= now() and c.payload::text like '%two_step_intro%')));
  perform pg_temp.res('15 recorded once per admin WITHOUT two-step (a_admin2, b_admin) - never the admin who has it, never staff',
    exists (select 1 from public.two_step_intro_sent where user_id = pg_temp.uid('a_admin2@a.test'))
    and exists (select 1 from public.two_step_intro_sent where user_id = pg_temp.uid('b_admin@b.test'))
    and not exists (select 1 from public.two_step_intro_sent where user_id in (pg_temp.uid('a_admin@a.test'), pg_temp.uid('a_staff@a.test'), pg_temp.uid('b_staff@b.test'))));
  perform pg_temp.res('16 the Studio A admin who already has two-step: the row is Done in their own inbox (never shown, never counted)',
    exists (select 1 from public.notification_inbox_state s where s.user_id = pg_temp.uid('a_admin@a.test') and s.notification_id = v_nid and s.done_at is not null)
    and not exists (select 1 from public.notification_inbox_state s where s.user_id = pg_temp.uid('a_admin2@a.test') and s.notification_id = v_nid));
  if to_regprocedure('public._r23_rows(uuid, uuid)') is not null then
    perform pg_temp.res('17 bell: unread for the admin without two-step; Done for the one with it and for staff (never shown, never counted)',
      exists (select 1 from public._r23_rows('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test')) x where x.id = v_nid and x.is_unread and not x.is_done)
      and exists (select 1 from public._r23_rows('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test')) x where x.id = v_nid and x.is_done and not x.is_unread)
      -- staff: hidden by the admins-only type (0285) and, whatever their notification settings, already Done for them
      and not exists (select 1 from public._r23_rows('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test')) x where x.id = v_nid and (x.is_unread or not x.is_done)));
  else perform pg_temp.res('17 bell (skipped: no inbox)', true); end if;

  r := public.two_step_intro_send(false);
  perform pg_temp.res('18 sent ONCE: a second run sends nothing new to the same admins',
    (r ->> 'admins')::int = 0 and pg_temp.intro_rows('a0000000-0000-4000-8000-000000000001') = 1
    and pg_temp.intro_rows('b0000000-0000-4000-8000-000000000001') = 1, r::text);

  -- a NEW admin without two-step joins Studio A later: only they are told, the earlier ones are not told again
  perform pg_temp.member('a_admin3@a.test', 'admin', 'a0000000-0000-4000-8000-000000000001');
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u where u.email = 'a_admin3@a.test' on conflict (k) do nothing;
  r := public.two_step_intro_send(false);
  perform pg_temp.res('19 a later admin gets their own notice; earlier admins get the new row marked Done (no repeat)',
    (r ->> 'admins')::int = 1 and pg_temp.intro_rows('a0000000-0000-4000-8000-000000000001') = 2
    and exists (select 1 from public.two_step_intro_sent where user_id = pg_temp.uid('a_admin3@a.test'))
    and exists (select 1 from public.notification_inbox_state s join public.notifications n on n.id = s.notification_id
                 where s.user_id = pg_temp.uid('a_admin2@a.test') and s.done_at is not null and n.detail ->> 'event' = 'two_step_intro'
                   and n.id <> pg_temp.get('nid')::uuid), r::text);

  perform pg_temp.as_user('a_admin@a.test', true); e := pg_temp.try('select public.two_step_intro_send(false)'); perform pg_temp.su();
  perform pg_temp.res('20 a studio admin cannot send it from the app (permission denied)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', true); e := pg_temp.try('select count(*) from public.two_step_intro_sent'); perform pg_temp.su();
  perform pg_temp.res('21 the ledger is not readable from the app', e like '42501%', e);
  perform set_config('helm.maintenance', 'off', false);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) additive only --------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('22 nothing else changed: 0285 step-up still refuses an admin without two-step (R35_SETUP_2STEP)',
    position('R35_SETUP_2STEP' in pg_get_functiondef('public._r285_step_up(uuid)'::regprocedure)) > 0
    and to_regprocedure('public.studio_two_step_status()') is not null);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.su();
select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R44-TWO-STEP-0291: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R44-TWO-STEP-0291: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
