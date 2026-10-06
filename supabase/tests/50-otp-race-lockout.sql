-- ============================================================================
-- 50-otp-race-lockout.sql — BRIEF CASE 5
-- "OTP race: only one concurrent verify succeeds; invalid attempts persist;
--  expiry + lockout work."
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available.
--
-- Deterministic (single-session) OTP behaviour is here. The CONCURRENT verify
-- race ("only one of two simultaneous correct verifications is approved") is in
-- supabase/tests/run-db-tests.sh (test group C5).
--
-- REGRESSION NOTES (two pending fixes in supabase/harden-2026-10 / prod-fix):
--   * "invalid attempts persist" is a REGRESSION GUARD for the C2b lockout fix
--     (prod-fix/C2b-PROD-otp-lockout.sql). The pre-fix verify_and_consent RAISES
--     on a wrong code, which ROLLS BACK the attempts++ — so the counter never
--     climbs and the 5-try lockout never trips. Test C5.a asserts the increment
--     PERSISTS; it FAILS on the pre-C2b body and PASSES once C2b is applied.
--   * "only one concurrent verify succeeds" (run-db-tests.sh C5) is a guard for
--     harden-2026-10/H02-otp-verify-row-lock.sql (SELECT ... FOR UPDATE on the
--     active OTP row). Without H02 two concurrent correct verifies can BOTH set
--     verified_at and BOTH insert a consent row.
--
-- EXACT SIGNATURE (verified against supabase/HELM-STAGING-SCHEMA.sql):
--   public.verify_and_consent(p_token uuid, p_phone text, p_code text,
--     p_agreed boolean, p_terms_version text, p_consent_text text,
--     p_client_name text, p_user_agent text) RETURNS jsonb  (SECURITY DEFINER)
-- Codes are stored HASHED (extensions.crypt(code, gen_salt('bf'))).
--
-- RUN:
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/50-otp-race-lockout.sql \
--     -f supabase/tests/99-teardown.sql
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on
\set Q_OTP '''db7e57ed-0000-4000-8000-00000000c005'''
\set T_OTP '''db7e57ed-0000-4000-8000-00000000ef01'''
\set OA    '''db7e57ed-0000-4000-8000-00000000000a'''

-- Report which verify_and_consent body is live (informational).
do $$
declare def text;
begin
  select pg_get_functiondef(oid) into def from pg_proc
    where proname='verify_and_consent' and pronamespace='public'::regnamespace;
  if def ilike '%raise exception ''incorrect code''%' then
    raise notice 'NOTE: pre-C2b verify_and_consent (RAISES on wrong code) — C5.a EXPECTED TO FAIL (attempts roll back).';
  else
    raise notice 'NOTE: C2b-fixed verify_and_consent (returns on wrong code) detected.';
  end if;
  if def ilike '%for update%' then
    raise notice 'NOTE: H02 row-lock present — run-db-tests.sh C5 race should PASS.';
  else
    raise notice 'NOTE: H02 row-lock ABSENT — run-db-tests.sh C5 race EXPECTED TO FAIL (two verifies may both approve).';
  end if;
end $$;

-- ---- C5.a — a wrong attempt must PERSIST (regression guard for C2b) ---------
begin;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (:Q_OTP, '9990001234', extensions.crypt('123456', extensions.gen_salt('bf')),
            now() + interval '10 min', :OA);
  do $$
  declare status text; n int;
  begin
    begin
      perform public.verify_and_consent('db7e57ed-0000-4000-8000-00000000ef01'::uuid,
        '9990001234', '000000', true, 'v1', 'terms', 'Tester', 'ua');
      status := 'returned';            -- C2b body returns instead of raising
    exception when others then
      status := 'raised';              -- pre-C2b body raises (rolls back attempts++)
    end;
    select attempts into n from public.quote_otps where quote_id='db7e57ed-0000-4000-8000-00000000c005' and phone='9990001234';
    if coalesce(n,0) < 1 then
      raise exception 'REGRESSION C5.a: wrong-code attempts did NOT persist (attempts=%, body %). Apply C2b.', coalesce(n,0), status;
    end if;
    raise notice 'PASS C5.a: wrong-code attempt persisted (attempts=%)', n;
  end $$;
rollback;

