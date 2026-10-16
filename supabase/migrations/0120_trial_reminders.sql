-- ============================================================================
-- 0120_trial_reminders.sql - CANONICAL forward-only. Reminders for the 8-day free trial.
-- REQUIRES 0036 (notifications.org_id / bell), 0045 (studio_subscriptions), 0058 (trial bell kind
--          'trial_reminder' + _trial_paid + _trial_refresh), 0116 (organizations.trial_ends_at),
--          0119 (unified 8-day trial, my_trial_org with trial_mode).
--
-- In plain words:
--   * A studio on the 8-day free trial (organizations.trial_ends_at, no card) is reminded THREE times,
--     counted in the STUDIO's own time zone (organizations.timezone):
--       d5  "3 days left in your free trial"   - the calendar day 3 days before the trial ends
--       d7  "Your free trial ends tomorrow"    - the calendar day before the trial ends
--       d8  "Your trial ends today"             - the calendar day the trial ends (last day)
--   * trial_reminders_tick() (SECURITY DEFINER, service role / pg_cron only, hourly) records ONE
--     row per studio per milestone per trial end in public.trial_reminders (UNIQUE dedupe_key)
--     and, only when that row is new, drops ONE bell notification (kind 'trial_reminder', the
--     0058 kind: catalog type billing_trial -> shown to admins only, RLS tr58_* already keeps it
--     admin-readable and never client-written). Running it again never duplicates anything.
--     A missed hour/day is not "caught up": only the milestone that is due TODAY is recorded.
--   * E-mail (DORMANT): every new trial_reminders row is also an e-mail waiting to go out
--     (email_status 'pending'). Nothing sends it until the owner deploys comms-dispatch and sets
--     HELM_COMMS_ENABLED=true; it then claims rows with trial_reminder_email_claim() (service role
--     only) which re-checks each row (still on trial, same end date, not paid, < 2 days old, valid
--     address) - anything stale is marked 'skipped', never sent. So no backlog is blasted later.
--   * The old 0058 job (_trial_refresh: 7 / 3 / 1 day e-mails worded for the 14-day trial) no longer
--     queues reminders for these 8-day studios (organizations.trial_ends_at set) - they get the
--     0120 reminders instead. Its past_due step and every other studio are unchanged.
--   * my_trial_org() also returns the studio time zone (the in-app reminder card uses it).
--
-- ZERO DATA LOSS: additive + idempotent. One NEW table, new functions, one cron job (only when
-- pg_cron is already installed). No DROP / DELETE / TRUNCATE, no existing row is changed.
-- _trial_refresh and my_trial_org are re-issued with the same signatures and grants. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._trial_paid(uuid)') is null or to_regprocedure('public._trial_refresh()') is null then
    raise exception '0120: apply 0058 (trial reminders) first'; end if;
  if to_regprocedure('public.my_trial_org()') is null or to_regprocedure('public._trial_days()') is null then
    raise exception '0120: apply 0116 + 0119 (8-day trial) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'organizations' and column_name = 'trial_ends_at') then
    raise exception '0120: organizations.trial_ends_at (0116) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'notifications' and column_name = 'org_id') then
    raise exception '0120: notifications.org_id is missing'; end if;
end $$;

-- ---- 1) the ledger / e-mail outbox ---------------------------------------------------------------
create table if not exists public.trial_reminders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  milestone        text not null check (milestone in ('d5', 'd7', 'd8')),
  trial_ends_at    timestamptz not null,
  dedupe_key       text not null check (char_length(dedupe_key) <= 200),
  email_status     text not null default 'pending' check (email_status in ('pending', 'sent', 'skipped', 'failed')),
  email_attempts   integer not null default 0,
  email_claimed_at timestamptz,
  email_sent_at    timestamptz,
  created_at       timestamptz not null default now()
);
create unique index if not exists trial_reminders_dedupe_key120 on public.trial_reminders(dedupe_key);
create index if not exists trial_reminders_email_pending120 on public.trial_reminders(created_at) where email_sent_at is null;

alter table public.trial_reminders enable row level security;
revoke all on table public.trial_reminders from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.trial_reminders from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.trial_reminders from authenticated'; end if;
end $$;
-- no policies: only SECURITY DEFINER functions and the service role touch this table

-- ---- 2) pure helpers ---------------------------------------------------------------------------
-- which milestone is due "today" in the studio's zone (null = none). JS mirror: trial.js reminderMilestone
create or replace function public._trial_reminder_milestone(p_ends timestamptz, p_now timestamptz, p_tz text)
returns text language plpgsql stable set search_path = '' as $$
-- trial-reminders-0120
declare v_tz text := coalesce(nullif(btrim(p_tz), ''), 'Asia/Kolkata'); v_left integer;
begin
  if p_ends is null or p_now is null or p_ends <= p_now then return null; end if;
  begin
    v_left := ((p_ends - interval '1 microsecond') at time zone v_tz)::date - (p_now at time zone v_tz)::date;
  exception when others then
    v_left := ((p_ends - interval '1 microsecond') at time zone 'Asia/Kolkata')::date - (p_now at time zone 'Asia/Kolkata')::date;
  end;
  return case v_left when 3 then 'd5' when 1 then 'd7' when 0 then 'd8' else null end;
