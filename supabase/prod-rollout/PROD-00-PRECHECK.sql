-- PROD-00-PRECHECK — run FIRST in the PRODUCTION SQL editor. READ-ONLY.
-- Shows ONLY the counts that would BLOCK the W16-01 CHECK constraints.
-- Every "rows" value should be 0. (PROD-01 now auto-clamps negative inventory,
-- so those two can be non-zero and it will still succeed; but a non-zero
-- quote_payments count needs a manual look — PROD-01 will SKIP that one constraint
-- with a NOTICE rather than fail.)
select 'inventory_items.total_qty < 0'  as blocker, count(*) as rows from public.inventory_items where total_qty < 0
union all
select 'inventory_items.unit_cost < 0',            count(*) from public.inventory_items where unit_cost is not null and unit_cost < 0
union all
select 'quote_payments.amount <= 0',              count(*) from public.quote_payments where amount <= 0;
