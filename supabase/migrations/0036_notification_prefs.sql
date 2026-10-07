-- ============================================================================
-- 0036_notification_prefs.sql — CANONICAL forward-only. Admin-managed
-- notifications per role (and per person).
--
-- Before this file every member of a studio saw EVERY entry of the studio's
-- notification log in the bell (crew saw payment receipts, OTP sends, …) and
-- nothing could be switched off. What this adds, in plain words:
--
--   1  notification_catalog() — the fixed list of notification TYPES Helm makes,
--      with a group (Sales / Planning / Operations / Finance / Chat / System),
--      the channels each one really uses (in-app bell, sms, email, whatsapp),
--      which outbound channels are REQUIRED (client OTP, receipts, links … — they
--      always go out and can't be switched off) and which outbound channels a
--      studio admin MAY switch off (automatic texts/emails to staff only).
--   2  notification_type_of(kind, channel) — maps a raw notifications.kind (e.g.
--      'task_accept', 'design_revise', 'nurture_birthday') to its catalog type.
--   3  notification_prefs — per studio: on/off per (role, type, channel), plus an
--      optional per-person override of the in-app bell. enabled = NULL means
--      "follow the default" — "reset to defaults" never deletes a row.
--      RLS: members read their own studio's rows; writes only through the admin
--      RPCs below (direct table writes are not granted to API roles).
--   4  notify_allowed(org, role, type, channel) — the rule everything uses:
--      required → always true; else the role's row, else the studio-wide row,
--      else the DEFAULT. Defaults = today's behaviour, with one deliberate
--      exception: money notifications (payment link / reminder / receipt /
--      payment received / needs attention) default ON in the bell only for admin
--      and roles that have Budget & finance VIEW access in the access matrix.
--   5  bell_feed() and my_pending() hide the types switched off for the caller
--      (their role, or their personal override). bell_feed no longer returns the
--      recipient column (client phone/e-mail) — the bell never displayed it.
--   6  A BEFORE INSERT trigger on notifications marks automatic staff texts/emails
--      (task assigned / reminder / due SMS, studio "payment received" e-mail)
--      as status 'suppressed' when the studio switched that channel off. The row
--      is still logged (audit trail); client-facing messages are never touched.
--   7  admin_get_notification_prefs / admin_set_notification_pref /
--      admin_reset_notification_prefs (studio admin only, own studio only) and
--      my_notification_prefs (any signed-in member: which types are hidden for
--      them — the bell uses it to hide chat). Every change writes audit_log
--      (actions 'notification_pref.set' / 'notification_pref.reset').
--
-- No existing row is changed or deleted by this file. The only DDL on an
-- existing table: notifications.status CHECK widened to allow 'suppressed'
-- (NOT VALID — existing rows already satisfy it). Idempotent. Forward-only.
-- Requires 0034 (chat_directory). Does NOT depend on 0035.
-- ============================================================================

-- 1) catalog (internal source of truth) ---------------------------------------
create or replace function public.notification_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  select $cat$[
    {"type":"approval_link","group":"Sales","label":"Approval link sent","audience":"client",
     "description":"The client was sent the link to review and approve their quote.",
     "channels":["in_app","sms"],"required":["sms"],"gated":[],"money":false},
    {"type":"otp","group":"Sales","label":"Approval code (OTP) sent","audience":"client",
     "description":"A one-time code was texted to the client so they can approve the quote.",
     "channels":["in_app","sms"],"required":["sms"],"gated":[],"money":false},
    {"type":"whatsapp_message","group":"Sales","label":"WhatsApp message sent","audience":"client",
     "description":"A teammate sent a WhatsApp message (event update, reminder or crew note) from Helm.",
     "channels":["in_app","whatsapp"],"required":["whatsapp"],"gated":[],"money":false},
    {"type":"nurture_greeting","group":"Sales","label":"Birthday / anniversary greeting","audience":"client",
     "description":"A greeting e-mail was queued for a past client's birthday or anniversary (Nurture).",
     "channels":["in_app","email"],"required":["email"],"gated":[],"money":false},
    {"type":"design_update","group":"Planning","label":"Design stage changed","audience":"staff",
     "description":"An event's design moved to a new stage (draft, revision, approved and so on).",
     "channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"task_assigned","group":"Planning","label":"Tasks assigned","audience":"staff",
     "description":"Tasks were assigned to a crew member or outsourced to a vendor; they are texted their work link.",
     "channels":["in_app","sms"],"required":[],"gated":["sms"],"money":false},
    {"type":"task_update","group":"Operations","label":"Task accepted / started / done","audience":"staff",
     "description":"A crew member accepted, rejected, started or completed a task from their work link.",
     "channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"task_reminder","group":"Operations","label":"Task reminder","audience":"staff",
     "description":"A repeating reminder text to the person who owns an open task.",
     "channels":["in_app","sms"],"required":[],"gated":["sms"],"money":false},
    {"type":"task_due","group":"Operations","label":"Task due","audience":"staff",
     "description":"A task reached its start time; the person who owns it is texted.",
     "channels":["in_app","sms"],"required":[],"gated":["sms"],"money":false},
    {"type":"payment_link","group":"Finance","label":"Payment link sent","audience":"client",
     "description":"The client was texted a link to pay.",
     "channels":["in_app","sms"],"required":["sms"],"gated":[],"money":true},
    {"type":"payment_reminder","group":"Finance","label":"Payment reminder sent","audience":"client",
     "description":"A teammate sent the client a reminder that a payment is due.",
     "channels":["in_app","sms"],"required":["sms"],"gated":[],"money":true},
    {"type":"payment_receipt","group":"Finance","label":"Payment receipt","audience":"client",
     "description":"The client was sent a receipt after paying.",
     "channels":["in_app","email","sms"],"required":["email","sms"],"gated":[],"money":true},
    {"type":"advance_paid","group":"Finance","label":"Payment received (studio e-mail)","audience":"studio",
     "description":"An e-mail to your studio inbox when a payment is recorded or paid online.",
     "channels":["in_app","email"],"required":[],"gated":["email"],"money":true},
    {"type":"payment_reconcile","group":"Finance","label":"Payment needs attention","audience":"studio",
     "description":"An online payment could not be applied to its event automatically (refund or match it by hand).",
     "channels":["in_app","email"],"required":["email"],"gated":[],"money":true},
    {"type":"chat_message","group":"Chat","label":"Chat messages","audience":"staff",
     "description":"Unread direct, group and Everyone messages shown in the bell.",
     "channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"other","group":"System","label":"Other updates","audience":"staff",
     "description":"Any other event activity Helm logs for your studio.",
     "channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb;
$$;

create or replace function public._notify_cat(p_type text)
returns jsonb language sql immutable set search_path = '' as $$
  select e from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = p_type limit 1;
$$;

-- staff roles the matrix governs (canonical list in store-api.js ALL_ROLES, minus client)
create or replace function public._notify_roles()
returns text[] language sql immutable set search_path = '' as $$
  select array['admin','manager','planner','sales','coordinator','supervisor','quality','operations','designer','crew','worker']::text[];
$$;

-- 2) raw kind → catalog type --------------------------------------------------
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable set search_path = '' as $$
  select case
    when k in ('approval_link','otp','payment_link','payment_reminder','payment_receipt','advance_paid',
               'payment_reconcile','task_assigned','task_reminder','task_due') then k
    when k in ('payment','payment_received') then 'payment_receipt'
    when k in ('task_accept','task_reject','task_start','task_complete') then 'task_update'
    when k like 'design\_%' then 'design_update'
    when k like 'nurture\_%' then 'nurture_greeting'
    when k like 'chat\_%' then 'chat_message'
    when coalesce(p_channel, '') = 'whatsapp' then 'whatsapp_message'
    else 'other' end
  from (select lower(btrim(coalesce(p_kind, ''))) as k) x;
$$;

create or replace function public.notify_required(p_type text, p_channel text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((public._notify_cat(p_type) -> 'required') ? coalesce(p_channel, ''), false);
$$;

-- 3) the prefs table ------------------------------------------------------------
create table if not exists public.notification_prefs (
  id uuid not null default gen_random_uuid() primary key,
  org_id uuid not null default public.current_org_id() references public.organizations(id),
  role text not null default '*',
  user_id uuid references auth.users(id) on delete cascade,   -- a removed user's overrides go with them
  type text not null,
  channel text not null,
  enabled boolean,                                             -- NULL = follow the default
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint notification_prefs_channel_chk check (channel in ('in_app','sms','email','whatsapp')),
  constraint notification_prefs_type_chk check (type ~ '^[a-z_]{1,40}$'),
  constraint notification_prefs_role_chk check (role ~ '^(\*|[a-z_]{1,20})$')
);
create unique index if not exists notification_prefs_role_uq
  on public.notification_prefs (org_id, role, type, channel) where user_id is null;
create unique index if not exists notification_prefs_user_uq
  on public.notification_prefs (org_id, user_id, type, channel) where user_id is not null;
create index if not exists notification_prefs_org_idx on public.notification_prefs (org_id);

alter table public.notification_prefs enable row level security;
drop policy if exists "np read own studio" on public.notification_prefs;
create policy "np read own studio" on public.notification_prefs for select to authenticated
  using (org_id = (select public.current_org_id()));
-- second layer only: API roles hold no write grant; the admin RPCs below write.
drop policy if exists "np admin write" on public.notification_prefs;
create policy "np admin write" on public.notification_prefs for all to authenticated
  using (org_id = (select public.current_org_id()) and (select public.is_admin()))
  with check (org_id = (select public.current_org_id()) and (select public.is_admin()));
-- same temp-password backstop every other RLS table has (0032 §7)
do $$ begin
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'drop policy if exists helm_pwgate_ins on public.notification_prefs';
    execute 'create policy helm_pwgate_ins on public.notification_prefs as restrictive for insert to authenticated with check (not (select public.helm_pw_change_pending()))';
    execute 'drop policy if exists helm_pwgate_upd on public.notification_prefs';
    execute 'create policy helm_pwgate_upd on public.notification_prefs as restrictive for update to authenticated using (not (select public.helm_pw_change_pending())) with check (not (select public.helm_pw_change_pending()))';
    execute 'drop policy if exists helm_pwgate_del on public.notification_prefs';
    execute 'create policy helm_pwgate_del on public.notification_prefs as restrictive for delete to authenticated using (not (select public.helm_pw_change_pending()))';
  end if;
end $$;

revoke all on public.notification_prefs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.notification_prefs from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.notification_prefs from authenticated';
    execute 'grant select on public.notification_prefs to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.notification_prefs to service_role'; end if;
end $$;

-- 4) the rule -------------------------------------------------------------------
create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when public.notify_required(p_type, p_channel) then true
    when p_channel = 'in_app' and coalesce((public._notify_cat(p_type) ->> 'money')::boolean, false) then
      coalesce(p_role = 'admin', false)
      or exists (select 1 from public.role_access ra
                  where ra.org_id = p_org and ra.role = p_role and ra.area = 'finance' and ra.can_view)
    else true end;
