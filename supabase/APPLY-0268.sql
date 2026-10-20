-- APPLY-0268.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0254 (closure checklist) - any database that already has 0105 + 0197 + 0198 + 0254.
-- r24 owner: "stock confuses me on Inventory, Teardown, Event-day command and Closure". After this script every page
-- tells ONE story per item on an event: Reserved (held) -> Out (given to a person, who + when) -> Back / Missing / Damaged.
--   * Mark back asks "how many came back OK" and "how many damaged"; the rest is Missing. Missing + damaged come off
--     what you own exactly once.
--   * Event-day command: "Give out" on a stock request now really takes the stock out of Inventory (a check-out with
--     the person's name and the time), so the counts stay in sync. Typed items that are not in stock are only marked given.
--   * A reservation follows its stock: released automatically when everything given out is back, or after the event
--     day when it was never taken out ("Reserved - never taken out, nothing to return").
--   * Closure checklist: only stock that went Out and did not come Back stops closing.
-- 2 new columns (inventory_checkouts.qty_damaged default 0, event_stock_requests.checkout_id), 3 new RPCs
-- (checkin_stock, issue_stock_request, release_unused_stock), 1 trigger, 3 functions replaced in place
-- (_checkout_free, checkout_availability, _r22_close_checks). Nothing deleted, no row changed by this script.
-- Safe to run twice. ASCII only. No edge-function deploy needed.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true (two result grids: the
--      migration's own check inside the transaction, then the same check after commit).
--   2  Deploy the site (inventory.html, teardown.html, command.html, closure.html, closure-checklist.js, event.html,
--      store-api.js, checkout-shortage.js, stock-flow.js / .css, stock-picker.js).
--   3  Check on one past event: Teardown shows each item as Reserved / Out / Back; Event-day command -> Give out
--      shows the item as Out on Inventory -> Out & back.
begin;
-- 0268_stock_one_flow.sql - CANONICAL forward-only.
-- REQUIRES 0072 + 0073 (inventory_checkouts.written_off, cancel_checkout), 0105 (_checkout_free, checkout_availability),
--          0197 (event_stock_requests.source), 0198 (_a198_org_today), 0254 (_r22_close_checks, event_closure_review),
--          phase23 (event_stock_requests), phase33 (inventory_checkouts), phase29 / phase57 (has_area, current_org_id).
--
-- In plain words (r24 owner: "I am confused by stock on Inventory, Teardown, Event-day command and Closure"):
--   ONE story for every item on an event, the same words on every page:
--     Reserved  - held for the event (inventory_reservations, unchanged)
--     Out       - given to a person, with who + when (an inventory_checkouts row, status 'out')
--     Back      - checked in OK              Missing - did not come back      Damaged - came back broken
--   1  Mark back with "came back OK" + "damaged": NEW checkin_stock(checkout, ok, damaged, by). Missing = the rest.
--      Missing AND damaged are taken off what you own (written_off), exactly once. NEW column
--      inventory_checkouts.qty_damaged (default 0; old rows = 0).
--   2  Event-day command "Live stock requests": marking a stock item Issued now really gives it out -
--      NEW issue_stock_request(request, given_to, staff_id, note, partial) creates the check-out against inventory
--      (same free-stock rule + row lock as checkout_equipment_smart, never negative) and links it
--      (NEW column event_stock_requests.checkout_id). A typed item that is not in stock is only marked given.
--      A shortage row (0197, "rent / buy") is not given from stock.
--   3  A reservation follows its stock: when everything given out for that item on the event is back (any check-in
--      path - Inventory, Teardown, crew link), the reservation is released (status 'returned', note says why) once
--      the event day has come. NEW release_unused_stock(event, include_today) releases reservations that were
--      never taken out after the event day ("Reserved - never taken out, nothing to return").
--   4  Closure checklist: only stock that went Out and did not come Back blocks closing; reserved-never-out does
--      not. The per-item table gets back / damaged / reserved_unused / state. (_r22_close_checks replaced in place,
--      marker 'r24-stock-0268'; every other check is unchanged.)
--   5  Free-stock maths (_checkout_free, checkout_availability): a short check-in whose missing units were already
--      written off no longer counts those units as still out (they were counted twice: off the total AND as out).
-- ZERO DATA LOSS: 2 new nullable/defaulted columns, new functions, 1 new trigger, 3 functions replaced in place.
-- No table, column, row or policy is dropped or deleted; the script itself updates no existing row.
-- Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run 0105 section 1 (_checkout_free + checkout_availability) and the
--   0254 _r22_close_checks body; drop trigger zz_r24_release_on_back on public.inventory_checkouts;
--   revoke execute on checkin_stock / issue_stock_request / release_unused_stock from authenticated.
--   (the two new columns can stay - nothing else reads them)

do $$ begin
  if to_regclass('public.inventory_checkouts') is null or to_regclass('public.inventory_reservations') is null
     or to_regclass('public.event_stock_requests') is null or to_regclass('public.inventory_items') is null then
    raise exception 'STOP 0268: inventory tables missing (phase7 / phase23 / phase33)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'written_off') then
    raise exception 'STOP 0268: apply 0072 (inventory_checkouts.written_off) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_stock_requests' and column_name = 'source') then
    raise exception 'STOP 0268: apply 0197 (event_stock_requests.source) first'; end if;
  if to_regprocedure('public._checkout_free(uuid,date,uuid)') is null or to_regprocedure('public.checkout_availability(uuid,uuid)') is null then
    raise exception 'STOP 0268: apply 0105 (check-out availability) first'; end if;
  if to_regprocedure('public._r22_close_checks(uuid,uuid)') is null or to_regprocedure('public._r22_check(text,text,text,text,text,text,numeric,numeric)') is null then
    raise exception 'STOP 0268: apply 0254 (closure checklist) first'; end if;
  if to_regprocedure('public._a198_org_today(uuid)') is null then
    raise exception 'STOP 0268: apply 0198 (event stages) first'; end if;
end $$;

-- ---- 1) columns (additive) ----------------------------------------------------------------------------------------
alter table public.inventory_checkouts add column if not exists qty_damaged numeric not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.inventory_checkouts'::regclass and conname = 'inventory_checkouts_damaged_0268') then
    alter table public.inventory_checkouts add constraint inventory_checkouts_damaged_0268 check (qty_damaged >= 0) not valid;
  end if;
