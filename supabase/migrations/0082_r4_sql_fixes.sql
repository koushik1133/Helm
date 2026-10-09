-- 0082_r4_sql_fixes.sql - CANONICAL forward-only. Round 4 review fixes for 0076-0080.
--
-- In plain words:
--   R4-01  comms_outbox_claim re-checks each queued message right before it is handed to
--          the sender. It now ALSO checks that:
--            * the address / number queued is still the client's (or member's) CURRENT one -
--              a client e-mail or phone corrected after queuing no longer gets the message
--              sent to the old (wrong) address; the row is skipped and the next tick queues
--              nothing new for that stage (dedupe key), so nobody is messaged twice;
--            * automatic payment reminders are still switched on (a planner's manual
--              "Send reminder now" is unaffected) and the channel is still chosen;
--            * follow-up channel still chosen; a WhatsApp forward's member is still staff
--              and their role still forwards that notification type.
--   R4-02  Re-pricing alerts (0077): the "already alerted in the last 10 minutes" check
--          scanned every notification of the studio for every future quote, so a studio
--          with a long bell history made a price-list save take seconds (and a statement
--          timeout can not be swallowed, so the save itself failed). A small partial index
--          on notifications (kind = price_change) makes the check instant. Soft-deleted /
--          archived quotes no longer get alerts.
--   R4-03  insights_range / insights_events counted soft-deleted events (quotes in the
--          Deleted shelf) in counts and money. They are now excluded (archived events are
--          history and still count), matching every other studio list.
--   R4-04  public_get_portal (signed-out client page) no longer returns brand.billing.
--
-- Additive + idempotent: function bodies replaced (create or replace, same signatures and
-- grants), one partial index added. No table is added, no row is changed or deleted.
-- ============================================================================

-- R4-02 index (partial: only price_change rows, so it is tiny)
create index if not exists notifications_price_change_idx
  on public.notifications (quote_id, created_at) where kind = 'price_change';

-- R4-01 -----------------------------------------------------------------------------------
create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- comms-claim-r4-0082: recipient + switches re-checked at claim time
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_cfg jsonb; v_client jsonb; v_wa text; v_role text;
begin
  update public.comms_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now() where sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.sent_at is null and c.status = 'pending' and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    v_cfg := public._comms_cfg(r.org_id);
    v_client := null; v_wa := null; v_role := null;
    if r.quote_id is not null then
      select q.client into v_client from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id;
    end if;
    v_ok := case r.purpose
      when 'pay_reminder' then exists (select 1 from public.payment_milestones m where m.id = r.milestone_id and m.org_id = r.org_id and m.status in ('due', 'invoiced'))
                               and public._comms_quote_live(r.quote_id)
                               and (coalesce((r.payload ->> 'manual')::boolean, false) or coalesce((v_cfg ->> 'pay_enabled')::boolean, false))
                               and r.channel = any (public._comms_channels(v_cfg, 'pay_channels'))
                               and public._comms_client_to(v_client, r.channel) is not distinct from r.recipient
      when 'follow_up' then public._comms_quote_live(r.quote_id) and coalesce((v_cfg ->> 'fu_enabled')::boolean, false)
                            and exists (select 1 from public.quotes q where q.id = r.quote_id and q.status <> 'confirmed'
                                          and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled'))
                            and r.channel = any (public._comms_channels(v_cfg, 'fu_channels'))
                            and public._comms_client_to(v_client, r.channel) is not distinct from r.recipient
      when 'wa_forward' then coalesce((v_cfg ->> 'wa_forward_enabled')::boolean, false)
                             and exists (select 1 from public.member_wa_optin w join public.profiles p on p.id = w.user_id
                                          where w.user_id = r.user_id and w.opted_in and w.org_id = r.org_id and p.org_id = r.org_id
                                            and coalesce(p.role, 'client') <> 'client')
      else false end;
    if coalesce(v_ok, false) and r.purpose = 'wa_forward' then
      select p.role, regexp_replace(coalesce(nullif(btrim(mp.whatsapp), ''), case when mp.whatsapp_same then nullif(btrim(mp.phone), '') end, ''), '[^0-9]', '', 'g')
        into v_role, v_wa
        from public.profiles p left join public.member_profiles mp on mp.user_id = p.id where p.id = r.user_id;
      v_ok := v_wa is not distinct from r.recipient
              and coalesce((v_cfg -> 'wa_forward_roles' -> v_role) ? (r.payload ->> 'type'), false);
    end if;
    if r.channel = 'whatsapp' and coalesce(v_cfg ->> 'studio_whatsapp', '') !~ '^[0-9]{8,15}$' then v_ok := false; end if;
    if not coalesce(v_ok, false) then
      update public.comms_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.comms_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'purpose', r.purpose, 'channel', r.channel,
      'to', r.recipient, 'payload', r.payload));
  end loop;
  return v_out;
