-- ============================================================================
-- phase98-revoke-anon-set-pricing.sql
-- ----------------------------------------------------------------------------
-- CORRECTIVE. Idempotent. Safe to re-run.
--
-- Wave-5 FINAL-VERIFY found that the anonymous role held EXECUTE on
-- public.set_pricing_config — a config-writing function. anon must never be able
-- to execute it (pricing changes are an authenticated/admin action). This revokes
-- EXECUTE from anon on every overload of set_pricing_config without needing its
-- exact signature. It does NOT touch the authenticated grant (admins still save
-- pricing) and mutates no data.
-- ============================================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'set_pricing_config'
  loop
    execute format('revoke execute on function %s from anon;', r.sig);
  end loop;
end $$;

-- Verify (read-only): expect zero rows.
-- select routine_name, grantee, privilege_type
--   from information_schema.role_routine_grants
--  where routine_schema='public' and routine_name='set_pricing_config' and grantee='anon';
