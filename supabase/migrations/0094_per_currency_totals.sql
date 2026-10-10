-- 0094_per_currency_totals.sql - CANONICAL forward-only. Money totals per currency.
--
-- In plain words:
--   A studio can hold quotes in more than one currency (INR / AED / USD - each quote keeps its
--   own currency, quotes.currency, stamped by 0089 and backfilled by 0091). The reports that add
--   money across many events must never add rupees and dirhams together. This keeps every old
--   output field exactly as it was and ADDS per-currency figures next to it:
--     * insights_range: money_by_currency (revenue / cost / expenses / profit / margin /
--       collected / outstanding / average, one row per currency), types_by_currency
--       (revenue per event type per currency) and cash_by_currency (receipts in the range).
--     * insights_events: each event row now says its currency.
--     * client_timeline: totals.by_currency (quoted / paid / due per currency).
--   No currency conversion anywhere. Same security definer, empty search_path, access checks
--   and grants as before.
--
-- Additive + idempotent: create or replace of 3 read-only functions. NO table, NO column,
-- NO row is created, changed or deleted. Needs 0068, 0082, 0089, 0091.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.insights_range(date,date)') is null or to_regprocedure('public.insights_events(date,date)') is null then
    raise exception '0094: apply 0076/0077/0082 first (insights functions missing)';
  end if;
  if to_regprocedure('public.client_timeline(uuid,integer)') is null then raise exception '0094: apply 0062/0068 first (client_timeline missing)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'currency') then
    raise exception '0094: apply 0089_country_tax.sql + 0091 first (quotes.currency missing)';
  end if;
end $$;

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
  v_bycur jsonb; v_tbycur jsonb; v_cashcur jsonb;
begin
  -- insights-range-0076 + r4-0082: soft-deleted events excluded + per-currency-0094
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
           coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') as cur,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null
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
         from part group by k) s),
    -- 0094: the same money, one row per quote currency (never added across currencies)
    case when v_fin then (select coalesce(jsonb_agg(x order by (x ->> 'events')::int desc, x ->> 'currency'), '[]'::jsonb) from (
       select jsonb_build_object(
         'currency', cur, 'events', count(*),
         'revenue', coalesce(sum(revenue), 0), 'cost', coalesce(sum(cost), 0), 'expenses', coalesce(sum(expenses), 0),
         'profit', coalesce(sum(revenue - cost - expenses), 0),
         'margin_pct', case when coalesce(sum(revenue), 0) <> 0 then round(sum(revenue - cost - expenses) / sum(revenue) * 100) end,
         'collected', coalesce(sum(collected), 0),
         'outstanding', coalesce(sum(greatest(revenue - collected, 0)), 0),
         'avg_event_value', case when count(*) > 0 then round(sum(revenue) / count(*)) end) as x
         from ev where status = 'confirmed' group by cur) s) end,
    case when v_fin then (select coalesce(jsonb_agg(x order by x ->> 'type', x ->> 'currency'), '[]'::jsonb) from (
       select jsonb_build_object('type', coalesce(event_type, 'Other'), 'currency', cur,
                'revenue', coalesce(sum(revenue), 0)) as x
         from ev where status = 'confirmed' group by coalesce(event_type, 'Other'), cur) s) end
    into v_counts, v_money, v_types, v_staff, v_bycur, v_tbycur;

  if v_fin then
    select coalesce(sum(p.amount), 0) into v_cash from public.quote_payments p
     where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
       and (p.paid_at at time zone v_tz)::date between v_from and v_to;
    v_money := v_money || jsonb_build_object('cash_in_range', v_cash);
    select coalesce(jsonb_agg(jsonb_build_object('currency', c, 'amount', a) order by c), '[]'::jsonb) into v_cashcur from (
      select coalesce(nullif(upper(btrim(q.currency)), ''), nullif(upper(btrim(p.currency)), ''), 'INR') as c, sum(p.amount) as a
        from public.quote_payments p left join public.quotes q on q.id = p.quote_id and q.org_id = v_org
       where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
         and (p.paid_at at time zone v_tz)::date between v_from and v_to
       group by 1) s;
  end if;

  return jsonb_build_object('from', v_from, 'to', v_to, 'finance', v_fin, 'counts', v_counts,
    'money', v_money, 'types', v_types, 'staff', v_staff,
    'money_by_currency', v_bycur, 'types_by_currency', v_tbycur, 'cash_by_currency', v_cashcur);
