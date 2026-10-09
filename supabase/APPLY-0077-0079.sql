-- APPLY-0077-0079.sql  --  ONE paste for round 3: 0077 (live history, re-price alerts, profit per event),
-- 0078 (payment reminders, client follow-ups, low-stock bell, WhatsApp forwarding - all dormant until switched on),
-- 0079 (tax by country; India unchanged). Run on STAGING first, then PROD, AFTER APPLY-0076.
-- Idempotent: safe to paste twice. Pure ASCII. The LAST result grid is the combined VERIFY: 25 rows, every ok = true.

-- ===================== APPLY-0077 =====================
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

-- ===================== APPLY-0078 =====================
-- APPLY-0078.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0078_comms_automation.sql verbatim.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: 5 new tables (RLS on), new functions + 2 triggers, the notification
-- catalog wrapped once (*__pre0078). No existing row is changed or deleted.
-- Requires 0041, 0050, 0065, 0069 (already applied on both databases).
-- AFTER APPLYING: nothing is sent until an admin switches it on in Control Center >
-- Notifications > "Automatic client messages & WhatsApp" AND the comms-dispatch edge
-- function is deployed with HELM_COMMS_ENABLED=true (see docs/COMMS-AUTOMATION-SETUP.md).
-- EXPECTED: the last result grid (item, ok) has 10 rows and EVERY ok = true.

-- ============================================================================
-- 0078_comms_automation.sql - CANONICAL forward-only. Automatic client messages,
-- low-stock bell warnings and WhatsApp forwarding of bell notifications.
--
-- In plain words:
--   1  comms_settings (one row per studio, admin-managed in Control Center):
--        * payment reminders: on/off, channels (email / whatsapp), N days before the
--          due date, on the due date, then every N days overdue up to M times, and a
--          message template ({client} {studio} {event} {label} {amount} {due} {status}).
--        * client follow-ups: on/off, channels, delay X days after the client FIRST
--          opened the booklet / approval link, max follow-ups, template.
--        * low-stock warnings in the bell: on/off (default on).
--        * WhatsApp forwarding: studio WhatsApp number, on/off, and per role which
--          notification types are forwarded (plus 'admin_message' = studio-wide
--          announcements posted in the chat broadcast channel).
--      Everything is OFF by default except the low-stock bell row. WhatsApp is never
--      used until the studio has saved its WhatsApp number.
--   2  client_link_opens - first / last time the client opened the booklet or the
--      approval page (public_link_opened, called by those signed-out pages; studio
--      members previewing their own link are ignored).
--   3  comms_outbox - every automatic message, one row per (purpose, target, stage,
--      channel) under a UNIQUE dedupe_key, so nothing is ever sent twice. Only the
--      service role reads it (claim / mark); the dormant edge function comms-dispatch
--      delivers it. A row is re-checked at claim time: a milestone that got paid, a
--      quote that got approved, a member who opted out -> 'skipped', never sent.
--   4  comms_tick() - run by pg_cron every 15 minutes (only if pg_cron is installed):
--      queues due payment reminders and follow-ups for studios that switched them on,
--      and writes deduped low-stock bell rows.
--   5  payment_reminder_send_now(milestone) - a planner's "Send reminder now" (at most
--      once per milestone + channel per 10 minutes).
--   6  member_wa_optin + my_wa_forward_get / my_wa_forward_set - each member opts in
--      to WhatsApp copies of their bell; the number is the WhatsApp number on their
--      profile (member_profiles, 0041). Forwarding is rate-limited (30 per member per
--      hour) and never forwards OTP rows or package rows that already have their own
--      WhatsApp message.
--   7  Sent client reminders / follow-ups are logged to notifications (kind
--      payment_reminder / client_follow_up, recipient = channel) so they appear in the
--      event's activity trail and the bell.
--   8  notification catalog: types inventory_low_stock and client_follow_up (rename
--      once to *__pre0078 and wrap, the 0069 pattern).
--
-- Additive + idempotent: new tables (RLS on, no API-role writes), new functions and
-- triggers, three catalog functions wrapped once. NO existing row is changed or
-- deleted. Requires 0041 (member_profiles), 0050 (rate_hit), 0065 (client_booklets),
-- 0069 (package flow + catalog wrap).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0078: has_area() is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0078: current_org_id() is not installed'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception '0078: 0050 (rate_hit) is not installed'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then raise exception '0078: 0045 (tg_studio_read_only) is not installed'; end if;
  if to_regclass('public.member_profiles') is null then raise exception '0078: 0041 (member_profiles) is not installed'; end if;
  if to_regclass('public.client_booklets') is null then raise exception '0078: 0065 (client_booklets) is not installed'; end if;
  if to_regclass('public.package_selections') is null then raise exception '0078: 0069 (package flow) is not installed'; end if;
  if to_regprocedure('public.notification_catalog__pre0069()') is null then raise exception '0078: 0069 catalog wrap is not installed'; end if;
end $$;

-- ---- 1) tables -------------------------------------------------------------------------
create table if not exists public.comms_settings (
  org_id             uuid primary key references public.organizations(id) on delete cascade,
  pay_enabled        boolean not null default false,
  pay_channels       text[]  not null default array['email']::text[],
  pay_before_days    integer not null default 3 check (pay_before_days between 0 and 30),
  pay_on_due         boolean not null default true,
  pay_every_days     integer not null default 3 check (pay_every_days between 1 and 30),
  pay_max_overdue    integer not null default 3 check (pay_max_overdue between 0 and 10),
  pay_template       text check (pay_template is null or (char_length(pay_template) <= 1000 and pay_template !~ '[<>]')),
  fu_enabled         boolean not null default false,
  fu_channels        text[]  not null default array['email']::text[],
  fu_delay_days      integer not null default 3 check (fu_delay_days between 1 and 30),
  fu_max             integer not null default 2 check (fu_max between 1 and 5),
  fu_template        text check (fu_template is null or (char_length(fu_template) <= 1000 and fu_template !~ '[<>]')),
  low_stock_enabled  boolean not null default true,
  wa_forward_enabled boolean not null default false,
  wa_forward_roles   jsonb   not null default '{}'::jsonb check (jsonb_typeof(wa_forward_roles) = 'object'),
  studio_whatsapp    text check (studio_whatsapp is null or studio_whatsapp ~ '^[0-9]{8,15}$'),
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  constraint comms_settings_channels_chk check (
    pay_channels <@ array['email', 'whatsapp']::text[] and fu_channels <@ array['email', 'whatsapp']::text[])
);

create table if not exists public.client_link_opens (
  quote_id        uuid not null references public.quotes(id) on delete cascade,
  kind            text not null check (kind in ('booklet', 'quote')),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  first_opened_at timestamptz not null default now(),
  last_opened_at  timestamptz not null default now(),
  open_count      integer not null default 1,
  primary key (quote_id, kind)
);

