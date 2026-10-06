-- ============================================================================
-- W15-002b — remove NON-canonical edit on finance / settlement / closure
-- ============================================================================
-- FOLLOW-UP to W15-002-settlement-closure-matrix-align.sql. That APPLY step
-- canonicalized the 8 STAFF roles but did not touch other roles that already had
-- can_edit=true on these areas. Production VERIFY revealed `client` with EDIT on
-- `finance` in the template org (00000000-…001) + 2 real orgs → CHECK rows.
--
-- A client (or any non-staff role) must never hold finance/settlement/closure EDIT.
-- It is fail-closed today (the money RPCs enforce can_edit() = admin/planner/sales/
-- operations), but the matrix should not promise it, and the TEMPLATE org must be
-- clean so new studios don't inherit it.
--
-- FIX: for these 3 areas, strip EDIT from every role outside the can_edit() set.
-- Only ever REMOVES edit (tightening, never broadens). Additive + idempotent.
-- Apply on PRODUCTION (and STAGING for parity — no-op if already clean).
-- ============================================================================

-- ---- APPLY ----
update public.role_access
set can_edit = false, updated_at = now()
where area in ('finance','settlement','closure')
  and role not in ('admin','planner','sales','operations')
  and can_edit = true;

-- ---- VERIFY (expect EVERY row PASS) ----
select org_id, area,
       coalesce(string_agg(role, ',' order by role) filter (where can_edit), '') as edit_roles,
       case when coalesce(string_agg(role, ',' order by role) filter (where can_edit), '')
                 = 'admin,operations,planner,sales'
            then 'PASS — matches can_edit()' else 'CHECK' end as status
from public.role_access
where area in ('finance','settlement','closure')
group by org_id, area
order by org_id, area;

-- OPTIONAL REVIEW (not changed here): which non-staff roles can VIEW finance?
-- A client VIEWING finance may also be unwanted, but reads are RLS/ownership-scoped,
-- so that is a separate decision — surfaced, not auto-changed.
-- select org_id, area, string_agg(role, ',' order by role) filter (where can_view and role not in
--   ('admin','planner','sales','operations','manager','coordinator','supervisor','quality')) as nonstaff_viewers
-- from public.role_access where area in ('finance','settlement','closure') group by org_id, area;
