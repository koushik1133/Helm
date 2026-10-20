-- APPLY-0269.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER everything up to APPLY-0260 (0132 assignment notify + 0241 delivery reminders must be in). Order-
-- independent of the other r23 / r24 files (0261-0268).
-- R24 automation (owner): (1) RUN-SHEET REMINDERS - each run-sheet line can name a real person (team member / staff /
-- vendor) as its owner; Helm reminds them before the line starts (studio default 15 min before + at the start, each
-- line can change its own time or switch it off): bell + e-mail (queued) for team members, WhatsApp (0132 queue) +
-- e-mail for staff and vendors, optionally a post in the event's team chat group. (2) One settings row per studio for
-- Control Center -> Automations. (3) A PUBLIC ENQUIRY FORM per studio at /<studio>/enquiry - every enquiry becomes a
-- lead (source "Enquiry form", New) + a bell notice + a queued instant thank-you e-mail. Off until an admin opens it.
-- 7 NEW nullable / defaulted columns on run_sheet_items, 3 NEW tables (RLS on, RPCs only), 1 guard trigger, new
-- functions, one pg_cron job (only when pg_cron is installed), the 0184 purge / keep lists patched in place. No
-- existing table / column / policy / row changed or deleted. Safe to run twice. ASCII only.
-- After this: deploy the site (runsheet.html, runsheet-remind.js, control.html, automations.js / .css, leads.html,
-- enquiry.html / .js / .css, store-api.js, vercel.json) and redeploy the edge function comms-dispatch (--no-verify-jwt).
begin;
-- 0269_r24_automation.sql - CANONICAL forward-only.
-- REQUIRES base run_sheet_items / leads / crew_members / vendors / notifications / work_tokens, 0020 (organizations.public_slug),
--          0016 + 0035 (chat event groups), 0041 (crew_members.profile_id), 0050 (rate_hit), 0078 (comms_settings),
--          0097 (quotes.is_demo), 0132 (assign_notify_outbox + _assign132_phone: the WhatsApp queue), 0179 (_tb179_no_send),
--          0183 (_trial_locked), 0241 (_dl241_tz / _dl241_email_ok: the r21 reminder engine helpers).
--
-- In plain words (owner, r24):
--   1  RUN-SHEET REMINDERS. "I expected the person on a run-sheet line to be reminded before it starts." Each run-sheet
--      line can now name a REAL person as its owner - a team member (has a Helm login), a staff member or a vendor -
--      or still a typed name. Each line has "Remind" (on by default when it has an owner), its own reminder time or the
--      studio default from Control Center (15 minutes before + at the start time), and "also post in the event group".
--      At each reminder time Helm (runsheet_reminders_tick, pg_cron every 5 minutes, only if pg_cron is installed):
--        * a team member (or a staff member linked to a login) gets a bell notification + an e-mail (QUEUED only -
--          sent later by the dormant comms-dispatch once e-mail is switched on);
--        * a staff member / vendor gets a WhatsApp message in the existing 0132 queue (with their own task link when
--          the office issued one; sent only when the studio's WhatsApp is switched on) + an e-mail when they have one;
--        * when "also post in the event group" is ticked, Helm posts the reminder in the event's team chat group.
--      Once per line + start time + reminder time + way (a UNIQUE key), never late (a slot missed by more than 20 minutes
--      is not sent), never for a cancelled / deleted / closed / sample event. Free trial: bell + chat only (no e-mail /
--      WhatsApp); the sample master never.
--   2  ONE SETTINGS ROW per studio (automation_settings): run-sheet reminders on / off (default ON), default times
--      (15 / 0), e-mail / WhatsApp on / off, and the public enquiry form (default OFF), its instant reply and the bell.
--      Control Center (controls EDIT) changes it; Control Center -> Automations lists every automation in one place.
--   3  LEADS TRACKED AUTOMATICALLY. A quote with a client already creates / links its lead (sync_quote_to_lead,
--      phase92 / 0199, unchanged). NEW: a public enquiry form per studio at /<studio>/enquiry. Signed out, a client
--      types name, phone or e-mail, event type, date, guests and a message and agrees to be contacted. Helm adds a
--      lead with source "Enquiry form" (status New) and a bell notice "New enquiry from ...", and QUEUES an instant
--      thank-you e-mail (the studio's own words) for the dormant comms-dispatch. Off until an admin switches it on.
--      Safe for the public: only the studio NAME is shown, nothing else is ever read back; rate-limited per network
--      (5 / hour), per studio (30 / hour) and per e-mail / phone (3 / day); a hidden "website" field catches bots
--      (silently ignored); a captcha token field is accepted for later (captcha-ready, see the notes on the RPC).
-- Changes: 7 NEW nullable / defaulted columns on run_sheet_items (owner_kind, owner_user_id, owner_crew_id,
-- owner_vendor_id, remind, remind_offsets, remind_group), 3 NEW tables (automation_settings, runsheet_reminder_sends,
-- lead_enquiries; RLS on, no anon / signed-in table privilege), 1 new guard trigger on run_sheet_items (a picked owner
-- must belong to the same studio), new functions only, 1 pg_cron job; inserts into notifications / chat_messages /
-- assign_notify_outbox / leads (new rows only). The 0184 trial purge / keep lists learn the new tables (patched in
-- place, the 0241 way). No existing column / row / policy changed or deleted. Additive + idempotent: safe to run twice.
-- ASCII only.
-- ROLLBACK (manual, only if ever needed): update public.automation_settings set runsheet_enabled = false, enquiry_enabled
-- = false (nothing more is queued / accepted) and select cron.unschedule('helm_runsheet_reminders'). Columns / tables can stay.

do $$ begin
  if to_regclass('public.run_sheet_items') is null or to_regclass('public.leads') is null or to_regclass('public.crew_members') is null
     or to_regclass('public.vendors') is null or to_regclass('public.notifications') is null or to_regclass('public.work_tokens') is null then
    raise exception 'STOP 0269: base tables (run_sheet_items / leads / crew_members / vendors / notifications / work_tokens) are missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'public_slug') then
    raise exception 'STOP 0269: 0020 (organizations.public_slug) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'crew_members' and column_name = 'profile_id') then
    raise exception 'STOP 0269: 0041 (crew_members.profile_id) is not applied'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0269: 0050 (rate_hit) is not applied'; end if;
  if to_regclass('public.assign_notify_outbox') is null or to_regprocedure('public._assign132_phone(text)') is null then
    raise exception 'STOP 0269: 0132 (assign_notify_outbox) is not applied'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0269: 0179 (_tb179_no_send) is not applied'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then raise exception 'STOP 0269: 0183 (_trial_locked) is not applied'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is null then raise exception 'STOP 0269: 0004 (tg_quote_org_match) is not applied'; end if;
  if to_regprocedure('public._dl241_tz(uuid)') is null or to_regprocedure('public._dl241_email_ok(text)') is null then
    raise exception 'STOP 0269: 0241 (delivery reminders) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'quote_id') then
    raise exception 'STOP 0269: 0035 (chat event groups) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'is_demo') then
    raise exception 'STOP 0269: 0097 (quotes.is_demo) is not applied'; end if;
end $$;

-- ---- 1) run-sheet line: a real owner + its reminder (new nullable / defaulted columns) --------------------------
alter table public.run_sheet_items add column if not exists owner_kind text;
alter table public.run_sheet_items add column if not exists owner_user_id uuid;
alter table public.run_sheet_items add column if not exists owner_crew_id uuid;
alter table public.run_sheet_items add column if not exists owner_vendor_id uuid;
alter table public.run_sheet_items add column if not exists remind boolean;            -- null = on when the line has an owner
alter table public.run_sheet_items add column if not exists remind_offsets integer[];  -- null = the studio default
alter table public.run_sheet_items add column if not exists remind_group boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.run_sheet_items'::regclass and conname = 'run_sheet_items_owner_kind_r24') then
    alter table public.run_sheet_items add constraint run_sheet_items_owner_kind_r24
      check (owner_kind is null or owner_kind in ('user', 'staff', 'vendor', 'other')) not valid;
    alter table public.run_sheet_items validate constraint run_sheet_items_owner_kind_r24;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.run_sheet_items'::regclass and conname = 'run_sheet_items_remind_offsets_r24') then
    alter table public.run_sheet_items add constraint run_sheet_items_remind_offsets_r24
      check (remind_offsets is null or (cardinality(remind_offsets) between 1 and 4 and 0 <= all(remind_offsets) and 1440 >= all(remind_offsets))) not valid;
    alter table public.run_sheet_items validate constraint run_sheet_items_remind_offsets_r24;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.run_sheet_items'::regclass and conname = 'run_sheet_items_owner_user_fk_r24') then
    alter table public.run_sheet_items add constraint run_sheet_items_owner_user_fk_r24
      foreign key (owner_user_id) references public.profiles(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.run_sheet_items'::regclass and conname = 'run_sheet_items_owner_crew_fk_r24') then
    alter table public.run_sheet_items add constraint run_sheet_items_owner_crew_fk_r24
      foreign key (owner_crew_id) references public.crew_members(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.run_sheet_items'::regclass and conname = 'run_sheet_items_owner_vendor_fk_r24') then
    alter table public.run_sheet_items add constraint run_sheet_items_owner_vendor_fk_r24
      foreign key (owner_vendor_id) references public.vendors(id) on delete set null;
  end if;
end $$;

-- ---- 2) tables --------------------------------------------------------------------------------------------------
create table if not exists public.automation_settings (
  org_id             uuid primary key references public.organizations(id) on delete cascade,
  runsheet_enabled   boolean not null default true,
  runsheet_offsets   integer[] not null default array[15, 0]::integer[],
  runsheet_email     boolean not null default true,
  runsheet_whatsapp  boolean not null default true,
  enquiry_enabled    boolean not null default false,
  enquiry_reply      boolean not null default true,
  enquiry_reply_text text check (enquiry_reply_text is null or (char_length(enquiry_reply_text) <= 600 and enquiry_reply_text !~ '[<>]')),
  enquiry_notify     boolean not null default true,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  constraint automation_settings_offsets_chk check (cardinality(runsheet_offsets) between 1 and 4 and 0 <= all(runsheet_offsets) and 1440 >= all(runsheet_offsets))
);

create table if not exists public.runsheet_reminder_sends (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  item_id     uuid not null references public.run_sheet_items(id) on delete cascade,
  offset_min  integer not null,
  channel     text not null check (channel in ('bell', 'email', 'whatsapp', 'chat')),
  recipient   text check (recipient is null or char_length(recipient) <= 200),
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  status      text not null default 'pending' check (status in ('pending', 'queued', 'sent', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 80),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists runsheet_reminder_sends_dedupe on public.runsheet_reminder_sends(dedupe_key);
create index if not exists runsheet_reminder_sends_pending_idx on public.runsheet_reminder_sends(created_at) where sent_at is null;
create index if not exists runsheet_reminder_sends_item_idx on public.runsheet_reminder_sends(item_id);

create table if not exists public.lead_enquiries (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  lead_id      uuid not null references public.leads(id) on delete cascade,
  consent_at   timestamptz not null default now(),
  ip_hash      text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 200),
  reply_to     text check (reply_to is null or char_length(reply_to) <= 200),
  reply_name   text check (reply_name is null or char_length(reply_name) <= 80),
  reply_status text not null default 'pending' check (reply_status in ('pending', 'sent', 'skipped', 'failed')),
  reply_reason text check (reply_reason is null or char_length(reply_reason) <= 80),
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists lead_enquiries_pending_idx on public.lead_enquiries(created_at) where sent_at is null;
create index if not exists lead_enquiries_org_idx on public.lead_enquiries(org_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['automation_settings', 'runsheet_reminder_sends', 'lead_enquiries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  -- quote <-> studio integrity (0004 G4)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.runsheet_reminder_sends'::regclass and tgname = 'zz_quote_org_match') then
    create trigger zz_quote_org_match before insert or update on public.runsheet_reminder_sends for each row execute function public.tg_quote_org_match();
  end if;
end $$;

-- ---- 3) guard: a picked owner must be a person of the SAME studio (never another studio's user / staff / vendor) --
create or replace function public.tg_r24_runsheet_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r24-automation-0269
declare v_org uuid := new.org_id; v_name text;
begin
  if v_org is null then select q.org_id into v_org from public.quotes q where q.id = new.quote_id; end if;
  if tg_op = 'UPDATE' and (new.owner_kind, new.owner_user_id, new.owner_crew_id, new.owner_vendor_id)
       is not distinct from (old.owner_kind, old.owner_user_id, old.owner_crew_id, old.owner_vendor_id) then
    return new;
  end if;
  -- one picked person at most, and the kind follows the id
  if num_nonnulls(new.owner_user_id, new.owner_crew_id, new.owner_vendor_id) > 1 then
    raise exception 'Pick one owner for this line.' using errcode = '22023'; end if;
  if new.owner_user_id is not null then
    select coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)) into v_name
      from public.profiles p where p.id = new.owner_user_id and p.org_id = v_org;
    if not found then raise exception 'That team member is not in this studio.' using errcode = '42501'; end if;
    new.owner_kind := 'user';
  elsif new.owner_crew_id is not null then
    select c.name into v_name from public.crew_members c where c.id = new.owner_crew_id and c.org_id = v_org;
    if not found then raise exception 'That staff member is not in this studio.' using errcode = '42501'; end if;
    new.owner_kind := 'staff';
  elsif new.owner_vendor_id is not null then
    select v.name into v_name from public.vendors v where v.id = new.owner_vendor_id and v.org_id = v_org;
    if not found then raise exception 'That vendor is not in this studio.' using errcode = '42501'; end if;
    new.owner_kind := 'vendor';
  elsif new.owner_kind in ('user', 'staff', 'vendor') then
    new.owner_kind := case when nullif(btrim(coalesce(new.owner, '')), '') is null then null else 'other' end;
  end if;
  -- the line keeps showing the person's name (print, staff link, 0132) when none was typed
  if v_name is not null and nullif(btrim(coalesce(new.owner, '')), '') is null then new.owner := left(v_name, 120); end if;
  return new;
end $$;
revoke all on function public.tg_r24_runsheet_owner() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_r24_runsheet_owner() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_r24_runsheet_owner() from authenticated'; end if;
  -- name sorts after org_from_quote (org_id is filled first) and before zz_runsheet_assign132 (owner name is set first)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.run_sheet_items'::regclass and tgname = 'zr24_runsheet_owner') then
    create trigger zr24_runsheet_owner before insert or update on public.run_sheet_items
      for each row execute function public.tg_r24_runsheet_owner();
  end if;
end $$;

-- ---- 4) helpers (internal, no app grants) ------------------------------------------------------------------------
create or replace function public._r24_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r24-automation-0269: the studio's settings, or the defaults (run-sheet reminders ON, enquiry form OFF)
  select coalesce((select jsonb_build_object('runsheet_enabled', s.runsheet_enabled, 'runsheet_offsets', to_jsonb(s.runsheet_offsets),
                     'runsheet_email', s.runsheet_email, 'runsheet_whatsapp', s.runsheet_whatsapp,
                     'enquiry_enabled', s.enquiry_enabled, 'enquiry_reply', s.enquiry_reply, 'enquiry_reply_text', s.enquiry_reply_text,
                     'enquiry_notify', s.enquiry_notify, 'updated_at', s.updated_at)
                     from public.automation_settings s where s.org_id = p_org),
                  jsonb_build_object('runsheet_enabled', true, 'runsheet_offsets', to_jsonb(array[15, 0]), 'runsheet_email', true,
                     'runsheet_whatsapp', true, 'enquiry_enabled', false, 'enquiry_reply', true, 'enquiry_reply_text', null,
                     'enquiry_notify', true, 'updated_at', null));
$$;

-- the line's start as a moment: the event date + the line's start time in the studio's time zone (null = no reminder)
create or replace function public._r24_item_at(p_date date, p_time time, p_org uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case when p_date is null or p_time is null then null
              else ((p_date + p_time)::timestamp at time zone public._dl241_tz(p_org)) end;
$$;

-- "7:30 pm" (studio zone)
create or replace function public._r24_hm(p_time time)
returns text language sql immutable set search_path = '' as $$
  select case when p_time is null then null else lower(to_char(p_time, 'FMHH12:MI am')) end;
$$;

-- who a line reminds: {kind, name, user_id, email, phone, crew_id} or null. A typed name that matches exactly ONE active
-- staff member (the 0132 rule) or ONE team member of the studio is used too.
create or replace function public._r24_target(p_item public.run_sheet_items, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_n integer; v_id uuid; v_name text := nullif(btrim(coalesce(p_item.owner, '')), '');
begin
  if p_item.owner_user_id is not null then
    select jsonb_build_object('kind', 'user', 'name', coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
             'user_id', p.id, 'email', lower(btrim(p.email)), 'phone', null) into v
      from public.profiles p where p.id = p_item.owner_user_id and p.org_id = p_org;
    return v;
  end if;
  if p_item.owner_crew_id is not null then v_id := p_item.owner_crew_id;
  elsif v_name is not null and coalesce(p_item.owner_kind, 'other') = 'other' and p_item.owner_vendor_id is null then
    select count(*), min(c.id::text)::uuid into v_n, v_id from public.crew_members c
     where c.org_id = p_org and c.active and lower(btrim(c.name)) = lower(v_name);
    if v_n <> 1 then v_id := null; end if;
  end if;
  if v_id is not null then
    select jsonb_build_object('kind', 'staff', 'name', c.name, 'crew_id', c.id, 'user_id', p.id,
             'email', lower(btrim(coalesce(nullif(btrim(p.email), ''), nullif(btrim(c.email), '')))), 'phone', c.phone) into v
      from public.crew_members c left join public.profiles p on p.id = c.profile_id and p.org_id = p_org
     where c.id = v_id and c.org_id = p_org;
    return v;
  end if;
  if p_item.owner_vendor_id is not null then
    select jsonb_build_object('kind', 'vendor', 'name', x.name, 'user_id', null, 'email', lower(btrim(x.email)), 'phone', x.phone) into v
      from public.vendors x where x.id = p_item.owner_vendor_id and x.org_id = p_org;
    return v;
  end if;
  if v_name is not null and coalesce(p_item.owner_kind, 'other') = 'other' then
    select count(*), min(p.id::text)::uuid into v_n, v_id from public.profiles p
     where p.org_id = p_org and lower(btrim(coalesce(p.full_name, ''))) = lower(v_name);
    if v_n = 1 then
      select jsonb_build_object('kind', 'user', 'name', coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
               'user_id', p.id, 'email', lower(btrim(p.email)), 'phone', null) into v
        from public.profiles p where p.id = v_id;
      return v;
    end if;
  end if;
  return null;
end $$;

-- is the line's reminder on, and its reminder times
create or replace function public._r24_item_on(p_item public.run_sheet_items)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_item.remind, nullif(btrim(coalesce(p_item.owner, '')), '') is not null
                  or num_nonnulls(p_item.owner_user_id, p_item.owner_crew_id, p_item.owner_vendor_id) > 0);
$$;

-- the reminder sentence
create or replace function public._r24_text(p_title text, p_time time, p_location text, p_offset integer, p_event text)
returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(
    case when p_offset = 0 then 'Starting now: ' else 'In ' || case when p_offset % 60 = 0 and p_offset >= 60
           then (p_offset / 60)::text || case when p_offset = 60 then ' hour' else ' hours' end else p_offset::text || ' min' end || ': ' end
    || left(coalesce(nullif(btrim(p_title), ''), 'Run-sheet item'), 160)
    || ' at ' || lower(to_char(p_time, 'FMHH12:MI am'))
    || coalesce(' (' || left(nullif(btrim(p_location), ''), 80) || ')', '')
    || coalesce(' - ' || left(nullif(btrim(p_event), ''), 80), ''), '[[:cntrl:]<>]', ' ', 'g'), 400);
$$;

-- ---- 5) settings (Control Center) -----------------------------------------------------------------------------
create or replace function public.automation_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  -- r24-automation-0269: Control Center viewers read; run-sheet viewers read the run-sheet part (default times)
  if auth.uid() is null or v_org is null or not (public.has_area('controls', 'view') or public.has_area('runsheet', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r24_cfg(v_org) || jsonb_build_object(
    'can_manage', public.has_area('controls', 'edit'),
    'public_slug', (select o.public_slug from public.organizations o where o.id = v_org),
    'trial_no_send', coalesce(public._tb179_no_send(v_org), false),
    'enquiries_7d', case when public.has_area('controls', 'view')
                         then (select count(*) from public.lead_enquiries e where e.org_id = v_org and e.created_at > now() - interval '7 days') end);
end $$;

create or replace function public.automation_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; v_off integer[]; v_txt text;
begin
  -- r24-automation-0269: Control Center EDIT only; unknown keys refused; every value checked
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('runsheet_enabled', 'runsheet_offsets', 'runsheet_email', 'runsheet_whatsapp', 'enquiry_enabled', 'enquiry_reply',
                 'enquiry_reply_text', 'enquiry_notify') then
      raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['runsheet_enabled', 'runsheet_email', 'runsheet_whatsapp', 'enquiry_enabled', 'enquiry_reply', 'enquiry_notify'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
  end loop;
  if p ? 'runsheet_offsets' then
    if jsonb_typeof(p -> 'runsheet_offsets') <> 'array' or jsonb_array_length(p -> 'runsheet_offsets') not between 1 and 4
       or exists (select 1 from jsonb_array_elements(p -> 'runsheet_offsets') e
                   where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[0-9]{1,4}$' or (e #>> '{}')::int > 1440) then
      raise exception 'Reminder times: 1 to 4 whole minutes between 0 and 1440.' using errcode = '22023'; end if;
    v_off := array(select distinct (e #>> '{}')::int from jsonb_array_elements(p -> 'runsheet_offsets') e order by 1 desc);
  end if;
  if p ? 'enquiry_reply_text' then
    if jsonb_typeof(p -> 'enquiry_reply_text') not in ('string', 'null') then raise exception 'The reply must be text.' using errcode = '22023'; end if;
    v_txt := nullif(btrim(coalesce(p ->> 'enquiry_reply_text', '')), '');
    if v_txt is not null and (char_length(v_txt) > 600 or v_txt ~ '[<>]') then
      raise exception 'The reply can be up to 600 characters, without < or >.' using errcode = '22023'; end if;
  end if;
  insert into public.automation_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
  update public.automation_settings s set
    runsheet_enabled   = case when p ? 'runsheet_enabled' then (p ->> 'runsheet_enabled')::boolean else s.runsheet_enabled end,
    runsheet_offsets   = coalesce(v_off, s.runsheet_offsets),
    runsheet_email     = case when p ? 'runsheet_email' then (p ->> 'runsheet_email')::boolean else s.runsheet_email end,
    runsheet_whatsapp  = case when p ? 'runsheet_whatsapp' then (p ->> 'runsheet_whatsapp')::boolean else s.runsheet_whatsapp end,
    enquiry_enabled    = case when p ? 'enquiry_enabled' then (p ->> 'enquiry_enabled')::boolean else s.enquiry_enabled end,
    enquiry_reply      = case when p ? 'enquiry_reply' then (p ->> 'enquiry_reply')::boolean else s.enquiry_reply end,
    enquiry_reply_text = case when p ? 'enquiry_reply_text' then v_txt else s.enquiry_reply_text end,
    enquiry_notify     = case when p ? 'enquiry_notify' then (p ->> 'enquiry_notify')::boolean else s.enquiry_notify end,
    updated_at = now(), updated_by = v_me
   where s.org_id = v_org;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'automation_settings.set', 'automation_settings', v_org::text, p, v_org);
  exception when others then raise warning 'r24-0269: audit skipped (%)', sqlstate;
  end;
  return public._r24_cfg(v_org);
end $$;

-- ---- 6) the run-sheet page: team members to pick + who each line reminds ---------------------------------------
-- names + roles only (never e-mails / phones) of the studio's team members, for the Owner picker
create or replace function public.runsheet_team_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('runsheet', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
                     'role', p.role) order by lower(coalesce(nullif(btrim(p.full_name), ''), p.email)))
                     from public.profiles p where p.org_id = v_org and coalesce(p.role, '') not in ('', 'client')), '[]'::jsonb);
end $$;

-- per line: is it reminded, when, who gets it and how (bell / e-mail / WhatsApp / group) - no contact details
create or replace function public.runsheet_reminder_targets(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); c jsonb; q record; i public.run_sheet_items; t jsonb; v_out jsonb := '[]'::jsonb;
  v_ways text[]; v_offs integer[]; v_trial boolean;
begin
  if auth.uid() is null or v_org is null or not public.has_area('runsheet', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.event_date, x.is_demo into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._r24_cfg(v_org);
  v_trial := coalesce(public._tb179_no_send(v_org), false);
  for i in select * from public.run_sheet_items r where r.quote_id = p_quote and r.org_id = v_org order by r.start_time nulls last, r.seq loop
    t := public._r24_target(i, v_org);
    v_offs := coalesce(i.remind_offsets, array(select jsonb_array_elements_text(c -> 'runsheet_offsets')::int));
    v_ways := '{}';
    if t is not null then
      if (t ->> 'user_id') is not null then v_ways := v_ways || 'bell'::text; end if;
      if not v_trial and (c ->> 'runsheet_email')::boolean and public._dl241_email_ok(t ->> 'email') then v_ways := v_ways || 'email'::text; end if;
      if not v_trial and (c ->> 'runsheet_whatsapp')::boolean and (t ->> 'kind') in ('staff', 'vendor')
         and public._assign132_phone(t ->> 'phone') is not null then v_ways := v_ways || 'whatsapp'::text; end if;
    end if;
    if i.remind_group then v_ways := v_ways || 'group'::text; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', i.id,
      'on', (c ->> 'runsheet_enabled')::boolean and public._r24_item_on(i) and not q.is_demo,
      'item_on', public._r24_item_on(i), 'custom', i.remind_offsets is not null,
      'offsets', to_jsonb(v_offs), 'name', t ->> 'name', 'kind', t ->> 'kind', 'ways', to_jsonb(v_ways),
      'group', i.remind_group, 'needs_time', i.start_time is null or q.event_date is null));
  end loop;
  return jsonb_build_object('enabled', (c ->> 'runsheet_enabled')::boolean, 'offsets', c -> 'runsheet_offsets', 'sample', q.is_demo,
    'trial_no_send', v_trial, 'items', v_out);
end $$;

-- ---- 7) the scheduler (pg_cron / service role) ------------------------------------------------------------------
create or replace function public.runsheet_reminders_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; i public.run_sheet_items; c jsonb; t jsonb; v_at timestamptz; v_fire timestamptz; v_off integer; v_offs integer[];
  v_key text; v_id uuid; v_txt text; v_trial boolean; v_conv uuid; v_phone text; v_tok uuid; v_link text; v_n integer := 0; v_skip integer := 0;