$$;

create or replace function public.notify_allowed(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when public.notify_required(p_type, p_channel) then true else coalesce(
    (select np.enabled from public.notification_prefs np
      where np.org_id = p_org and np.user_id is null and np.role = coalesce(p_role, '*')
        and np.type = p_type and np.channel = p_channel),
    (select np.enabled from public.notification_prefs np
      where np.org_id = p_org and np.user_id is null and np.role = '*'
        and np.type = p_type and np.channel = p_channel),
    public.notify_default(p_org, coalesce(p_role, '*'), p_type, p_channel)) end;
$$;

-- a person: their own override first, then their role's rule
create or replace function public.notify_allowed_user(p_org uuid, p_user uuid, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when public.notify_required(p_type, p_channel) then true else coalesce(
    (select np.enabled from public.notification_prefs np
      where np.org_id = p_org and np.user_id = p_user and np.type = p_type and np.channel = p_channel),
    public.notify_allowed(p_org, (select p.role from public.profiles p where p.id = p_user and p.org_id = p_org),
                          p_type, p_channel)) end;
$$;

-- the catalog types hidden from a person's bell
create or replace function public._notify_hidden_types(p_org uuid, p_user uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c ->> 'type'), '{}'::text[])
    from jsonb_array_elements(public.notification_catalog()) c
   where p_org is not null and p_user is not null
     and not public.notify_allowed_user(p_org, p_user, c ->> 'type', 'in_app');
$$;

-- 5) bell + dashboard counter honour the prefs ------------------------------------
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- notification-prefs-0036: types switched off for the caller are hidden; no recipient column
declare uid uuid := auth.uid(); org uuid := public.current_org_id(); seen timestamptz; result jsonb; v_hidden text[];
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select s.last_seen_at into seen from public.notification_seen s where s.user_id = uid;
  seen := coalesce(seen, 'epoch'::timestamptz);
  v_hidden := public._notify_hidden_types(org, uid);
  with recent as (
    select n.id, n.kind, n.channel, n.status, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
      from public.notifications n
      left join public.quotes q on q.id = n.quote_id
     where n.org_id = org
       and not (public.notification_type_of(n.kind, n.channel) = any (v_hidden))
     order by n.created_at desc
     limit greatest(1, least(coalesce(p_limit, 20), 100))
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from public.notifications n
                where n.org_id = org and n.created_at > seen
                  and not (public.notification_type_of(n.kind, n.channel) = any (v_hidden)))
  ) into result;
  return result;
