-- 0154_final_fixes.sql - CANONICAL forward-only.
-- REQUIRES 0012 (worker_respond / _notify) + 0039 (_work_token_live) + 0145 (dashboard_money) + 0153 (crew_task_respond).
--
-- In plain words - final QA 2026-10-22:
--   1. When crew finished / accepted / started a task from the signed-in app (crew_task_respond),
--      managers and admins got no bell notification. It now sends the same task_accept /
--      task_reject / task_start / task_complete notification the worker link sends.
--   2. The Business page showed '-' for Booked / Collected / Outstanding when the studio's stored
--      currency (organizations.currency, e.g. a stale USD) differs from the studio's tax-setting
--      currency the page uses (e.g. INR). New dashboard_money_for(months, currency) is the same
--      read as dashboard_money but reports in the currency the page asks for. dashboard_money is
--      NOT changed; organizations.currency is NOT changed.
--   3. Rate limit on the public crew task link: every worker_* RPC resolves its token through
--      _work_token_live, which now counts calls per link (120 a minute) and per caller IP
--      (600 a minute) in a small counter table and refuses beyond that. The previous body is kept
--      as _work_token_live__pre0154.
--
-- ZERO DATA LOSS: one new table (counters only), CREATE OR REPLACE of functions, one function
-- rename (kept as _work_token_live__pre0154). No existing table, column, row or policy is
-- removed or changed. No DELETE / DROP / TRUNCATE. ASCII only. Safe to run twice.

do $$ begin
  if to_regprocedure('public._notify(uuid,text,text,text,jsonb)') is null then raise exception 'STOP: apply 0033 first'; end if;
  if to_regprocedure('public._work_token_live(uuid)') is null then raise exception 'STOP: apply 0039 first'; end if;
  if to_regprocedure('public.dashboard_money(integer)') is null then raise exception 'STOP: apply 0145 first'; end if;
  if to_regprocedure('public.crew_task_respond(uuid,text)') is null then raise exception 'STOP: apply 0153 first'; end if;
end $$;

