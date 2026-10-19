-- r20-business-0239.sql -- 0239: the Business page has its own access area 'business' (admin only by default).
-- Studio A (fixture) gets a planner (finance on, as the default matrix gives planners), a coordinator and an
-- event manager; the migration is applied twice; the Business RPCs refuse every role but admin until the
-- matrix switch is turned on; planners keep finance (event P&L, dashboard money, settlement payments);
-- new studios get the same default; tenants stay apart. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bz(name text, result text); grant all on _bz to anon, authenticated, service_role;
create temp table _bkv(k text primary key, v text); grant all on _bkv to anon, authenticated, service_role;

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
begin insert into _bz values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR ' || sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _bkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _bkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
-- the non-business access matrix of a studio, as one string (proves 0239 never touches it)
create or replace function pg_temp.matrix(p_org uuid) returns text language sql as $$
  select coalesce(md5(string_agg(role || ':' || area || ':' || can_view::text || ':' || can_edit::text || ':' || updated_at::text, ','
                                 order by role collate "C", area collate "C")), '')
    from public.role_access where org_id = p_org and area <> 'business' $$;

-- ---- setup: studio A with a planner / coordinator / manager (default-matrix rights), studio B's planner -------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.member('bz_planner@a.test', 'planner', a);
  perform pg_temp.member('bz_coord@a.test', 'coordinator', a);
  perform pg_temp.member('bz_mgr@a.test', 'manager', a);
  perform pg_temp.member('bz_planner@b.test', 'planner', b);
  perform pg_temp.su();
  -- the 0049 defaults for these roles (planner + manager: finance / settlement / closure / quotes; coordinator: quotes view)
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select d.o, d.role, d.area, d.can_view, d.can_edit, now() - interval '1 day'
      from (select o, x.* from (values (a), (b)) oo(o), public._a49_default_matrix() x
             where x.role in ('planner', 'coordinator', 'manager')) d
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = excluded.updated_at;
  -- studio B had already switched Business on for its planner (as if set in Control Center): must stay on
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values (b, 'planner', 'business', true, false, now() - interval '1 day')
    on conflict (org_id, role, area) do update set can_view = true, can_edit = false;
  update public.quotes set status = 'confirmed', event_date = current_date - 3
   where id in ('a0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-00000000da01');
  perform pg_temp.put('mA', pg_temp.matrix(a)); perform pg_temp.put('mB', pg_temp.matrix(b));
end $$;

-- ---- the migration, twice (the fixture studios were created after the clean install) -------------------------
\ir ../../supabase/migrations/0239_business_area_admin_only.sql
do $$ begin perform pg_temp.put('n1', (select count(*) from public.role_access where area = 'business')::text); end $$;
\ir ../../supabase/migrations/0239_business_area_admin_only.sql

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('01 studio A: one business row per role (12), admin view + edit, every other role off',
    (select count(*) from public.role_access where org_id = a and area = 'business') = 12
    and exists (select 1 from public.role_access where org_id = a and area = 'business' and role = 'admin' and can_view and can_edit)
    and not exists (select 1 from public.role_access where org_id = a and area = 'business' and role <> 'admin' and (can_view or can_edit)));
  perform pg_temp.res('02 every studio has the rows (incl. orgs made before the fixture)',
    not exists (select 1 from public.organizations o where (select count(*) from public.role_access ra
      where ra.org_id = o.id and ra.area = 'business') < 12));
  perform pg_temp.res('03 second run adds nothing (row count unchanged)',
    (select count(*) from public.role_access where area = 'business')::text = pg_temp.get('n1'));
  perform pg_temp.res('04 a business switch a studio had already turned on is kept (insert only, never overwritten)',
    exists (select 1 from public.role_access where org_id = b and role = 'planner' and area = 'business' and can_view and not can_edit));
  perform pg_temp.res('05 every other access row is untouched (values + updated_at) in both studios',
    pg_temp.matrix(a) = pg_temp.get('mA') and pg_temp.matrix(b) = pg_temp.get('mB'));
  perform pg_temp.res('06 planner keeps finance / settlement / closure (view + edit) in studio A',
    (select count(*) from public.role_access where org_id = a and role = 'planner' and area in ('finance', 'settlement', 'closure')
       and can_view and can_edit) = 3);
