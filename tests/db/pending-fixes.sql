-- pending-fixes.sql - behavioral proof for migrations 0071 (reserve_inventory) and 0072
-- (pending fixes: designer/quality invites, member re-invite refusal, chat 4000 cap, deleted
-- chat lock, checkout row lock, idempotent write-off + qty_in cap, adjust_inventory_total gate,
-- create_quote F10 gate kept + studio-timezone quote codes). Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _pf; create temp table _pf(name text, result text);
grant all on _pf to anon, authenticated;
-- per-run tag so a re-run on the same database never collides with rows from an earlier run
drop table if exists _pft; create temp table _pft as select substr(md5(random()::text), 1, 10) as tag, null::uuid as item;
grant all on _pft to anon, authenticated;

-- ---- 2/3) invitations -----------------------------------------------------------------
do $$ declare a_admin uuid; n int; v_role text; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  perform auth.login_as(a_admin);
  begin perform public.create_invitation('pf_designer@a.test','designer'); insert into _pf values('01 designer invite works','PASS');
  exception when others then insert into _pf values('01 designer invite works','FAIL: '||sqlerrm); end;
  begin perform public.create_invitation('pf_quality@a.test','quality'); insert into _pf values('02 quality invite works','PASS');
  exception when others then insert into _pf values('02 quality invite works','FAIL: '||sqlerrm); end;
  begin perform public.create_invitation('a_staff@a.test','crew'); insert into _pf values('03 inviting existing member refused (22023)','FAIL: allowed');
  exception when others then insert into _pf values('03 inviting existing member refused (22023)', case when sqlstate='22023' then 'PASS' else 'FAIL: '||sqlstate||' '||sqlerrm end); end;
  begin perform public.create_invitation('A_Admin@a.test ','sales'); insert into _pf values('04 last admin cannot self-demote via invite','FAIL: allowed');
  exception when others then insert into _pf values('04 last admin cannot self-demote via invite', case when sqlstate='22023' then 'PASS' else 'FAIL: '||sqlstate end); end;
  execute 'reset role';
  select count(*) into n from public.invitations where lower(email) in ('a_staff@a.test','a_admin@a.test');
  select role into v_role from public.profiles where id=a_admin;
  insert into _pf values('05 no invite row for members + admin still admin', case when n=0 and v_role='admin' then 'PASS' else 'FAIL: n='||n||' role='||v_role end);
  perform auth.logout();
exception when others then insert into _pf values('0x invitations setup','FAIL: '||sqlerrm); end $$;

