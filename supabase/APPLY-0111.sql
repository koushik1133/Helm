-- APPLY-0111.sql - paste into the Supabase SQL editor (staging first, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0111_booklet_invoice_total.sql:
--   * _bk_payments - client booklet total / outstanding = quote + approved change orders.
--   No table, column, row or trigger is changed or deleted. No temp tables, no session settings.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- 0111_booklet_invoice_total.sql - CANONICAL forward-only.
--
-- In plain words:
--   The client booklet Payments section said "Paid in full" while an APPROVED change order
--   (e.g. +5,000) was still unpaid: _bk_payments (0070) used the quote total only, while
--   Settlement / the overpay guard / the close gate (0110) use quote + approved change orders.
--   Fix: _bk_payments total = quote total + sum(price_delta) of that quote's approved change
--   orders (same rule as public.helm_invoice_total, 0110), only when the quote is priced (> 0),
--   exactly like the 0110 guards. Outstanding = that total - paid. Everything else in the 0070
--   body (paid source, receipts shape, org scoping) is unchanged; public_get_booklet is untouched.
--   _bk_payments stays internal (no anon / authenticated execute); it is only called by the
--   SECURITY DEFINER token-scoped public_get_booklet with the booklet's own quote_id + org_id.
--
--   Changes: 1 function body replaced. No table / column / row / trigger changed or deleted.
--   Additive + idempotent (create or replace). Safe to run twice. REQUIRES 0070 (+ 0069 helpers).

create or replace function public._bk_payments(p_quote uuid, p_org uuid, p_base jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-payments-0070 / invoice-total-0111
declare q public.quotes; v_total numeric; v_paid numeric; v_rc jsonb;
begin
  select * into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if q.id is null then return p_base; end if;
  v_total := public._pkg_total(q.pricing);
  if v_total > 0 then   -- 0111: invoice = quote + approved change orders (0110 rule)
    v_total := v_total + coalesce((select round(sum(coalesce(c.price_delta, 0)), 2)
                                     from public.change_requests c
                                    where c.quote_id = q.id and c.status = 'approved'), 0);
  end if;
  v_paid := public._pkg_paid(q.id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', left(pm.receipt_no, 60),
           'date', coalesce(pm.paid_at, pm.created_at),
           'amount', round(pm.amount, 2),
           'method', left(nullif(btrim(coalesce(pm.method, '')), ''), 40))
           order by coalesce(pm.paid_at, pm.created_at), pm.id), '[]'::jsonb)
    into v_rc from public.quote_payments pm
   where pm.quote_id = q.id and pm.org_id = q.org_id and pm.status = 'paid';
  return coalesce(p_base, '{}'::jsonb) || jsonb_build_object(
    'paid', v_paid, 'total', v_total, 'outstanding', round(v_total - v_paid, 2), 'receipts', v_rc);
end $$;

do $$ begin
  execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from authenticated'; end if;
end $$;

commit;

-- ---- VERIFY (expect every ok = true) ----
select '_bk_payments includes approved changes' as item, pg_get_functiondef('public._bk_payments(uuid, uuid, jsonb)'::regprocedure) like '%invoice-total-0111%' as ok
union all
select '_bk_payments keeps receipts', pg_get_functiondef('public._bk_payments(uuid, uuid, jsonb)'::regprocedure) like '%receipts%'
union all
select 'booklet reader still installed', to_regprocedure('public.public_get_booklet(uuid)') is not null
union all
select 'anon cannot run _bk_payments', not has_function_privilege('anon','public._bk_payments(uuid, uuid, jsonb)','execute')
union all
select 'studio users cannot run _bk_payments', not has_function_privilege('authenticated','public._bk_payments(uuid, uuid, jsonb)','execute')
union all
select 'anon can still open booklets', has_function_privilege('anon','public.public_get_booklet(uuid)','execute');
