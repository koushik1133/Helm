-- inv-fixes.sql - behavioral proof for migration 0073: check-outs are cancelled (never deleted),
-- cancelled rows never count as "out" (checkout_equipment / reserve_inventory), audit trail,
-- and the duplicate active-name partial unique indexes (incl. the skip-when-dirty path).
-- Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _if; create temp table _if(name text, result text);
grant all on _if to anon, authenticated;
drop table if exists _ift; create temp table _ift as select substr(md5(random()::text), 1, 10) as tag;
grant all on _ift to anon, authenticated;

-- ---- 1) cancel_checkout -------------------------------------------------------------------
do $$ declare a_admin uuid; a_staff uuid; b_admin uuid; item uuid; co uuid; co2 uuid; c public.inventory_checkouts;
  n int; v_st text; v_by uuid; tag text := (select tag from _ift); begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_admin from auth.users where email='b_admin@b.test';
  insert into public.inventory_items(name, total_qty, org_id)
    values ('IF_tables_'||tag, 10, 'a0000000-0000-4000-8000-000000000001') returning id into item;
  perform auth.login_as(a_admin);
  c := public.checkout_equipment(item, null, 6, 'Crew A', null, null); co := c.id;
  begin perform public.checkout_equipment(item, null, 5, 'Crew B', null, null); insert into _if values('01 over-issue refused while 6 out','FAIL: allowed');
  exception when others then insert into _if values('01 over-issue refused while 6 out', case when sqlstate='23514' then 'PASS' else 'FAIL: '||sqlstate end); end;

  -- not allowed without inventory edit / from another studio
  perform auth.logout(); perform auth.login_as(a_staff);
  begin perform public.cancel_checkout(co, null); insert into _if values('02 cancel needs inventory edit','FAIL: allowed');
  exception when others then insert into _if values('02 cancel needs inventory edit', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout(); perform auth.login_as(b_admin);
  begin perform public.cancel_checkout(co, null); insert into _if values('03 other studio cannot cancel','FAIL: allowed');
  exception when others then insert into _if values('03 other studio cannot cancel', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;

  -- the API can not hard-delete a check-out row
  perform auth.logout(); perform auth.login_as(a_admin);
  begin delete from public.inventory_checkouts where id = co; get diagnostics n = row_count;
    insert into _if values('04 API delete of a check-out refused', case when n = 0 then 'PASS' else 'FAIL: deleted '||n end);
  exception when others then insert into _if values('04 API delete of a check-out refused', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  execute 'reset role';
  insert into _if values('05 row still there after delete attempt', case when exists(select 1 from public.inventory_checkouts where id = co) then 'PASS' else 'FAIL: gone' end);

  -- cancel: kept, marked, audited; stock free again
  perform auth.login_as(a_admin);
  c := public.cancel_checkout(co, 'entered twice');
  execute 'reset role';
  select status, cancelled_by into v_st, v_by from public.inventory_checkouts where id = co;
  insert into _if values('06 cancel marks row cancelled + who', case when v_st = 'cancelled' and v_by = a_admin then 'PASS' else 'FAIL: '||coalesce(v_st,'?') end);
  select count(*) into n from public.audit_log where entity = 'inventory_checkouts' and entity_id = co::text and action = 'update'
    and changed ? 'status';
  insert into _if values('07 cancel written to audit_log', case when n >= 1 then 'PASS' else 'FAIL: n='||n end);
  perform auth.login_as(a_admin);
  begin c := public.checkout_equipment(item, null, 10, 'Crew C', null, null); co2 := c.id; insert into _if values('08 cancelled stock is available again (10/10)','PASS');
  exception when others then insert into _if values('08 cancelled stock is available again (10/10)','FAIL: '||sqlerrm); end;
  begin c := public.cancel_checkout(co, null); insert into _if values('09 cancel is idempotent', case when c.status = 'cancelled' then 'PASS' else 'FAIL: '||c.status end);
  exception when others then insert into _if values('09 cancel is idempotent','FAIL: '||sqlerrm); end;
  begin perform public.checkin_equipment(co, 1, 'x', false); insert into _if values('10 check-in of cancelled row refused','FAIL: allowed');
  exception when others then insert into _if values('10 check-in of cancelled row refused', case when sqlerrm like '%cancelled%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  -- something returned -> cannot cancel
  perform public.checkin_equipment(co2, 4, 'Crew C', false);
  begin perform public.cancel_checkout(co2, null); insert into _if values('11 partly returned check-out cannot be cancelled','FAIL: allowed');
  exception when others then insert into _if values('11 partly returned check-out cannot be cancelled', case when sqlstate='P0001' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout();
exception when others then execute 'reset role'; insert into _if values('1x cancel setup','FAIL: '||sqlerrm); end $$;

-- ---- 2) reserve_inventory ignores cancelled check-outs --------------------------------------
do $$ declare a_admin uuid; item uuid; qA uuid; c public.inventory_checkouts; tag text := (select tag from _ift); begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into qA from public.quotes where code = 'A-0001' and org_id = 'a0000000-0000-4000-8000-000000000001';
  insert into public.inventory_items(name, total_qty, org_id)
    values ('IF_plates_'||tag, 10, 'a0000000-0000-4000-8000-000000000001') returning id into item;
  perform auth.login_as(a_admin);
  c := public.checkout_equipment(item, qA, 10, 'Crew A', null, null);
  begin perform public.reserve_inventory(item, qA, 11, null); insert into _if values('12 reserve over stock refused','FAIL: allowed');
  exception when others then insert into _if values('12 reserve over stock refused', case when sqlstate='P0001' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform public.cancel_checkout(c.id, null);
  begin perform public.reserve_inventory(item, qA, 10, null); insert into _if values('13 reserve sum excludes cancelled check-out','PASS');
  exception when others then insert into _if values('13 reserve sum excludes cancelled check-out','FAIL: '||sqlerrm); end;
  perform auth.logout();
exception when others then execute 'reset role'; insert into _if values('2x reserve setup','FAIL: '||sqlerrm); end $$;

-- ---- 3) duplicate active names --------------------------------------------------------------
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  tag text := (select tag from _ift); nm text; begin
  execute 'reset role';
  nm := 'IF Chair '||tag;
  insert into _if values('14 indexes exist on a clean DB', case when to_regclass('public.inventory_items_org_name_uidx') is not null
    and to_regclass('public.vendors_org_name_uidx') is not null and to_regclass('public.dish_catalog_org_cat_name_uidx') is not null then 'PASS' else 'FAIL' end);
  insert into public.inventory_items(name, total_qty, org_id) values (nm, 1, orgA);
  begin insert into public.inventory_items(name, total_qty, org_id) values ('  '||upper(nm)||' ', 1, orgA); insert into _if values('15 active item dup (case/space) refused','FAIL: allowed');
  exception when others then insert into _if values('15 active item dup (case/space) refused', case when sqlstate='23505' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin insert into public.inventory_items(name, total_qty, org_id, active) values (nm, 1, orgA, false); insert into _if values('16 inactive item dup allowed','PASS');
  exception when others then insert into _if values('16 inactive item dup allowed','FAIL: '||sqlerrm); end;
  if exists (select 1 from public.organizations where id = orgB) then
    begin insert into public.inventory_items(name, total_qty, org_id) values (nm, 1, orgB); insert into _if values('17 same name in another studio allowed','PASS');
    exception when others then insert into _if values('17 same name in another studio allowed','FAIL: '||sqlerrm); end;
  else insert into _if values('17 same name in another studio allowed','PASS (no org B)'); end if;
  begin update public.inventory_items set active = true where org_id = orgA and name = nm and not active; insert into _if values('18 reactivating a dup refused','FAIL: allowed');
  exception when others then insert into _if values('18 reactivating a dup refused', case when sqlstate='23505' then 'PASS' else 'FAIL: '||sqlstate end); end;
  insert into public.vendors(name, org_id) values ('IF Vendor '||tag, orgA);
  begin insert into public.vendors(name, org_id) values ('if vendor '||tag, orgA); insert into _if values('19 active vendor dup refused','FAIL: allowed');
  exception when others then insert into _if values('19 active vendor dup refused', case when sqlstate='23505' then 'PASS' else 'FAIL: '||sqlstate end); end;
  insert into public.dish_catalog(category, name, org_id) values ('Starters', 'IF Tikka '||tag, orgA);
  begin insert into public.dish_catalog(category, name, org_id) values ('starters', 'if tikka '||tag, orgA); insert into _if values('20 active dish dup (same category) refused','FAIL: allowed');
  exception when others then insert into _if values('20 active dish dup (same category) refused', case when sqlstate='23505' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin insert into public.vendors(name, org_id, active) values ('IF VENDOR '||tag, orgA, false); insert into _if values('21 inactive vendor dup allowed','PASS');
  exception when others then insert into _if values('21 inactive vendor dup allowed','FAIL: '||sqlerrm); end;
exception when others then insert into _if values('3x unique setup','FAIL: '||sqlerrm); end $$;

-- ---- 4) pre-existing duplicates: 0073 skips the index (NOTICE), never touches data ----------
reset role;
drop index if exists public.vendors_org_name_uidx;
insert into public.vendors(name, org_id) select 'IF Dirty '||tag, 'a0000000-0000-4000-8000-000000000001' from _ift;
insert into public.vendors(name, org_id) select 'if dirty '||tag, 'a0000000-0000-4000-8000-000000000001' from _ift;
\i supabase/migrations/0073_inventory_cancel_and_unique_names.sql
insert into _if select '22 index skipped while duplicates exist', case when to_regclass('public.vendors_org_name_uidx') is null then 'PASS' else 'FAIL: created' end;
insert into _if select '23 duplicate rows untouched by the skip', case when (select count(*) from public.vendors v, _ift t where lower(v.name) = 'if dirty '||t.tag and v.active) = 2 then 'PASS' else 'FAIL' end;
-- the owner deactivates the extra in the app, re-runs 0073: index comes back
update public.vendors set active = false where id = (select v.id from public.vendors v, _ift t where v.name = 'if dirty '||t.tag);
\i supabase/migrations/0073_inventory_cancel_and_unique_names.sql
insert into _if select '24 index created on re-run once clean', case when to_regclass('public.vendors_org_name_uidx') is not null then 'PASS' else 'FAIL' end;

select name, result from _if order by name;
select case when count(*) filter (where result not like 'PASS%') = 0
  then 'INV-FIXES: ALL PASS ('||count(*)||'/'||count(*)||')'
  else 'INV-FIXES: '||count(*) filter (where result not like 'PASS%')||' FAILED' end from _if;
