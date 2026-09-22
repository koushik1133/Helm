-- ============================================================================
-- Phase 85 — Per-organization data export (GDPR / DPDP portability)
-- ---------------------------------------------------------------------------
-- Read-only, admin-gated, STRICTLY org-scoped export of a tenant's own data.
-- Every sub-select filters `where org_id = current_org_id()` — it is impossible
-- for this to read another tenant's rows. Returns JSON the admin can download.
--
-- SAFE BY DESIGN: read-only (no writes, no deletes), SECURITY DEFINER but the
-- org filter is re-applied on every table (phase70-77 pattern). service_role is
-- NOT used and must never be exposed to the client — an admin calls this as
-- themselves and only ever gets their own org back.
--
-- Idempotent (create or replace). Run AFTER phase56/57. Extend the SELECT list
-- as new tenant tables are added.
-- ============================================================================

create or replace function public.export_org_data()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_org is null then raise exception 'no organization context' using errcode='42501'; end if;

  return jsonb_build_object(
    'exported_at',  now(),
    'org',          (select to_jsonb(o) from public.organizations o where o.id = v_org),
    'members',      (select coalesce(jsonb_agg(to_jsonb(p) - 'id'), '[]'::jsonb)
                       from public.profiles p where p.org_id = v_org),
    'quotes',       (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
                       from public.quotes q where q.org_id = v_org),
    'leads',        (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                       from public.leads l where l.org_id = v_org),
    'invitations',  (select coalesce(jsonb_agg(to_jsonb(i) - 'token'), '[]'::jsonb)
                       from public.invitations i where i.org_id = v_org)
  );
end; $$;
revoke all on function public.export_org_data() from anon;
grant execute on function public.export_org_data() to authenticated;

notify pgrst, 'reload schema';
select 'export_org_data' t, 'ready' s;
