-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
begin;
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- a156guard txn: the refusal above runs INSIDE a transaction, so under psql -f without ON_ERROR_STOP
-- every later statement fails too ("current transaction is aborted") and nothing is applied.
-- ═════════════════════════════════════════════════════════════════════════════
-- ============================================================================
-- Phase 91 — Studio location (onboarding)
-- ---------------------------------------------------------------------------
-- Adds an optional free-text location (city, country) captured during
-- onboarding and editable later in Control Center. Additive, idempotent,
-- non-destructive. No RLS change (organizations RLS already org-scopes rows).
-- ============================================================================
alter table public.organizations add column if not exists location text;

notify pgrst, 'reload schema';
select 'phase91 studio-location' t, 'ready' s;

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