end $$;

-- R4-02 / R4-03 (bodies as in 0076 / 0077 plus the soft-delete filters) ---------------------
create or replace function public._r3_price_change_notify(p_org uuid, p_source text, p_fields text[], p_package text default null)
returns integer language plpgsql security definer set search_path = '' as $$
-- reprice-alert-0077 + r4-0082: skips soft-deleted / archived quotes
declare n integer := 0;
begin
  if p_org is null or coalesce(array_length(p_fields, 1), 0) = 0 then return 0; end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
  select q.id, 'in_app', 'price_change', 'sent',
         jsonb_build_object('source', p_source, 'fields', to_jsonb(p_fields), 'event_code', q.code,
                            'path', 'flow.html?id=' || q.id::text), p_org
    from public.quotes q
   where q.org_id = p_org and q.deleted_at is null and q.archived_at is null
     and coalesce(q.status, '') <> 'cancelled'
     and coalesce(q.lifecycle_stage, 'quote') not in ('settlement', 'closed')
     and (q.event_date is null or q.event_date >= current_date)
     and coalesce(public._r3_num(q.pricing, 'total'), 0) > 0
     and (
          (p_source = 'menu' and q.pricing ->> '_packageName' = p_package and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0)
       or (p_source = 'pricing' and (
             ('chairPrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'chairs'), 0) > 0)
          or ('platePrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0 and nullif(q.pricing ->> '_packageName', '') is null)
          or (('layoutBase' = any (p_fields) or 'assetPrices' = any (p_fields)) and coalesce(public._r3_num(q.pricing, 'other'), 0) > 0)
          or 'gstPct' = any (p_fields) or 'serviceChargePct' = any (p_fields)))
     )
     and not exists (select 1 from public.notifications x
                      where x.quote_id = q.id and x.kind = 'price_change' and x.org_id = p_org
                        and x.created_at > now() - interval '10 minutes'
                        and x.detail ->> 'source' = p_source and x.detail -> 'fields' = to_jsonb(p_fields))
   order by q.event_date nulls last
   limit 200;
  get diagnostics n = row_count;
  return n;
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
begin
  -- insights-range-0076 + r4-0082: soft-deleted events excluded
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
  -- insights-events-0077 + r4-0082: soft-deleted events excluded
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  v_fin := public.has_area('finance', 'view');
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  with ev0 as (
    select q.id, q.code, q.title, coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.event_date, (q.created_at at time zone v_tz)::date) as d,
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
           'id', id, 'code', code, 'title', title, 'date', d, 'stage', stage,
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


-- R4-04 the signed-out client portal (public_get_portal, anon via the approval link) returned
-- the studio's WHOLE brand object, which since onboarding also carries brand.billing (legal
-- name + billing address). Wrap once: same result with brand.billing removed.
do $$ begin
  if to_regprocedure('public.public_get_portal__pre0082(uuid)') is null
     and position('portal-brand-r4-0082' in (select p.prosrc from pg_proc p where p.oid = 'public.public_get_portal(uuid)'::regprocedure)) = 0 then
    alter function public.public_get_portal(uuid) rename to public_get_portal__pre0082;
  end if;
end $$;
revoke all on function public.public_get_portal__pre0082(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.public_get_portal__pre0082(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.public_get_portal__pre0082(uuid) from authenticated'; end if;
end $$;
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- portal-brand-r4-0082: never hand out brand.billing on the signed-out portal
declare v jsonb;
begin
  v := public.public_get_portal__pre0082(p_token);
  if jsonb_typeof(v -> 'studio') = 'object' and jsonb_typeof(v #> '{studio,brand}') = 'object' then
    v := jsonb_set(v, '{studio,brand}', (v #> '{studio,brand}') - 'billing');
  end if;
  return v;
end $$;
revoke all on function public.public_get_portal(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_get_portal(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_get_portal(uuid) to authenticated'; end if;
end $$;

-- privileges (create or replace keeps them; restated so a re-run is self-contained)
revoke all on function public.comms_outbox_claim(integer) from public;
revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from public;
revoke all on function public.insights_range(date, date) from public;
revoke all on function public.insights_events(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.comms_outbox_claim(integer) from anon';
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from anon';
    execute 'revoke all on function public.insights_range(date, date) from anon';
    execute 'revoke all on function public.insights_events(date, date) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.comms_outbox_claim(integer) from authenticated';
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from authenticated';
    execute 'grant execute on function public.insights_range(date, date) to authenticated';
    execute 'grant execute on function public.insights_events(date, date) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.comms_outbox_claim(integer) to service_role';
  end if;
end $$;