end $$;

create or replace function public.my_pending()
returns jsonb language sql stable security definer set search_path = public as $$
  -- notification-prefs-0036: 'unread' skips types switched off for the caller
  with me as (
    select auth.uid() as uid, public.current_org_id() as org, public.has_area('quotes','view') as can_view
  ),
  hid as (select public._notify_hidden_types(me.org, me.uid) as h from me),
  ev as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.event_time, q.lifecycle_stage,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is null)     as open_tasks,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is not null) as done_tasks
    from public.quotes q, me
    where me.can_view
      and q.org_id = me.org
      and coalesce(q.lifecycle_stage,'') <> 'closed'
    order by q.event_date nulls last, q.updated_at desc
    limit 25
  ),
  unread as (
    select count(*)::int as c
    from public.notifications n, me, hid
    where n.org_id = me.org
      and n.created_at > coalesce((select last_seen_at from public.notification_seen s where s.user_id = me.uid), '-infinity'::timestamptz)
      and not (public.notification_type_of(n.kind, n.channel) = any (hid.h))
  )
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(ev) order by (ev.event_date is null), ev.event_date) from ev), '[]'::jsonb),
    'unread',   (select c from unread),
    'as_of',    now()
  );
$$;

-- 6) outbound gate: automatic staff texts/e-mails a studio switched off ------------
alter table public.notifications drop constraint if exists notifications_status_check;
alter table public.notifications add constraint notifications_status_check
  check (status = any (array['simulated', 'sent', 'failed', 'suppressed'])) not valid;