begin
  -- r24-automation-0269: service role / pg_cron only
  for r in
    select ri.id as item_id, q.id as quote_id, q.org_id, q.event_date, coalesce(nullif(btrim(q.title), ''), q.code) as ev
      from public.run_sheet_items ri
      join public.quotes q on q.id = ri.quote_id and q.org_id = ri.org_id
      join public.organizations o on o.id = q.org_id
      left join public.automation_settings s on s.org_id = q.org_id
     where coalesce(s.runsheet_enabled, true)
       and ri.start_time is not null
       and q.event_date between current_date - 1 and current_date + 2
       and q.deleted_at is null and coalesce(q.status, '') <> 'cancelled' and coalesce(q.lifecycle_stage, '') <> 'closed'
       and not coalesce(q.is_demo, false) and not coalesce(o.is_sample_master, false)
  loop
    begin
      select * into i from public.run_sheet_items x where x.id = r.item_id;
      if not public._r24_item_on(i) then continue; end if;
      v_at := public._r24_item_at(r.event_date, i.start_time, r.org_id);
      if v_at is null or v_at < now() - interval '3 hours' or v_at > now() + interval '1465 minutes' then continue; end if;
      if coalesce(public._trial_locked(r.org_id), false) then continue; end if;
      c := public._r24_cfg(r.org_id);
      v_offs := coalesce(i.remind_offsets, array(select jsonb_array_elements_text(c -> 'runsheet_offsets')::int));
      foreach v_off in array coalesce(v_offs, '{}'::integer[]) loop
        v_fire := v_at - make_interval(mins => v_off);
        if now() < v_fire or now() >= v_fire + interval '20 minutes' then continue; end if;
        t := public._r24_target(i, r.org_id);
        v_txt := public._r24_text(i.title, i.start_time, i.location, v_off, r.ev);
        v_trial := coalesce(public._tb179_no_send(r.org_id), false);
        v_key := 'rs:' || i.id || ':' || floor(extract(epoch from v_at))::bigint || ':' || v_off || ':';
        -- a) the bell, for a person with a Helm login
        if t is not null and (t ->> 'user_id') is not null then
          v_id := null;
          insert into public.runsheet_reminder_sends(org_id, quote_id, item_id, offset_min, channel, recipient, dedupe_key, status, sent_at)
            values (r.org_id, r.quote_id, i.id, v_off, 'bell', t ->> 'user_id', v_key || 'bell', 'sent', now())
            on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is not null then
            insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
              values (r.quote_id, 'in_app', 'event_reminder', 'simulated',
                      jsonb_build_object('label', left(v_txt || ' - ' || coalesce(t ->> 'name', 'owner'), 500), 'via', 'comms', 'source', '0269',
                                         'runsheet_item', i.id, 'notify', jsonb_build_array(t ->> 'user_id')), r.org_id);
            v_n := v_n + 1;
          end if;
        end if;
        -- b) the e-mail (queued for comms-dispatch; trials never)
        if t is not null and public._dl241_email_ok(t ->> 'email') then
          v_id := null;
          insert into public.runsheet_reminder_sends(org_id, quote_id, item_id, offset_min, channel, recipient, dedupe_key)
            values (r.org_id, r.quote_id, i.id, v_off, 'email', t ->> 'email', v_key || 'email')
            on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is not null then
            if v_trial or not (c ->> 'runsheet_email')::boolean then
              update public.runsheet_reminder_sends set status = 'skipped', sent_at = now(),
                     reason = case when v_trial then 'free_trial' else 'email_off' end where id = v_id;
              v_skip := v_skip + 1;
            else v_n := v_n + 1; end if;
          end if;
        end if;
        -- c) WhatsApp for a staff member / vendor: into the 0132 queue (sent only when the studio's WhatsApp is on)
        v_phone := case when t is not null and (t ->> 'kind') in ('staff', 'vendor') then public._assign132_phone(t ->> 'phone') end;
        if v_phone is not null then
          v_id := null;
          insert into public.runsheet_reminder_sends(org_id, quote_id, item_id, offset_min, channel, recipient, dedupe_key)
            values (r.org_id, r.quote_id, i.id, v_off, 'whatsapp', v_phone, v_key || 'whatsapp')
            on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is not null then
            if v_trial or not (c ->> 'runsheet_whatsapp')::boolean then
              update public.runsheet_reminder_sends set status = 'skipped', sent_at = now(),
                     reason = case when v_trial then 'free_trial' else 'whatsapp_off' end where id = v_id;
              v_skip := v_skip + 1;
            else
              v_tok := null;
              if (t ->> 'kind') = 'staff' then
                select wt.token into v_tok from public.work_tokens wt
                 where wt.quote_id = r.quote_id and wt.org_id = r.org_id and public._assign132_phone(wt.phone) = v_phone
                   and wt.revoked_at is null and (wt.expires_at is null or wt.expires_at > now())
                 order by wt.created_at desc limit 1;
              end if;
              v_link := case when v_tok is not null then 'work.html?token=' || v_tok::text end;
              insert into public.assign_notify_outbox(org_id, quote_id, item_kind, item_id, phone, name, body, link_path, updated_at)
                values (r.org_id, r.quote_id, 'runsheet', i.id, v_phone, left(t ->> 'name', 120),
                        left('Hi ' || coalesce(nullif(btrim(t ->> 'name'), ''), 'there') || ', reminder from '
                             || coalesce((select o.name from public.organizations o where o.id = r.org_id), 'your studio') || ': ' || v_txt || '.'
                             || case when v_link is not null then ' Open your link:' else '' end, 880),
                        v_link, now() - interval '2 minutes');
              update public.runsheet_reminder_sends set status = 'queued', reason = 'whatsapp_queue' where id = v_id;
              v_n := v_n + 1;
            end if;
          end if;
        end if;
        -- d) the event's team chat group, when the line asks for it
        if i.remind_group then
          v_id := null;
          insert into public.runsheet_reminder_sends(org_id, quote_id, item_id, offset_min, channel, recipient, dedupe_key, status, sent_at)
            values (r.org_id, r.quote_id, i.id, v_off, 'chat', null, v_key || 'chat', 'sent', now())
            on conflict (dedupe_key) do nothing returning id into v_id;
          if v_id is not null then
            select x.id into v_conv from public.chat_conversations x where x.quote_id = r.quote_id and x.org_id = r.org_id and x.kind = 'group'
             order by x.created_at limit 1;
            if v_conv is null then
              update public.runsheet_reminder_sends set status = 'skipped', reason = 'no_group' where id = v_id;
            else
              insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
                values (v_conv, r.org_id, null, 'system', left(chr(9200) || ' ' || v_txt || coalesce(' - @' || (t ->> 'name'), ''), 600),
                        case when t is not null and (t ->> 'user_id') is not null
                             and exists (select 1 from public.chat_members m where m.conversation_id = v_conv and m.user_id = (t ->> 'user_id')::uuid)
                             then jsonb_build_object('mentions', jsonb_build_array(t ->> 'user_id'), 'runsheet_item', i.id)
                             else jsonb_build_object('runsheet_item', i.id) end);
              begin update public.chat_conversations set last_message_at = now() where id = v_conv; exception when others then null; end;
              v_n := v_n + 1;
            end if;
          end if;
        end if;
      end loop;
    exception when others then raise warning 'r24-0269: tick skipped one run-sheet line (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('done', v_n, 'skipped', v_skip);
