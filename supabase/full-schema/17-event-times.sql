-- =========================================================================
-- PHASE 10b — Event times (makes the calendar's conflict check time-aware)
-- Idempotent. Depends on: phase10-calendar.sql (quotes.event_date).
-- A clash is now "same resource AND the time windows overlap" — a morning
-- event and an evening event on the same day no longer clash. Events with no
-- times are simply not time-clashed (per the chosen rule).
-- =========================================================================
alter table public.quotes add column if not exists start_time time;
alter table public.quotes add column if not exists end_time   time;
