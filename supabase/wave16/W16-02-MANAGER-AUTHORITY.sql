-- ============================================================================
-- W16-02-MANAGER-AUTHORITY.sql — product decision: Manager (Event Manager) may
-- create, settle, and close quotes. Adds 'manager' to can_create() (create) and
-- can_edit() (settlement/closure/payments gate on can_edit). Resolves the W15-002
-- can_edit/has_area divergence in favour of granting manager authority.
-- Additive, idempotent. can_delete() is NOT changed (manager still cannot delete).
-- ============================================================================
create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','manager'), false); $$;

create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid())
    in ('admin','planner','sales','operations','manager'), false); $$;
