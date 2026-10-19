-- 0266_notification_inbox.sql - CANONICAL forward-only.
-- REQUIRES 0036 (notification prefs: _notify_hidden_types, notification_type_of, notification_catalog,
--          notification_seen, bell_feed), 0042 (_a42_redact_detail), 0063 (notification_mutes), 0153 (_a153_money_key),
--          0250 + 0254 (bell_feed chain: security notices HQ only, close rows for approvers), 0244 (helm_notice_outbox +
--          helm_notice_outbox_claim, comms-dispatch lane), phase29 / phase57 (role_access, has_area, current_org_id,
--          user_role, is_admin), 0050 (rate_hit).
--
-- In plain words (owner, r23 - "turn the bell into a proper notification inbox", the Linear / GitHub / Slack model):
--   1  Every person gets their OWN inbox state for each bell notification: read / unread, Done (archived) and
--      Snoozed (until a time). NEW notification_inbox_state - one row per (person, notification), only written by
--      the RPCs below. The studio's notifications rows are shared by the whole team, so a person's read / done /
--      snooze must never sit on that shared row (one person's "Done" would vanish it for everybody): the brief's
--      snoozed_until / done_at / digested_at columns live here, per person. notifications itself is not changed.
--   2  What a person sees is exactly what their bell already shows them: the same rules (role / type / channel
--      prefs 0036, personal mutes 0063, trial notices admins only 0058, price changes for quote editors 0077,
--      money rows + money fields only for quote viewers 0153, studio security rows never 0250, close requests only
--      for approvers 0254, bearer links stripped 0042). _r23_visible() is that one rule set; the DB test compares
--      it with bell_feed for several roles so the two can never drift apart silently.
--   3  inbox_feed(tab, filter, event, limit, cursor) - the /inbox page and the bell: tabs Unread / All / Snoozed /
--      Done, filter by group (Sales / Planning / Operations / Finance / Billing / Chat / System) or type, one event,
--      paged newest first; counts per tab and per group. Unread = not read since it arrived (or since it came back
--      from a snooze / was marked unread); "Mark all read" keeps using the existing bell_mark_seen time.
--   4  inbox_act(ids, action, until, preset) - read, unread, done, undone, snooze (later today = +3 h, tomorrow
--      9:00 am, next Monday 9:00 am - in the studio's time zone, default Asia/Kolkata - or a custom time up to 6
--      months ahead), unsnooze. Up to 500 at once (bulk), only rows this person can see in their own studio,
--      rate limited. inbox_read_all(filter, event) marks a whole tab / filter read.
--   5  Snoozed rows come back by themselves: inbox_tick() (pg_cron every 5 minutes, only if pg_cron is installed)
--      turns every snooze whose time has passed into "unread again" (and the feed already treats a passed snooze
--      as back even before the job runs).
--   6  E-mail only for what is STILL unread: per person Off / Instant (important only) / Daily digest; the studio
--      default (Control Center -> Notifications -> Inbox & e-mail digest, default: Daily at 8:00 am, items unread
--      for at least 60 minutes) plus a studio-wide "inbox e-mails" switch. inbox_tick() queues ONE digest per person
--      per studio day (max 20 items, never an item already put in a digest, last 2 days only) or, for "Instant",
--      the important ones (payment received / needs attention, client approved, close request, task rejected,
--      low stock) unread for 5+ minutes. Queued in the existing Helm notice outbox (0244, kind inbox_digest), sent
--      by comms-dispatch - DORMANT until it is deployed with e-mail on. At send time the claim re-checks every item:
--      anything read, done or snoozed since is left out, and nothing is sent when nothing is left. Never for a free
--      trial / read-only / sample studio (_tb179_no_send), never to an unsubscribed address (0165).
--   7  bell_feed is wrapped once (bell_feed__pre0266 keeps the database's own body): Done and currently snoozed rows
--      leave the bell, each row's unread follows the inbox, rows back from a snooze are added on top and the badge
--      count is the inbox unread count. Any error inside the wrapper returns the old bell unchanged (fail-open).
--      The answer carries inbox.open_marks_read (studio setting, default OFF): opening the bell no longer marks
--      everything read - like Linear, an item is read when you open it or mark it.
--   8  Trial retention (0184): the per-person state goes with the trial data (before notifications); the two
--      settings tables are kept like notification_prefs.
-- DRIFT-SAFE: bell_feed renamed ONCE to bell_feed__pre0266 and wrapped (marker 'r23-inbox-0266'); the outbox kind
-- check is widened ONCE to a superset of whatever kinds it already allows (read from the constraint itself); one
-- branch is added in place to helm_notice_outbox_claim. Additive + idempotent: 3 new tables (RLS on, read-only
-- for the app), 1 new index on notifications (org_id, created_at), new functions, 1 pg_cron job. No row updated or
-- deleted outside the new tables, no table / column dropped, no existing policy changed. Safe to run twice. ASCII.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   update public.inbox_settings set email_enabled = false;   -- nothing more is queued
--   select cron.unschedule('helm_inbox_tick');
--   drop function public.bell_feed(integer); alter function public.bell_feed__pre0266(integer) rename to bell_feed;
--   grant execute on function public.bell_feed(integer) to authenticated;
--   (the new tables can stay - unused; queued inbox_digest rows are skipped by an older claim body)

do $$ begin
  if to_regprocedure('public.bell_feed(integer)') is null or to_regprocedure('public.bell_mark_seen()') is null
     or to_regclass('public.notification_seen') is null then
    raise exception 'STOP 0266: apply 0036 + phase48 first (bell_feed / bell_mark_seen / notification_seen)'; end if;
  if to_regprocedure('public._notify_hidden_types(uuid,uuid)') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.notification_catalog()') is null then
    raise exception 'STOP 0266: apply 0036 first (notification prefs)'; end if;
  if to_regclass('public.notification_mutes') is null then raise exception 'STOP 0266: apply 0063 first (notification_mutes)'; end if;
  if to_regprocedure('public._a42_redact_detail(jsonb)') is null then raise exception 'STOP 0266: apply 0042 first (_a42_redact_detail)'; end if;
  if to_regprocedure('public._a153_money_key(text)') is null then raise exception 'STOP 0266: apply 0153 first (_a153_money_key)'; end if;
  if position('r21-secnotice-0250' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed__pre0254(integer)')), '')) = 0
     and position('r23-inbox-0266' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed(integer)')), '')) = 0
     and position('r22-closure-0254' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed(integer)')), '')) = 0 then
    raise exception 'STOP 0266: apply 0250 + 0254 first (bell_feed chain)'; end if;
  if to_regclass('public.role_access') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0266: phase29 / phase57 (role_access, has_area, current_org_id, user_role) is not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0266: apply 0244 first (helm_notice_outbox)'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0266: apply 0050 first (rate_hit)'; end if;
end $$;

-- ---- 1) tables ------------------------------------------------------------------------------------------------
-- one row per (person, notification): that person's own read / unread / done / snooze / digest marks
create table if not exists public.notification_inbox_state (
  user_id            uuid not null references auth.users(id) on delete cascade,
  notification_id    uuid not null references public.notifications(id) on delete cascade,
  org_id             uuid not null references public.organizations(id) on delete cascade,
  read_at            timestamptz,
  unread_at          timestamptz,          -- marked unread / came back from a snooze (wins over an earlier read)
  done_at            timestamptz,          -- Done (archived); null = in the inbox
  snoozed_until      timestamptz,          -- hidden until then, then unread again
  snooze_returned_at timestamptz,          -- when the last snooze ran out (set by inbox_tick)
  digested_at        timestamptz,          -- put in an e-mail digest / instant e-mail (never twice)
  updated_at         timestamptz not null default now(),
  constraint notification_inbox_state_pk primary key (user_id, notification_id)
);
create index if not exists notification_inbox_state_org_idx on public.notification_inbox_state (org_id);
create index if not exists notification_inbox_state_notif_idx on public.notification_inbox_state (notification_id);
create index if not exists notification_inbox_state_snooze_idx on public.notification_inbox_state (snoozed_until) where snoozed_until is not null;
create index if not exists notifications_org_created_idx on public.notifications (org_id, created_at desc);

-- studio settings (Control Center -> Notifications -> Inbox & e-mail digest)
create table if not exists public.inbox_settings (
  org_id                 uuid primary key references public.organizations(id) on delete cascade,
  email_enabled          boolean not null default true,
  digest_default         text not null default 'daily' check (digest_default in ('off', 'instant_important', 'daily')),
  digest_hour            integer not null default 8 check (digest_hour between 0 and 23),
  digest_min_age_minutes integer not null default 60 check (digest_min_age_minutes between 15 and 1440),
  bell_open_marks_read   boolean not null default false,
  updated_by             uuid,
  updated_at             timestamptz not null default now()
);

-- a person's own e-mail choice (null digest = follow the studio default)
create table if not exists public.inbox_person_prefs (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  digest     text check (digest in ('off', 'instant_important', 'daily')),
  updated_at timestamptz not null default now(),
  constraint inbox_person_prefs_pk primary key (user_id, org_id)
);

alter table public.notification_inbox_state enable row level security;
alter table public.inbox_settings enable row level security;
alter table public.inbox_person_prefs enable row level security;
drop policy if exists r23_inbox_state_own on public.notification_inbox_state;
create policy r23_inbox_state_own on public.notification_inbox_state for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
drop policy if exists r23_inbox_settings_read on public.inbox_settings;
create policy r23_inbox_settings_read on public.inbox_settings for select to authenticated
  using (org_id = (select public.current_org_id()));
drop policy if exists r23_inbox_prefs_own on public.inbox_person_prefs;
create policy r23_inbox_prefs_own on public.inbox_person_prefs for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));

-- the studio settings follow the read-only guard (an ended unpaid trial cannot change them); a person's own marks do
-- not (reading and clearing notifications must keep working for a read-only studio, like notification_seen)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.inbox_settings'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.inbox_settings for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

do $$ declare t text; begin
  foreach t in array array['notification_inbox_state', 'inbox_settings', 'inbox_person_prefs'] loop
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- ---- 2) helpers (internal: not callable by the app) ------------------------------------------------------------
-- has_area for a given role (the digest runs without a signed-in user)
create or replace function public._r23_area(p_org uuid, p_role text, p_area text, p_need text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266: same rule as has_area(), for any role
  select case when coalesce(p_role, '') = 'admin' then true
    else coalesce((select case when p_need = 'edit' then ra.can_edit else ra.can_view end
                     from public.role_access ra where ra.org_id = p_org and ra.role = p_role and ra.area = p_area limit 1), false) end;
$$;

-- the bell's detail rules: bearer links out (0042); money fields out for people without quote view (0153)
create or replace function public._r23_detail(p jsonb, p_money boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select case when jsonb_typeof(d) <> 'object' or p_money then d
    else coalesce((select jsonb_object_agg(e.k, e.v) from jsonb_each(d) e(k, v)
                    where not public._a153_money_key(e.k)
                      and not (e.k = 'message' and coalesce(e.v #>> '{}', '') ~* '(price|total|amount|paid|rs\.|inr)')), '{}'::jsonb) end
    from (select public._a42_redact_detail(p) as d) x;
$$;

-- the notifications rows this person's bell shows (see header point 2; DB test keeps it equal to bell_feed). Free-trial
-- reminders follow the 0058 prefs default (admins only unless the studio opts a role in) exactly as the bell does.
create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  with me as (
    select public._r23_area(p_org, p.role, 'quotes', 'view') as qv,
           public._r23_area(p_org, p.role, 'quotes', 'edit') as qe,
           (coalesce(p.role, '') in ('admin', 'manager', 'coordinator') or public._r23_area(p_org, p.role, 'closure', 'view')) as cl,
           coalesce(public._notify_hidden_types(p_org, p_uid), '{}'::text[]) as hid,
           coalesce((select array_agg(m.type) from public.notification_mutes m where m.user_id = p_uid and m.org_id = p_org), '{}'::text[]) as mut
      from public.profiles p
     where p.id = p_uid and p.org_id = p_org and p_org is not null
  )
  select n.id, n.kind, n.channel, n.status, public._r23_detail(n.detail, me.qv), n.created_at, n.quote_id, t.ty
    from me
    join public.notifications n on n.org_id = p_org
    cross join lateral (select public.notification_type_of(n.kind, n.channel) as ty) t
   where coalesce(n.kind, '') <> 'security_alert'
     and not (t.ty = any (me.hid))
     and not (t.ty = any (me.mut))
     and (me.qe or coalesce(n.kind, '') <> 'price_change')
     and (me.qv or coalesce(n.kind, '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)')
     and (me.cl or coalesce(n.kind, '') not in ('event_close_request', 'event_close_decision'));
$$;

-- visible rows + this person's state + computed unread / snoozed / done
create or replace function public._r23_rows(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text,
              read_at timestamptz, done_at timestamptz, snoozed_until timestamptz, digested_at timestamptz,
              is_unread boolean, is_snoozed boolean, is_done boolean, returned boolean, sort_at timestamptz)
language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266: unread = the newest of (arrived, marked unread, back from snooze) is later than the newest of
  -- (marked read, "mark all read" time - which only covers rows that existed then)
  with w as (
    select coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = p_uid), '-infinity'::timestamptz) as seen
  ), b as (
    select v.*, st.read_at, st.unread_at, st.done_at, st.snoozed_until, st.digested_at, st.snooze_returned_at,
           (st.done_at is not null) as dn,
           (st.done_at is null and st.snoozed_until is not null and st.snoozed_until > now()) as sz,
           case when st.snoozed_until is not null and st.snoozed_until <= now() then st.snoozed_until end as back_now
      from public._r23_visible(p_org, p_uid) v
      left join public.notification_inbox_state st on st.user_id = p_uid and st.notification_id = v.id
  )
  select b.id, b.kind, b.channel, b.status, b.detail, b.created_at, b.quote_id, b.ntype,
         b.read_at, b.done_at, case when b.sz then b.snoozed_until end, b.digested_at,
         (not b.dn and not b.sz
          and greatest(b.created_at, b.unread_at, b.back_now, b.snooze_returned_at)
              > coalesce(greatest(b.read_at, case when w.seen >= b.created_at then w.seen end), '-infinity'::timestamptz)),
         b.sz, b.dn,
         coalesce(b.back_now, b.snooze_returned_at) is not null,
         greatest(b.created_at, b.back_now, b.snooze_returned_at)
    from b, w;
$$;

-- studio settings with defaults (a studio without a row = the defaults)
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select jsonb_build_object(
    'email_enabled', coalesce(s.email_enabled, true),
    'digest_default', coalesce(s.digest_default, 'daily'),
    'digest_hour', coalesce(s.digest_hour, 8),
    'digest_min_age_minutes', coalesce(s.digest_min_age_minutes, 60),
    'bell_open_marks_read', coalesce(s.bell_open_marks_read, false),
    'timezone', coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Kolkata'),
    'saved', s.org_id is not null)
  from (select 1) one left join public.inbox_settings s on s.org_id = p_org;
$$;

create or replace function public._r23_tz(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266: the studio time zone when Postgres knows it, else India
  select coalesce((select o.timezone from public.organizations o
                    where o.id = p_org and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = o.timezone)), 'Asia/Kolkata');
$$;

-- a person's effective e-mail mode
create or replace function public._r23_mode(p_org uuid, p_uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select case when not coalesce((public._r23_cfg(p_org) ->> 'email_enabled')::boolean, true) then 'off'
    else coalesce((select pp.digest from public.inbox_person_prefs pp where pp.user_id = p_uid and pp.org_id = p_org),
                  public._r23_cfg(p_org) ->> 'digest_default', 'daily') end;
$$;

-- "important" = worth an instant e-mail
create or replace function public._r23_important(p_kind text)
returns boolean language sql immutable set search_path = '' as $$
  -- r23-inbox-0266
  select lower(coalesce(p_kind, '')) in ('advance_paid', 'payment_received', 'payment', 'pkg_payment', 'payment_reconcile',
    'approved', 'quote_approved', 'change_order', 'event_close_request', 'event_close_decision', 'task_reject', 'inventory_low_stock');
$$;

-- a short plain label for e-mails (no amounts, no links)
create or replace function public._r23_label(p_kind text, p_detail jsonb)
returns text language sql immutable set search_path = '' as $$
  -- r23-inbox-0266
  select left(case k
    when 'task_assigned' then 'Tasks assigned' || coalesce(' - ' || nullif(d ->> 'category', ''), '')
    when 'task_accept' then 'Task accepted' || coalesce(' by ' || nullif(d ->> 'worker', ''), '')
    when 'task_reject' then 'Task rejected' || coalesce(' by ' || nullif(d ->> 'worker', ''), '')
    when 'task_start' then 'Task started' || coalesce(' by ' || nullif(d ->> 'worker', ''), '')
    when 'task_complete' then 'Task completed' || coalesce(' by ' || nullif(d ->> 'worker', ''), '')
    when 'task_reminder' then 'Task reminder' || coalesce(': ' || nullif(d ->> 'task', ''), '')
    when 'task_due' then 'Task due' || coalesce(': ' || nullif(d ->> 'task', ''), '')
    when 'otp' then 'Approval code sent to the client'
    when 'approval_link' then 'Approval link sent to the client'
    when 'approved' then 'The client approved the quote'
    when 'quote_approved' then 'The client approved the quote'
    when 'payment_link' then 'Payment link sent'
    when 'payment_reminder' then 'Payment reminder sent'
    when 'payment_receipt' then 'Payment receipt sent'
    when 'payment' then 'Payment update'
    when 'payment_received' then 'Payment received'
    when 'advance_paid' then 'Payment received'
    when 'pkg_payment' then 'Package payment received'
    when 'payment_reconcile' then 'Payment needs attention'
    when 'price_change' then 'Prices changed - review and re-price'
    when 'pkg_selected' then 'The client chose a package'
    when 'pkg_accepted' then 'Package choice accepted'
    when 'pkg_declined' then 'Package choice declined'
    when 'inventory_low_stock' then 'Low stock: ' || coalesce(nullif(d ->> 'item', ''), 'an item')
    when 'client_follow_up' then 'Follow-up sent to the client'
    when 'event_close_request' then 'Close request' || coalesce(' from ' || nullif(d ->> 'actor_name', ''), '') || ' - waiting for approval'
    when 'event_close_decision' then case when d ->> 'decision' = 'declined' then 'Close request declined' else 'Event closed with override' end
    when 'event_reminder' then coalesce(nullif(d ->> 'label', ''), 'An event is coming up')
    when 'trial_reminder' then coalesce(nullif(d ->> 'label', ''), 'Free trial update')
    when 'invite_link_request' then 'A teammate asked for a new invitation link'
    when 'invite_site_link' then 'Invitation link update'
    when 'booklet_link' then 'Booklet link update'
    else case when k like 'design\_%' then 'Design stage: ' || replace(substr(k, 8), '_', ' ')
              when k like 'nurture\_%' then 'Greeting queued'
              else initcap(replace(nullif(k, ''), '_', ' ')) end end, 140)
  from (select lower(btrim(coalesce(p_kind, ''))) as k,
               case when jsonb_typeof(p_detail) = 'object' then p_detail else '{}'::jsonb end as d) x;
$$;

-- snooze time: a preset in the studio's time zone, or a custom time (1 minute .. 180 days ahead)
create or replace function public._r23_snooze_at(p_org uuid, p_preset text, p_until timestamptz)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_tz text := public._r23_tz(p_org); v_loc timestamp := now() at time zone public._r23_tz(p_org); v timestamptz;
begin
  v := case lower(coalesce(nullif(btrim(p_preset), ''), 'custom'))
    when 'later_today' then now() + interval '3 hours'
    when 'tomorrow' then ((v_loc::date + 1) + time '09:00') at time zone v_tz
    when 'next_week' then ((v_loc::date + (8 - extract(isodow from v_loc)::integer)) + time '09:00') at time zone v_tz
    when 'custom' then p_until
    else null end;
  if v is null or v <= now() + interval '1 minute' or v > now() + interval '180 days' then
    raise exception 'Pick a snooze time in the future (up to 6 months ahead)' using errcode = '22023';
  end if;
  return v;
end $$;

-- counts for the badge / tabs
create or replace function public._r23_counts(p_org uuid, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select jsonb_build_object(
    'unread', count(*) filter (where r.is_unread),
    'all', count(*) filter (where not r.is_done and not r.is_snoozed),
    'snoozed', count(*) filter (where r.is_snoozed),
    'done', count(*) filter (where r.is_done))
  from public._r23_rows(p_org, p_uid) r;
$$;

-- the caller's e-mail settings (shown on /inbox)
create or replace function public._r23_my_settings(p_org uuid, p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266
  select jsonb_build_object(
    'mode', public._r23_mode(p_org, p_uid),
    'mine', (select pp.digest from public.inbox_person_prefs pp where pp.user_id = p_uid and pp.org_id = p_org),
    'studio_default', c ->> 'digest_default',
    'email_enabled', (c ->> 'email_enabled')::boolean,
    'digest_hour', (c ->> 'digest_hour')::integer,
    'digest_min_age_minutes', (c ->> 'digest_min_age_minutes')::integer,
    'bell_open_marks_read', (c ->> 'bell_open_marks_read')::boolean,
    'timezone', public._r23_tz(p_org),
    'has_email', exists (select 1 from public.profiles p where p.id = p_uid and nullif(btrim(coalesce(p.email, '')), '') is not null))
  from (select public._r23_cfg(p_org) as c) x;
$$;

-- ---- 3) the inbox feed ------------------------------------------------------------------------------------------
create or replace function public.inbox_feed(p_tab text default 'unread', p_filter text default null, p_quote uuid default null,
                                             p_limit integer default 50, p_cursor text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266: one page of this person's inbox (newest first) + counts per tab and per group
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_tab text := lower(btrim(coalesce(p_tab, 'unread')));
        v_f text := lower(btrim(coalesce(p_filter, ''))); v_lim integer := greatest(1, least(coalesce(p_limit, 50), 100));
        v_cat jsonb := public.notification_catalog(); v_at timestamptz; v_cid uuid; v jsonb;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_tab not in ('unread', 'all', 'snoozed', 'done') then raise exception 'unknown inbox tab' using errcode = '22023'; end if;
  if v_f !~ '^[a-z_]{0,40}$' then raise exception 'unknown filter' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_cursor, '')), '') is not null then
    begin
      v_at := split_part(p_cursor, '|', 1)::timestamptz;
      v_cid := nullif(split_part(p_cursor, '|', 2), '')::uuid;
    exception when others then raise exception 'bad cursor' using errcode = '22023';
    end;
  end if;
  with r as materialized (
    select x.*, coalesce((select e ->> 'group' from jsonb_array_elements(v_cat) e where e ->> 'type' = x.ntype limit 1), 'System') as grp
      from public._r23_rows(v_org, v_uid) x
  ), t as materialized (
    select r.* from r
     where case v_tab when 'unread' then r.is_unread
                      when 'all' then not r.is_done and not r.is_snoozed
                      when 'snoozed' then r.is_snoozed
                      else r.is_done end
  ), f as (
    select t.* from t
     where (v_f = '' or lower(t.grp) = v_f or t.ntype = v_f or lower(coalesce(t.kind, '')) = v_f)
       and (p_quote is null or t.quote_id = p_quote)
       and (v_at is null or (t.sort_at, t.id) < (v_at, coalesce(v_cid, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
     order by t.sort_at desc, t.id desc
     limit v_lim + 1
  ), page as (
    select f.*, row_number() over (order by f.sort_at desc, f.id desc) as rn from f
  )
  select jsonb_build_object(
    'tab', v_tab,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'kind', p.kind, 'channel', p.channel, 'status', p.status, 'detail', p.detail,
        'created_at', p.created_at, 'sort_at', p.sort_at, 'quote_id', p.quote_id,
        'event_code', q.code, 'event_title', q.title, 'type', p.ntype, 'group', p.grp,
        'unread', p.is_unread, 'read_at', p.read_at, 'done_at', p.done_at, 'snoozed_until', p.snoozed_until,
        'returned', p.returned and p.is_unread) order by p.sort_at desc, p.id desc)
      from page p left join public.quotes q on q.id = p.quote_id and q.org_id = v_org
     where p.rn <= v_lim), '[]'::jsonb),
    'next_cursor', (select to_char(p.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id::text
                      from page p where p.rn = v_lim and exists (select 1 from page p2 where p2.rn = v_lim + 1)),
    'counts', jsonb_build_object(
        'unread', (select count(*) from r where r.is_unread),
        'all', (select count(*) from r where not r.is_done and not r.is_snoozed),
        'snoozed', (select count(*) from r where r.is_snoozed),
        'done', (select count(*) from r where r.is_done)),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('key', lower(g.grp), 'label', g.grp, 'count', g.n, 'unread', g.u) order by g.grp)
        from (select t.grp, count(*) as n, count(*) filter (where t.is_unread) as u from t group by t.grp) g), '[]'::jsonb),
    'settings', public._r23_my_settings(v_org, v_uid)
  ) into v;
  return v;
end $$;

-- ---- 4) actions: read / unread / done / undone / snooze / unsnooze (bulk) ----------------------------------------
create or replace function public.inbox_act(p_ids uuid[], p_action text, p_until timestamptz default null, p_preset text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266: only the caller's own marks change; only rows the caller can see in their own studio
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_act text := lower(btrim(coalesce(p_action, '')));
        v_ids uuid[]; v_at timestamptz; v_n integer := 0;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_act not in ('read', 'unread', 'done', 'undone', 'snooze', 'unsnooze') then raise exception 'unknown inbox action' using errcode = '22023'; end if;
  if p_ids is null or coalesce(cardinality(p_ids), 0) = 0 then
    return jsonb_build_object('changed', 0, 'counts', public._r23_counts(v_org, v_uid)); end if;
  if cardinality(p_ids) > 500 then raise exception 'Too many notifications at once (500 max)' using errcode = '22023'; end if;
  if public.rate_hit('inbox_act', v_uid::text, 60, 240) > 0 then
    raise exception 'Too many changes - wait a moment and try again' using errcode = '54000'; end if;
  if v_act = 'snooze' then v_at := public._r23_snooze_at(v_org, p_preset, p_until); end if;
  select array_agg(distinct v.id) into v_ids from public._r23_visible(v_org, v_uid) v where v.id = any (p_ids);
  if v_ids is null then return jsonb_build_object('changed', 0, 'counts', public._r23_counts(v_org, v_uid)); end if;
  insert into public.notification_inbox_state (user_id, notification_id, org_id)
    select v_uid, i, v_org from unnest(v_ids) i
  on conflict (user_id, notification_id) do nothing;
  update public.notification_inbox_state s set
    read_at       = case v_act when 'read' then now() when 'unread' then null when 'done' then coalesce(s.read_at, now()) else s.read_at end,
    unread_at     = case v_act when 'read' then null when 'unread' then clock_timestamp() when 'done' then null else s.unread_at end,   -- later than any read / mark-all time
    done_at       = case v_act when 'done' then now() when 'undone' then null when 'snooze' then null else s.done_at end,
    snoozed_until = case v_act when 'snooze' then v_at when 'unsnooze' then null when 'done' then null else s.snoozed_until end,
    snooze_returned_at = case v_act when 'snooze' then null else s.snooze_returned_at end,
    updated_at    = now()
  where s.user_id = v_uid and s.org_id = v_org and s.notification_id = any (v_ids);
  get diagnostics v_n = row_count;
  return jsonb_build_object('changed', v_n, 'action', v_act, 'snoozed_until', v_at, 'counts', public._r23_counts(v_org, v_uid));
end $$;

-- mark a whole tab / filter read. No filter = everything (the bell's "Mark all read" time, bell_mark_seen).
create or replace function public.inbox_read_all(p_filter text default null, p_quote uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_f text := lower(btrim(coalesce(p_filter, '')));
        v_cat jsonb := public.notification_catalog(); v_ids uuid[]; v_n integer := 0;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_f !~ '^[a-z_]{0,40}$' then raise exception 'unknown filter' using errcode = '22023'; end if;
  if public.rate_hit('inbox_act', v_uid::text, 60, 240) > 0 then
    raise exception 'Too many changes - wait a moment and try again' using errcode = '54000'; end if;
  if v_f = '' and p_quote is null then
    perform public.bell_mark_seen();
    update public.notification_inbox_state s set read_at = now(), unread_at = null, updated_at = now()
     where s.user_id = v_uid and s.org_id = v_org and s.done_at is null and s.unread_at is not null;
    return jsonb_build_object('changed', -1, 'counts', public._r23_counts(v_org, v_uid));
  end if;
  select array_agg(r.id) into v_ids from (
    select x.id from public._r23_rows(v_org, v_uid) x
     where x.is_unread
       and (v_f = '' or x.ntype = v_f or lower(coalesce(x.kind, '')) = v_f
            or lower(coalesce((select e ->> 'group' from jsonb_array_elements(v_cat) e where e ->> 'type' = x.ntype limit 1), 'system')) = v_f)
       and (p_quote is null or x.quote_id = p_quote)
     limit 2000) r;
  if v_ids is not null then
    insert into public.notification_inbox_state (user_id, notification_id, org_id)
      select v_uid, i, v_org from unnest(v_ids) i on conflict (user_id, notification_id) do nothing;
    update public.notification_inbox_state s set read_at = now(), unread_at = null, updated_at = now()
     where s.user_id = v_uid and s.org_id = v_org and s.notification_id = any (v_ids);
    get diagnostics v_n = row_count;
  end if;
  return jsonb_build_object('changed', v_n, 'counts', public._r23_counts(v_org, v_uid));
end $$;

-- ---- 5) settings ---------------------------------------------------------------------------------------------------
create or replace function public.inbox_my_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r23_my_settings(v_org, v_uid);
end $$;

-- p_mode: 'off' | 'instant_important' | 'daily' | null / 'default' (follow the studio default)
create or replace function public.inbox_set_my_digest(p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_m text := lower(btrim(coalesce(p_mode, '')));
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_m in ('', 'default') then v_m := null;
  elsif v_m not in ('off', 'instant_important', 'daily') then raise exception 'unknown e-mail setting' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.org_id = v_org) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.inbox_person_prefs (user_id, org_id, digest, updated_at) values (v_uid, v_org, v_m, now())
  on conflict (user_id, org_id) do update set digest = excluded.digest, updated_at = now();
  return public._r23_my_settings(v_org, v_uid);
end $$;

create or replace function public.admin_get_inbox_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266: Control Center (controls VIEW reads, EDIT changes)
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('controls', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r23_cfg(v_org) || jsonb_build_object('can_manage', public.has_area('controls', 'edit'),
    'people', (select jsonb_build_object(
        'off', count(*) filter (where pp.digest = 'off'),
        'instant_important', count(*) filter (where pp.digest = 'instant_important'),
        'daily', count(*) filter (where pp.digest = 'daily'))
      from public.inbox_person_prefs pp where pp.org_id = v_org));
end $$;

create or replace function public.admin_set_inbox_settings(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_old jsonb; c jsonb;
        v_en boolean; v_def text; v_hour integer; v_age integer; v_bell boolean;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  v_old := public._r23_cfg(v_org); c := v_old;
  begin
    v_en   := coalesce((p ->> 'email_enabled')::boolean, (c ->> 'email_enabled')::boolean);
    v_def  := lower(coalesce(p ->> 'digest_default', c ->> 'digest_default'));
    v_hour := coalesce((p ->> 'digest_hour')::integer, (c ->> 'digest_hour')::integer);
    v_age  := coalesce((p ->> 'digest_min_age_minutes')::integer, (c ->> 'digest_min_age_minutes')::integer);
    v_bell := coalesce((p ->> 'bell_open_marks_read')::boolean, (c ->> 'bell_open_marks_read')::boolean);
  exception when others then raise exception 'invalid inbox settings' using errcode = '22023';
  end;
  if v_def not in ('off', 'instant_important', 'daily') then raise exception 'unknown default e-mail setting' using errcode = '22023'; end if;
  if v_hour not between 0 and 23 then raise exception 'digest hour must be 0-23' using errcode = '22023'; end if;
  if v_age not between 15 and 1440 then raise exception 'unread time must be 15-1440 minutes' using errcode = '22023'; end if;
  insert into public.inbox_settings (org_id, email_enabled, digest_default, digest_hour, digest_min_age_minutes, bell_open_marks_read, updated_by, updated_at)
    values (v_org, v_en, v_def, v_hour, v_age, v_bell, v_me, now())
  on conflict (org_id) do update set email_enabled = excluded.email_enabled, digest_default = excluded.digest_default,
    digest_hour = excluded.digest_hour, digest_min_age_minutes = excluded.digest_min_age_minutes,
    bell_open_marks_read = excluded.bell_open_marks_read, updated_by = v_me, updated_at = now();
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'inbox_settings.set', 'inbox_settings', v_org::text,
              jsonb_build_object('old', v_old - 'timezone' - 'saved', 'new', public._r23_cfg(v_org) - 'timezone' - 'saved'), v_org);
  exception when others then raise warning 'r23-inbox-0266: audit skipped (%)', sqlstate;
  end;
  return public.admin_get_inbox_settings();
end $$;

-- ---- 6) bell: per-person inbox state (rename once, then wrap) -------------------------------------------------------
do $$ begin
  if to_regprocedure('public.bell_feed__pre0266(integer)') is null
     and position('r23-inbox-0266' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed(integer)')), '')) = 0 then
    alter function public.bell_feed(integer) rename to bell_feed__pre0266;
  end if;
  if to_regprocedure('public.bell_feed__pre0266(integer)') is null then raise exception '0266: public.bell_feed__pre0266(integer) missing after rename'; end if;
  revoke all on function public.bell_feed__pre0266(integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.bell_feed__pre0266(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.bell_feed__pre0266(integer) from authenticated'; end if;
end $$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266: Done / snoozed rows leave the bell, unread follows the person's inbox, rows back from a snooze come
-- first, the badge = inbox unread (+ HQ notices for operators). Any error -> the bell exactly as before.
declare v jsonb; v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_out jsonb;
        v_lim integer := greatest(1, least(coalesce(p_limit, 20), 100)); v_hq integer := 0; v_seen timestamptz;
begin
  v := public.bell_feed__pre0266(p_limit);
  if v is null or jsonb_typeof(v -> 'items') <> 'array' or v_uid is null or v_org is null then return v; end if;
  begin
    if to_regclass('public.hq_security_notices') is not null and public.is_platform_operator() then
      v_seen := greatest(coalesce((select max(s.last_seen_at) from public.hq_security_seen s where s.user_id = v_uid), 'epoch'::timestamptz),
                         coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = v_uid), 'epoch'::timestamptz));
      select count(*) into v_hq from public.hq_security_notices n where n.last_at > v_seen;
    end if;
    with r as materialized (select * from public._r23_rows(v_org, v_uid)),
    kept as (
      select case when r.id is null then e.i
                  else e.i || jsonb_build_object('unread', r.is_unread, 'returned', r.returned and r.is_unread, 'sort_at', r.sort_at) end as i,
             coalesce(r.sort_at, (e.i ->> 'created_at')::timestamptz) as at, e.ord
        from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
        left join r on r.id::text = (e.i ->> 'id')
       where not coalesce(r.is_done or r.is_snoozed, false)
    ),
    back as (
      select jsonb_build_object('id', r.id, 'kind', r.kind, 'channel', r.channel, 'status', r.status, 'detail', r.detail,
               'created_at', r.created_at, 'sort_at', r.sort_at, 'quote_id', r.quote_id, 'event_code', q.code, 'event_title', q.title,
               'unread', true, 'returned', true) as i, r.sort_at as at, 0::bigint as ord
        from (select * from r where r.returned and r.is_unread
                and not exists (select 1 from jsonb_array_elements(v -> 'items') x where x ->> 'id' = r.id::text)
               order by r.sort_at desc limit 10) r
        left join public.quotes q on q.id = r.quote_id and q.org_id = v_org
    ),
    allrows as (select * from kept union all select * from back)
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(a.i order by a.at desc nulls last, a.ord) from (select * from allrows order by at desc nulls last, ord limit v_lim) a), '[]'::jsonb),
      'unread', (select count(*) from r where r.is_unread) + v_hq)
      into v_out;
    return v || v_out || jsonb_build_object('inbox', jsonb_build_object('v', 1,
      'open_marks_read', coalesce((public._r23_cfg(v_org) ->> 'bell_open_marks_read')::boolean, false)));
  exception when others then
    raise warning 'r23-inbox-0266: bell inbox state skipped (%)', sqlstate;
    return v;
  end;
end $$;

-- ---- 7) the scheduler: snoozes come back + digests are queued ------------------------------------------------------
-- recipients + data for one queued digest, resolved at claim time (null = skip). Items read / done / snoozed since
-- it was queued are left out; nothing left -> null.
create or replace function public._r23_digest_mail(p_org uuid, p_user uuid, p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_mode text; v_email text; v_name text; v_ids uuid[]; v_items jsonb; v_more integer; v_tz text := public._r23_tz(p_org);
begin
  if p_org is null or p_user is null then return null; end if;
  v_mode := public._r23_mode(p_org, p_user);
  if v_mode = 'off' then return null; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is not null and public._tb179_no_send(p_org) then return null; end if;
  select lower(btrim(p.email)), nullif(btrim(split_part(coalesce(p.full_name, ''), ' ', 1)), '') into v_email, v_name
    from public.profiles p where p.id = p_user and p.org_id = p_org;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return null; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is not null and public.email_is_opted_out(null, v_email) then return null; end if;
  begin
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p_payload -> 'ids', '[]'::jsonb)) x;
  exception when others then return null;
  end;
  if v_ids is null then return null; end if;
  with r as materialized (select * from public._r23_rows(p_org, p_user))
  select coalesce((select jsonb_agg(jsonb_build_object(
             'title', public._r23_label(r.kind, r.detail),
             'event', left(q.title, 120), 'code', left(q.code, 40),
             'at', to_char(r.sort_at at time zone v_tz, 'DD/MM/YYYY HH12:MI am')) order by r.sort_at desc)
           from r left join public.quotes q on q.id = r.quote_id and q.org_id = p_org
          where r.is_unread and r.id = any (v_ids)), '[]'::jsonb),
         (select count(*) from r where r.is_unread and not (r.id = any (v_ids)))
    into v_items, v_more;
  if jsonb_array_length(v_items) = 0 then return null; end if;
  return jsonb_build_object('to', jsonb_build_array(v_email), 'data', jsonb_build_object(
    'studio', (select o.name from public.organizations o where o.id = p_org),
    'name', v_name, 'mode', coalesce(p_payload ->> 'mode', v_mode),
    'items', v_items, 'count', jsonb_array_length(v_items), 'more', v_more));
