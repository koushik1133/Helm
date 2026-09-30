-- SEC-07 v2 BEHAVIOUR — BLOCK 2A (TAB 1): sends the 3rd code to +91 90000 12345 and HOLDS the transaction 20 s.
begin;
select 'TAB 1' as tab, clock_timestamp() as started;
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
values ('ee5ec07e-0000-4000-8000-00000000c002','+91-9000012345','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a');
select pg_sleep(20);
commit;
select 'TAB 1 committed (3rd code accepted)' as tab, clock_timestamp() as at;