create table if not exists public.comms_outbox (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid references public.quotes(id) on delete cascade,
  milestone_id uuid,
  user_id      uuid,
  purpose      text not null check (purpose in ('pay_reminder', 'follow_up', 'wa_forward')),
  channel      text not null check (channel in ('email', 'whatsapp')),
  recipient    text not null check (char_length(recipient) between 3 and 200),
  payload      jsonb not null default '{}'::jsonb,
  dedupe_key   text not null check (char_length(dedupe_key) <= 200),
  status       text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create unique index if not exists comms_outbox_dedupe_key on public.comms_outbox(dedupe_key);
create index if not exists comms_outbox_pending_idx on public.comms_outbox(created_at) where sent_at is null;
create index if not exists comms_outbox_user_recent_idx on public.comms_outbox(user_id, created_at) where purpose = 'wa_forward';

create table if not exists public.member_wa_optin (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  opted_in   boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.inv_shortage_alerts (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  item_id     uuid not null references public.inventory_items(id) on delete cascade,
  event_date  date not null,
  need        numeric not null,
  have        numeric not null,
  notified_at timestamptz not null default now(),
  primary key (org_id, item_id, event_date)
);

-- RLS on; no direct API-role writes (RPCs only)
alter table public.comms_settings enable row level security;
alter table public.client_link_opens enable row level security;
alter table public.comms_outbox enable row level security;
alter table public.member_wa_optin enable row level security;
alter table public.inv_shortage_alerts enable row level security;
do $$ declare t text; begin
  foreach t in array array['comms_settings', 'client_link_opens', 'comms_outbox', 'member_wa_optin', 'inv_shortage_alerts'] loop
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    -- suspended studios are read-only for signed-in / signed-out callers (0045 guard; the
    -- service role and pg_cron are not affected, and every system write here is wrapped)
    execute format('drop trigger if exists zzz_studio_read_only on public.%I', t);
    execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
  end loop;
  -- quote <-> studio integrity (0004 G4) on the tables that carry both
  foreach t in array array['comms_outbox', 'client_link_opens'] loop
    execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
  end loop;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on table public.comms_settings to authenticated';
    execute 'grant select on table public.client_link_opens to authenticated';
  end if;
end $$;
drop policy if exists comms_settings_read on public.comms_settings;
create policy comms_settings_read on public.comms_settings for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('controls', 'view'));
drop policy if exists client_link_opens_read on public.client_link_opens;
create policy client_link_opens_read on public.client_link_opens for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'));

-- ---- 2) notification catalog: 2 new types (rename once + wrap) --------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['notification_catalog', ''],
    ['notification_type_of', 'text, text'],
    ['notify_default', 'uuid, text, text, text']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0078', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0078');
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0078', f[2]);
  end loop;
end $$;

create or replace function public.notification_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  -- comms-0078: the database's own catalog + low stock + client follow-up (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'inventory_low_stock') then c
    else c || $cat$[
    {"type":"inventory_low_stock","group":"Operations","label":"Low stock on an event date",
     "description":"Events on the same date need more of an inventory item than the studio owns (reservations, layout needs and check-outs). Shown to roles with Inventory access.",
     "audience":"staff","channels":["in_app","whatsapp"],"required":[],"gated":["whatsapp"],"money":false},
    {"type":"client_follow_up","group":"Sales","label":"Client follow-up sent",
     "description":"An automatic, polite follow-up went to a client who opened their booklet or quote but has not approved yet.",
     "audience":"client","channels":["in_app","email","whatsapp"],"required":["email","whatsapp"],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0078() as c) x;
$$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_kind, ''))) in ('inventory_low_stock', 'client_follow_up')
              then lower(btrim(p_kind))
              else public.notification_type_of__pre0078(p_kind, p_channel) end;
$$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- comms-0078: low stock -> admin + Inventory view ; follow-ups -> admin + Quotes view
  select case
    when p_type in ('inventory_low_stock', 'client_follow_up') then
      coalesce(p_role = 'admin', false) or coalesce(p_role = '*', false)
      or exists (select 1 from public.role_access ra where ra.org_id = p_org and ra.role = p_role and ra.can_view
                   and ra.area = case when p_type = 'inventory_low_stock' then 'inventory' else 'quotes' end)
    else public.notify_default__pre0078(p_org, p_role, p_type, p_channel) end;
$$;

-- ---- 3) helpers (internal) ----------------------------------------------------------------
create or replace function public._comms_default_pay_template()
returns text language sql immutable set search_path = '' as $$
  select 'Hi {client}, a gentle reminder from {studio}: the payment "{label}" of {amount} for {event} is {status} (due {due}). Thank you!'::text;
$$;
create or replace function public._comms_default_fu_template()
returns text language sql immutable set search_path = '' as $$
  select 'Hi {client}, this is {studio}. Just checking in on the proposal for {event} that we shared. Happy to answer any questions or make changes - simply reply to this message.'::text;
$$;

-- the studio's settings with defaults (a studio without a row = everything off but low stock)
create or replace function public._comms_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pay_enabled', coalesce(s.pay_enabled, false),
    'pay_channels', to_jsonb(coalesce(s.pay_channels, array['email']::text[])),
    'pay_before_days', coalesce(s.pay_before_days, 3),
    'pay_on_due', coalesce(s.pay_on_due, true),
    'pay_every_days', coalesce(s.pay_every_days, 3),
    'pay_max_overdue', coalesce(s.pay_max_overdue, 3),
    'pay_template', coalesce(s.pay_template, public._comms_default_pay_template()),
    'fu_enabled', coalesce(s.fu_enabled, false),
    'fu_channels', to_jsonb(coalesce(s.fu_channels, array['email']::text[])),
    'fu_delay_days', coalesce(s.fu_delay_days, 3),
    'fu_max', coalesce(s.fu_max, 2),
    'fu_template', coalesce(s.fu_template, public._comms_default_fu_template()),
    'low_stock_enabled', coalesce(s.low_stock_enabled, true),
    'wa_forward_enabled', coalesce(s.wa_forward_enabled, false),
    'wa_forward_roles', coalesce(s.wa_forward_roles, '{}'::jsonb),
    'studio_whatsapp', s.studio_whatsapp,
    'updated_at', s.updated_at)
  from (select 1) one left join public.comms_settings s on s.org_id = p_org;
$$;

-- {placeholder} substitution; unknown placeholders are left as typed
create or replace function public._comms_render(p_tpl text, p_vars jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := coalesce(p_tpl, ''); k text;
begin
  for k in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb)) loop
    v := replace(v, '{' || k || '}', coalesce(p_vars ->> k, ''));
  end loop;
  return left(v, 1000);
end $$;

create or replace function public._comms_money(p numeric)
returns text language sql immutable set search_path = '' as $$
  select 'Rs. ' || regexp_replace(to_char(round(coalesce(p, 0), 2), 'FM999,999,999,990.00'), '\.00$', '');