end $$;

-- queue the digests that are due (never raises out: a failing person / studio is skipped)
create or replace function public._r23_queue_digests()
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
declare o record; p record; c jsonb; v_tz text; v_loc timestamp; v_hour integer; v_age integer; v_mode text; v_key text;
        v_ids uuid[]; v_n integer := 0; v_ins integer;
begin
  for o in select g.id from public.organizations g loop
    begin
      c := public._r23_cfg(o.id);
      if not coalesce((c ->> 'email_enabled')::boolean, true) then continue; end if;
      if to_regprocedure('public._tb179_no_send(uuid)') is not null and public._tb179_no_send(o.id) then continue; end if;
      v_tz := public._r23_tz(o.id); v_loc := now() at time zone v_tz;
      v_hour := coalesce((c ->> 'digest_hour')::integer, 8); v_age := coalesce((c ->> 'digest_min_age_minutes')::integer, 60);
      for p in select pr.id from public.profiles pr
                where pr.org_id = o.id and pr.role = any (public._notify_roles())
                  and nullif(btrim(coalesce(pr.email, '')), '') is not null loop
        v_mode := public._r23_mode(o.id, p.id); v_ids := null; v_key := null;
        if v_mode = 'daily' and ((extract(hour from v_loc)::integer - v_hour + 24) % 24) < 2 then
          v_key := 'inbox_digest:' || p.id::text || ':' || to_char(v_loc::date, 'YYYY-MM-DD');
          if exists (select 1 from public.helm_notice_outbox x where x.dedupe_key = v_key) then continue; end if;
          select array_agg(z.id order by z.sort_at desc) into v_ids from (
            select r.id, r.sort_at from public._r23_rows(o.id, p.id) r
             where r.is_unread and r.digested_at is null
               and r.sort_at <= now() - make_interval(mins => v_age) and r.sort_at >= now() - interval '2 days'
             order by r.sort_at desc limit 20) z;
        elsif v_mode = 'instant_important' then
          select array_agg(z.id order by z.sort_at desc) into v_ids from (
            select r.id, r.sort_at from public._r23_rows(o.id, p.id) r
             where r.is_unread and r.digested_at is null and public._r23_important(r.kind)
               and r.sort_at <= now() - interval '5 minutes' and r.sort_at >= now() - interval '1 day'
             order by r.sort_at desc limit 20) z;
          if v_ids is not null then v_key := 'inbox_instant:' || p.id::text || ':' || md5(array_to_string(v_ids, ',')); end if;
        end if;
        if v_ids is null or v_key is null then continue; end if;
        insert into public.helm_notice_outbox (kind, org_id, ref_id, payload, dedupe_key)
          values ('inbox_digest', o.id, p.id, jsonb_build_object('user_id', p.id, 'mode', v_mode, 'ids', to_jsonb(v_ids)), v_key)
        on conflict (dedupe_key) do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into public.notification_inbox_state (user_id, notification_id, org_id, digested_at)
            select p.id, i, o.id, now() from unnest(v_ids) i
          on conflict (user_id, notification_id) do update set digested_at = now(), updated_at = now();
          v_n := v_n + 1;
        end if;
      end loop;
    exception when others then
      raise warning 'r23-inbox-0266: digest skipped for one studio (%)', sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- pg_cron (every 5 minutes) or the service role: snoozes that ran out come back as unread, then digests are queued
