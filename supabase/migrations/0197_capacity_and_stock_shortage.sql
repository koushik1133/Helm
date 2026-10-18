-- 0197_capacity_and_stock_shortage.sql - CANONICAL forward-only.
-- REQUIRES the base quotes / inventory_items / inventory_reservations / inventory_checkouts /
-- event_stock_requests (phase23) / event_resources / vendors tables, 0026 (tg_ref_org_match),
-- 0071 (reserve_inventory demand rule) and phase72 (assert_quote_org).
--
-- In plain words:
--   1) OVER-CAPACITY DECISION. A quote can have more guests than its linked venue holds
--      (seated + floating). Before the quote is sent, a PDF is made or the booking is confirmed,
--      the app now asks how to resolve it: change venue, reduce guests, extend the space (an
--      overflow tent / extra seating line) or proceed anyway with a note. The answer is kept on
--      the quote in a NEW nullable column quotes.capacity_decision (jsonb), written only through
--      set_quote_capacity_decision(quote, decision): quotes edit right + own studio, shape
--      checked, the venue / inventory item / vendor it names must be the caller's own studio's.
--      The app never writes the column directly (no column grant), so the shape is always valid.
--   2) STOCK SHORTAGE SOURCING. "Reserve for this event" asking for more than is free no longer
--      over-commits stock (which showed a minus on inventory and the calendar). The new
--      reserve_inventory_with_sourcing(item, quote, qty, note, source, vendor, rate, source_note)
--      does it in ONE transaction: locks the item, works out what is free on the event's date
--      exactly like reserve_inventory (0071: live reservations + still-out check-outs, shelved /
--      cancelled / closed events ignored), reserves only what is free, and records the rest as a
--      shortage on event_stock_requests (new nullable columns source / booking_id / vendor_id):
--        source 'vendor' - rent from a vendor: also adds a vendor booking (event_resources,
--                          status enquiry, cost = shortfall x rate) so it shows in Budget & margin
--                          and the vendor's history;
--        source 'buy'    - outsource / buy (note only);
--        source 'none'   - not sourced yet (shows as "unsourced").
--      Available stock can never go below zero through this path.
--   Additive + idempotent: ADD COLUMN IF NOT EXISTS (nullable, no default, no backfill), check /
--   foreign-key constraints on those new all-null columns created only when missing (so they pass
--   on every existing row), org-match triggers created only when missing, CREATE OR REPLACE FUNCTION. No DROP of data, DELETE, UPDATE or TRUNCATE; no existing
--   row is changed. The 0167 sample clone and trial seed are untouched (new columns stay null).
--   ROLLBACK (manual, only if ever needed): drop function public.set_quote_capacity_decision(uuid, jsonb);
--   drop function public.reserve_inventory_with_sourcing(uuid, uuid, numeric, text, text, uuid, numeric, text);
--   the new columns can stay (all nullable) - dropping them would discard recorded decisions.
-- ============================================================================

do $$ begin
  if to_regclass('public.quotes') is null then raise exception '0197: public.quotes is missing'; end if;
  if to_regclass('public.event_stock_requests') is null then raise exception '0197: public.event_stock_requests is missing (phase23)'; end if;
  if to_regclass('public.event_resources') is null then raise exception '0197: public.event_resources is missing'; end if;
  if to_regclass('public.inventory_reservations') is null then raise exception '0197: public.inventory_reservations is missing'; end if;
  if to_regclass('public.vendors') is null then raise exception '0197: public.vendors is missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0197: public.has_area(text,text) is missing'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0197: public.current_org_id() is missing'; end if;
end $$;

