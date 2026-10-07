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
