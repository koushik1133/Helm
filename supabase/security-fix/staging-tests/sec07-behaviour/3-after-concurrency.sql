-- SEC-07 v2 BEHAVIOUR — BLOCK 3: after both tabs finished. Exactly 3 codes to that number in the last hour.
select 'codes to 919000012345 in last hour (expect 3)' as what, count(*)::text as value,
       case when count(*) = 3 then 'PASS' else 'FAIL' end as result
  from public.quote_otps
 where regexp_replace(phone,'[^0-9]','','g') = '919000012345' and created_at > now() - interval '1 hour'
   and quote_id = 'ee5ec07e-0000-4000-8000-00000000c002';