end $$;

-- the dispatcher (comms-dispatch, service role) takes the due reminder e-mails; each is re-checked here
create or replace function public.runsheet_reminder_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_ident jsonb; i public.run_sheet_items;
begin
  update public.runsheet_reminder_sends set status = 'failed', sent_at = now() where sent_at is null and channel = 'email' and attempts >= 5;
  update public.runsheet_reminder_sends set status = 'skipped', reason = 'stale', sent_at = now()
   where sent_at is null and channel = 'email' and status = 'pending' and created_at < now() - interval '2 hours';
  for r in select s.* from public.runsheet_reminder_sends s
            where s.sent_at is null and s.status = 'pending' and s.channel = 'email'
              and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes')
            order by s.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of s skip locked
  loop
    select * into i from public.run_sheet_items x where x.id = r.item_id and x.org_id = r.org_id;
    v_ok := i.id is not null and public._r24_item_on(i)
        and coalesce((public._r24_cfg(r.org_id) ->> 'runsheet_enabled')::boolean, false)
        and coalesce((public._r24_cfg(r.org_id) ->> 'runsheet_email')::boolean, false)
        and not coalesce(public._tb179_no_send(r.org_id), false) and not coalesce(public._trial_locked(r.org_id), false)
        and exists (select 1 from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id and q.deleted_at is null
                      and coalesce(q.status, '') <> 'cancelled' and not coalesce(q.is_demo, false))
        and lower(coalesce(public._r24_target(i, r.org_id) ->> 'email', '')) = lower(r.recipient);
    if not coalesce(v_ok, false) then
      update public.runsheet_reminder_sends set status = 'skipped', reason = 'recheck', sent_at = now() where id = r.id;
      continue;
    end if;
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.runsheet_reminder_sends set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', r.recipient, 'offset_min', r.offset_min,
      'name', public._r24_target(i, r.org_id) ->> 'name', 'title', i.title, 'time_text', public._r24_hm(i.start_time), 'location', i.location,
      'text', public._r24_text(i.title, i.start_time, i.location, r.offset_min, null),
      'event', (select coalesce(nullif(btrim(q.title), ''), q.code, 'the event') from public.quotes q where q.id = r.quote_id),
      'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id),
      'quote_id', r.quote_id, 'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