create or replace function public.tg_notification_prefs_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  if NEW.channel in ('sms', 'email', 'whatsapp') and NEW.org_id is not null
     and coalesce(NEW.status, '') <> 'failed' then
    v_type := public.notification_type_of(NEW.kind, NEW.channel);
    -- only channels the catalog marks switchable (never a client message / OTP / receipt)
    if coalesce((public._notify_cat(v_type) -> 'gated') ? NEW.channel, false)
       and not public.notify_allowed(NEW.org_id, '*', v_type, NEW.channel) then
      NEW.status := 'suppressed';
      NEW.detail := coalesce(NEW.detail, '{}'::jsonb) || jsonb_build_object('suppressed_by', 'notification_prefs');
    end if;
  end if;
  return NEW;
end $$;
drop trigger if exists zz_notification_prefs_gate on public.notifications;
create trigger zz_notification_prefs_gate before insert on public.notifications
  for each row execute function public.tg_notification_prefs_gate();

-- 7) RPCs ------------------------------------------------------------------------
-- signed-in member: which types are hidden from MY bell (chat is merged client-side)
create or replace function public.my_notification_prefs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('hidden', to_jsonb(public._notify_hidden_types(v_org, v_me)));
end $$;

-- studio admin: the whole picture for the Control Center matrix
create or replace function public.admin_get_notification_prefs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_roles text[] := public._notify_roles(); v_cat jsonb := public.notification_catalog();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'catalog', v_cat,
    'roles', to_jsonb(v_roles),
    'in_app', (select jsonb_object_agg(c ->> 'type', (
        select jsonb_object_agg(r, jsonb_build_object(
          'on', public.notify_allowed(v_org, r, c ->> 'type', 'in_app'),
          'default', public.notify_default(v_org, r, c ->> 'type', 'in_app'),
          'set', exists (select 1 from public.notification_prefs np where np.org_id = v_org and np.user_id is null
                          and np.role = r and np.type = c ->> 'type' and np.channel = 'in_app' and np.enabled is not null)))
          from unnest(v_roles) r))
        from jsonb_array_elements(v_cat) c),
    'outbound', (select coalesce(jsonb_object_agg(c ->> 'type', (
        select coalesce(jsonb_object_agg(ch, jsonb_build_object(
          'on', public.notify_allowed(v_org, '*', c ->> 'type', ch),
          'default', public.notify_default(v_org, '*', c ->> 'type', ch),
          'required', public.notify_required(c ->> 'type', ch),
          'switchable', coalesce((c -> 'gated') ? ch, false))), '{}'::jsonb)
          from jsonb_array_elements_text(c -> 'channels') ch where ch <> 'in_app')), '{}'::jsonb)
        from jsonb_array_elements(v_cat) c),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', np.user_id, 'type', np.type, 'enabled', np.enabled)
                 order by np.user_id, np.type), '[]'::jsonb)
                 from public.notification_prefs np
                where np.org_id = v_org and np.user_id is not null and np.enabled is not null),
    'changed', (select count(*) from public.notification_prefs np where np.org_id = v_org and np.enabled is not null)
  );