end $$;

-- one per studio per milestone per trial end (an HQ extension = a new end = new reminders)
create or replace function public._trial_reminder_key(p_org uuid, p_milestone text, p_ends timestamptz)
returns text language sql immutable set search_path = '' as $$
  select 'trial120:' || p_org::text || ':' || p_milestone || ':' || to_char(p_ends at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI');
$$;

create or replace function public._trial_reminder_label(p_milestone text)
returns text language sql immutable set search_path = '' as $$
  select case p_milestone
    when 'd5' then '3 days left in your free trial'
    when 'd7' then 'Your free trial ends tomorrow'
    when 'd8' then 'Your trial ends today'
    else 'Free trial update' end;
$$;

-- ---- 3) the tick (pg_cron hourly / service role) -------------------------------------------------
create or replace function public.trial_reminders_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-reminders-0120: service role / pg_cron only (EXECUTE granted to service_role alone)
declare o record; v_m text; v_id uuid; n integer := 0;
begin
  for o in
    select org.id, org.trial_ends_at, coalesce(nullif(btrim(org.timezone), ''), 'Asia/Kolkata') as tz
      from public.organizations org
      left join public.studio_subscriptions s on s.org_id = org.id
     where org.trial_ends_at is not null
       and org.trial_ends_at > now() and org.trial_ends_at <= now() + interval '5 days'
       and coalesce(s.status, 'trial') = 'trial'
  loop
    begin
      if public._trial_paid(o.id) then continue; end if;
      v_m := public._trial_reminder_milestone(o.trial_ends_at, now(), o.tz);
      if v_m is null then continue; end if;
      v_id := null;
      insert into public.trial_reminders(org_id, milestone, trial_ends_at, dedupe_key)
        values (o.id, v_m, o.trial_ends_at, public._trial_reminder_key(o.id, v_m, o.trial_ends_at))
        on conflict (dedupe_key) do nothing
        returning id into v_id;
      if v_id is not null then
        n := n + 1;
        begin   -- the bell row must never block the ledger row
          insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
            values (null, 'in_app', 'trial_reminder', 'simulated',
                    jsonb_build_object('trial', 'trial_' || v_m, 'milestone', v_m, 'label', public._trial_reminder_label(v_m),
                                       'ends_at', o.trial_ends_at, 'source', '0120'),
                    o.id);
        exception when others then raise warning 'trial-reminders-0120: bell row skipped (%)', sqlstate;
        end;
      end if;
    exception when others then raise warning 'trial-reminders-0120: studio skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('trial_reminders_new', n);
end $$;

-- ---- 4) e-mail claim / mark (service role; comms-dispatch, DORMANT until HELM_COMMS_ENABLED) -----
create or replace function public.trial_reminder_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-reminders-0120
declare r record; v_out jsonb := '[]'::jsonb; v_to text; v_ok boolean;
  v_re constant text := '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$';
begin
  update public.trial_reminders set email_status = 'failed', email_sent_at = now()
   where email_sent_at is null and email_attempts >= 5;
  update public.trial_reminders set email_status = 'skipped', email_sent_at = now()
   where email_sent_at is null and created_at < now() - interval '2 days';
  for r in
    select tr.id, tr.org_id, tr.milestone, tr.trial_ends_at, o.name, o.business_email, o.created_by,
           o.trial_ends_at as cur_end, coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') as tz
      from public.trial_reminders tr join public.organizations o on o.id = tr.org_id
     where tr.email_sent_at is null and tr.email_status = 'pending'
       and (tr.email_claimed_at is null or tr.email_claimed_at < now() - interval '10 minutes')
     order by tr.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of tr skip locked
  loop
    -- re-check at send time: still the same trial, not over, not paid, still on trial
    v_ok := r.cur_end is not null and r.cur_end = r.trial_ends_at and r.cur_end > now()
            and not public._trial_paid(r.org_id)
            and coalesce((select s.status from public.studio_subscriptions s where s.org_id = r.org_id), 'trial') = 'trial';
    v_to := case when coalesce(r.business_email, '') ~ v_re then r.business_email
                 else (select u.email from auth.users u where u.id = r.created_by) end;
    if not coalesce(v_ok, false) or coalesce(v_to, '') !~ v_re then
      update public.trial_reminders set email_status = 'skipped', email_sent_at = now() where id = r.id;
      continue;
    end if;
    update public.trial_reminders set email_claimed_at = now(), email_attempts = email_attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', v_to, 'milestone', r.milestone,
      'studio', coalesce(r.name, ''), 'ends_at', r.trial_ends_at, 'timezone', r.tz));
  end loop;
  return v_out;
