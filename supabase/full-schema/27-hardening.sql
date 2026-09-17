-- =========================================================================
-- Phase 21 — Hardening: role-based READ access + atomic inventory adjust
--
-- WHY: until now every feature table read as `using (true)` for any signed-in
-- user, so a crew or client account could read finances, leads, proposals, etc.
-- This pins READ access to the role, matching the app's VIEW_SCOPE:
--   finance/pipeline  -> admin, planner, sales           (can_view_finance)
--   ops/resources     -> admin, planner, sales, operations (can_view_ops)
--   crew / client     -> no internal tables (they use token flows only)
--
-- Idempotent: re-running drops & recreates the policies each time. Safe to run
-- after all earlier phase SQL. Token/worker/approval flows are unaffected —
-- they go through SECURITY DEFINER RPCs which bypass RLS.
-- =========================================================================

-- 1) role helpers ---------------------------------------------------------
create or replace function public.can_view_finance() returns boolean
  language sql stable set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales'), false);
$$;
create or replace function public.can_view_ops() returns boolean
  language sql stable set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false);
$$;

-- 2) atomic inventory total adjust (avoids a lost update on concurrent teardown returns)
create or replace function public.adjust_inventory_total(p_item_id uuid, p_delta numeric)
  returns public.inventory_items language plpgsql security definer set search_path = public as $$
declare row public.inventory_items;
begin
  if not public.can_edit() then raise exception 'not allowed'; end if;
  update public.inventory_items
     set total_qty = greatest(0, coalesce(total_qty,0) + coalesce(p_delta,0))
   where id = p_item_id
   returning * into row;
  return row;
end; $$;
revoke all on function public.adjust_inventory_total(uuid, numeric) from anon;
grant execute on function public.adjust_inventory_total(uuid, numeric) to authenticated;

-- 3) re-scope RLS read policies by role -----------------------------------
do $$
declare
  -- finance + client pipeline: admin / planner / sales only
  fin  text[] := array['event_costs','change_requests','payment_milestones','expense_claims',
                       'event_closure','event_ratings','quote_payments','quote_consents',
                       'leads','lead_archive','event_discovery','event_requirements',
                       'event_proposal','proposal_risks'];
  -- operational data: + operations. writes stay on can_edit()
  opsd text[] := array['event_resource_needs','event_resources','inventory_items','inventory_reservations',
                       'run_sheet_items','event_plan','event_checklist','event_day','event_issues',
                       'crew_members','vendors','event_tasks','task_templates',
                       'work_tokens','notifications'];   -- worker links + comms carry PII / access — hide from crew/client
  -- quote core: read = ops; keep create/edit/delete split (operations can edit but not create/delete)
  core text[] := array['quotes','quote_versions','layouts'];
  t text; p record;
begin
  foreach t in array fin loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_finance() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_view_finance() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_view_finance() )', t);
  end loop;

  foreach t in array opsd loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_ops() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_edit() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_edit() )', t);
  end loop;

  foreach t in array core loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_ops() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_create() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_delete() )', t);
  end loop;
end $$;

-- 4) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';
