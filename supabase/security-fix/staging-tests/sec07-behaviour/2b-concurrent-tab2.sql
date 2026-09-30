-- SEC-07 v2 BEHAVIOUR — BLOCK 2B (TAB 2): start within 20 s of TAB 1. Sends a 4th code to the same number.
-- It must WAIT for TAB 1, then FAIL with "too many codes sent to this number".
begin;
insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
values ('ee5ec07e-0000-4000-8000-00000000c002','(+91) 90000-12345','x',now()+interval '10 min','ee5ec07e-0000-4000-8000-00000000000a');
commit;
select case when count(*) > 3 then 'FAIL: 4th code was accepted' else 'no 4th code stored' end as tab2, clock_timestamp() as at
  from public.quote_otps where quote_id = 'ee5ec07e-0000-4000-8000-00000000c002' and regexp_replace(phone,'[^0-9]','','g') = '919000012345';
