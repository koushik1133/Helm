-- ============================================================================
-- W15-002 — close the can_edit()/has_area() divergence on settlement & closure
-- ============================================================================
-- FINDING (WAVE-15B): settlement/closure WRITES are enforced by the legacy
-- can_edit() = {admin, planner, sales, operations} (RLS on expense_claims/
-- event_closure/event_ratings + RPCs set_closure/close_event/record_payment/
-- mark_paid). The data-driven RBAC matrix (has_area), shown in Control Center and
-- used by other feature RLS, could show manager/coordinator as "edit" on these
-- areas — but the RPCs then deny them (HTTP 42501). The divergence is FAIL-CLOSED
-- (over-restriction, never an exposure); the harm is a false promise in the UI.
--
-- PRODUCT DECISION (2026-10-01): KEEP settlement/closure edit = {admin, planner,
-- sales, operations}; manager/coordinator stay VIEW-ONLY (no behavior change).
--
-- FIX (this file): canonicalize the role_access matrix for the finance group
-- (finance, settlement, closure) to EXACTLY match can_edit(), for every org, so
-- has_area() and can_edit() AGREE. Control Center will then correctly show
-- manager/coordinator as view-only on these areas — no contradictory promise.
-- Enforcement is unchanged (still can_edit()); this only makes the matrix honest.
--
-- SAFE: additive + idempotent (upsert on the (org_id,role,area) PK). Only touches
-- the 3 finance-group areas for 8 roles; leaves every other area/role untouched.
-- No money/closure RPC bodies changed → no lockout, no payment-flow regression.
-- Apply on STAGING first, verify, then PRODUCTION.
--
-- NOTE (follow-up, NOT done here): if you later want the MATRIX to be the true
-- authority (so a Control-Center toggle actually grants manager settlement/closure
-- edit), that requires switching the RLS policies AND the RPCs
-- (set_closure/close_event + the shared record_payment/mark_paid) from can_edit()
-- to has_area(...) — a larger, test-gated change. This file deliberately does the
-- conservative, zero-risk close that matches the "keep view-only" decision.
-- ============================================================================

-- ---- PRECHECK (read-only): current edit grants on the finance-group areas ----
select org_id, area,
       coalesce(string_agg(role, ', ' order by role) filter (where can_edit), '(none)') as edit_roles
from public.role_access
where area in ('finance','settlement','closure')
group by org_id, area
order by org_id, area;

-- ---- APPLY: canonicalize the matrix to match can_edit() for every org ----
insert into public.role_access (org_id, role, area, can_view, can_edit)
select o.id, g.role, a.area, true /* can_view */, g.can_edit
from public.organizations o
cross join (values
  -- EDIT roles = can_edit() set
  ('admin', true), ('planner', true), ('sales', true), ('operations', true),
  -- VIEW-ONLY roles (can open the page, cannot write) — preserves today's behavior
  ('manager', false), ('coordinator', false), ('supervisor', false), ('quality', false)
) as g(role, can_edit)
cross join (values ('finance'), ('settlement'), ('closure')) as a(area)
on conflict (org_id, role, area) do update
  set can_view = excluded.can_view,
      can_edit = excluded.can_edit,
      updated_at = now();

-- ---- VERIFY (run last) — per org, edit set MUST equal exactly the can_edit() set ----
select org_id, area,
       string_agg(role, ',' order by role) filter (where can_edit) as edit_roles,
       case when string_agg(role, ',' order by role) filter (where can_edit)
                 = 'admin,operations,planner,sales'
            then 'PASS — matches can_edit()' else 'CHECK' end as status
from public.role_access
where area in ('finance','settlement','closure')
group by org_id, area
order by org_id, area;

-- Expected: every row PASS (edit_roles = admin,operations,planner,sales), and
-- manager/coordinator appear only as view (can_edit=false) → no divergence.
