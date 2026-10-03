-- checkout-overissue.sql — proves checkout_equipment (0015) refuses to issue more stock
-- than is physically on hand, and frees stock back up as items are returned.
-- Behavioral: acts as org A's admin (admin bypasses has_area), seeds an item, exercises
-- the guard. Requires the canonical migrations + the two-tenant fixture.
set client_min_messages = warning;
\set ON_ERROR_STOP 0
drop table if exists _co; create temp table _co(name text, result text);

do $$
declare a_admin uuid; item uuid; co1 uuid;
begin
  select id into a_admin from auth.users where email='a_admin@a.test';
  perform auth.login_as(a_admin);     -- sets request.jwt.claims (org + admin role)
  execute 'reset role';               -- run the harness as owner (so the temp result table is writable); checkout_equipment is SECURITY DEFINER and reads the JWT claims, which persist
  insert into public.inventory_items(name, total_qty, org_id)
    values ('HARDEN_TEST_walkie', 5, public.current_org_id()) returning id into item;

  -- 1) checking out the full on-hand qty succeeds
  begin
    perform public.checkout_equipment(item, null, 5, 'Crew A', null, null);
    insert into _co values('1. check out up to total (5 of 5) succeeds','PASS');
  exception when others then insert into _co values('1. check out up to total (5 of 5) succeeds','FAIL: '||left(sqlerrm,60)); end;

  -- 2) one more over the total is REJECTED with 23514
  begin
    perform public.checkout_equipment(item, null, 1, 'Crew B', null, null);
    insert into _co values('2. over-issue (6th of 5) rejected','FAIL: over-issue allowed');
  exception when others then
    if sqlstate='23514' then insert into _co values('2. over-issue (6th of 5) rejected','PASS');
    else insert into _co values('2. over-issue (6th of 5) rejected','FAIL: wrong error '||sqlstate); end if;
  end;

  -- 3) after returning 3, three are free again and issuable
  select id into co1 from public.inventory_checkouts where item_id=item and status<>'returned' order by checked_out_at limit 1;
  perform public.checkin_equipment(co1, 3, 'Crew A', false);   -- 3 back, 2 still out
  begin
    perform public.checkout_equipment(item, null, 3, 'Crew C', null, null);   -- free = 5-2 = 3
    insert into _co values('3. freed stock (3) issuable after partial return','PASS');
  exception when others then insert into _co values('3. freed stock (3) issuable after partial return','FAIL: '||left(sqlerrm,50)); end;

  -- 4) ...but a 4th now (0 free) is rejected
  begin
    perform public.checkout_equipment(item, null, 1, 'Crew D', null, null);
    insert into _co values('4. over-issue after re-issue rejected','FAIL: over-issue allowed');
  exception when others then
    if sqlstate='23514' then insert into _co values('4. over-issue after re-issue rejected','PASS');
    else insert into _co values('4. over-issue after re-issue rejected','FAIL: wrong error '||sqlstate); end if;
  end;

  perform auth.logout();
exception when others then insert into _co values('setup','FAIL: '||left(sqlerrm,90)); end $$;

select name, result from _co order by name;
select case when count(*) filter (where result like 'FAIL%')=0
  then 'CHECKOUT-OVERISSUE: ALL PASS ('||count(*)||' checks)'
  else 'CHECKOUT-OVERISSUE: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _co;