end $$;

-- studio admin: set one cell. p_enabled NULL = back to the default.
--   in_app + p_role  → that role's bell;   in_app + p_user → that person's bell (own studio only);
--   sms/email/whatsapp → studio-wide, and only where the catalog marks it switchable.
create or replace function public.admin_set_notification_pref(p_type text, p_channel text, p_role text,
                                                              p_enabled boolean, p_user uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_cat jsonb; v_role text;
        v_id uuid; v_old boolean; v_email text; v_ch text := lower(btrim(coalesce(p_channel, '')));
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_cat := public._notify_cat(p_type);
  if v_cat is null then raise exception 'unknown notification type' using errcode = '22023'; end if;
  if not coalesce((v_cat -> 'channels') ? v_ch, false) then
    raise exception 'this notification is not sent by %', coalesce(nullif(v_ch, ''), 'that channel') using errcode = '22023';
  end if;
  if public.notify_required(p_type, v_ch) then
    raise exception 'this notification is required and is always sent — it can''t be switched off' using errcode = '22023';
  end if;
  if v_ch <> 'in_app' and not coalesce((v_cat -> 'gated') ? v_ch, false) then
    raise exception 'this channel can''t be switched' using errcode = '22023';
  end if;
  if p_user is not null then
    if v_ch <> 'in_app' then raise exception 'per-person settings are for the in-app bell only' using errcode = '22023'; end if;
    perform 1 from public.profiles p where p.id = p_user and p.org_id = v_org;
    if not found then raise exception 'not authorized' using errcode = '42501'; end if;   -- unknown or another studio's user
    v_role := '*';
  elsif v_ch = 'in_app' then
    v_role := lower(btrim(coalesce(p_role, '')));
    if not (v_role = any (public._notify_roles())) then raise exception 'unknown role' using errcode = '22023'; end if;
  else
    v_role := '*';                                                                       -- outbound switches are studio-wide
  end if;

  select np.id, np.enabled into v_id, v_old from public.notification_prefs np
   where np.org_id = v_org and np.role = v_role and np.type = p_type and np.channel = v_ch
     and np.user_id is not distinct from p_user
   for update;
  if v_id is null then
    if p_user is null then
      insert into public.notification_prefs(org_id, role, user_id, type, channel, enabled, updated_by, updated_at)
        values (v_org, v_role, null, p_type, v_ch, p_enabled, v_me, now())
      on conflict (org_id, role, type, channel) where user_id is null
        do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
      returning id into v_id;
    else
      insert into public.notification_prefs(org_id, role, user_id, type, channel, enabled, updated_by, updated_at)
        values (v_org, '*', p_user, p_type, v_ch, p_enabled, v_me, now())
      on conflict (org_id, user_id, type, channel) where user_id is not null
        do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()
      returning id into v_id;
    end if;
  elsif v_old is distinct from p_enabled then
    update public.notification_prefs set enabled = p_enabled, updated_by = v_me, updated_at = now()
     where id = v_id and org_id = v_org;
  end if;

  if v_old is distinct from p_enabled then
    select p.email into v_email from public.profiles p where p.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'notification_pref.set', 'notification_prefs', v_id::text, v_org,
              jsonb_build_object('type', p_type, 'channel', v_ch, 'role', v_role, 'user_id', p_user,
                                 'enabled', jsonb_build_object('old', v_old, 'new', p_enabled)));
  end if;

  return jsonb_build_object('type', p_type, 'channel', v_ch, 'role', v_role, 'user_id', p_user, 'enabled', p_enabled,
    'effective', case when p_user is not null then public.notify_allowed_user(v_org, p_user, p_type, v_ch)
                      else public.notify_allowed(v_org, v_role, p_type, v_ch) end);
