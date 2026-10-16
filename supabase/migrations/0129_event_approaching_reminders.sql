-- ============================================================================
-- 0129_event_approaching_reminders.sql - CANONICAL forward-only. "Your event is coming up" reminders.
-- REQUIRES 0016 (chat), 0035 (chat_conversations.quote_id = event group), 0036 (notifications.org_id
--          / bell), 0040 (quotes.deleted_at), 0045 (_studio_writable), 0120 (organizations.timezone use).
--
-- In plain words (marker: helm-0129-event-remind):
--   * Each studio picks how early the team is reminded before a confirmed event:
--     organizations.event_reminder_days (default 7, allowed 1-30). Admins change it in the
--     Control Center ("Remind the team before each event: [7] days").
--   * event_reminders_tick() (SECURITY DEFINER, service role / pg_cron only, hourly) looks at every
--     CONFIRMED, not-deleted, not-closed event and counts days to the event date in the STUDIO's
--     own time zone:
--       'window'  - the event is inside the window (2..N days away): "Event in N days: ..."
--                   (sent once; an event confirmed late, e.g. 4 days before, still gets it once)
--       'd1'      - the day before: "Event tomorrow: ..."
--     For each new reminder it records ONE ledger row in public.event_reminders (UNIQUE dedupe_key:
--     event + milestone + event date, so a moved date reminds again, a re-run never duplicates),
--     then drops ONE bell notification for the studio (kind 'event_reminder', linked to the event -
--     the bell is studio-wide, so admins and the whole team see it) and, when the event has a team
--     chat group (0035), posts the same text into that group so everyone in the group is told.
--   * Nothing is e-mailed, texted or WhatsApp-ed: the bell row is marked detail.via = 'comms' so the
--     0078 WhatsApp forwarder skips it, and the chat group is never the broadcast channel.
--   * event_reminder_upcoming() lets the app show "Upcoming in N days" on the event page / dashboard.
--
-- ZERO DATA LOSS: additive + idempotent. One NEW nullable-safe column (default 7), one NEW table,
-- new functions, one cron job (only when pg_cron is already installed). No DROP / DELETE / TRUNCATE,
-- no existing row or function is changed. Safe to run twice. ASCII only.
-- ============================================================================

do $$ begin
  if to_regclass('public.chat_messages') is null or to_regclass('public.notifications') is null then
    raise exception '0129: apply 0016 (chat) and the notifications migrations first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'chat_conversations' and column_name = 'quote_id') then
    raise exception '0129: chat_conversations.quote_id (0035) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'quotes' and column_name = 'deleted_at') then
    raise exception '0129: quotes.deleted_at (0040) is missing'; end if;
  if to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0129: _studio_writable (0045) is missing'; end if;
end $$;

-- ---- 1) the per-studio setting -----------------------------------------------------------------
alter table public.organizations add column if not exists event_reminder_days integer not null default 7;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'org_event_reminder_days_ck129') then
    alter table public.organizations add constraint org_event_reminder_days_ck129
      check (event_reminder_days between 1 and 30) not valid;
  end if;
end $$;

-- ---- 2) the ledger (dedupe) --------------------------------------------------------------------
create table if not exists public.event_reminders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid references public.quotes(id) on delete set null,
  milestone   text not null check (milestone in ('window', 'd1')),
  event_date  date not null,
  days_left   integer not null,
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  chat_posted boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists event_reminders_dedupe_key129 on public.event_reminders(dedupe_key);
create index if not exists event_reminders_org129 on public.event_reminders(org_id, created_at desc);

alter table public.event_reminders enable row level security;
revoke all on table public.event_reminders from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.event_reminders from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.event_reminders from authenticated'; end if;
end $$;
-- no policies: only SECURITY DEFINER functions and the service role touch this table

