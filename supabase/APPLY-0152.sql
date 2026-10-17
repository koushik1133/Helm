-- APPLY-0152.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: re-creates 4 functions, adds 2 new BEFORE INSERT triggers. No existing rows change. Safe to run twice.
begin;
-- 0152_manager_role_fixes.sql - CANONICAL forward-only.
-- REQUIRES 0003 (helm_total_paid) + 0033 (tg_pay_needs_total) + 0049/0110/0148 (close gate) + 0124 (vendor_bills).
--
-- In plain words - manager QA 2026-10-19:
--   1. A draft quote that was never priced or confirmed could be closed (the close check only looked
--      at money owed, which is 0 when there is no total). Closing now also needs the event to be
--      CONFIRMED with a price (a cancelled event can still be closed, to settle it). An admin can
--      still close with a written override reason, exactly as before (audited).
--   2. A refund bigger than what the client has paid, and a vendor bill on a closed or never-
--      confirmed event, were accepted. New rows are now checked when they are created:
--        - refunds (kind 'refund'): all open refunds together can't exceed what was paid
--        - refunds and vendor bills: not on a closed event (re-open it first)
--        - vendor bills: not on a quote that was never confirmed
--      Existing rows are NOT touched or re-checked. Updates are not affected.
--   3. The "no quote total yet" payment error had garbled characters on staging (an em dash pasted
--      with the wrong encoding). Same trigger function, same logic, ASCII hyphen in the message.
--
-- ZERO DATA LOSS: CREATE OR REPLACE of functions + CREATE OR REPLACE TRIGGER (new triggers only).
-- No table, column, row or policy is removed or changed. ASCII only. Safe to run twice.

do $$ begin
  if to_regprocedure('public._a49_close_blockers(uuid)') is null
     or to_regprocedure('public._a49_blocker_text(jsonb)') is null
     or to_regprocedure('public.helm_invoice_total(uuid)') is null then
    raise exception 'STOP: apply 0049 + 0110 (close gate) first'; end if;
  if to_regprocedure('public.tg_pay_needs_total()') is null then
    raise exception 'STOP: apply 0033 first'; end if;
  if to_regclass('public.vendor_bills') is null or to_regclass('public.event_refunds') is null then
    raise exception 'STOP: apply 0124 (vendor bills) first'; end if;
end $$;

-- ---- 1) close gate: an unpriced / never-confirmed quote is a blocker ---------------------
create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- 0110 body + manager-1019-0152: not_booked blocker
declare v_total numeric; v_paid numeric; v_owed numeric; v_items jsonb; v_n int; v_status text; v_nb text;
begin
  select coalesce(nullif(q.pricing ->> 'total', '')::numeric, 0), q.status into v_total, v_status
    from public.quotes q where q.id = p_quote;
  if coalesce(v_total, 0) > 0 then v_total := public.helm_invoice_total(p_quote); end if;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_owed := greatest(coalesce(v_total, 0) - v_paid, 0);
  if v_owed <= 0.5 then v_owed := 0; end if;
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', coalesce(i.name, 'item'), 'qty', c.qty_out, 'issued_to', c.issued_to)
           order by c.checked_out_at), '[]'::jsonb)
    into v_n, v_items
    from public.inventory_checkouts c left join public.inventory_items i on i.id = c.item_id
   where c.quote_id = p_quote and c.status = 'out';
  -- 0152: a cancelled event may still be closed; anything else must be confirmed AND priced
  if coalesce(v_status, '') <> 'cancelled' then
    if coalesce(v_status, '') <> 'confirmed' then v_nb := 'unconfirmed';
    elsif coalesce(v_total, 0) <= 0 then v_nb := 'unpriced'; end if;
  end if;
  return jsonb_build_object('total', coalesce(v_total, 0), 'paid', v_paid, 'balance_owed', v_owed,
                            'open_checkouts', v_n, 'checkouts', v_items, 'not_booked', v_nb,
                            'blocked', (v_owed > 0 or v_n > 0 or v_nb is not null));
end $$;

create or replace function public._a49_blocker_text(b jsonb)
returns text language sql immutable set search_path = '' as $$
  -- manager-1019-0152: + not_booked
  select concat_ws('; ',
    case when b ->> 'not_booked' = 'unconfirmed' then 'the quote was never confirmed by the client'
         when b ->> 'not_booked' = 'unpriced' then 'the quote has no price yet' end,
    case when (b ->> 'balance_owed')::numeric > 0
         then 'client balance still owed: ' || to_char((b ->> 'balance_owed')::numeric, 'FM999999999990.00') end,
    case when (b ->> 'open_checkouts')::int > 0
         then (b ->> 'open_checkouts') || ' equipment checkout(s) still out: '
              || (select string_agg(x ->> 'item' || ' x' || (x ->> 'qty'), ', ')
                    from (select x from jsonb_array_elements(b -> 'checkouts') x limit 8) s) end);
