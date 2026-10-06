-- ============================================================================
-- H06 — explicit tenant-scoped READ guard on quote_payments (defense-in-depth)
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). NOT APPLIED. Staging → verify → prod.
--
-- CONTEXT: quote_payments carries a permissive SELECT policy "mgr read payments"
-- with `using (true)` (see supabase/otp-payments.sql). Live behaviour is ALREADY
-- org-isolated (a cross-tenant read test on 2026-10-01 returned 0 rows from other
-- orgs), so an org-scoping mechanism is in effect — but the policy does not SAY so.
-- This makes the tenant boundary EXPLICIT and guaranteed at the quote_payments read
-- layer, independent of any other policy.
--
-- APPROACH: add a RESTRICTIVE SELECT policy `org_id = current_org_id()`. Restrictive
-- policies are AND'd with every permissive policy, so this can ONLY tighten — it
-- cannot broaden access and cannot break the (already-correct) behaviour. It does
-- NOT touch or drop the existing permissive policy (no risk of removing the wrong
-- one, the mistake H03 made). SECURITY DEFINER RPCs own the table and bypass RLS,
-- so record_payment / record_settlement_payment are unaffected.
--
-- SAFETY: additive + idempotent (drop-if-exists + create). Read-only effect; no data
-- touched. The PRECHECK prints the live policy set so you can confirm before/after.
-- ============================================================================

-- ---- PRECHECK (read-only): current policies on quote_payments ---------------
select polname,
       polpermissive as is_permissive,
       case polcmd when '*' then 'ALL' when 'r' then 'SELECT' when 'a' then 'INSERT'
            when 'w' then 'UPDATE' when 'd' then 'DELETE' end as cmd,
       pg_get_expr(polqual, polrelid) as using_expr
from pg_policy where polrelid = 'public.quote_payments'::regclass
order by polpermissive desc, polname;

-- ---- APPLY ----------------------------------------------------------------
drop policy if exists "qp tenant read guard" on public.quote_payments;
create policy "qp tenant read guard" on public.quote_payments
  as restrictive for select to authenticated
  using ( org_id = public.current_org_id() );

-- ---- VERIFY (expect guard_present = true) ----------------------------------
select exists(
  select 1 from pg_policy
  where polrelid = 'public.quote_payments'::regclass
    and polname = 'qp tenant read guard'
    and polpermissive = false
    and polcmd = 'r'
) as guard_present;

-- ---- BEHAVIOURAL VERIFY (re-run the live cross-tenant read test) -----------
--  As a staff user in org A via PostGREST:
--    GET quote_payments?org_id=neq.<my_org>&limit=1   → [] (still 0 cross-tenant)
--    GET quote_payments (own org)                     → own rows still visible
--  (tests/db/tenant-isolation.mjs covers this.)

-- ---- ROLLBACK -------------------------------------------------------------
-- drop policy if exists "qp tenant read guard" on public.quote_payments;
