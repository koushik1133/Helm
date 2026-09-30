-- SEC-07 v2 BEHAVIOUR — BLOCK 4: CLEANUP. Removes every row the tests created (test studios ee5ec07e… only).
reset role;
select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claims','',false);
do $$ declare r record; begin
  for r in select c.table_name from information_schema.columns c
             join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
            where c.table_schema='public' and c.column_name='org_id' and c.table_name not in ('quotes','organizations','profiles')
  loop execute format('delete from public.%I where org_id in (%L,%L)', r.table_name,
                      'ee5ec07e-0000-4000-8000-00000000000a','ee5ec07e-0000-4000-8000-00000000000b'); end loop;
end $$;
delete from public.quotes where org_id in ('ee5ec07e-0000-4000-8000-00000000000a','ee5ec07e-0000-4000-8000-00000000000b');
do $$ declare r record; begin   -- second pass: rows written by quote-delete triggers (audit etc.)
  for r in select c.table_name from information_schema.columns c
             join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
            where c.table_schema='public' and c.column_name='org_id' and c.table_name not in ('quotes','organizations','profiles')
  loop execute format('delete from public.%I where org_id in (%L,%L)', r.table_name,
                      'ee5ec07e-0000-4000-8000-00000000000a','ee5ec07e-0000-4000-8000-00000000000b'); end loop;
end $$;
delete from public.profiles where id in ('ee5ec07e-0000-4000-8000-0000000000a1','ee5ec07e-0000-4000-8000-0000000000b1');
delete from public.organizations where id in ('ee5ec07e-0000-4000-8000-00000000000a','ee5ec07e-0000-4000-8000-00000000000b');
delete from auth.users where id in ('ee5ec07e-0000-4000-8000-0000000000a1','ee5ec07e-0000-4000-8000-0000000000b1');
-- leftovers across EVERY public table with org_id, plus core rows and the G5 probe
with t as (select c.table_name from information_schema.columns c
             join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name and x.table_type='BASE TABLE'
            where c.table_schema='public' and c.column_name='org_id')
select 'leftover test rows (expect 0)' as check,
  (select coalesce(sum((xpath('/row/n/text()', query_to_xml(format(
     'select count(*) as n from public.%I where org_id::text like %L', table_name, 'ee5ec07e%'), false, true, '')))[1]::text::int), 0) from t)
+ (select count(*) from public.organizations where id::text like 'ee5ec07e%')
+ (select count(*) from public.profiles where id::text like 'ee5ec07e%')
+ (select count(*) from auth.users where id::text like 'ee5ec07e%')
+ (select count(*) from pg_proc where proname = 'zz_sec07_probe') as n;
