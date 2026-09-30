-- BLOCK 3 — after both tabs finished
select 'reservation e002' as what, status as value, case when status='returned' then 'PASS' else 'FAIL' end as result
  from public.inventory_reservations where id='ee5ec06e-0000-4000-8000-00000000e002'
union all
select 'stock (expect 5 = 7-2, one deduction)', total_qty::text, case when total_qty=5 then 'PASS' else 'FAIL' end
  from public.inventory_items where id='ee5ec06e-0000-4000-8000-00000000d001';
