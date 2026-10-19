-- 0240_insights_event_costs.sql - CANONICAL forward-only.
-- REQUIRES phase29 / phase57 (has_area), 0094 (insights_events: same event filter), 0101 (_r101_quote_tax),
--          0124 + 0142 + 0146 (_vb_event_pnl: the ONE per-event profit Settlement / Closure / Business use).
--
-- In plain words (owner, r21: "per-event costs and expenses as interactive graphs" + "benchmarks for each event"):
--   1  ONE NEW read-only function insights_event_costs(from, to) for the Insights page. For every confirmed
--      event dated in the period (same events as the "Profit per event" table: not deleted, not a lead /
--      discovery / proposal) it returns the event's revenue (ex-tax), profit and margin from _vb_event_pnl -
--      so the numbers match Settlement, Closure and the Business page - and splits the cost into:
--        vendors         vendor bills / bookings / vendor cost lines (one source per booking, as event_pnl)
--        crew            cost lines that read like staff / crew / labour / security (Budget page lines)
--        logistics       cost lines that read like transport / delivery / travel / generator / fuel
--        rentals         cost lines that read like rent / hire / inventory / chairs / tents / linen
--        change_orders   cost of approved change orders
--        other_costs     every other non-vendor cost line (miscellaneous)
--        expense_claims  paid staff expense claims
--        refunds         processed refunds to the client (they come off profit, as in event_pnl)
--      vendors + crew + logistics + rentals + change_orders + other_costs + expense_claims + refunds = cost_total
--      and revenue - cost_total = profit (= event_pnl net_profit). Plus event type, guest count (pricing.guests,
--      else client.guests), collected (payment ledger, else paid milestones - same rule as insights_events) and
--      outstanding (amount due incl. tax minus collected, never below 0).
--   2  Access: signed in, a studio member, the 'insights' area (admin only by default, unchanged); money only
--      with 'finance' too - without it the list is empty and finance = false. Only the caller's own studio
--      (every read is filtered by current_org_id()).
--   Changes: 1 new function. No table / column / policy / row is created, changed or deleted. Additive +
--   idempotent (create or replace). Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): drop function public.insights_event_costs(date, date);
--   the Insights page then shows "needs database update 0240" on the new charts and everything else keeps working.

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP: phase29 / phase57 (has_area, current_org_id) is not applied'; end if;
  if to_regprocedure('public.insights_events(date,date)') is null then raise exception 'STOP: 0077 / 0094 (insights_events) is not applied'; end if;
  if to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null then raise exception 'STOP: 0124 (_vb_event_pnl) is not applied'; end if;
  if position('v_refunds' in (select prosrc from pg_proc where oid = to_regprocedure('public._vb_event_pnl(uuid,uuid)'))) = 0 then
    raise exception 'STOP: 0146 (_vb_event_pnl with refunds) is not applied'; end if;
end $$;