-- ---- C5.b — 5 failed attempts lock the code out ----------------------------
begin;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id, attempts)
    values (:Q_OTP, '9990005555', extensions.crypt('123456', extensions.gen_salt('bf')),
            now() + interval '10 min', :OA, 5);     -- already at the lockout threshold
  do $$
  declare res jsonb; approved boolean := false; locked boolean := false;
  begin
    begin
      res := public.verify_and_consent('db7e57ed-0000-4000-8000-00000000ef01'::uuid,
        '9990005555', '123456', true, 'v1', 'terms', 'Tester', 'ua');   -- CORRECT code, but locked
      approved := coalesce(res->>'approved','')='true';
      locked   := coalesce(res->>'error','')='locked';
    exception when others then
      locked := (SQLERRM ilike '%too many attempts%');   -- pre-C2b raises this
    end;
    if approved then
      raise exception 'ASSERT FAILED C5.b: a correct code was APPROVED despite 5 prior attempts (lockout broken)';
    end if;
    if not locked then
      raise exception 'ASSERT FAILED C5.b: expected a lockout refusal, got %', coalesce(res::text,'(raised, non-lockout)');
    end if;
    raise notice 'PASS C5.b: locked code refused even with the correct value';
  end $$;
rollback;

-- ---- C5.c — an expired code is not active ----------------------------------
begin;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (:Q_OTP, '9990009999', extensions.crypt('123456', extensions.gen_salt('bf')),
            now() - interval '1 min', :OA);        -- already expired
  do $$
  declare res jsonb; approved boolean := false; refused boolean := false;
  begin
    begin
      res := public.verify_and_consent('db7e57ed-0000-4000-8000-00000000ef01'::uuid,
        '9990009999', '123456', true, 'v1', 'terms', 'Tester', 'ua');
      approved := coalesce(res->>'approved','')='true';
      refused  := coalesce(res->>'error','')='no_active_code';
    exception when others then
      refused := (SQLERRM ilike '%no active code%');
    end;
    if approved then raise exception 'ASSERT FAILED C5.c: an EXPIRED code was approved'; end if;
    if not refused then raise exception 'ASSERT FAILED C5.c: expected no-active-code refusal, got %', coalesce(res::text,'(raised)'); end if;
    raise notice 'PASS C5.c: expired code treated as inactive';
  end $$;
rollback;

-- ---- C5.d — correct code approves, then is single-use ----------------------
begin;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (:Q_OTP, '9990007777', extensions.crypt('123456', extensions.gen_salt('bf')),
            now() + interval '10 min', :OA);
  do $$
  declare res jsonb; n int;
  begin
    res := public.verify_and_consent('db7e57ed-0000-4000-8000-00000000ef01'::uuid,
      '9990007777', '123456', true, 'v1', 'terms', 'Tester', 'ua');
    if coalesce(res->>'approved','') <> 'true' then
      raise exception 'ASSERT FAILED C5.d: correct code + agreed was not approved (got %)', res;
    end if;
    select count(*) into n from public.quote_consents
      where quote_id='db7e57ed-0000-4000-8000-00000000c005' and phone='9990007777';
    if n <> 1 then raise exception 'ASSERT FAILED C5.d: expected exactly 1 consent row, got %', n; end if;
    if (select approval_status from public.quotes where id='db7e57ed-0000-4000-8000-00000000c005') <> 'approved' then
      raise exception 'ASSERT FAILED C5.d: quote not marked approved';
    end if;
    raise notice 'PASS C5.d: correct code approved + 1 consent row + quote approved';

    -- single-use: a second verify with the same (now consumed) code is refused
    declare approved2 boolean := false;
    begin
      res := public.verify_and_consent('db7e57ed-0000-4000-8000-00000000ef01'::uuid,
        '9990007777', '123456', true, 'v1', 'terms', 'Tester', 'ua');
      approved2 := coalesce(res->>'approved','')='true';
    exception when others then
      approved2 := false;   -- pre-C2b body raises 'no active code' -> still refused
    end;
    if approved2 then
      raise exception 'ASSERT FAILED C5.e: the code was reusable after a successful verify';
    end if;
    raise notice 'PASS C5.e: consumed code cannot be reused (single-use)';
  end $$;
rollback;

\echo 'CASE 5 (OTP lockout/expiry/single-use) complete — see run-db-tests.sh C5 for the concurrent-verify race'