end $$;
alter table public.event_stock_requests add column if not exists checkout_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_stock_requests'::regclass and conname = 'event_stock_requests_checkout_fk_0268') then
    alter table public.event_stock_requests add constraint event_stock_requests_checkout_fk_0268
      foreign key (checkout_id) references public.inventory_checkouts(id) on delete set null;
  end if;
end $$;
create index if not exists event_stock_requests_checkout_idx on public.event_stock_requests (checkout_id) where checkout_id is not null;

-- ---- 2) "not back yet" for free-stock maths ----------------------------------------------------------------------
-- units of an out / partial check-out that are still off the shelf AND still in total_qty:
--   given out - came back - (written off that was missing, i.e. written_off - damaged)
create or replace function public._r24_not_back(p_out numeric, p_in numeric, p_written_off numeric, p_damaged numeric)
returns numeric language sql immutable set search_path = '' as $$
  -- r24-stock-0268
  select greatest(coalesce(p_out, 0) - coalesce(p_in, 0) - greatest(coalesce(p_written_off, 0) - coalesce(p_damaged, 0), 0), 0);
$$;

-- ---- 3) free-stock maths (0105 bodies; only the 'still out' expression changes) ------------------------------
create or replace function public._checkout_free(p_item uuid, p_date date, p_quote uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_org uuid := public.current_org_id(); v_total numeric; v_out numeric; v_res numeric;
begin
  select coalesce(total_qty, 0) into v_total from public.inventory_items where id = p_item and org_id = v_org;
  if not found then return 0; end if;
  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c
   where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_res := 0;
  if p_date is not null then
    -- other live events on the same date: reserved minus what they already took out (counted above)
    select coalesce(sum(greatest(r.res - coalesce(o.out_qty, 0), 0)), 0) into v_res
      from (select r0.quote_id, sum(r0.qty) as res from public.inventory_reservations r0
             where r0.item_id = p_item and r0.status in ('reserved', 'allocated') group by r0.quote_id) r
      join public.quotes q on q.id = r.quote_id
      left join (select c0.quote_id, sum(public._r24_not_back(c0.qty_out, c0.qty_in, c0.written_off, c0.qty_damaged)) as out_qty
                   from public.inventory_checkouts c0
                  where c0.item_id = p_item and c0.org_id = v_org and c0.status in ('out', 'partial') group by c0.quote_id) o
        on o.quote_id = r.quote_id
     where q.org_id = v_org and q.event_date = p_date and q.id is distinct from p_quote
       and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
       and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed');
  end if;
  return greatest(v_total - v_out - v_res, 0);
end $$;
revoke all on function public._checkout_free(uuid, date, uuid) from public, anon, authenticated;

create or replace function public.checkout_availability(p_item uuid, p_quote uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id(); v_it record; v_date date; v_out numeric; v_free numeric;
  v_blocking jsonb; v_overdue jsonb; v_subs jsonb; v_resother jsonb;
begin
  if not (public.has_area('inventory', 'view') or public.has_area('inventory', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select id, name, category, unit, coalesce(total_qty, 0) as total into v_it
    from public.inventory_items where id = p_item and org_id = v_org;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  if p_quote is not null then
    perform public.assert_quote_org(p_quote);
    select event_date into v_date from public.quotes where id = p_quote;
  end if;

  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_free := public._checkout_free(p_item, v_date, p_quote);

  -- open check-outs holding this item: which event, how many, when due back (day after the event)
  select coalesce(jsonb_agg(x order by x->>'due_back' nulls last), '[]'::jsonb) into v_blocking from (
    select jsonb_build_object('checkout_id', c.id, 'quote_id', c.quote_id,
             'event', coalesce(q.title, 'No event'), 'event_date', q.event_date,
             'due_back', case when q.event_date is not null then q.event_date + 1 end,
             'qty', public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged), 'issued_to', c.issued_to,
             'overdue', (q.event_date is not null and q.event_date + 1 < current_date)) as x
      from public.inventory_checkouts c left join public.quotes q on q.id = c.quote_id
     where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial')
       and public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged) > 0) s;
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_overdue
    from jsonb_array_elements(v_blocking) e where (e->>'overdue')::boolean;

  -- other events on the same date holding a reservation
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', q.id, 'event', q.title, 'event_date', q.event_date, 'qty', r.qty)), '[]'::jsonb)
    into v_resother
    from (select quote_id, sum(qty) as qty from public.inventory_reservations
           where item_id = p_item and status in ('reserved', 'allocated') group by quote_id) r
    join public.quotes q on q.id = r.quote_id
   where v_date is not null and q.org_id = v_org and q.event_date = v_date and q.id is distinct from p_quote
     and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled';

  -- substitutes: same category, active, something free on that date
  select coalesce(jsonb_agg(s order by (s->>'available')::numeric desc), '[]'::jsonb) into v_subs from (
    select jsonb_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit,
             'available', public._checkout_free(i.id, v_date, p_quote)) as s
      from public.inventory_items i
     where i.org_id = v_org and i.id <> p_item and coalesce(i.active, true)
       and v_it.category is not null and i.category = v_it.category
     limit 20) t
   where (s->>'available')::numeric > 0;

  return jsonb_build_object('item_id', v_it.id, 'item', v_it.name, 'category', v_it.category, 'unit', v_it.unit,
    'total', v_it.total, 'out_now', v_out, 'reserved_other', greatest(v_it.total - v_out - v_free, 0),
    'in_repair', 0, 'available', v_free, 'event_date', v_date,
    'blocking', v_blocking, 'overdue', v_overdue, 'reserved_by', v_resother,
    'substitutes', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_subs) e limit 5) z));
