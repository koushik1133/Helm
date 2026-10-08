-- =====================================================================
-- PENDING-SQL-ALL.sql  --  running list of every SQL change still to be applied
-- Owner: Koushik. Kept up to date during the Oct-2026 edge-case pass.
--
-- RULES (all sections below follow them):
--   * ADDITIVE + IDEMPOTENT only: CREATE OR REPLACE / IF NOT EXISTS. Nothing is
--     dropped, deleted, truncated or rewritten. Safe to paste twice.
--   * Pure ASCII, no temp tables, no session state (Supabase SQL editor safe).
--   * Order matters: run sections top to bottom. Each has its own VERIFY query.
--   * Apply to STAGING (xizehqgeyjcfpzrdymly) first, check VERIFY, then PROD
--     (nqltzgiwznphugcfhmbm).
--
-- STATUS LOG
--   Section 1  reserve_inventory (atomic stock reservation)   status: NOT YET APPLIED
--              (a hand-pasted copy may exist on one database -- harmless to re-run)
--   Section 2+ none yet. New sections are appended here as the next pages are tested.
--
-- NOTE for the repo: when this goes into migrations it must be renumbered
-- (0070 is already used by 0070_booklet_payments.sql) -> 0071, and added to
-- supabase/migrations/MANIFEST so the "DB canonical" GitHub check passes.
-- =====================================================================


-- ---------------------------------------------------------------------
-- SECTION 1 -- public.reserve_inventory(uuid, uuid, numeric, text)
-- Why: two people reserving the last units at the same moment could both succeed.
-- This locks the item row, re-computes demand for the event date (live
-- reservations + open check-outs, ignoring archived/deleted/cancelled/closed
-- events) and inserts only if it still fits.
-- App side: inventory.reserve() calls it and falls back to the old behaviour if
-- the function does not exist. A user-confirmed "Reserve anyway" over-commit
-- deliberately bypasses it.
-- ---------------------------------------------------------------------
create or replace function public.reserve_inventory(p_item uuid, p_quote uuid, p_qty numeric, p_note text default null)
returns public.inventory_reservations
language plpgsql
security definer
set search_path = public
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

  insert into public.inventory_reservations (item_id, quote_id, qty, note)
    values (p_item, p_quote, p_qty, nullif(btrim(coalesce(p_note,'')),''))
    returning * into v_row;
  return v_row;
end $$;

revoke all on function public.reserve_inventory(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory(uuid, uuid, numeric, text) to authenticated;

-- VERIFY 1 (expect one row: reserve_inventory | true | authenticated can execute)
select p.proname,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'reserve_inventory';
-- expected: security_definer = true, authenticated_can_execute = true, anon_can_execute = false


-- ================= END OF CURRENT PENDING SQL =================
