-- BLOCK 1 — TESTS 1, 2, 3, 5 (run as ONE script). An 'UNEXPECTED' error means a test failed.
select set_config('sec06.t1','',false), set_config('sec06.t2','',false), set_config('sec06.t3','',false), set_config('sec06.t5','',false);
select set_config('sec06.stock0', (select total_qty::text from public.inventory_items where id='ee5ec06e-0000-4000-8000-00000000d001'), false);
-- act as the Studio A admin
select set_config('request.jwt.claim.sub','ee5ec06e-0000-4000-8000-0000000000a1',false),
       set_config('request.jwt.claims','{"sub":"ee5ec06e-0000-4000-8000-0000000000a1","role":"authenticated"}',false);
set role authenticated;
-- TEST 1: damaged 5 > reserved 4 must be rejected
do $$ begin
  perform public.return_reservation('ee5ec06e-0000-4000-8000-00000000e001', 5);
  raise exception 'UNEXPECTED: test 1 accepted damaged > qty';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec06.t1', sqlerrm, false);
end $$;
-- TEST 2: valid damaged 3
select set_config('sec06.t2', (public.return_reservation('ee5ec06e-0000-4000-8000-00000000e001', 3)).status, false);
-- TEST 3: repeat return must be rejected
do $$ begin
  perform public.return_reservation('ee5ec06e-0000-4000-8000-00000000e001', 3);
  raise exception 'UNEXPECTED: test 3 accepted a repeat return';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec06.t3', sqlerrm, false);
end $$;
-- TEST 5: Studio B admin tries Studio A's second reservation
select set_config('request.jwt.claim.sub','ee5ec06e-0000-4000-8000-0000000000b1',false),
       set_config('request.jwt.claims','{"sub":"ee5ec06e-0000-4000-8000-0000000000b1","role":"authenticated"}',false);
do $$ begin
  perform public.return_reservation('ee5ec06e-0000-4000-8000-00000000e002', 1);
  raise exception 'UNEXPECTED: test 5 Org B returned Org A reservation';
exception when others then
  if sqlerrm like 'UNEXPECTED%' then raise; end if;
  perform set_config('sec06.t5', sqlerrm, false);
end $$;
reset role;
select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claims','',false);
-- RESULTS
select t.test, t.expected, t.actual, case when t.ok then 'PASS' else 'FAIL' end as result from (values
  ('1 damaged > qty rejected', 'error: between 0 and 4', current_setting('sec06.t1'), current_setting('sec06.t1') like '%between 0 and 4%'),
  ('1 reservation unchanged',  'reserved (before test 2)', 'checked by test 2 succeeding', current_setting('sec06.t2') = 'returned'),
  ('1 inventory unchanged',    'stock 10 before', current_setting('sec06.stock0'), current_setting('sec06.stock0') = '10'),
  ('2 valid return',           'returned', current_setting('sec06.t2'), current_setting('sec06.t2') = 'returned'),
  ('2+3 stock decreased once', '7 (10-3)', (select total_qty::text from public.inventory_items where id='ee5ec06e-0000-4000-8000-00000000d001'),
                                (select total_qty from public.inventory_items where id='ee5ec06e-0000-4000-8000-00000000d001') = 7),
  ('3 repeat return rejected', 'error: already returned', current_setting('sec06.t3'), current_setting('sec06.t3') like '%already returned%'),
  ('5 Org B denied',           'error: reservation not found', current_setting('sec06.t5'), current_setting('sec06.t5') like '%not found%'),
  ('5 Org A reservation unchanged', 'reserved', (select status from public.inventory_reservations where id='ee5ec06e-0000-4000-8000-00000000e002'),
                                (select status from public.inventory_reservations where id='ee5ec06e-0000-4000-8000-00000000e002') = 'reserved')
) as t(test, expected, actual, ok);
