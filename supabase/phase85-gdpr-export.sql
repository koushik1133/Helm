-- ============================================================================
-- Phase 85 — GDPR / DPDP: per-organization data export package
-- ---------------------------------------------------------------------------
-- Read-only, org-scoped export of a tenant's OWN data as one JSON block, for
-- data-portability / subject-access requests. Gated on has_area('users','view').
--
-- STRICT ISOLATION: context is resolved via public.current_org_id() and EVERY
-- sub-select filters `where org_id = v_org`. It is structurally impossible for
-- this to read another tenant's rows. Read-only — no writes, no deletes. It is
-- SECURITY DEFINER only so it can assemble the package in one call; the org
-- filter is re-applied on every table (the audited phase70-77 pattern).
-- service_role is NOT used and must never reach the client.
--
-- Idempotent (create or replace). Run AFTER phase56/57, phase83 (invitations),
-- phase84 (event_attendees).
-- ============================================================================

create or replace function public.export_tenant_organization_package()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_org uuid := public.current_org_id();
begin
  -- resolve + authorize
  if v_org is null then
    raise exception 'no organization context' using errcode = '42501';
  end if;
  if not public.has_area('users', 'view') then
    raise exception 'not authorized to export organization data' using errcode = '42501';
  end if;

  -- consolidate this org's rows only (token stripped from invitations; profile pk kept minimal)
  return jsonb_build_object(
    'exported_at',     now(),
    'org_id',          v_org,
    'organizations',   (select to_jsonb(o) from public.organizations o where o.id = v_org),
    'profiles',        (select coalesce(jsonb_agg(to_jsonb(p) - 'id'), '[]'::jsonb)
                          from public.profiles p where p.org_id = v_org),
    'quotes',          (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
                          from public.quotes q where q.org_id = v_org),
    'event_attendees', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                          from public.event_attendees a where a.org_id = v_org),
    'invitations',     (select coalesce(jsonb_agg(to_jsonb(i) - 'token'), '[]'::jsonb)
                          from public.invitations i where i.org_id = v_org)
  );
end; $$;
revoke all on function public.export_tenant_organization_package() from anon;
grant execute on function public.export_tenant_organization_package() to authenticated;

notify pgrst, 'reload schema';
select 'export_tenant_organization_package' t, 'ready' s;