create or replace function public.runsheet_reminder_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.runsheet_reminder_sends set claimed_at = null where id = p_id and sent_at is null and channel = 'email';
    return 'pending';
  end if;
  update public.runsheet_reminder_sends set status = p_status, sent_at = now() where id = p_id and sent_at is null and channel = 'email';
  return p_status;
end $$;

-- ---- 8) the public enquiry form (/<studio>/enquiry, signed out) -------------------------------------------------
create or replace function public._r24_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v := nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', ''), ',', 1)), '');
  return case when v is null then null else encode(pg_catalog.sha256(convert_to('helm-enq:' || v, 'UTF8')), 'hex') end;
end $$;

-- the studio behind a public link name, only while its enquiry form is switched on and it may take enquiries
create or replace function public._r24_enquiry_org(p_slug text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_slug text := lower(btrim(coalesce(p_slug, ''))); v_org uuid;
begin
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then return null; end if;
  select o.id into v_org from public.organizations o
   where o.public_slug = v_slug and not coalesce(o.is_sample_master, false);
  if v_org is null then return null; end if;
  if not coalesce((public._r24_cfg(v_org) ->> 'enquiry_enabled')::boolean, false) then return null; end if;
  if coalesce(public._trial_locked(v_org), false) then return null; end if;
  return v_org;
end $$;

-- what the form may show: the studio's name only
create or replace function public.public_enquiry_info(p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_ip text := public._r24_ip_hash();
begin
  -- r24-automation-0269
  if v_ip is not null and public.rate_hit('enq.info', v_ip, 600, 120) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  v_org := public._r24_enquiry_org(p_slug);
  if v_org is null then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  return jsonb_build_object('ok', true, 'studio', (select o.name from public.organizations o where o.id = v_org));
end $$;

-- one enquiry -> one lead (source "Enquiry form", New) + a bell notice + the instant reply queued.
-- p: {name, phone, email, event_type, event_date (YYYY-MM-DD), guests, message, consent (true), website (honeypot),
--     captcha (Turnstile token - accepted, not yet checked here: captcha-ready for when captcha-verify learns anonymous passes)}
-- Answers {ok:true} or {ok:false, reason, message}; never reads anything back.
create or replace function public.public_enquiry_submit(p_slug text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_ip text := public._r24_ip_hash(); c jsonb; k text;
  v_name text; v_email text; v_phone text; v_type text; v_date date; v_guests integer; v_msg text; v_lead uuid; v_studio text;
  v_ua text; v_reply_to text; v_status text := 'pending'; v_reason text; h jsonb;
begin
  -- r24-automation-0269
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('name', 'phone', 'email', 'event_type', 'event_date', 'guests', 'message', 'consent', 'website', 'captcha') then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  end loop;
  if v_ip is not null and public.rate_hit('enq.ip', v_ip, 3600, 5) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many enquiries from this network. Please try again in an hour.'); end if;
  v_org := public._r24_enquiry_org(p_slug);
  if v_org is null then return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This enquiry form is not open right now.'); end if;
  -- a filled hidden field = a bot: say thank you, keep nothing
  if nullif(btrim(coalesce(p ->> 'website', '')), '') is not null then return jsonb_build_object('ok', true); end if;
  if public.rate_hit('enq.org', v_org::text, 3600, 30) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'The studio is receiving many enquiries. Please try again a little later.'); end if;
  v_name := left(btrim(regexp_replace(coalesce(p ->> 'name', ''), '[[:cntrl:]<>]', ' ', 'g')), 80);
  if char_length(v_name) < 2 then return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'name', 'message', 'Please enter your name.'); end if;
  v_email := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  if v_email is not null and not public._dl241_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'email', 'message', 'Please enter a valid e-mail address.'); end if;
  v_phone := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null and regexp_replace(v_phone, '[^0-9]', '', 'g') !~ '^[0-9]{10,15}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'phone', 'message', 'Please enter a valid phone number (10 digits).'); end if;
  if v_email is null and v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'phone', 'message', 'Please give a phone number or an e-mail so the studio can reply.'); end if;
  if coalesce(p ->> 'consent', '') <> 'true' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'consent', 'message', 'Please tick the box so the studio may contact you.'); end if;
  v_type := nullif(left(btrim(regexp_replace(coalesce(p ->> 'event_type', ''), '[[:cntrl:]<>]', ' ', 'g')), 60), '');
  if nullif(btrim(coalesce(p ->> 'event_date', '')), '') is not null then
    if (p ->> 'event_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick the event date.'); end if;
    begin v_date := (p ->> 'event_date')::date; exception when others then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick the event date.'); end;
    if v_date < current_date or v_date > current_date + 1100 then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick a date from today onwards.'); end if;
  end if;
  if nullif(btrim(coalesce(p ->> 'guests', '')), '') is not null then
    if (p ->> 'guests') !~ '^[0-9]{1,6}$' or (p ->> 'guests')::integer not between 1 and 100000 then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'guests', 'message', 'Guests: a number from 1 to 100000.'); end if;
    v_guests := (p ->> 'guests')::integer;
  end if;
  v_msg := nullif(left(btrim(regexp_replace(coalesce(p ->> 'message', ''), '[<>]', ' ', 'g')), 1000), '');
  if public.rate_hit('enq.addr', encode(pg_catalog.sha256(convert_to(v_org::text || ':' || coalesce(v_email, '') || ':'
       || coalesce(regexp_replace(v_phone, '[^0-9]', '', 'g'), ''), 'UTF8')), 'hex'), 86400, 3) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We already have your enquiry. The studio will get back to you soon.'); end if;
  c := public._r24_cfg(v_org);
  select o.name into v_studio from public.organizations o where o.id = v_org;
  begin
    insert into public.leads(org_id, name, phone, email, source, event_type, event_date, guest_count, notes, status, owner)
      values (v_org, v_name, v_phone, v_email, 'enquiry_form', v_type, v_date, v_guests,
              'From the enquiry form' || coalesce(': ' || v_msg, ''), 'new', null)
      returning id into v_lead;
  exception when others then
    raise warning 'r24-0269: enquiry not saved (%)', sqlstate;
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'The studio cannot take enquiries online right now. Please call or e-mail them.');
  end;
  -- the instant reply: queued only (comms-dispatch sends it once e-mail is live); free trials / no e-mail -> kept as skipped
  if v_email is null then v_status := 'skipped'; v_reason := 'no_email';
  elsif not coalesce((c ->> 'enquiry_reply')::boolean, false) then v_status := 'skipped'; v_reason := 'reply_off';
  elsif coalesce(public._tb179_no_send(v_org), false) then v_status := 'skipped'; v_reason := 'free_trial';
  else v_reply_to := v_email; end if;
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ua := left(nullif(btrim(regexp_replace(coalesce(h ->> 'user-agent', ''), '[[:cntrl:]]', ' ', 'g')), ''), 200);
  insert into public.lead_enquiries(org_id, lead_id, ip_hash, user_agent, reply_to, reply_name, reply_status, reply_reason, sent_at)
    values (v_org, v_lead, v_ip, v_ua, coalesce(v_reply_to, v_email), v_name, v_status, v_reason, case when v_status = 'skipped' then now() end);
  if coalesce((c ->> 'enquiry_notify')::boolean, true) then
    begin
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (null, 'in_app', 'lead_new', 'simulated',
                jsonb_build_object('label', left('New enquiry from ' || v_name || coalesce(' - ' || v_type, '')
                                                 || coalesce(', ' || to_char(v_date, 'DD/MM/YYYY'), '') || ' (enquiry form)', 300),
                                   'via', 'comms', 'source', '0269', 'lead_id', v_lead), v_org);
    exception when others then raise warning 'r24-0269: enquiry bell skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true, 'studio', v_studio);
