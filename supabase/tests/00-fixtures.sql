-- ============================================================================
-- 00-fixtures.sql — shared, idempotent, NON-PRODUCTION test fixtures.
-- ----------------------------------------------------------------------------
-- STATUS: NOT YET EXECUTED. No isolated test DB credentials were available when
--         this file was authored. Nothing here has been run against any database.
--
-- PURPOSE: create two isolated test studios (orgs A and B), one user per RBAC
--          role under test, the minimal role_access matrix those roles need, and
--          a handful of quotes / milestones / OTP rows that every per-case test
--          file (10-…, 20-…, …, 60-…) builds on. Everything created here is
--          removed by 99-teardown.sql. All rows live under two dedicated test
--          org ids (db7e57ed-…-000a / -000b); nothing else is touched.
--
-- SAFETY:  This file REFUSES to run unless you explicitly acknowledge it is a
--          throwaway / staging DB by passing  -v HELM_TEST_ACK=1 .
--          NEVER run against production (project ref nqltzgiwznphugcfhmbm).
--          Intended target: staging (xizehqgeyjcfpzrdymly) or a throwaway project
--          that already has supabase/HELM-STAGING-SCHEMA.sql applied (plus, for
--          the payment-guard tests, the overpayment migrations — see docs).
--
-- RUN (fixtures + one case + teardown, all in one psql invocation):
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql \
--     -f supabase/tests/30-overpayment-update-path.sql \
--     -f supabase/tests/99-teardown.sql
--
-- Use the DIRECT connection (port 5432), not the transaction pooler (advisory /
-- FOR UPDATE locks and multi-statement sessions need a real session).
-- ============================================================================

\if :{?HELM_TEST_ACK}
\else
\echo '*** REFUSING: pass -v HELM_TEST_ACK=1 to confirm this is a NON-PRODUCTION test DB ***'
\quit
\endif

\set ON_ERROR_STOP on

-- --- fixed ids (shared across every test file) ------------------------------
-- orgs
\set OA   '''db7e57ed-0000-4000-8000-00000000000a'''
\set OB   '''db7e57ed-0000-4000-8000-00000000000b'''
-- users (org A), one per role under test
\set U_ADMIN  '''db7e57ed-0000-4000-8000-0000000000a0'''
\set U_PLAN   '''db7e57ed-0000-4000-8000-0000000000a1'''
\set U_SALES  '''db7e57ed-0000-4000-8000-0000000000a2'''
\set U_MGR    '''db7e57ed-0000-4000-8000-0000000000a3'''
\set U_CLIENT '''db7e57ed-0000-4000-8000-0000000000a4'''
-- user (org B)
\set U_BADMIN '''db7e57ed-0000-4000-8000-0000000000b0'''
-- quotes (org A)
\set Q_MAIN '''db7e57ed-0000-4000-8000-00000000c001'''
\set Q_IDEM '''db7e57ed-0000-4000-8000-00000000c002'''
\set Q_UPD  '''db7e57ed-0000-4000-8000-00000000c003'''
\set Q_RLS  '''db7e57ed-0000-4000-8000-00000000c004'''
\set Q_OTP  '''db7e57ed-0000-4000-8000-00000000c005'''
-- quote (org B)
\set Q_B    '''db7e57ed-0000-4000-8000-00000000c0b1'''
-- milestone (org A, on Q_RLS)
\set M_RLS  '''db7e57ed-0000-4000-8000-00000000d001'''
-- OTP approval token (on Q_OTP)
\set T_OTP  '''db7e57ed-0000-4000-8000-00000000ef01'''

-- --- clean any leftovers from an interrupted run ----------------------------
delete from public.quote_payments     where quote_id in (:Q_MAIN,:Q_IDEM,:Q_UPD,:Q_RLS,:Q_OTP,:Q_B);
delete from public.payment_milestones where quote_id in (:Q_MAIN,:Q_IDEM,:Q_UPD,:Q_RLS,:Q_OTP,:Q_B);
delete from public.quote_otps         where quote_id in (:Q_MAIN,:Q_IDEM,:Q_UPD,:Q_RLS,:Q_OTP,:Q_B);
delete from public.quote_consents     where quote_id in (:Q_MAIN,:Q_IDEM,:Q_UPD,:Q_RLS,:Q_OTP,:Q_B);
delete from public.notifications      where quote_id in (:Q_MAIN,:Q_IDEM,:Q_UPD,:Q_RLS,:Q_OTP,:Q_B);
delete from public.quotes             where org_id in (:OA,:OB);
delete from public.role_access        where org_id in (:OA,:OB);
delete from public.profiles           where id in (:U_ADMIN,:U_PLAN,:U_SALES,:U_MGR,:U_CLIENT,:U_BADMIN);
delete from public.organizations      where id in (:OA,:OB);
delete from auth.users                where id in (:U_ADMIN,:U_PLAN,:U_SALES,:U_MGR,:U_CLIENT,:U_BADMIN);

