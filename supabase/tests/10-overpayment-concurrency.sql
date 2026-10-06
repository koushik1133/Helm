-- ============================================================================
-- 10-overpayment-concurrency.sql — BRIEF CASE 1
-- "Two independent sessions post payments concurrently against the SAME quote ->
--  one succeeds, the other is rejected (or idempotently resolved); the paid total
--  never exceeds the quote total."
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available; no output
--         in this repo is real. Author it, read it, run it yourself on staging.
--
-- WHAT THIS FILE COVERS (deterministic, single session): the CAP invariant that
--   the concurrency test must preserve — sum(paid quote_payments) + sum(paid
--   payment_milestones) <= (pricing->>'total') + 0.5. It inserts up to the cap,
--   then proves the next paid row is rejected with SQLSTATE 23514, and that the
--   stored paid total never exceeds the quote total.
--
-- THE ACTUAL TWO-SESSION RACE lives in supabase/tests/run-db-tests.sh
--   (test group C1): two genuinely separate psql sessions each BEGIN, insert a
--   'paid' row for Q_MAIN, pg_sleep to interleave, then COMMIT. Expectation:
--   exactly ONE commits; the other aborts with 23514; final sum(paid) <= total.
--   That race only holds when the per-quote lock (prod-fix/B2 or harden-2026-10/H01)
--   is applied. See the PRECONDITION probe below.
--
-- DEPENDS ON (must be applied to the test DB first, in this order):
--   supabase/HELM-STAGING-SCHEMA.sql
--   supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql   (adds trg_no_overpayment)
--   supabase/prod-fix/B2-overpayment-concurrency-lock.sql  (adds per-quote lock)
--   [optionally] supabase/harden-2026-10/H01-overpayment-update-path-and-lock.sql
--
-- RUN:
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/10-overpayment-concurrency.sql \
--     -f supabase/tests/99-teardown.sql
-- EXPECTED: every PASS notice prints; psql exits 0. Any ASSERT FAILED aborts
--   with a nonzero exit (that is a real finding, not a harness bug).
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on
\set Q_MAIN '''db7e57ed-0000-4000-8000-00000000c001'''
\set OA     '''db7e57ed-0000-4000-8000-00000000000a'''

-- ---- PRECONDITION: the overpayment guard must exist, else the invariant is
--      entirely unenforced (that itself is a failing security posture). -------
do $$
begin
  if not exists (select 1 from pg_trigger
                 where tgname='trg_no_overpayment' and tgrelid='public.quote_payments'::regclass) then
    raise exception 'PRECONDITION FAILED: trg_no_overpayment missing on quote_payments — apply W16-04 (+B2). Overpayment is NOT enforced.';
  end if;
  raise notice 'PRECONDITION ok: trg_no_overpayment present';
  if pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) not ilike '%pg_advisory_xact_lock%' then
    raise notice 'NOTE: enforce_no_overpayment() has NO per-quote lock (B2/H01 not applied) — the two-session race in run-db-tests.sh (C1) is EXPECTED TO FAIL here until B2 is applied.';
  else
    raise notice 'PRECONDITION ok: enforce_no_overpayment() takes a per-quote lock';
  end if;
end $$;

-- ---- CAP invariant (single session; RLS bypassed as table owner) -----------
-- Wrapped in one transaction + rollback so the file leaves NO committed rows
-- (lets run-db-tests.sh reuse Q_MAIN for the concurrency phase).
begin;
-- Q_MAIN total = 1000. First paid 800 fits.
insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
  values (:Q_MAIN, 800, 'paid', :OA, 'DBT-MAIN-01');

do $$
begin
  if (select coalesce(sum(amount),0) from public.quote_payments
        where quote_id = 'db7e57ed-0000-4000-8000-00000000c001' and status='paid') <> 800 then
    raise exception 'ASSERT FAILED: first paid 800 did not land';
  end if;
  raise notice 'PASS C1.a: first paid 800 of 1000 accepted';
end $$;

-- Second paid 800 would reach 1600 > 1000.5 -> must be rejected (23514).
do $$
begin
  begin
    insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
      values ('db7e57ed-0000-4000-8000-00000000c001', 800, 'paid',
              'db7e57ed-0000-4000-8000-00000000000a', 'DBT-MAIN-02');
    raise exception 'ASSERT FAILED: overpayment (800+800 > 1000) was ACCEPTED — cap not enforced';
  exception
    when check_violation then                         -- SQLSTATE 23514
      raise notice 'PASS C1.b: overshoot rejected with 23514 (check_violation)';
  end;
end $$;

-- Paid total must never exceed the quote total.
do $$
declare v_paid numeric; v_total numeric := 1000;
begin
  select coalesce(sum(amount),0) into v_paid from public.quote_payments
    where quote_id='db7e57ed-0000-4000-8000-00000000c001' and status='paid';
  if v_paid > v_total + 0.5 then
    raise exception 'ASSERT FAILED: stored paid total % exceeds quote total %', v_paid, v_total;
  end if;
  raise notice 'PASS C1.c: stored paid total % <= quote total % (invariant held)', v_paid, v_total;
end $$;

-- A payment that exactly fills the remaining 200 is allowed.
insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
  values (:Q_MAIN, 200, 'paid', :OA, 'DBT-MAIN-03');
do $$
begin
  if (select coalesce(sum(amount),0) from public.quote_payments
        where quote_id='db7e57ed-0000-4000-8000-00000000c001' and status='paid') <> 1000 then
    raise exception 'ASSERT FAILED: exact-fill to 1000 did not land';
  end if;
  raise notice 'PASS C1.d: exact fill to the cap (1000) accepted';
end $$;
rollback;  -- leave no committed rows

\echo 'CASE 1 (overpayment cap, single session) complete — see run-db-tests.sh C1 for the real two-session race'