end $$;

-- the instant replies for comms-dispatch (service role); each re-checked here
create or replace function public.enquiry_reply_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; c jsonb; v_ident jsonb; v_text text; v_studio text;
begin
  update public.lead_enquiries set reply_status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.lead_enquiries set reply_status = 'skipped', reply_reason = 'stale', sent_at = now()
   where sent_at is null and reply_status = 'pending' and created_at < now() - interval '1 day';
  for r in select e.*, l.event_type, l.name as lead_name from public.lead_enquiries e
             join public.leads l on l.id = e.lead_id and l.org_id = e.org_id
            where e.sent_at is null and e.reply_status = 'pending' and (e.claimed_at is null or e.claimed_at < now() - interval '10 minutes')
            order by e.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of e skip locked
  loop
    c := public._r24_cfg(r.org_id);
    v_ok := coalesce((c ->> 'enquiry_reply')::boolean, false) and public._dl241_email_ok(r.reply_to)
        and not coalesce(public._tb179_no_send(r.org_id), false) and not coalesce(public._trial_locked(r.org_id), false)
        and not exists (select 1 from public.organizations o where o.id = r.org_id and coalesce(o.is_sample_master, false));
    if not coalesce(v_ok, false) then
      update public.lead_enquiries set reply_status = 'skipped', reply_reason = 'recheck', sent_at = now() where id = r.id;
      continue;
    end if;
    select o.name into v_studio from public.organizations o where o.id = r.org_id;
    v_text := coalesce(nullif(btrim(c ->> 'enquiry_reply_text'), ''),
      'Hi {name}, thank you for your enquiry with {studio}. We have your details and will get back to you shortly.');
    v_text := replace(replace(replace(v_text, '{name}', coalesce(nullif(btrim(r.reply_name), ''), 'there')), '{studio}', coalesce(v_studio, 'us')),
                      '{event}', coalesce(nullif(btrim(r.event_type), ''), 'your event'));
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.lead_enquiries set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', r.reply_to, 'name', r.reply_name, 'studio', v_studio,
      'text', left(v_text, 800), 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