$$;

do $$ declare f text; begin
  foreach f in array array['_a49_close_blockers(uuid)', '_a49_blocker_text(jsonb)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 2) checks when a refund or vendor bill is CREATED --------------------------------------
create or replace function public.tg_a152_money_create_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- manager-1019-0152: refunds / vendor bills checked on insert (API callers only)
declare v_status text; v_paid numeric; v_open numeric;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if new.quote_id is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  select q.status into v_status from public.quotes q where q.id = new.quote_id;
  if exists (select 1 from public.event_closure c where c.quote_id = new.quote_id and c.closed_at is not null) then
    raise exception 'This event is closed - re-open it before adding a %.',
      case when tg_table_name = 'vendor_bills' then 'vendor bill' else 'refund' end
      using errcode = '23514', hint = 'event_closed';
  end if;
  if tg_table_name = 'vendor_bills' then
    if coalesce(v_status, '') = 'quote' then
      raise exception 'This quote is not confirmed yet - confirm the booking before adding a vendor bill.'
        using errcode = '23514', hint = 'not_confirmed';
    end if;
    return new;
  end if;
  -- event_refunds: money given back can't exceed money received
  if coalesce(new.kind, 'refund') = 'refund' and coalesce(new.status, 'pending') <> 'rejected' then
    v_paid := coalesce(public.helm_total_paid(new.quote_id, null, null), 0);
    select coalesce(sum(r.amount), 0) into v_open from public.event_refunds r
     where r.quote_id = new.quote_id and coalesce(r.kind, 'refund') = 'refund' and r.status in ('pending', 'approved', 'processed');
    if coalesce(new.amount, 0) + v_open > v_paid + 0.5 then
      raise exception 'A refund can''t be more than the client has paid (paid %, already refunded or pending %).',
        to_char(v_paid, 'FM999999999990.00'), to_char(v_open, 'FM999999999990.00')
        using errcode = '23514', hint = 'refund_over_paid';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_a152_money_create_guard() from public, anon, authenticated;

create or replace trigger ad_a152_refund_create_guard before insert on public.event_refunds
  for each row execute function public.tg_a152_money_create_guard();
create or replace trigger ad_a152_bill_create_guard before insert on public.vendor_bills
  for each row execute function public.tg_a152_money_create_guard();

-- ---- 3) payment error: ASCII message (logic unchanged from 0033) ----------------------------
create or replace function public.tg_pay_needs_total()
returns trigger language plpgsql security definer set search_path = '' as $$
-- rescore3-0033 / manager-1019-0152 ascii message
declare v_total numeric;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if new.status is distinct from 'paid' or coalesce(new.amount, 0) <= 0 then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'paid' and new.amount is not distinct from old.amount then
    return new;
  end if;
  select public.helm_pricing_num(q.pricing -> 'total') into v_total from public.quotes q where q.id = new.quote_id;
  if v_total is null or v_total <= 0 then
    raise exception 'this event has no quote total yet - price the quote before recording a payment'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.tg_pay_needs_total() from public, anon, authenticated;
commit;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 close gate knows not_booked', position('not_booked' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._a49_close_blockers(uuid)'))) > 0),
  ('02 blocker text knows not_booked', position('not_booked' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._a49_blocker_text(jsonb)'))) > 0),
  ('03 refund create guard trigger', exists (select 1 from pg_trigger where tgname = 'ad_a152_refund_create_guard' and tgrelid = 'public.event_refunds'::regclass)),
  ('04 vendor bill create guard trigger', exists (select 1 from pg_trigger where tgname = 'ad_a152_bill_create_guard' and tgrelid = 'public.vendor_bills'::regclass)),
  ('05 payment message is ASCII', (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_pay_needs_total()')) ~ '^[\x01-\x7f]*$'
       and position('no quote total yet - price' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_pay_needs_total()'))) > 0),
  ('06 helpers closed to studio users', not has_function_privilege('authenticated', 'public._a49_close_blockers(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public.tg_a152_money_create_guard()', 'execute')),
  ('07 close_event_blockers still callable', has_function_privilege('authenticated', 'public.close_event_blockers(uuid)', 'execute'))
) v(item, ok) order by item;
