-- ============================================================================
-- 20-idempotency-key.sql — BRIEF CASE 2
-- "Concurrent same-idempotency-key submission -> ONE logical payment"
-- (the unique partial index on (quote_id, idempotency_key) + the RPC's
--  idempotent-replay path).
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available.
--
-- TWO INDEPENDENT GUARANTEES ARE TESTED:
--   (a) STORAGE-LEVEL: the partial unique index quote_payments_idempotency_uk on
--       (quote_id, idempotency_key) WHERE idempotency_key IS NOT NULL makes a
--       second raw insert with the same key fail with SQLSTATE 23505. This is the
--       last-resort guard that makes a true concurrent double-submit collapse to
--       one row even if two sessions both pass the RPC's replay check.
--   (b) RPC-LEVEL: public.record_payment(...,p_idempotency_key) returns the
--       EXISTING receipt with "idempotent_replay": true on a repeat key, and does
--       NOT create a second row (the happy-path, no double-charge).
--
-- THE CONCURRENT version (two sessions, same key, same instant) is in
--   supabase/tests/run-db-tests.sh (test group C2): proves exactly one row and
--   one receipt survive. Under race, one session wins the replay/insert and the
--   other either replays or hits 23505 — either way: one logical payment.
--
-- EXACT SIGNATURE (verified against supabase/HELM-STAGING-SCHEMA.sql):
--   public.record_payment(p_quote uuid, p_amount numeric, p_method text DEFAULT 'cash',
--     p_receipt_no text DEFAULT NULL, p_milestone uuid DEFAULT NULL,
--     p_note text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) RETURNS jsonb
--   SECURITY DEFINER, gated on public.can_edit() (admin/planner/sales/operations).
--
-- RUN:
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/20-idempotency-key.sql \
--     -f supabase/tests/99-teardown.sql
-- EXPECTED: all PASS notices; psql exits 0.
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on
\set Q_IDEM '''db7e57ed-0000-4000-8000-00000000c002'''
\set OA     '''db7e57ed-0000-4000-8000-00000000000a'''
\set U_PLAN '''db7e57ed-0000-4000-8000-0000000000a1'''

-- ---- PRECONDITION: the partial unique index exists -------------------------
do $$
begin
  if not exists (select 1 from pg_indexes
                 where schemaname='public' and tablename='quote_payments'
                   and indexname='quote_payments_idempotency_uk') then
    raise exception 'PRECONDITION FAILED: quote_payments_idempotency_uk index missing';
  end if;
  raise notice 'PRECONDITION ok: quote_payments_idempotency_uk present';
end $$;

-- ---- (a) storage-level: duplicate key rejected -----------------------------
-- Wrapped in a transaction + rollback so the file leaves no committed rows.
begin;
insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no, idempotency_key)
  values (:Q_IDEM, 100, 'created', :OA, 'DBT-IDEM-RAW-1', 'RAW-KEY-1');
do $$
begin
  begin
    insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no, idempotency_key)
      values ('db7e57ed-0000-4000-8000-00000000c002', 100, 'created',
              'db7e57ed-0000-4000-8000-00000000000a', 'DBT-IDEM-RAW-2', 'RAW-KEY-1');
    raise exception 'ASSERT FAILED: duplicate idempotency_key was accepted — unique index not enforcing';
  exception when unique_violation then                 -- SQLSTATE 23505
    raise notice 'PASS C2.a: duplicate (quote_id, idempotency_key) rejected with 23505';
  end;
end $$;

do $$
begin
  if (select count(*) from public.quote_payments
        where quote_id='db7e57ed-0000-4000-8000-00000000c002' and idempotency_key='RAW-KEY-1') <> 1 then
    raise exception 'ASSERT FAILED: expected exactly 1 row for RAW-KEY-1';
  end if;
  raise notice 'PASS C2.b: exactly one row persisted for the duplicated key';
end $$;
rollback;  -- leave no committed rows from the storage-level probe

-- ---- (b) RPC-level idempotent replay ---------------------------------------
-- Runs as the planner (can_edit()=true). record_payment is SECURITY DEFINER so it
-- elevates past RLS; auth.uid()/current_org_id() read the jwt-claim GUCs below.
begin;
  select set_config('request.jwt.claim.sub', 'db7e57ed-0000-4000-8000-0000000000a1', true);
  select set_config('request.jwt.claims', '{"sub":"db7e57ed-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
  set local role authenticated;

  do $$
  declare r1 jsonb; r2 jsonb; n int;
  begin
    r1 := public.record_payment('db7e57ed-0000-4000-8000-00000000c002', 300, 'cash', null, null, null, 'RPC-KEY-1');
    r2 := public.record_payment('db7e57ed-0000-4000-8000-00000000c002', 300, 'cash', null, null, null, 'RPC-KEY-1');
    select count(*) into n from public.quote_payments
      where quote_id='db7e57ed-0000-4000-8000-00000000c002' and idempotency_key='RPC-KEY-1';
    if n <> 1 then
      raise exception 'ASSERT FAILED: RPC created % rows for RPC-KEY-1 (want 1)', n;
    end if;
    if coalesce(r2->>'idempotent_replay','') <> 'true' then
      raise exception 'ASSERT FAILED: second call not flagged idempotent_replay (got %)', r2;
    end if;
    if (r1->>'receipt_no') is distinct from (r2->>'receipt_no') then
      raise exception 'ASSERT FAILED: replay returned a different receipt (% vs %)', r1->>'receipt_no', r2->>'receipt_no';
    end if;
    raise notice 'PASS C2.c: repeated key -> exactly one row';
    raise notice 'PASS C2.d: replay flagged idempotent_replay=true, same receipt %', r2->>'receipt_no';
  end $$;
rollback;  -- discard RPC side effects (booking flip, notifications); storage proof already asserted above

\echo 'CASE 2 (idempotency) complete — see run-db-tests.sh C2 for the concurrent same-key race'
