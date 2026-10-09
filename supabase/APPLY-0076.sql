-- APPLY-0076.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0076_insights.sql verbatim.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: one CREATE OR REPLACE FUNCTION (read-only) + grants. No row is changed.
-- AFTER APPLYING: admins always see Insights. For any other role, an admin ticks
-- Control Center > Users & access > "Insights" (view). Money figures additionally need "Budget & finance".
-- EXPECTED: the last result grid (item, ok) has 5 rows and EVERY ok = true.

-- 0076_insights.sql - CANONICAL forward-only. Date-ranged studio insights (read-only).
--
-- In plain words:
--   insights_range(from, to) returns one JSON summary for the caller's own studio, for the
--   events whose event date (or, when no date is set yet, the day they were created in the
--   studio's time zone) falls inside [from, to]:
--     * counts: total / confirmed / completed (settlement or closed) / cancelled / open quotes
--     * money (confirmed events only, same rules as the Budget + Settlement screens):
--         revenue  = quote total + approved change-order price deltas
--         cost     = per cost line the actual where entered else the estimate
--                    + approved change-order cost deltas + vendor bookings not yet imported
--         expenses = paid expense claims
--         profit   = revenue - cost - expenses ; margin % = profit / revenue
--         collected = paid rows of the quote_payments ledger (paid milestones only when the
--                    event has no ledger rows at all) ; outstanding = revenue - collected (>= 0)
--         cash_in_range = ledger receipts whose paid_at falls in the range (any event)
--     * top event types (count + revenue)
--     * staff participation: per in-house crew member (event_tasks.crew_id, else the typed
--       name) and per event manager (quotes.manager_id), the distinct events they worked on,
--       their task counts and the event list for the drill-down.
--   Access: the caller must have the new "insights" area (role_access matrix; admins always).
--   Money figures are returned as null unless the caller also has the "finance" area.
--   No role_access rows are seeded (owner decision D2: nobody gains access silently) - an
--   admin ticks "Insights" for the roles that should see it in Control Center.
--
-- Additive + idempotent: one new function (create or replace). No table, no column, no row
-- is created, changed or deleted.
-- ============================================================================

create or replace function public.insights_range(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_fin boolean;
  v_tz text;
  v_from date := coalesce(p_from, date '2000-01-01');
  v_to date := coalesce(p_to, date '2100-12-31');
  v_counts jsonb; v_money jsonb; v_types jsonb; v_staff jsonb; v_cash numeric;
begin
  -- insights-range-0076
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  v_fin := public.has_area('finance', 'view');
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  with ev0 as (
    select q.id, q.code, q.title, nullif(btrim(coalesce(q.event_type, '')), '') as event_type, q.status,
           coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.event_date, (q.created_at at time zone v_tz)::date) as d, q.manager_id,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org
       and coalesce(q.event_date, (q.created_at at time zone v_tz)::date) between v_from and v_to
       and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
  ), ev as (
    select e.*,
      e.base + coalesce((select sum(c.price_delta) from public.change_requests c
                          where c.quote_id = e.id and c.org_id = v_org and c.status = 'approved'), 0) as revenue,
      coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k where k.quote_id = e.id and k.org_id = v_org), 0)
        + coalesce((select sum(c.cost_delta) from public.change_requests c
                     where c.quote_id = e.id and c.org_id = v_org and c.status = 'approved'), 0)
        + coalesce((select sum(b.cost) from public.event_resources b
                     where b.quote_id = e.id and b.org_id = v_org and b.status <> 'cancelled' and b.cost is not null
                       and not exists (select 1 from public.event_costs k2 where k2.quote_id = e.id and k2.booking_id = b.id)), 0) as cost,
      coalesce((select sum(x.amount) from public.expense_claims x
                 where x.quote_id = e.id and x.org_id = v_org and x.status = 'paid'), 0) as expenses,
      case
        when exists (select 1 from public.quote_payments p where p.quote_id = e.id and p.org_id = v_org)
          then coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id = e.id and p.org_id = v_org and p.status = 'paid'), 0)
        else coalesce((select sum(m.amount) from public.payment_milestones m where m.quote_id = e.id and m.org_id = v_org and m.status = 'paid'), 0)
      end as collected
    from ev0 e
  ), part as (
    select coalesce('c:' || t.crew_id::text, 'n:' || lower(btrim(t.assignee_name))) as k,
           coalesce(max(cm.name), max(btrim(t.assignee_name))) as nm, 'crew' as kind,
           e.id as qid, e.code, e.title, e.d, count(*) as tasks, count(*) filter (where t.status = 'completed') as done
      from ev0 e
      join public.event_tasks t on t.quote_id = e.id and t.org_id = v_org
      left join public.crew_members cm on cm.id = t.crew_id and cm.org_id = v_org
     where e.status <> 'cancelled' and coalesce(t.assignee_kind, 'in_house') <> 'outsourced'
       and (t.crew_id is not null or nullif(btrim(coalesce(t.assignee_name, '')), '') is not null)
     group by 1, e.id, e.code, e.title, e.d
    union all
    select 'u:' || e.manager_id::text, coalesce(nullif(btrim(pr.full_name), ''), nullif(split_part(coalesce(pr.email, ''), '@', 1), ''), 'Manager'),
           'manager', e.id, e.code, e.title, e.d, 0, 0
      from ev0 e
      join public.profiles pr on pr.id = e.manager_id and pr.org_id = v_org
     where e.status <> 'cancelled' and e.manager_id is not null
  )
  select
    (select jsonb_build_object(
       'total', count(*),
       'confirmed', count(*) filter (where status = 'confirmed'),
       'completed', count(*) filter (where status <> 'cancelled' and stage in ('settlement', 'closed')),
       'cancelled', count(*) filter (where status = 'cancelled'),
       'open_quotes', count(*) filter (where status = 'quote')) from ev0),
    case when v_fin then (select jsonb_build_object(
       'events', count(*),
       'revenue', coalesce(sum(revenue), 0),
       'cost', coalesce(sum(cost), 0),
       'expenses', coalesce(sum(expenses), 0),
       'profit', coalesce(sum(revenue - cost - expenses), 0),
       'margin_pct', case when coalesce(sum(revenue), 0) <> 0 then round(sum(revenue - cost - expenses) / sum(revenue) * 100) end,
       'collected', coalesce(sum(collected), 0),
       'outstanding', coalesce(sum(greatest(revenue - collected, 0)), 0),
       'avg_event_value', case when count(*) > 0 then round(sum(revenue) / count(*)) end)
       from ev where status = 'confirmed') end,
    (select coalesce(jsonb_agg(t order by (t ->> 'count')::int desc, t ->> 'type'), '[]'::jsonb) from (
       select jsonb_build_object('type', coalesce(event_type, 'Other'), 'count', count(*),
                'revenue', case when v_fin then coalesce(sum(revenue) filter (where status = 'confirmed'), 0) end) as t
         from ev where status <> 'cancelled' group by coalesce(event_type, 'Other')) s),
    (select coalesce(jsonb_agg(x order by (x ->> 'events')::int desc, x ->> 'name'), '[]'::jsonb) from (
       select jsonb_build_object('key', k, 'name', max(nm), 'kind', min(kind), 'events', count(distinct qid),
                'tasks', sum(tasks), 'done', sum(done),
                'list', jsonb_agg(jsonb_build_object('id', qid, 'code', code, 'title', title, 'date', d, 'tasks', tasks, 'role', kind)
                                  order by d, code)) as x
         from part group by k) s)
    into v_counts, v_money, v_types, v_staff;

  if v_fin then
    select coalesce(sum(p.amount), 0) into v_cash from public.quote_payments p
     where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
       and (p.paid_at at time zone v_tz)::date between v_from and v_to;
    v_money := v_money || jsonb_build_object('cash_in_range', v_cash);
  end if;

  return jsonb_build_object('from', v_from, 'to', v_to, 'finance', v_fin, 'counts', v_counts,
    'money', v_money, 'types', v_types, 'staff', v_staff);
end $$;

revoke all on function public.insights_range(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.insights_range(date, date) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.insights_range(date, date) to authenticated;
  end if;
end $$;

-- =====================================================================================
-- VERIFY (expect 5 rows, ALL ok = true)
-- =====================================================================================
select item, ok from (values
  ('01 insights_range exists', (to_regprocedure('public.insights_range(date, date)') is not null)),
  ('02 security definer + search_path empty', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.insights_range(date, date)')), false))),
  ('03 gated on insights area + finance masking', (coalesce((select p.prosrc like '%has_area(''insights'', ''view'')%' and p.prosrc like '%has_area(''finance'', ''view'')%' and p.prosrc like '%insights-range-0076%' from pg_proc p where p.oid = to_regprocedure('public.insights_range(date, date)')), false))),
  ('04 tenant scoped (current_org_id)', (coalesce((select p.prosrc like '%q.org_id = v_org%' and p.prosrc like '%current_org_id()%' from pg_proc p where p.oid = to_regprocedure('public.insights_range(date, date)')), false))),
  ('05 authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.insights_range(date, date)', 'execute') and not has_function_privilege('anon', 'public.insights_range(date, date)', 'execute'), false)))
) v(item, ok)
order by item;
