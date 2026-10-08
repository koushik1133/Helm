-- saved-views.sql -- 0064 saved_views (saved filters) RLS, share rule, default, caps, suspend.
-- Fixture: a_admin/a_staff(sales) studio A, b_admin/b_staff studio B. Rolled back. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _sv(name text, result text); grant all on _sv to anon, authenticated, service_role;
create temp table _ids(k text primary key, id uuid); grant all on _ids to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _sv values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.mk(p_k text, p_page text, p_name text, p_shared boolean) returns text language plpgsql as $$
declare i uuid; begin
  insert into public.saved_views(page, name, state, shared) values (p_page, p_name, '{"q":"x"}', p_shared) returning id into i;
  insert into _ids values (p_k, i) on conflict (k) do update set id = excluded.id; return '';
exception when others then return sqlstate; end $$;
grant execute on function pg_temp.mk(text,text,text,boolean) to anon, authenticated, service_role;
create or replace function pg_temp.id(p_k text) returns uuid language sql as $$ select id from _ids where k = p_k $$;
grant execute on function pg_temp.id(text) to anon, authenticated, service_role;
create or replace function pg_temp.sees(p_k text) returns boolean language sql as $$ select exists (select 1 from public.saved_views where id = pg_temp.id(p_k)) $$;
grant execute on function pg_temp.sees(text) to anon, authenticated, service_role;

