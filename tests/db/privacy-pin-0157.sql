-- privacy-pin-0157.sql -- 0157: studio privacy PIN (Hide amounts) kept on the server as a bcrypt hash.
-- Fixture: a_admin (admin) + a_staff (sales, has controls EDIT) in studio A, b_admin in studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _pf(name text, result text); grant all on _pf to anon, authenticated, service_role;

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
begin insert into _pf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ declare e text; r jsonb; i int;
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  update auth.users set last_sign_in_at = now() - interval '2 hours' where email = 'a_admin@a.test';

  -- default state (no PIN set yet)
  perform pg_temp.login('a_staff@a.test');
  r := public.privacy_pin_status();
  perform pg_temp.res('01 default + staff cannot change', (r ->> 'is_default')::boolean and not (r ->> 'can_change')::boolean, r::text);
  perform pg_temp.res('02 status never returns a hash', not (r ? 'pin_hash') and not (r::text like '%$2%'), r::text);
  r := public.privacy_pin_check('0000');
  perform pg_temp.res('03 default 0000 unlocks', (r ->> 'ok')::boolean, r::text);
  r := public.privacy_pin_check('1234');
  perform pg_temp.res('04 wrong PIN counted', not (r ->> 'ok')::boolean and (r ->> 'tries_left')::int = 4, r::text);
  e := pg_temp.try($q$select public.privacy_pin_check('12a4')$q$);
  perform pg_temp.res('05 not 4 digits -> 22023', e like '22023%', e);
  e := pg_temp.try($q$select public.privacy_pin_set('0000', '4826')$q$);
  perform pg_temp.res('06 non-admin (even with controls edit) cannot change', e like '42501%', e);
  e := pg_temp.try($q$select public.privacy_pin_reset()$q$);
  perform pg_temp.res('07 non-admin cannot reset', e like '42501%', e);
  e := pg_temp.try($q$select * from public.privacy_pin$q$);
  perform pg_temp.res('08 table not readable by app roles', e like '42501%', e);
  e := pg_temp.try($q$select * from public.privacy_pin_attempts$q$);
  perform pg_temp.res('09 counter not readable by app roles', e like '42501%', e);

  -- admin changes the PIN
  perform pg_temp.login('a_admin@a.test');
  r := public.privacy_pin_status();
  perform pg_temp.res('10 admin can change', (r ->> 'can_change')::boolean, r::text);
  r := public.privacy_pin_set('9999', '4826');
  perform pg_temp.res('11 change needs the current PIN', not (r ->> 'ok')::boolean and r ->> 'reason' = 'wrong_current', r::text);
  r := public.privacy_pin_set('0000', '4826');
  perform pg_temp.res('12 admin sets a new PIN', (r ->> 'ok')::boolean, r::text);
  e := pg_temp.try($q$select public.privacy_pin_set('4826', '48')$q$);
  perform pg_temp.res('13 new PIN must be 4 digits', e like '22023%', e);
  perform pg_temp.su();
  perform pg_temp.res('14 stored as bcrypt, never plain', (select pin_hash from public.privacy_pin where org_id = orgA) like '$2%'
       and not exists (select 1 from public.privacy_pin where pin_hash like '%4826%'));
  perform pg_temp.res('15 audit row without the PIN', exists (select 1 from public.audit_log where action = 'privacy_pin.set' and org_id = orgA)
       and not exists (select 1 from public.audit_log where action like 'privacy_pin%' and changed::text like '%4826%'));

  -- everyone in the studio now unlocks with the new PIN
  perform pg_temp.login('a_staff@a.test');
  r := public.privacy_pin_check('0000');
  perform pg_temp.res('16 old default no longer works', not (r ->> 'ok')::boolean, r::text);
  r := public.privacy_pin_check('4826');
  perform pg_temp.res('17 new PIN unlocks for staff', (r ->> 'ok')::boolean, r::text);
  r := public.privacy_pin_status();
  perform pg_temp.res('18 status no longer default', not (r ->> 'is_default')::boolean, r::text);

  -- other studio is untouched
  perform pg_temp.login('b_admin@b.test');
  r := public.privacy_pin_check('4826');
  perform pg_temp.res('19 other studio: A PIN does not work', not (r ->> 'ok')::boolean, r::text);
  r := public.privacy_pin_check('0000');
  perform pg_temp.res('20 other studio keeps default 0000', (r ->> 'ok')::boolean, r::text);

  -- lockout: 5 wrong -> 30 s; the right PIN is refused while locked
  perform pg_temp.login('a_staff@a.test');
  for i in 1..4 loop r := public.privacy_pin_check('1111'); end loop;
  perform pg_temp.res('21 four wrong -> one try left', (r ->> 'tries_left')::int = 1 and (r ->> 'locked_seconds')::int = 0, r::text);
  r := public.privacy_pin_check('1111');
  perform pg_temp.res('22 fifth wrong -> locked 30 s', (r ->> 'locked_seconds')::int = 30, r::text);
  r := public.privacy_pin_check('4826');
  perform pg_temp.res('23 right PIN refused while locked', not (r ->> 'ok')::boolean and (r ->> 'locked_seconds')::int > 0, r::text);
  perform pg_temp.su();
  update public.privacy_pin_attempts set locked_until = now() - interval '1 second'
   where user_id = (select id from auth.users where email = 'a_staff@a.test');
  perform pg_temp.login('a_staff@a.test');
  for i in 1..5 loop r := public.privacy_pin_check('1111'); end loop;
  perform pg_temp.res('24 next lock doubles (60 s)', (r ->> 'locked_seconds')::int = 60, r::text);

  -- reset (forgot PIN): only within 15 minutes of signing in
  perform pg_temp.login('a_admin@a.test');
  r := public.privacy_pin_reset();
  perform pg_temp.res('25 reset refused on an old sign-in', not (r ->> 'ok')::boolean and r ->> 'reason' = 'sign_in_again', r::text);
  perform pg_temp.su();
  update auth.users set last_sign_in_at = now() - interval '2 minutes' where email = 'a_admin@a.test';
  perform pg_temp.login('a_admin@a.test');
  r := public.privacy_pin_reset();
  perform pg_temp.res('26 reset right after sign-in -> default', (r ->> 'ok')::boolean, r::text);
  r := public.privacy_pin_check('0000');
  perform pg_temp.res('27 default 0000 works again', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('28 reset keeps the row (no delete)', exists (select 1 from public.privacy_pin where org_id = orgA and pin_hash is null));

  -- anon
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.privacy_pin_check('0000')$q$);
  perform pg_temp.res('29 anon cannot check', e like '42501%', e);
  e := pg_temp.try($q$select public.privacy_pin_status()$q$);
  perform pg_temp.res('30 anon cannot read status', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _pf values ('3x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _pf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PRIVACY-PIN-0157: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PRIVACY-PIN-0157: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _pf;
rollback;