-- --- orgs -------------------------------------------------------------------
insert into public.organizations(id, name, business_email) values
  (:OA, 'DBTEST Studio A', 'studio-a@example.invalid'),
  (:OB, 'DBTEST Studio B', 'studio-b@example.invalid');

-- --- auth users + profiles (role drives RBAC) -------------------------------
insert into auth.users(id, email) values
  (:U_ADMIN,  'dbtest-admin@example.invalid'),
  (:U_PLAN,   'dbtest-planner@example.invalid'),
  (:U_SALES,  'dbtest-sales@example.invalid'),
  (:U_MGR,    'dbtest-manager@example.invalid'),
  (:U_CLIENT, 'dbtest-client@example.invalid'),
  (:U_BADMIN, 'dbtest-badmin@example.invalid');

insert into public.profiles(id, org_id, role) values
  (:U_ADMIN,  :OA, 'admin'),
  (:U_PLAN,   :OA, 'planner'),
  (:U_SALES,  :OA, 'sales'),
  (:U_MGR,    :OA, 'manager'),
  (:U_CLIENT, :OA, 'client'),
  (:U_BADMIN, :OB, 'admin')
on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;

-- --- minimal role_access matrix for org A -----------------------------------
-- Mirrors supabase/phase29-role-access.sql for the areas exercised here.
-- NOTE the deliberate asymmetries that the RBAC tests rely on:
--   * quote_payments table is governed by RLS area 'quotes' (NOT 'finance').
--   * payment_milestones table is governed by RLS area 'finance'.
--   * can_edit() (the money-RPC gate) = role in (admin,planner,sales,operations)
--     and is INDEPENDENT of this matrix -> 'manager' has finance EDIT here but
--     can_edit()=false, 'sales' has quotes EDIT + can_edit()=true but finance
--     EDIT=false. Admin bypasses this matrix entirely in has_area().
insert into public.role_access(org_id, role, area, can_view, can_edit) values
  (:OA,'manager','quotes',    true,  true ),
  (:OA,'manager','finance',   true,  true ),
  (:OA,'manager','settlement',true,  true ),
  (:OA,'planner','quotes',    true,  true ),
  (:OA,'planner','finance',   true,  true ),
  (:OA,'planner','settlement',true,  true ),
  (:OA,'sales',  'quotes',    true,  true ),
  (:OA,'sales',  'finance',   true,  false),   -- VIEW only on finance
  (:OA,'sales',  'settlement',true,  false),
  (:OA,'client', 'quotes',    false, false),   -- ordinary user: nothing
  (:OA,'client', 'finance',   false, false)
on conflict (org_id, role, area) do update
  set can_view = excluded.can_view, can_edit = excluded.can_edit;

-- --- quotes -----------------------------------------------------------------
-- pricing uses the 'total' key because the overpayment trigger reads
-- (pricing->>'total')::numeric. A quote with no 'total' is SKIPPED by the guard.
insert into public.quotes(id, org_id, code, title, pricing, event_date, approval_token, approval_token_expires_at) values
  (:Q_MAIN, :OA, 'DBT-MAIN', 'cap + concurrency', '{"total":1000}', current_date + 90, null, null),
  (:Q_IDEM, :OA, 'DBT-IDEM', 'idempotency',        '{"total":1000}', null, null, null),
  (:Q_UPD,  :OA, 'DBT-UPD',  'update-path guard',  '{"total":1000}', null, null, null),
  (:Q_RLS,  :OA, 'DBT-RLS',  'ledger RLS',         '{"total":100000}', null, null, null),
  (:Q_OTP,  :OA, 'DBT-OTP',  'otp race/lockout',   '{"total":1000}', null, :T_OTP, now() + interval '1 day'),
  (:Q_B,    :OB, 'DBT-B',    'other tenant',       '{"total":1000}', null, null, null);

-- --- a settlement milestone on Q_RLS (finance-area ledger row) ---------------
insert into public.payment_milestones(id, quote_id, label, amount, status, org_id) values
  (:M_RLS, :Q_RLS, 'Balance', 500, 'due', :OA);

\echo 'fixtures ready: orgs A/B, 6 users, role_access, 6 quotes, 1 milestone'
