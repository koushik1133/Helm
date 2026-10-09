-- 0073_inventory_cancel_and_unique_names.sql - CANONICAL forward-only.
-- Additive + idempotent. No row is updated or deleted by this migration.
-- REQUIRES 0015, 0025, 0071, 0072.
--
-- In plain words:
--   1  Owner decision #4: equipment check-out records are NEVER hard-deleted. A check-out recorded
--      by mistake (nothing returned yet) is CANCELLED with the new cancel_checkout() function:
--      status 'cancelled', who + when kept, the audit trigger logs it, and the stock is free again.
--      The checkouts status CHECK is widened to allow 'cancelled' (superset swap, guarded DO block).
--      The "ra del" RLS policy on inventory_checkouts is dropped and DELETE revoked from the API
--      roles, so the app can no longer delete a check-out row.
--   2  Every "how much is out" sum ignores cancelled rows: checkout_equipment (was "status <> returned",
--      which would have counted cancelled rows), reserve_inventory (0071, already out/partial only),
--      and checkin_equipment / worker_checkin_equipment refuse a cancelled row.
--   3  Owner decision #12: exact duplicate names among ACTIVE inventory items, partners (vendors) and
--      dishes (same category + name) are refused by partial unique indexes on
--      (org_id, lower(btrim(name))) WHERE active. Each index is created ONLY when no duplicates
--      exist today; otherwise it is skipped with a NOTICE (re-run this file after the owner has
--      renamed or deactivated the extras in the app). Existing data is never modified.
--      Staff phones and leads stay WARN-only in the app (no index).

-- ---- 1a) status CHECK: allow 'cancelled' (superset of out / returned / partial) -------------
do $$
declare v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'inventory_checkouts_status_check' and c.conrelid = 'public.inventory_checkouts'::regclass;
  if v_def is null or v_def not like '%cancelled%' then
    if v_def is not null then
      alter table public.inventory_checkouts drop constraint inventory_checkouts_status_check;
    end if;
    alter table public.inventory_checkouts add constraint inventory_checkouts_status_check
      check (status = any (array['out'::text, 'returned'::text, 'partial'::text, 'cancelled'::text]));
  end if;
end $$;

alter table public.inventory_checkouts add column if not exists cancelled_at timestamptz;
alter table public.inventory_checkouts add column if not exists cancelled_by uuid;

-- ---- 1b) cancel_checkout: the only way to take back a mistaken check-out --------------------
create or replace function public.cancel_checkout(p_id uuid, p_reason text default null)
returns public.inventory_checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.inventory_checkouts; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.has_area('inventory', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v_row from public.inventory_checkouts
   where id = p_id and org_id = public.current_org_id() for update;
  if not found then raise exception 'checkout not found' using errcode = '42501'; end if;
  if v_row.status = 'cancelled' then return v_row; end if;              -- idempotent
  if v_row.status <> 'out' or coalesce(v_row.qty_in, 0) > 0 or v_row.checked_in_at is not null then
    raise exception 'This check-out already has items returned - check it in instead of cancelling it.'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and length(v_reason) > 500 then v_reason := left(v_reason, 500); end if;
  update public.inventory_checkouts
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         note = case when v_reason is null then note
                     else concat_ws(' | ', nullif(btrim(coalesce(note, '')), ''), 'Cancelled: ' || v_reason) end
   where id = p_id and org_id = public.current_org_id()
   returning * into v_row;
  return v_row;                                                           -- audit_trg logs the UPDATE
end $$;
revoke all on function public.cancel_checkout(uuid, text) from public, anon;
grant execute on function public.cancel_checkout(uuid, text) to authenticated;

-- ---- 1c) no hard delete of check-out rows from the API -------------------------------------
drop policy if exists "ra del" on public.inventory_checkouts;
revoke delete on public.inventory_checkouts from anon, authenticated;

-- ---- 2a) checkout_equipment: only out / partial rows count as out (0072 body otherwise) ------
create or replace function public.checkout_equipment(
  p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid, p_note text)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_total numeric; v_out numeric; v_free numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item and org_id = public.current_org_id()) then
    raise exception 'item not found' using errcode='42501'; end if;
  if p_quote is not null then perform public.assert_quote_org(p_quote); end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  if coalesce(btrim(p_issued_to),'') = '' then raise exception 'who is it issued to?'; end if;

  -- physical availability guard; FOR UPDATE serialises concurrent check-outs of the same item
  select coalesce(total_qty,0) into v_total
    from public.inventory_items where id = p_item and org_id = public.current_org_id() for update;
  select coalesce(sum(greatest(qty_out - coalesce(qty_in,0), 0)), 0) into v_out
    from public.inventory_checkouts where item_id = p_item and status in ('out','partial');
  v_free := v_total - v_out;
  if p_qty > v_free then
    raise exception 'cannot check out % - only % of % available (% already out on loan)',
      p_qty, v_free, v_total, v_out using errcode='23514';
  end if;

  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $$;
grant execute on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) to authenticated;

-- ---- 2b) check-in refuses a cancelled row (0072 bodies otherwise) ---------------------------
create or replace function public.checkin_equipment(p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean default false)
 returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_missing numeric; v_new_wo numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id and org_id = public.current_org_id() for update;
  if not found then raise exception 'checkout not found'; end if;
  if row.status = 'cancelled' then raise exception 'This check-out was cancelled - nothing to check in.'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  if coalesce(p_qty_in,0) > row.qty_out then raise exception 'returned count cannot exceed quantity issued'; end if;
  v_missing := greatest(row.qty_out - coalesce(p_qty_in,0), 0);
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = nullif(btrim(coalesce(p_returned_by,'')),''),
         confirmed_by = auth.uid(),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= row.qty_out then 'returned' else 'partial' end
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if p_writeoff and v_missing > coalesce(row.written_off,0) then
    v_new_wo := v_missing - coalesce(row.written_off,0);
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty,0) - v_new_wo)
     where id = row.item_id and org_id = public.current_org_id();
    update public.inventory_checkouts set written_off = v_missing where id = p_id and org_id = public.current_org_id()
     returning * into row;
  end if;
  return row;
end; $$;
grant execute on function public.checkin_equipment(uuid,numeric,text,boolean) to authenticated;

create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  w := public._work_token_live(p_token);
  select * into row from public.inventory_checkouts where id = p_id for update;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  if row.status = 'cancelled' then raise exception 'This check-out was cancelled - nothing to check in.'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  if coalesce(p_qty_in,0) > row.qty_out then raise exception 'returned count cannot exceed quantity issued'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $function$;

-- ---- 3) duplicate active names: partial unique indexes, only when the data is already clean ---
do $$
declare v_n bigint;
begin
  if to_regclass('public.inventory_items_org_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.inventory_items where active
      group by org_id, lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index inventory_items_org_name_uidx on public.inventory_items (org_id, lower(btrim(name))) where active';
    else
      raise notice '0073: inventory_items_org_name_uidx SKIPPED - % duplicate active name group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;

  if to_regclass('public.vendors_org_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.vendors where active
      group by org_id, lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index vendors_org_name_uidx on public.vendors (org_id, lower(btrim(name))) where active';
    else
      raise notice '0073: vendors_org_name_uidx SKIPPED - % duplicate active name group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;

  if to_regclass('public.dish_catalog_org_cat_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.dish_catalog where active
      group by org_id, lower(btrim(category)), lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index dish_catalog_org_cat_name_uidx on public.dish_catalog (org_id, lower(btrim(category)), lower(btrim(name))) where active';
    else
      raise notice '0073: dish_catalog_org_cat_name_uidx SKIPPED - % duplicate active dish group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;
end $$;
