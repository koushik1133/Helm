-- BLOCK 5 — CLEANUP: removes every row the test created (test studios only)
reset role;
do $$ declare r record; begin
  for r in select c.table_name from information_schema.columns c
             join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
            where c.table_schema='public' and c.column_name='org_id' and c.table_name not in ('quotes','organizations','profiles')
  loop execute format('delete from public.%I where org_id in (%L,%L)', r.table_name,
                      'ee5ec06e-0000-4000-8000-00000000000a','ee5ec06e-0000-4000-8000-00000000000b'); end loop;
end $$;
delete from public.quotes where org_id in ('ee5ec06e-0000-4000-8000-00000000000a','ee5ec06e-0000-4000-8000-00000000000b');
delete from public.profiles where id in ('ee5ec06e-0000-4000-8000-0000000000a1','ee5ec06e-0000-4000-8000-0000000000b1');
delete from public.organizations where id in ('ee5ec06e-0000-4000-8000-00000000000a','ee5ec06e-0000-4000-8000-00000000000b');
delete from auth.users where id in ('ee5ec06e-0000-4000-8000-0000000000a1','ee5ec06e-0000-4000-8000-0000000000b1');
select 'leftover test rows (expect 0)' as check,
  (select count(*) from public.organizations where id::text like 'ee5ec06e%')
+ (select count(*) from public.quotes where id::text like 'ee5ec06e%')
+ (select count(*) from public.inventory_items where id::text like 'ee5ec06e%')
+ (select count(*) from public.inventory_reservations where id::text like 'ee5ec06e%')
+ (select count(*) from public.invitations where org_id::text like 'ee5ec06e%')
+ (select count(*) from auth.users where id::text like 'ee5ec06e%') as n;