end $$;
revoke all on function public.checkout_availability(uuid, uuid) from public, anon;
grant execute on function public.checkout_availability(uuid, uuid) to authenticated;


-- ---- 4) release reservations that are done ------------------------------------------------------------------------
-- Internal. For one event (optionally one item): a live reservation (reserved / allocated) is released (status
-- 'returned', the note says why) when nothing of that item is Out on the event any more AND
--   (a) something was given out for it and all of it is back / written off, once the event day has come, or
--   (b) it was only Reserved (never taken out) and the event day is over (or today with p_include_today),
--       or the event is cancelled / closed.
-- 'allocated' with no check-out at all (given out before names were recorded) is never released here.
create or replace function public._r24_release(p_quote uuid, p_org uuid, p_item uuid default null, p_include_today boolean default false)
returns integer language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268
declare v_q record; v_today date; v_day_come boolean; v_day_over boolean; v_n integer := 0;
begin
  select q.id, q.event_date, q.status, q.lifecycle_stage into v_q from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if not found then return 0; end if;
  v_today := public._a198_org_today(p_org);
  v_day_come := v_q.status = 'cancelled' or v_q.lifecycle_stage = 'closed' or (v_q.event_date is not null and v_q.event_date <= v_today);
  v_day_over := v_q.status = 'cancelled' or v_q.lifecycle_stage = 'closed'
                or (v_q.event_date is not null and (v_q.event_date < v_today or (p_include_today and v_q.event_date <= v_today)));
  if not v_day_come then return 0; end if;
  with x as (
    select r.id,
           exists (select 1 from public.inventory_checkouts c where c.quote_id = r.quote_id and c.item_id = r.item_id
                     and c.org_id = p_org and c.status <> 'cancelled') as went_out
      from public.inventory_reservations r
     where r.quote_id = p_quote and r.org_id = p_org and (p_item is null or r.item_id = p_item)
       and r.status in ('reserved', 'allocated')
       and not exists (select 1 from public.inventory_checkouts c where c.quote_id = r.quote_id and c.item_id = r.item_id
                         and c.org_id = p_org and c.status = 'out')
     for update of r)
  update public.inventory_reservations r
     set status = 'returned',
         note = left(concat_ws(' | ', nullif(btrim(coalesce(r.note, '')), ''),
                  case when x.went_out then 'Back - released automatically' else 'Released - never taken out' end), 2000)
    from x
   where r.id = x.id and (x.went_out or (r.status = 'reserved' and v_day_over));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- every check-in path (Inventory, Teardown, the crew link, checkin_stock) releases the reservation it finishes
create or replace function public.tg_r24_release_on_back()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268
begin
  if new.quote_id is not null and old.status = 'out' and new.status in ('returned', 'partial') then
    perform public._r24_release(new.quote_id, new.org_id, new.item_id, false);
  end if;
  return null;
end $$;
drop trigger if exists zz_r24_release_on_back on public.inventory_checkouts;
create trigger zz_r24_release_on_back after update of status on public.inventory_checkouts
  for each row execute function public.tg_r24_release_on_back();