-- ---- 3) pure helpers ---------------------------------------------------------------------------
-- days from "today in the studio zone" to the event date (JS mirror: event-reminders.js daysUntil)
create or replace function public._event_days_left(p_date date, p_now timestamptz, p_tz text)
returns integer language plpgsql stable set search_path = '' as $$
-- helm-0129-event-remind
declare v_tz text := coalesce(nullif(btrim(p_tz), ''), 'Asia/Kolkata');
begin
  if p_date is null or p_now is null then return null; end if;
  begin
    return p_date - (p_now at time zone v_tz)::date;
  exception when others then
    return p_date - (p_now at time zone 'Asia/Kolkata')::date;
  end;
end $$;

-- which reminder is due (null = none). N = studio window (1..30)
create or replace function public._event_reminder_milestone(p_days_left integer, p_window integer)
returns text language sql immutable set search_path = '' as $$
  -- helm-0129-event-remind
  select case
    when p_days_left is null or p_days_left < 1 then null
    when p_days_left = 1 then 'd1'
    when p_days_left <= greatest(1, least(coalesce(p_window, 7), 30)) then 'window'
    else null end;
$$;

create or replace function public._event_reminder_text(p_milestone text, p_days_left integer, p_name text, p_date date)
returns text language sql immutable set search_path = '' as $$
  -- helm-0129-event-remind
  select left(case when p_milestone = 'd1' then 'Event tomorrow: '
                   else 'Event in ' || p_days_left::text || ' days: ' end
         || coalesce(nullif(btrim(p_name), ''), 'Your event') || ' on ' || to_char(p_date, 'DD Mon YYYY')
         || case when p_milestone = 'd1' then ' - final check: staff, vendors, load-in and the checklist.'
                 else ' - check the checklist, staff and vendors.' end, 400);
$$;

-- ---- 4) the tick (pg_cron hourly / service role) -------------------------------------------------
create or replace function public.event_reminders_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0129-event-remind: service role / pg_cron only (EXECUTE granted to service_role alone)
declare r record; v_left integer; v_m text; v_id uuid; v_txt text; v_conv uuid; n integer := 0; n_chat integer := 0;
begin
  for r in
    select q.id, q.org_id, q.code, q.title, q.event_date,
           coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') as tz,
           greatest(1, least(coalesce(o.event_reminder_days, 7), 30)) as win
      from public.quotes q
      join public.organizations o on o.id = q.org_id
     where q.status = 'confirmed' and q.deleted_at is null
       and coalesce(q.lifecycle_stage, '') <> 'closed'
       and q.event_date is not null
       and q.event_date between current_date - 1 and current_date + 32
  loop
    begin
      v_left := public._event_days_left(r.event_date, now(), r.tz);
      v_m := public._event_reminder_milestone(v_left, r.win);
      if v_m is null then continue; end if;
      v_id := null;
      insert into public.event_reminders(org_id, quote_id, milestone, event_date, days_left, dedupe_key)
        values (r.org_id, r.id, v_m, r.event_date, v_left,
                'evrem129:' || r.id::text || ':' || v_m || ':' || to_char(r.event_date, 'YYYY-MM-DD'))
        on conflict (dedupe_key) do nothing
        returning id into v_id;
      if v_id is null then continue; end if;
      n := n + 1;
      v_txt := public._event_reminder_text(v_m, v_left, coalesce(nullif(btrim(r.title), ''), r.code), r.event_date);
      begin   -- the bell row must never block the ledger row
        insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
          values (r.id, 'in_app', 'event_reminder', 'simulated',
                  jsonb_build_object('label', v_txt, 'milestone', v_m, 'days_left', v_left,
                                     'event_date', r.event_date, 'window_days', r.win,
                                     'via', 'comms', 'source', '0129'),
                  r.org_id);
      exception when others then raise warning 'helm-0129: bell row skipped (%)', sqlstate;
      end;
      begin   -- post into the event's team chat group, when one exists (never the broadcast channel)
        select c.id into v_conv from public.chat_conversations c
         where c.quote_id = r.id and c.org_id = r.org_id and c.kind = 'group' limit 1;
        if v_conv is not null then
          insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body)
            values (v_conv, r.org_id, null, 'system', v_txt);
          update public.event_reminders set chat_posted = true where id = v_id;
          n_chat := n_chat + 1;
          begin
            update public.chat_conversations set last_message_at = now() where id = v_conv;
          exception when others then null;
          end;
        end if;
      exception when others then raise warning 'helm-0129: chat post skipped (%)', sqlstate;
      end;
    exception when others then raise warning 'helm-0129: event skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('event_reminders_new', n, 'chat_posts', n_chat);