create or replace function public.inbox_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
declare v_back integer := 0; v_q integer := 0;
begin
  if auth.uid() is not null and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501'; end if;
  update public.notification_inbox_state s
     set unread_at = greatest(coalesce(s.unread_at, '-infinity'::timestamptz), s.snoozed_until),
         snooze_returned_at = s.snoozed_until, snoozed_until = null, updated_at = now()
   where s.snoozed_until is not null and s.snoozed_until <= now() and s.done_at is null;
  get diagnostics v_back = row_count;
  begin
    v_q := public._r23_queue_digests();
  exception when others then raise warning 'r23-inbox-0266: digests skipped (%)', sqlstate;
  end;
  return jsonb_build_object('returned', v_back, 'queued', v_q);
end $$;

-- ---- 8) the e-mail lane: outbox kinds widened once (superset) + one claim branch ------------------------------------
do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0266: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('inbox_digest' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0266: helm_notice_outbox kind check has an unexpected body - left unchanged (digests stay off)'; return; end if;
  v_kinds := v_kinds || array['inbox_digest'];
  -- same shape as the 0244 / 0254 check (kind in ('a', 'b', ...)), so a later migration can widen it the same way
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0266 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0266 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r23-inbox-0266' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0266: helm_notice_outbox_claim has an unexpected body - left unchanged (digests are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind = ''inbox_digest'' and r.org_id is not null and r.ref_id is not null then\n'
        || E'      -- r23-inbox-0266: inbox e-mail digest (still-unread items re-checked here)\n'
        || E'      v_data := public._r23_digest_mail(r.org_id, r.ref_id, r.payload);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 9) trial retention (0184) knows the new tables (patched in place, skipped when 0184 is not installed) -----------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''notification_inbox_state''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''notifications''', ''))) / length('''notifications''') <> 1 then
        raise notice '0266: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''notifications''', '''notification_inbox_state'', ''notifications''');
      end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''inbox_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''notification_seen''', ''))) / length('''notification_seen''') <> 1 then
        raise notice '0266: _tr184_keep_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''notification_seen''', '''notification_seen'', ''inbox_settings'', ''inbox_person_prefs''');
      end if;
    end if;
  end if;
