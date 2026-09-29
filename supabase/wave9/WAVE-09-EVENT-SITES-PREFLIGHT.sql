-- ============================================================================
-- WAVE-09-EVENT-SITES-PREFLIGHT.sql   (READ-ONLY — run in STAGING first)
-- ----------------------------------------------------------------------------
-- Confirms the STAGING baseline matches production BEFORE re-scoping:
-- event_sites must currently have exactly 4 policies, all granted to `public`,
-- with the org-scoped has_area(...) predicates. Single-result PASS/FAIL.
-- Changes nothing. Do NOT run against production.
-- ============================================================================
with p as (
  select policyname, cmd, roles::text[] as roles, qual, with_check
  from pg_policies
  where schemaname='public' and tablename='event_sites'
)
select
  case when (
    (select count(*) from p) = 4
    and (select bool_and('public' = any(roles)) from p)
    and exists (select 1 from p where policyname='event_sites_select' and cmd='SELECT'
                and qual like '%has_area(''quotes''::text, ''view''::text)%'
                and qual like '%current_org_id()%')
    and exists (select 1 from p where policyname='event_sites_insert' and cmd='INSERT'
                and with_check like '%has_area(''quotes''::text, ''edit''::text)%')
    and exists (select 1 from p where policyname='event_sites_update' and cmd='UPDATE'
                and qual like '%''edit''%' and with_check like '%''edit''%')
    and exists (select 1 from p where policyname='event_sites_delete' and cmd='DELETE'
                and qual like '%''edit''%')
  ) then 'PASS — baseline is 4 event_sites policies on role public; safe to run UPGRADE'
       else 'FAIL — baseline does not match; STOP and investigate before UPGRADE'
  end as preflight_result,
  (select count(*) from p) as policy_count,
  (select array_agg(policyname order by policyname) from p) as policies,
  (select array_agg(distinct r) from p, unnest(p.roles) r) as roles_seen;
