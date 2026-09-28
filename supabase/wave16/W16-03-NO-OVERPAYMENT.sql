-- ============================================================================
-- W16-03-NO-OVERPAYMENT.sql — reject a payment that pushes total paid beyond the
-- quote total. Implemented as a BEFORE INSERT trigger on quote_payments so it
-- covers EVERY insert path (record_payment RPC, milestones, direct). Additive,
-- idempotent. Skips the guard when the quote total is unknown/0 (can't compute).
-- 0.5 epsilon absorbs rupee rounding. Errcode 23514 (check_violation).
-- ============================================================================
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric, 0) into v_total from public.quotes where id = new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;      -- unknown total → don't block
  select coalesce(sum(amount),0) into v_paid from public.quote_payments
    where quote_id = new.quote_id and status = 'paid'
      and id is distinct from new.id;
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert on public.quote_payments
  for each row execute function public.enforce_no_overpayment();
