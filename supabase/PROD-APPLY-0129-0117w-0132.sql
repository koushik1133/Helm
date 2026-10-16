-- APPLY 0129 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
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
commit;

-- VERIFY 0129 (read-only; expect every ok = true)
select '0129 organizations.event_reminder_days exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'event_reminder_days') as ok
union all select '0129 every studio has 1-30 reminder days', not exists (select 1 from public.organizations o where o.event_reminder_days is null or o.event_reminder_days not between 1 and 30)
union all select '0129 event_reminders ledger exists', to_regclass('public.event_reminders') is not null
union all select '0129 event_reminders RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.event_reminders')), false)
union all select '0129 event_reminders not writable by authenticated', not has_table_privilege('authenticated', 'public.event_reminders', 'insert')
union all select '0129 event_reminders not readable by anon', not has_table_privilege('anon', 'public.event_reminders', 'select')
union all select '0129 dedupe key unique', to_regclass('public.event_reminders_dedupe_key129') is not null
union all select '0129 tick exists + security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.event_reminders_tick()')), false)
union all select '0129 tick not callable by anon', not has_function_privilege('anon', 'public.event_reminders_tick()', 'execute')
union all select '0129 tick not callable by authenticated', not has_function_privilege('authenticated', 'public.event_reminders_tick()', 'execute')
union all select '0129 tick sends nothing outside the app (no _notify / comms_outbox)', coalesce(pg_get_functiondef(to_regprocedure('public.event_reminders_tick()')) not like '%_notify(%' and pg_get_functiondef(to_regprocedure('public.event_reminders_tick()')) not like '%comms_outbox%', false)
union all select '0129 settings_get callable by authenticated', has_function_privilege('authenticated', 'public.event_reminder_settings_get()', 'execute')
union all select '0129 settings_set not callable by anon', not has_function_privilege('anon', 'public.event_reminder_settings_set(integer)', 'execute')
union all select '0129 upcoming not callable by anon', not has_function_privilege('anon', 'public.event_reminder_upcoming()', 'execute')
union all select '0129 milestone: 7 days in a 7-day window', public._event_reminder_milestone(7, 7) = 'window'
union all select '0129 milestone: 8 days in a 7-day window = none', public._event_reminder_milestone(8, 7) is null
union all select '0129 milestone: 1 day = d1', public._event_reminder_milestone(1, 7) = 'd1'
union all select '0129 milestone: today = none', public._event_reminder_milestone(0, 7) is null;
-- STAGING-APPLY-WA-0117w-0132.sql - paste whole file into the Supabase SQL editor (STAGING).
-- Part A: WhatsApp-only subset of APPLY-0117 (NO Razorpay objects). Part B: APPLY-0132.
-- One transaction for both parts, then ONE read-only verify select (expect every ok = true).
-- The full APPLY-0117.sql can later be run on top: it adds org_payment_accounts + Razorpay
-- functions and create-or-replaces the shared functions with their Razorpay branches.
-- ZERO DATA LOSS: additive + idempotent. No DROP of data, no DELETE, no TRUNCATE. ASCII only.
begin;

-- ===================== PART A: 0117 WhatsApp-only =====================
do $$ begin
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception '0117w: current_org_id() / is_admin() missing'; end if;
  if to_regclass('public.organizations') is null then raise exception '0117w: organizations missing'; end if;
end $$;

-- ---- 1) tables ----------------------------------------------------------------------------

create table if not exists public.org_whatsapp_accounts (
  org_id              uuid primary key references public.organizations(id),
  waba_id             text,
  phone_number_id     text,
  display_phone       text,
  verified_name       text,
  token_secret_id     uuid,           -- vault.secrets.id
  status              text not null default 'pending',
  quality             text,
  last_error          text,
  connected_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint org_whatsapp_accounts_status_chk check (status in ('pending', 'connected', 'disabled', 'error')),
  constraint org_whatsapp_accounts_ids_chk check ((waba_id is null or waba_id ~ '^[0-9]{5,30}$') and (phone_number_id is null or phone_number_id ~ '^[0-9]{5,30}$'))
);
create unique index if not exists org_whatsapp_accounts_phone_uk117 on public.org_whatsapp_accounts (phone_number_id) where phone_number_id is not null;

create table if not exists public.integration_webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  event_id      text not null,
  event_type    text not null,
  org_id        uuid,
  quote_id      uuid,
  ref           text,                 -- plink_ / pay_ / rfnd_ / wamid
  status        text,
  amount_paise  bigint,
  detail        jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now(),
  constraint integration_webhook_events_provider_chk check (provider in ('razorpay', 'whatsapp'))
);
create unique index if not exists integration_webhook_events_uk117 on public.integration_webhook_events (provider, event_id);
create index if not exists integration_webhook_events_org_idx117 on public.integration_webhook_events (org_id, received_at desc);

