-- APPLY-0113.sql - paste into the Supabase SQL editor (staging first, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0113_insights_events_ex_tax.sql:
--   * insights_events_ex_tax - Insights per-event rows with tax / revenue / profit / margin ex-tax.
--   No table, column, row or trigger is changed or deleted. No temp tables, no session settings.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- 0113_insights_events_ex_tax.sql - CANONICAL forward-only.
--
-- In plain words:
--   Insights "Profit per event" used insights_events (0077/0094), whose revenue includes the
--   GST collected, so the GST was counted as profit: QA-E2E Full Run 2 showed revenue 4,38,600,
--   profit 4,01,800 (92%) while Settlement / Closure / the Insights header (ex-tax, 0101) say
--   3,72,000 revenue and 3,35,200 profit (90%).
--   Fix: a NEW wrapper insights_events_ex_tax(from, to) that returns the insights_events result
--   (every access check runs inside it) plus, per row, tax / revenue_ex_tax / profit_ex_tax /
--   margin_pct_ex_tax - the same _r101_quote_tax rule 0101 uses for the header. The page reads
--   the ex-tax fields when present and falls back to insights_events on an older database.
--
--   Changes: 1 new function. insights_events and every table / row are untouched.
--   Additive + idempotent (create or replace). Safe to run twice. REQUIRES 0094 + 0101.

create or replace function public.insights_events_ex_tax(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- insights-events-ex-tax-0113
declare
  r jsonb; v_org uuid := public.current_org_id(); out_rows jsonb := '[]'::jsonb;
  x jsonb; tx numeric; rev numeric; pro numeric;
begin
  r := public.insights_events(p_from, p_to);   -- every access check of 0094 runs here
  if r is null or jsonb_typeof(r) <> 'object' or not coalesce((r ->> 'finance')::boolean, false)
     or jsonb_typeof(r -> 'events') <> 'array' then return r; end if;
  for x in select e.value from jsonb_array_elements(r -> 'events') with ordinality as e(value, n) order by e.n loop
    rev := case when coalesce(x ->> 'revenue', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (x ->> 'revenue')::numeric end;
    pro := case when coalesce(x ->> 'profit', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (x ->> 'profit')::numeric end;
    if rev is not null and pro is not null and coalesce(x ->> 'id', '') ~ '^[0-9a-fA-F-]{36}$' then
      select public._r101_quote_tax(q.pricing,
               case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end)
        into tx from public.quotes q where q.id = (x ->> 'id')::uuid and q.org_id = v_org;
      tx := coalesce(tx, 0);
      x := x || jsonb_build_object('tax', tx, 'revenue_ex_tax', rev - tx, 'profit_ex_tax', pro - tx,
                 'margin_pct_ex_tax', case when rev - tx <> 0 then round((pro - tx) / (rev - tx) * 100) end);
    end if;
    out_rows := out_rows || jsonb_build_array(x);
  end loop;
  return r || jsonb_build_object('events', out_rows);
end $$;
revoke all on function public.insights_events_ex_tax(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_events_ex_tax(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_events_ex_tax(date, date) to authenticated'; end if;
end $$;

commit;

-- verify
select 'function exists' as item, to_regprocedure('public.insights_events_ex_tax(date,date)') is not null as ok
union all
select 'body marker present', exists(select 1 from pg_proc where proname='insights_events_ex_tax' and prosrc like '%insights-events-ex-tax-0113%')
union all
select 'authenticated can execute', has_function_privilege('authenticated','public.insights_events_ex_tax(date,date)','execute')
union all
select 'anon cannot execute', not has_function_privilege('anon','public.insights_events_ex_tax(date,date)','execute')
union all
select 'insights_events still present', to_regprocedure('public.insights_events(date,date)') is not null;
