-- 0098_public_paid_status.sql - CANONICAL forward-only. Client approval link: paid vs total.
--
-- In plain words:
--   The client's approval page said "Payment received - your event is confirmed" as soon as
--   ANY payment was recorded (approval_status = 'paid'), even when only a ₹50,000 advance
--   was in against a ₹3,06,800 quote. This adds ONE read-only function the approval page
--   calls with the same link token: how much is paid (summed from the quote_payments
--   LEDGER - the same source the settlement page uses), the latest receipt number, the
--   quote total, the event date and the studio's "balance due N days before" term.
--   The page then says "Advance of ₹50,000 received ... Balance ₹2,56,800 due by ..."
--   and only "Paid in full" when paid >= total.
--
-- Security: the link is checked by calling public_get_quote first (same expiry, shelving
-- and auto-expire rules - an invalid link raises exactly as before). Returns figures only:
-- no names, phones, payment references or links.
--
-- Additive + idempotent: one new function + grant. NO table, NO column, NO row changed.
-- Needs 0042 (public_get_quote wrapper), 0010 (quote_payments.receipt_no).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_quote(uuid)') is null then raise exception '0098: public_get_quote missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_payments' and column_name = 'receipt_no') then
    raise exception '0098: apply 0010 first (quote_payments.receipt_no missing)';
  end if;
end $$;

create or replace function public.public_quote_paid_status(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare q public.quotes; v_paid numeric; v_n int; v_last text; v_last_amt numeric; v_days text; v_total numeric;
begin
  perform public.public_get_quote(p_token);   -- raises on an invalid / expired / shelved link
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select coalesce(sum(amount), 0), count(*) into v_paid, v_n from public.quote_payments where quote_id = q.id and status = 'paid';
  select receipt_no, amount into v_last, v_last_amt from public.quote_payments
    where quote_id = q.id and status = 'paid' order by coalesce(paid_at, created_at) desc limit 1;
  select value->>'balanceDueDays' into v_days from public.app_config where key = 'pricing' and org_id = q.org_id;
  v_total := case when coalesce(q.pricing->>'total', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (q.pricing->>'total')::numeric else null end;
  return jsonb_build_object('total', v_total, 'paid', v_paid, 'payments', v_n,
    'last_receipt', v_last, 'last_amount', v_last_amt, 'event_date', q.event_date,
    'balance_due_days', case when coalesce(v_days, '') ~ '^[0-9]{1,3}$' then v_days::int else null end);
end $$;

revoke all on function public.public_quote_paid_status(uuid) from public;
grant execute on function public.public_quote_paid_status(uuid) to anon, authenticated;
