-- 0071_reserve_inventory_atomic.sql
-- (was the orphaned 0070_reserve_inventory_atomic.sql; an older body of this function was hand-pasted
--  on prod + staging. This migration supersedes it: search_path = '' and created_by = auth.uid().)
-- Additive + idempotent (CREATE OR REPLACE FUNCTION only; no table or data changes).
--
-- Atomic inventory reservation: locks the item row, re-computes demand for the event's
-- date (live reservations + open check-outs, ignoring shelved/cancelled/closed events),
-- and inserts only if it still fits. Closes the check-then-insert race that the client-side
-- re-check in store-api.js (inventory.reserve) can only narrow.
-- The client should call this via rpc("reserve_inventory", ...) once deployed, falling
-- back to the plain insert when the function is missing.

create or replace function public.reserve_inventory(p_item uuid, p_quote uuid, p_qty numeric, p_note text default null)
returns public.inventory_reservations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total numeric; v_date date; v_org uuid := public.current_org_id();
  v_load numeric; v_undated numeric; v_row public.inventory_reservations;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  perform public.assert_quote_org(p_quote);

  -- serialise concurrent reservations of the same item
  select total_qty into v_total from public.inventory_items
    where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode='42501'; end if;

  select event_date into v_date from public.quotes where id = p_quote;

  -- per (item, event) demand = greatest(live reservations, still-out check-outs); live events only
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

  -- stock checked out with no event counts as undated demand
  v_undated := v_undated + coalesce((select sum(c.qty_out - coalesce(c.qty_in,0)) from public.inventory_checkouts c
                                      where c.item_id = p_item and c.quote_id is null and c.status in ('out','partial')),0);

  -- a dateless target event is checked conservatively against everything on its own bucket
  if v_date is null then v_load := v_undated; v_undated := 0; end if;

  if v_load + v_undated + p_qty > v_total then
    raise exception 'not enough stock free (% left)', greatest(v_total - v_load - v_undated, 0) using errcode='P0001';
  end if;

  insert into public.inventory_reservations (item_id, quote_id, qty, note, created_by)
    values (p_item, p_quote, p_qty, nullif(btrim(coalesce(p_note,'')),''), auth.uid())
    returning * into v_row;
  return v_row;
end $$;

revoke all on function public.reserve_inventory(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory(uuid, uuid, numeric, text) to authenticated;
