-- ============================================================================
-- 0015_checkout_overissue_guard.sql — stop checking out more stock than you own.
-- Forward-only, idempotent (CREATE OR REPLACE). NO data change, NO signature change.
--
-- BUG: checkout_equipment inserted a loan with no availability check, so you could
-- check out 20 of 20 items, then check out 20 MORE — 40 physically "out" of 20 owned
-- (double-allocation / over-issue). Found in the Oct-2026 operations pass.
--
-- FIX: before issuing, reject when the requested qty exceeds what is physically on hand
-- = total_qty - (everything still out on loan for that item). "Still out" = qty_out minus
-- what's already been checked back in, over every non-returned checkout. This is a pure
-- physical-stock guard (checkout-vs-checkout + total), so it can't double-count against
-- date-based reservations. Behaviour is otherwise identical to the canonical function.
-- ============================================================================

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

  -- physical availability guard (the fix)
  select coalesce(total_qty,0) into v_total
    from public.inventory_items where id = p_item and org_id = public.current_org_id();
  select coalesce(sum(greatest(qty_out - coalesce(qty_in,0), 0)), 0) into v_out
    from public.inventory_checkouts where item_id = p_item and status <> 'returned';
  v_free := v_total - v_out;
  if p_qty > v_free then
    raise exception 'cannot check out % — only % of % available (% already out on loan)',
      p_qty, v_free, v_total, v_out using errcode='23514';
  end if;

  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $$;
grant execute on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) to authenticated;

-- ---- VERIFY (read-only) -----------------------------------------------------
-- A second checkout that would exceed total_qty now raises errcode 23514.
