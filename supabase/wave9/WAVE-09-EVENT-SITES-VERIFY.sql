-- ============================================================================
-- WAVE-09-EVENT-SITES-VERIFY.sql   (READ-ONLY — run in STAGING after UPGRADE)
-- ----------------------------------------------------------------------------
-- Confirms all 4 event_sites policies now target `authenticated` (and NOT
-- public/anon) while keeping identical names, commands and predicates.
-- Single-result PASS/FAIL. Changes nothing.
-- ============================================================================
with p as (
  select policyname, cmd, roles::text[] as roles, qual, with_check
  from pg_policies
  where schemaname='public' and tablename='event_sites'
)
select
  case when (
    (select count(*) from p) = 4
    and (select bool_and(roles = array['authenticated']) from p)          -- ONLY authenticated
    and not (select bool_or('public' = any(roles) or 'anon' = any(roles)) from p)
    and exists (select 1 from p where policyname='event_sites_select' and cmd='SELECT'
                and qual like '%has_area(''quotes''::text, ''view''::text)%' and qual like '%current_org_id()%')
    and exists (select 1 from p where policyname='event_sites_insert' and cmd='INSERT'
                and with_check like '%has_area(''quotes''::text, ''edit''::text)%')
    and exists (select 1 from p where policyname='event_sites_update' and cmd='UPDATE'
                and qual like '%''edit''%' and with_check like '%''edit''%')
    and exists (select 1 from p where policyname='event_sites_delete' and cmd='DELETE'
                and qual like '%''edit''%')
    and (select relrowsecurity from pg_class where oid='public.event_sites'::regclass)  -- RLS still on
  ) then 'PASS — event_sites re-scoped to authenticated; predicates + names + RLS intact'
       else 'FAIL — re-scope incomplete; run ROLLBACK and re-check'
  end as verify_result,
  (select array_agg(policyname||'='||array_to_string(roles,',') order by policyname) from p) as policy_roles;
