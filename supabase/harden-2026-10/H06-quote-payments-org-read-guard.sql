-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- ==========================================================================================
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