-- ---- 4/5) chat ------------------------------------------------------------------------
do $$ declare a_staff uuid; a_admin uuid; v uuid; r public.chat_messages; mid uuid; begin
  execute 'reset role';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into a_admin from auth.users where email='a_admin@a.test';
  perform auth.login_as(a_staff);
  v := public.chat_start_dm(a_admin);
  begin r := public.chat_send(v,'text',repeat('x',4001),null,null,null,null); insert into _pf values('06 chat 4001 chars refused','FAIL: allowed');
  exception when others then insert into _pf values('06 chat 4001 chars refused', case when sqlstate='23514' then 'PASS' else 'FAIL: '||sqlstate||' '||sqlerrm end); end;
  begin r := public.chat_send(v,'text',repeat('y',4000),null,null,null,null); mid := r.id; insert into _pf values('07 chat 4000 chars ok','PASS');
  exception when others then insert into _pf values('07 chat 4000 chars ok','FAIL: '||sqlerrm); end;
  begin update public.chat_messages set body = repeat('z',4001) where id = mid; insert into _pf values('08 edit to 4001 chars refused','FAIL: allowed');
  exception when others then insert into _pf values('08 edit to 4001 chars refused', case when sqlstate='23514' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin update public.chat_messages set deleted = true, body = null, media_path = null, meta = null where id = mid;
    insert into _pf values('09 author can delete own message', case when found then 'PASS' else 'FAIL: no row' end);
  exception when others then insert into _pf values('09 author can delete own message','FAIL: '||sqlerrm); end;
  begin update public.chat_messages set deleted = false where id = mid; insert into _pf values('10 deleted message cannot be undeleted','FAIL: allowed');
  exception when others then insert into _pf values('10 deleted message cannot be undeleted', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin update public.chat_messages set body = 'back' where id = mid; insert into _pf values('11 deleted message cannot be edited','FAIL: allowed');
  exception when others then insert into _pf values('11 deleted message cannot be edited', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout();
exception when others then insert into _pf values('1x chat setup','FAIL: '||sqlerrm); end $$;

-- ---- 6/7/8) inventory -------------------------------------------------------------------
do $$ declare a_admin uuid; a_staff uuid; item uuid; co uuid; v_tot numeric; v_wo numeric; c public.inventory_checkouts;
  crew uuid := gen_random_uuid(); tok uuid := gen_random_uuid(); qA uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  perform auth.login_as(a_admin); execute 'reset role';
  insert into public.inventory_items(name, total_qty, org_id) values ('PF_chairs_'||(select tag from _pft), 10, public.current_org_id()) returning id into item;
  execute 'update _pft set item = $1' using item;

  -- 6) checkout locks the item row (xmax = this transaction) and over-issue is refused
  c := public.checkout_equipment(item, null, 4, 'Crew A', null, null); co := c.id;
  begin perform public.checkout_equipment(item, null, 7, 'Crew B', null, null); insert into _pf values('13 over-issue refused','FAIL: allowed');
  exception when others then insert into _pf values('13 over-issue refused', case when sqlstate='23514' then 'PASS' else 'FAIL: '||sqlstate end); end;

  -- 7) qty_in > qty_out refused (staff path)
  begin perform public.checkin_equipment(co, 5, 'Crew A', false); insert into _pf values('14 staff qty_in > qty_out refused','FAIL: allowed');
  exception when others then insert into _pf values('14 staff qty_in > qty_out refused', case when sqlerrm like '%cannot exceed%' then 'PASS' else 'FAIL: '||sqlerrm end); end;

  -- 7) double write-off only subtracts once
  perform public.checkin_equipment(co, 1, 'Crew A', true);   -- 3 missing -> 10 - 3 = 7
  perform public.checkin_equipment(co, 1, 'Crew A', true);   -- retry: nothing more
  select total_qty into v_tot from public.inventory_items where id = item;
  select written_off into v_wo from public.inventory_checkouts where id = co;
  insert into _pf values('15 double write-off subtracts once', case when v_tot = 7 and v_wo = 3 then 'PASS' else 'FAIL: total='||v_tot||' wo='||v_wo end);
  begin update public.inventory_checkouts set written_off = -1 where id = co; insert into _pf values('16 written_off >= 0 enforced','FAIL: allowed');
  exception when others then insert into _pf values('16 written_off >= 0 enforced', case when sqlstate='23514' then 'PASS' else 'FAIL: '||sqlstate end); end;

  -- 7) worker (crew link, anon) path: qty_in > qty_out refused, exact return ok
  insert into public.crew_members(id, name, phone, org_id, active) values (crew, 'PF Crew', '99'||(select substr(regexp_replace(md5(tag),'[^0-9]','','g')||'00000000',1,8) from _pft), public.current_org_id(), true);
  insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at) values (tok, qA, '99'||(select substr(regexp_replace(md5(tag),'[^0-9]','','g')||'00000000',1,8) from _pft), 'PF Crew', public.current_org_id(), now() + interval '1 day');
  c := public.checkout_equipment(item, qA, 2, 'PF Crew', crew, null); co := c.id;
  perform auth.login_anon();
  begin perform public.worker_checkin_equipment(tok, co, 3); insert into _pf values('17 worker qty_in > qty_out refused','FAIL: allowed');
  exception when others then insert into _pf values('17 worker qty_in > qty_out refused', case when sqlerrm like '%cannot exceed%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  begin perform public.worker_checkin_equipment(tok, co, 2); insert into _pf values('18 worker full return ok','PASS');
  exception when others then insert into _pf values('18 worker full return ok','FAIL: '||sqlerrm); end;
  execute 'reset role';

  -- 8) adjust_inventory_total: refused without inventory edit (sales), ok for admin
  execute 'reset role'; perform auth.login_as(a_staff);
  begin perform public.adjust_inventory_total(item, 5); insert into _pf values('19 adjust_inventory_total refused w/o inventory edit','FAIL: allowed');
  exception when others then insert into _pf values('19 adjust_inventory_total refused w/o inventory edit', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  execute 'reset role'; perform auth.login_as(a_admin);
  begin perform public.adjust_inventory_total(item, 1); insert into _pf values('20 adjust_inventory_total ok for inventory editor','PASS');
  exception when others then insert into _pf values('20 adjust_inventory_total ok for inventory editor','FAIL: '||sqlerrm); end;

  -- 0071) reserve_inventory sets created_by; anon cannot execute
  declare r public.inventory_reservations; begin
    r := public.reserve_inventory(item, qA, 1, 'pf');
    insert into _pf values('21 reserve_inventory sets created_by', case when r.created_by = a_admin then 'PASS' else 'FAIL: '||coalesce(r.created_by::text,'null') end);
  exception when others then insert into _pf values('21 reserve_inventory sets created_by','FAIL: '||sqlerrm); end;
  execute 'reset role';
  insert into _pf values('22 reserve_inventory not executable by anon',
    case when not has_function_privilege('anon','public.reserve_inventory(uuid,uuid,numeric,text)','execute')
          and has_function_privilege('authenticated','public.reserve_inventory(uuid,uuid,numeric,text)','execute') then 'PASS' else 'FAIL' end);
  perform auth.login_anon();
  begin perform public.reserve_inventory(item, qA, 1, null); insert into _pf values('23 anon call to reserve_inventory refused','FAIL: allowed');
  exception when others then insert into _pf values('23 anon call to reserve_inventory refused', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout();
exception when others then insert into _pf values('2x inventory setup','FAIL: '||sqlerrm); end $$;

-- ---- 6) checkout_equipment takes the item row lock (top-level transaction, no subtransaction,
-- so the row's xmax is this transaction's id while its FOR UPDATE lock is held; rolled back) ---
begin;
select auth.login_as((select id from auth.users where email='a_admin@a.test')) \gset
select public.checkout_equipment((select item from _pft), null, 1, 'Lock probe', null, null) is not null as issued \gset
reset role;
select coalesce((select (i.xmax = pg_current_xact_id()::xid)::text from public.inventory_items i
  where i.id = (select item from _pft)), 'false') as pf_locked \gset
