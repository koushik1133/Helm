-- ============================================================================
-- H03b — CORRECTION to H03: block paid-milestone writes with RESTRICTIVE policies
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS: H03 used PERMISSIVE policies to try to limit writes to non-paid
-- rows. Permissive policies are OR'd — they only GRANT, they cannot RESTRICT — and a
-- pre-existing broad write policy (NOT named "write mile", so H03's drop was a no-op)
-- still permits paid writes. Verified on staging 2026-10-01 via a real authenticated
-- (admin) PostgREST session: INSERT status='paid' → 201, UPDATE →'paid' → 204,
-- DELETE paid → 204 — i.e. H03 did NOT block them. (Anon is correctly deny-all.)
--
-- ⚠️ H03 was already applied to STAGING and PRODUCTION; it is INEFFECTIVE there.
-- Apply H03b on both (staging → verify behaviourally → prod) to actually enforce it.
--
-- FIX: add RESTRICTIVE policies (AND'd with every permissive policy) so NO staff
-- write may create, transition-to, mutate, or delete a PAID milestone — regardless
-- of what permissive policies exist. SELECT is untouched, so paid rows stay visible.
-- record_settlement_payment runs SECURITY DEFINER as the table owner and BYPASSES
-- RLS (incl. restrictive), so it can still mark a milestone paid. No set_config flag.
--
-- Additive + idempotent. Leaves H03's (harmless, redundant) permissive policies and
-- the pre-existing broad grant in place; the restrictive layer does the enforcing.
-- ============================================================================

-- ---- PRECHECK (read-only): list current policies + restrictive presence ----
select polname,
       case polcmd when '*' then 'ALL' when 'r' then 'SELECT' when 'a' then 'INSERT'
            when 'w' then 'UPDATE' when 'd' then 'DELETE' end as cmd,
       polpermissive as is_permissive
from pg_policy where polrelid = 'public.payment_milestones'::regclass
order by polpermissive desc, polname;

-- ---- APPLY: restrictive guards (status must never be 'paid' on a staff write) ----
drop policy if exists "mile no paid insert" on public.payment_milestones;
create policy "mile no paid insert" on public.payment_milestones
  as restrictive for insert to authenticated
  with check ( status is distinct from 'paid' );

drop policy if exists "mile no paid update" on public.payment_milestones;
create policy "mile no paid update" on public.payment_milestones
  as restrictive for update to authenticated
  using      ( status is distinct from 'paid' )     -- can only touch non-paid rows
  with check ( status is distinct from 'paid' );    -- and cannot turn one paid

drop policy if exists "mile no paid delete" on public.payment_milestones;
create policy "mile no paid delete" on public.payment_milestones
  as restrictive for delete to authenticated
  using ( status is distinct from 'paid' );          -- cannot delete a paid row

-- ---- VERIFY (expect 3 restrictive write guards present) --------------------
select
  (select count(*) from pg_policy
     where polrelid='public.payment_milestones'::regclass
       and polpermissive = false
       and polname in ('mile no paid insert','mile no paid update','mile no paid delete')) = 3
    as restrictive_guards_present;

-- ---- BEHAVIOURAL VERIFY (run after apply; expected results) ----------------
--  As an authenticated staff (can_edit) via PostgREST:
--    INSERT payment_milestones status='paid'        → DENIED (42501)
--    UPDATE a 'due' milestone  → status='paid'       → DENIED (42501)
--    DELETE a 'paid' milestone                       → DENIED (42501)
--    INSERT/UPDATE/DELETE a non-paid milestone       → ALLOWED
--    record_settlement_payment(...)                  → still marks paid (definer)
--  (These are the ones that WRONGLY succeeded under H03 alone.)

-- ---- ROLLBACK -------------------------------------------------------------
-- drop policy if exists "mile no paid insert" on public.payment_milestones;
-- drop policy if exists "mile no paid update" on public.payment_milestones;
-- drop policy if exists "mile no paid delete" on public.payment_milestones;
