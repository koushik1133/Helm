-- APPLY-0077.sql - paste-ready (Supabase SQL editor). Same body as supabase/migrations/0077_r3_sync_reprice_profit.sql.
-- Additive + idempotent; safe to run twice. Ends with verify rows (item, ok) - expect ALL ok = true.

-- 0077_r3_sync_reprice_profit.sql - CANONICAL forward-only. Round 3 (A).
--
-- In plain words:
--   1  Recent records (the clock button next to search) were kept ONLY in this browser's
--      localStorage, so a record opened on the laptop never showed on the phone. A small
--      per-person list now lives on the server: recent_touch() records an opened record,
--      recent_list() returns the newest ones. Rows belong to the caller and their studio;
--      nobody else can read them. Rows are upserted, never deleted.
--   2  Live history: quote_versions (floor-plan versions) and quotation_versions (Q1/Q2/..)
--      are added to the supabase_realtime publication so the version list on the builder
--      and the flow page refresh the moment a teammate saves on another device. Realtime
--      honours the existing row level security of both tables (own studio only).
--   3  Re-pricing alerts: when the Control Center price list changes (chair price, plate
--      price, GST %, service charge %, layout base, per-object prices) or a menu package's
--      price per plate changes, every FUTURE quote of that studio that uses the changed
--      line (not cancelled, not in settlement / closed, event date today or later) gets an
--      in-app bell entry (kind price_change). The quote's price is NEVER changed here; the
--      planner re-prices from the quote page. The bell shows these entries only to people
--      who can edit quotes (planners / admins). A failure in this alert can never block
--      the price-list save.
--   4  insights_events(from, to): the per-event profit table for Insights. Same events,
--      same money rules and the same insights + finance gates as insights_range (0076):
--      confirmed events in range, revenue / cost (incl. paid expense claims) / profit /
--      margin / collected / outstanding. Money is null without the finance area.
--
-- Additive + idempotent. One new per-person table, new functions, two triggers and a
-- wrapper around bell_feed (the previous body is kept as bell_feed__pre0077). No existing
-- row is changed or deleted.
-- ============================================================================

-- 1) recent records ------------------------------------------------------------------
create table if not exists public.user_recent_records (
  user_id uuid not null,
  org_id uuid not null,
  href text not null,
  title text not null,
  kind text not null default 'record',
  opened_at timestamptz not null default now(),
  primary key (user_id, org_id, href)
);
alter table public.user_recent_records enable row level security;
drop policy if exists "urr own read" on public.user_recent_records;
create policy "urr own read" on public.user_recent_records for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
revoke all on public.user_recent_records from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.user_recent_records from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.user_recent_records from authenticated';
    execute 'grant select on public.user_recent_records to authenticated'; end if;
end $$;
create index if not exists user_recent_records_recent_idx on public.user_recent_records (user_id, org_id, opened_at desc);
-- suspended studios are read-only here too (same guard as every studio table)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    drop trigger if exists zzz_studio_read_only on public.user_recent_records;
    create trigger zzz_studio_read_only before insert or update or delete on public.user_recent_records
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

create or replace function public.recent_touch(p_href text, p_title text, p_kind text default 'record')
returns boolean language plpgsql security definer set search_path = '' as $$
-- recent-records-0077
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_href text := btrim(coalesce(p_href, '')); v_title text := left(regexp_replace(btrim(coalesce(p_title, '')), '\s+', ' ', 'g'), 120);
  v_kind text := lower(btrim(coalesce(p_kind, 'record')));
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_href ~ '^/' then v_href := substr(v_href, 2); end if;
  if length(v_href) > 400 or v_href !~ '^[a-z0-9-]+\.html([?#][^[:space:]\\]*)?$' then
    raise exception 'invalid link' using errcode = '22023'; end if;
  if v_title = '' then raise exception 'title required' using errcode = '22023'; end if;
  if v_kind not in ('event', 'quote', 'lead', 'builder', 'vendor', 'staff', 'record') then v_kind := 'record'; end if;
  insert into public.user_recent_records(user_id, org_id, href, title, kind, opened_at)
    values (v_uid, v_org, v_href, v_title, v_kind, now())
  on conflict (user_id, org_id, href) do update set title = excluded.title, kind = excluded.kind, opened_at = excluded.opened_at;
  return true;
