-- g4-coverage.sql — catalog-wide coverage for the G4 quote<->org integrity trigger.
-- Asserts: every public base table carrying BOTH quote_id and org_id (except the
-- documented allow-dangling audit_log/lead_archive) has the zz_quote_org_match
-- trigger, and the trigger function is SECURITY DEFINER. Requires 0004 applied.
set client_min_messages = warning;

-- 1) expected set vs installed set
with expected as (
  select c.table_name
  from information_schema.columns c
  join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
  join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
  where c.table_schema='public' and c.column_name='quote_id'
    and c.table_name not in ('quotes','audit_log','lead_archive')
),
installed as (
  select c.relname as table_name
  from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where tg.tgname='zz_quote_org_match' and n.nspname='public'
)
select
  (select count(*) from expected) as expected_tables,
  (select count(*) from installed) as installed_triggers,
  (select count(*) from expected e where not exists (select 1 from installed i where i.table_name=e.table_name)) as missing,
  case when (select count(*) from expected e where not exists (select 1 from installed i where i.table_name=e.table_name))=0
       then 'G4-COVERAGE: ALL expected tables protected' else 'G4-COVERAGE: MISSING triggers' end as coverage_result;

-- 2) list any missing (should be empty)
select 'MISSING: '||e.table_name
from information_schema.columns c
join information_schema.columns o on o.table_name=c.table_name and o.column_name='org_id'
join information_schema.tables t on t.table_name=c.table_name and t.table_type='BASE TABLE'
cross join lateral (select c.table_name) e
where c.table_schema='public' and c.column_name='quote_id'
  and c.table_name not in ('quotes','audit_log','lead_archive')
  and not exists (select 1 from pg_trigger tg join pg_class k on k.oid=tg.tgrelid join pg_namespace n on n.oid=k.relnamespace
                  where tg.tgname='zz_quote_org_match' and n.nspname='public' and k.relname=c.table_name);

-- 3) trigger function must be SECURITY DEFINER (else RLS hides the victim quote)
select case when (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='tg_quote_org_match')
            then 'G4-DEFINER: tg_quote_org_match is SECURITY DEFINER'
            else 'G4-DEFINER: FAIL not definer' end;