end $$;

create or replace function public.insights_events(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_org uuid := public.current_org_id();
  v_fin boolean;
  v_tz text;
  v_from date := coalesce(p_from, date '2000-01-01');
  v_to date := coalesce(p_to, date '2100-12-31');
  v_rows jsonb;
begin
  -- insights-events-0077 + r4-0082: soft-deleted events excluded + per-currency-0094
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  v_fin := public.has_area('finance', 'view');
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  with ev0 as (
    select q.id, q.code, q.title, coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.event_date, (q.created_at at time zone v_tz)::date) as d,
           coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') as cur,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
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
                       and not exists (select 1 from public.event_costs k2 where k2.quote_id = e.id and k2.booking_id = b.id)), 0)
        + coalesce((select sum(x.amount) from public.expense_claims x
                     where x.quote_id = e.id and x.org_id = v_org and x.status = 'paid'), 0) as cost,
      case
        when exists (select 1 from public.quote_payments p where p.quote_id = e.id and p.org_id = v_org)
          then coalesce((select sum(p.amount) from public.quote_payments p where p.quote_id = e.id and p.org_id = v_org and p.status = 'paid'), 0)
        else coalesce((select sum(m.amount) from public.payment_milestones m where m.quote_id = e.id and m.org_id = v_org and m.status = 'paid'), 0)
      end as collected
    from ev0 e
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'code', code, 'title', title, 'date', d, 'stage', stage, 'currency', cur,
           'revenue', case when v_fin then revenue end,
           'cost', case when v_fin then cost end,
           'profit', case when v_fin then revenue - cost end,
           'margin_pct', case when v_fin and revenue <> 0 then round((revenue - cost) / revenue * 100) end,
           'collected', case when v_fin then collected end,
           'outstanding', case when v_fin then greatest(revenue - collected, 0) end)
         order by d, code), '[]'::jsonb)
    into v_rows
    from (select * from ev order by d, code limit 1000) s;

  return jsonb_build_object('from', v_from, 'to', v_to, 'finance', v_fin, 'events', v_rows);
end $$;



