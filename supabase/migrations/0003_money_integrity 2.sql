-- ============================================================================
-- 0003_money_integrity.sql — CANONICAL forward-only (reuses H04 + H01 + B2).
-- Closes two money defects and the overpayment TOCTOU:
--   * helm_total_paid double-count → LEDGER-ONLY (sum paid quote_payments only).
--   * overpayment with NO lock (check-then-insert race) → a per-quote serialization
--     boundary: transaction-scoped advisory lock keyed on the quote + FOR UPDATE on
--     the parent quotes row, so concurrent paid writes serialize and the second is
--     rejected if it would exceed the quote total. Guard runs on INSERT *and* UPDATE,
--     on both quote_payments and payment_milestones.
-- Idempotent (CREATE OR REPLACE / drop-create trigger). Forward-only.
-- FAIL-before (PG17): baseline has NO overpayment guard — two paid rows summing
-- past the total both commit. PASS-after: second write rejected (errcode 23514);
-- genuine two-session overlap serializes to exactly one financial effect.
-- ============================================================================

-- (1) ledger-only total paid (H04): real cash = paid quote_payments rows only.
create or replace function public.helm_total_paid(p_quote uuid, p_excl_qp uuid, p_excl_pm uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from public.quote_payments
                   where quote_id = p_quote and status = 'paid'
                     and id is distinct from p_excl_qp), 0);
$$;

-- (2) overpayment guard on the money ledger (H01 + B2 lock).
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;   -- serialize on the quote
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id = new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);     -- excludes this row
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- (3) same guard on milestones flipped to paid (keeps one financial effect).
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

drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert or update on public.quote_payments
  for each row execute function public.enforce_no_overpayment();
drop trigger if exists trg_no_overpayment_ms on public.payment_milestones;
create trigger trg_no_overpayment_ms before insert or update on public.payment_milestones
  for each row execute function public.enforce_no_overpayment_ms();

-- ---- VERIFY (expect ledger_only=t, locks=t, triggers insert-or-update) -------
-- select pg_get_functiondef('public.helm_total_paid(uuid,uuid,uuid)'::regprocedure) not ilike '%payment_milestones%' as ledger_only,
--        pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) ilike '%pg_advisory_xact_lock%' as has_lock;
-- ---- ROLLBACK: drop trigger trg_no_overpayment[_ms]; (overpayment guard removed)
