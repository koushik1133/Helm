-- ============================================================================
-- 40-ledger-rls.sql — BRIEF CASE 4  (partly a REGRESSION GUARD)
-- "Direct REST/browser writes (anon + authenticated) cannot create / alter /
--  mark-paid / delete financial ledger rows outside the RPC boundary."
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available.
--
-- Reproduces the RLS negatives at the DATABASE layer by switching the session
-- role (anon / authenticated) + jwt-claim GUCs, exactly as PostgREST does. A
-- real-HTTP sibling (anon key + staff JWT) is tests/db/rest-ledger-rls.mjs .
-- Role is switched at the TOP LEVEL of each transaction (not inside DO blocks);
-- each DO block then runs AS the role that is currently set.
--
-- TWO CLASSES OF CHECK:
--  (1) GENUINE CONTROLS — must PASS on today's schema (anon / ordinary user /
--      sales-on-finance all denied).
--  (2) REGRESSION GUARDS — assert the SECURE end-state; EXPECTED TO FAIL today.
--      quote_payments is governed by RLS area 'quotes' and payment_milestones by
--      area 'finance' (generic ra ins/upd/del). So a quotes-editor (sales) can
--      today write quote_payments directly and a finance-editor (manager) can
--      mark milestones paid directly — bypassing record_payment /
--      record_settlement_payment. The fix (pending): make these two ledger tables
--      SELECT-only for anon/authenticated and force writes through the RPCs
--      (see docs/DB-TEST-SUITE.md "Case 4"). Until then group (2) FAILS — the point.
--
-- REQUIRES: a Supabase-style DB where roles `anon` and `authenticated` exist.
--
-- RUN (expect group-1 PASS, group-2 FAILURE today; all PASS after the lockdown):
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/40-ledger-rls.sql \
--     -f supabase/tests/99-teardown.sql
-- (If a group-2 assertion fails mid-run, psql stops before teardown — re-run
--  99-teardown.sql, or just re-run the whole command; fixtures are idempotent.)
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on