rollback;
insert into _pf values('12 checkout_equipment takes the item row lock', case when :'pf_locked' = 'true' then 'PASS' else 'FAIL: not locked' end);

-- ---- 10) quote codes ------------------------------------------------------------------------
do $$ declare a_staff uuid; a_admin uuid; q public.quotes; lid uuid := gen_random_uuid();
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; tz text; begin
  execute 'reset role';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into a_admin from auth.users where email='a_admin@a.test';
  -- F10 kept: sales without quotes edit is refused by the has_area gate (not by can_create)
  update public.role_access set can_edit = false where org_id = orgA and role = 'sales' and area = 'quotes';
  perform auth.login_as(a_staff);
  begin q := public.create_quote(null,'PF denied',null,null,0,null); insert into _pf values('24 create_quote refused w/o quotes edit (F10)','FAIL: allowed');
  exception when others then insert into _pf values('24 create_quote refused w/o quotes edit (F10)', case when sqlstate='42501' and sqlerrm='not authorized' then 'PASS' else 'FAIL: '||sqlstate||' '||sqlerrm end); end;
  execute 'reset role';
  update public.role_access set can_edit = true where org_id = orgA and role = 'sales' and area = 'quotes';

  -- studio timezone stamp: UTC+14 and UTC-12 are always on different calendar days
  foreach tz in array array['Pacific/Kiritimati','Etc/GMT+12'] loop
    execute 'reset role';
    update public.organizations set timezone = tz where id = orgA;
    perform auth.login_as(a_admin);
    q := public.create_quote(null,'PF tz '||tz,null,null,0,null);
    insert into _pf values('25 create_quote code uses studio tz '||tz,
      case when q.code like to_char((now() at time zone tz)::date,'MMDDYYYY')||'-%' then 'PASS' else 'FAIL: '||q.code end);
  end loop;
  execute 'reset role';
  update public.organizations set timezone = 'Not/AZone' where id = orgA;
  perform auth.login_as(a_admin);
  q := public.create_quote(null,'PF bad tz',null,null,0,null);
  insert into _pf values('26 invalid tz falls back to Asia/Kolkata',
    case when q.code like to_char((now() at time zone 'Asia/Kolkata')::date,'MMDDYYYY')||'-%' then 'PASS' else 'FAIL: '||q.code end);
  q := public.create_quote(null,'PF dated',null,null,0,date '2031-02-03');
  insert into _pf values('27 event date still wins', case when q.code like '02032031-%' then 'PASS' else 'FAIL: '||q.code end);
  execute 'reset role';
  update public.organizations set timezone = 'Pacific/Kiritimati' where id = orgA;
  insert into public.leads(id, name, phone, status, event_type, org_id) values (lid, 'PF Lead', '9000000001', 'new', 'Wedding', orgA);
  perform auth.login_as(a_admin);
  q := public.convert_lead_to_quote(lid);
  insert into _pf values('28 convert_lead_to_quote uses studio tz',
    case when q.code like to_char((now() at time zone 'Pacific/Kiritimati')::date,'MMDDYYYY')||'-%' then 'PASS' else 'FAIL: '||q.code end);
  insert into _pf values('29 convert_lead_to_quote title keeps em dash', case when q.title = 'PF Lead '||chr(8212)||' Wedding' then 'PASS' else 'FAIL: '||q.title end);
  execute 'reset role';
  update public.organizations set timezone = 'Asia/Kolkata' where id = orgA;
  perform auth.logout();
exception when others then
  execute 'reset role';
  update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
  insert into _pf values('3x quote setup','FAIL: '||sqlerrm); end $$;

select name, result from _pf order by name;
select case when count(*) filter (where result not like 'PASS%') = 0
  then 'PENDING-FIXES: ALL PASS ('||count(*)||'/'||count(*)||')'
  else 'PENDING-FIXES: '||count(*) filter (where result not like 'PASS%')||' FAILED' end from _pf;