$$;

-- a client address for a channel, or null
create or replace function public._comms_client_to(p_client jsonb, p_channel text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if p_channel = 'email' then
    v := lower(btrim(coalesce(p_client ->> 'email', '')));
    if v ~ '^[^\s@<>"'',;:\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$' then return v; end if;
    return null;
  elsif p_channel = 'whatsapp' then
    v := public.helm_norm_phone(regexp_replace(coalesce(p_client ->> 'phone', ''), '[^0-9]', '', 'g'));
    if v ~ '^[0-9]{8,15}$' then return v; end if;
    return null;
  end if;
  return null;
end $$;

-- a quote that is still a live, studio-visible event
create or replace function public._comms_quote_live(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select q.deleted_at is null and q.archived_at is null and coalesce(q.status, '') <> 'cancelled'
                     and coalesce(q.lifecycle_stage, '') <> 'closed'
                     from public.quotes q where q.id = p_quote), false);
$$;

-- channels actually usable for a studio (WhatsApp only once the studio saved its number)
create or replace function public._comms_channels(p_cfg jsonb, p_key text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(c order by c), '{}'::text[])
    from jsonb_array_elements_text(coalesce(p_cfg -> p_key, '[]'::jsonb)) c
   where c = 'email' or (c = 'whatsapp' and coalesce(p_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$');
$$;

-- queue one payment reminder for a milestone on every usable channel; returns rows queued
create or replace function public._comms_queue_pay(p_milestone uuid, p_stage text, p_status_text text, p_manual boolean, p_actor uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare m public.payment_milestones; q public.quotes; v_cfg jsonb; ch text; v_to text; v_text text; v_n integer := 0; v_rows integer;
  v_studio text; v_key text;
begin
  select * into m from public.payment_milestones x where x.id = p_milestone;
  if m.id is null or m.status not in ('due', 'invoiced') or coalesce(m.amount, 0) <= 0 then return 0; end if;
  select * into q from public.quotes x where x.id = m.quote_id;
  if q.id is null or q.org_id is distinct from m.org_id or not public._comms_quote_live(q.id) then return 0; end if;
  v_cfg := public._comms_cfg(q.org_id);
  select o.name into v_studio from public.organizations o where o.id = q.org_id;
  v_text := public._comms_render(v_cfg ->> 'pay_template', jsonb_build_object(
    'client', coalesce(nullif(btrim(q.client ->> 'name'), ''), 'there'), 'studio', coalesce(v_studio, 'your planner'),
    'event', coalesce(nullif(btrim(q.title), ''), 'your event'), 'label', m.label, 'amount', public._comms_money(m.amount),
    'due', coalesce(to_char(m.due_date, 'DD Mon YYYY'), 'soon'), 'status', p_status_text));
  foreach ch in array public._comms_channels(v_cfg, 'pay_channels') loop
    v_to := public._comms_client_to(q.client, ch);
    if v_to is null then continue; end if;
    v_key := case when p_manual then 'pay:now:' || m.id || ':' || ch || ':' || floor(extract(epoch from now()) / 600)::bigint
                  else 'pay:' || m.id || ':' || p_stage || ':' || ch end;
    insert into public.comms_outbox(org_id, quote_id, milestone_id, purpose, channel, recipient, payload, dedupe_key, created_by)
      values (q.org_id, q.id, m.id, 'pay_reminder', ch, v_to,
              jsonb_build_object('subject', 'Payment reminder - ' || coalesce(nullif(btrim(q.title), ''), 'your event'),
                                 'text', v_text, 'stage', p_stage, 'manual', p_manual, 'studio', v_studio),
              v_key, p_actor)
      on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

-- ---- 4) WhatsApp forwarding of bell rows ---------------------------------------------------
-- one opted-in member list per (studio, type); never raises
create or replace function public._comms_forward(p_org uuid, p_type text, p_quote uuid, p_payload jsonb, p_dedupe text, p_skip_user uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_cfg jsonb := public._comms_cfg(p_org); r record; v_n integer := 0; v_rows integer; v_recent integer;
begin
  if not coalesce((v_cfg ->> 'wa_forward_enabled')::boolean, false)
     or coalesce(v_cfg ->> 'studio_whatsapp', '') !~ '^[0-9]{8,15}$' then return 0; end if;
  for r in
    select p.id, p.role,
           coalesce(nullif(btrim(mp.whatsapp), ''), case when mp.whatsapp_same then nullif(btrim(mp.phone), '') end) as wa
      from public.profiles p
      join public.member_wa_optin o on o.user_id = p.id and o.org_id = p_org and o.opted_in
      left join public.member_profiles mp on mp.user_id = p.id
     where p.org_id = p_org and coalesce(p.role, 'client') <> 'client'
       and (p_skip_user is null or p.id <> p_skip_user)
       and coalesce((v_cfg -> 'wa_forward_roles' -> p.role) ? p_type, false)
       and (p_type = 'admin_message' or (
             public.notify_allowed_user(p_org, p.id, p_type, 'in_app')
             and not exists (select 1 from public.notification_mutes nm where nm.user_id = p.id and nm.org_id = p_org and nm.type = p_type)))
  loop
    if r.wa is null or regexp_replace(r.wa, '[^0-9]', '', 'g') !~ '^[0-9]{8,15}$' then continue; end if;
    select count(*) into v_recent from public.comms_outbox c
     where c.user_id = r.id and c.purpose = 'wa_forward' and c.created_at > now() - interval '1 hour';
    if v_recent >= 30 then continue; end if;                     -- rate limit: 30 per member per hour
    insert into public.comms_outbox(org_id, quote_id, user_id, purpose, channel, recipient, payload, dedupe_key)
      values (p_org, p_quote, r.id, 'wa_forward', 'whatsapp', regexp_replace(r.wa, '[^0-9]', '', 'g'),
              coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('type', p_type), p_dedupe || ':' || r.id::text)
      on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_n := v_n + v_rows;
  end loop;
  return v_n;
end $$;

create or replace function public._comms_tg_forward()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text; v_label text; v_code text; v_title text; v_d jsonb := coalesce(NEW.detail, '{}'::jsonb);
begin
  begin
    if NEW.org_id is null or coalesce(NEW.status, '') in ('suppressed', 'failed') or coalesce(v_d ->> 'via', '') = 'comms' then return null; end if;
    v_type := public.notification_type_of(NEW.kind, NEW.channel);
    -- OTP rows never; package rows already have their own staff WhatsApp (0069)
    if v_type in ('otp', 'pkg_selected', 'pkg_payment') then return null; end if;
    if not coalesce((public._comms_cfg(NEW.org_id) ->> 'wa_forward_enabled')::boolean, false) then return null; end if;
    select c ->> 'label' into v_label from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' = v_type limit 1;
    if NEW.quote_id is not null then select q.code, q.title into v_code, v_title from public.quotes q where q.id = NEW.quote_id; end if;
    perform public._comms_forward(NEW.org_id, v_type, NEW.quote_id, jsonb_build_object(
      'kind', NEW.kind, 'channel', NEW.channel, 'quote_id', NEW.quote_id, 'event_code', v_code,
      'detail', jsonb_strip_nulls(jsonb_build_object('task_id', v_d ->> 'task_id', 'item_id', v_d ->> 'item_id', 'path', v_d ->> 'path')),
      'text', left('Helm: ' || coalesce(v_label, replace(coalesce(NEW.kind, 'update'), '_', ' '))
                   || case when v_code is not null then ' - ' || v_code || coalesce(' ' || nullif(btrim(v_title), ''), '') else '' end, 300)),
      'fwd:n:' || NEW.id::text, null);
  exception when others then raise warning 'comms-0078: forward skipped (%)', sqlstate;
  end;
  return null;
end $$;
drop trigger if exists zzz_comms_forward on public.notifications;
create trigger zzz_comms_forward after insert on public.notifications
  for each row execute function public._comms_tg_forward();

-- studio announcements (chat broadcast channel) -> type 'admin_message'
create or replace function public._comms_tg_broadcast()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_from text;
begin
  begin
    if coalesce(NEW.deleted, false) or NEW.org_id is null then return null; end if;
    select c.kind into v_kind from public.chat_conversations c where c.id = NEW.conversation_id;
    if v_kind is distinct from 'broadcast' then return null; end if;
    select coalesce(nullif(btrim(p.full_name), ''), 'Studio admin') into v_from from public.profiles p where p.id = NEW.sender_id;
    perform public._comms_forward(NEW.org_id, 'admin_message', null, jsonb_build_object(
      '__chat', true, 'conversation_id', NEW.conversation_id, 'msg_id', NEW.id,
      'text', left('Helm announcement from ' || coalesce(v_from, 'Studio admin') || ': '
                   || coalesce(nullif(btrim(regexp_replace(coalesce(NEW.body, ''), '\s+', ' ', 'g')), ''), '(attachment)'), 300)),
      'fwd:c:' || NEW.id::text, NEW.sender_id);
  exception when others then raise warning 'comms-0078: broadcast forward skipped (%)', sqlstate;
  end;
  return null;
end $$;
drop trigger if exists zzz_comms_broadcast on public.chat_messages;
create trigger zzz_comms_broadcast after insert on public.chat_messages
  for each row execute function public._comms_tg_broadcast();

-- ---- 5) low stock (bell, deduped) -------------------------------------------------------------
-- per (item, date): sum over live events of greatest(reservations, still-out check-outs,
-- layout / resource needs) vs total stock minus stock out on no event. One bell row per
-- (item, date) and again only if the shortfall grows.
create or replace function public._comms_low_stock(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_n integer := 0; v_tz text; v_today date; v_prev numeric; v_qid uuid; v_code text;
begin
  select coalesce(o.timezone, 'Asia/Kolkata') into v_tz from public.organizations o where o.id = p_org;
  begin v_today := (now() at time zone v_tz)::date; exception when others then v_today := current_date; end;
  for r in
    with ev as (
      select q.id, q.event_date from public.quotes q
       where q.org_id = p_org and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled'
         and coalesce(q.lifecycle_stage, '') <> 'closed'
         and q.event_date between v_today and v_today + 90
    ), per as (
      select i.id as item_id, i.name, i.total_qty, e.event_date, e.id as qid,
             greatest(
               coalesce((select sum(x.qty) from public.inventory_reservations x where x.item_id = i.id and x.quote_id = e.id and x.status in ('reserved', 'allocated')), 0),
               coalesce((select sum(c.qty_out - coalesce(c.qty_in, 0)) from public.inventory_checkouts c where c.item_id = i.id and c.quote_id = e.id and c.status in ('out', 'partial')), 0),
               coalesce((select sum(n.qty) from public.event_resource_needs n where n.item_id = i.id and n.quote_id = e.id and coalesce(n.status, 'open') not in ('cancelled', 'closed')), 0)) as d
        from public.inventory_items i cross join ev e
       where i.org_id = p_org and i.active
    ), agg as (
      select p.item_id, p.name, p.total_qty, p.event_date, sum(p.d) as need, count(*) filter (where p.d > 0) as events,
             (array_agg(p.qid order by p.d desc))[1] as top_q
        from per p group by p.item_id, p.name, p.total_qty, p.event_date
    )
    select a.*, greatest(a.total_qty - coalesce((select sum(c.qty_out - coalesce(c.qty_in, 0)) from public.inventory_checkouts c
                                                  where c.item_id = a.item_id and c.quote_id is null and c.status in ('out', 'partial')), 0), 0) as have
      from agg a
  loop
    if r.need <= r.have or r.need <= 0 then continue; end if;
    select s.need into v_prev from public.inv_shortage_alerts s where s.org_id = p_org and s.item_id = r.item_id and s.event_date = r.event_date;
    if v_prev is not null and r.need <= v_prev then continue; end if;      -- already told; only a bigger gap re-notifies
    insert into public.inv_shortage_alerts(org_id, item_id, event_date, need, have, notified_at)
      values (p_org, r.item_id, r.event_date, r.need, r.have, now())
      on conflict (org_id, item_id, event_date) do update set need = excluded.need, have = excluded.have, notified_at = now();
    v_qid := r.top_q;
    select q.code into v_code from public.quotes q where q.id = v_qid;
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (v_qid, 'in_app', 'inventory_low_stock', 'simulated', jsonb_build_object(
        'item_id', r.item_id, 'item', left(r.name, 80), 'date', r.event_date, 'need', r.need, 'have', r.have,
        'short', r.need - r.have, 'events', r.events, 'event_code', v_code), p_org);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---- 6) the scheduler (pg_cron / service role) ------------------------------------------------
create or replace function public.comms_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare o record; v_cfg jsonb; v_today date; m record; d integer; v_stage text; v_txt text; n integer;
  v_pay integer := 0; v_fu integer := 0; v_low integer := 0; f record; v_ch text; v_to text; v_text text; v_key text; v_rows integer;
begin
  -- comms-tick-0078: service role / pg_cron only (EXECUTE is granted to service_role alone)
  for o in select org.id, org.name, coalesce(org.timezone, 'Asia/Kolkata') as tz from public.organizations org loop
    begin
      v_cfg := public._comms_cfg(o.id);
      begin v_today := (now() at time zone o.tz)::date; exception when others then v_today := current_date; end;

      -- payment reminders
      if coalesce((v_cfg ->> 'pay_enabled')::boolean, false) then
        for m in
          select pm.id, pm.due_date from public.payment_milestones pm join public.quotes q on q.id = pm.quote_id
           where pm.org_id = o.id and q.org_id = o.id and pm.status in ('due', 'invoiced') and pm.amount > 0 and pm.due_date is not null
             and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled' and coalesce(q.lifecycle_stage, '') <> 'closed'
             and pm.due_date between v_today - 400 and v_today + 30
        loop
          d := m.due_date - v_today; v_stage := null;
          if d > 0 and d <= (v_cfg ->> 'pay_before_days')::int then
            v_stage := 'pre'; v_txt := 'due in ' || d || case when d = 1 then ' day' else ' days' end;
          elsif d = 0 and (v_cfg ->> 'pay_on_due')::boolean then
            v_stage := 'due'; v_txt := 'due today';
          elsif d < 0 then
            n := floor((-d)::numeric / (v_cfg ->> 'pay_every_days')::int)::int;
            if n between 1 and (v_cfg ->> 'pay_max_overdue')::int then
              v_stage := 'od' || n; v_txt := 'overdue by ' || (-d) || case when d = -1 then ' day' else ' days' end;
            end if;
          end if;
          if v_stage is not null then v_pay := v_pay + public._comms_queue_pay(m.id, v_stage, v_txt, false, null); end if;
        end loop;
      end if;

      -- client follow-ups: opened, not approved / declined, no package choice since
      if coalesce((v_cfg ->> 'fu_enabled')::boolean, false) then
        for f in
          select q.id, q.client, q.title, min(lo.first_opened_at) as opened
            from public.quotes q join public.client_link_opens lo on lo.quote_id = q.id
           where q.org_id = o.id and q.deleted_at is null and q.archived_at is null
             and q.status not in ('cancelled', 'confirmed') and coalesce(q.lifecycle_stage, '') <> 'closed'
             and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled')
           group by q.id, q.client, q.title
        loop
          if exists (select 1 from public.package_selections s where s.quote_id = f.id and s.created_at >= f.opened) then continue; end if;
          n := floor(extract(epoch from (now() - f.opened)) / 86400 / (v_cfg ->> 'fu_delay_days')::int)::int;
          if n < 1 or n > (v_cfg ->> 'fu_max')::int then continue; end if;
          v_text := public._comms_render(v_cfg ->> 'fu_template', jsonb_build_object(
            'client', coalesce(nullif(btrim(f.client ->> 'name'), ''), 'there'), 'studio', coalesce(o.name, 'your planner'),
            'event', coalesce(nullif(btrim(f.title), ''), 'your event')));
          foreach v_ch in array public._comms_channels(v_cfg, 'fu_channels') loop
            v_to := public._comms_client_to(f.client, v_ch);
            if v_to is null then continue; end if;
            v_key := 'fu:' || f.id || ':' || n || ':' || v_ch;
            insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
              values (o.id, f.id, 'follow_up', v_ch, v_to, jsonb_build_object('subject', 'Following up - '
                      || coalesce(nullif(btrim(f.title), ''), 'your event'), 'text', v_text, 'stage', 'fu' || n, 'studio', o.name), v_key)
              on conflict (dedupe_key) do nothing;
            get diagnostics v_rows = row_count;
            v_fu := v_fu + v_rows;
          end loop;
        end loop;
      end if;

      if coalesce((v_cfg ->> 'low_stock_enabled')::boolean, true) then v_low := v_low + public._comms_low_stock(o.id); end if;
    exception when others then raise warning 'comms-0078: studio tick skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('pay_reminders', v_pay, 'follow_ups', v_fu, 'low_stock', v_low);
end $$;

-- ---- 7) outbox claim / mark (service role; edge function comms-dispatch) ----------------------
create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_cfg jsonb;
begin
  update public.comms_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now() where sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.sent_at is null and c.status = 'pending' and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    -- re-check at send time: paid / approved / opted out -> skipped, never sent
    v_cfg := public._comms_cfg(r.org_id);
    v_ok := case r.purpose
      when 'pay_reminder' then exists (select 1 from public.payment_milestones m where m.id = r.milestone_id and m.status in ('due', 'invoiced'))
                               and public._comms_quote_live(r.quote_id)
      when 'follow_up' then public._comms_quote_live(r.quote_id) and coalesce((v_cfg ->> 'fu_enabled')::boolean, false)
                            and exists (select 1 from public.quotes q where q.id = r.quote_id and q.status <> 'confirmed'
                                          and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled'))
      when 'wa_forward' then coalesce((v_cfg ->> 'wa_forward_enabled')::boolean, false)
                             and exists (select 1 from public.member_wa_optin w join public.profiles p on p.id = w.user_id
                                          where w.user_id = r.user_id and w.opted_in and p.org_id = r.org_id)
      else false end;
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

create or replace function public.comms_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare r public.comms_outbox;
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.comms_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.comms_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null returning * into r;
  -- activity trail: a delivered client reminder / follow-up is logged once (row was unsent until now)
  if r.id is not null and p_status = 'sent' and r.purpose in ('pay_reminder', 'follow_up') and r.quote_id is not null then
    begin
      insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
        values (r.quote_id, r.channel, r.channel, case when r.purpose = 'pay_reminder' then 'payment_reminder' else 'client_follow_up' end,
                'sent', jsonb_build_object('via', 'comms', 'auto', not coalesce((r.payload ->> 'manual')::boolean, false),
                                           'stage', r.payload ->> 'stage', 'milestone_id', r.milestone_id), r.org_id);
    exception when others then raise warning 'comms-0078: activity log skipped (%)', sqlstate;
    end;
  end if;
  return p_status;
end $$;

-- ---- 8) RPCs for the app ----------------------------------------------------------------------
-- Control Center: read (controls VIEW)
create or replace function public.comms_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('controls', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._comms_cfg(v_org) || jsonb_build_object(
    'roles', to_jsonb(public._notify_roles()),
    'types', coalesce((select jsonb_agg(jsonb_build_object('type', c ->> 'type', 'label', c ->> 'label', 'group', c ->> 'group') order by c ->> 'group', c ->> 'label')
                         from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' not in ('otp', 'pkg_selected', 'pkg_payment')), '[]'::jsonb)
             || jsonb_build_array(jsonb_build_object('type', 'admin_message', 'label', 'Studio announcements (admin messages)', 'group', 'Chat')),
    'default_pay_template', public._comms_default_pay_template(),
    'default_fu_template', public._comms_default_fu_template(),
    'pending', (select count(*) from public.comms_outbox c where c.org_id = v_org and c.sent_at is null));
end $$;

-- Control Center: write (controls EDIT). Only the keys given change.
create or replace function public.comms_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; v_roles jsonb; r text; t text;
  v_types text[]; v_allowed text[] := array['pay_enabled', 'pay_channels', 'pay_before_days', 'pay_on_due', 'pay_every_days',
    'pay_max_overdue', 'pay_template', 'fu_enabled', 'fu_channels', 'fu_delay_days', 'fu_max', 'fu_template',
    'low_stock_enabled', 'wa_forward_enabled', 'wa_forward_roles', 'studio_whatsapp'];
  v_wa text;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (v_allowed)) then raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['pay_enabled', 'pay_on_due', 'fu_enabled', 'low_stock_enabled', 'wa_forward_enabled'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['pay_before_days', 'pay_every_days', 'pay_max_overdue', 'fu_delay_days', 'fu_max'] loop
    if p ? k and (jsonb_typeof(p -> k) <> 'number' or (p ->> k) !~ '^[0-9]{1,2}$') then raise exception '% must be a whole number', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['pay_channels', 'fu_channels'] loop
    if p ? k and (jsonb_typeof(p -> k) <> 'array' or exists (select 1 from jsonb_array_elements(p -> k) e
                    where jsonb_typeof(e) <> 'string' or e #>> '{}' not in ('email', 'whatsapp'))) then
      raise exception '% must be a list of email / whatsapp', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['pay_template', 'fu_template'] loop
    if p ? k and jsonb_typeof(p -> k) not in ('string', 'null') then raise exception '% must be text', k using errcode = '22023'; end if;
  end loop;
  if p ? 'studio_whatsapp' then
    if jsonb_typeof(p -> 'studio_whatsapp') = 'null' or btrim(coalesce(p ->> 'studio_whatsapp', '')) = '' then v_wa := null;
    else
      v_wa := public.helm_norm_phone(regexp_replace(p ->> 'studio_whatsapp', '[^0-9]', '', 'g'));
      if v_wa !~ '^[0-9]{8,15}$' then raise exception 'enter a valid WhatsApp number' using errcode = '22023'; end if;
    end if;
  end if;
  if p ? 'wa_forward_roles' then
    v_roles := p -> 'wa_forward_roles';
    if jsonb_typeof(v_roles) <> 'object' then raise exception 'wa_forward_roles must be an object' using errcode = '22023'; end if;
    v_types := array(select c ->> 'type' from jsonb_array_elements(public.notification_catalog()) c) || array['admin_message'];
    for r in select jsonb_object_keys(v_roles) loop
      if not (r = any (public._notify_roles())) then raise exception 'unknown role %', r using errcode = '22023'; end if;
      if jsonb_typeof(v_roles -> r) <> 'array' then raise exception 'role % must list types', r using errcode = '22023'; end if;
      for t in select jsonb_array_elements_text(v_roles -> r) loop
        if not (t = any (v_types)) or t in ('otp', 'pkg_selected', 'pkg_payment') then raise exception 'unknown type %', t using errcode = '22023'; end if;
      end loop;
    end loop;
  end if;

  insert into public.comms_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  update public.comms_settings s set
    pay_enabled        = case when p ? 'pay_enabled' then (p ->> 'pay_enabled')::boolean else s.pay_enabled end,
    pay_channels       = case when p ? 'pay_channels' then array(select distinct jsonb_array_elements_text(p -> 'pay_channels')) else s.pay_channels end,
    pay_before_days    = case when p ? 'pay_before_days' then (p ->> 'pay_before_days')::int else s.pay_before_days end,
    pay_on_due         = case when p ? 'pay_on_due' then (p ->> 'pay_on_due')::boolean else s.pay_on_due end,
    pay_every_days     = case when p ? 'pay_every_days' then (p ->> 'pay_every_days')::int else s.pay_every_days end,
    pay_max_overdue    = case when p ? 'pay_max_overdue' then (p ->> 'pay_max_overdue')::int else s.pay_max_overdue end,
    pay_template       = case when p ? 'pay_template' then nullif(btrim(coalesce(p ->> 'pay_template', '')), '') else s.pay_template end,
    fu_enabled         = case when p ? 'fu_enabled' then (p ->> 'fu_enabled')::boolean else s.fu_enabled end,
    fu_channels        = case when p ? 'fu_channels' then array(select distinct jsonb_array_elements_text(p -> 'fu_channels')) else s.fu_channels end,
    fu_delay_days      = case when p ? 'fu_delay_days' then (p ->> 'fu_delay_days')::int else s.fu_delay_days end,
    fu_max             = case when p ? 'fu_max' then (p ->> 'fu_max')::int else s.fu_max end,
    fu_template        = case when p ? 'fu_template' then nullif(btrim(coalesce(p ->> 'fu_template', '')), '') else s.fu_template end,
    low_stock_enabled  = case when p ? 'low_stock_enabled' then (p ->> 'low_stock_enabled')::boolean else s.low_stock_enabled end,
    wa_forward_enabled = case when p ? 'wa_forward_enabled' then (p ->> 'wa_forward_enabled')::boolean else s.wa_forward_enabled end,
    wa_forward_roles   = case when p ? 'wa_forward_roles' then v_roles else s.wa_forward_roles end,
    studio_whatsapp    = case when p ? 'studio_whatsapp' then v_wa else s.studio_whatsapp end,
    updated_at = now(), updated_by = v_me
   where s.org_id = v_org;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'comms_settings.set', 'comms_settings', v_org::text, p - 'studio_whatsapp'
            || case when p ? 'studio_whatsapp' then jsonb_build_object('studio_whatsapp', case when v_wa is null then 'cleared' else 'set' end) else '{}'::jsonb end, v_org);
  return public._comms_cfg(v_org);
end $$;

-- "Send reminder now" (finance or quotes EDIT, own studio)
create or replace function public.payment_reminder_send_now(p_milestone uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); m public.payment_milestones; q public.quotes; v_n integer;
  v_cfg jsonb; v_due text;
begin
  if v_me is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = m.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  if m.status not in ('due', 'invoiced') then raise exception 'this milestone is already settled' using errcode = '22023'; end if;
  if coalesce(m.amount, 0) <= 0 then raise exception 'this milestone has no amount' using errcode = '22023'; end if;
  v_cfg := public._comms_cfg(v_org);
  if cardinality(public._comms_channels(v_cfg, 'pay_channels')) = 0 then
    raise exception 'choose a reminder channel in Control Center first' using errcode = '22023'; end if;
  if not exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c where public._comms_client_to(q.client, c) is not null) then
    raise exception 'add the client''s e-mail or WhatsApp number to the event first' using errcode = '22023'; end if;
  v_due := case when m.due_date is null then 'due' when m.due_date < current_date then 'overdue' when m.due_date = current_date then 'due today' else 'due soon' end;
  v_n := public._comms_queue_pay(m.id, 'manual', v_due, true, v_me);
  if v_n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'payment_reminder.queued', 'payment_milestones', m.id::text, q.id, jsonb_build_object('rows', v_n), v_org);
  end if;
  return jsonb_build_object('queued', v_n, 'already_queued', v_n = 0);
end $$;

-- a member's own WhatsApp forwarding switch
create or replace function public.my_wa_forward_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_cfg jsonb; v_wa text; v_role text;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_cfg := public._comms_cfg(v_org);
  select p.role into v_role from public.profiles p where p.id = v_me;
  select coalesce(nullif(btrim(mp.whatsapp), ''), case when mp.whatsapp_same then nullif(btrim(mp.phone), '') end) into v_wa
    from public.member_profiles mp where mp.user_id = v_me;
  return jsonb_build_object(
    'opted_in', coalesce((select w.opted_in from public.member_wa_optin w where w.user_id = v_me and w.org_id = v_org), false),
    'has_number', v_wa is not null,
    'number_tail', case when v_wa is null then null else right(regexp_replace(v_wa, '[^0-9]', '', 'g'), 4) end,
    'studio_ready', coalesce((v_cfg ->> 'wa_forward_enabled')::boolean, false) and coalesce(v_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$',
    'types', coalesce(v_cfg -> 'wa_forward_roles' -> v_role, '[]'::jsonb));
end $$;

create or replace function public.my_wa_forward_set(p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null or p_on is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and coalesce(p.role, 'client') <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.member_wa_optin(user_id, org_id, opted_in, updated_at) values (v_me, v_org, p_on, now())
    on conflict (user_id) do update set opted_in = excluded.opted_in, org_id = excluded.org_id, updated_at = now();
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_me, 'wa_forward.optin', 'member_wa_optin', v_me::text, jsonb_build_object('opted_in', p_on), v_org);
  return public.my_wa_forward_get();
end $$;

-- signed-out booklet / approval page: "the client opened it" (rate-limited, no data returned)
create or replace function public.public_link_opened(p_kind text, p_token uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_q uuid; v_org uuid;
begin
  if p_token is null or p_kind not in ('booklet', 'quote') then return; end if;
  if public.rate_hit('link_open', p_token::text, 3600, 60) > 60 then return; end if;
  if p_kind = 'booklet' then
    select b.quote_id, b.org_id into v_q, v_org from public.client_booklets b
     where b.token = p_token and b.revoked_at is null and b.expires_at > now();
  else
    select q.id, q.org_id into v_q, v_org from public.quotes q
     where q.approval_token = p_token and q.approval_token_revoked_at is null
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  end if;
  if v_q is null then return; end if;
  -- a studio member previewing their own link is not "the client opened it"
  if auth.uid() is not null and exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id = v_org) then return; end if;
  begin
    insert into public.client_link_opens(quote_id, kind, org_id) values (v_q, p_kind, v_org)
      on conflict (quote_id, kind) do update set last_opened_at = now(), open_count = public.client_link_opens.open_count + 1;
  exception when others then return;      -- e.g. a suspended (read-only) studio: never break the client's page
  end;
end $$;

-- ---- 9) privileges ------------------------------------------------------------------------------
-- (the three wrapped catalog functions keep the same privileges the 0069 wrappers have)
do $$ declare f text; begin
  foreach f in array array[
    'public._comms_default_pay_template()', 'public._comms_default_fu_template()', 'public._comms_cfg(uuid)',
    'public._comms_render(text, jsonb)', 'public._comms_money(numeric)', 'public._comms_client_to(jsonb, text)',
    'public._comms_quote_live(uuid)', 'public._comms_channels(jsonb, text)',
    'public._comms_queue_pay(uuid, text, text, boolean, uuid)', 'public._comms_forward(uuid, text, uuid, jsonb, text, uuid)',
    'public._comms_tg_forward()', 'public._comms_tg_broadcast()', 'public._comms_low_stock(uuid)',
    'public.comms_tick()', 'public.comms_outbox_claim(integer)', 'public.comms_outbox_mark(uuid, text)',
    'public.comms_settings_get()', 'public.comms_settings_set(jsonb)', 'public.payment_reminder_send_now(uuid)',
    'public.my_wa_forward_get()', 'public.my_wa_forward_set(boolean)', 'public.public_link_opened(text, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    -- hosted Supabase default privileges grant new functions to the API roles; take them back
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.comms_settings_get() to authenticated';
    execute 'grant execute on function public.comms_settings_set(jsonb) to authenticated';
    execute 'grant execute on function public.payment_reminder_send_now(uuid) to authenticated';
    execute 'grant execute on function public.my_wa_forward_get() to authenticated';
    execute 'grant execute on function public.my_wa_forward_set(boolean) to authenticated';
    execute 'grant execute on function public.public_link_opened(text, uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.public_link_opened(text, uuid) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.comms_tick() to service_role';
    execute 'grant execute on function public.comms_outbox_claim(integer) to service_role';
    execute 'grant execute on function public.comms_outbox_mark(uuid, text) to service_role';
  end if;
end $$;

-- ---- 10) pg_cron, ONLY if it is already installed (never created here) -------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_comms_tick') then
        perform cron.schedule('helm_comms_tick', '*/15 * * * *', 'select public.comms_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_comms_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

-- =====================================================================================

-- ===================== APPLY-0079 =====================
-- APPLY-0079.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0079_country_tax.sql verbatim, plus VERIFY.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: renames the current total function once and wraps it. No row is changed.
-- EXPECTED: the last result grid (item, ok) has 6 rows and EVERY ok = true.

-- 0079_country_tax.sql - CANONICAL forward-only. Country-based tax: tax-inclusive prices.
--
-- In plain words:
--   A studio now picks its country (India, UAE, UK, US, Singapore, Australia, Canada or
--   other). The country only changes LABELS (GST / VAT / Sales tax, GSTIN / TRN / ABN ...),
--   the currency symbol and the suggested default rate - the money is still ONE rate kept
--   in quotes.pricing.gstPct, so the existing D8 server pricing authority keeps working.
--   The one new money rule: an admin may say "my prices already include tax". A quote
--   saved that way carries pricing.taxInclusive = true, and its total is the post-discount
--   value itself (the tax is extracted from it for display, not added on top).
--
--   This file wraps helm_quote_total once more (the same rename-and-wrap pattern as 0026):
--     * the current function is kept, unchanged, as helm_quote_total__pretax
--     * the new helm_quote_total: when pricing.taxInclusive is true it prices the quote with
--       gstPct 0 (= round(post-discount value)); otherwise it returns EXACTLY what the old
--       function returned. Mirrors store-api.js pricing._canon (taxInclusive branch).
--
--   Existing quotes never carry taxInclusive, so every existing and re-priced India quote
--   comes to the same rupee as before. Additive + idempotent: no table, column or row is
--   created, changed or deleted. Pure calculation - reads no table, so it cannot cross
--   tenants; it runs inside the per-quote pricing trigger that is already org-scoped.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then
    raise exception '0079: helm_quote_total(jsonb) is not installed (apply 0001 + 0026 first)';
  end if;
  if to_regprocedure('public.helm_quote_total__pretax(jsonb)') is null then
    alter function public.helm_quote_total(jsonb) rename to helm_quote_total__pretax;
  end if;
end $$;

revoke all on function public.helm_quote_total__pretax(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total__pretax(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.helm_quote_total__pretax(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total__pretax(jsonb) to service_role;
  end if;
end $$;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable security definer set search_path = '' as $$
-- country-tax-0079: taxInclusive -> price at gstPct 0, else unchanged
begin
  if p is not null and jsonb_typeof(p) = 'object'
     and lower(coalesce(p ->> 'taxInclusive', '')) = 'true' then
    return public.helm_quote_total__pretax(p || jsonb_build_object('gstPct', 0));
  end if;
  return public.helm_quote_total__pretax(p);
end $$;

revoke all on function public.helm_quote_total(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.helm_quote_total(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total(jsonb) to service_role;
  end if;
end $$;

-- =====================================================================================

-- =====================================================================================
-- COMBINED VERIFY (expect 25 rows, ALL ok = true)
-- =====================================================================================
select item, ok from (values
('0077 01 recent records table with RLS', (coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.user_recent_records')), false))),
  ('0077 02 recent_touch + recent_list exist', (to_regprocedure('public.recent_touch(text, text, text)') is not null and to_regprocedure('public.recent_list(integer)') is not null)),
  ('0077 03 insights_events exists, definer, empty search_path', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.insights_events(date, date)')), false))),
  ('0077 04 insights_events gated on insights + finance', (coalesce((select p.prosrc like '%has_area(''insights'', ''view'')%' and p.prosrc like '%has_area(''finance'', ''view'')%' and p.prosrc like '%q.org_id = v_org%' from pg_proc p where p.oid = to_regprocedure('public.insights_events(date, date)')), false))),
  ('0077 05 price-list trigger present', (exists (select 1 from pg_trigger t where t.tgname = 'zz_r3_pricing_changed' and t.tgrelid = to_regclass('public.app_config')))),
  ('0077 06 menu price trigger present', (exists (select 1 from pg_trigger t where t.tgname = 'zz_r3_menu_price_changed' and t.tgrelid = to_regclass('public.menu_templates')))),
  ('0077 07 bell_feed wrapper + previous body kept', (to_regprocedure('public.bell_feed__pre0077(integer)') is not null and coalesce((select position('reprice-alert-0077' in p.prosrc) > 0 from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)')), false))),
  ('0077 08 authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.insights_events(date, date)', 'execute') and has_function_privilege('authenticated', 'public.recent_list(integer)', 'execute') and not has_function_privilege('anon', 'public.recent_touch(text, text, text)', 'execute') and not has_function_privilege('authenticated', 'public._r3_price_change_notify(uuid, text, text[], text)', 'execute'), false))),
  ('0077 09 version tables in realtime publication', (not exists (select 1 from pg_publication where pubname = 'supabase_realtime') or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('quote_versions', 'quotation_versions')) = 2)),
('0078 01 tables exist', (to_regclass('public.comms_settings') is not null and to_regclass('public.comms_outbox') is not null
      and to_regclass('public.client_link_opens') is not null and to_regclass('public.member_wa_optin') is not null
      and to_regclass('public.inv_shortage_alerts') is not null)),
  ('0078 02 RLS on every new table', (coalesce((select bool_and(c.relrowsecurity) from pg_class c where c.oid in (to_regclass('public.comms_settings'),
      to_regclass('public.comms_outbox'), to_regclass('public.client_link_opens'), to_regclass('public.member_wa_optin'),
      to_regclass('public.inv_shortage_alerts'))), false))),
  ('0078 03 outbox dedupe key is unique', (exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'comms_outbox_dedupe_key' and indexdef like 'CREATE UNIQUE%'))),
  ('0078 04 API roles cannot touch the outbox', (not has_table_privilege('authenticated', 'public.comms_outbox', 'select')
      and not has_table_privilege('anon', 'public.comms_outbox', 'select') and not has_table_privilege('authenticated', 'public.comms_outbox', 'insert'))),
  ('0078 05 claim / mark / tick: service role only', (has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.comms_tick()', 'execute')
      and not has_function_privilege('anon', 'public.comms_outbox_mark(uuid, text)', 'execute'))),
  ('0078 06 app RPCs: authenticated yes, anon no (link-open anon yes)', (has_function_privilege('authenticated', 'public.comms_settings_set(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.comms_settings_set(jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.payment_reminder_send_now(uuid)', 'execute')
      and has_function_privilege('anon', 'public.public_link_opened(text, uuid)', 'execute'))),
  ('0078 07 security definer + empty search_path', (coalesce((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p
      where p.oid in (to_regprocedure('public.comms_tick()'), to_regprocedure('public.comms_settings_set(jsonb)'),
        to_regprocedure('public.payment_reminder_send_now(uuid)'), to_regprocedure('public.public_link_opened(text, uuid)'),
        to_regprocedure('public.comms_outbox_claim(integer)'), to_regprocedure('public.comms_outbox_mark(uuid, text)'))), false))),
  ('0078 08 catalog has the 2 new types', (public.notification_type_of('inventory_low_stock') = 'inventory_low_stock'
      and public.notification_type_of('client_follow_up') = 'client_follow_up'
      and to_regprocedure('public.notification_catalog__pre0078()') is not null)),
  ('0078 09 forwarding triggers installed', (exists (select 1 from pg_trigger where tgname = 'zzz_comms_forward' and tgrelid = 'public.notifications'::regclass)
      and exists (select 1 from pg_trigger where tgname = 'zzz_comms_broadcast' and tgrelid = 'public.chat_messages'::regclass))),
  ('0078 10 dormant: nothing on unless an admin saved it', (not exists (select 1 from public.comms_settings s where s.pay_enabled or s.fu_enabled or s.wa_forward_enabled)
      or exists (select 1 from public.comms_settings s where s.updated_by is not null))),
('0079 01 wrapper + kept base exist', (to_regprocedure('public.helm_quote_total(jsonb)') is not null and to_regprocedure('public.helm_quote_total__pretax(jsonb)') is not null)),
  ('0079 02 wrapper is the 0079 body, definer, search_path empty', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) and p.prosrc like '%country-tax-0079%' from pg_proc p where p.oid = to_regprocedure('public.helm_quote_total(jsonb)')), false))),
  ('0079 03 exclusive total unchanged (5000 + 18 pct = 5900)', (public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500}'::jsonb) = 5900)),
  ('0079 04 inclusive total = post-discount value (5000)', (public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxInclusive":true}'::jsonb) = 5000)),
  ('0079 05 legacy subtotal shape unchanged (1180)', (public.helm_quote_total('{"subtotal":1000}'::jsonb) = 1180)),
  ('0079 06 authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.helm_quote_total(jsonb)', 'execute') and not has_function_privilege('anon', 'public.helm_quote_total(jsonb)', 'execute'), false)))
) v(item, ok)
order by item;
