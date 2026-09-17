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
