-- ============================================================================
-- H01 — overpayment: cover the UPDATE path + lock the parent quote (FOR UPDATE)
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Apply order: H01 → H02 → H03.
-- NOT APPLIED. Author: coordinator. Verify on an ISOLATED test DB (staging
-- xizehqgeyjcfpzrdymly or throwaway) with the concurrency tests in
-- supabase/tests/ BEFORE any production apply. NEVER run on prod from here.
--
-- WHY (two confirmed gaps on top of W16-04 + B2):
--   (a) trg_no_overpayment on public.quote_payments fires `BEFORE INSERT` ONLY.
--       An UPDATE that flips an existing row's amount/status to 'paid' (or raises
--       a paid row's amount) BYPASSES the overpayment cap entirely.
--   (b) B2 added a per-quote advisory lock (good). The brief also wants a
--       deterministic parent-row lock: we additionally take SELECT ... FOR UPDATE
--       on the quotes row so concurrent payment writes for one quote serialize on
--       the row itself, and the paid-total is recomputed AFTER the lock (no TOCTOU).
--
-- DESIGN NOTE (canonical ledger): helm_total_paid still sums BOTH quote_payments
-- and paid payment_milestones (W16-04 model). Whether payment_milestones should
-- remain a money ledger or become schedule-only (so helm_total_paid counts
-- quote_payments ONLY) is a PRODUCT DECISION — see README. This migration does NOT
-- change that semantics; it only closes the UPDATE-path bypass and strengthens
-- locking, which are safe regardless of that decision.
--
-- Additive + idempotent (create or replace + drop/create trigger).
-- ============================================================================

-- ---- PRECHECK (read-only) — expect quote_payments trigger = INSERT-only -----
select tgname,
       pg_get_triggerdef(t.oid) as def,
       (pg_get_triggerdef(t.oid) ilike '%before insert%' and pg_get_triggerdef(t.oid) not ilike '%update%')
         as insert_only_today
from pg_trigger t
where tgname = 'trg_no_overpayment' and tgrelid = 'public.quote_payments'::regclass;

-- ---- APPLY ----------------------------------------------------------------
-- quote_payments guard: now runs on INSERT and on any UPDATE that leaves/makes the
-- row 'paid'. Excludes the row's own id from the paid sum (via helm_total_paid's
-- p_excl_qp) so an in-place UPDATE re-checks the NEW amount correctly.
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  -- deterministic serialization for this quote: advisory lock (B2) + row lock.
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;   -- parent-row lock
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id = new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);     -- excludes this row
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- payment_milestones guard: same locking discipline; already INSERT-or-UPDATE.
create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id = new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, null, new.id);
  if (v_paid + coalesce(new.amount,0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, quote total %)',
      coalesce(new.amount,0), v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- recreate the quote_payments trigger to fire on INSERT **and** UPDATE
drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert or update on public.quote_payments
  for each row execute function public.enforce_no_overpayment();

-- (payment_milestones trigger already fires on insert-or-update; recreate to be sure)
drop trigger if exists trg_no_overpayment_ms on public.payment_milestones;
create trigger trg_no_overpayment_ms before insert or update on public.payment_milestones
  for each row execute function public.enforce_no_overpayment_ms();

-- ---- VERIFY (expect all true) ---------------------------------------------
select
  (select pg_get_triggerdef(t.oid) ilike '%insert or update%'
     from pg_trigger t where tgname='trg_no_overpayment' and tgrelid='public.quote_payments'::regclass)
    as qp_trigger_now_insert_or_update,
  (pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) ilike '%for update%')
    as qp_fn_locks_quote_row,
  (pg_get_functiondef('public.enforce_no_overpayment_ms()'::regprocedure) ilike '%for update%')
    as ms_fn_locks_quote_row;

-- ---- ROLLBACK (restore the W16-04/B2 state: INSERT-only qp trigger, advisory-only) --
-- Re-apply supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql then
-- supabase/prod-fix/B2-overpayment-concurrency-lock.sql to revert this file.