end $$;

-- studio admin: everything back to the defaults (rows kept, enabled → NULL)
create or replace function public.admin_reset_notification_prefs()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_prev jsonb; v_n integer; v_email text;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('type', np.type, 'channel', np.channel, 'role', np.role,
                                               'user_id', np.user_id, 'enabled', np.enabled)), '[]'::jsonb), count(*)
    into v_prev, v_n
    from public.notification_prefs np where np.org_id = v_org and np.enabled is not null;
  if v_n = 0 then return 0; end if;
  update public.notification_prefs set enabled = null, updated_by = v_me, updated_at = now()
   where org_id = v_org and enabled is not null;
  select p.email into v_email from public.profiles p where p.id = v_me;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
    values (v_me, v_email, 'notification_pref.reset', 'notification_prefs', null, v_org,
            jsonb_build_object('count', v_n, 'previous', v_prev));
  return v_n;
end $$;

-- grants --------------------------------------------------------------------------
-- internal helpers: never callable by API roles (notify_allowed takes any studio id)
revoke all on function public.notification_catalog() from public;
revoke all on function public._notify_cat(text) from public;
revoke all on function public._notify_roles() from public;
revoke all on function public.notification_type_of(text, text) from public;
revoke all on function public.notify_required(text, text) from public;
revoke all on function public.notify_default(uuid, text, text, text) from public;
revoke all on function public.notify_allowed(uuid, text, text, text) from public;
revoke all on function public.notify_allowed_user(uuid, uuid, text, text) from public;
revoke all on function public._notify_hidden_types(uuid, uuid) from public;
revoke all on function public.tg_notification_prefs_gate() from public;
revoke all on function public.bell_feed(integer) from public;
revoke all on function public.my_pending() from public;
revoke all on function public.my_notification_prefs() from public;
revoke all on function public.admin_get_notification_prefs() from public;
revoke all on function public.admin_set_notification_pref(text, text, text, boolean, uuid) from public;
revoke all on function public.admin_reset_notification_prefs() from public;
do $$
declare f text;
begin
  foreach f in array array[
    'public.notification_catalog()', 'public._notify_cat(text)', 'public._notify_roles()',
    'public.notification_type_of(text,text)', 'public.notify_required(text,text)',
    'public.notify_default(uuid,text,text,text)', 'public.notify_allowed(uuid,text,text,text)',
    'public.notify_allowed_user(uuid,uuid,text,text)', 'public._notify_hidden_types(uuid,uuid)',
    'public.tg_notification_prefs_gate()']
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- edge functions (service role) ask notify_allowed before an automatic studio e-mail
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.notify_allowed(uuid,text,text,text) to service_role';
  end if;
  foreach f in array array[
    'public.bell_feed(integer)', 'public.my_pending()', 'public.my_notification_prefs()',
    'public.admin_get_notification_prefs()', 'public.admin_set_notification_pref(text,text,text,boolean,uuid)',
    'public.admin_reset_notification_prefs()']
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select jsonb_array_length(public.notification_catalog());                                      -- 16
-- select has_function_privilege('authenticated','public.notify_allowed(uuid,text,text,text)','EXECUTE'); -- false
-- select has_function_privilege('authenticated','public.admin_set_notification_pref(text,text,text,boolean,uuid)','EXECUTE'); -- true
-- select count(*) from public.notification_prefs;                                                -- 0 on first apply
