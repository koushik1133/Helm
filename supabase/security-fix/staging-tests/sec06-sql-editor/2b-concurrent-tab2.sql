-- BLOCK 2B — TAB 2: start within 20 s of TAB 1. It WAITS on TAB 1's row lock, then must fail.
begin;
select set_config('request.jwt.claim.sub','ee5ec06e-0000-4000-8000-0000000000a1',true),
       set_config('request.jwt.claims','{"sub":"ee5ec06e-0000-4000-8000-0000000000a1","role":"authenticated"}',true);
set local role authenticated;
select 'TAB 2' as tab, (public.return_reservation('ee5ec06e-0000-4000-8000-00000000e002', 2)).status as result, clock_timestamp() as at;
commit;