begin;
  -- seed a paid ledger row (as owner, RLS bypassed) for update/delete attempts
  insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
    values ('db7e57ed-0000-4000-8000-00000000c004', 100, 'paid',
            'db7e57ed-0000-4000-8000-00000000000a', 'DBT-RLS-SEED');

  -- ======================= GROUP 1 — GENUINE CONTROLS ======================
  -- ---- anon ----
  select set_config('request.jwt.claims','{"role":"anon"}', true);
  set local role anon;

  do $$  -- anon INSERT quote_payments -> blocked
  begin
    begin
      insert into public.quote_payments(quote_id, amount, status)
        values ('db7e57ed-0000-4000-8000-00000000c004', 50, 'paid');
      raise exception 'ASSERT FAILED C4.1a: anon INSERT into quote_payments SUCCEEDED';
    exception when insufficient_privilege then
      raise notice 'PASS C4.1a: anon INSERT quote_payments blocked (42501)';
    end;
  end $$;

  do $$  -- anon UPDATE / DELETE quote_payments -> 0 rows (or denied)
  declare n int; upd_blocked boolean := false; del_blocked boolean := false;
  begin
    begin
      update public.quote_payments set amount = 999 where quote_id='db7e57ed-0000-4000-8000-00000000c004';
      get diagnostics n = row_count; upd_blocked := (n = 0);
    exception when insufficient_privilege then upd_blocked := true; end;
    if not upd_blocked then raise exception 'ASSERT FAILED C4.1b: anon UPDATE changed rows'; end if;
    begin
      delete from public.quote_payments where quote_id='db7e57ed-0000-4000-8000-00000000c004';
      get diagnostics n = row_count; del_blocked := (n = 0);
    exception when insufficient_privilege then del_blocked := true; end;
    if not del_blocked then raise exception 'ASSERT FAILED C4.1c: anon DELETE removed rows'; end if;
    raise notice 'PASS C4.1b/c: anon UPDATE and DELETE on quote_payments blocked (0 rows / denied)';
  end $$;

  do $$  -- anon INSERT payment_milestones -> blocked
  begin
    begin
      insert into public.payment_milestones(quote_id, label, amount, status)
        values ('db7e57ed-0000-4000-8000-00000000c004','hack',500,'paid');
      raise exception 'ASSERT FAILED C4.1e: anon INSERT payment_milestones SUCCEEDED';
    exception when insufficient_privilege then
      raise notice 'PASS C4.1e: anon INSERT payment_milestones blocked (42501)';
    end;
  end $$;
  reset role;

  -- ---- ordinary authenticated user (role 'client', no grants) ----
  select set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a4', true);
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a4","role":"authenticated"}', true);
  set local role authenticated;
  do $$  -- client INSERT quote_payments -> blocked
  begin
    begin
      insert into public.quote_payments(quote_id, amount, status)
        values ('db7e57ed-0000-4000-8000-00000000c004', 50, 'paid');
      raise exception 'ASSERT FAILED C4.1d: ordinary user INSERT into quote_payments SUCCEEDED';
    exception when insufficient_privilege then
      raise notice 'PASS C4.1d: ordinary user (client) INSERT quote_payments blocked (42501)';
    end;
  end $$;
  reset role;

  -- ---- sales (finance EDIT = false) cannot write payment_milestones ----
  select set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a2', true);
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  set local role authenticated;
  do $$
  begin
    begin
      insert into public.payment_milestones(quote_id, label, amount, status)
        values ('db7e57ed-0000-4000-8000-00000000c004','hack',500,'paid');
      raise exception 'ASSERT FAILED C4.1f: sales INSERT payment_milestones SUCCEEDED (finance edit should be denied)';
    exception when insufficient_privilege then
      raise notice 'PASS C4.1f: sales INSERT payment_milestones blocked (no finance edit, 42501)';
    end;
  end $$;
  reset role;

  -- ==================== GROUP 2 — REGRESSION GUARDS (fail today) ============
  -- Assert the SECURE end-state (ledger writable ONLY via the RPCs). On today's
  -- schema the direct staff writes SUCCEED, so each assertion fires a REGRESSION.
  -- ---- sales direct INSERT into quote_payments (area 'quotes' edit) ----
  select set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a2', true);
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  set local role authenticated;
  do $$
  begin
    begin
      insert into public.quote_payments(quote_id, amount, status, receipt_no)
        values ('db7e57ed-0000-4000-8000-00000000c004', 50, 'paid', 'DBT-RLS-SALES');
      raise exception 'REGRESSION C4.2a: sales INSERTED a ledger row directly (bypassed record_payment). Lock quote_payments to the RPC boundary.';
    exception when insufficient_privilege then
      raise notice 'PASS C4.2a: sales direct INSERT quote_payments blocked (RPC-only boundary enforced)';
    end;
  end $$;

  do $$  -- sales direct UPDATE of the seeded ledger row -> should affect 0 rows
  declare n int;
  begin
    update public.quote_payments set amount = 1
      where quote_id='db7e57ed-0000-4000-8000-00000000c004' and receipt_no='DBT-RLS-SEED';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'REGRESSION C4.2b: sales UPDATED % ledger rows directly. Lock quote_payments to the RPC boundary.', n;
    end if;
    raise notice 'PASS C4.2b: sales direct UPDATE quote_payments affected 0 rows';
  end $$;
  reset role;

  -- ---- manager direct "mark paid" on payment_milestones (finance edit) ----
  select set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a3', true);
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
  set local role authenticated;
  do $$
  declare n int;
  begin
    update public.payment_milestones set status='paid', paid_at=now()
      where id='db7e57ed-0000-4000-8000-00000000d001';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'REGRESSION C4.2c: manager marked % milestone(s) paid directly (bypassed record_settlement_payment). Lock payment_milestones to the RPC boundary.', n;
    end if;
    raise notice 'PASS C4.2c: manager direct milestone mark-paid affected 0 rows';
  end $$;
  reset role;
rollback;

\echo 'CASE 4 (ledger RLS) complete — group 1 are genuine controls; group 2 are regression guards for the RPC-boundary lockdown'