end $$;

create or replace function public.recent_list(p_limit integer default 10)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- recent-records-0077
  select coalesce(jsonb_agg(jsonb_build_object('href', r.href, 'title', r.title, 'kind', r.kind, 'at', r.opened_at)
                            order by r.opened_at desc), '[]'::jsonb)
    from (select * from public.user_recent_records u
           where auth.uid() is not null and u.user_id = auth.uid() and u.org_id = public.current_org_id()
           order by u.opened_at desc limit greatest(1, least(coalesce(p_limit, 10), 50))) r;
$$;

-- 2) realtime for the version lists -------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.quote_versions; exception when others then null; end;
    begin alter publication supabase_realtime add table public.quotation_versions; exception when others then null; end;
  end if;
end $$;

-- 3) re-pricing alerts --------------------------------------------------------------
create or replace function public._r3_num(p jsonb, k text)
returns numeric language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p -> k) = 'number' then (p ->> k)::numeric
              when (p ->> k) ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (p ->> k)::numeric end;
$$;

-- one bell entry per affected future quote; dedupes an identical alert from the last 10 minutes
create or replace function public._r3_price_change_notify(p_org uuid, p_source text, p_fields text[], p_package text default null)
returns integer language plpgsql security definer set search_path = '' as $$
-- reprice-alert-0077
declare n integer := 0;
begin
  if p_org is null or coalesce(array_length(p_fields, 1), 0) = 0 then return 0; end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
  select q.id, 'in_app', 'price_change', 'sent',
         jsonb_build_object('source', p_source, 'fields', to_jsonb(p_fields), 'event_code', q.code,
                            'path', 'flow.html?id=' || q.id::text), p_org
    from public.quotes q
   where q.org_id = p_org
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

create or replace function public._r3_tg_pricing_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
-- reprice-alert-0077: never blocks the save
declare o jsonb; nw jsonb := coalesce(new.value, '{}'::jsonb); f text[] := '{}'; k text;
begin
  begin
    if new.key is distinct from 'pricing' then return null; end if;
    o := case when tg_op = 'UPDATE' then coalesce(old.value, '{}'::jsonb)
              else '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0}'::jsonb end;
    foreach k in array array['chairPrice', 'platePrice', 'gstPct', 'serviceChargePct', 'layoutBase'] loop
      if coalesce(public._r3_num(o, k), 0) is distinct from coalesce(public._r3_num(nw, k), 0) and nw ? k then f := f || k; end if;
    end loop;
    if coalesce(o -> 'assetPrices', '{}'::jsonb) is distinct from coalesce(nw -> 'assetPrices', '{}'::jsonb) then f := f || 'assetPrices'::text; end if;
    perform public._r3_price_change_notify(new.org_id, 'pricing', f, null);
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists zz_r3_pricing_changed on public.app_config;
create trigger zz_r3_pricing_changed after insert or update on public.app_config
  for each row execute function public._r3_tg_pricing_changed();

create or replace function public._r3_tg_menu_price_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
-- reprice-alert-0077: never blocks the save
begin
  begin
    if new.price_per_plate is distinct from old.price_per_plate then
      perform public._r3_price_change_notify(new.org_id, 'menu', array['platePrice'], new.name);
    end if;
  exception when others then null;
  end;
  return null;
end $$;
drop trigger if exists zz_r3_menu_price_changed on public.menu_templates;
create trigger zz_r3_menu_price_changed after update on public.menu_templates
  for each row execute function public._r3_tg_menu_price_changed();

-- bell: price_change entries only for people who can edit quotes
do $$ begin
  if to_regprocedure('public.bell_feed__pre0077(integer)') is null and to_regprocedure('public.bell_feed(integer)') is not null
     and position('reprice-alert-0077' in (select p.prosrc from pg_proc p where p.oid = 'public.bell_feed(integer)'::regprocedure)) = 0 then
    alter function public.bell_feed(integer) rename to bell_feed__pre0077;
  end if;
  if to_regprocedure('public.bell_feed__pre0077(integer)') is not null then
    revoke all on function public.bell_feed__pre0077(integer) from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.bell_feed__pre0077(integer) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.bell_feed__pre0077(integer) from authenticated'; end if;
  end if;
