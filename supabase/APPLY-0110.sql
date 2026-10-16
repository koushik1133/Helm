-- APPLY-0110.sql - paste into the Supabase SQL editor (staging first, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0110_overpay_cap_includes_changes.sql:
--   * helm_invoice_total(quote) - read-only: quote total + approved change orders.
--   * enforce_no_overpayment / enforce_no_overpayment_ms - cap now = invoice total (was quote total only).
--   * _a49_close_blockers - close gate balance uses the same invoice total.
--   No table, column, row or trigger is changed or deleted. No temp tables, no session settings.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- 0110_overpay_cap_includes_changes.sql - CANONICAL forward-only.
--
-- In plain words:
--   The "no overpayment" guard on payments capped what the client may pay at the quote total
--   ONLY. Settlement's invoice is "quote + approved change orders", so once a change order was
--   approved the client could never be recorded as paying the full invoice: e.g. quote 82,600 +
--   approved change 5,000 = invoice 87,600, 40,000 received, recording the exact 47,600 balance was
--   refused ("Some values are invalid"). QA-E2E ops run, 2026-10-13, staging.
--
--   Fix: one read-only helper helm_invoice_total(quote) = pricing.total + sum(price_delta) of the
--   quote's APPROVED change_requests, and the two overpayment trigger functions now compare against
--   it. Locking is unchanged in spirit (advisory per-quote lock + parent row FOR UPDATE, as H01).
--   Triggers themselves are NOT recreated - whatever trigger wiring the database has stays.
--
--   Changes: 1 new function + 2 function bodies replaced. No table / column / row changed or deleted.
--   Additive + idempotent (create or replace). Safe to run twice.

create or replace function public.helm_invoice_total(p_quote uuid) returns numeric
  language sql stable security definer set search_path = public as $fn$
  select coalesce((select (q.pricing->>'total')::numeric from public.quotes q where q.id = p_quote), 0)
       + coalesce((select sum(coalesce(c.price_delta, 0)) from public.change_requests c
                    where c.quote_id = p_quote and c.status = 'approved'), 0)
$fn$;
revoke all on function public.helm_invoice_total(uuid) from public, anon, authenticated;   -- internal helper: only the definer triggers/close gate call it (no cross-studio totals lookup)

create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_base numeric; v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;
  select coalesce((pricing->>'total')::numeric, 0) into v_base from public.quotes where id = new.quote_id;
  if v_base is null or v_base <= 0 then return new; end if;     -- unpriced quote: unchanged behaviour
  v_total := public.helm_invoice_total(new.quote_id);             -- quote + approved changes
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, invoice total %)',
      new.amount, v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_base numeric; v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;
  select coalesce((pricing->>'total')::numeric, 0) into v_base from public.quotes where id = new.quote_id;
  if v_base is null or v_base <= 0 then return new; end if;
  v_total := public.helm_invoice_total(new.quote_id);
  v_paid := public.helm_total_paid(new.quote_id, null, new.id);
  if (v_paid + coalesce(new.amount, 0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, invoice total %)',
      coalesce(new.amount, 0), v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- Close gate: the same "quote + approved changes" total, so an event with an unpaid approved
-- change order is blocked from closing (it showed balance_owed 0 while Settlement showed 5,000 due).
create or replace function public._a49_close_blockers(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_total numeric; v_paid numeric; v_owed numeric; v_items jsonb; v_n int;
begin
  select coalesce(nullif(q.pricing ->> 'total', '')::numeric, 0) into v_total
    from public.quotes q where q.id = p_quote;
  if coalesce(v_total, 0) > 0 then v_total := public.helm_invoice_total(p_quote); end if;
  v_paid := coalesce(public.helm_total_paid(p_quote, null, null), 0);
  v_owed := greatest(coalesce(v_total, 0) - v_paid, 0);
  if v_owed <= 0.5 then v_owed := 0; end if;
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', coalesce(i.name, 'item'), 'qty', c.qty_out, 'issued_to', c.issued_to)
           order by c.checked_out_at), '[]'::jsonb)
    into v_n, v_items
    from public.inventory_checkouts c left join public.inventory_items i on i.id = c.item_id
   where c.quote_id = p_quote and c.status = 'out';
  return jsonb_build_object('total', coalesce(v_total, 0), 'paid', v_paid, 'balance_owed', v_owed,
                            'open_checkouts', v_n, 'checkouts', v_items,
                            'blocked', (v_owed > 0 or v_n > 0));
end $$;

commit;

-- ---- VERIFY (expect every ok = true) ----
select 'helm_invoice_total exists' as item, to_regprocedure('public.helm_invoice_total(uuid)') is not null as ok
union all
select 'qp guard uses invoice total', pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) like '%helm_invoice_total%'
union all
select 'ms guard uses invoice total', pg_get_functiondef('public.enforce_no_overpayment_ms()'::regprocedure) like '%helm_invoice_total%'
union all
select 'qp guard keeps advisory lock', pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) like '%pg_advisory_xact_lock%'
union all
select 'trg_no_overpayment still present', exists(select 1 from pg_trigger where tgname='trg_no_overpayment' and tgrelid='public.quote_payments'::regclass)
union all
select 'close gate uses invoice total', pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure) like '%helm_invoice_total%'
union all
select 'anon cannot run helm_invoice_total', not has_function_privilege('anon','public.helm_invoice_total(uuid)','execute')
union all
select 'studio users cannot call helm_invoice_total directly', not has_function_privilege('authenticated','public.helm_invoice_total(uuid)','execute');