-- ---- 5) Mark back: came back OK + damaged; the rest is missing ----------------------------------------------------
create or replace function public.checkin_stock(p_id uuid, p_ok numeric, p_damaged numeric default 0, p_returned_by text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268
declare v_org uuid := public.current_org_id(); v_row public.inventory_checkouts; v_ok numeric := coalesce(p_ok, 0);
        v_dmg numeric := coalesce(p_damaged, 0); v_miss numeric; v_off numeric;
begin
  select * into v_row from public.inventory_checkouts where id = p_id and org_id = v_org for update;
  if not found then raise exception 'check-out not found' using errcode = '42501'; end if;
  -- Inventory edit, or event-day Command edit for stock given out on an event
  if not (public.has_area('inventory', 'edit') or (v_row.quote_id is not null and public.has_area('command', 'edit'))) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_row.status = 'cancelled' then raise exception 'This was cancelled - nothing to mark back.' using errcode = 'P0001'; end if;
  if v_row.status <> 'out' then raise exception 'Already marked back.' using errcode = 'P0001'; end if;
  if v_ok < 0 or v_dmg < 0 or v_ok <> trunc(v_ok) or v_dmg <> trunc(v_dmg) then
    raise exception 'Use whole numbers, 0 or more.' using errcode = '22023'; end if;
  if v_ok + v_dmg > v_row.qty_out then
    raise exception 'Only % went out - came back OK + damaged can be at most %.', v_row.qty_out, v_row.qty_out using errcode = '22023'; end if;
  v_miss := v_row.qty_out - v_ok - v_dmg;
  v_off := v_miss + v_dmg;                                   -- missing and damaged both leave what you own
  update public.inventory_checkouts
     set qty_in = v_ok + v_dmg, qty_damaged = v_dmg,
         returned_by = nullif(btrim(coalesce(p_returned_by, '')), ''),
         confirmed_by = auth.uid(), checked_in_at = now(),
         written_off = coalesce(written_off, 0) + v_off,
         status = case when v_miss = 0 then 'returned' else 'partial' end
   where id = p_id and org_id = v_org
   returning * into v_row;
  if v_off > 0 then
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty, 0) - v_off)
     where id = v_row.item_id and org_id = v_org;
  end if;
  return jsonb_build_object('ok', true, 'checkout_id', v_row.id, 'status', v_row.status,
    'back', v_ok, 'damaged', v_dmg, 'missing', v_miss, 'written_off', v_off);
end $$;