create or replace function public.client_timeline(p_ref uuid, p_limit integer default 300)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_role text;
  v_leads boolean; v_quotes boolean; v_fin boolean; v_media boolean; v_staff boolean;
  v_name text; v_phone text; v_email text; v_digits text; v_lname text;
  v_lead_ids uuid[] := '{}'; v_quote_ids uuid[] := '{}'; v_lim int;
  v_items jsonb := '[]'::jsonb; v_rows jsonb; v_status text; v_found boolean := false;
  v_quoted numeric; v_paid numeric; v_totals jsonb := null; v_sections text[] := '{}';
  v_bycur jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if not found or v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_ref is null then raise exception 'not found' using errcode = 'P0002'; end if;

  v_leads := public.has_area('leads', 'view');
  v_quotes := public.has_area('quotes', 'view');
  v_fin := public.has_area('finance', 'view');
  v_media := public.has_area('media', 'view');
  v_staff := public.has_area('staff', 'view');
  v_lim := greatest(1, least(500, coalesce(p_limit, 300)));

  -- 1. the anchor: a lead (leads area) or an event (quotes area) of this studio
  if v_leads then
    select l.name, l.phone, l.email into v_name, v_phone, v_email
      from public.leads l where l.id = p_ref and l.org_id = v_org;
    v_found := found;
  end if;
  if not v_found and v_quotes then
    select q.client ->> 'name', q.client ->> 'phone', q.client ->> 'email' into v_name, v_phone, v_email
      from public.quotes q where q.id = p_ref and q.org_id = v_org and q.deleted_at is null;
    v_found := found;
  end if;
  if not v_found then raise exception 'not found' using errcode = 'P0002'; end if;

  v_name := nullif(btrim(coalesce(v_name, '')), '');
  v_lname := lower(v_name);
  v_digits := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');
  if char_length(coalesce(v_digits, '')) < 7 then v_digits := null; end if;
  v_email := nullif(lower(btrim(coalesce(v_email, ''))), '');

  -- 2. the same person's leads and events (own studio only)
  select coalesce(array_agg(l.id), '{}') into v_lead_ids from public.leads l
   where l.org_id = v_org and (l.id = p_ref
      or (v_digits is not null and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = v_digits)
      or (v_email is not null and lower(btrim(coalesce(l.email, ''))) = v_email)
      or (v_lname is not null and lower(btrim(coalesce(l.name, ''))) = v_lname
          and (v_digits is null or char_length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) < 7)));
  select coalesce(array_agg(q.id), '{}') into v_quote_ids from public.quotes q
   where q.org_id = v_org and q.deleted_at is null and (q.id = p_ref
      or q.id in (select l.quote_id from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids))
      or (v_digits is not null and right(regexp_replace(coalesce(q.client ->> 'phone', ''), '\D', '', 'g'), 10) = v_digits)
      or (v_email is not null and lower(btrim(coalesce(q.client ->> 'email', ''))) = v_email)
      or (v_lname is not null and lower(btrim(coalesce(q.client ->> 'name', ''))) = v_lname
          and (v_digits is null or char_length(regexp_replace(coalesce(q.client ->> 'phone', ''), '\D', '', 'g')) < 7)));
  -- events linked from a matched lead pull that lead in too
  select coalesce(array_agg(distinct x), '{}') into v_lead_ids from (
    select unnest(v_lead_ids) x union
    select l.id from public.leads l where l.org_id = v_org and l.quote_id = any(v_quote_ids)) s;

  -- 3. timeline parts, each gated by the access matrix
  if v_leads then
    v_sections := v_sections || 'leads'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'leads', 'at', l.created_at, 'id', l.id,
               'title', 'Lead added: ' || coalesce(nullif(l.name, ''), 'lead'),
               'subtitle', concat_ws(' / ', nullif(l.status, ''), nullif(l.event_type, ''), nullif(l.source, ''), to_char(l.event_date, 'YYYY-MM-DD')),
               'link', 'leads.html?hs=' ) as j
        from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
      union all
      select jsonb_build_object('kind', 'leads', 'at', l.updated_at, 'id', l.id,
               'title', 'Lead status: ' || l.status, 'subtitle', coalesce(nullif(l.name, ''), ''),
               'link', 'leads.html?hs=')
        from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
         and l.updated_at is not null and l.updated_at > l.created_at + interval '1 minute' and nullif(l.status, '') is not null) s;
    v_items := v_items || v_rows;
    select l.status into v_status from public.leads l where l.org_id = v_org and l.id = any(v_lead_ids)
     order by l.updated_at desc nulls last limit 1;
  end if;

  if v_quotes then
    v_sections := v_sections || 'events'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'events', 'at', q.created_at, 'id', q.id,
               'title', 'Event created: ' || coalesce(nullif(q.title, ''), q.code),
               'subtitle', concat_ws(' / ', q.code, nullif(q.event_type, ''), to_char(q.event_date, 'YYYY-MM-DD')),
               'link', 'event.html?id=' || q.id::text) as j
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)
      union all
      select jsonb_build_object('kind', 'events', 'at', q.confirmed_at, 'id', q.id,
               'title', 'Event confirmed: ' || coalesce(nullif(q.title, ''), q.code),
               'subtitle', concat_ws(' / ', q.code, nullif(q.approval_status, '')),
               'link', 'event.html?id=' || q.id::text)
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids) and q.confirmed_at is not null
      union all
      select jsonb_build_object('kind', 'events', 'at', q.updated_at, 'id', q.id,
               'title', 'Status now: ' || coalesce(nullif(q.lifecycle_stage, ''), q.status),
               'subtitle', concat_ws(' / ', q.code, nullif(q.approval_status, '')),
               'link', 'event.html?id=' || q.id::text)
        from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids)
         and q.updated_at > q.created_at + interval '1 minute'
      union all
      select jsonb_build_object('kind', 'events', 'at', v.created_at, 'id', v.id,
               'title', 'Quote version ' || v.version_no || coalesce(': ' || nullif(v.label, ''), ''),
               'subtitle', q.code, 'link', 'event.html?id=' || q.id::text)
        from public.quote_versions v join public.quotes q on q.id = v.quote_id and q.org_id = v_org
       where v.org_id = v_org and v.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
    if cardinality(v_quote_ids) > 0 then   -- the latest event's stage wins over a lead status
      select coalesce(nullif(q.lifecycle_stage, ''), q.status) into v_status from public.quotes q
       where q.org_id = v_org and q.id = any(v_quote_ids) order by q.updated_at desc nulls last limit 1;
    end if;
    -- 0068: same fallback as the app (store-api mapQuoteSummary / budget.summary):
    -- pricing.total, then an older top-level total column if this database has one.
    select coalesce(sum(coalesce(
             case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric end,
             case when (to_jsonb(q) ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (to_jsonb(q) ->> 'total')::numeric end,
             0)), 0) into v_quoted
      from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids);
    v_totals := jsonb_build_object('quoted', round(v_quoted, 2), 'events', cardinality(v_quote_ids));
  end if;

  if v_fin then
    v_sections := v_sections || 'payments'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'payments', 'at', coalesce(pm.paid_at, pm.created_at), 'id', pm.id,
               'title', case when pm.status = 'paid' then 'Payment received' else 'Payment ' || pm.status end
                        || coalesce(' (' || pm.receipt_no || ')', ''),
               'subtitle', concat_ws(' / ', q.code, pm.currency || ' ' || to_char(pm.amount, 'FM999999999990.00'), nullif(pm.method, '')),
               'link', 'settlement.html?quote=' || q.id::text) as j
        from public.quote_payments pm join public.quotes q on q.id = pm.quote_id and q.org_id = v_org
       where pm.org_id = v_org and pm.quote_id = any(v_quote_ids)
      union all
      select jsonb_build_object('kind', 'payments', 'at', coalesce(m.paid_at, m.created_at), 'id', m.id,
               'title', 'Milestone: ' || coalesce(nullif(m.label, ''), 'payment') || ' (' || m.status || ')',
               'subtitle', concat_ws(' / ', q.code, to_char(m.amount, 'FM999999999990.00'), 'due ' || to_char(m.due_date, 'YYYY-MM-DD')),
               'link', 'settlement.html?quote=' || q.id::text)
        from public.payment_milestones m join public.quotes q on q.id = m.quote_id and q.org_id = v_org
       where m.org_id = v_org and m.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
    -- 0068: same rule as the settlement page (store-api settlement.summary), per event:
    -- the quote_payments LEDGER when that event has any ledger row, otherwise its paid milestones.
    select coalesce(sum(case
             when exists (select 1 from public.quote_payments x where x.org_id = v_org and x.quote_id = q.id)
               then (select coalesce(sum(pm.amount), 0) from public.quote_payments pm
                      where pm.org_id = v_org and pm.quote_id = q.id and pm.status = 'paid')
             else (select coalesce(sum(m.amount), 0) from public.payment_milestones m
                    where m.org_id = v_org and m.quote_id = q.id and m.status = 'paid') end), 0) into v_paid
      from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids);
    v_totals := coalesce(v_totals, '{}'::jsonb) || jsonb_build_object('paid', round(v_paid, 2));
    if v_quotes then
      v_totals := v_totals || jsonb_build_object('due', round(greatest(v_quoted - v_paid, 0), 2));
    end if;
  end if;

  -- per-currency-0094: the same quoted / paid / due, one row per quote currency
  if v_totals is not null and cardinality(v_quote_ids) > 0 then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('currency', cur, 'events', n,
             'quoted', case when v_quotes then round(qd, 2) end,
             'paid', case when v_fin then round(pd, 2) end,
             'due', case when v_quotes and v_fin then round(greatest(qd - pd, 0), 2) end)) order by cur), '[]'::jsonb) into v_bycur
      from (select coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') as cur, count(*) as n,
                   coalesce(sum(coalesce(
                     case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric end,
                     case when (to_jsonb(q) ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (to_jsonb(q) ->> 'total')::numeric end,
                     0)), 0) as qd,
                   coalesce(sum(case
                     when exists (select 1 from public.quote_payments x where x.org_id = v_org and x.quote_id = q.id)
                       then (select coalesce(sum(pm.amount), 0) from public.quote_payments pm
                              where pm.org_id = v_org and pm.quote_id = q.id and pm.status = 'paid')
                     else (select coalesce(sum(m.amount), 0) from public.payment_milestones m
                            where m.org_id = v_org and m.quote_id = q.id and m.status = 'paid') end), 0) as pd
              from public.quotes q where q.org_id = v_org and q.id = any(v_quote_ids) group by 1) s;
    v_totals := v_totals || jsonb_build_object('by_currency', v_bycur);
  end if;

  if v_quotes or v_media then
    v_sections := v_sections || 'files'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'files', 'at', f.created_at, 'id', f.id,
               'title', 'File uploaded: ' || coalesce(nullif(f.filename, ''), 'file'),
               'subtitle', q.code, 'link', 'event.html?id=' || q.id::text) as j
        from public.event_files f join public.quotes q on q.id = f.quote_id and q.org_id = v_org
       where f.org_id = v_org and f.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
  end if;

  if v_staff then
    v_sections := v_sections || 'tasks'::text;
    select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('kind', 'tasks', 'at', coalesce(t.completed_at, t.created_at), 'id', t.id,
               'title', 'Task: ' || coalesce(nullif(t.title, ''), 'task'),
               'subtitle', concat_ws(' / ', q.code, nullif(t.status, ''), nullif(t.assignee_name, '')),
               'link', 'ops.html?quote=' || q.id::text) as j
        from public.event_tasks t join public.quotes q on q.id = t.quote_id and q.org_id = v_org
       where t.org_id = v_org and t.quote_id = any(v_quote_ids)) s;
    v_items := v_items || v_rows;
  end if;

  -- messages: only event chats the caller can already see (membership / broadcast)
  v_sections := v_sections || 'messages'::text;
  select coalesce(jsonb_agg(j), '[]'::jsonb) into v_rows from (
    select jsonb_build_object('kind', 'messages', 'at', m.created_at, 'id', m.id,
             'title', 'Message in ' || coalesce(nullif(c.title, ''), 'event chat'),
             'subtitle', left(case when m.kind = 'text' then coalesce(m.body, '') else '[' || coalesce(m.kind, 'media') || ']' end, 140),
             'link', 'chat.html?c=' || c.id::text) as j
      from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id and c.org_id = v_org
     where m.org_id = v_org and not coalesce(m.deleted, false) and c.quote_id = any(v_quote_ids)
       and public.chat_can_see(c.id)
     order by m.created_at desc limit 100) s;
  v_items := v_items || v_rows;

  select coalesce(jsonb_agg(e order by (e ->> 'at')::timestamptz desc nulls last), '[]'::jsonb) into v_items
    from (select e from jsonb_array_elements(v_items) e order by (e ->> 'at')::timestamptz desc nulls last limit v_lim) s;

  return jsonb_build_object(
    'client', jsonb_build_object('name', coalesce(v_name, 'Client'), 'phone', v_phone, 'email', v_email, 'status', v_status),
    'totals', v_totals, 'sections', to_jsonb(v_sections),
    'counts', jsonb_strip_nulls(jsonb_build_object('leads', case when v_leads then cardinality(v_lead_ids) end,
                                                   'events', case when v_quotes then cardinality(v_quote_ids) end)),
    'items', v_items);
end $$;

revoke all on function public.insights_range(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_range(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_range(date, date) to authenticated'; end if;
end $$;
revoke all on function public.insights_events(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_events(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_events(date, date) to authenticated'; end if;
end $$;
revoke all on function public.client_timeline(uuid, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.client_timeline(uuid, integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.client_timeline(uuid, integer) to authenticated'; end if;
end $$;