end $$;

-- ---- admin: the Business page works -----------------------------------------------------------------------
do $$ declare v text; begin
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('10 admin: has_area(business) true', public.has_area('business', 'view') and public.has_area('business', 'edit'));
  v := pg_temp.val($q$select jsonb_path_query_array(public.business_pnl(current_date - 30, current_date + 30), '$.events[*].quote_id')::text$q$);
  perform pg_temp.res('11 admin: business_pnl works (studio A''s confirmed event, not B''s)',
    position('a0000000-0000-4000-8000-00000000da01' in v) > 0 and position('b0000000-0000-4000-8000-00000000da01' in v) = 0, v);
  v := pg_temp.val($q$select (public.vendor_payables_summary() ? 'outstanding')::text$q$);
  perform pg_temp.res('12 admin: vendor_payables_summary works', v = 'true', v);
  perform pg_temp.su();
end $$;

-- ---- planner / coordinator / manager: page RPCs refused; planner finance paths still work --------------------
do $$ declare e text; v text; begin
  perform pg_temp.login('bz_planner@a.test');
  perform pg_temp.res('20 planner: finance view yes, business no', public.has_area('finance', 'view') and not public.has_area('business', 'view'));
  e := pg_temp.try($q$select public.business_pnl(null, null)$q$);
  perform pg_temp.res('21 planner: business_pnl refused 42501', e like '42501%', e);
  e := pg_temp.try($q$select public.vendor_payables_summary()$q$);
  perform pg_temp.res('22 planner: vendor_payables_summary refused 42501', e like '42501%', e);
  e := pg_temp.try($q$select public.business_pnl__pre0239(null, null)$q$) || ' | ' || pg_temp.try($q$select public.vendor_payables_summary__pre0239()$q$);
  perform pg_temp.res('23 planner: the kept bodies cannot be called directly (permission denied)',
    e like '42501%permission denied%| 42501%permission denied%', e);
  v := pg_temp.val($q$select (public.event_pnl('a0000000-0000-4000-8000-00000000da01') is not null)::text$q$);
  perform pg_temp.res('24 planner: event P&L (Settlement / Closure / Budget) still works', v = 'true', v);
  v := pg_temp.val($q$select (public.dashboard_money(12) ->> 'finance')$q$);
  perform pg_temp.res('25 planner: dashboard money still shows money (finance true)', v = 'true', v);
  e := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000000da01', 100, 'cash', 'BZ-0239-1')$q$);
  perform pg_temp.res('26 planner: recording a settlement payment on the event still works', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('27 the payment is on the ledger', exists (select 1 from public.quote_payments
    where quote_id = 'a0000000-0000-4000-8000-00000000da01' and amount = 100 and status = 'paid'));

  perform pg_temp.login('bz_coord@a.test');
  e := pg_temp.try($q$select public.business_pnl(null, null)$q$) || ' | ' || pg_temp.try($q$select public.vendor_payables_summary()$q$);
  perform pg_temp.res('28 coordinator: both Business RPCs refused', e like '42501%| 42501%', e);
  perform pg_temp.login('bz_mgr@a.test');
  e := pg_temp.try($q$select public.business_pnl(null, null)$q$) || ' | ' || pg_temp.try($q$select public.vendor_payables_summary()$q$);
  perform pg_temp.res('29 event manager (finance on): both Business RPCs refused', e like '42501%| 42501%', e);
  perform pg_temp.su();
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.business_pnl(null, null)$q$) || ' | ' || pg_temp.try($q$select public.vendor_payables_summary()$q$);
  perform pg_temp.res('30 signed out: refused', e like '42501%| 42501%', e);
  perform pg_temp.su();
end $$;

