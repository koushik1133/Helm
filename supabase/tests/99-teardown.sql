-- ============================================================================
-- 99-teardown.sql — remove everything 00-fixtures.sql created. Idempotent.
-- STATUS: NOT YET EXECUTED (no isolated test DB creds were available).
-- RUN: append it to any psql invocation after the case files, e.g.
--   psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
--     -f supabase/tests/00-fixtures.sql -f supabase/tests/10-overpayment-concurrency.sql \
--     -f supabase/tests/99-teardown.sql
-- Deletes ONLY the two dedicated test orgs' rows; never touches other data.
-- ============================================================================
\set ON_ERROR_STOP on
\set OA '''db7e57ed-0000-4000-8000-00000000000a'''
\set OB '''db7e57ed-0000-4000-8000-00000000000b'''
\set U_ADMIN  '''db7e57ed-0000-4000-8000-0000000000a0'''
\set U_PLAN   '''db7e57ed-0000-4000-8000-0000000000a1'''
\set U_SALES  '''db7e57ed-0000-4000-8000-0000000000a2'''
\set U_MGR    '''db7e57ed-0000-4000-8000-0000000000a3'''
\set U_CLIENT '''db7e57ed-0000-4000-8000-0000000000a4'''
\set U_BADMIN '''db7e57ed-0000-4000-8000-0000000000b0'''

delete from public.quote_payments     where org_id in (:OA,:OB);
delete from public.payment_milestones  where org_id in (:OA,:OB);
delete from public.quote_otps          where org_id in (:OA,:OB);
delete from public.quote_consents      where org_id in (:OA,:OB);
delete from public.notifications       where org_id in (:OA,:OB);
delete from public.quotes              where org_id in (:OA,:OB);
delete from public.role_access         where org_id in (:OA,:OB);
delete from public.profiles            where id in (:U_ADMIN,:U_PLAN,:U_SALES,:U_MGR,:U_CLIENT,:U_BADMIN);
delete from public.organizations       where id in (:OA,:OB);
delete from auth.users                 where id in (:U_ADMIN,:U_PLAN,:U_SALES,:U_MGR,:U_CLIENT,:U_BADMIN);
\echo 'teardown complete: test orgs A/B removed'
