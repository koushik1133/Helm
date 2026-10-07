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
-- =========================================================================
-- PHASE 18 — Teardown & returns  [Block D]
-- Idempotent. Depends on: phase14-logistics.sql (event_checklist),
--   phase7-inventory.sql (returns), phase9-vendors.sql (vendor exit).
-- Teardown reuses what's already there: inventory reservations go to
-- 'returned' (freeing/adjusting stock) and vendor bookings go to 'delivered'.
-- The only schema change is allowing a 'teardown' section on the checklist.
-- =========================================================================

alter table public.event_checklist drop constraint if exists event_checklist_section_check;
alter table public.event_checklist
  add constraint event_checklist_section_check
  check (section in ('logistics','compliance','comms','guests','teardown'));
