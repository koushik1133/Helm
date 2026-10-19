-- APPLY-0241.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER everything up to APPLY-0239 (already applied on production). Order-independent of the other r21 files.
-- Delivery & arrival reminders (owner, r21): per assignment ("120 chairs from Deccan Rentals by 4:30 pm") with its
-- own reminder times (default 60 / 30 / 0 min from Control Center); e-mail reminders with a one-tap status link
-- (/delivery?t=...); every reply tracked on the assignment and posted by Helm into the event's team chat group +
-- the bell; "No response from X" when nobody answers. OFF until an admin switches it on in Control Center ->
-- Notifications. 5 NEW tables, new functions, a new access area with NO rows written (falls back to Event-day
-- command), one pg_cron job (only when pg_cron is installed). No existing table / column / policy / function / row
-- changed or deleted. Safe to run twice. ASCII only.
-- After this: deploy the site (delivery-*.js / .css, delivery.html, command.html, control.html, store-api.js,
-- capacity-shortage.js) and redeploy the edge function comms-dispatch (--no-verify-jwt). See the owner steps.
begin;
-- 0241_delivery_reminders.sql - CANONICAL forward-only.
-- REQUIRES phase29 / phase57 (role_access + has_area + current_org_id + user_role), 0004 (tg_quote_org_match),
--          0016 + 0035 (chat_conversations.quote_id event groups, chat_messages.meta mentions), 0045
--          (tg_studio_read_only), 0050 (rate_hit), 0078 (comms_settings, the comms-dispatch outbox pattern),
--          0097 (quotes.is_demo), 0150 (comms_settings.email_from_name / email_reply_to), 0166 / 0179
--          (_tb179_no_send), 0183 (_trial_locked), 0212 (_tr212_email_ok, trial_email_settings / sends).
--
-- In plain words (owner, r21): "tomorrow's event needs chairs; we don't have enough so they come from a vendor who
-- must deliver by a set time - as that time comes near, remind the vendor / staff automatically, ask them to reply,
-- track every reply on the assignment and tell the admin + the team in the event's chat group". No daily digests:
-- reminders belong to ONE assignment.
--   1  delivery_commitments - one row per promised delivery or arrival (an "assignment"): the event (quote), WHAT
--      (e.g. "Chairs"), quantity, WHO is responsible (a vendor, a staff member, a studio user or someone else) + their
--      e-mail, WHEN (due_at, timestamptz; the app enters it in the studio's time zone), and - chosen at the bottom of
--      the assignment form - ITS OWN reminder times (offsets, minutes before; e.g. 60 / 30 / 0; [] = none; null = the
--      studio default). Status: scheduled -> reminded -> confirmed (on the way) -> arrived, or delayed (with a new
--      time) / issue; cancelled instead of deleting (the app can never delete). delivery_commitment_log keeps every
--      step: when, status, note, new time, and WHO (a studio user by name, the person's own status link, or Helm).
--   2  delivery_settings - one row per studio, Control Center (controls EDIT): on / off (default OFF), the DEFAULT
--      reminder times (60 / 30 / 0), which kinds of people may be e-mailed (default vendor, staff, studio user;
--      "someone else" off), a copy to the person who scheduled it, post replies into the team chat (the event's own
--      group, or a studio group / the broadcast channel picked here), the bell, and the "no response" alert.
--   3  Access: a NEW access area 'deliveries' ("Deliveries & arrivals" in Control Center -> Roles & access):
--      view = see the tracker, edit = schedule / change / mark status. NO role_access row is written by this file:
--      until a studio saves a 'deliveries' row for a role, the role follows its 'command' (Event-day command)
--      switch (_dl241_can). Admin always.
--   4  The scheduler: delivery_reminders_tick() (pg_cron every 5 minutes, only if pg_cron is installed) queues one
--      reminder e-mail per (assignment, due time, reminder time, recipient) into delivery_reminder_sends (UNIQUE
--      dedupe key) at each of the assignment's reminder times before the due time (or the promised new time), only
--      while it still needs an answer (scheduled / reminded / delayed). Never late: a slot missed by more than 20
--      minutes is not queued. The dormant edge function comms-dispatch claims the rows (delivery_reminder_claim,
--      re-checked at claim time), sends the e-mail and marks it (delivery_reminder_mark). E-mail only (WhatsApp /
--      SMS stay off). No reply 15 minutes after the due time although reminded -> one "No response from X" alert.
--   5  Every reply (status link or a planner on the board) and every "no response" is posted by Helm (a system
--      message, @mentioning the studio admins + the person who scheduled it) into the event's team chat group (or the
--      group picked in settings) and dropped into the bell (kind event_reminder, detail.via = 'comms' so the 0078
--      WhatsApp forwarder skips it), e.g. "Chairs x120 (Deccan Rentals) - delayed: truck stuck, new ETA 5:30 pm".
--   6  Free trial: an active free trial may send these e-mails within the 0212 numbers (30 a day per studio, 5 a day
--      to one address, counted over the 0212 client e-mail ledger plus the reminders already let through); an ended
--      trial, the sample master and sample (demo) events never send.
--   7  The status link: every reminder e-mail carries a fresh one-click link /delivery?t=<64 hex> (two random UUIDs
--      = 244 random bits). Only its sha-256 is stored (delivery_links), it opens ONE assignment, and it expires (24
--      hours after the due time, at least 12 hours, at most 14 days). Without signing in the person can say "on the
--      way", "arrived", "delayed" (+ new time) or "problem" with a short note (rate-limited). A planner can also copy
--      such a link from the board (delivery_link_issue) to send it another way.
-- Changes: 5 new tables (RLS on; no API-role table privilege - the board and the link page go through the RPCs
-- below), 1 new access area (no rows), new functions only, 1 pg_cron job; inserts into chat_messages /
-- notifications (system rows, the 0129 pattern). No existing table, column, policy, function or row is changed or
-- deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): update public.delivery_settings set enabled = false (nothing more is
-- queued, sent or posted), and select cron.unschedule('helm_delivery_reminders'). The tables can stay (unused).

do $$ begin
  if to_regclass('public.role_access') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0241: phase29 / phase57 (role_access, has_area, current_org_id, user_role) is not applied'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is null then raise exception 'STOP 0241: 0004 (tg_quote_org_match) is not applied'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then raise exception 'STOP 0241: 0045 (tg_studio_read_only) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'quote_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'meta') then
    raise exception 'STOP 0241: 0016 + 0035 (chat event groups + mentions) are not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'comms_settings' and column_name = 'email_reply_to') then
    raise exception 'STOP 0241: 0150 (studio e-mail sender settings) is not applied'; end if;
  if to_regclass('public.event_plan') is null or to_regclass('public.event_resources') is null or to_regclass('public.notifications') is null then
    raise exception 'STOP 0241: event_plan / event_resources / notifications are missing'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0241: 0050 (rate_hit) is not applied'; end if;
  if to_regclass('public.comms_settings') is null then raise exception 'STOP 0241: 0078 (comms automation) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'is_demo') then
    raise exception 'STOP 0241: 0097 (quotes.is_demo) is not applied'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0241: 0179 (_tb179_no_send) is not applied'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then raise exception 'STOP 0241: 0183 (_trial_locked) is not applied'; end if;
  if to_regprocedure('public._tr212_email_ok(uuid)') is null or to_regprocedure('public._tr212_rcpt_hash(text)') is null
     or to_regclass('public.trial_email_settings') is null or to_regclass('public.trial_email_sends') is null then
    raise exception 'STOP 0241: 0212 (trial e-mail caps) is not applied'; end if;
end $$;

