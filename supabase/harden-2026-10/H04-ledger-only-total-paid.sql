-- ============================================================================
-- H04 — canonical ledger-only paid total (resolve the double-count)   [OPTIONAL]
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Apply AFTER H01+H03 (needs milestone-paid
-- writes already routed through the RPC / blocked from direct staff writes).
-- NOT APPLIED. Verify on an isolated test DB with the payment tests first.
--
-- DECISION RESOLVED HERE: quote_payments is the SINGLE money ledger. A paid
-- payment_milestone is a SCHEDULE status, not a second money record. Today
-- helm_total_paid sums paid quote_payments + paid payment_milestones, so a
-- settlement that writes BOTH (same money) double-counts and can falsely reject a
-- later legitimate payment. (Latent now: the UI calls record_settlement_payment
-- with p_milestone = NULL, and H03 blocks direct milestone-paid writes — so no
-- milestone is currently marked paid. H04 makes the model correct regardless.)
--
-- CHANGES:
--   1. helm_total_paid counts quote_payments ONLY (signature unchanged; p_excl_pm
--      kept for caller compatibility but ignored).
--   2. The payment_milestones overpayment trigger is removed — a milestone's amount
--      is no longer money, so it must not be added to the paid total (that was the
--      double-count). Overpayment stays fully enforced on the quote_payments ledger
--      by trg_no_overpayment (H01: INSERT or UPDATE + FOR UPDATE).
--
-- Additive/idempotent (create or replace + drop trigger if exists). Reversible.
-- ============================================================================

-- ---- PRECHECK (read-only) — expect counts_milestones = true (the double-count) --
select (pg_get_functiondef('public.helm_total_paid(uuid,uuid,uuid)'::regprocedure)
          ilike '%payment_milestones%') as counts_milestones_today,
       exists(select 1 from pg_trigger where tgname='trg_no_overpayment_ms'
                and tgrelid='public.payment_milestones'::regclass) as ms_trigger_present_today;

-- ---- APPLY ----------------------------------------------------------------
-- 1) ledger-only paid total
create or replace function public.helm_total_paid(p_quote uuid, p_excl_qp uuid, p_excl_pm uuid)
returns numeric language sql stable security definer set search_path = public as $$
  -- The quote_payments ledger is the sole money source. The third parameter is
  -- accepted for backward-compatible call signatures and ignored (no second table).
  select coalesce((select sum(amount) from public.quote_payments
                   where quote_id = p_quote and status = 'paid'
                     and id is distinct from p_excl_qp), 0);
$$;

-- 2) remove the milestone money-guard (milestone amount is no longer counted).
--    Overpayment remains enforced on the quote_payments ledger (trg_no_overpayment).
drop trigger if exists trg_no_overpayment_ms on public.payment_milestones;
-- (enforce_no_overpayment_ms() left defined but unused, so the ROLLBACK can re-bind it.)

-- ---- VERIFY (expect ledger_only = true, ms_trigger_gone = true) ------------
select (pg_get_functiondef('public.helm_total_paid(uuid,uuid,uuid)'::regprocedure)
          not ilike '%payment_milestones%') as ledger_only,
       not exists(select 1 from pg_trigger where tgname='trg_no_overpayment_ms'
                    and tgrelid='public.payment_milestones'::regclass) as ms_trigger_gone;

-- Behavioural VERIFY (test DB): advance via record_payment + balance via
-- record_settlement_payment on one quote → helm_total_paid = exactly the sum of the
-- two quote_payments rows (NOT doubled); a further payment over the balance → 23514.

-- ---- ROLLBACK -------------------------------------------------------------
-- Re-apply supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql (restores helm_total_paid
-- summing both tables AND recreates trg_no_overpayment_ms), then re-apply
-- supabase/harden-2026-10/H01 (to restore the INSERT-or-UPDATE + FOR UPDATE guards).