end $$;

create or replace function public.trial_reminder_email_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- trial-reminders-0120
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.trial_reminders set email_claimed_at = null where id = p_id and email_sent_at is null;
    return 'pending';
  end if;
  update public.trial_reminders set email_status = p_status, email_sent_at = now() where id = p_id and email_sent_at is null;
  return p_status;
end $$;

-- ---- 5) 0058 job: no 14-day-worded 7/3/1 reminders for 8-day trial studios ------------------------
-- 0058 body; step (b) skips studios with organizations.trial_ends_at (0120 reminds them). Step (a) unchanged.
create or replace function public._trial_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-reminders-0058 trial-reminders-0120
declare n_pd int := 0; n_rem int := 0; rec record; v_kind text; v_id uuid;
begin
  for rec in
    select s.org_id, s.trial_ends_at from public.studio_subscriptions s
     where s.status = 'trial' and s.trial_ends_at is not null and s.trial_ends_at < current_date
       and not public._trial_paid(s.org_id)
     for update of s
  loop
    update public.studio_subscriptions set status = 'past_due', updated_at = now()
     where org_id = rec.org_id and status = 'trial';
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'billing.trial_ended_past_due', 'studio_subscriptions', rec.org_id::text,
              jsonb_build_object('trial_ends_at', rec.trial_ends_at), rec.org_id, now());
    n_pd := n_pd + 1;
  end loop;

  for rec in
    select s.org_id, s.status, s.trial_ends_at, (s.trial_ends_at - current_date) as d
      from public.studio_subscriptions s
     where s.trial_ends_at is not null and not public._trial_paid(s.org_id)
       and not exists (select 1 from public.organizations o where o.id = s.org_id and o.trial_ends_at is not null)
       and ((s.status = 'trial' and s.trial_ends_at between current_date and current_date + 7)
         or (s.status = 'past_due' and s.current_period_end is null
             and s.trial_ends_at < current_date and s.trial_ends_at >= current_date - 14))
  loop
    v_kind := case when rec.status = 'past_due' then 'trial_ended'
                   when rec.d <= 1 then 'trial_1d' when rec.d <= 3 then 'trial_3d' else 'trial_7d' end;
    v_id := null;
    insert into public.billing_reminders(org_id, kind, period_end) values (rec.org_id, v_kind, rec.trial_ends_at)
      on conflict (org_id, kind, period_end) do nothing
      returning id into v_id;
    if v_id is not null then
      n_rem := n_rem + 1;
      begin
        insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
          values (null, 'in_app', 'trial_reminder', 'simulated',
                  jsonb_build_object('trial', v_kind, 'label', public._trial_label(v_kind),
                                     'days_left', greatest(rec.d, 0), 'ends_at', rec.trial_ends_at),
                  rec.org_id);
      exception when others then null;
      end;
    end if;
  end loop;
  return jsonb_build_object('trial_past_due_set', n_pd, 'trial_reminders_queued', n_rem);
end $$;

-- ---- 6) my_trial_org: + timezone (0119 body otherwise) ----------------------------------------------
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119 trial-reminders-0120
declare v_org uuid := public.current_org_id(); o public.organizations; v_locked boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org;
  if o.trial_ends_at is null then
    return jsonb_build_object('is_trial_org', false, 'is_admin', coalesce(public.is_admin(), false));
  end if;
  v_locked := public._trial_locked(v_org);
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', o.trial_ends_at,
    'days_left', greatest(0, ceil(extract(epoch from (o.trial_ends_at - now())) / 86400.0))::int,
    'ended', o.trial_ends_at <= now(), 'locked', v_locked, 'trial_mode', o.trial_mode,
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'),
    'is_admin', coalesce(public.is_admin(), false));
end $$;

-- ---- 7) privileges -----------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public._trial_reminder_milestone(timestamptz, timestamptz, text)', 'public._trial_reminder_key(uuid, text, timestamptz)',
    'public._trial_reminder_label(text)', 'public.trial_reminders_tick()', 'public.trial_reminder_email_claim(integer)',
    'public.trial_reminder_email_mark(uuid, text)', 'public._trial_refresh()', 'public.my_trial_org()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_trial_org() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.my_trial_org() to service_role';
    execute 'grant execute on function public.trial_reminders_tick() to service_role';
    execute 'grant execute on function public.trial_reminder_email_claim(integer) to service_role';
    execute 'grant execute on function public.trial_reminder_email_mark(uuid, text) to service_role';
  end if;
end $$;

-- ---- 8) pg_cron hourly, ONLY if it is already installed (never created here) ----------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_trial_reminders') then
        perform cron.schedule('helm_trial_reminders', '7 * * * *', 'select public.trial_reminders_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_trial_reminders could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  else
    raise notice '0120: pg_cron not installed - run select public.trial_reminders_tick() hourly from a service caller';
  end if;
end $$;

notify pgrst, 'reload schema';
