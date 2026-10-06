-- ============================================================================
-- H03 — payment_milestones RLS: schedule-management only; money via RPC + audit
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Apply order: H01 → H02 → H03. NOT APPLIED.
--
-- ⚠️ STAGE-2 / GATED: apply ONLY AFTER the settlement UI posts paid transitions
-- EXCLUSIVELY through public.record_settlement_payment (never a direct milestone
-- write), and the role-regression tests in supabase/tests/ pass on an isolated
-- test DB. Applying before the UI is routed through the RPC will break "mark paid".
--
-- CURRENT STATE (authoritative schema):
--   * quote_payments — RLS enabled, SELECT-only policy, NO write policy ⇒ already
--     write-locked for authenticated/anon; only SECURITY DEFINER RPCs (owner,
--     RLS-bypassing; FORCE RLS is NOT set) can write it. No change needed here.
--   * payment_milestones — policy "write mile" = can_edit() FOR ALL ⇒ staff can
--     directly INSERT/UPDATE/DELETE, including setting status='paid', changing
--     amount, and deleting PAID rows. That lets an authorized client move money
--     outside the audited RPC boundary. THIS FILE closes that.
--
-- MODEL: payment_milestones is a SCHEDULE/workflow record. Staff may create/edit/
-- delete milestones that are NOT paid. The paid transition (and any mutation or
-- deletion of a paid milestone) must go through record_settlement_payment, which
-- runs SECURITY DEFINER (bypasses RLS) and writes the canonical quote_payments
-- ledger + audit. No spoofable set_config flag is used — enforcement is purely the
-- RLS predicate on status, plus the table owner's definer bypass.
--
-- Additive/idempotent (drop policy if exists + create). Keeps "read mile".
-- ============================================================================

-- ---- PRECHECK (read-only) — expect write_mile_is_for_all = true (the gap) ----
select polname,
       (polcmd = '*') as is_for_all,
       pg_get_expr(polqual,  polrelid) as using_expr,
       pg_get_expr(polwithcheck, polrelid) as check_expr
from pg_policy
where polrelid = 'public.payment_milestones'::regclass
order by polname;

-- ---- APPLY ----------------------------------------------------------------
-- Replace the single blanket "write mile" with scoped, status-aware policies.
drop policy if exists "write mile" on public.payment_milestones;

-- INSERT: staff may add schedule rows, but NOT pre-create a paid one.
create policy "mile insert schedule" on public.payment_milestones
  for insert to authenticated
  with check ( public.can_edit() and status is distinct from 'paid' );

-- UPDATE: staff may edit only NON-paid rows and may NOT flip a row to paid
-- (paid transitions go through record_settlement_payment / definer).
create policy "mile update schedule" on public.payment_milestones
  for update to authenticated
  using      ( public.can_edit() and status is distinct from 'paid' )
  with check ( public.can_edit() and status is distinct from 'paid' );

-- DELETE: staff may remove only NON-paid schedule rows (never a paid record).
create policy "mile delete schedule" on public.payment_milestones
  for delete to authenticated
  using ( public.can_edit() and status is distinct from 'paid' );

-- "read mile" (SELECT using true) is intentionally preserved.

-- ---- VERIFY (expect no single FOR-ALL write policy; 3 scoped ones present) --
select
  not exists (select 1 from pg_policy
              where polrelid='public.payment_milestones'::regclass and polcmd='*'
                and polname='write mile') as blanket_write_removed,
  (select count(*) from pg_policy
     where polrelid='public.payment_milestones'::regclass
       and polname in ('mile insert schedule','mile update schedule','mile delete schedule')) = 3
    as scoped_policies_present;

-- Behavioural VERIFY (run as a finance/quote editor on the test DB):
--   * UPDATE a milestone SET status='paid'  → DENIED (0 rows / RLS)
--   * DELETE a paid milestone               → DENIED
--   * INSERT/UPDATE/DELETE a non-paid row   → ALLOWED
--   * record_settlement_payment(...)        → still flips the milestone to paid
-- (these are the role-regression + boundary tests in supabase/tests/).

-- ---- ROLLBACK -------------------------------------------------------------
-- drop policy if exists "mile insert schedule" on public.payment_milestones;
-- drop policy if exists "mile update schedule" on public.payment_milestones;
-- drop policy if exists "mile delete schedule" on public.payment_milestones;
-- create policy "write mile" on public.payment_milestones for all to authenticated
--   using ( public.can_edit() ) with check ( public.can_edit() );