create table if not exists public.whatsapp_opt_outs (
  id            bigint generated always as identity primary key,
  phone         text not null,
  org_id        uuid,                 -- NULL = Helm shared number
  opted_out     boolean not null default true,
  source        text not null default 'reply',
  updated_at    timestamptz not null default now(),
  constraint whatsapp_opt_outs_phone_chk check (phone ~ '^[0-9]{8,15}$')
);
create unique index if not exists whatsapp_opt_outs_uk117
  on public.whatsapp_opt_outs (phone, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---- 2) RLS + grants (admin of the studio sees non-secret fields only) ---------------------
alter table public.org_whatsapp_accounts enable row level security;
alter table public.integration_webhook_events enable row level security;
alter table public.whatsapp_opt_outs enable row level security;

revoke all on public.org_whatsapp_accounts,
              public.integration_webhook_events, public.whatsapp_opt_outs from public, anon, authenticated;
grant all on public.org_whatsapp_accounts,
             public.integration_webhook_events, public.whatsapp_opt_outs to service_role;
-- column-level: the Vault id columns are NOT granted
grant select (org_id, waba_id, phone_number_id, display_phone, verified_name, status, quality, last_error, connected_at, updated_at)
  on public.org_whatsapp_accounts to authenticated;
grant select (id, provider, event_type, org_id, quote_id, ref, status, amount_paise, received_at)
  on public.integration_webhook_events to authenticated;

drop policy if exists org_whatsapp_accounts_admin_read on public.org_whatsapp_accounts;
create policy org_whatsapp_accounts_admin_read on public.org_whatsapp_accounts for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.is_admin(), false));
drop policy if exists integration_webhook_events_admin_read on public.integration_webhook_events;
create policy integration_webhook_events_admin_read on public.integration_webhook_events for select to authenticated
  using (org_id is not null and org_id = public.current_org_id() and coalesce(public.is_admin(), false));
-- whatsapp_opt_outs: service role only (no authenticated policy)

