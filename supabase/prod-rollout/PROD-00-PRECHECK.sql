-- PROD-00-PRECHECK — run FIRST in the PRODUCTION SQL editor. READ-ONLY. Reports
-- whether it is safe to add the W16 CHECK constraints and what is already applied.
-- If any *_violations count is > 0, CLEAN those rows before running PROD-01.
select 'inventory_items.total_qty < 0' as check, count(*) as violations from public.inventory_items where total_qty < 0
union all select 'inventory_items.unit_cost < 0', count(*) from public.inventory_items where unit_cost < 0
union all select 'quote_payments.amount <= 0', count(*) from public.quote_payments where amount <= 0
union all select 'quote_payments overpaid (paid>total+0.5)',
  (select count(*) from (
     select p.quote_id, sum(p.amount) paid, max((q.pricing->>'total')::numeric) tot
     from public.quote_payments p join public.quotes q on q.id=p.quote_id
     where p.status='paid' group by p.quote_id
   ) s where s.tot is not null and s.tot>0 and s.paid > s.tot + 0.5);
-- current state (informational)
select 'helm_quote_total present' as item, count(*)::text as val from pg_proc where proname='helm_quote_total'
union all select 'trg_no_overpayment present', count(*)::text from pg_trigger where tgname='trg_no_overpayment'
union all select 'W16 checks present', count(*)::text from pg_constraint where conname in ('inventory_items_total_qty_nonneg','inventory_items_unit_cost_nonneg','quote_payments_amount_pos')
union all select 'manager in can_create', case when pg_get_functiondef((select oid from pg_proc where proname='can_create' limit 1)) ilike '%manager%' then 'yes' else 'no' end
union all select 'manager in can_edit', case when pg_get_functiondef((select oid from pg_proc where proname='can_edit' limit 1)) ilike '%manager%' then 'yes' else 'no' end;
