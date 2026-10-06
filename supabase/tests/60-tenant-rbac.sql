-- ============================================================================
-- 60-tenant-rbac.sql — BRIEF CASE 6
-- "Tenant-isolation / RBAC negative tests across orgs and the roles: anonymous,
--  ordinary authenticated user, finance editor, quote editor, admin."
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB creds were available.
--
-- ROLE MAPPING in this product (10 roles; see supabase/phase29-role-access.sql):
--   anonymous                -> anon (no JWT)
--   ordinary auth user       -> role 'client'  (no area grants)
--   finance editor           -> role 'manager' (finance EDIT granted in matrix)
--   quote editor             -> role 'sales'   (quotes EDIT granted in matrix)
--   admin                    -> role 'admin'   (bypasses the matrix)
--   NB: there is no finance-EXCLUSIVE role; 'manager' is the closest finance
--       editor. Crucially the money RPCs gate on public.can_edit() =
--       role in (admin,planner,sales,operations) — which EXCLUDES 'manager'.
--       So the "finance editor" (manager) is DENIED by the payment RPCs even
--       though the matrix grants finance edit (the W15-002 divergence). These
--       tests assert that real, current behaviour.
--
-- Org scoping is public.current_org_id() (= profiles.org_id for auth.uid()); the
-- money RPCs also call public.assert_quote_org() which raises 42501 cross-org.
--
-- RUN:
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/60-tenant-rbac.sql \
--     -f supabase/tests/99-teardown.sql
-- EXPECTED: all PASS notices; psql exits 0. (These assert TODAY's behaviour; none
--   are pending-fix regression guards.)
-- ============================================================================
\if :{?HELM_TEST_ACK}
\else
\echo '*** pass -v HELM_TEST_ACK=1 to confirm NON-PRODUCTION ***'
\quit
\endif
\set ON_ERROR_STOP on
\set Q_MAIN '''db7e57ed-0000-4000-8000-00000000c001'''
\set Q_B    '''db7e57ed-0000-4000-8000-00000000c0b1'''

-- helper jwt-claim snippets per user id
\set CL_CLIENT '''{"sub":"db7e57ed-0000-4000-8000-0000000000a4","role":"authenticated"}'''
\set CL_MGR    '''{"sub":"db7e57ed-0000-4000-8000-0000000000a3","role":"authenticated"}'''
\set CL_SALES  '''{"sub":"db7e57ed-0000-4000-8000-0000000000a2","role":"authenticated"}'''
\set CL_ADMIN  '''{"sub":"db7e57ed-0000-4000-8000-0000000000a0","role":"authenticated"}'''
\set CL_BADMIN '''{"sub":"db7e57ed-0000-4000-8000-0000000000b0","role":"authenticated"}'''

-- ================= has_area() spot checks (matrix sanity) ===================
do $$
begin
  perform set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a2', true);  -- sales
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  if public.has_area('quotes','edit') is not true then raise exception 'ASSERT FAILED: sales should have quotes edit'; end if;
  if public.has_area('finance','edit') is not false then raise exception 'ASSERT FAILED: sales should NOT have finance edit'; end if;
  raise notice 'PASS C6.0a: sales = quotes:edit, finance:view-only';

  perform set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a3', true);  -- manager
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
  if public.has_area('finance','edit') is not true then raise exception 'ASSERT FAILED: manager should have finance edit'; end if;
  if public.can_edit() is not false then raise exception 'ASSERT FAILED: manager can_edit() should be false (RPC gate excludes manager)'; end if;
  raise notice 'PASS C6.0b: manager = finance:edit but can_edit()=false (RPC-gate divergence)';

  perform set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000a4', true);  -- client
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a4","role":"authenticated"}', true);
  if public.has_area('quotes','view') is not false then raise exception 'ASSERT FAILED: client should have no quotes view'; end if;
  raise notice 'PASS C6.0c: client = no area access';
end $$;

-- ================= RBAC: who may call the money RPCs ========================
-- ordinary user (client) -> record_payment denied (can_edit=false)
do $$
begin
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a4","role":"authenticated"}', true);
  begin
    perform public.record_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, null);
    raise exception 'ASSERT FAILED C6.1: client was allowed to record_payment';
  exception when insufficient_privilege then
    raise notice 'PASS C6.1: client record_payment denied (42501 not authorized)';
  end;
