-- ============================================================================
-- WAVE-06-PREFLIGHT.sql  — READ ONLY. Run BEFORE WAVE-06-UPGRADE.sql.
-- Reports whether the D8 server-pricing-authority objects already exist and
-- whether the DB is ready. SELECT-only; no mutation.
-- ============================================================================
with checks as (
  select 'DEP' area, 'quotes.pricing column' item, 'present' expected,
         case when exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='quotes' and column_name='pricing')
              then 'present' else 'MISSING (need base schema)' end actual
  union all
  select 'DEP','save_quotation_version(2-arg) present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version' and p.pronargs=2)
              then 'present' else 'MISSING (run phase77 first)' end
  union all
  select 'DEP','current_org_id() present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='current_org_id') then 'present' else 'MISSING (phase56)' end
  union all
  select 'D8','helm_quote_total() fn','present after upgrade',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='helm_quote_total') then 'ALREADY PRESENT' else 'not yet (will be added)' end
  union all
  select 'D8','quotes_enforce_pricing_total trigger','present after upgrade',
         case when exists (select 1 from pg_trigger where tgname='quotes_enforce_pricing_total' and not tgisinternal)
              then 'ALREADY PRESENT' else 'not yet (will be added)' end
  union all
  select 'D8','save_quotation_version already server-authoritative','yes after upgrade',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version'
              and pg_get_functiondef(p.oid) ilike '%helm_quote_total%')
              then 'ALREADY UPGRADED' else 'not yet (client total trusted)' end
  union all
  -- Informational: how many existing quotes would change total if backfilled.
  select 'DATA','quotes whose stored total != recompute (informational)','(any)',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='helm_quote_total')
              then '(re-run after upgrade to count)' else 'run upgrade first' end
)
select area, item, expected, actual,
       case when actual like 'MISSING%' then 'BLOCKER'
            when actual like 'not yet%' then 'NEEDS UPGRADE'
            when actual like 'ALREADY%' then 'PRESENT'
            else 'INFO' end as status
from checks order by area, item;
