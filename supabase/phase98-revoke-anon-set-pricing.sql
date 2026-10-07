-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- ═════════════════════════════════════════════════════════════════════════════
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