-- ---- 1) tables --------------------------------------------------------------------------------------------------
create table if not exists public.delivery_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  enabled     boolean not null default false,
  offsets     integer[] not null default array[60, 30, 0]::integer[],
  ping_kinds  text[] not null default array['vendor', 'staff', 'user']::text[],
  cc_creator  boolean not null default true,
  chat_post   boolean not null default true,
  chat_conversation_id uuid references public.chat_conversations(id) on delete set null,
  notify_bell boolean not null default true,
  no_response_alert boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  constraint delivery_settings_offsets_chk check (cardinality(offsets) between 1 and 6 and 0 <= all(offsets) and 1440 >= all(offsets)),
  constraint delivery_settings_kinds_chk check (ping_kinds <@ array['vendor', 'staff', 'user', 'other']::text[])
);

create table if not exists public.delivery_commitments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  what          text not null check (char_length(btrim(what)) between 1 and 200),
  qty           numeric check (qty is null or (qty > 0 and qty <= 1000000)),
  party_kind    text not null default 'vendor' check (party_kind in ('vendor', 'staff', 'user', 'other')),
  vendor_id     uuid references public.vendors(id) on delete set null,
  crew_id       uuid references public.crew_members(id) on delete set null,
  user_id       uuid references public.profiles(id) on delete set null,
  party_name    text check (party_name is null or char_length(party_name) <= 120),
  contact_email text check (contact_email is null or contact_email ~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$'),
  due_at        timestamptz not null,
  eta_at        timestamptz,
  status        text not null default 'scheduled' check (status in ('scheduled', 'reminded', 'confirmed', 'arrived', 'delayed', 'issue', 'cancelled')),
  note          text check (note is null or char_length(note) <= 500),
  source        text not null default 'manual' check (source in ('manual', 'shortage', 'resource', 'command')),
  booking_id    uuid,
  reminders_on  boolean not null default true,
  offsets       integer[] check (offsets is null or (cardinality(offsets) <= 6 and 0 <= all(offsets) and 1440 >= all(offsets))),
  no_response_at timestamptz,
  status_at     timestamptz not null default now(),
  status_by     text check (status_by is null or char_length(status_by) <= 160),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists delivery_commitments_quote_idx on public.delivery_commitments(quote_id, due_at);
create index if not exists delivery_commitments_due_idx on public.delivery_commitments(due_at) where status in ('scheduled', 'reminded', 'delayed');

create table if not exists public.delivery_commitment_log (
  id            uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.delivery_commitments(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  at            timestamptz not null default clock_timestamp(),
  status        text not null,
  note          text check (note is null or char_length(note) <= 500),
  eta_at        timestamptz,
  actor_kind    text not null check (actor_kind in ('user', 'link', 'system')),
  actor_id      uuid,
  actor_label   text check (actor_label is null or char_length(actor_label) <= 160)
);
create index if not exists delivery_commitment_log_idx on public.delivery_commitment_log(commitment_id, at);

create table if not exists public.delivery_reminder_sends (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  commitment_id  uuid not null references public.delivery_commitments(id) on delete cascade,
  offset_min     integer not null,
  recipient_kind text not null check (recipient_kind in ('party', 'cc')),
  recipient      text not null check (char_length(recipient) between 3 and 200),
  dedupe_key     text not null check (char_length(dedupe_key) <= 200),
  status         text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason         text,
  trial_slot     boolean not null default false,
  attempts       integer not null default 0,
  claimed_at     timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists delivery_reminder_sends_dedupe on public.delivery_reminder_sends(dedupe_key);
create index if not exists delivery_reminder_sends_pending_idx on public.delivery_reminder_sends(created_at) where sent_at is null;

create table if not exists public.delivery_links (
  token_hash    text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  commitment_id uuid not null references public.delivery_commitments(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  issued_via    text not null check (issued_via in ('email', 'copy')),
  expires_at    timestamptz not null,
  uses          integer not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists delivery_links_commitment_idx on public.delivery_links(commitment_id);

-- RLS on everywhere; no API-role table privilege at all (the board + the link page go through the RPCs below)
do $$ declare t text; begin
  foreach t in array array['delivery_settings', 'delivery_commitments', 'delivery_commitment_log', 'delivery_reminder_sends', 'delivery_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    -- suspended studios are read-only for signed-in / signed-out callers (0045 guard)
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  -- quote <-> studio integrity (0004 G4)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.delivery_commitments'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.delivery_commitments for each row execute function public.tg_quote_org_match();
  end if;
end $$;

-- ---- 2) helpers (internal, no app grants) -----------------------------------------------------------------------
-- 'deliveries' area: the studio's own row for the role when saved, else the role's 'command' switch; admin always
create or replace function public._dl241_can(p_need text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- delivery-reminders-0241
  select case
    when public.current_org_id() is null or auth.uid() is null then false
    when public.user_role() = 'admin' then true
    when exists (select 1 from public.role_access ra where ra.org_id = public.current_org_id() and ra.role = public.user_role()
                   and ra.area = 'deliveries')
      then coalesce((select case when p_need = 'edit' then ra.can_edit and ra.can_view else ra.can_view end from public.role_access ra
                      where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.area = 'deliveries'), false)
    else coalesce(public.has_area('command', p_need), false)
  end;
$$;

create or replace function public._dl241_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- delivery-reminders-0241: the studio's settings, or the defaults (reminders off)
  select coalesce((select jsonb_build_object('enabled', s.enabled, 'offsets', to_jsonb(s.offsets), 'ping_kinds', to_jsonb(s.ping_kinds),
                                             'cc_creator', s.cc_creator, 'chat_post', s.chat_post, 'chat_conversation_id', s.chat_conversation_id,
                                             'notify_bell', s.notify_bell, 'no_response_alert', s.no_response_alert, 'updated_at', s.updated_at)
                     from public.delivery_settings s where s.org_id = p_org),
                  jsonb_build_object('enabled', false, 'offsets', to_jsonb(array[60, 30, 0]), 'ping_kinds', to_jsonb(array['vendor', 'staff', 'user']),
                                     'cc_creator', true, 'chat_post', true, 'chat_conversation_id', null, 'notify_bell', true,
                                     'no_response_alert', true, 'updated_at', null));
$$;

create or replace function public._dl241_email_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(btrim(p), '') ~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$';
$$;

create or replace function public._dl241_tz(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') into v from public.organizations o where o.id = p_org;
  v := coalesce(v, 'Asia/Kolkata');
  begin perform now() at time zone v; exception when others then v := 'Asia/Kolkata'; end;
  return v;
end $$;

-- dd/mm/yyyy, hh:mi AM in the studio's zone (India-first display)
create or replace function public._dl241_when(p_at timestamptz, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_at is null then null else to_char(p_at at time zone public._dl241_tz(p_org), 'DD/MM/YYYY, HH12:MI AM') end;
$$;

-- free trial: the 0212 numbers (trial_email_settings: 30 a day per studio, 5 a day per address), counted over the
-- 0212 client e-mail ledger PLUS the reminders already let through (delivery_reminder_sends.trial_slot) - so a
-- reminder only uses what is left of the studio's day. The 0212 ledger itself is not written (its kind list is
-- fixed); null = OK, else 'cap_studio' | 'cap_recipient' | 'bad_recipient'. Same advisory lock as 0212.
create or replace function public._dl241_trial_take(p_org uuid, p_recipient text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_day integer; v_rcpt integer; v_n integer; v_h text;
begin
  if p_org is null or not public._dl241_email_ok(p_recipient) then return 'bad_recipient'; end if;
  select coalesce(min(x.per_studio_day), 30), coalesce(min(x.per_recipient_day), 5) into v_day, v_rcpt from public.trial_email_settings x where x.id;
  v_day := coalesce(v_day, 30); v_rcpt := coalesce(v_rcpt, 5);
  perform pg_advisory_xact_lock(hashtextextended('helm:trial-email:' || p_org::text, 0));
  select (select count(*) from public.trial_email_sends t where t.org_id = p_org and t.created_at > now() - interval '24 hours')
       + (select count(*) from public.delivery_reminder_sends s where s.org_id = p_org and s.trial_slot and s.created_at > now() - interval '24 hours')
    into v_n;
  if v_n >= v_day then return 'cap_studio'; end if;
  v_h := public._tr212_rcpt_hash(p_recipient);
  select (select count(*) from public.trial_email_sends t where t.org_id = p_org and t.recipient_hash = v_h and t.created_at > now() - interval '24 hours')
       + (select count(*) from public.delivery_reminder_sends s where s.org_id = p_org and s.trial_slot and lower(s.recipient) = lower(btrim(p_recipient))
            and s.created_at > now() - interval '24 hours')
    into v_n;
  if v_n >= v_rcpt then return 'cap_recipient'; end if;
  return null;
end $$;

-- the free-trial / sample rule: null = may e-mail (slot taken when it is a trial), else the reason it may not
create or replace function public._dl241_send_block(p_org uuid, p_recipient text, p_take boolean)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_cap text;
begin
  if p_org is null then return 'no_studio'; end if;
  if exists (select 1 from public.organizations o where o.id = p_org and coalesce(o.is_sample_master, false)) then return 'sample_master'; end if;
  if coalesce(public._trial_locked(p_org), false) then return 'trial_ended'; end if;
  if not coalesce(public._tb179_no_send(p_org), false) then return null; end if;        -- paid studio: no cap
  if not coalesce(public._tr212_email_ok(p_org), false) then return 'trial_no_send'; end if;
  if not p_take then return null; end if;
  v_cap := public._dl241_trial_take(p_org, p_recipient);
  return case when v_cap is null then null else 'trial_' || v_cap end;
end $$;

create or replace function public._dl241_actor_label(p_uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select left(coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Studio member'), 160) from public.profiles p where p.id = p_uid;
$$;

create or replace function public._dl241_log(p_c uuid, p_org uuid, p_status text, p_note text, p_eta timestamptz, p_kind text, p_actor uuid, p_label text)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.delivery_commitment_log(commitment_id, org_id, status, note, eta_at, actor_kind, actor_id, actor_label)
    values (p_c, p_org, p_status, left(nullif(btrim(coalesce(p_note, '')), ''), 500), p_eta, p_kind, p_actor, left(p_label, 160));
$$;

-- one commitment as the board shows it
create or replace function public._dl241_row(p_c public.delivery_commitments)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p_c.id, 'quote_id', p_c.quote_id, 'what', p_c.what, 'qty', p_c.qty, 'party_kind', p_c.party_kind,
    'vendor_id', p_c.vendor_id, 'crew_id', p_c.crew_id, 'user_id', p_c.user_id, 'party_name', p_c.party_name,
    'contact_email', p_c.contact_email, 'due_at', p_c.due_at, 'eta_at', p_c.eta_at, 'status', p_c.status, 'note', p_c.note,
    'source', p_c.source, 'booking_id', p_c.booking_id, 'reminders_on', p_c.reminders_on, 'status_at', p_c.status_at,
    'offsets', to_jsonb(p_c.offsets), 'no_response_at', p_c.no_response_at,
    'offsets_effective', to_jsonb(coalesce(p_c.offsets, (select x.offsets from public.delivery_settings x where x.org_id = p_c.org_id), array[60, 30, 0])),
    'status_by', p_c.status_by, 'created_at', p_c.created_at, 'created_by', p_c.created_by,
    'due_text', public._dl241_when(p_c.due_at, p_c.org_id), 'eta_text', public._dl241_when(p_c.eta_at, p_c.org_id),
    'overdue', p_c.status in ('scheduled', 'reminded', 'confirmed', 'delayed') and coalesce(p_c.eta_at, p_c.due_at) < now(),
    'reminders_sent', (select count(*) from public.delivery_reminder_sends s where s.commitment_id = p_c.id and s.status = 'sent'),
    'reminders_queued', (select count(*) from public.delivery_reminder_sends s where s.commitment_id = p_c.id and s.status = 'pending'),
    'event_title', (select q.title from public.quotes q where q.id = p_c.quote_id),
    'event_code', (select q.code from public.quotes q where q.id = p_c.quote_id),
    'event_date', (select q.event_date from public.quotes q where q.id = p_c.quote_id));
$$;

-- "4:52 pm" in the studio's zone
create or replace function public._dl241_hm(p_at timestamptz, p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_at is null then null else lower(to_char(p_at at time zone public._dl241_tz(p_org), 'FMHH12:MI am')) end;
$$;

-- the one-line update posted into the team chat + the bell (emoji written as chr() so this file stays ASCII)
create or replace function public._dl241_update_text(p_c public.delivery_commitments, p_event text, p_note text, p_by text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_what text; v_who text; v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:cntrl:]]', ' ', 'g')), ''); v text; v_code text;
begin
  v_what := p_c.what || case when p_c.qty is not null then ' x' || trim(to_char(p_c.qty, 'FM9999999990.##'), '.') else '' end;
  v_who := coalesce(nullif(btrim(p_c.party_name), ''), 'the responsible person');
  select q.code into v_code from public.quotes q where q.id = p_c.quote_id;
  v := case p_event
    when 'confirmed'   then chr(128666) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' on the way, due ' || public._dl241_hm(coalesce(p_c.eta_at, p_c.due_at), p_c.org_id)
    when 'arrived'     then chr(9989) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' arrived ' || public._dl241_hm(now(), p_c.org_id)
    when 'delayed'     then chr(9888) || chr(65039) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' delayed'
                            || coalesce(': ' || v_note, '') || coalesce(', new ETA ' || public._dl241_hm(p_c.eta_at, p_c.org_id), '')
    when 'issue'       then chr(10071) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' problem' || coalesce(': ' || v_note, '')
    when 'cancelled'   then chr(10006) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' cancelled'
    when 'no_response' then chr(9200) || ' No response from ' || v_who || ' for ' || v_what || ' (due '
                            || public._dl241_hm(coalesce(p_c.eta_at, p_c.due_at), p_c.org_id) || ')'
    else chr(128230) || ' ' || v_what || ' (' || v_who || ') ' || chr(8212) || ' ' || coalesce(p_event, 'updated') end;
  if p_event in ('confirmed', 'arrived') and v_note is not null then v := v || ' - ' || v_note; end if;
  if nullif(btrim(coalesce(p_by, '')), '') is not null then v := v || ' (by ' || btrim(p_by) || ')'; end if;
  if v_code is not null then v := v || ' ' || chr(183) || ' ' || v_code; end if;
  return left(v, 600);
end $$;

-- after a reply / status change / missed reply: post into the event's team chat group (or the group the studio
-- picked) as Helm (system message, @mentions the admins + the person who scheduled it + the
-- studio's coordinators / managers who are in that group) and drop a bell row (listing every coordinator / manager).
-- Only while the studio switched delivery reminders on. Never blocks the caller (errors are swallowed).
create or replace function public._dl241_announce(p_id uuid, p_event text, p_note text, p_by text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare c public.delivery_commitments; s public.delivery_settings; v_txt text; v_conv uuid; v_ment jsonb; v_ops jsonb; v_done boolean := false;
begin
  select * into c from public.delivery_commitments d where d.id = p_id;
  if c.id is null then return false; end if;
  select * into s from public.delivery_settings x where x.org_id = c.org_id;
  if s.org_id is null or not s.enabled then return false; end if;
  if exists (select 1 from public.quotes q where q.id = c.quote_id and q.is_demo) then return false; end if;
  v_txt := public._dl241_update_text(c, p_event, p_note, p_by);
  if s.chat_post then
    begin
      select x.id into v_conv from public.chat_conversations x
       where x.id = s.chat_conversation_id and x.org_id = c.org_id and x.kind in ('group', 'broadcast');
      if v_conv is null then
        select x.id into v_conv from public.chat_conversations x where x.quote_id = c.quote_id and x.org_id = c.org_id and x.kind = 'group'
         order by x.created_at limit 1;
      end if;
      if v_conv is not null then
        select coalesce(jsonb_agg(to_jsonb(u.id)), '[]'::jsonb) into v_ment
          from (select p.id from public.profiles p where p.org_id = c.org_id and p.role = 'admin'
                union select c.created_by where c.created_by is not null
                -- r21: event coordinators + managers of the same studio, only when they are in the group
                union select p.id from public.profiles p
                       join public.chat_members m on m.conversation_id = v_conv and m.user_id = p.id and m.org_id = c.org_id
                      where p.org_id = c.org_id and p.role in ('coordinator', 'manager')) u;
        insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
          values (v_conv, c.org_id, null, 'system', v_txt,
                  case when jsonb_array_length(v_ment) > 0 then jsonb_build_object('mentions', v_ment, 'delivery_id', c.id) else jsonb_build_object('delivery_id', c.id) end);
        begin update public.chat_conversations set last_message_at = now() where id = v_conv; exception when others then null; end;
        v_done := true;
      end if;
    exception when others then raise warning 'delivery-0241: chat post skipped (%)', sqlstate;
    end;
  end if;
  if s.notify_bell then
    begin
      select coalesce(jsonb_agg(to_jsonb(p.id) order by p.id), '[]'::jsonb) into v_ops
        from public.profiles p where p.org_id = c.org_id and p.role in ('coordinator', 'manager');
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (c.quote_id, 'in_app', 'event_reminder', 'simulated',
                jsonb_build_object('label', v_txt, 'via', 'comms', 'source', '0241', 'delivery_id', c.id, 'event', p_event,
                                   'notify', v_ops), c.org_id);
      v_done := true;
    exception when others then raise warning 'delivery-0241: bell row skipped (%)', sqlstate;
    end;
  end if;
  return v_done;
end $$;

-- ---- 3) settings (Control Center) -------------------------------------------------------------------------------
create or replace function public.delivery_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  -- delivery-reminders-0241: the board (deliveries view) and Control Center (controls view) read this
  if auth.uid() is null or v_org is null or not (public._dl241_can('view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._dl241_cfg(v_org) || jsonb_build_object('timezone', public._dl241_tz(v_org),
    'can_manage', public.has_area('controls', 'edit'),
    'can_schedule', public._dl241_can('edit'),
    'trial_email', case when coalesce(public._tb179_no_send(v_org), false) then coalesce(public._tr212_email_ok(v_org), false) else null end,
    -- the studio's own (non-event) chat groups + the broadcast channel, for "post updates into ..." (titles only)
    'groups', case when public.has_area('controls', 'view') then coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.title, 'Group'), 'kind', c.kind)
                 order by c.kind desc, c.title) from public.chat_conversations c
               where c.org_id = v_org and c.kind in ('group', 'broadcast') and c.quote_id is null), '[]'::jsonb) else '[]'::jsonb end);
end $$;

create or replace function public.delivery_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; v_off integer[]; v_kinds text[]; v_conv uuid;
begin
  -- delivery-reminders-0241: Control Center EDIT only (admin / whoever the studio gave Control Center edit)
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('enabled', 'offsets', 'ping_kinds', 'cc_creator', 'chat_post', 'chat_conversation_id', 'notify_bell', 'no_response_alert') then
      raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  if p ? 'chat_conversation_id' and jsonb_typeof(p -> 'chat_conversation_id') <> 'null' and nullif(p ->> 'chat_conversation_id', '') is not null then
    begin v_conv := (p ->> 'chat_conversation_id')::uuid; exception when others then raise exception 'bad chat group' using errcode = '22023'; end;
    -- only one of this studio's own non-event groups / the broadcast channel
    if not exists (select 1 from public.chat_conversations c where c.id = v_conv and c.org_id = v_org and c.kind in ('group', 'broadcast') and c.quote_id is null) then
      raise exception 'chat group not found' using errcode = 'P0002'; end if;
  end if;
  foreach k in array array['enabled', 'cc_creator', 'chat_post', 'notify_bell', 'no_response_alert'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
  end loop;
  if p ? 'offsets' then
    if jsonb_typeof(p -> 'offsets') <> 'array' or jsonb_array_length(p -> 'offsets') not between 1 and 6
       or exists (select 1 from jsonb_array_elements(p -> 'offsets') e where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,4}$' or (e #>> '{}')::int > 1440) then
      raise exception 'reminder times must be 1 to 6 whole minutes between 0 and 1440' using errcode = '22023'; end if;
    v_off := array(select distinct (e #>> '{}')::int from jsonb_array_elements(p -> 'offsets') e order by 1 desc);
  end if;
  if p ? 'ping_kinds' then
    if jsonb_typeof(p -> 'ping_kinds') <> 'array'
       or exists (select 1 from jsonb_array_elements(p -> 'ping_kinds') e where jsonb_typeof(e) <> 'string' or (e #>> '{}') not in ('vendor', 'staff', 'user', 'other')) then
      raise exception 'ping_kinds must list vendor / staff / user / other' using errcode = '22023'; end if;
    v_kinds := array(select distinct e #>> '{}' from jsonb_array_elements(p -> 'ping_kinds') e);
  end if;
  insert into public.delivery_settings(org_id) values (v_org) on conflict (org_id) do nothing;
  update public.delivery_settings s set
    enabled    = case when p ? 'enabled' then (p ->> 'enabled')::boolean else s.enabled end,
    offsets    = coalesce(v_off, s.offsets),
    ping_kinds = coalesce(v_kinds, s.ping_kinds),
    cc_creator = case when p ? 'cc_creator' then (p ->> 'cc_creator')::boolean else s.cc_creator end,
    chat_post  = case when p ? 'chat_post' then (p ->> 'chat_post')::boolean else s.chat_post end,
    chat_conversation_id = case when p ? 'chat_conversation_id' then v_conv else s.chat_conversation_id end,
    notify_bell = case when p ? 'notify_bell' then (p ->> 'notify_bell')::boolean else s.notify_bell end,
    no_response_alert = case when p ? 'no_response_alert' then (p ->> 'no_response_alert')::boolean else s.no_response_alert end,
    updated_at = now(), updated_by = v_me
   where s.org_id = v_org;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'delivery_settings.set', 'delivery_settings', v_org::text, p, v_org);
  exception when others then raise warning 'delivery-0241: audit skipped (%)', sqlstate;
  end;
  return public._dl241_cfg(v_org);
end $$;

-- ---- 4) the board (signed-in, own studio, 'deliveries' area) ---------------------------------------------------
-- create (p.id absent) or change (p.id given) one delivery / arrival
create or replace function public.delivery_save(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.delivery_commitments; v_id uuid;
  v_quote uuid; v_kind text; v_vendor uuid; v_crew uuid; v_user uuid; v_name text; v_email text; v_due timestamptz;
  v_qty numeric; v_what text; v_note text; v_src text; v_rem boolean; v_old_due timestamptz; k text; v_off integer[]; v_off_set boolean := false;
begin
  if v_me is null or v_org is null or not public._dl241_can('edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'delivery must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('id', 'quote_id', 'what', 'qty', 'party_kind', 'vendor_id', 'crew_id', 'user_id', 'party_name', 'contact_email',
                 'due_at', 'note', 'source', 'booking_id', 'reminders_on', 'offsets') then
      raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  if nullif(p ->> 'id', '') is not null then
    begin v_id := (p ->> 'id')::uuid; exception when others then raise exception 'bad id' using errcode = '22023'; end;
    select * into c from public.delivery_commitments d where d.id = v_id and d.org_id = v_org for update;
    if c.id is null then raise exception 'delivery not found' using errcode = 'P0002'; end if;
    if c.status = 'cancelled' then raise exception 'this delivery was cancelled' using errcode = '22023'; end if;
  end if;
  -- event: own studio, live
  begin v_quote := coalesce(nullif(p ->> 'quote_id', '')::uuid, c.quote_id); exception when others then raise exception 'bad event' using errcode = '22023'; end;
  if v_quote is null or not exists (select 1 from public.quotes q where q.id = v_quote and q.org_id = v_org and q.deleted_at is null) then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  if c.id is not null and v_quote <> c.quote_id then raise exception 'a delivery cannot move to another event' using errcode = '22023'; end if;
  v_what := btrim(coalesce(p ->> 'what', c.what, ''));
  if char_length(v_what) not between 1 and 200 or v_what ~ '[<>]' then raise exception 'say what is delivered (1-200 characters, no < or >)' using errcode = '22023'; end if;
  if p ? 'qty' and jsonb_typeof(p -> 'qty') <> 'null' then
    if jsonb_typeof(p -> 'qty') <> 'number' or (p ->> 'qty')::numeric <= 0 or (p ->> 'qty')::numeric > 1000000 then
      raise exception 'quantity must be a number above 0' using errcode = '22023'; end if;
    v_qty := (p ->> 'qty')::numeric;
  elsif p ? 'qty' then v_qty := null; else v_qty := c.qty; end if;
  v_kind := coalesce(nullif(p ->> 'party_kind', ''), c.party_kind, 'vendor');
  if v_kind not in ('vendor', 'staff', 'user', 'other') then raise exception 'unknown kind of person' using errcode = '22023'; end if;
  v_name := nullif(btrim(coalesce(p ->> 'party_name', case when p ? 'party_name' then '' else c.party_name end, '')), '');
  v_email := nullif(lower(btrim(coalesce(p ->> 'contact_email', case when p ? 'contact_email' then '' else c.contact_email end, ''))), '');
  -- the responsible person must belong to this studio; their saved e-mail is the default
  if v_kind = 'vendor' then
    begin v_vendor := coalesce(nullif(p ->> 'vendor_id', '')::uuid, case when p ? 'vendor_id' then null else c.vendor_id end); exception when others then raise exception 'bad vendor' using errcode = '22023'; end;
    if v_vendor is not null then
      if not exists (select 1 from public.vendors v where v.id = v_vendor and v.org_id = v_org) then raise exception 'vendor not found' using errcode = 'P0002'; end if;
      select coalesce(v_name, v.name), coalesce(v_email, nullif(lower(btrim(v.email)), '')) into v_name, v_email from public.vendors v where v.id = v_vendor;
    end if;
  elsif v_kind = 'staff' then
    begin v_crew := coalesce(nullif(p ->> 'crew_id', '')::uuid, case when p ? 'crew_id' then null else c.crew_id end); exception when others then raise exception 'bad staff member' using errcode = '22023'; end;
    if v_crew is not null then
      if not exists (select 1 from public.crew_members m where m.id = v_crew and m.org_id = v_org) then raise exception 'staff member not found' using errcode = 'P0002'; end if;
      select coalesce(v_name, m.name), coalesce(v_email, nullif(lower(btrim(m.email)), '')) into v_name, v_email from public.crew_members m where m.id = v_crew;
    end if;
  elsif v_kind = 'user' then
    begin v_user := coalesce(nullif(p ->> 'user_id', '')::uuid, case when p ? 'user_id' then null else c.user_id end); exception when others then raise exception 'bad user' using errcode = '22023'; end;
    if v_user is not null then
      if not exists (select 1 from public.profiles u where u.id = v_user and u.org_id = v_org) then raise exception 'user not found' using errcode = 'P0002'; end if;
      select coalesce(v_name, nullif(btrim(u.full_name), ''), u.email), coalesce(v_email, nullif(lower(btrim(u.email)), '')) into v_name, v_email from public.profiles u where u.id = v_user;
    end if;
  end if;
  if v_name is null and v_vendor is null and v_crew is null and v_user is null then raise exception 'say who is responsible' using errcode = '22023'; end if;
  v_name := left(v_name, 120);
  if v_name ~ '[<>]' then raise exception 'name may not contain < or >' using errcode = '22023'; end if;
  if v_email is not null and not public._dl241_email_ok(v_email) then raise exception 'enter a valid e-mail address' using errcode = '22023'; end if;
  begin v_due := coalesce(nullif(p ->> 'due_at', '')::timestamptz, c.due_at); exception when others then raise exception 'enter the due date and time' using errcode = '22023'; end;
  if v_due is null then raise exception 'enter the due date and time' using errcode = '22023'; end if;
  if v_due > now() + interval '400 days' or v_due < now() - interval '30 days' then raise exception 'the due time must be within the next 400 days' using errcode = '22023'; end if;
  v_note := case when p ? 'note' then nullif(btrim(coalesce(p ->> 'note', '')), '') else c.note end;
  if char_length(coalesce(v_note, '')) > 500 or coalesce(v_note, '') ~ '[<>]' then raise exception 'note: up to 500 characters, no < or >' using errcode = '22023'; end if;
  v_src := coalesce(nullif(p ->> 'source', ''), c.source, 'manual');
  if v_src not in ('manual', 'shortage', 'resource', 'command') then raise exception 'unknown source' using errcode = '22023'; end if;
  if p ? 'reminders_on' and jsonb_typeof(p -> 'reminders_on') <> 'boolean' then raise exception 'reminders_on must be true or false' using errcode = '22023'; end if;
  v_rem := case when p ? 'reminders_on' then (p ->> 'reminders_on')::boolean else coalesce(c.reminders_on, true) end;
  -- this assignment's own reminder times (minutes before; [] = no reminders; null / absent = the studio default)
  if p ? 'offsets' then
    v_off_set := true;
    if jsonb_typeof(p -> 'offsets') = 'null' then v_off := null;
    elsif jsonb_typeof(p -> 'offsets') <> 'array' or jsonb_array_length(p -> 'offsets') > 6
       or exists (select 1 from jsonb_array_elements(p -> 'offsets') e where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,4}$' or (e #>> '{}')::int > 1440) then
      raise exception 'reminders: up to 6 times, each 0 to 1440 minutes before' using errcode = '22023';
    else v_off := array(select distinct (e #>> '{}')::int from jsonb_array_elements(p -> 'offsets') e order by 1 desc);
    end if;
  end if;

  if c.id is null then
    insert into public.delivery_commitments(org_id, quote_id, what, qty, party_kind, vendor_id, crew_id, user_id, party_name, contact_email,
        due_at, note, source, booking_id, reminders_on, offsets, status_by, created_by)
      values (v_org, v_quote, v_what, v_qty, v_kind, v_vendor, v_crew, v_user, v_name, v_email, v_due, v_note, v_src,
        case when nullif(p ->> 'booking_id', '') ~* '^[0-9a-f-]{36}$'
              and exists (select 1 from public.event_resources r where r.id = (p ->> 'booking_id')::uuid and r.org_id = v_org and r.quote_id = v_quote)
             then (p ->> 'booking_id')::uuid end,
        v_rem, v_off, public._dl241_actor_label(v_me), v_me)
      returning * into c;
    perform public._dl241_log(c.id, v_org, 'scheduled', v_note, null, 'user', v_me, public._dl241_actor_label(v_me));
  else
    v_old_due := c.due_at;
    update public.delivery_commitments d set what = v_what, qty = v_qty, party_kind = v_kind, vendor_id = v_vendor, crew_id = v_crew, user_id = v_user,
        party_name = v_name, contact_email = v_email, due_at = v_due, note = v_note, reminders_on = v_rem, updated_at = now(),
        offsets = case when v_off_set then v_off else d.offsets end,
        no_response_at = case when v_due is distinct from v_old_due then null else d.no_response_at end,
        -- a new due time starts the reminders again (an old ETA no longer applies)
        eta_at = case when v_due is distinct from v_old_due then null else d.eta_at end,
        status = case when v_due is distinct from v_old_due and d.status in ('reminded', 'delayed') then 'scheduled' else d.status end
      where d.id = c.id returning * into c;
    perform public._dl241_log(c.id, v_org, 'edited',
      case when v_due is distinct from v_old_due then 'Due time changed to ' || public._dl241_when(v_due, v_org) else null end,
      null, 'user', v_me, public._dl241_actor_label(v_me));
  end if;
  return public._dl241_row(c);
end $$;

-- a studio member sets the status (Arrived, On the way, Delayed + new time, Problem, Cancelled, back to Scheduled)
create or replace function public.delivery_set_status(p_id uuid, p_status text, p_note text default null, p_eta timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.delivery_commitments; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_me is null or v_org is null or not public._dl241_can('edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_status is null or p_status not in ('scheduled', 'confirmed', 'arrived', 'delayed', 'issue', 'cancelled') then raise exception 'unknown status' using errcode = '22023'; end if;
  if char_length(coalesce(v_note, '')) > 500 or coalesce(v_note, '') ~ '[<>]' then raise exception 'note: up to 500 characters, no < or >' using errcode = '22023'; end if;
  if p_eta is not null and (p_status <> 'delayed' or p_eta > now() + interval '30 days' or p_eta < now() - interval '1 day') then
    raise exception 'a new time is only for Delayed, within 30 days' using errcode = '22023'; end if;
  select * into c from public.delivery_commitments d where d.id = p_id and d.org_id = v_org for update;
  if c.id is null then raise exception 'delivery not found' using errcode = 'P0002'; end if;
  if c.status = 'cancelled' and p_status <> 'scheduled' then raise exception 'this delivery was cancelled' using errcode = '22023'; end if;
  update public.delivery_commitments d set status = p_status, status_at = now(), status_by = public._dl241_actor_label(v_me), updated_at = now(),
      eta_at = case when p_status = 'delayed' then coalesce(p_eta, d.eta_at) when p_status = 'scheduled' then null else d.eta_at end,
      note = coalesce(v_note, d.note),
      no_response_at = case when p_status = 'scheduled' then null else d.no_response_at end
    where d.id = c.id returning * into c;
  perform public._dl241_log(c.id, v_org, p_status, v_note, case when p_status = 'delayed' then c.eta_at end, 'user', v_me, public._dl241_actor_label(v_me));
  if p_status <> 'scheduled' then perform public._dl241_announce(c.id, p_status, v_note, public._dl241_actor_label(v_me)); end if;
  return public._dl241_row(c);
end $$;

-- the board: one event (p_quote) or every delivery due between p_from and p_to (default: the last day + next 7 days)
create or replace function public.delivery_list(p_quote uuid default null, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public._dl241_can('view') then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public._dl241_row(d) order by d.due_at, d.created_at)
    from public.delivery_commitments d
    join public.quotes q on q.id = d.quote_id and q.org_id = v_org and q.deleted_at is null
   where d.org_id = v_org
     and (case when p_quote is not null then d.quote_id = p_quote
               else d.due_at between coalesce(p_from, now() - interval '1 day') and coalesce(p_to, now() + interval '7 days') end)
     and d.due_at between coalesce(p_from, '-infinity'::timestamptz) and coalesce(p_to, 'infinity'::timestamptz)), '[]'::jsonb);
end $$;

create or replace function public.delivery_history(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public._dl241_can('view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.delivery_commitments d where d.id = p_id and d.org_id = v_org) then raise exception 'delivery not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'at_text', public._dl241_when(l.at, v_org), 'status', l.status, 'note', l.note,
              'eta_text', public._dl241_when(l.eta_at, v_org), 'actor_kind', l.actor_kind, 'actor', l.actor_label) order by l.at desc)
       from public.delivery_commitment_log l where l.commitment_id = p_id and l.org_id = v_org), '[]'::jsonb),
    'reminders', coalesce((select jsonb_agg(jsonb_build_object('offset_min', s.offset_min, 'to', s.recipient_kind, 'status', s.status,
              'reason', s.reason, 'at_text', public._dl241_when(coalesce(s.sent_at, s.created_at), v_org)) order by s.created_at desc)
       from public.delivery_reminder_sends s where s.commitment_id = p_id and s.org_id = v_org), '[]'::jsonb));
end $$;

-- a fresh status link for the board's "Copy status link" (the raw token is shown once; only its hash is kept)
create or replace function public.delivery_link_issue(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.delivery_commitments; v_tok text; v_exp timestamptz;
begin
  if v_me is null or v_org is null or not public._dl241_can('edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  select * into c from public.delivery_commitments d where d.id = p_id and d.org_id = v_org;
  if c.id is null then raise exception 'delivery not found' using errcode = 'P0002'; end if;
  if c.status = 'cancelled' then raise exception 'this delivery was cancelled' using errcode = '22023'; end if;
  if public.rate_hit('delivery_link_issue', v_me::text, 3600, 60) > 0 then raise exception 'Too many links - try again later' using errcode = '54000'; end if;
  v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := least(greatest(coalesce(c.eta_at, c.due_at) + interval '24 hours', now() + interval '12 hours'), now() + interval '14 days');
  insert into public.delivery_links(token_hash, commitment_id, org_id, issued_via, expires_at)
    values (encode(pg_catalog.sha256(convert_to(v_tok, 'UTF8')), 'hex'), c.id, v_org, 'copy', v_exp);
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'expires_text', public._dl241_when(v_exp, v_org));
end $$;

-- ---- 5) the status link page (signed out: the 64-hex token is the only key) -------------------------------------
create or replace function public._dl241_link(p_token text)
returns public.delivery_links language plpgsql stable security definer set search_path = '' as $$
declare l public.delivery_links;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into l from public.delivery_links x where x.token_hash = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex') and x.expires_at > now();
  return l;
end $$;

create or replace function public._dl241_public(p_c public.delivery_commitments)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- only what the responsible person needs: no money, no client, no other delivery
  select jsonb_build_object('ok', true, 'what', p_c.what, 'qty', p_c.qty, 'party_name', p_c.party_name, 'status', p_c.status,
    'due_text', public._dl241_when(p_c.due_at, p_c.org_id), 'eta_text', public._dl241_when(p_c.eta_at, p_c.org_id),
    'timezone', public._dl241_tz(p_c.org_id),
    'event', (select coalesce(nullif(btrim(q.title), ''), 'the event') from public.quotes q where q.id = p_c.quote_id),
    'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = p_c.quote_id),
    'venue', (select left(nullif(btrim(ep.venue_name), ''), 160) from public.event_plan ep where ep.quote_id = p_c.quote_id limit 1),
    'studio', (select o.name from public.organizations o where o.id = p_c.org_id),
    'can_update', p_c.status <> 'cancelled' and not coalesce(public._trial_locked(p_c.org_id), false));
$$;

create or replace function public.delivery_link_get(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.delivery_links; c public.delivery_commitments;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('delivery_link_get', left(p_token, 32), 600, 120) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._dl241_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  select * into c from public.delivery_commitments d where d.id = l.commitment_id and d.org_id = l.org_id;
  if c.id is null then return jsonb_build_object('ok', false); end if;
  return public._dl241_public(c);
end $$;

create or replace function public.delivery_link_update(p_token text, p_status text, p_note text default null, p_eta timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.delivery_links; c public.delivery_commitments; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_label text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('delivery_link_update', left(p_token, 32), 600, 12) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._dl241_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  if p_status is null or p_status not in ('confirmed', 'arrived', 'delayed', 'issue') then raise exception 'unknown status' using errcode = '22023'; end if;
  if char_length(coalesce(v_note, '')) > 300 or coalesce(v_note, '') ~ '[<>]' then raise exception 'note: up to 300 characters, no < or >' using errcode = '22023'; end if;
  if p_eta is not null and (p_status <> 'delayed' or p_eta > now() + interval '7 days' or p_eta < now() - interval '1 hour') then
    raise exception 'a new time is only for Delayed, within 7 days' using errcode = '22023'; end if;
  if p_status = 'issue' and v_note is null then raise exception 'say what the problem is' using errcode = '22023'; end if;
  select * into c from public.delivery_commitments d where d.id = l.commitment_id and d.org_id = l.org_id for update;
  if c.id is null then return jsonb_build_object('ok', false); end if;
  if c.status = 'cancelled' or coalesce(public._trial_locked(c.org_id), false) then
    return public._dl241_public(c) || jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  v_label := left(coalesce(c.party_name, 'Status link') || ' (status link)', 160);
  update public.delivery_commitments d set status = p_status, status_at = now(), status_by = v_label, updated_at = now(),
      eta_at = case when p_status = 'delayed' then coalesce(p_eta, d.eta_at) else d.eta_at end
    where d.id = c.id returning * into c;
  update public.delivery_links x set uses = x.uses + 1, last_used_at = now() where x.token_hash = l.token_hash;
  perform public._dl241_log(c.id, c.org_id, p_status, v_note, case when p_status = 'delayed' then c.eta_at end, 'link', null, v_label);
  perform public._dl241_announce(c.id, p_status, v_note, null);
  return public._dl241_public(c);
end $$;

-- ---- 6) the scheduler (pg_cron / service role) -----------------------------------------------------------------
create or replace function public.delivery_reminders_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_off integer; v_t timestamptz; v_fire timestamptz; v_to text; v_kind text; v_key text; v_id uuid; v_block text;
  v_n integer := 0; v_skip integer := 0; v_cc text; v_nr integer := 0; v_offs integer[];
begin
  -- delivery-reminders-0241: service role / pg_cron only
  for r in
    select d.*, s.offsets as s_offsets, s.ping_kinds, s.cc_creator, s.no_response_alert, q.is_demo as q_demo
      from public.delivery_commitments d
      join public.delivery_settings s on s.org_id = d.org_id and s.enabled
      join public.quotes q on q.id = d.quote_id and q.org_id = d.org_id
     where d.status in ('scheduled', 'reminded', 'delayed') and d.reminders_on
       and q.deleted_at is null and q.status <> 'cancelled'
       and coalesce(d.eta_at, d.due_at) between now() - interval '3 hours' and now() + interval '1465 minutes'
  loop
    begin
      v_t := coalesce(r.eta_at, r.due_at);
      -- the assignment's own reminder times, else the studio default
      v_offs := coalesce(r.offsets, r.s_offsets);
      foreach v_off in array coalesce(v_offs, '{}'::integer[]) loop
        v_fire := v_t - make_interval(mins => v_off);
        if now() < v_fire or now() >= v_fire + interval '20 minutes' then continue; end if;
        v_cc := (select lower(btrim(p.email)) from public.profiles p where p.id = r.created_by and p.org_id = r.org_id);
        foreach v_kind in array array['party', 'cc'] loop
          v_to := case when v_kind = 'party' then case when r.party_kind = any (r.ping_kinds) then r.contact_email end
                       else case when r.cc_creator and v_cc is distinct from lower(coalesce(r.contact_email, '')) then v_cc end end;
          if v_to is null or not public._dl241_email_ok(v_to) then continue; end if;
          v_key := 'dl:' || r.id || ':' || floor(extract(epoch from v_t))::bigint || ':' || v_off || ':' || v_kind;
          v_id := null;
          insert into public.delivery_reminder_sends(org_id, commitment_id, offset_min, recipient_kind, recipient, dedupe_key)
            values (r.org_id, r.id, v_off, v_kind, v_to, v_key)
            on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is null then continue; end if;
          v_block := case when r.q_demo then 'sample_event' else public._dl241_send_block(r.org_id, v_to, true) end;
          if v_block is not null then
            update public.delivery_reminder_sends set status = 'skipped', reason = v_block, sent_at = now() where id = v_id;
            v_skip := v_skip + 1;
          else
            -- a trial reminder holds its slot from now on (counted by _dl241_trial_take)
            update public.delivery_reminder_sends set trial_slot = coalesce(public._tb179_no_send(r.org_id), false) where id = v_id;
            v_n := v_n + 1;
          end if;
        end loop;
      end loop;
      if r.status = 'scheduled' and exists (select 1 from public.delivery_reminder_sends s where s.commitment_id = r.id and s.status in ('pending', 'sent')) then
        update public.delivery_commitments set status = 'reminded', status_at = now(), status_by = 'Helm (automatic reminder)' where id = r.id and status = 'scheduled';
        perform public._dl241_log(r.id, r.org_id, 'reminded', null, null, 'system', null, 'Helm (automatic reminder)');
      end if;
      -- no answer 15 minutes after the due time (or the promised new time) although they were reminded:
      -- tell the admins + the team (chat group + bell), once per due time
      if r.no_response_alert and r.status in ('scheduled', 'reminded', 'delayed') and r.no_response_at is null
         and now() >= v_t + interval '15 minutes'
         and exists (select 1 from public.delivery_reminder_sends s where s.commitment_id = r.id and s.recipient_kind = 'party' and s.status in ('sent', 'pending'))
         and not exists (select 1 from public.delivery_commitment_log l where l.commitment_id = r.id and l.actor_kind = 'link'
                           and l.at >= coalesce((select min(s.created_at) from public.delivery_reminder_sends s where s.commitment_id = r.id
                                                    and floor(extract(epoch from v_t))::bigint::text = split_part(s.dedupe_key, ':', 3)), r.created_at)) then
        update public.delivery_commitments set no_response_at = now() where id = r.id and no_response_at is null;
        perform public._dl241_log(r.id, r.org_id, 'no_response', null, null, 'system', null, 'Helm (no reply)');
        perform public._dl241_announce(r.id, 'no_response', null, null);
        v_nr := v_nr + 1;
      end if;
    exception when others then raise warning 'delivery-0241: tick skipped one delivery (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('queued', v_n, 'skipped', v_skip, 'no_response', v_nr);
end $$;

-- the dispatcher (comms-dispatch, service role) takes the due e-mails; each is re-checked and gets a fresh link
create or replace function public.delivery_reminder_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_tok text; v_exp timestamptz; v_ident jsonb;
begin
  update public.delivery_reminder_sends set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.delivery_reminder_sends set status = 'skipped', reason = 'stale', sent_at = now() where sent_at is null and created_at < now() - interval '2 hours';
  for r in select s.*, d.status as d_status, d.quote_id, d.what, d.qty, d.party_name, d.due_at, d.eta_at, d.org_id as d_org, d.reminders_on
             from public.delivery_reminder_sends s join public.delivery_commitments d on d.id = s.commitment_id and d.org_id = s.org_id
            where s.sent_at is null and s.status = 'pending' and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes')
            order by s.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of s skip locked
  loop
    v_ok := r.d_status in ('scheduled', 'reminded', 'delayed') and r.reminders_on
        and coalesce((select x.enabled from public.delivery_settings x where x.org_id = r.org_id), false)
        and exists (select 1 from public.quotes q where q.id = r.quote_id and q.deleted_at is null and q.status <> 'cancelled' and not q.is_demo)
        and public._dl241_send_block(r.org_id, r.recipient, false) is null
        -- a trial e-mail must have taken its slot when it was queued (and the studio is still on an active trial)
        and (not coalesce(public._tb179_no_send(r.org_id), false) or r.trial_slot);
    if not coalesce(v_ok, false) then
      update public.delivery_reminder_sends set status = 'skipped', reason = 'recheck', sent_at = now() where id = r.id;
      continue;
    end if;
    v_tok := null;
    if r.recipient_kind = 'party' then
      v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
      v_exp := least(greatest(coalesce(r.eta_at, r.due_at) + interval '24 hours', now() + interval '12 hours'), now() + interval '14 days');
      insert into public.delivery_links(token_hash, commitment_id, org_id, issued_via, expires_at)
        values (encode(pg_catalog.sha256(convert_to(v_tok, 'UTF8')), 'hex'), r.commitment_id, r.org_id, 'email', v_exp);
    end if;
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.delivery_reminder_sends set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', r.recipient, 'kind', r.recipient_kind, 'offset_min', r.offset_min,
      'what', r.what, 'qty', r.qty, 'party_name', r.party_name, 'status', r.d_status,
      'due_text', public._dl241_when(coalesce(r.eta_at, r.due_at), r.org_id),
      'event', (select coalesce(nullif(btrim(q.title), ''), 'the event') from public.quotes q where q.id = r.quote_id),
      'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id),
      'quote_id', r.quote_id,
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'token', v_tok, 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

create or replace function public.delivery_reminder_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.delivery_reminder_sends set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.delivery_reminder_sends set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 7) grants -------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal helpers + service-role entry points: no app grants
  foreach f in array array['public._dl241_can(text)', 'public._dl241_cfg(uuid)', 'public._dl241_email_ok(text)', 'public._dl241_tz(uuid)',
      'public._dl241_when(timestamptz, uuid)', 'public._dl241_send_block(uuid, text, boolean)', 'public._dl241_actor_label(uuid)',
      'public._dl241_log(uuid, uuid, text, text, timestamptz, text, uuid, text)', 'public._dl241_row(public.delivery_commitments)',
      'public._dl241_link(text)', 'public._dl241_public(public.delivery_commitments)',
      'public._dl241_hm(timestamptz, uuid)', 'public._dl241_trial_take(uuid, text)', 'public._dl241_update_text(public.delivery_commitments, text, text, text)',
      'public._dl241_announce(uuid, text, text, text)',
      'public.delivery_reminders_tick()', 'public.delivery_reminder_claim(integer)', 'public.delivery_reminder_mark(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.delivery_reminders_tick() to service_role;
    grant execute on function public.delivery_reminder_claim(integer) to service_role;
    grant execute on function public.delivery_reminder_mark(uuid, text) to service_role;
  end if;
  -- the app (signed in; each RPC checks the studio + area itself)
  foreach f in array array['public.delivery_settings_get()', 'public.delivery_settings_set(jsonb)', 'public.delivery_save(jsonb)',
      'public.delivery_set_status(uuid, text, text, timestamptz)', 'public.delivery_list(uuid, timestamptz, timestamptz)',
      'public.delivery_history(uuid)', 'public.delivery_link_issue(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the signed-out status link page
  foreach f in array array['public.delivery_link_get(text)', 'public.delivery_link_update(text, text, text, timestamptz)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 8) trial retention (0184) knows the new tables ------------------------------------------------------------
-- Patched in place, the way 0198 / 0201 / 0206 / 0212 add theirs (skipped when 0184 is not installed). The four
-- assignment tables are the event's own records (they already go with the quote: FK on delete cascade), so they
-- are classified with the quote, children first; delivery_settings is a studio setting (kept, like comms_settings).
-- Nothing is deleted by this file: the purge itself stays behind the owner switch (off by default).
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''delivery_commitments''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''quotes''', ''))) / length('''quotes''') <> 1 then
        raise notice '0241: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''quotes''', '''delivery_links'', ''delivery_reminder_sends'', ''delivery_commitment_log'', ''delivery_commitments'', ''quotes''');
      end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''delivery_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_settings''', ''))) / length('''comms_settings''') <> 1 then
        raise notice '0241: _tr184_keep_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''comms_settings''', '''comms_settings'', ''delivery_settings''');
      end if;
    end if;
  end if;
end $$;

-- ---- 9) pg_cron, ONLY if it is already installed (never created here) -----------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_delivery_reminders') then
        perform cron.schedule('helm_delivery_reminders', '*/5 * * * *', 'select public.delivery_reminders_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_delivery_reminders could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 five tables exist with RLS on and no anon / signed-in table privilege',
     (select count(*) from pg_class c where c.oid in (to_regclass('public.delivery_settings'), to_regclass('public.delivery_commitments'),
        to_regclass('public.delivery_commitment_log'), to_regclass('public.delivery_reminder_sends'), to_regclass('public.delivery_links')) and c.relrowsecurity) = 5
     and not has_table_privilege('authenticated', 'public.delivery_commitments', 'select')
     and not has_table_privilege('anon', 'public.delivery_links', 'select')),
  ('02 no studio switched on by this file (reminders OFF until an admin saves the setting)',
     not exists (select 1 from public.delivery_settings where enabled)),
  ('03 deliveries access falls back to the Event-day command switch (no role_access row needed)',
     position('has_area(''command''' in (select prosrc from pg_proc where oid = to_regprocedure('public._dl241_can(text)'))) > 0),
  ('04 app RPCs signed-in only; the 2 link RPCs also anon; tick / claim / mark service role only',
     has_function_privilege('authenticated', 'public.delivery_save(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.delivery_save(jsonb)', 'execute')
     and has_function_privilege('anon', 'public.delivery_link_get(text)', 'execute')
     and has_function_privilege('anon', 'public.delivery_link_update(text,text,text,timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.delivery_reminders_tick()', 'execute')
     and not has_function_privilege('anon', 'public.delivery_reminder_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.delivery_reminder_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._dl241_announce(uuid,text,text,text)', 'execute')),
  ('05 scheduler, claim and mark functions exist',
     to_regprocedure('public.delivery_reminders_tick()') is not null and to_regprocedure('public.delivery_reminder_claim(integer)') is not null
     and to_regprocedure('public.delivery_reminder_mark(uuid,text)') is not null),
  ('06 pg_cron job helm_delivery_reminders scheduled (or pg_cron not installed - then schedule it by hand, see the owner steps)',
     case when to_regclass('cron.job') is null then true
          else position('<row>' in query_to_xml('select 1 from cron.job where jobname = ''helm_delivery_reminders''', false, false, '')::text) > 0 end),
  ('07 trial retention (0184) classifies the new tables (assignments purge with the quote, settings kept)',
     to_regprocedure('public._tr184_purge_tables()') is null
     or (public._tr184_purge_tables() @> array['delivery_links', 'delivery_reminder_sends', 'delivery_commitment_log', 'delivery_commitments']
         and 'delivery_settings' = any(public._tr184_keep_tables())))
) v(item, ok) order by item;