-- ---- 6) Event-day command: "Issued" really gives the stock out ----------------------------------------------------
create or replace function public.issue_stock_request(p_request uuid, p_issued_to text, p_issued_to_id uuid default null,
                                                      p_note text default null, p_partial boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268
declare v_org uuid := public.current_org_id(); v_r public.event_stock_requests; v_date date; v_free numeric;
        v_take numeric; v_note text; v_id uuid; v_crew uuid;
begin
  if not public.has_area('command', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v_r from public.event_stock_requests where id = p_request and org_id = v_org for update;
  if not found then raise exception 'request not found' using errcode = '42501'; end if;
  if v_r.checkout_id is not null then                                    -- already given out: same answer again
    return jsonb_build_object('ok', true, 'already', true, 'checkout_id', v_r.checkout_id, 'from_stock', true);
  end if;
  if v_r.status = 'cancelled' then raise exception 'This request was cancelled.' using errcode = 'P0001'; end if;
  if v_r.source is not null then
    raise exception 'This is a shortage to rent or buy - mark it Sourced instead.' using errcode = 'P0001'; end if;
  if v_r.item_id is null then                                            -- typed item, not from stock: status only
    update public.event_stock_requests set status = 'issued' where id = v_r.id;
    return jsonb_build_object('ok', true, 'from_stock', false);
  end if;
  if coalesce(btrim(p_issued_to), '') = '' then raise exception 'Who is it given to?' using errcode = '22023'; end if;
  if coalesce(v_r.qty, 0) <= 0 then raise exception 'quantity must be > 0' using errcode = '22023'; end if;
  perform 1 from public.inventory_items where id = v_r.item_id and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  select q.event_date into v_date from public.quotes q where q.id = v_r.quote_id and q.org_id = v_org;
  if not found then raise exception 'event not found' using errcode = '42501'; end if;
  select cm.id into v_crew from public.crew_members cm where cm.id = p_issued_to_id and cm.org_id = v_org;
  v_free := public._checkout_free(v_r.item_id, v_date, v_r.quote_id);
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_r.qty <= v_free then v_take := v_r.qty;
  elsif coalesce(p_partial, false) and v_free > 0 then
    v_take := v_free;
    v_note := left(concat_ws(' | ', v_note, 'Short by ' || (v_r.qty - v_free)::text || ' (asked ' || v_r.qty::text || ', ' || v_free::text || ' free)'), 2000);
  else
    return jsonb_build_object('ok', false, 'code', 'shortage', 'requested', v_r.qty, 'available', v_free);
  end if;
  v_note := left(concat_ws(' | ', v_note, 'From event-day stock request'), 2000);
  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note, org_id)
    values (v_r.item_id, v_r.quote_id, v_take, left(btrim(p_issued_to), 200), v_crew, auth.uid(), v_note, v_org)
    returning id into v_id;
  update public.event_stock_requests set status = 'issued', checkout_id = v_id where id = v_r.id;
  return jsonb_build_object('ok', true, 'from_stock', true, 'checkout_id', v_id, 'qty_out', v_take,
    'requested', v_r.qty, 'partial', v_take < v_r.qty, 'shortfall', v_r.qty - v_take);
end $$;

-- ---- 7) release what was never taken out (Teardown / Closure / Inventory call it) ---------------------------------
create or replace function public.release_unused_stock(p_quote uuid, p_include_today boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r24-stock-0268
declare v_org uuid := public.current_org_id(); v_n integer;
begin
  if not (public.has_area('inventory', 'edit') or public.has_area('command', 'edit') or public.has_area('closure', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = '42501'; end if;
  v_n := public._r24_release(p_quote, v_org, null, coalesce(p_include_today, false));
  return jsonb_build_object('ok', true, 'released', v_n);
end $$;

-- ---- 8) closure checklist: only Out-and-not-Back blocks (0254 body; the equipment part changes) -------------------
create or replace function public._r22_close_checks(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254: read-only; no auth here - callers check
-- r24-stock-0268: stock = Reserved -> Out -> Back / Missing / Damaged; only Out-and-not-Back blocks
declare
  b jsonb; v_status text; v_inv jsonb; v_checks jsonb := '[]'::jsonb; v_owed numeric; v_nb text;
  n_out numeric; n_res numeric; n_miss numeric; n_wo numeric; n_items int; n_unused numeric; n_dmg numeric;
  n_claim int; a_claim numeric; n_claim_ok int; a_claim_ok numeric; n_ref int; a_ref numeric;
  n_book int; n_nobill int; v_nobill text; a_due numeric; n_due int;
  n_crew int; n_crew_open int; n_crew_here int;
  n_task int; n_task_done int; n_task_open int; n_iss int; n_iss_open int; n_iss_high int; n_vend int;
begin
  select q.status into v_status from public.quotes q where q.id = p_quote and q.org_id = p_org;
  if not found then return null; end if;
  b := public._a49_close_blockers(p_quote);
  v_owed := coalesce((b ->> 'balance_owed')::numeric, 0); v_nb := b ->> 'not_booked';

  -- r24-stock-0268: ONE story per item - Reserved (held) -> Out (given to a person) -> Back / Missing / Damaged.
  -- Only stock that went Out and did not come Back blocks closing. A reservation that was never taken out is NOT a
  -- blocker (it is released automatically). 'allocated' with no check-out = given out before names were recorded,
  -- so it still counts as Out until someone marks it back.
  with r as (select x.item_id, sum(x.qty) filter (where x.status <> 'cancelled') as res,
                    sum(x.qty) filter (where x.status in ('reserved', 'allocated')) as res_open,
                    sum(x.qty) filter (where x.status = 'allocated') as res_alloc
               from public.inventory_reservations x where x.quote_id = p_quote and x.org_id = p_org group by x.item_id),
       c as (select x.item_id, count(*) filter (where x.status <> 'cancelled') as n_co,
                    sum(x.qty_out) filter (where x.status <> 'cancelled') as co,
                    sum(coalesce(x.qty_in, 0)) filter (where x.status in ('returned', 'partial')) as ci,
                    sum(greatest(x.qty_out - coalesce(x.qty_in, 0), 0)) filter (where x.status = 'partial') as miss,
                    sum(coalesce(x.written_off, 0)) filter (where x.status <> 'cancelled') as wo,
                    sum(coalesce(x.qty_damaged, 0)) filter (where x.status in ('returned', 'partial')) as dmg,
                    sum(x.qty_out) filter (where x.status = 'out') as still_out
               from public.inventory_checkouts x where x.quote_id = p_quote and x.org_id = p_org group by x.item_id),
       k as (select item_id from r union select item_id from c),
       t0 as (select k.item_id, coalesce(nullif(btrim(it.name), ''), 'Item') as name, it.unit,
                    coalesce(r.res, 0) as res, coalesce(r.res_open, 0) as res_open, coalesce(r.res_alloc, 0) as res_alloc,
                    coalesce(c.n_co, 0) as n_co, coalesce(c.co, 0) as co, coalesce(c.ci, 0) as ci, coalesce(c.miss, 0) as miss,
                    coalesce(c.wo, 0) as wo, coalesce(c.dmg, 0) as dmg, coalesce(c.still_out, 0) as still_out
               from k left join r on r.item_id = k.item_id left join c on c.item_id = k.item_id
               left join public.inventory_items it on it.id = k.item_id),
       t as (select t0.*, case when t0.n_co = 0 then t0.res_alloc else 0 end as legacy_out,
                    case when t0.n_co = 0 then greatest(t0.res_open - t0.res_alloc, 0) else 0 end as unused
               from t0)
  select coalesce(jsonb_agg(jsonb_build_object('item_id', t.item_id, 'item', t.name, 'unit', t.unit,
            'reserved', t.res, 'reserved_open', t.legacy_out, 'reserved_unused', t.unused, 'checked_out', t.co, 'checked_in', t.ci,
            'back', greatest(t.ci - t.dmg, 0), 'missing', t.miss, 'damaged', t.dmg, 'written_off', t.wo, 'still_out', t.still_out,
            'status', case when t.still_out > 0 or t.legacy_out > 0 then 'fail' when t.miss > 0 or t.dmg > 0 or t.wo > 0 then 'warn' else 'ok' end,
            'state', case when t.still_out > 0 or t.legacy_out > 0 then 'out' when t.n_co > 0 and t.miss > 0 then 'missing'
                          when t.n_co > 0 and t.dmg > 0 then 'damaged' when t.n_co > 0 then 'back'
                          when t.unused > 0 then 'reserved' else 'released' end)
            order by t.name, t.item_id), '[]'::jsonb),
         count(*), coalesce(sum(t.still_out), 0), coalesce(sum(t.legacy_out), 0), coalesce(sum(t.miss), 0), coalesce(sum(t.wo), 0),
         coalesce(sum(t.unused), 0), coalesce(sum(t.dmg), 0)
    into v_inv, n_items, n_out, n_res, n_miss, n_wo, n_unused, n_dmg from t;

  -- 1 event day (0198: no override) / no date (admin)
  v_checks := v_checks || jsonb_build_array(case
    when coalesce(v_status, '') = 'cancelled' then public._r22_check('event_day', 'Event day is over', 'ok', null,
         'Cancelled event - it can be closed once it is settled.', 'event', null, null)
    when coalesce((b ->> 'too_early')::boolean, false) then public._r22_check('event_day', 'Event day is over', 'fail', 'none',
         'You can close this event after ' || coalesce(b ->> 'close_after', '') || ' (event day).', 'event', null, null)
    when coalesce((b ->> 'no_event_date')::boolean, false) then public._r22_check('event_day', 'Event day is over', 'fail', 'admin',
         'The event has no date yet - set it on the event page.', 'event', null, null)
    else public._r22_check('event_day', 'Event day is over', 'ok', null, 'The event day (' || coalesce(b ->> 'close_after', '') || ') is over.', 'event', null, null) end);
  -- 2 booking confirmed + priced (0152, admin)
  if v_nb is not null then
    v_checks := v_checks || jsonb_build_array(public._r22_check('booked', 'Booking confirmed and priced', 'fail', 'admin',
      case when v_nb = 'unpriced' then 'The quote has no price yet - price it first.'
           else 'This is still a quote - the client has not confirmed the booking.' end, 'quote', null, null));
  end if;
  -- 3 client balance on the ledger (0049, admin)
  v_checks := v_checks || jsonb_build_array(case when v_owed > 0
    then public._r22_check('balance', 'Client balance is 0', 'fail', 'admin', 'Balance still due from the client - collect it in Settlement.', 'settlement', null, v_owed)
    else public._r22_check('balance', 'Client balance is 0', 'ok', null, 'Nothing is due from the client.', 'settlement', null, 0) end);
  -- 4 stock back (Out and not Back = 0049 server gate, admin; given out with no name recorded = any approver).
  --   Reserved but never taken out is never a blocker (released automatically, 0268).
  v_checks := v_checks || jsonb_build_array(case
    when n_out > 0 then public._r22_check('inventory', 'All stock back', 'fail', 'admin',
         'Out and not back yet: ' || trim(to_char(n_out, 'FM999999990.##')) || case when n_res > 0 then ' (and ' || trim(to_char(n_res, 'FM999999990.##')) || ' given out with no name recorded)' else '' end || ' - mark them back in Teardown & returns.',
         'inventory', n_out + n_res, null)
    when n_res > 0 then public._r22_check('inventory', 'All stock back', 'fail', 'any',
         'Given out (no name recorded) and not marked back: ' || trim(to_char(n_res, 'FM999999990.##')) || ' - mark them back in Teardown & returns.', 'inventory', n_res, null)
    when n_miss > 0 or n_dmg > 0 or n_wo > 0 then public._r22_check('inventory', 'All stock back', 'warn', null,
         'Everything is back or written off: ' || trim(to_char(n_miss, 'FM999999990.##')) || ' missing, ' || trim(to_char(n_dmg, 'FM999999990.##')) || ' damaged (taken off your stock).', 'inventory', greatest(n_miss + n_dmg, n_wo), null)
    when n_items = 0 then public._r22_check('inventory', 'All stock back', 'ok', null, 'No stock was booked for this event.', 'inventory', 0, null)
    when n_unused > 0 then public._r22_check('inventory', 'All stock back', 'ok', null,
         'Everything that went out is back. ' || trim(to_char(n_unused, 'FM999999990.##')) || ' reserved but never taken out - nothing to return.', 'inventory', 0, null)
    else public._r22_check('inventory', 'All stock back', 'ok', null, 'Everything that went out is back.', 'inventory', 0, null) end);
  -- 5 expense claims
  select count(*) filter (where e.status = 'pending'), coalesce(sum(e.amount) filter (where e.status = 'pending'), 0),
         count(*) filter (where e.status = 'approved'), coalesce(sum(e.amount) filter (where e.status = 'approved'), 0)
    into n_claim, a_claim, n_claim_ok, a_claim_ok
    from public.expense_claims e where e.quote_id = p_quote and e.org_id = p_org;
  v_checks := v_checks || jsonb_build_array(case
    when n_claim > 0 then public._r22_check('claims', 'No expense claims waiting', 'fail', 'any',
         n_claim || ' staff expense claim(s) waiting for approval.', 'settlement', n_claim, a_claim)
    when n_claim_ok > 0 then public._r22_check('claims', 'No expense claims waiting', 'warn', null,
         n_claim_ok || ' approved claim(s) not paid yet.', 'settlement', n_claim_ok, a_claim_ok)
    else public._r22_check('claims', 'No expense claims waiting', 'ok', null, 'No staff expense claim is waiting.', 'settlement', 0, null) end);
  -- 6 refunds
  select count(*), coalesce(sum(x.amount), 0) into n_ref, a_ref
    from public.event_refunds x where x.quote_id = p_quote and x.org_id = p_org and x.status in ('pending', 'approved');
  v_checks := v_checks || jsonb_build_array(case when n_ref > 0
    then public._r22_check('refunds', 'No refunds waiting', 'fail', 'any', n_ref || ' refund / recovery entry(ies) not processed yet.', 'settlement', n_ref, a_ref)
    else public._r22_check('refunds', 'No refunds waiting', 'ok', null, 'No refund is waiting.', 'settlement', 0, null) end);
  -- 7 a vendor bill for every priced vendor booking
  select count(*), count(*) filter (where not x.billed),
         string_agg(case when not x.billed then x.label end, ', ' order by x.label)
    into n_book, n_nobill, v_nobill
    from (select coalesce(nullif(btrim(r.label), ''), coalesce(v.name, 'booking')) as label,
                 exists (select 1 from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status = 'open'
                           and (vb.booking_id = r.id or (vb.booking_id is null and vb.vendor_id = r.vendor_id))) as billed
            from public.event_resources r left join public.vendors v on v.id = r.vendor_id
           where r.quote_id = p_quote and r.org_id = p_org and r.vendor_id is not null
             and r.status in ('booked', 'confirmed', 'delivered') and coalesce(r.cost, 0) > 0) x;
  v_checks := v_checks || jsonb_build_array(case
    when n_nobill > 0 then public._r22_check('bills', 'Vendor bills recorded', 'fail', 'any',
         n_nobill || ' of ' || n_book || ' vendor booking(s) have no bill yet: ' || left(v_nobill, 300) || '.', 'settlement', n_nobill, null)
    when n_book = 0 then public._r22_check('bills', 'Vendor bills recorded', 'ok', null, 'No priced vendor bookings.', 'settlement', 0, null)
    else public._r22_check('bills', 'Vendor bills recorded', 'ok', null, 'Every vendor booking has a bill (' || n_book || ').', 'settlement', 0, null) end);
  -- 8 crew arrivals marked (same crew set as the 0246 ledger)
  select count(*), count(*) filter (where not x.marked), count(*) filter (where x.here)
    into n_crew, n_crew_open, n_crew_here
    from (select exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                           and d.ref_id = cm.id and d.status in ('arrived', 'left', 'no_show')) as marked,
                 exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                           and d.ref_id = cm.id and d.status in ('arrived', 'left')) as here
            from public.crew_members cm
           where cm.org_id = p_org
             and (exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                            and t.status not in ('rejected', 'cancelled', 'unassigned'))
               or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = cm.id))) x;
  v_checks := v_checks || jsonb_build_array(case
    when n_crew_open > 0 then public._r22_check('attendance', 'Crew attendance confirmed', 'fail', 'any',
         n_crew_open || ' of ' || n_crew || ' crew member(s) have no arrival marked for the event day.', 'command', n_crew_open, null)
    when n_crew = 0 then public._r22_check('attendance', 'Crew attendance confirmed', 'ok', null, 'No crew assigned to this event.', 'command', 0, null)
    else public._r22_check('attendance', 'Crew attendance confirmed', 'ok', null, 'Arrival marked for all ' || n_crew || ' crew member(s).', 'command', 0, null) end);
  -- 9 vendor payouts (warning only)
  select count(*) filter (where x.due > 0.5), coalesce(sum(x.due) filter (where x.due > 0.5), 0) into n_due, a_due
    from (select vb.amount - coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as due
            from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status = 'open') x;
  v_checks := v_checks || jsonb_build_array(case when n_due > 0
    then public._r22_check('payouts', 'Vendors paid', 'warn', null, n_due || ' vendor bill(s) not fully paid yet (you can still pay them after closing).', 'settlement', n_due, a_due)
    else public._r22_check('payouts', 'Vendors paid', 'ok', null, 'Every recorded vendor bill is paid.', 'settlement', 0, 0) end);

  -- small counts for the closure dashboard
  select count(*) filter (where t.status <> 'cancelled'), count(*) filter (where t.status = 'completed'),
         count(*) filter (where t.status not in ('completed', 'cancelled'))
    into n_task, n_task_done, n_task_open from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org;
  select count(*), count(*) filter (where i.status <> 'resolved'), count(*) filter (where i.status <> 'resolved' and i.severity = 'high')
    into n_iss, n_iss_open, n_iss_high from public.event_issues i where i.quote_id = p_quote and i.org_id = p_org;
  select count(distinct r.vendor_id) into n_vend from public.event_resources r
   where r.quote_id = p_quote and r.org_id = p_org and r.vendor_id is not null and r.status <> 'cancelled';

  return jsonb_build_object(
    'checks', v_checks,
    'failed', (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(v_checks) c where c ->> 'status' = 'fail'),
    'inventory', v_inv,
    'server_blocked', coalesce((b ->> 'blocked')::boolean, false),
    'too_early', coalesce((b ->> 'too_early')::boolean, false),
    'close_after', b ->> 'close_after',
    'counts', jsonb_build_object(
      'tasks', n_task, 'tasks_done', n_task_done, 'tasks_open', n_task_open,
      'issues', n_iss, 'issues_open', n_iss_open, 'issues_high_open', n_iss_high,
      'vendors', n_vend, 'vendor_bookings', n_book, 'crew', n_crew, 'crew_arrived', n_crew_here,
      'items', n_items, 'still_out', n_out, 'reserved_open', n_res, 'missing', n_miss, 'written_off', n_wo,
      'reserved_unused', n_unused, 'damaged', n_dmg));
