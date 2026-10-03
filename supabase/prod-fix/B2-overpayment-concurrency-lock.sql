-- ============================================================================
-- B2 — close the overpayment concurrency (TOCTOU) gap with a per-quote lock.
-- The overpayment triggers do check-then-insert: SELECT sum(paid) then compare.
-- Under READ COMMITTED two concurrent paid inserts for the SAME quote each read
-- the pre-other total and BOTH pass -> overpayment. Fix: take a transaction-scoped
-- advisory lock keyed on quote_id at the top of each trigger (only on the 'paid'
-- path). Concurrent payments for one quote serialize; the 2nd re-reads sum(paid)
-- after the 1st commits and correctly rejects the overshoot. One key per quote =
-- no deadlock. Covers record_payment, record_settlement_payment, and direct inserts.
-- Additive, idempotent (create or replace). Matches SEC-07's OTP lock pattern.
-- ============================================================================

create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  -- serialize concurrent paid inserts for this quote (TOCTOU guard)
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, null, new.id);
  if (v_paid + coalesce(new.amount,0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, quote total %)',
      coalesce(new.amount,0), v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

-- VERIFY (both trigger fns now take the advisory lock)
select 'enforce_no_overpayment has advisory lock' as check,
       pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) like '%pg_advisory_xact_lock%' as ok
union all
select 'enforce_no_overpayment_ms has advisory lock',
       pg_get_functiondef('public.enforce_no_overpayment_ms()'::regprocedure) like '%pg_advisory_xact_lock%';