-- ---- 3) Vault helper (private) -------------------------------------------------------------
create or replace function public._integ_vault_put(p_existing uuid, p_secret text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v uuid;
begin
  if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     and to_regprocedure('vault.create_secret(text,text,text)') is null then
    raise exception 'vault_unavailable' using errcode = 'P0001'; end if;
  if p_existing is not null and exists (select 1 from vault.secrets where id = p_existing) then
    perform vault.update_secret(p_existing, p_secret);
    return p_existing;
  end if;
  select vault.create_secret(p_secret, p_name || ':' || gen_random_uuid()::text, 'helm integration 0117') into v;
  return v;
end $$;
revoke all on function public._integ_vault_put(uuid, text, text) from public, anon, authenticated;
grant execute on function public._integ_vault_put(uuid, text, text) to service_role;

create or replace function public._integ_vault_get(p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare v text;
begin
  if p_id is null or to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into v using p_id;
  return v;
end $$;
revoke all on function public._integ_vault_get(uuid) from public, anon, authenticated;
grant execute on function public._integ_vault_get(uuid) to service_role;


create or replace function public.save_org_whatsapp_account(p_waba_id text, p_phone_number_id text, p_token text, p_display_phone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id(); r public.org_whatsapp_accounts; v_t uuid;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  p_waba_id := btrim(coalesce(p_waba_id, '')); p_phone_number_id := btrim(coalesce(p_phone_number_id, ''));
  if p_waba_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_waba_id' using errcode = '22023'; end if;
  if p_phone_number_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_phone_number_id' using errcode = '22023'; end if;
  if length(coalesce(p_token, '')) not between 20 and 1000 then raise exception 'invalid_token' using errcode = '22023'; end if;
  if exists (select 1 from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id and org_id <> v_org) then
    raise exception 'phone_in_use' using errcode = '23505'; end if;
  select * into r from public.org_whatsapp_accounts where org_id = v_org for update;
  v_t := public._integ_vault_put(r.token_secret_id, p_token, 'wa_token:' || v_org::text);
  insert into public.org_whatsapp_accounts as a (org_id, waba_id, phone_number_id, display_phone, token_secret_id, status, updated_by, updated_at)
    values (v_org, p_waba_id, p_phone_number_id, left(nullif(btrim(coalesce(p_display_phone, '')), ''), 30), v_t, 'pending', auth.uid(), now())
  on conflict (org_id) do update set waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id,
    display_phone = excluded.display_phone, token_secret_id = excluded.token_secret_id, status = 'pending',
    last_error = null, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;
revoke all on function public.save_org_whatsapp_account(text, text, text, text) from public, anon;
grant execute on function public.save_org_whatsapp_account(text, text, text, text) to authenticated, service_role;

-- admin may pause their own studio's account (never deletes anything)
create or replace function public.set_org_integration_status(p_kind text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_status not in ('disabled', 'pending') then raise exception 'invalid_status' using errcode = '22023'; end if;
  if p_kind = 'razorpay' then
    raise exception 'razorpay not enabled yet' using errcode = '0A000';
  elsif p_kind = 'whatsapp' then
    update public.org_whatsapp_accounts set status = p_status, updated_at = now(), updated_by = auth.uid() where org_id = v_org;
  else raise exception 'invalid_kind' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;
revoke all on function public.set_org_integration_status(text, text) from public, anon;
grant execute on function public.set_org_integration_status(text, text) to authenticated, service_role;


create or replace function public.org_whatsapp_creds(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare r public.org_whatsapp_accounts;
begin
  select * into r from public.org_whatsapp_accounts where org_id = p_org and status = 'connected';
  if r.org_id is null then return null; end if;
  return jsonb_build_object('org_id', r.org_id, 'waba_id', r.waba_id, 'phone_number_id', r.phone_number_id,
    'token', public._integ_vault_get(r.token_secret_id));
end $$;
revoke all on function public.org_whatsapp_creds(uuid) from public, anon, authenticated;
grant execute on function public.org_whatsapp_creds(uuid) to service_role;

create or replace function public.mark_org_integration(p_org uuid, p_kind text, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
begin
  if p_status not in ('pending', 'connected', 'disabled', 'error') then raise exception 'invalid_status'; end if;
  if p_kind = 'razorpay' then
    raise exception 'razorpay not enabled yet' using errcode = '0A000';
  elsif p_kind = 'whatsapp' then
    update public.org_whatsapp_accounts set status = p_status, last_error = left(p_error, 200), updated_at = now(),
      connected_at = case when p_status = 'connected' then now() else connected_at end where org_id = p_org;
  end if;
end $$;
revoke all on function public.mark_org_integration(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_org_integration(uuid, text, text, text) to service_role;
-- ---- 7) WhatsApp: statuses + opt-outs -------------------------------------------------------
create or replace function public.wa_record_event(
  p_event_id text, p_phone_number_id text, p_type text, p_ref text, p_status text, p_recipient text, p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_org uuid; v_id bigint;
begin
  if nullif(btrim(coalesce(p_event_id, '')), '') is null then return jsonb_build_object('result', 'ignored'); end if;
  select org_id into v_org from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id;
  insert into public.integration_webhook_events(provider, event_id, event_type, org_id, ref, status, detail)
    values ('whatsapp', left(p_event_id, 160), left(coalesce(p_type, 'status'), 60), v_org, left(p_ref, 120), left(p_status, 40),
            coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('recipient_tail', right(regexp_replace(coalesce(p_recipient, ''), '\D', '', 'g'), 4))))
  on conflict (provider, event_id) do nothing returning id into v_id;
  return jsonb_build_object('result', case when v_id is null then 'replay' else 'recorded' end, 'org_id', v_org);
end $$;
revoke all on function public.wa_record_event(text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.wa_record_event(text, text, text, text, text, text, jsonb) to service_role;

create or replace function public.wa_set_opt_out(p_phone_number_id text, p_phone text, p_opted_out boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_org uuid; v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if v_phone !~ '^[0-9]{8,15}$' then return jsonb_build_object('result', 'ignored'); end if;
  select org_id into v_org from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id;
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out, source, updated_at)
    values (v_phone, v_org, coalesce(p_opted_out, true), 'reply', now())
  on conflict (phone, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set opted_out = excluded.opted_out, updated_at = now();
  return jsonb_build_object('result', 'recorded', 'opted_out', coalesce(p_opted_out, true));
end $$;
revoke all on function public.wa_set_opt_out(text, text, boolean) from public, anon, authenticated;
grant execute on function public.wa_set_opt_out(text, text, boolean) to service_role;

-- my studio's integration summary for the Settings panel (admin only, non-secret)
create or replace function public.my_integration_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id(); w public.org_whatsapp_accounts;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    return jsonb_build_object('is_admin', false); end if;
  select * into w from public.org_whatsapp_accounts where org_id = v_org;
  return jsonb_build_object('is_admin', true, 'org_id', v_org,
    'vault', to_regclass('vault.decrypted_secrets') is not null,
    'razorpay', null::jsonb,
    'whatsapp', case when w.org_id is null then null else jsonb_build_object('waba_id', w.waba_id, 'phone_number_id', w.phone_number_id, 'display_phone', w.display_phone, 'status', w.status, 'quality', w.quality, 'last_error', w.last_error, 'connected_at', w.connected_at) end);
end $$;
revoke all on function public.my_integration_accounts() from public, anon;
grant execute on function public.my_integration_accounts() to authenticated, service_role;

-- ===================== PART B: 0132 =====================
-- ============================================================================
-- 0132_assignment_notify.sql - CANONICAL forward-only. Tell people when work is assigned to them.
-- REQUIRES base run_sheet_items / event_tasks / crew_members / work_tokens, 0012 (_work_token_live),
--          0016 + 0035 (chat, event group = chat_conversations.quote_id), 0040 (quotes.deleted_at),
--          0049 (has_area 'runsheet'), 0078 (_comms_cfg: studio_whatsapp), 0117 (whatsapp_opt_outs).
--
-- In plain words (marker: helm-0132-assign-notify):
--   * When a run-sheet line gets an Owner (or its owner/activity/time/place changes), or an
--     event task gets/changes its assignee, the row is stamped assign_changed_at = now(). The
--     person's own task link (work.html?token=...) reads that stamp through the new
--     worker_assignment_updates(token) and shows an "Updated" badge + their run-sheet lines.
--   * At the same moment ONE WhatsApp message is QUEUED in the new assign_notify_outbox:
--       "Hi <name>, <event>: you've been assigned '<activity>' at <time> (<place>). Open your link: <url>"
--     Nothing is sent by the database. comms-dispatch picks the row up only when the studio has
--     WhatsApp switched on (HELM_COMMS_ENABLED + studio_whatsapp set) and the number has not
--     opted out; until then rows simply expire as 'skipped' after one day. Queueing can NEVER
--     make the save fail (every step is wrapped; on any problem the save goes through, no message).
--   * Dedupe: editing the same line for the same person again within 10 minutes updates the one
--     queued message instead of adding another (and never re-sends one that already went).
--   * runsheet_group_status(quote) / runsheet_post_to_group(item, action) let the run-sheet form
--     post "<who> added '<activity>' at <time> -> @<owner>" into THAT event's own team chat group
--     (only the group of the item's own event, only for a caller who is a member of it).
--
-- Owner matching: run_sheet_items.owner is a free-text name picked from the Staff list. It is
-- matched to exactly ONE active crew member of the same studio by name (case-insensitive);
-- vendors / unknown / ambiguous names get the badge-free path (no message, nothing breaks).
--
-- ZERO DATA LOSS: additive + idempotent. Two NEW nullable columns, one NEW table, new functions,
-- two new triggers. No DROP of data / DELETE / TRUNCATE, no existing function body is changed.
-- Safe to run twice. ASCII only.
-- ============================================================================

do $$ begin
  if to_regclass('public.run_sheet_items') is null then raise exception '0132: run_sheet_items is not installed'; end if;
  if to_regclass('public.event_tasks') is null then raise exception '0132: event_tasks is not installed'; end if;
  if to_regclass('public.crew_members') is null then raise exception '0132: crew_members is not installed'; end if;
  if to_regclass('public.work_tokens') is null then raise exception '0132: work_tokens is not installed'; end if;
  if to_regprocedure('public._work_token_live(uuid)') is null then raise exception '0132: 0012 (_work_token_live) is not installed'; end if;
  if to_regprocedure('public._comms_cfg(uuid)') is null then raise exception '0132: 0078 (_comms_cfg) is not installed'; end if;
  if to_regclass('public.whatsapp_opt_outs') is null then raise exception '0132: 0117 (whatsapp_opt_outs) is not installed'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0132: has_area is not installed'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'quote_id') then
    raise exception '0132: 0035 (event groups) is not installed';
  end if;
end $$;

-- ---- 1) columns (nullable, no default rewrite) ----------------------------------------------
alter table public.run_sheet_items add column if not exists assign_changed_at timestamptz;
alter table public.event_tasks     add column if not exists assign_changed_at timestamptz;

-- ---- 2) outbox -------------------------------------------------------------------------------
create table if not exists public.assign_notify_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid references public.quotes(id) on delete cascade,
  item_kind   text not null check (item_kind in ('runsheet', 'task')),
  item_id     uuid not null,
  phone       text not null check (phone ~ '^[0-9]{8,15}$'),
  name        text check (name is null or char_length(name) <= 120),
  body        text not null check (char_length(body) between 1 and 900),
  link_path   text check (link_path is null or link_path ~ '^work\.html\?token=[0-9a-f-]{36}$'),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists assign_notify_outbox_pending132 on public.assign_notify_outbox(created_at) where sent_at is null;
create index if not exists assign_notify_outbox_item132 on public.assign_notify_outbox(item_id, phone, created_at desc);

alter table public.assign_notify_outbox enable row level security;
revoke all on table public.assign_notify_outbox from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.assign_notify_outbox from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.assign_notify_outbox from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.assign_notify_outbox to service_role'; end if;
end $$;

-- ---- 3) helpers (internal) -------------------------------------------------------------------
-- digits only; a bare 10-digit (or 0 + 10-digit) number is taken as Indian (+91)
create or replace function public._assign132_phone(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when d ~ '^0[0-9]{10}$' then '91' || substr(d, 2)
    when d ~ '^[0-9]{10}$' then '91' || d
    when d ~ '^[0-9]{8,15}$' then d
    else null end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x;
$$;
revoke all on function public._assign132_phone(text) from public;

-- queue (or refresh) one message; returns true when a row was queued/refreshed
create or replace function public._assign132_enqueue(p_org uuid, p_quote uuid, p_kind text, p_item uuid,
  p_phone text, p_name text, p_activity text, p_when text, p_location text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- helm-0132-assign-notify
declare v_phone text := public._assign132_phone(p_phone); q record; v_tok uuid; v_body text; v_link text; v_prev record;
begin
  if p_org is null or p_quote is null or p_item is null or v_phone is null then return false; end if;
  select qq.id, qq.code, qq.title, qq.status, qq.event_date, qq.deleted_at, qq.lifecycle_stage into q
    from public.quotes qq where qq.id = p_quote and qq.org_id = p_org;
  if q.id is null or q.deleted_at is not null or coalesce(q.status, '') = 'cancelled'
     or coalesce(q.lifecycle_stage, '') = 'closed' or (q.event_date is not null and q.event_date < current_date) then
    return false;
  end if;
  -- the person's own live task link for this event, if the office has issued one
  select wt.token into v_tok from public.work_tokens wt
   where wt.quote_id = p_quote and wt.org_id = p_org and public._assign132_phone(wt.phone) = v_phone
     and wt.revoked_at is null and (wt.expires_at is null or wt.expires_at > now())
   order by wt.created_at desc limit 1;
  v_link := case when v_tok is not null then 'work.html?token=' || v_tok::text end;
  v_body := 'Hi ' || coalesce(nullif(btrim(p_name), ''), 'there') || ', '
         || coalesce(nullif(nullif(btrim(q.title), ''), 'Untitled event'), q.code)
         || ': you''ve been assigned ''' || left(coalesce(nullif(btrim(p_activity), ''), 'a task'), 200) || ''''
         || case when nullif(btrim(p_when), '') is not null then ' at ' || btrim(p_when) else '' end
         || case when nullif(btrim(p_location), '') is not null then ' (' || left(btrim(p_location), 120) || ')' else '' end
         || '.' || case when v_link is not null then ' Open your link:' else ' Please check with the office for details.' end;
  v_body := left(regexp_replace(v_body, '[[:cntrl:]<>]', ' ', 'g'), 880);
  perform pg_advisory_xact_lock(hashtextextended('helm.assign132:' || p_item::text || ':' || v_phone, 0));
  select o.id, o.status, o.claimed_at, o.sent_at into v_prev from public.assign_notify_outbox o
   where o.item_id = p_item and o.phone = v_phone and o.created_at > now() - interval '10 minutes'
   order by o.created_at desc limit 1;
  if v_prev.id is not null then
    if v_prev.status = 'pending' and v_prev.sent_at is null and v_prev.claimed_at is null then
      update public.assign_notify_outbox set body = v_body, link_path = v_link, name = left(p_name, 120), updated_at = now()
       where id = v_prev.id and claimed_at is null and sent_at is null;
      return true;
    end if;
    return false;   -- one message per item + person per 10 minutes
  end if;
  insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body, link_path, created_by)
    values (p_org, p_quote, p_kind, p_item, v_phone, left(nullif(btrim(p_name), ''), 120), v_body, v_link, auth.uid());
  return true;
end $$;
revoke all on function public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text) from authenticated'; end if;
end $$;

-- ---- 4) triggers: stamp + queue (never block the save) -----------------------------------------
create or replace function public.tg_runsheet_assign132()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0132-assign-notify
declare v_org uuid; v_n integer; v_phone text; v_name text;
begin
  if nullif(btrim(coalesce(new.owner, '')), '') is null then return new; end if;
  if tg_op = 'UPDATE' and (new.owner, new.title, new.start_time, new.location, new.duration_min)
       is not distinct from (old.owner, old.title, old.start_time, old.location, old.duration_min) then
    return new;
  end if;
  new.assign_changed_at := now();
  begin
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    select count(*), min(cm.phone), min(cm.name) into v_n, v_phone, v_name from public.crew_members cm
     where cm.org_id = v_org and cm.active and lower(btrim(cm.name)) = lower(btrim(new.owner));
    if v_n = 1 then
      perform public._assign132_enqueue(v_org, new.quote_id, 'runsheet', new.id, v_phone, v_name, new.title,
        to_char(new.start_time, 'HH24:MI'), new.location);
    end if;
  exception when others then
    raise warning 'helm-0132: run-sheet notify skipped (%)', sqlstate;
  end;
  return new;
end $$;
revoke all on function public.tg_runsheet_assign132() from public;

create or replace function public.tg_task_assign132()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0132-assign-notify
declare v_org uuid; v_tz text; v_phone text; v_name text; v_when text;
begin
  if tg_op = 'UPDATE' and (new.assignee_phone, new.assignee_name, new.crew_id, new.title, new.planned_start)
       is not distinct from (old.assignee_phone, old.assignee_name, old.crew_id, old.title, old.planned_start) then
    return new;
  end if;
  v_phone := nullif(btrim(coalesce(new.assignee_phone, '')), '');
  v_name := new.assignee_name;
  begin
    select q.org_id into v_org from public.quotes q where q.id = new.quote_id;
    if v_phone is null and new.crew_id is not null then
      select cm.phone, coalesce(v_name, cm.name) into v_phone, v_name from public.crew_members cm
       where cm.id = new.crew_id and cm.org_id = v_org;
    end if;
  exception when others then v_phone := null;
  end;
  if v_phone is null then return new; end if;
  new.assign_changed_at := now();
  begin
    select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
    v_when := case when new.planned_start is not null
                   then to_char(new.planned_start at time zone coalesce(v_tz, 'Asia/Kolkata'), 'DD Mon HH24:MI') end;
    perform public._assign132_enqueue(v_org, new.quote_id, 'task', new.id, v_phone, v_name, new.title, v_when, null);
  exception when others then
    raise warning 'helm-0132: task notify skipped (%)', sqlstate;
  end;
  return new;
end $$;
revoke all on function public.tg_task_assign132() from public;

drop trigger if exists zz_runsheet_assign132 on public.run_sheet_items;
create trigger zz_runsheet_assign132 before insert or update of owner, title, start_time, location, duration_min
  on public.run_sheet_items for each row execute function public.tg_runsheet_assign132();
drop trigger if exists zz_task_assign132 on public.event_tasks;
create trigger zz_task_assign132 before insert or update of assignee_phone, assignee_name, crew_id, title, planned_start
  on public.event_tasks for each row execute function public.tg_task_assign132();

-- ---- 5) dispatcher RPCs (service role only) ---------------------------------------------------
create or replace function public.assign_notify_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0132-assign-notify: gates re-checked at claim time
declare r record; v_out jsonb := '[]'::jsonb; v_ok boolean; v_cfg jsonb;
begin
  update public.assign_notify_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  update public.assign_notify_outbox set status = 'skipped', sent_at = now() where sent_at is null and created_at < now() - interval '1 day';
  for r in select o.* from public.assign_notify_outbox o
     where o.sent_at is null and o.status = 'pending' and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
       and o.updated_at < now() - interval '1 minute'          -- let a burst of edits settle first
     order by o.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    v_cfg := public._comms_cfg(r.org_id);
    v_ok := coalesce(v_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$'
      and not exists (select 1 from public.whatsapp_opt_outs x where x.phone = r.phone and x.opted_out
                        and (x.org_id is null or x.org_id = r.org_id))
      and exists (select 1 from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id and q.deleted_at is null
                    and coalesce(q.status, '') <> 'cancelled')
      and case r.item_kind
            when 'runsheet' then exists (select 1 from public.run_sheet_items i where i.id = r.item_id and i.quote_id = r.quote_id)
            when 'task' then exists (select 1 from public.event_tasks t where t.id = r.item_id and t.quote_id = r.quote_id)
            else false end;
    if not coalesce(v_ok, false) then
      update public.assign_notify_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.assign_notify_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', r.phone, 'text', r.body, 'link_path', r.link_path));
  end loop;
  return v_out;
end $$;

create or replace function public.assign_notify_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.assign_notify_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.assign_notify_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

do $$ declare f text; begin
  foreach f in array array['public.assign_notify_claim(integer)', 'public.assign_notify_mark(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 6) the person's own link: what changed for me --------------------------------------------
create or replace function public.worker_assignment_updates(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- helm-0132-assign-notify: token-scoped (same liveness gate as worker_get_tasks)
declare w public.work_tokens; v_phone text; rs jsonb; tk jsonb;
begin
  w := public._work_token_live(p_token);
  v_phone := public._assign132_phone(w.phone);
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'start_time', to_char(i.start_time, 'HH24:MI'),
           'duration_min', i.duration_min, 'location', i.location, 'note', i.note, 'changed_at', i.assign_changed_at)
           order by i.start_time nulls last, i.seq), '[]'::jsonb) into rs
    from public.run_sheet_items i
   where i.quote_id = w.quote_id and nullif(btrim(coalesce(i.owner, '')), '') is not null
     and (lower(btrim(i.owner)) = lower(btrim(coalesce(w.name, '')))
          or exists (select 1 from public.crew_members cm
                      where cm.org_id = w.org_id and cm.active and lower(btrim(cm.name)) = lower(btrim(i.owner))
                        and public._assign132_phone(cm.phone) = v_phone));
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'changed_at', t.assign_changed_at)), '[]'::jsonb) into tk
    from public.event_tasks t
   where t.quote_id = w.quote_id and t.assignee_phone = w.phone and t.assign_changed_at is not null;
  return jsonb_build_object('runsheet', rs, 'tasks', tk);
end $$;
revoke all on function public.worker_assignment_updates(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.worker_assignment_updates(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.worker_assignment_updates(uuid) to authenticated'; end if;
end $$;

-- ---- 7) run-sheet -> the event's own team chat group ------------------------------------------
create or replace function public.runsheet_group_status(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_id uuid;
begin
  if v_me is null or v_org is null or not public.has_area('runsheet', 'view') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select c.id into v_id from public.chat_conversations c where c.quote_id = p_quote and c.org_id = v_org;
  return jsonb_build_object('has_group', v_id is not null,
    'member', v_id is not null and exists (select 1 from public.chat_members m where m.conversation_id = v_id and m.user_id = v_me));
end $$;

create or replace function public.runsheet_post_to_group(p_item uuid, p_action text default 'added')
returns text language plpgsql volatile security definer set search_path = '' as $$
-- helm-0132-assign-notify: posts only into the item's OWN event group, only for a member
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); i record; v_conv uuid; v_who text;
        v_body text; v_meta jsonb; v_mention uuid; v_n integer;
begin
  if v_me is null or v_org is null or not public.has_area('runsheet', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select ri.id, ri.quote_id, ri.title, ri.owner, ri.start_time into i
    from public.run_sheet_items ri join public.quotes q on q.id = ri.quote_id
   where ri.id = p_item and q.org_id = v_org;
  if i.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select c.id into v_conv from public.chat_conversations c where c.quote_id = i.quote_id and c.org_id = v_org;
  if v_conv is null then return 'no_group'; end if;
  if not exists (select 1 from public.chat_members m where m.conversation_id = v_conv and m.user_id = v_me) then return 'not_member'; end if;
  select coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1), 'Someone') into v_who
    from public.profiles p where p.id = v_me;
  v_body := coalesce(v_who, 'Someone') || case when p_action = 'updated' then ' updated ''' else ' added ''' end
         || left(coalesce(i.title, ''), 200) || ''''
         || case when i.start_time is not null then ' at ' || to_char(i.start_time, 'HH24:MI') else '' end
         || case when nullif(btrim(coalesce(i.owner, '')), '') is not null then ' -> @' || left(btrim(i.owner), 80) else '' end;
  v_body := left(regexp_replace(v_body, '[[:cntrl:]]', ' ', 'g'), 500);
  -- @mention the owner when they are a signed-in member of this group (bell ping via 0035)
  if nullif(btrim(coalesce(i.owner, '')), '') is not null then
    select count(*), min(m.user_id::text)::uuid into v_n, v_mention
      from public.chat_members m join public.profiles p on p.id = m.user_id
     where m.conversation_id = v_conv and p.org_id = v_org and lower(btrim(coalesce(p.full_name, ''))) = lower(btrim(i.owner));
    if v_n <> 1 then v_mention := null; end if;
  end if;
  v_meta := case when v_mention is not null and v_mention <> v_me then jsonb_build_object('mentions', jsonb_build_array(v_mention)) end;
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, meta)
    values (v_conv, v_org, v_me, 'text', v_body, v_meta);
  update public.chat_conversations set last_message_at = now() where id = v_conv;
  return 'posted';
end $$;

do $$ declare f text; begin
  foreach f in array array['public.runsheet_group_status(uuid)', 'public.runsheet_post_to_group(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY 0117w + 0132 (read-only; expect every ok = true)
select '0117w org_whatsapp_accounts exists' as item, to_regclass('public.org_whatsapp_accounts') is not null as ok
union all select '0117w whatsapp_opt_outs exists', to_regclass('public.whatsapp_opt_outs') is not null
union all select '0117w integration_webhook_events exists', to_regclass('public.integration_webhook_events') is not null
union all select '0117w RLS on org_whatsapp_accounts', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.org_whatsapp_accounts')), false)
union all select '0117w RLS on whatsapp_opt_outs', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.whatsapp_opt_outs')), false)
union all select '0117w RLS on integration_webhook_events', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.integration_webhook_events')), false)
union all select '0117w token_secret_id not readable by authenticated', not has_column_privilege('authenticated', 'public.org_whatsapp_accounts', 'token_secret_id', 'select')
union all select '0117w opt_outs not readable by authenticated', not has_table_privilege('authenticated', 'public.whatsapp_opt_outs', 'select')
union all select '0117w save_org_whatsapp_account callable by authenticated', has_function_privilege('authenticated', 'public.save_org_whatsapp_account(text, text, text, text)', 'execute')
union all select '0117w org_whatsapp_creds not callable by authenticated', not has_function_privilege('authenticated', 'public.org_whatsapp_creds(uuid)', 'execute')
union all select '0117w vault_get not callable by authenticated', not has_function_privilege('authenticated', 'public._integ_vault_get(uuid)', 'execute')
union all select '0117w mark_org_integration not callable by authenticated', not has_function_privilege('authenticated', 'public.mark_org_integration(uuid, text, text, text)', 'execute')
union all select '0117w set_org_integration_status exists', to_regprocedure('public.set_org_integration_status(text, text)') is not null
union all select '0117w wa_record_event + wa_set_opt_out exist', to_regprocedure('public.wa_record_event(text, text, text, text, text, text, jsonb)') is not null and to_regprocedure('public.wa_set_opt_out(text, text, boolean)') is not null
union all select '0117w my_integration_accounts exists', to_regprocedure('public.my_integration_accounts()') is not null
union all select '0132 run_sheet_items.assign_changed_at exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'run_sheet_items' and column_name = 'assign_changed_at')
union all select '0132 event_tasks.assign_changed_at exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'assign_changed_at')
union all select '0132 assign_notify_outbox exists', to_regclass('public.assign_notify_outbox') is not null
union all select '0132 outbox RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.assign_notify_outbox')), false)
union all select '0132 outbox not readable by anon', not has_table_privilege('anon', 'public.assign_notify_outbox', 'select')
union all select '0132 outbox not writable by authenticated', not has_table_privilege('authenticated', 'public.assign_notify_outbox', 'insert')
union all select '0132 run-sheet trigger installed', exists (select 1 from pg_trigger where tgname = 'zz_runsheet_assign132' and tgrelid = 'public.run_sheet_items'::regclass)
union all select '0132 task trigger installed', exists (select 1 from pg_trigger where tgname = 'zz_task_assign132' and tgrelid = 'public.event_tasks'::regclass)
union all select '0132 enqueue not callable by authenticated', not has_function_privilege('authenticated', 'public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text)', 'execute')
union all select '0132 claim not callable by anon', not has_function_privilege('anon', 'public.assign_notify_claim(integer)', 'execute')
union all select '0132 claim not callable by authenticated', not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute')
union all select '0132 mark not callable by authenticated', not has_function_privilege('authenticated', 'public.assign_notify_mark(uuid, text)', 'execute')
union all select '0132 worker updates callable by anon (token link)', has_function_privilege('anon', 'public.worker_assignment_updates(uuid)', 'execute')
union all select '0132 group post not callable by anon', not has_function_privilege('anon', 'public.runsheet_post_to_group(uuid, text)', 'execute')
union all select '0132 group post callable by authenticated', has_function_privilege('authenticated', 'public.runsheet_post_to_group(uuid, text)', 'execute')
union all select '0132 group status not callable by anon', not has_function_privilege('anon', 'public.runsheet_group_status(uuid)', 'execute')
union all select '0132 phone: 10 digits -> +91', public._assign132_phone('98765 43210') = '919876543210'
union all select '0132 phone: garbage -> null', public._assign132_phone('abc') is null
union all select '0132 nothing sent yet by the database (outbox only)', coalesce(pg_get_functiondef(to_regprocedure('public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text)')) not like '%http%', false);