-- ---- the matrix switch (Control Center) grants it; switching off takes it away; tenants stay apart ----------
do $$ declare e text; v text; begin
  perform pg_temp.login('bz_planner@a.test');
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'business', true, false)$q$);
  perform pg_temp.res('40 a planner cannot switch business on for itself', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'business', true, false)$q$);
  perform pg_temp.res('41 admin switches business on for planners (Control Center)', e = '', e);
  perform pg_temp.login('bz_planner@a.test');
  v := pg_temp.val($q$select (public.business_pnl(null, null) ? 'events')::text || (public.vendor_payables_summary() ? 'paid')::text$q$);
  perform pg_temp.res('42 planner now sees the Business numbers', v = 'truetrue', v);
  perform pg_temp.login('bz_coord@a.test');
  e := pg_temp.try($q$select public.business_pnl(null, null)$q$);
  perform pg_temp.res('43 coordinator still refused (switch is per role)', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'business', false, false)$q$);
  perform pg_temp.login('bz_planner@a.test');
  e := e || pg_temp.try($q$select public.business_pnl(null, null)$q$);
  perform pg_temp.res('44 switched off again: planner refused', e like '42501%', e);
  -- studio B switched it on for its planner: works there, and only with studio B's own numbers
  perform pg_temp.login('bz_planner@b.test');
  v := pg_temp.val($q$select (public.vendor_payables_summary() ? 'outstanding')::text$q$);
  perform pg_temp.res('45 studio B planner (switch on in B) can open B''s Business numbers', v = 'true', v);
  v := pg_temp.val($q$select coalesce(jsonb_path_query_array(public.business_pnl(current_date - 30, current_date + 30), '$.events[*].quote_id')::text, '')$q$);
  perform pg_temp.res('46 studio B planner gets studio B''s event, never studio A''s',
    position('b0000000-0000-4000-8000-00000000da01' in v) > 0 and position('a0000000-0000-4000-8000-00000000da01' in v) = 0, v);
  perform pg_temp.su();
end $$;

-- ---- new studios: the clean default matrix has business for admin only; insights admin only ----------------
do $$ declare e text; o uuid; begin
  perform pg_temp.member('bz_new@c.test', 'admin', null);
  update public.profiles set org_id = null where email = 'bz_new@c.test';
  perform pg_temp.login('bz_new@c.test');
  e := pg_temp.try($q$select public.create_studio('BZ New Studio', 'bz_new@c.test')$q$);
  perform pg_temp.su();
  select org_id into o from public.profiles where email = 'bz_new@c.test';
  perform pg_temp.res('50 create_studio works', e = '' and o is not null, e);
  perform pg_temp.res('51 new studio: business row for admin (on) and every other default role (off)',
    exists (select 1 from public.role_access where org_id = o and area = 'business' and role = 'admin' and can_view and can_edit)
    and (select count(*) from public.role_access where org_id = o and area = 'business' and role <> 'admin' and not can_view and not can_edit) >= 10
    and not exists (select 1 from public.role_access where org_id = o and area = 'business' and role <> 'admin' and (can_view or can_edit)));
  perform pg_temp.res('52 new studio: planners still get finance / settlement / closure by default',
    (select count(*) from public.role_access where org_id = o and role = 'planner' and area in ('finance', 'settlement', 'closure') and can_view and can_edit) = 3);
  perform pg_temp.res('53 new studio: insights on for no role but admin',
    not exists (select 1 from public.role_access where org_id = o and area = 'insights' and role <> 'admin' and (can_view or can_edit)));
  perform pg_temp.res('54 default matrix: business + insights on for admin only',
    not exists (select 1 from public._a49_default_matrix() d where d.area in ('business', 'insights') and d.role <> 'admin' and (d.can_view or d.can_edit)));
  perform pg_temp.login('bz_planner@a.test');
  perform pg_temp.res('55 planner: insights area off (admin only by default)', not public.has_area('insights', 'view'));
  perform pg_temp.su();
end $$;

-- ---- the APPLY paste file's self-check holds on this database ------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('60 wrappers need business, kept bodies need finance, grants as designed',
    position('has_area(''business''' in (select prosrc from pg_proc where oid = to_regprocedure('public.business_pnl(date,date)'))) > 0
    and position('has_area(''finance''' in (select prosrc from pg_proc where oid = to_regprocedure('public.business_pnl__pre0239(date,date)'))) > 0
    and has_function_privilege('authenticated', 'public.business_pnl(date,date)', 'execute')
    and not has_function_privilege('anon', 'public.vendor_payables_summary()', 'execute')
    and not has_function_privilege('authenticated', 'public.vendor_payables_summary__pre0239()', 'execute'));
end $$;

select name, result from _bz order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R20-BUSINESS-0239: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R20-BUSINESS-0239: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bz;
rollback;