end $$;

-- ---- 10) grants ------------------------------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._r23_area(uuid, text, text, text)', 'public._r23_detail(jsonb, boolean)', 'public._r23_visible(uuid, uuid)',
    'public._r23_rows(uuid, uuid)', 'public._r23_cfg(uuid)', 'public._r23_tz(uuid)', 'public._r23_mode(uuid, uuid)',
    'public._r23_important(text)', 'public._r23_label(text, jsonb)', 'public._r23_snooze_at(uuid, text, timestamptz)',
    'public._r23_counts(uuid, uuid)', 'public._r23_my_settings(uuid, uuid)', 'public._r23_digest_mail(uuid, uuid, jsonb)',
    'public._r23_queue_digests()', 'public.inbox_tick()',
    'public.inbox_feed(text, text, uuid, integer, text)', 'public.inbox_act(uuid[], text, timestamptz, text)',
    'public.inbox_read_all(text, uuid)', 'public.inbox_my_settings()', 'public.inbox_set_my_digest(text)',
    'public.admin_get_inbox_settings()', 'public.admin_set_inbox_settings(jsonb)', 'public.bell_feed(integer)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach s in array array['public.inbox_feed(text, text, uuid, integer, text)', 'public.inbox_act(uuid[], text, timestamptz, text)',
      'public.inbox_read_all(text, uuid)', 'public.inbox_my_settings()', 'public.inbox_set_my_digest(text)',
      'public.admin_get_inbox_settings()', 'public.admin_set_inbox_settings(jsonb)', 'public.bell_feed(integer)'] loop
      execute format('grant execute on function %s to authenticated', s);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.inbox_tick() to service_role';
  end if;
end $$;

-- ---- 11) pg_cron, ONLY if it is already installed (never created here) -------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_inbox_tick') then
        perform cron.schedule('helm_inbox_tick', '*/5 * * * *', 'select public.inbox_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_inbox_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