end $$;

-- ---- 5) settings for the Control Center ------------------------------------------------------------
create or replace function public.event_reminder_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0129-event-remind
declare v_org uuid := public.current_org_id(); v integer;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(o.event_reminder_days, 7) into v from public.organizations o where o.id = v_org;
  return jsonb_build_object('days', coalesce(v, 7), 'min', 1, 'max', 30,
                            'can_edit', coalesce(public.is_admin(), false));
end $$;

create or replace function public.event_reminder_settings_set(p_days integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0129-event-remind: studio admins only
declare v_org uuid := public.current_org_id(); v_old integer;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 30 then
    raise exception 'Choose between 1 and 30 days.' using errcode = '22023'; end if;
  select o.event_reminder_days into v_old from public.organizations o where o.id = v_org;
  update public.organizations set event_reminder_days = p_days where id = v_org;
  if v_old is distinct from p_days then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'settings.event_reminder_days', 'organizations', v_org::text,
              jsonb_build_object('from', v_old, 'to', p_days), v_org, now());
  end if;
  return public.event_reminder_settings_get();
end $$;

-- ---- 6) "Upcoming in N days" for the event page / dashboard ----------------------------------------
create or replace function public.event_reminder_upcoming()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0129-event-remind: confirmed events of MY studio inside the reminder window (no money fields)
declare v_org uuid := public.current_org_id(); v_tz text; v_win integer;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'), greatest(1, least(coalesce(o.event_reminder_days, 7), 30))
    into v_tz, v_win from public.organizations o where o.id = v_org;
  if not coalesce(public.has_area('quotes', 'view'), false) then
    return jsonb_build_object('days', v_win, 'items', '[]'::jsonb);
  end if;
  return jsonb_build_object('days', v_win, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('quote_id', x.id, 'code', x.code, 'title', x.title,
                                        'event_date', x.event_date, 'days_left', x.dl) order by x.dl, x.code)
      from (select q.id, q.code, q.title, q.event_date, public._event_days_left(q.event_date, now(), v_tz) as dl
              from public.quotes q
             where q.org_id = v_org and q.status = 'confirmed' and q.deleted_at is null
               and coalesce(q.lifecycle_stage, '') <> 'closed'
               and q.event_date between current_date - 1 and current_date + 32) x
     where x.dl between 0 and v_win), '[]'::jsonb));
end $$;

-- ---- 7) privileges -----------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public._event_days_left(date, timestamptz, text)', 'public._event_reminder_milestone(integer, integer)',
    'public._event_reminder_text(text, integer, text, date)', 'public.event_reminders_tick()',
    'public.event_reminder_settings_get()', 'public.event_reminder_settings_set(integer)',
    'public.event_reminder_upcoming()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_reminder_settings_get() to authenticated';
    execute 'grant execute on function public.event_reminder_settings_set(integer) to authenticated';
    execute 'grant execute on function public.event_reminder_upcoming() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_reminders_tick() to service_role';
  end if;
end $$;

-- ---- 8) pg_cron hourly, ONLY if it is already installed (never created here) ----------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_event_reminders') then
        perform cron.schedule('helm_event_reminders', '17 * * * *', 'select public.event_reminders_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_event_reminders could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  else
    raise notice '0129: pg_cron not installed - run select public.event_reminders_tick() hourly from a service caller';
  end if;
end $$;

notify pgrst, 'reload schema';