create or replace function public.insights_event_costs(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- insights-event-costs-0240
declare
  v_org uuid := public.current_org_id();
  v_tz text;
  v_from date := coalesce(p_from, date '2000-01-01');
  v_to date := coalesce(p_to, date '2100-12-31');
  q record; p jsonb; v_rows jsonb := '[]'::jsonb;
  v_rev numeric; v_tax numeric; v_vendor numeric; v_other numeric; v_staff numeric; v_refunds numeric; v_net numeric;
  v_crew numeric; v_logi numeric; v_rent numeric; v_chg numeric; v_misc numeric; v_col numeric; v_guests int;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if not public.has_area('finance', 'view') then
    return jsonb_build_object('from', v_from, 'to', v_to, 'finance', false, 'events', '[]'::jsonb);
  end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  for q in
    select x.id, x.code, x.title, coalesce(x.lifecycle_stage, 'quote') as stage,
           coalesce(x.event_date, (x.created_at at time zone v_tz)::date) as d,
           nullif(btrim(coalesce(x.event_type, '')), '') as etype,
           case when coalesce(x.pricing ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (x.pricing ->> 'guests')::int > 0 then (x.pricing ->> 'guests')::int
                when coalesce(x.client ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (x.client ->> 'guests')::int > 0 then (x.client ->> 'guests')::int end as guests
      from public.quotes x
     where x.org_id = v_org and x.deleted_at is null and x.status = 'confirmed'
       and coalesce(x.event_date, (x.created_at at time zone v_tz)::date) between v_from and v_to
       and coalesce(x.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
     order by 5, 2 limit 500
  loop
    p := public._vb_event_pnl(q.id, v_org);
    continue when p is null;
    v_rev := coalesce((p ->> 'revenue')::numeric, 0); v_tax := coalesce((p ->> 'tax')::numeric, 0);
    v_vendor := coalesce((p ->> 'vendors')::numeric, 0); v_other := coalesce((p ->> 'other')::numeric, 0);
    v_staff := coalesce((p ->> 'staff')::numeric, 0); v_refunds := coalesce((p ->> 'refunds')::numeric, 0);
    v_net := coalesce((p ->> 'net_profit')::numeric, v_rev - v_vendor - v_other - v_staff - v_refunds);
    -- the non-vendor cost lines event_pnl counts as "other" (not tied to an active booking), by what they read like
    select coalesce(sum(case when t.k = 'logistics' then t.a end), 0), coalesce(sum(case when t.k = 'crew' then t.a end), 0),
           coalesce(sum(case when t.k = 'rentals' then t.a end), 0)
      into v_logi, v_crew, v_rent
      from (select coalesce(k.actual, k.estimated) as a,
                   case when lower(coalesce(k.category, '') || ' ' || coalesce(k.description, '')) ~ '(logistic|transport|truck|tempo|vehicle|deliver|travel|parking|valet|generator|fuel|diesel|cartage|freight|courier)' then 'logistics'
                        when lower(coalesce(k.category, '') || ' ' || coalesce(k.description, '')) ~ '(staff|crew|waiter|manpower|security|bouncer|labou?r|helper|coordinator|anchor|emcee|salary|wage|day rate)' then 'crew'
                        when lower(coalesce(k.category, '') || ' ' || coalesce(k.description, '')) ~ '(rent|hire|inventory|equipment|chair|furniture|\mtables?\M|tent|shamiana|linen|crockery|cutlery)' then 'rentals'
                        else 'other' end as k
              from public.event_costs k
             where k.quote_id = q.id and k.org_id = v_org and k.kind <> 'vendor'
               and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')) t;
    v_chg := coalesce((select sum(c.cost_delta) from public.change_requests c
                        where c.quote_id = q.id and c.org_id = v_org and c.status = 'approved'), 0);
    v_misc := v_other - v_logi - v_crew - v_rent - v_chg;   -- = the unmatched lines, so the parts add up to event_pnl
    v_col := case
      when exists (select 1 from public.quote_payments pm where pm.quote_id = q.id and pm.org_id = v_org)
        then coalesce((select sum(pm.amount) from public.quote_payments pm where pm.quote_id = q.id and pm.org_id = v_org and pm.status = 'paid'), 0)
      else coalesce((select sum(m.amount) from public.payment_milestones m where m.quote_id = q.id and m.org_id = v_org and m.status = 'paid'), 0) end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', q.id, 'code', q.code, 'title', q.title, 'date', q.d, 'stage', q.stage, 'event_type', q.etype, 'guests', q.guests,
      'currency', coalesce(p ->> 'currency', 'INR'),
      'revenue', round(v_rev, 2), 'tax', round(v_tax, 2),
      'vendors', round(v_vendor, 2), 'crew', round(v_crew, 2), 'logistics', round(v_logi, 2), 'rentals', round(v_rent, 2),
      'change_orders', round(v_chg, 2), 'other_costs', round(v_misc, 2), 'expense_claims', round(v_staff, 2), 'refunds', round(v_refunds, 2),
      'cost_total', round(v_vendor + v_other + v_staff + v_refunds, 2),
      'profit', round(v_net, 2), 'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
      'collected', round(v_col, 2), 'outstanding', round(greatest(v_rev + v_tax - v_col, 0), 2)));
  end loop;

  return jsonb_build_object('from', v_from, 'to', v_to, 'finance', true, 'events', v_rows);
end $$;

revoke all on function public.insights_event_costs(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_event_costs(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_event_costs(date, date) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.insights_event_costs(date, date) to service_role'; end if;
end $$;
