-- ============================================================================
-- 0014_advisor_hardening.sql — clears the two legitimate Supabase Security Advisor
-- items on the canonical path. NO business-semantics change. Idempotent. Forward-only.
--
--   1) helm_schema_migrations (the migration LEDGER created by the runner) sits in the
--      public schema, so the advisor raises rls_disabled_in_public (ERROR). It holds
--      ONLY migration metadata (filename / sha256 / applied_at) — no tenant data, no
--      PII — but we enable RLS and revoke anon/authenticated so it is deny-all to the
--      API roles. No policy is added => PostgREST/anon/authenticated see nothing; the
--      owner + service_role (BYPASSRLS) keep full access for the migration runner.
--
--   2) set_updated_at() (a base-v1 trigger helper: `new.updated_at = now()`) had a
--      mutable search_path (function_search_path_mutable WARN). Pin it to '' (empty) —
--      now() resolves from pg_catalog regardless, so behavior is unchanged.
-- ============================================================================

alter table if exists public.helm_schema_migrations enable row level security;
revoke all on public.helm_schema_migrations from anon, authenticated;

do $$ begin
  if to_regprocedure('public.set_updated_at()') is not null then
    execute 'alter function public.set_updated_at() set search_path = ''''';
  end if;
end $$;

-- ---- VERIFY (read-only) -----------------------------------------------------
-- select relrowsecurity from pg_class where oid='public.helm_schema_migrations'::regclass; -- expect t
-- select proconfig from pg_proc where oid='public.set_updated_at()'::regprocedure;         -- expect {search_path=}
