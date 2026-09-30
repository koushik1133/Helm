-- BLOCK 2A — TAB 1: returns reservation e002 (damaged 2) and HOLDS the transaction open 20 s.
begin;
select set_config('request.jwt.claim.sub','ee5ec06e-0000-4000-8000-0000000000a1',true),
       set_config('request.jwt.claims','{"sub":"ee5ec06e-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
set local role authenticated;
select 'TAB 1' as tab, (public.return_reservation('ee5ec06e-0000-4000-8000-00000000e002', 2)).status as result, clock_timestamp() as at;
select pg_sleep(20);
commit;
select 'TAB 1 committed' as tab, clock_timestamp() as at;