create or replace function public.enquiry_reply_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then update public.lead_enquiries set claimed_at = null where id = p_id and sent_at is null; return 'pending'; end if;
  update public.lead_enquiries set reply_status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 9) grants ----------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r24_cfg(uuid)', 'public._r24_item_at(date, time, uuid)', 'public._r24_hm(time)',
      'public._r24_target(public.run_sheet_items, uuid)', 'public._r24_item_on(public.run_sheet_items)',
      'public._r24_text(text, time, text, integer, text)', 'public._r24_ip_hash()', 'public._r24_enquiry_org(text)',
      'public.runsheet_reminders_tick()', 'public.runsheet_reminder_claim(integer)', 'public.runsheet_reminder_mark(uuid, text)',
      'public.enquiry_reply_claim(integer)', 'public.enquiry_reply_mark(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.runsheet_reminders_tick()', 'public.runsheet_reminder_claim(integer)', 'public.runsheet_reminder_mark(uuid, text)',
        'public.enquiry_reply_claim(integer)', 'public.enquiry_reply_mark(uuid, text)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
  -- the app (signed in; each RPC checks the studio + area itself)
  foreach f in array array['public.automation_settings_get()', 'public.automation_settings_set(jsonb)', 'public.runsheet_team_options()',
      'public.runsheet_reminder_targets(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the signed-out enquiry form
  foreach f in array array['public.public_enquiry_info(text)', 'public.public_enquiry_submit(text, jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 10) trial retention (0184) knows the new tables (patched in place, the 0241 way; skipped without 0184) -----
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''runsheet_reminder_sends''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''run_sheet_items''', ''))) / length('''run_sheet_items''') <> 1
         or (length(v_def) - length(replace(v_def, '''leads''', ''))) / length('''leads''') <> 1 then
        raise notice '0269: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(replace(v_def, '''run_sheet_items''', '''runsheet_reminder_sends'', ''run_sheet_items'''),
                        '''leads''', '''lead_enquiries'', ''leads''');
      end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''automation_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_settings''', ''))) / length('''comms_settings''') <> 1 then
        raise notice '0269: _tr184_keep_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''comms_settings''', '''comms_settings'', ''automation_settings''');
      end if;
    end if;
  end if;