-- ---- 1) crew_task_respond: same bell notification as the worker link ---------------------
create or replace function public.crew_task_respond(p_task uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- crew-1020-0153 final-1022-0154
declare tsk record; newst text; v_name text;
begin
  if auth.uid() is null or public.current_org_id() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select t.id, t.quote_id, t.title, t.status, t.crew_id into tsk from public.event_tasks t
   where t.id = p_task and t.org_id = public.current_org_id()
     and t.crew_id in (select public._a153_my_crew_ids());
  if tsk.id is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  newst := case p_action when 'accept' then 'accepted' when 'reject' then 'rejected'
                         when 'start' then 'in_progress' when 'complete' then 'completed' else null end;
  if newst is null then raise exception 'invalid action' using errcode = '22023'; end if;
  if tsk.status in ('completed', 'cancelled') then raise exception 'this task is already closed' using errcode = '22023'; end if;
  if p_action in ('accept', 'reject') and tsk.status not in ('assigned', 'accepted', 'rejected') then
    raise exception 'this task has already started' using errcode = '22023'; end if;
  if p_action = 'start' and tsk.status not in ('accepted', 'assigned') then raise exception 'accept the task first' using errcode = '22023'; end if;
  if p_action = 'complete' and tsk.status not in ('in_progress', 'accepted') then raise exception 'start the task first' using errcode = '22023'; end if;
  update public.event_tasks set status = newst,
    responded_at = case when p_action in ('accept', 'reject') then now() else responded_at end,
    started_at   = case when p_action = 'start' then now() else started_at end,
    completed_at = case when p_action = 'complete' then now() else completed_at end
   where id = tsk.id;
  select cm.name into v_name from public.crew_members cm where cm.id = tsk.crew_id;
  -- final-1022: tell the studio, exactly like worker_respond does
  perform public._notify(tsk.quote_id, 'sms', null, 'task_' || p_action,
                         jsonb_build_object('task', tsk.title, 'worker', coalesce(v_name, 'Crew')));
  return jsonb_build_object('ok', true, 'status', newst);
end $$;
revoke all on function public.crew_task_respond(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.crew_task_respond(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.crew_task_respond(uuid, text) to authenticated'; end if;
end $$;

-- ---- 2) dashboard_money_for: dashboard_money in the currency the page asks for ------------
create or replace function public.dashboard_money_for(p_months integer default 12, p_currency text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-money-0108 final-1022-0154 (0142: dominant quote currency fallback; 0145: stamped quotes only)
declare
  v_org uuid := public.current_org_id();
  v_q boolean; v_fin boolean; v_leads boolean;
  v_tz text; v_cur text; v_today date; v_start date;
  v_n integer := least(greatest(coalesce(p_months, 12), 1), 24);
  v_months jsonb; v_totals jsonb; v_other jsonb; v_overdue jsonb; v_pipe jsonb; v_leadc jsonb; v_up jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_q := public.has_area('quotes', 'view');
  v_fin := public.has_area('finance', 'view');
  if not (v_q or v_fin) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_leads := public.has_area('leads', 'view');

  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  -- 0142: organizations.currency can be a stale default (e.g. USD) while every quote is priced in
  -- INR - then every total came back 0 and the real money sat in other_currencies. When the studio
  -- has NO live quote in its stored currency, use the currency most of its quotes are priced in.
  -- final-1022-0154: the page asks for the studio's own currency (studio tax setting); when it
  -- names a valid ISO code, report in that currency and skip the guessing below.
  if upper(btrim(coalesce(p_currency, ''))) ~ '^[A-Z]{3}$' then
    v_cur := upper(btrim(p_currency));
  elsif not exists (select 1 from public.quotes q where q.org_id = v_org and q.deleted_at is null
                   and upper(btrim(coalesce(q.currency, ''))) = v_cur) then  -- 0145: stamped currency only
    select x.c into v_cur from (
      select upper(q.currency) as c, count(*) as n from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$'
       group by 1 order by 2 desc, 1 limit 1) x;
    v_cur := coalesce(v_cur, 'INR');
  end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;
  v_start := (date_trunc('month', v_today::timestamp) - make_interval(months => v_n - 1))::date;

  -- one pass over the studio's quotes (quotes_org_idx), ledger + change requests pre-aggregated per quote
  with q as (
    select q.id, q.code, q.title, q.client, q.status, coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.approval_status, 'none') as appr, q.confirmed_at, q.event_date,
           case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null
  ), cr as (
    select c.quote_id, sum(c.price_delta) as d from public.change_requests c
     where c.org_id = v_org and c.status = 'approved' group by c.quote_id
  ), led as (
    select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
     where p.org_id = v_org group by p.quote_id
  ), msp as (
    select m.quote_id, sum(m.amount) filter (where m.status = 'paid') as paid from public.payment_milestones m
     where m.org_id = v_org group by m.quote_id
  ), ev as (
    select q.*, q.base + coalesce(cr.d, 0) as value,
           case when led.quote_id is not null then coalesce(led.paid, 0) else coalesce(msp.paid, 0) end as paid,
           led.quote_id is not null as has_led
      from q left join cr on cr.quote_id = q.id left join led on led.quote_id = q.id left join msp on msp.quote_id = q.id
  )
  select
    case when v_q then jsonb_build_object(
      'currency', v_cur,
      'open',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr <> 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr <> 'sent' and cur = v_cur), 0)),
      'sent',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr = 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr = 'sent' and cur = v_cur), 0)),
      'confirmed', jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage <> 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage <> 'closed' and cur = v_cur), 0)),
      'closed',    jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage = 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage = 'closed' and cur = v_cur), 0)),
      'cancelled', jsonb_build_object('count', count(*) filter (where status = 'cancelled')),
      'total', count(*)) end,
    jsonb_build_object(
      'booked_all', case when v_q or v_fin then coalesce(sum(value) filter (where status = 'confirmed' and cur = v_cur), 0) end,
      'collected_all', case when v_fin then coalesce(sum(paid) filter (where cur = v_cur), 0) end,
      'outstanding', case when v_fin then coalesce(sum(greatest(value - paid, 0)) filter (where status = 'confirmed' and cur = v_cur), 0) end),
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', x.cur, 'booked_all', x.b, 'collected_all', x.c, 'outstanding', x.o) order by x.cur), '[]'::jsonb)
        from (select e2.cur, coalesce(sum(e2.value) filter (where e2.status = 'confirmed'), 0) as b, coalesce(sum(e2.paid), 0) as c,
                     coalesce(sum(greatest(e2.value - e2.paid, 0)) filter (where e2.status = 'confirmed'), 0) as o
                from ev e2 where e2.cur <> v_cur group by e2.cur) x) end,
    case when v_fin then (
      select coalesce(jsonb_agg(o order by (o ->> 'due_date'), (o ->> 'code')), '[]'::jsonb) from (
        select jsonb_build_object('quote_id', z.quote_id, 'milestone_id', z.id, 'code', z.code, 'title', z.title,
                 'client', nullif(btrim(coalesce(z.client ->> 'name', '')), ''), 'label', z.label, 'due_date', z.due_date,
                 'amount', z.amount, 'paid', z.mpaid, 'balance', z.amount - z.mpaid, 'currency', z.cur) as o
          from (
            select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                             when y.mstatus = 'paid' then y.amount else 0 end as mpaid
              from (
                select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, e.code, e.title, e.client, e.cur,
                       e.paid as qpaid, e.has_led,
                       coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                                    rows between unbounded preceding and 1 preceding), 0) as prior_amt
                  from public.payment_milestones m
                  join ev e on e.id = m.quote_id and e.status = 'confirmed'
                 where m.org_id = v_org
              ) y
          ) z
         where z.due_date is not null and z.due_date < v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
         order by z.due_date, z.code
         limit 10) s) end,
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('quote_id', u.id, 'value', u.value, 'paid', u.paid, 'currency', u.cur) order by u.event_date, u.code), '[]'::jsonb)
        from (select e3.id, e3.code, e3.event_date, e3.value, e3.paid, e3.cur from ev e3
               where e3.status = 'confirmed' and e3.event_date between v_today and v_today + 30
               order by e3.event_date, e3.code limit 50) u) end
    into v_pipe, v_totals, v_other, v_overdue, v_up
    from ev;

  -- months: booked by confirmation month (studio currency), collected by ledger paid month
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'),
           'booked', case when v_q or v_fin then coalesce(b.v, 0) end,
           'collected', case when v_fin then coalesce(c.v, 0) end) order by g.m), '[]'::jsonb)
    into v_months
    from generate_series(v_start::timestamp, date_trunc('month', v_today::timestamp), interval '1 month') g(m)
    left join (
      select date_trunc('month', (q.confirmed_at at time zone v_tz))::date as m,
             sum(case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end
                 + coalesce((select sum(c.price_delta) from public.change_requests c
                              where c.quote_id = q.id and c.org_id = v_org and c.status = 'approved'), 0)) as v
        from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed' and q.confirmed_at is not null
         and q.confirmed_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) b on b.m = g.m::date
    left join (
      select date_trunc('month', (p.paid_at at time zone v_tz))::date as m, sum(p.amount) as v
        from public.quote_payments p
        join public.quotes q on q.id = p.quote_id and q.org_id = v_org and q.deleted_at is null
       where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
         and p.paid_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) c on c.m = g.m::date;

  if v_leads then
    select coalesce(jsonb_object_agg(s.st, s.n), '{}'::jsonb) into v_leadc from (
      select coalesce(nullif(btrim(l.status), ''), 'new') as st, count(*) as n
        from public.leads l where l.org_id = v_org group by 1) s;
  end if;

  return jsonb_build_object('currency', v_cur, 'today', v_today, 'months_n', v_n,
    'finance', v_fin, 'months', v_months, 'totals', v_totals, 'other_currencies', v_other,
    'overdue', v_overdue, 'upcoming', v_up, 'pipeline', v_pipe, 'leads', v_leadc);
