-- APPLY-0108-0109.sql - paste into the Supabase SQL editor (STAGING first, then PROD). Safe to paste twice.
-- Part 1 = 0108 dashboard_money (read-only revenue numbers). Part 2 = 0109 user_dashboard_prefs (layout + desk notes).
-- The editor shows only the LAST result set: the 0109 verify rows. Every ok must be true.

-- APPLY-0108.sql - paste into the Supabase SQL editor (staging, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0108_dashboard_money.sql:
--   * dashboard_money(p_months) - ONE new read-only function: exact booked / collected (payment
--     ledger) per month, outstanding, overdue milestones and pipeline counts for the dashboard.
--   No table, column or row is created, changed or deleted.
-- Needs 0040 / 0082 / 0089 / phase29 has_area - checked below with a clear message.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- =================================================================================================
-- 0108_dashboard_money.sql
-- =================================================================================================
-- 0108_dashboard_money.sql - CANONICAL forward-only. Exact money + pipeline numbers for the dashboard.
--
-- In plain words:
--   The dashboard used to add up money from the first 500 quotes it downloaded, and it could not
--   show what was actually collected. This adds ONE read-only function that the dashboard calls:
--
--     dashboard_money(p_months int default 12) -> jsonb, for the caller's own studio only.
--
--   It returns (studio currency = organizations.currency, else INR):
--     * months[]  - last p_months (1..24): { month 'YYYY-MM', booked, collected }
--                   booked    = confirmed quote value (pricing total + approved change requests)
--                               by confirmation month (studio local date)
--                   collected = PAYMENT LEDGER (quote_payments status 'paid') by paid month
--     * totals    - { booked_all, collected_all, outstanding } (outstanding = confirmed value not
--                   yet collected, per event, never below 0)
--     * other_currencies[] - the same totals for quotes in another currency (never added together)
--     * overdue[] - up to 10 payment milestones due before today and not fully paid
--     * upcoming[] - confirmed events in the next 30 days: { quote_id, value, paid, currency }
--     * pipeline  - exact counts / values: quotes open / sent / confirmed / closed / cancelled,
--                   leads by status
--   "Paid" always comes from the ledger (quote_payments). Only an event with NO ledger rows at all
--   (very old data) falls back to milestones marked paid - same rule as insights_range (0082).
--
--   Who can call it: quotes VIEW or finance VIEW. Collected / outstanding / overdue need finance
--   VIEW (null otherwise). Lead counts need leads VIEW. Soft-deleted events are ignored.
--
--   Changes: one new function. No table, column or row is created, changed or deleted.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0108: has_area(text,text) is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then
    raise exception '0108: current_org_id() is not installed'; end if;
  if to_regclass('public.quote_payments') is null or to_regclass('public.payment_milestones') is null
     or to_regclass('public.change_requests') is null or to_regclass('public.leads') is null then
    raise exception '0108: quote_payments / payment_milestones / change_requests / leads missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'currency')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'deleted_at') then
    raise exception '0108: quotes.currency / quotes.deleted_at missing (apply 0040 and 0089 first)'; end if;
end $$;

create or replace function public.dashboard_money(p_months integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-money-0108
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
  execute 'revoke all on function public.dashboard_money(integer) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_money(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_money(integer) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.dashboard_money(integer) to service_role'; end if;
end $$;

commit;

-- =================================================================================================
-- verify (read-only)
-- =================================================================================================
select item, ok from (values
  ('0108 01 function installed', to_regprocedure('public.dashboard_money(integer)') is not null),
  ('0108 02 definer function with empty search_path', exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.dashboard_money(integer)')
      and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])),
  ('0108 03 read-only (stable)', exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.dashboard_money(integer)') and p.provolatile = 's')),
  ('0108 04 studio users yes, anon no', has_function_privilege('authenticated', 'public.dashboard_money(integer)', 'execute')
      and not has_function_privilege('anon', 'public.dashboard_money(integer)', 'execute')),
  ('0108 05 org-scoped and area-gated', position('current_org_id()' in (select prosrc from pg_proc where oid = to_regprocedure('public.dashboard_money(integer)'))) > 0
      and position('has_area(''finance'', ''view'')' in (select prosrc from pg_proc where oid = to_regprocedure('public.dashboard_money(integer)'))) > 0
      and position('has_area(''quotes'', ''view'')' in (select prosrc from pg_proc where oid = to_regprocedure('public.dashboard_money(integer)'))) > 0)
) v(item, ok)
order by item;

-- APPLY-0109.sql - paste into the Supabase SQL editor (staging, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0109_user_dashboard_prefs.sql:
--   * user_dashboard_prefs - ONE new table: each person's dashboard layout + desk notes, own row only.
--   * my_dashboard_prefs / save_dashboard_layout / save_desk_notes - three functions the dashboard calls.
--   No existing table, column or row is changed or deleted. No temp tables, no session settings.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- =================================================================================================
-- 0109_user_dashboard_prefs.sql
-- =================================================================================================
-- 0109_user_dashboard_prefs.sql - CANONICAL forward-only. Per-user dashboard layout + desk notes.
--
-- In plain words:
--   Each person can now arrange their own home dashboard (block order + which blocks are hidden)
--   and their "Desk notes" are kept on the server instead of only in one browser. One row per
--   person per studio. Nobody else - not even a studio admin - can read or change someone's row.
--
--     user_dashboard_prefs(user_id, org_id, layout jsonb, hidden jsonb, desk_notes text <= 2000)
--     my_dashboard_prefs()            -> jsonb  { layout, hidden, desk_notes, updated_at }
--     save_dashboard_layout(p jsonb)  -> void   { order: [...ids], hidden: [...ids] }  ({} = reset)
--     save_desk_notes(p_text text)    -> void
--
--   The layout only holds block ids (e.g. "calendar"); it never decides what a role can see -
--   role gating stays in the app and in each block's own RLS. User and studio always come from
--   the session (auth.uid() + current_org_id()), never from the caller.
--
--   Changes: one new table (RLS on, own row only, no delete, no anon) + three functions.
--   No existing table, column or row is changed or deleted. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.current_org_id()') is null then
    raise exception '0109: current_org_id() is not installed'; end if;
  if to_regclass('public.organizations') is null then
    raise exception '0109: public.organizations is missing'; end if;
end $$;

create table if not exists public.user_dashboard_prefs (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  org_id      uuid        not null references public.organizations(id) on delete cascade,
  layout      jsonb       not null default '{}'::jsonb,
  hidden      jsonb       not null default '[]'::jsonb,
  desk_notes  text        not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, org_id)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'udp_layout_shape' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_layout_shape
      check (jsonb_typeof(layout) = 'object' and pg_column_size(layout) < 8192); end if;
  if not exists (select 1 from pg_constraint where conname = 'udp_hidden_shape' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_hidden_shape
      check (jsonb_typeof(hidden) = 'array' and jsonb_array_length(hidden) <= 40); end if;
  if not exists (select 1 from pg_constraint where conname = 'udp_notes_len' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_notes_len
      check (char_length(desk_notes) <= 2000); end if;
end $$;

alter table public.user_dashboard_prefs enable row level security;
revoke all on table public.user_dashboard_prefs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.user_dashboard_prefs from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.user_dashboard_prefs from authenticated';
    execute 'grant select, insert, update on table public.user_dashboard_prefs to authenticated';   -- no DELETE
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.user_dashboard_prefs to service_role'; end if;
end $$;

drop policy if exists "a109 prefs own read" on public.user_dashboard_prefs;
create policy "a109 prefs own read" on public.user_dashboard_prefs for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
drop policy if exists "a109 prefs own insert" on public.user_dashboard_prefs;
create policy "a109 prefs own insert" on public.user_dashboard_prefs for insert to authenticated
  with check (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
drop policy if exists "a109 prefs own update" on public.user_dashboard_prefs;
create policy "a109 prefs own update" on public.user_dashboard_prefs for update to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()))
  with check (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));

create or replace function public.my_dashboard_prefs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); r record;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.layout, p.hidden, p.desk_notes, p.updated_at into r
    from public.user_dashboard_prefs p where p.user_id = v_uid and p.org_id = v_org;
  if not found then
    return jsonb_build_object('layout', '{}'::jsonb, 'hidden', '[]'::jsonb, 'desk_notes', '', 'updated_at', null);
  end if;
  return jsonb_build_object('layout', r.layout, 'hidden', r.hidden, 'desk_notes', r.desk_notes, 'updated_at', r.updated_at);
end $$;

create or replace function public.save_dashboard_layout(p_layout jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_order jsonb := '[]'::jsonb; v_hidden jsonb := '[]'::jsonb; v_layout jsonb;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' then raise exception 'bad layout' using errcode = '22023'; end if;
  -- keep only short block ids, de-duplicated, max 40 (layout never carries anything else)
  if jsonb_typeof(p_layout -> 'order') = 'array' then
    select coalesce(jsonb_agg(x.v order by x.i), '[]'::jsonb) into v_order from (
      select v, min(i) as i from jsonb_array_elements_text(p_layout -> 'order') with ordinality t(v, i)
       where v ~ '^[a-z][a-z0-9_-]{0,31}$' group by v order by min(i) limit 40) x;
  end if;
  if jsonb_typeof(p_layout -> 'hidden') = 'array' then
    select coalesce(jsonb_agg(x.v order by x.i), '[]'::jsonb) into v_hidden from (
      select v, min(i) as i from jsonb_array_elements_text(p_layout -> 'hidden') with ordinality t(v, i)
       where v ~ '^[a-z][a-z0-9_-]{0,31}$' group by v order by min(i) limit 40) x;
  end if;
  v_layout := case when jsonb_array_length(v_order) > 0 then jsonb_build_object('v', 1, 'order', v_order) else '{}'::jsonb end;
  insert into public.user_dashboard_prefs as p (user_id, org_id, layout, hidden)
    values (v_uid, v_org, v_layout, v_hidden)
  on conflict (user_id, org_id) do update set layout = excluded.layout, hidden = excluded.hidden, updated_at = now();
end $$;

create or replace function public.save_desk_notes(p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.user_dashboard_prefs as p (user_id, org_id, desk_notes)
    values (v_uid, v_org, left(coalesce(p_text, ''), 2000))
  on conflict (user_id, org_id) do update set desk_notes = excluded.desk_notes, updated_at = now();
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.my_dashboard_prefs()', 'public.save_dashboard_layout(jsonb)', 'public.save_desk_notes(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
end $$;

commit;

-- =================================================================================================
-- verify (read-only)
-- =================================================================================================
select item, ok from (values
  ('0109 01 table installed', to_regclass('public.user_dashboard_prefs') is not null),
  ('0109 02 row level security on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.user_dashboard_prefs')), false)),
  ('0109 03 three own-row policies', (select count(*) from pg_policies where schemaname = 'public' and tablename = 'user_dashboard_prefs') = 3),
  ('0109 04 anon has no table access', not has_table_privilege('anon', 'public.user_dashboard_prefs', 'select')
      and not has_table_privilege('anon', 'public.user_dashboard_prefs', 'insert')),
  ('0109 05 no delete for studio users', not has_table_privilege('authenticated', 'public.user_dashboard_prefs', 'delete')),
  ('0109 06 functions installed', to_regprocedure('public.my_dashboard_prefs()') is not null
      and to_regprocedure('public.save_dashboard_layout(jsonb)') is not null and to_regprocedure('public.save_desk_notes(text)') is not null),
  ('0109 07 definer functions with empty search_path', (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.my_dashboard_prefs()'),
      to_regprocedure('public.save_dashboard_layout(jsonb)'), to_regprocedure('public.save_desk_notes(text)'))
      and p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) = 3),
  ('0109 08 studio users yes, anon no', has_function_privilege('authenticated', 'public.save_dashboard_layout(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.save_dashboard_layout(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.save_desk_notes(text)', 'execute')
      and not has_function_privilege('anon', 'public.my_dashboard_prefs()', 'execute')),
  ('0109 09 notes length capped', exists (select 1 from pg_constraint where conname = 'udp_notes_len' and conrelid = to_regclass('public.user_dashboard_prefs')))
) v(item, ok)
order by item;