end $$;

-- ---- 11) pg_cron, ONLY if it is already installed (never created here) -----------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_runsheet_reminders') then
        perform cron.schedule('helm_runsheet_reminders', '*/5 * * * *', 'select public.runsheet_reminders_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_runsheet_reminders could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 seven new run-sheet columns exist (nullable / defaulted)',
     (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'run_sheet_items'
        and column_name in ('owner_kind', 'owner_user_id', 'owner_crew_id', 'owner_vendor_id', 'remind', 'remind_offsets', 'remind_group')) = 7),
  ('02 three new tables with RLS on and no anon / signed-in table privilege',
     (select count(*) from pg_class c where c.oid in (to_regclass('public.automation_settings'), to_regclass('public.runsheet_reminder_sends'),
        to_regclass('public.lead_enquiries')) and c.relrowsecurity) = 3
     and not has_table_privilege('authenticated', 'public.automation_settings', 'select')
     and not has_table_privilege('anon', 'public.lead_enquiries', 'select')),
  ('03 no studio settings row written (run-sheet reminders follow the default ON, enquiry form OFF)',
     not exists (select 1 from public.automation_settings where enquiry_enabled)),
  ('04 owner guard trigger on run_sheet_items + quote / studio match on the reminder ledger',
     exists (select 1 from pg_trigger where tgrelid = 'public.run_sheet_items'::regclass and tgname = 'zr24_runsheet_owner')
     and exists (select 1 from pg_trigger where tgrelid = 'public.runsheet_reminder_sends'::regclass and tgname = 'zz_quote_org_match')),
  ('05 grants: app RPCs signed-in only, the 2 enquiry RPCs also anon, tick / claim / mark service role only',
     has_function_privilege('authenticated', 'public.automation_settings_set(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.automation_settings_set(jsonb)', 'execute')
     and has_function_privilege('anon', 'public.public_enquiry_submit(text, jsonb)', 'execute')
     and has_function_privilege('anon', 'public.public_enquiry_info(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.runsheet_reminders_tick()', 'execute')
     and not has_function_privilege('anon', 'public.runsheet_reminder_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.enquiry_reply_claim(integer)', 'execute')),
  ('06 pg_cron job helm_runsheet_reminders scheduled (or pg_cron not installed - then schedule it by hand, see the owner steps)',
     case when to_regclass('cron.job') is null then true
          else position('<row>' in query_to_xml('select 1 from cron.job where jobname = ''helm_runsheet_reminders''', false, false, '')::text) > 0 end),
  ('07 trial retention (0184) classifies the new tables',
     to_regprocedure('public._tr184_purge_tables()') is null
     or (public._tr184_purge_tables() @> array['runsheet_reminder_sends', 'lead_enquiries'] and 'automation_settings' = any(public._tr184_keep_tables())))
) v(item, ok) order by item;