end $$;

-- finance editor (manager) -> record_payment AND record_settlement_payment denied
do $$
begin
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
  begin
    perform public.record_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, null);
    raise exception 'ASSERT FAILED C6.2a: manager was allowed to record_payment (can_edit excludes manager)';
  exception when insufficient_privilege then
    raise notice 'PASS C6.2a: manager record_payment denied (42501)';
  end;
  begin
    perform public.record_settlement_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, null);
    raise exception 'ASSERT FAILED C6.2b: manager was allowed to record_settlement_payment';
  exception when insufficient_privilege then
    raise notice 'PASS C6.2b: manager record_settlement_payment denied (42501)';
  end;
end $$;

-- quote editor (sales) -> record_payment ALLOWED (can_edit=true). Rollback side effects.
begin;
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  do $$
  declare res jsonb;
  begin
    res := public.record_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, 'C6-SALES-OK');
    if coalesce(res->>'booking','') <> 'confirmed' then
      raise exception 'ASSERT FAILED C6.3: sales record_payment did not confirm booking (got %)', res;
    end if;
    raise notice 'PASS C6.3: sales (quote editor) record_payment allowed';
  end $$;
rollback;

-- admin -> record_payment ALLOWED. Rollback side effects.
begin;
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a0","role":"authenticated"}', true);
  do $$
  declare res jsonb;
  begin
    res := public.record_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, 'C6-ADMIN-OK');
    if coalesce(res->>'booking','') <> 'confirmed' then
      raise exception 'ASSERT FAILED C6.4: admin record_payment failed (got %)', res;
    end if;
    raise notice 'PASS C6.4: admin record_payment allowed';
  end $$;
rollback;

-- ================= Tenant isolation (cross-org) =============================
-- Org B admin cannot record_payment against an Org A quote (assert_quote_org)
do $$
begin
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000b0","role":"authenticated"}', true);
  begin
    perform public.record_payment('db7e57ed-0000-4000-8000-00000000c001', 100, 'cash', null, null, null, null);
    raise exception 'ASSERT FAILED C6.5: Org B admin recorded a payment on an Org A quote';
  exception when insufficient_privilege then
    raise notice 'PASS C6.5: cross-org record_payment blocked by assert_quote_org (42501)';
  end;
end $$;

-- Org A admin cannot record_payment against an Org B quote either
do $$
begin
  perform set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000a0","role":"authenticated"}', true);
  begin
    perform public.record_payment('db7e57ed-0000-4000-8000-00000000c0b1', 100, 'cash', null, null, null, null);
    raise exception 'ASSERT FAILED C6.6: Org A admin recorded a payment on an Org B quote';
  exception when insufficient_privilege then
    raise notice 'PASS C6.6: cross-org record_payment blocked the other direction (42501)';
  end;
end $$;

-- Org B admin cannot even SEE Org A ledger rows through RLS (seed one first).
-- Role is switched at the top level; the DO block runs AS authenticated (Org B).
begin;
  insert into public.quote_payments(quote_id, amount, status, org_id, receipt_no)
    values ('db7e57ed-0000-4000-8000-00000000c001', 100, 'paid',
            'db7e57ed-0000-4000-8000-00000000000a', 'DBT-ISO-SEED');
  select set_config('request.jwt.claim.sub','db7e57ed-0000-4000-8000-0000000000b0', true);
  select set_config('request.jwt.claims','{"sub":"db7e57ed-0000-4000-8000-0000000000b0","role":"authenticated"}', true);
  set local role authenticated;
  do $$
  declare n int;
  begin
    select count(*) into n from public.quote_payments
      where quote_id='db7e57ed-0000-4000-8000-00000000c001';
    if n <> 0 then
      raise exception 'ASSERT FAILED C6.7: Org B admin can SEE % Org A ledger rows via RLS', n;
    end if;
    raise notice 'PASS C6.7: Org B admin sees 0 Org A ledger rows (RLS org isolation)';
  end $$;
  reset role;
rollback;

\echo 'CASE 6 (tenant isolation + RBAC) complete'
