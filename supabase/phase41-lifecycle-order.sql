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