-- ---- 1) new nullable columns ------------------------------------------------------------------
alter table public.quotes add column if not exists capacity_decision jsonb;
alter table public.event_stock_requests add column if not exists source text;
alter table public.event_stock_requests add column if not exists booking_id uuid;
alter table public.event_stock_requests add column if not exists vendor_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_capacity_decision_shape_0197') then
    alter table public.quotes add constraint quotes_capacity_decision_shape_0197
      check (capacity_decision is null or (jsonb_typeof(capacity_decision) = 'object'
             and capacity_decision ->> 'choice' in ('venue', 'reduce', 'extend', 'proceed')
             and pg_column_size(capacity_decision) <= 8192));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_stock_requests'::regclass and conname = 'event_stock_requests_source_0197') then
    alter table public.event_stock_requests add constraint event_stock_requests_source_0197
      check (source is null or source in ('vendor', 'buy', 'none'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_stock_requests'::regclass and conname = 'event_stock_requests_booking_fk_0197') then
    alter table public.event_stock_requests add constraint event_stock_requests_booking_fk_0197
      foreign key (booking_id) references public.event_resources(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_stock_requests'::regclass and conname = 'event_stock_requests_vendor_fk_0197') then
    alter table public.event_stock_requests add constraint event_stock_requests_vendor_fk_0197
      foreign key (vendor_id) references public.vendors(id) on delete set null;
  end if;
end $$;

create index if not exists event_stock_req_booking_idx_0197 on public.event_stock_requests(booking_id) where booking_id is not null;
create index if not exists event_stock_req_vendor_idx_0197 on public.event_stock_requests(vendor_id) where vendor_id is not null;

-- cross-studio guard for the two new references (0026 tg_ref_org_match; new / changed values only)
do $$ begin
  if to_regprocedure('public.tg_ref_org_match()') is null then return; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_stock_requests' and column_name = 'org_id') then
    if not exists (select 1 from pg_trigger where tgrelid = 'public.event_stock_requests'::regclass and tgname = 'zz_ref_org_match_booking_id' and not tgisinternal) then
      create trigger zz_ref_org_match_booking_id before insert or update of booking_id, org_id on public.event_stock_requests
        for each row execute function public.tg_ref_org_match('booking_id', 'event_resources');
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = 'public.event_stock_requests'::regclass and tgname = 'zz_ref_org_match_vendor_id' and not tgisinternal) then
      create trigger zz_ref_org_match_vendor_id before insert or update of vendor_id, org_id on public.event_stock_requests
        for each row execute function public.tg_ref_org_match('vendor_id', 'vendors');
    end if;
  end if;
end $$;

-- ---- 2) set_quote_capacity_decision -----------------------------------------------------------
-- p_decision = null clears it. Otherwise:
--   { choice: venue|reduce|extend|proceed, note, guests, capacity, venue_id, venue_name,
--     extra_capacity (extend), line: { label, qty, rate, amount, source: inventory|vendor|later, item_id, vendor_id } }
-- The stored object adds decided_at + decided_by. Returns the stored value.
create or replace function public.set_quote_capacity_decision(p_quote uuid, p_decision jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_choice text; v_note text; v_guests numeric; v_cap numeric; v_extra numeric;
  v_venue uuid; v_line jsonb := null; v_src text; v_item uuid; v_vendor uuid;
  v_qty numeric; v_rate numeric; v_label text; v_out jsonb;
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  num_re constant text := '^[0-9]{1,9}(\.[0-9]{1,2})?$';
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_quote is null or not exists (select 1 from public.quotes where id = p_quote and org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if p_decision is null or p_decision = 'null'::jsonb then
    update public.quotes set capacity_decision = null where id = p_quote and org_id = v_org;
    return null;
  end if;
  if jsonb_typeof(p_decision) <> 'object' or pg_column_size(p_decision) > 6000 then
    raise exception 'capacity decision must be a small object' using errcode = '22023';
  end if;
  v_choice := p_decision ->> 'choice';
  if v_choice is null or v_choice not in ('venue', 'reduce', 'extend', 'proceed') then
    raise exception 'choose: change venue, reduce guests, extend the space or proceed anyway' using errcode = '22023';
  end if;
  v_note := nullif(btrim(coalesce(p_decision ->> 'note', '')), '');
  if v_note is not null and length(v_note) > 1000 then raise exception 'note is too long (1000 characters at most)' using errcode = '22023'; end if;
  if v_choice = 'proceed' and (v_note is null or length(v_note) < 5) then
    raise exception 'add a note (at least 5 characters) to proceed anyway' using errcode = '22023';
  end if;
  if coalesce(p_decision ->> 'guests', '') !~ '^[0-9]{1,7}$' or (p_decision ->> 'guests')::numeric < 1 then
    raise exception 'guests must be a whole number' using errcode = '22023';
  end if;
  v_guests := (p_decision ->> 'guests')::numeric;
  if coalesce(p_decision ->> 'capacity', '0') !~ '^[0-9]{1,7}$' then raise exception 'capacity must be a whole number' using errcode = '22023'; end if;
  v_cap := coalesce((p_decision ->> 'capacity')::numeric, 0);
  if coalesce(p_decision ->> 'extra_capacity', '0') !~ '^[0-9]{1,7}$' then raise exception 'extra capacity must be a whole number' using errcode = '22023'; end if;
  v_extra := coalesce((p_decision ->> 'extra_capacity')::numeric, 0);
  if v_choice = 'extend' and v_extra < 1 then raise exception 'say how many more guests the extra space holds' using errcode = '22023'; end if;
  if nullif(p_decision ->> 'venue_id', '') is not null then
    if (p_decision ->> 'venue_id') !~ uuid_re then raise exception 'venue is not valid' using errcode = '22023'; end if;
    v_venue := (p_decision ->> 'venue_id')::uuid;
    if to_regclass('public.venues') is null
       or not exists (select 1 from public.venues where id = v_venue and org_id = v_org) then
      raise exception 'venue belongs to another studio' using errcode = '42501';
    end if;
  end if;
  if p_decision ? 'line' and jsonb_typeof(p_decision -> 'line') = 'object' then
    v_label := nullif(btrim(coalesce(p_decision -> 'line' ->> 'label', '')), '');
    if v_label is null or length(v_label) > 200 then raise exception 'name the extra space (200 characters at most)' using errcode = '22023'; end if;
    v_src := coalesce(p_decision -> 'line' ->> 'source', 'later');
    if v_src not in ('inventory', 'vendor', 'later') then raise exception 'source must be inventory, vendor or later' using errcode = '22023'; end if;
    if coalesce(p_decision -> 'line' ->> 'qty', '1') !~ '^[0-9]{1,6}$' then raise exception 'quantity must be a whole number' using errcode = '22023'; end if;
    v_qty := coalesce((p_decision -> 'line' ->> 'qty')::numeric, 1);
    if coalesce(p_decision -> 'line' ->> 'rate', '0') !~ num_re then raise exception 'rate must be an amount' using errcode = '22023'; end if;
    v_rate := coalesce((p_decision -> 'line' ->> 'rate')::numeric, 0);
    if nullif(p_decision -> 'line' ->> 'item_id', '') is not null then
      if (p_decision -> 'line' ->> 'item_id') !~ uuid_re then raise exception 'item is not valid' using errcode = '22023'; end if;
      v_item := (p_decision -> 'line' ->> 'item_id')::uuid;
      if not exists (select 1 from public.inventory_items where id = v_item and org_id = v_org) then
        raise exception 'item belongs to another studio' using errcode = '42501'; end if;
    end if;
    if nullif(p_decision -> 'line' ->> 'vendor_id', '') is not null then
      if (p_decision -> 'line' ->> 'vendor_id') !~ uuid_re then raise exception 'vendor is not valid' using errcode = '22023'; end if;
      v_vendor := (p_decision -> 'line' ->> 'vendor_id')::uuid;
      if not exists (select 1 from public.vendors where id = v_vendor and org_id = v_org) then
        raise exception 'vendor belongs to another studio' using errcode = '42501'; end if;
    end if;
    v_line := jsonb_strip_nulls(jsonb_build_object('label', v_label, 'source', v_src, 'qty', v_qty, 'rate', v_rate,
      'amount', round(v_qty * v_rate, 2), 'item_id', v_item, 'vendor_id', v_vendor));
  elsif v_choice = 'extend' then
    raise exception 'describe the extra space (what, quantity and rate)' using errcode = '22023';
  end if;

  v_out := jsonb_strip_nulls(jsonb_build_object(
    'choice', v_choice, 'note', v_note, 'guests', v_guests, 'capacity', v_cap,
    'extra_capacity', case when v_choice = 'extend' then v_extra end,
    'venue_id', v_venue, 'venue_name', left(nullif(btrim(coalesce(p_decision ->> 'venue_name', '')), ''), 200),
    'line', v_line, 'decided_at', now(), 'decided_by', auth.uid()));
  update public.quotes set capacity_decision = v_out where id = p_quote and org_id = v_org;
  return v_out;
end $$;
revoke all on function public.set_quote_capacity_decision(uuid, jsonb) from public, anon;
grant execute on function public.set_quote_capacity_decision(uuid, jsonb) to authenticated;

-- ---- 3) reserve_inventory_with_sourcing ---------------------------------------------------------
-- Returns { reserved, short, available, reservation_id, request_id, booking_id }.
create or replace function public.reserve_inventory_with_sourcing(
  p_item uuid, p_quote uuid, p_qty numeric, p_note text default null,
  p_source text default 'none', p_vendor uuid default null, p_rate numeric default null, p_source_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_total numeric; v_name text; v_unit text; v_date date; v_code text;
  v_load numeric; v_undated numeric; v_free numeric; v_take numeric; v_short numeric;
  v_res uuid; v_req uuid; v_bk uuid; v_vname text; v_vkind text; v_src text := coalesce(nullif(btrim(coalesce(p_source, '')), ''), 'none');
  v_snote text := left(nullif(btrim(coalesce(p_source_note, '')), ''), 500);
  v_label text; v_txt text;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('inventory', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_qty is null or p_qty <= 0 or p_qty <> trunc(p_qty) or p_qty > 1000000 then
    raise exception 'quantity must be a whole number above 0' using errcode = '22023';
  end if;
  if v_src not in ('vendor', 'buy', 'none') then raise exception 'source must be vendor, buy or none' using errcode = '22023'; end if;
  if p_rate is not null and (p_rate < 0 or p_rate >= 1e9 or round(p_rate, 2) <> p_rate) then
    raise exception 'rate must be an amount of 0 or more' using errcode = '22023';
  end if;
  if not exists (select 1 from public.quotes where id = p_quote and org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if v_src = 'vendor' then
    if p_vendor is null then raise exception 'pick the vendor to rent from' using errcode = '22023'; end if;
    if not coalesce(public.has_area('vendors', 'edit'), false) then
      raise exception 'your role cannot add vendor bookings - choose outsource / buy or ask a manager' using errcode = '42501';
    end if;
    select name, kind into v_vname, v_vkind from public.vendors where id = p_vendor and org_id = v_org;
    if not found then raise exception 'vendor belongs to another studio' using errcode = '42501'; end if;
  elsif p_vendor is not null then
    raise exception 'a vendor is only used with source vendor' using errcode = '22023';
  end if;

  -- serialise with reserve_inventory / other sourcing calls on the same item
  select total_qty, name, unit into v_total, v_name, v_unit from public.inventory_items
    where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  select event_date, code into v_date, v_code from public.quotes where id = p_quote;

  -- same demand rule as reserve_inventory (0071)
  with ev as (
    select q.id, q.event_date from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.archived_at is null
       and q.status <> 'cancelled' and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')
  ), per as (
    select e.id as qid, e.event_date,
           greatest(coalesce((select sum(r.qty) from public.inventory_reservations r
                               where r.item_id = p_item and r.quote_id = e.id and r.status in ('reserved','allocated')),0),
                    coalesce((select sum(c.qty_out - coalesce(c.qty_in,0)) from public.inventory_checkouts c
                               where c.item_id = p_item and c.quote_id = e.id and c.status in ('out','partial')),0)) as d
      from ev e
  )
  select coalesce(sum(d) filter (where event_date is not distinct from v_date and v_date is not null),0),
         coalesce(sum(d) filter (where event_date is null),0)
    into v_load, v_undated from per;
  v_undated := v_undated + coalesce((select sum(c.qty_out - coalesce(c.qty_in,0)) from public.inventory_checkouts c
                                      where c.item_id = p_item and c.org_id = v_org and c.quote_id is null and c.status in ('out','partial')),0);
  if v_date is null then v_load := v_undated; v_undated := 0; end if;

  v_free := greatest(coalesce(v_total, 0) - v_load - v_undated, 0);
  v_free := floor(v_free);
  v_take := least(p_qty, v_free);
  v_short := p_qty - v_take;

  if v_take > 0 then
    insert into public.inventory_reservations (item_id, quote_id, qty, note, created_by)
      values (p_item, p_quote, v_take, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
      returning id into v_res;
  end if;

  if v_short > 0 then
    v_label := left('Short: ' || v_short::text || ' x ' || coalesce(v_name, 'item'), 200);
    if v_src = 'vendor' then
      v_txt := left('Rent ' || v_short::text || ' ' || coalesce(nullif(v_unit, ''), 'x') || ' ' || coalesce(v_name, 'item')
        || ' for ' || coalesce(v_code, 'this event') || coalesce(' on ' || to_char(v_date, 'DD Mon YYYY'), '')
        || ' (stock shortfall)' || coalesce('. ' || v_snote, ''), 2000);
      insert into public.event_resources (quote_id, vendor_id, kind, label, qty, cost, status, note, created_by)
        values (p_quote, p_vendor, v_vkind, left(coalesce(v_name, 'Item') || ' - rent ' || v_short::text || ' (stock shortfall)', 500),
                v_short, case when p_rate is null then null else round(v_short * p_rate, 2) end, 'enquiry', v_txt, auth.uid())
        returning id into v_bk;
    end if;
    insert into public.event_stock_requests (quote_id, item_id, label, qty, status, note, created_by, source, booking_id, vendor_id)
      values (p_quote, p_item, v_label, v_short, 'requested',
              left(case v_src when 'vendor' then 'Sourcing from ' || coalesce(v_vname, 'vendor')
                              when 'buy' then 'Outsource / buy'
                              else 'Unsourced' end
                   || coalesce(' - ' || v_snote, ''), 1000),
              auth.uid(), v_src, v_bk, case when v_src = 'vendor' then p_vendor end)
      returning id into v_req;
  end if;

  return jsonb_strip_nulls(jsonb_build_object('reserved', v_take, 'short', v_short, 'available', v_free,
    'reservation_id', v_res, 'request_id', v_req, 'booking_id', v_bk, 'source', case when v_short > 0 then v_src end));
end $$;
revoke all on function public.reserve_inventory_with_sourcing(uuid, uuid, numeric, text, text, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory_with_sourcing(uuid, uuid, numeric, text, text, uuid, numeric, text) to authenticated;

notify pgrst, 'reload schema';