end $$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- reprice-alert-0077: price_change rows only for quote editors
declare v jsonb; v_drop integer;
begin
  v := public.bell_feed__pre0077(p_limit);
  if public.has_area('quotes', 'edit') or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  select count(*) into v_drop from jsonb_array_elements(v -> 'items') e(i)
   where e.i ->> 'kind' = 'price_change' and coalesce((e.i ->> 'unread')::boolean, false);
  return v || jsonb_build_object(
    'items', coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
                        where coalesce(e.i ->> 'kind', '') <> 'price_change'), '[]'::jsonb),
    'unread', greatest(coalesce((v ->> 'unread')::integer, 0) - v_drop, 0));
end $$;

-- 4) per-event profit for Insights --------------------------------------------------
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
  -- insights-events-0077
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
     where q.org_id = v_org and q.status = 'confirmed'
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

-- grants ----------------------------------------------------------------------------
revoke all on function public.recent_touch(text, text, text) from public;
revoke all on function public.recent_list(integer) from public;
revoke all on function public._r3_num(jsonb, text) from public;
revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from public;
revoke all on function public._r3_tg_pricing_changed() from public;
revoke all on function public._r3_tg_menu_price_changed() from public;
revoke all on function public.bell_feed(integer) from public;
revoke all on function public.insights_events(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.recent_touch(text, text, text) from anon';
    execute 'revoke all on function public.recent_list(integer) from anon';
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from anon';
    execute 'revoke all on function public.bell_feed(integer) from anon';
    execute 'revoke all on function public.insights_events(date, date) from anon';
    execute 'revoke all on function public._r3_tg_pricing_changed() from anon';
    execute 'revoke all on function public._r3_tg_menu_price_changed() from anon';
    execute 'revoke all on function public._r3_num(jsonb, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._r3_price_change_notify(uuid, text, text[], text) from authenticated';
    execute 'revoke all on function public._r3_tg_pricing_changed() from authenticated';
    execute 'revoke all on function public._r3_tg_menu_price_changed() from authenticated';
    execute 'revoke all on function public._r3_num(jsonb, text) from authenticated';
    execute 'grant execute on function public.recent_touch(text, text, text) to authenticated';
    execute 'grant execute on function public.recent_list(integer) to authenticated';
    execute 'grant execute on function public.bell_feed(integer) to authenticated';
    execute 'grant execute on function public.insights_events(date, date) to authenticated';
  end if;
end $$;

-- =====================================================================================
-- VERIFY (expect 9 rows, ALL ok = true)
-- =====================================================================================
select item, ok from (values
  ('01 recent records table with RLS', (coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.user_recent_records')), false))),
  ('02 recent_touch + recent_list exist', (to_regprocedure('public.recent_touch(text, text, text)') is not null and to_regprocedure('public.recent_list(integer)') is not null)),
  ('03 insights_events exists, definer, empty search_path', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.insights_events(date, date)')), false))),
  ('04 insights_events gated on insights + finance', (coalesce((select p.prosrc like '%has_area(''insights'', ''view'')%' and p.prosrc like '%has_area(''finance'', ''view'')%' and p.prosrc like '%q.org_id = v_org%' from pg_proc p where p.oid = to_regprocedure('public.insights_events(date, date)')), false))),
  ('05 price-list trigger present', (exists (select 1 from pg_trigger t where t.tgname = 'zz_r3_pricing_changed' and t.tgrelid = to_regclass('public.app_config')))),
  ('06 menu price trigger present', (exists (select 1 from pg_trigger t where t.tgname = 'zz_r3_menu_price_changed' and t.tgrelid = to_regclass('public.menu_templates')))),
  ('07 bell_feed wrapper + previous body kept', (to_regprocedure('public.bell_feed__pre0077(integer)') is not null and coalesce((select position('reprice-alert-0077' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)')), false))),
  ('08 authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.insights_events(date, date)', 'execute') and has_function_privilege('authenticated', 'public.recent_list(integer)', 'execute') and not has_function_privilege('anon', 'public.recent_touch(text, text, text)', 'execute') and not has_function_privilege('authenticated', 'public._r3_price_change_notify(uuid, text, text[], text)', 'execute'), false))),
  ('09 version tables in realtime publication', (not exists (select 1 from pg_publication where pubname = 'supabase_realtime') or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('quote_versions', 'quotation_versions')) = 2))
) v(item, ok)
order by item;
