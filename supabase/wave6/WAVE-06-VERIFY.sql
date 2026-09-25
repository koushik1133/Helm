-- ============================================================================
-- WAVE-06-VERIFY.sql  — READ ONLY. Run AFTER WAVE-06-UPGRADE.sql.
-- Proves the D8 server-pricing-authority objects exist and behave. The functional
-- rows use helm_quote_total() (a pure function) so they need no data and mutate
-- nothing. Every row should read PASS.
-- ============================================================================
with v as (
  select 'D8' area,'helm_quote_total() present' check_name,'yes' expected,
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='helm_quote_total') then 'yes' else 'no' end actual
  union all
  select 'D8','helm_quote_total not executable by anon','yes',
         case when not exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='helm_quote_total' and grantee='anon') then 'yes' else 'no' end
  union all
  select 'D8','enforce_pricing_total trigger present','yes',
         case when exists (select 1 from pg_trigger where tgname='quotes_enforce_pricing_total' and not tgisinternal) then 'yes' else 'no' end
  union all
  select 'D8','trigger fires on INSERT and UPDATE','yes',
         case when (select (tgtype & 4)=4 /*insert*/ and (tgtype & 16)=16 /*update*/
                    from pg_trigger where tgname='quotes_enforce_pricing_total') then 'yes' else 'no' end
  union all
  select 'D8','save_quotation_version uses helm_quote_total','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version'
              and pg_get_functiondef(p.oid) ilike '%helm_quote_total%') then 'yes' else 'no' end
  union all
  select 'D8','save_quotation_version still anon-revoked (Wave5 preserved)','yes',
         case when not exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='save_quotation_version' and grantee='anon') then 'yes' else 'no' end
  -- functional (pure-function) checks: post-discount GST, single rate, rounding
  union all
  select 'D8','formula: 165000 - 5000 @18% = 188800','188800',
         public.helm_quote_total('{"subtotal":165000,"discount":5000,"gstPct":18,"total":1}'::jsonb)::text
  union all
  select 'D8','formula: discount capped at subtotal (=> 0)','0',
         public.helm_quote_total('{"subtotal":1000,"discount":99999,"gstPct":18,"total":123}'::jsonb)::text
  union all
  select 'D8','formula: legacy (no components) keeps its total','777',
         public.helm_quote_total('{"total":777}'::jsonb)::text
)
select area, check_name, expected, actual,
       case when actual = expected then 'PASS' else 'FAIL' end as status
from v order by check_name;

-- Negative components must raise (run separately; expect an error, not a row):
-- select public.helm_quote_total('{"subtotal":-1,"discount":0,"gstPct":18}'::jsonb);
