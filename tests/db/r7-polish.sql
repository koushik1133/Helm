-- r7-polish.sql -- 0084: plain-ASCII messages, phone triggers (new/changed only), reopen_event.
-- Fixture: a_admin/a_staff studio A, b_admin studio B, quoteA. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _r7(name text, result text); grant all on _r7 to anon, authenticated, service_role;
create temp table _r7kv(k text primary key, v text); grant all on _r7kv to anon, authenticated, service_role;

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
begin insert into _r7 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _r7kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _r7kv where k = p_k $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  bad uuid; good uuid; e text; r public.event_closure; n int; begin
  perform pg_temp.su();
  -- an OLD bad row, inserted with the trigger off (simulates data from before 0084)
  alter table public.crew_members disable trigger zz_a84_phone_check;
  insert into public.crew_members(name, phone, org_id) values ('Old Bad', '8765432134567890-=-0987w45e', a) returning id into bad;
  alter table public.crew_members enable trigger zz_a84_phone_check;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'closure', true, true, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;

  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.crew_members(name, phone) values ('Junk', '8765432134567890-=-098765432123w45e6r7t8y9u0iop')$q$);
  perform pg_temp.res('01 garbage phone refused on insert', (e like '22023%' or e like '23514%'), e);
  e := pg_temp.try($q$insert into public.crew_members(name, phone) values ('Short', '12345')$q$);
  perform pg_temp.res('02 too-short phone refused', (e like '22023%' or e like '23514%'), e);
  e := pg_temp.try($q$insert into public.crew_members(name, phone) values ('Good R7', '+919876543210')$q$);
  perform pg_temp.res('03 E.164 phone accepted', e = '', e);
  e := pg_temp.try(format('update public.crew_members set name = %L, active = false where id = %L', 'Old Bad 2', bad));
  perform pg_temp.res('04 old bad row still editable when phone unchanged', e = '', e);
  e := pg_temp.try(format('update public.crew_members set phone = %L where id = %L', '12345678901234567890', bad));
  perform pg_temp.res('05 changing to another bad phone refused', (e like '22023%' or e like '23514%'), e);
  e := pg_temp.try(format('update public.crew_members set phone = %L where id = %L', '98765 43210', bad));
  perform pg_temp.res('06 fixing the bad phone accepted', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('07 no table constraint added (old rows never re-checked)', not exists (select 1 from pg_constraint where conname like '%a84%'));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.nurture(name, phone) values ('N bad', 'xx12')$q$);
  perform pg_temp.res('08 nurture garbage phone refused', (e like '22023%' or e like '23514%'), e);
  e := pg_temp.try($q$insert into public.nurture(name, phone) values ('N good', '+919812345678')$q$);
  perform pg_temp.res('09 nurture phone stored', e = '' and exists (select 1 from public.nurture where name = 'N good' and phone = '+919812345678'), e);

  -- messages plain ASCII
  perform pg_temp.su();
  perform pg_temp.res('10 stage/closed messages plain ASCII', (select bool_and(prosrc !~ '[^\x01-\x7e]') from pg_proc where oid in
    ('public.set_lifecycle_stage(uuid,text,text)'::regprocedure, 'public._a52_stage_blockers(uuid,text)'::regprocedure, 'public._a46_tg_money_freeze()'::regprocedure)));

  -- reopen_event
  insert into public.event_closure(quote_id, closed_at, org_id) values (q, now() - interval '1 day', a)
    on conflict (quote_id) do update set closed_at = excluded.closed_at;
  update public.quotes set lifecycle_stage = 'closed' where id = q;
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'staff tries'));
  perform pg_temp.res('11 non-admin cannot reopen', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'other studio'));
  perform pg_temp.res('12 other studio admin cannot reopen', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'no'));
  perform pg_temp.res('13 short reason refused', (e like '22023%' or e like '23514%'), e);
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'client asked for a late change'));
  perform pg_temp.res('14 admin reopens', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('15 closed_at cleared + stage settlement',
    (select closed_at is null from public.event_closure where quote_id = q) and (select lifecycle_stage from public.quotes where id = q) = 'settlement');
  select count(*) into n from public.audit_log where action = 'event_reopen' and quote_id = q and changed ->> 'reason' = 'client asked for a late change';
  perform pg_temp.res('16 audit row written', n = 1, n::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'again please'));
  perform pg_temp.res('17 reopening an open event refused', (e like '22023%' or e like '23514%'), e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.reopen_event(%L, %L)', q, 'anon tries'));
  perform pg_temp.res('18 anon cannot execute', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _r7 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _r7 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R7-POLISH: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R7-POLISH: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _r7;
rollback;
