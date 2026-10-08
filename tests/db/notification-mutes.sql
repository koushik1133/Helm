-- notification-mutes.sql - 0063: per-person muted notification types.
-- Fixture: Studio A (a_admin, a_staff) and Studio B (b_admin). Rolled back at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _nm(name text, result text); grant all on _nm to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _nm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.mute(p_email text, p_type text, p_on boolean) returns jsonb language plpgsql as $$
declare j jsonb; begin perform pg_temp.login(p_email);
  begin j := public.set_notification_mute(p_type, p_on); exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j; end $$;
create or replace function pg_temp.mine(p_email text) returns jsonb language plpgsql as $$
declare j jsonb; begin perform pg_temp.login(p_email);
  begin j := public.my_notification_mutes(); exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j; end $$;

do $$ declare j jsonb; n int; e text; begin
  j := pg_temp.mute('a_staff@a.test', 'task_update', true);
  perform pg_temp.res('01 mute returns list', j = '["task_update"]'::jsonb, j::text);
  j := pg_temp.mute('a_staff@a.test', 'task_update', true);
  perform pg_temp.res('02 mute twice is idempotent', j = '["task_update"]'::jsonb, j::text);
  j := pg_temp.mute('a_staff@a.test', 'security_alert', true);
  perform pg_temp.res('03 security can be muted', j = '["security_alert","task_update"]'::jsonb, j::text);
  j := pg_temp.mute('a_staff@a.test', 'not_a_type', true);
  perform pg_temp.res('04 unknown type refused', j ->> 'err' = '22023', j::text);
  j := pg_temp.mute('a_staff@a.test', 'Bad Type!', true);
  perform pg_temp.res('05 junk type refused', j ->> 'err' = '22023', j::text);
  j := pg_temp.mine('a_admin@a.test');
  perform pg_temp.res('06 other person sees none of mine', j = '[]'::jsonb, j::text);
  j := pg_temp.mine('b_admin@b.test');
  perform pg_temp.res('07 other studio sees none', j = '[]'::jsonb, j::text);
  -- direct table reads: own rows only
  perform pg_temp.login('a_admin@a.test'); select count(*) into n from public.notification_mutes; perform pg_temp.su();
  perform pg_temp.res('08 RLS hides other people rows', n = 0, n::text);
  perform pg_temp.login('a_staff@a.test'); select count(*) into n from public.notification_mutes; perform pg_temp.su();
  perform pg_temp.res('09 RLS shows own rows', n = 2, n::text);
  -- direct writes refused
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.notification_mutes(user_id, org_id, type) values (auth.uid(), public.current_org_id(), 'other'); e := 'ok';
  exception when others then e := sqlstate; end; perform pg_temp.su();
  perform pg_temp.res('10 direct insert refused', e = '42501', e);
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.notification_mutes; e := 'ok'; exception when others then e := sqlstate; end; perform pg_temp.su();
  perform pg_temp.res('11 direct delete refused', e = '42501', e);
  -- anon refused
  perform pg_temp.anon(); begin j := public.my_notification_mutes(); e := 'ok'; exception when others then e := sqlstate; end; perform pg_temp.su();
  perform pg_temp.res('12 anon cannot list', e = '42501', e);
  perform pg_temp.anon(); begin j := public.set_notification_mute('other', true); e := 'ok'; exception when others then e := sqlstate; end; perform pg_temp.su();
  perform pg_temp.res('13 anon cannot mute', e = '42501', e);
  -- unmute
  j := pg_temp.mute('a_staff@a.test', 'security_alert', false);
  perform pg_temp.res('14 unmute removes', j = '["task_update"]'::jsonb, j::text);
  j := pg_temp.mute('a_staff@a.test', 'security_alert', false);
  perform pg_temp.res('15 unmute twice ok', j = '["task_update"]'::jsonb, j::text);
  perform pg_temp.res('16 RLS on', (select relrowsecurity from pg_class where oid = 'public.notification_mutes'::regclass));
  perform pg_temp.res('17 RPCs security definer', (select bool_and(prosecdef) from pg_proc where proname in ('my_notification_mutes','set_notification_mute') and pronamespace = 'public'::regnamespace));
end $$;

select name, result from _nm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then format('NOTIFICATION-MUTES: ALL PASS (%s/%s)', count(*), count(*))
            else format('NOTIFICATION-MUTES: %s FAILED', count(*) filter (where result <> 'PASS')) end as summary
  from _nm;
rollback;