do $$ declare u uuid; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su(); set local session_replication_role = replica;
  u := coalesce((select id from auth.users where email = 'sv_client@a.test'), auth.seed_user('sv_client@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'sv_client@a.test', 'Client', 'client', a, false, now()) on conflict (id) do update set role = 'client', org_id = a;
  delete from public.role_access where org_id = a and role = 'sales' and area = 'leads';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'quotes', true, true, a, now())
    on conflict do nothing;
  delete from public.studio_subscriptions where org_id = a;
end $$;

do $$ declare e text; n int; r record; begin
  perform pg_temp.su();
  perform pg_temp.res('01 RLS enabled', (select relrowsecurity from pg_class where oid = 'public.saved_views'::regclass));
  perform pg_temp.res('02 anon has no table privileges', not has_table_privilege('anon', 'public.saved_views', 'select')
    and not has_table_privilege('anon', 'public.saved_views', 'insert'));
  perform pg_temp.res('03 suspended-studio guard attached', exists (select 1 from pg_trigger where tgrelid = 'public.saved_views'::regclass and tgname = 'zzz_studio_read_only'));

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.mk('s1', 'leads', 'My hot leads', false);
  perform pg_temp.su(); select * into r from public.saved_views where id = pg_temp.id('s1');
  perform pg_temp.res('04 member saves own view; owner + studio stamped', e = '' and r.user_id = pg_temp.uid('a_staff@a.test')
    and r.org_id = 'a0000000-0000-4000-8000-000000000001', e);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.mk('s2', 'quotes', 'shared try', true);
  perform pg_temp.res('05 non-admin cannot share', e = '42501', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('update public.saved_views set shared = true where id = ''' || pg_temp.id('s1') || '''');
  perform pg_temp.res('06 non-admin cannot flip shared on', e = '42501', e);

  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.mk('aq', 'quotes', 'Confirmed only', true) || pg_temp.mk('al', 'leads', 'Admin leads', true) || pg_temp.mk('ap', 'quotes', 'Admin private', false);
  perform pg_temp.res('07 admin can share', e = '', e);

  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('08 member with quotes view sees shared quotes view', pg_temp.sees('aq'));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('09 member without leads area does not see shared leads view', not pg_temp.sees('al'));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('10 admin private view hidden from member', not pg_temp.sees('ap'));
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('11 admin does not see member private view', not pg_temp.sees('s1'));

  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.saved_views;
  perform pg_temp.res('12 other studio sees nothing', n = 0, n::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try('update public.saved_views set name = ''hack''');
  perform pg_temp.su(); select count(*) into n from public.saved_views where name = 'hack';
  perform pg_temp.res('13 other studio cannot rename', n = 0, e || n);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('update public.saved_views set name = ''x'' where id = ''' || pg_temp.id('aq') || '''')
    || pg_temp.try('delete from public.saved_views where id = ''' || pg_temp.id('aq') || '''');
  perform pg_temp.su(); select count(*) into n from public.saved_views where id = pg_temp.id('aq') and name = 'Confirmed only';
  perform pg_temp.res('14 member cannot edit or delete a shared view they do not own', n = 1, e || n);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('update public.saved_views set user_id = ''' || pg_temp.uid('a_admin@a.test') || ''' where id = ''' || pg_temp.id('s1') || '''');
  perform pg_temp.res('15 owner cannot be reassigned', e = '42501', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('insert into public.saved_views(org_id, user_id, page, name) values (''b0000000-0000-4000-8000-000000000001'', '''
       || pg_temp.uid('b_staff@b.test') || ''', ''leads'', ''forged'')');
  perform pg_temp.su(); select count(*) into n from public.saved_views where name = 'forged' and org_id = 'a0000000-0000-4000-8000-000000000001' and user_id = pg_temp.uid('a_staff@a.test');
  perform pg_temp.res('16 forged org/user on insert are overwritten with caller', e = '' and n = 1, e || n);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('insert into public.saved_views(page, name, state) values (''leads'', ''big'', jsonb_build_object(''q'', repeat(''x'', 5000)))');
  perform pg_temp.res('17 state over 4 KB refused', e = '23514', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('insert into public.saved_views(page, name) values (''hq'', ''bad'')') || '|'
    || pg_temp.try('insert into public.saved_views(page, name) values (''leads'', ''   '')') || '|'
    || pg_temp.try('insert into public.saved_views(page, name, state) values (''leads'', ''arr'', ''[1]'')');
  perform pg_temp.res('18 unknown page / blank name / non-object state refused', e = '23514|23514|23514', e);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.mk('s3', 'leads', 'Second', false);
  perform pg_temp.login('a_staff@a.test'); perform public.saved_view_set_default(pg_temp.id('s1'));
  perform pg_temp.login('a_staff@a.test'); perform public.saved_view_set_default(pg_temp.id('s3'));
  perform pg_temp.su(); select count(*) into n from public.saved_views where user_id = pg_temp.uid('a_staff@a.test') and page = 'leads' and is_default;
  perform pg_temp.res('19 set_default keeps exactly one default (moved)', n = 1 and (select is_default from public.saved_views where id = pg_temp.id('s3')), n::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select public.saved_view_set_default(''' || pg_temp.id('aq') || ''')');
  perform pg_temp.res('20 set_default on someone else''s view refused', e = 'P0002', e);
  perform pg_temp.login('a_staff@a.test'); perform public.saved_view_set_default(pg_temp.id('s3'), false);
  perform pg_temp.su(); select count(*) into n from public.saved_views where user_id = pg_temp.uid('a_staff@a.test') and is_default;
  perform pg_temp.res('21 set_default(false) clears it', n = 0, n::text);
  perform pg_temp.res('22 anon cannot run set_default', not has_function_privilege('anon', 'public.saved_view_set_default(uuid,boolean)', 'execute'));

  perform pg_temp.login('sv_client@a.test');
  e := pg_temp.mk('c1', 'leads', 'client', false);
  perform pg_temp.res('23 client role refused', e = '42501', e);
  perform pg_temp.su(); perform auth.login_anon();
  e := pg_temp.try('select count(*) from public.saved_views');
  perform pg_temp.res('24 signed-out caller refused', e = '42501', e);

  perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.studio_subscriptions(org_id, status) values ('a0000000-0000-4000-8000-000000000001', 'suspended');
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.mk('s4', 'leads', 'while suspended', false) || '|'
    || pg_temp.try('update public.saved_views set name = ''z'' where id = ''' || pg_temp.id('s1') || '''') || '|'
    || pg_temp.try('delete from public.saved_views where id = ''' || pg_temp.id('s1') || '''');
  perform pg_temp.res('25 suspended studio: insert/update/delete refused', e = '25006|25006|25006', e);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('26 suspended studio: reads still work', pg_temp.sees('s1'));
  perform pg_temp.su(); set local session_replication_role = replica;
  delete from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001';

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('delete from public.saved_views where id = ''' || pg_temp.id('s1') || '''');
  perform pg_temp.su(); select count(*) into n from public.saved_views where id = pg_temp.id('s1');
  perform pg_temp.res('27 owner deletes own view', e = '' and n = 0, e || n);
  perform pg_temp.su(); select count(*) into n from public.saved_views where page = 'quotes' and name in ('Confirmed only', 'Admin private');
  perform pg_temp.res('28 deleting own view touches no other rows', n = 2, n::text);
end $$;

select name, result from _sv order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 28 then 'SAVED-VIEWS: ALL PASS (28/28)'
            else 'SAVED-VIEWS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/28 ran' end from _sv;
rollback;
