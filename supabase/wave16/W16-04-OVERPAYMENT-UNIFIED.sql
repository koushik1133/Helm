-- ============================================================================
-- W16-04-OVERPAYMENT-UNIFIED.sql — close the settlement-path overpayment gap.
-- "Money received" is tracked in TWO tables: quote_payments (flow advance/receipts)
-- and payment_milestones with status='paid' (settlement "Record payment"). W16-03
-- only guarded quote_payments, so overpayment via the Settlement screen slipped
-- through. This enforces ONE invariant across BOTH tables:
--   sum(paid quote_payments) + sum(paid payment_milestones) <= quote total (+0.5).
-- Additive, idempotent. Skips when the quote total is unknown/0. Errcode 23514.
-- ============================================================================
create or replace function public.helm_total_paid(p_quote uuid, p_excl_qp uuid, p_excl_pm uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from public.quote_payments
                    where quote_id=p_quote and status='paid' and id is distinct from p_excl_qp),0)
       + coalesce((select sum(amount) from public.payment_milestones
                    where quote_id=p_quote and status='paid' and id is distinct from p_excl_pm),0);
$$;

-- quote_payments guard (INSERT)
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

-- payment_milestones guard (INSERT or UPDATE, only when the row is/*becomes* paid)
create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, null, new.id);
  if (v_paid + coalesce(new.amount,0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, quote total %)',
      coalesce(new.amount,0), v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert on public.quote_payments
  for each row execute function public.enforce_no_overpayment();

drop trigger if exists trg_no_overpayment_ms on public.payment_milestones;
create trigger trg_no_overpayment_ms before insert or update on public.payment_milestones
  for each row execute function public.enforce_no_overpayment_ms();