end $$;
do $$ begin
  execute 'revoke all on function public.dashboard_money_for(integer, text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_money_for(integer, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_money_for(integer, text) to authenticated'; end if;
end $$;

-- ---- 3) rate limit on the public crew task link ------------------------------------------
create table if not exists public.a154_link_hits (
  k text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
alter table public.a154_link_hits enable row level security;
revoke all on table public.a154_link_hits from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.a154_link_hits from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.a154_link_hits from authenticated'; end if;
end $$;

-- count one call for key k in a 1-minute window; true = over the limit
create or replace function public._a154_hit(p_key text, p_limit integer)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  if p_key is null or p_key = '' then return false; end if;
  begin
    insert into public.a154_link_hits as h (k, window_start, hits) values (left(p_key, 200), now(), 1)
    on conflict (k) do update set
      hits = case when h.window_start < now() - interval '1 minute' then 1 else h.hits + 1 end,
      window_start = case when h.window_start < now() - interval '1 minute' then now() else h.window_start end
    returning hits into n;
  exception when read_only_sql_transaction then return false;   -- a read-only call is never blocked
  end;
  return n > p_limit;
end $$;
revoke all on function public._a154_hit(text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a154_hit(text, integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a154_hit(text, integer) from authenticated'; end if;
end $$;

do $$ begin
  if to_regprocedure('public._work_token_live__pre0154(uuid)') is null
     and position('final-1022-0154' in (select p.prosrc from pg_proc p where p.oid = 'public._work_token_live(uuid)'::regprocedure)) = 0 then
    alter function public._work_token_live(uuid) rename to _work_token_live__pre0154;
  end if;
end $$;

create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $$
-- final-1022-0154: rate limit, then the previous checks unchanged
declare v_ip text;
begin
  begin
    v_ip := split_part(coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''), ',', 1);
  exception when others then v_ip := '';
  end;
  if public._a154_hit('t:' || coalesce(p_token::text, ''), 120)
     or (btrim(v_ip) <> '' and public._a154_hit('ip:' || btrim(v_ip), 600)) then
    raise exception 'too many requests - wait a minute and try again' using errcode = '54000';
  end if;
  return public._work_token_live__pre0154(p_token);
end $$;
revoke all on function public._work_token_live(uuid) from public;
revoke all on function public._work_token_live__pre0154(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._work_token_live(uuid) from anon';
    execute 'revoke all on function public._work_token_live__pre0154(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._work_token_live(uuid) from authenticated';
    execute 'revoke all on function public._work_token_live__pre0154(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._work_token_live(uuid) to service_role'; end if;
end $$;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 crew_task_respond notifies', position('_notify' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.crew_task_respond(uuid,text)'))) > 0),
  ('02 crew_task_respond callable', has_function_privilege('authenticated', 'public.crew_task_respond(uuid, text)', 'execute')),
  ('03 dashboard_money_for callable', has_function_privilege('authenticated', 'public.dashboard_money_for(integer, text)', 'execute')),
  ('04 dashboard_money_for closed to anon', not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.dashboard_money_for(integer, text)', 'execute')),
  ('05 dashboard_money kept', to_regprocedure('public.dashboard_money(integer)') is not null),
  ('06 token check rate limited', position('final-1022-0154' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._work_token_live(uuid)'))) > 0),
  ('07 previous token check kept', to_regprocedure('public._work_token_live__pre0154(uuid)') is not null),
  ('08 counter table private', (select c.relrowsecurity from pg_class c where c.oid = 'public.a154_link_hits'::regclass)
       and not has_table_privilege('authenticated', 'public.a154_link_hits', 'select')),
  ('09 helpers closed', not has_function_privilege('authenticated', 'public._a154_hit(text, integer)', 'execute')
       and not has_function_privilege('authenticated', 'public._work_token_live(uuid)', 'execute'))
) v(item, ok);
