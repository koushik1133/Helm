-- ============================================================================
-- 30-overpayment-update-path.sql — BRIEF CASE 3  *** REGRESSION GUARD ***
-- "Updating amount/status/quote_id on quote_payments cannot bypass overpayment
--  controls."
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available.
--
-- *** THIS IS A REGRESSION TEST FOR A NOT-YET-APPLIED FIX. ***
-- On TODAY'S schema the overpayment trigger trg_no_overpayment fires
-- `BEFORE INSERT` ONLY (see supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql and
-- prod-fix/B2-overpayment-concurrency-lock.sql). An UPDATE that raises a paid
-- row's amount, flips a cheap row to 'paid', or re-points quote_id BYPASSES the
-- cap entirely. This file asserts the SECURE behaviour (every such UPDATE is
-- rejected with SQLSTATE 23514). Therefore:
--     * BEFORE the fix  -> these assertions FAIL (psql exits nonzero). That
--       failure is the POINT: it proves the live bypass exists.
--     * AFTER applying  supabase/harden-2026-10/H01-overpayment-update-path-and-lock.sql
--       (recreates the trigger as BEFORE INSERT OR UPDATE) -> these assertions PASS.
--
-- DEPENDS ON: HELM-STAGING-SCHEMA.sql + W16-04 (+B2). The fix under test: H01.
--
-- RUN (expect FAILURE today, SUCCESS after H01):
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/30-overpayment-update-path.sql \
--     -f supabase/tests/99-teardown.sql
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on
\set Q_UPD  '''db7e57ed-0000-4000-8000-00000000c003'''
\set Q_MAIN '''db7e57ed-0000-4000-8000-00000000c001'''
\set OA     '''db7e57ed-0000-4000-8000-00000000000a'''

-- ---- Report whether the fix is applied (informational, never fails here) ---
do $$
declare def text;
begin
  select pg_get_triggerdef(t.oid) into def from pg_trigger t
    where tgname='trg_no_overpayment' and tgrelid='public.quote_payments'::regclass;
  if def is null then
    raise notice 'NOTE: trg_no_overpayment ABSENT — neither INSERT nor UPDATE is guarded.';
  elsif def ilike '%insert or update%' or def ilike '%update%' then
    raise notice 'NOTE: UPDATE-path fix APPEARS APPLIED (H01) — these tests should PASS.';
  else
    raise notice 'NOTE: trigger is INSERT-ONLY (pre-H01) — these REGRESSION tests are EXPECTED TO FAIL, exposing the bypass.';
  end if;
end $$;

begin;
  -- seed a legitimate paid 500 on Q_UPD (total 1000) and a paid 900 on Q_MAIN
  insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
    values (:Q_UPD, 500, 'paid', :OA, 'DBT-UPD-01');
  insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
    values (:Q_MAIN, 900, 'paid', :OA, 'DBT-UPD-MAIN-01');

  -- (a) raise a paid row's amount past the cap via UPDATE
  do $$
  begin
    begin
      update public.quote_payments set amount = 5000
        where quote_id='db7e57ed-0000-4000-8000-00000000c003' and receipt_no='DBT-UPD-01';
      raise exception 'ASSERT FAILED C3.a: UPDATE amount 500->5000 bypassed the cap (regression: apply H01)';
    exception when check_violation then
      raise notice 'PASS C3.a: UPDATE raising amount past the cap rejected (23514)';
    end;
  end $$;

  -- (b) flip a cheap non-paid row to 'paid' past the cap via UPDATE
  insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
    values (:Q_UPD, 5000, 'created', :OA, 'DBT-UPD-02');
  do $$
  begin
    begin
      update public.quote_payments set status='paid'
        where quote_id='db7e57ed-0000-4000-8000-00000000c003' and receipt_no='DBT-UPD-02';
      raise exception 'ASSERT FAILED C3.b: UPDATE status created->paid (5000) bypassed the cap (regression: apply H01)';
    exception when check_violation then
      raise notice 'PASS C3.b: UPDATE flipping a 5000 row to paid rejected (23514)';
    end;
  end $$;

  -- (c) re-point an already-paid row from Q_MAIN onto Q_UPD via UPDATE quote_id.
  --     Q_UPD already has 500 paid; adding 900 -> 1400 > 1000 must be rejected.
  do $$
  begin
    begin
      update public.quote_payments set quote_id='db7e57ed-0000-4000-8000-00000000c003'
        where quote_id='db7e57ed-0000-4000-8000-00000000c001' and receipt_no='DBT-UPD-MAIN-01';
      raise exception 'ASSERT FAILED C3.c: UPDATE quote_id moved a paid 900 onto an over-full quote (regression: apply H01)';
    exception when check_violation then
      raise notice 'PASS C3.c: UPDATE re-pointing quote_id into an overpayment rejected (23514)';
    end;
  end $$;

  -- invariant must still hold on Q_UPD regardless
  do $$
  declare v numeric;
  begin
    select coalesce(sum(amount),0) into v from public.quote_payments
      where quote_id='db7e57ed-0000-4000-8000-00000000c003' and status='paid';
    if v > 1000.5 then
      raise exception 'ASSERT FAILED C3.d: paid total % on Q_UPD exceeds 1000 (cap breached via UPDATE)', v;
    end if;
    raise notice 'PASS C3.d: Q_UPD paid total % still within the 1000 cap', v;
  end $$;
rollback;

\echo 'CASE 3 (UPDATE-path overpayment) complete — regression guard for harden-2026-10/H01'