end $$;



-- ---- 9) grants ----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['_r24_not_back(numeric, numeric, numeric, numeric)', '_r24_release(uuid, uuid, uuid, boolean)',
                           'tg_r24_release_on_back()'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
  foreach f in array array['checkin_stock(uuid, numeric, numeric, text)', 'issue_stock_request(uuid, text, uuid, text, boolean)',
                           'release_unused_stock(uuid, boolean)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.' || f || ' to authenticated'; end if;
  end loop;
end $$;

-- ---- VERIFY (read-only): every row must say ok = true ------------------------------------
select item, ok from (values
  ('01 new columns: check-outs remember damaged, requests link their check-out',
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'qty_damaged')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_stock_requests' and column_name = 'checkout_id')),
  ('02 mark back / give out / release: signed-in only',
       has_function_privilege('authenticated', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
       and not has_function_privilege('anon', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
       and has_function_privilege('authenticated', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
       and not has_function_privilege('anon', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
       and has_function_privilege('authenticated', 'public.release_unused_stock(uuid,boolean)', 'execute')
       and not has_function_privilege('anon', 'public.release_unused_stock(uuid,boolean)', 'execute')),
  ('03 helpers private', not has_function_privilege('authenticated', 'public._r24_release(uuid,uuid,uuid,boolean)', 'execute')
       and not has_function_privilege('anon', 'public._r24_release(uuid,uuid,uuid,boolean)', 'execute')),
  ('04 reservation follows its stock (trigger)', exists (select 1 from pg_trigger where tgname = 'zz_r24_release_on_back'
       and tgrelid = 'public.inventory_checkouts'::regclass)),
  ('05 free-stock maths + closure checklist are 0268', position('_r24_not_back' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._checkout_free(uuid,date,uuid)'))) > 0
       and position('_r24_not_back' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.checkout_availability(uuid,uuid)'))) > 0
       and position('r24-stock-0268' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r22_close_checks(uuid,uuid)'))) > 0),
  ('06 closure review still for signed-in users only', has_function_privilege('authenticated', 'public.event_closure_review(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.event_closure_review(uuid)', 'execute'))
) v(item, ok) order by item;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 new columns: check-outs remember damaged, requests link their check-out',
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'qty_damaged')
       and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_stock_requests' and column_name = 'checkout_id')),
  ('02 mark back / give out / release: signed-in only',
       has_function_privilege('authenticated', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
       and not has_function_privilege('anon', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
       and has_function_privilege('authenticated', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
       and not has_function_privilege('anon', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
       and has_function_privilege('authenticated', 'public.release_unused_stock(uuid,boolean)', 'execute')
       and not has_function_privilege('anon', 'public.release_unused_stock(uuid,boolean)', 'execute')),
  ('03 helpers private', not has_function_privilege('authenticated', 'public._r24_release(uuid,uuid,uuid,boolean)', 'execute')
       and not has_function_privilege('anon', 'public._r24_release(uuid,uuid,uuid,boolean)', 'execute')),
  ('04 reservation follows its stock (trigger)', exists (select 1 from pg_trigger where tgname = 'zz_r24_release_on_back'
       and tgrelid = 'public.inventory_checkouts'::regclass)),
  ('05 free-stock maths + closure checklist are 0268', position('_r24_not_back' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._checkout_free(uuid,date,uuid)'))) > 0
       and position('_r24_not_back' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.checkout_availability(uuid,uuid)'))) > 0
       and position('r24-stock-0268' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r22_close_checks(uuid,uuid)'))) > 0),
  ('06 closure review still for signed-in users only', has_function_privilege('authenticated', 'public.event_closure_review(uuid)', 'execute')
       and not has_function_privilege('anon', 'public.event_closure_review(uuid)', 'execute'))
) v(item, ok) order by item;
