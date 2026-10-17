-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- ==========================================================================================
-- ============================================================================
-- Phase 41 — Lifecycle order: capture event date + time up front
-- ---------------------------------------------------------------------------
-- Adds quotes.event_time so the event's time is captured alongside the date
-- right at the start of the lifecycle (the menu-before-quote gating is enforced
-- in the workspace UI). Kept as simple text ("18:00") — the full time-aware
-- overlap/conflict calendar remains deferred.
-- Idempotent: safe to run multiple times.
-- ============================================================================

alter table public.quotes add column if not exists event_time text;

notify pgrst, 'reload schema';

-- verify
select count(*) quotes_with_time from public.quotes where event_time is not null;
