-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
begin;
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- a156guard txn: the refusal above runs INSIDE a transaction, so under psql -f without ON_ERROR_STOP
-- every later statement fails too ("current transaction is aborted") and nothing is applied.
-- ==========================================================================================
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

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
