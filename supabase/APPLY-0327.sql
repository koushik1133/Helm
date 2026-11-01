-- APPLY-0327.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0327: ..." if an earlier migration it builds on is missing (0045 / 0057 / 0166 / 0183 / 0283).
-- R119 (owner: "make welcome e-mails really work, live"): welcome e-mails become SAFE to switch on.
--   * One switch in the database (helm_welcome_mail_settings.enabled) - OFF after this file. Nothing is sent until the
--     owner runs APPLY-0327-WELCOME-ON.sql.
--   * Only welcomes queued in the last 48 hours can go out; older unsent ones are closed as "expired" (kept, never sent).
--   * Each welcome is re-checked before sending (studio exists, trial not ended, person still a member, one per studio).
--   * Billing reminders: a reminder older than 3 days, or one the studio no longer needs (paid since), is never sent late.
--   Adds two nullable columns + one settings table (switch off); no row, column, table or policy is deleted.
--   Safe to run twice. ASCII only. Independent of 0325 / 0326.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end (8 rows) must say ok = true.
--   2  Redeploy comms-dispatch (it now also sends the welcome e-mails) - see the PR for the exact commands.
--   3  When you are ready: run APPLY-0327-WELCOME-ON.sql (one line). To stop again: run the OFF line in that file.
begin;
-- 0327_r119_welcome_live_safe.sql - CANONICAL forward-only. R119 (owner: "make welcome e-mails really work, live").
-- REQUIRES 0057 (welcome_email_outbox, welcome_email_outbox_claim / _mark), 0045 (billing_reminders, studio_subscriptions,
--          subscription_payments), 0166 (_is_trial_org), 0183 (_trial_locked, _trial_effective_end), 0283 (_r283_is_off).
--
-- In plain words:
--   Welcome e-mails ("Welcome to Helm - <studio> is ready" for a new studio's owner, "You've joined <studio>" for a new
--   teammate) have been QUEUED since 0057 but never sent on production. Switching the sender on as it was would have
--   sent every row queued since 0057 at once - including studios that were deleted and trials that ended long ago.
--   Now, before anything can go out:
--     * ONE switch in the database decides whether welcome e-mails go out at all: helm_welcome_mail_settings.enabled
--       (OFF by default). Flip it with one line of SQL (APPLY-0327-WELCOME-ON.sql); flip it back the same way - nothing
--       to redeploy. Both senders (comms-dispatch, which already runs every few minutes, and welcome-mailer) obey it.
--     * welcome_email_outbox_claim hands out only rows queued in the LAST 48 HOURS (and at least 2 minutes old, so the
--       studio set-up has finished). Every older unsent row is closed as status 'skipped' + skip_reason 'expired' - it is
--       kept, never deleted, and never sent.
--     * Each row is re-checked at claim time: the studio still exists, is not the sample master, its trial has not
--       ended (read-only studio), the person is still a member of that studio and not deactivated, and the studio has
--       not already had an owner welcome. A row that fails is closed as 'skipped' with the reason (no_studio / sample /
--       trial_ended / not_member / duplicate).
--     * The claim also says whether the studio is on its FREE TRIAL right now (+ the trial end) so the e-mail can explain
--       the trial in plain words. Each row carries safe = 'r119-0327': the senders refuse a row without it.
--   Billing reminders (billing-reminder, also dormant): NEW billing_reminder_recheck(id) - a reminder queued more than
--   3 days ago, or one the studio no longer needs (paid since it was queued, the plan moved on, the trial converted), is
--   closed as channel 'skipped' + skip_reason and never sent late. The edge function asks before every send.
-- The 0057 claim body is kept once as welcome_email_outbox_claim__pre0327 with NO app privilege (not even service_role),
-- the house pattern (0298 / 0326).
-- ZERO DATA LOSS: two nullable columns (skip_reason) and one settings table (one row, switch off) are ADDED; no row,
-- column, table or policy is deleted. Rows are only ever closed (sent_at / status / channel / skip_reason), exactly as the
-- senders already did. Additive + idempotent: safe to run twice. ASCII only. Independent of 0325 / 0326.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.welcome_email_outbox') is null or to_regprocedure('public.welcome_email_outbox_claim(integer)') is null
     or to_regprocedure('public.welcome_email_outbox_mark(uuid,text)') is null then
    raise exception 'STOP 0327: welcome e-mails (0057) missing - run 0057 first'; end if;
  if to_regclass('public.billing_reminders') is null or to_regclass('public.studio_subscriptions') is null
     or to_regclass('public.subscription_payments') is null then
    raise exception 'STOP 0327: Helm billing (0045) missing - run 0045 first'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then raise exception 'STOP 0327: trial sandbox (0166) missing'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null or to_regprocedure('public._trial_effective_end(uuid)') is null then
    raise exception 'STOP 0327: trial expiry (0183) missing - run 0183 first'; end if;
  if to_regprocedure('public._r283_is_off(uuid,uuid)') is null then raise exception 'STOP 0327: team safety (0283) missing - run 0283 first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception 'STOP 0327: organizations.is_sample_master missing - run the trial migrations (0166+) first'; end if;
end $$;

-- ---- 1) additive columns + the one switch ---------------------------------------------------------------------
alter table public.welcome_email_outbox add column if not exists skip_reason text;
alter table public.billing_reminders add column if not exists skip_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.welcome_email_outbox'::regclass and conname = 'welcome_email_outbox_skip_reason_chk327') then
    alter table public.welcome_email_outbox add constraint welcome_email_outbox_skip_reason_chk327
      check (skip_reason is null or char_length(skip_reason) <= 40);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.billing_reminders'::regclass and conname = 'billing_reminders_skip_reason_chk327') then
    alter table public.billing_reminders add constraint billing_reminders_skip_reason_chk327
      check (skip_reason is null or char_length(skip_reason) <= 40);
  end if;
end $$;

-- one row; enabled = false until the owner flips it (APPLY-0327-WELCOME-ON.sql)
create table if not exists public.helm_welcome_mail_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.helm_welcome_mail_settings(id, enabled) values (true, false) on conflict (id) do nothing;
alter table public.helm_welcome_mail_settings enable row level security;
revoke all on public.helm_welcome_mail_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.helm_welcome_mail_settings from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.helm_welcome_mail_settings from authenticated; end if;
end $$;

-- ---- 2) keep the 0057 claim body once (__pre0327, no privilege at all) ----------------------------------------
do $$
declare v_pub regprocedure := to_regprocedure('public.welcome_email_outbox_claim(integer)');
        v_pre regprocedure := to_regprocedure('public.welcome_email_outbox_claim__pre0327(integer)');
begin
  if v_pub is not null and v_pre is null
     and position('r119-0327' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
    alter function public.welcome_email_outbox_claim(integer) rename to welcome_email_outbox_claim__pre0327;
  end if;
  v_pre := to_regprocedure('public.welcome_email_outbox_claim__pre0327(integer)');
  if v_pre is not null then
    execute 'revoke all on function ' || v_pre::text || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
  end if;
end $$;

-- ---- 3) the switch (read by the senders before they claim) -----------------------------------------------------
create or replace function public.welcome_email_switch()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r119-0327: true only when the owner switched welcome e-mails on (one row, default off)
  select coalesce((select s.enabled from public.helm_welcome_mail_settings s where s.id), false);
$$;

-- ---- 4) the safe claim -----------------------------------------------------------------------------------------
create or replace function public.welcome_email_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r119-0327: only rows queued in the last 48 hours (and >= 2 minutes old); older unsent rows closed as skipped/expired;
-- each row re-checked (studio exists, not the sample master, trial not ended, person still an active member, one owner
-- welcome per studio); nothing handed out while the switch (helm_welcome_mail_settings.enabled) is off.
declare r record; v_out jsonb := '[]'::jsonb; v_why text; v_end timestamptz; v_trial boolean;
begin
  -- 0057: give up after 5 tries
  update public.welcome_email_outbox set status = 'failed', sent_at = now()
   where sent_at is null and attempts >= 5;
  -- never late: anything queued more than 48 hours ago is closed (kept, never sent)
  update public.welcome_email_outbox set status = 'skipped', skip_reason = 'expired', sent_at = now()
   where sent_at is null and created_at < now() - interval '48 hours';
  if not public.welcome_email_switch() then return '[]'::jsonb; end if;
  for r in
    select w.* from public.welcome_email_outbox w
     where w.sent_at is null
       and w.created_at >= now() - interval '48 hours' and w.created_at <= now() - interval '2 minutes'
       and (w.claimed_at is null or w.claimed_at < now() - interval '10 minutes')
     order by w.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  loop
    v_why := null;
    if r.org_id is null or not exists (select 1 from public.organizations o where o.id = r.org_id) then
      v_why := 'no_studio';
    elsif r.org_id = '00000000-0000-4000-8000-000000000001'::uuid
       or exists (select 1 from public.organizations o where o.id = r.org_id and coalesce(o.is_sample_master, false)) then
      v_why := 'sample';
    elsif not exists (select 1 from public.profiles p where p.id = r.user_id and p.org_id = r.org_id)
       or public._r283_is_off(r.user_id, r.org_id) then
      v_why := 'not_member';
    elsif public._trial_locked(r.org_id) then
      v_why := 'trial_ended';
    elsif r.kind = 'studio_owner' and exists (select 1 from public.welcome_email_outbox x
             where x.org_id = r.org_id and x.kind = 'studio_owner' and x.id <> r.id and x.status = 'sent') then
      v_why := 'duplicate';
    elsif r.kind = 'member' and exists (select 1 from public.welcome_email_outbox x
             where x.org_id = r.org_id and x.user_id = r.user_id and x.kind = 'member' and x.id <> r.id and x.status = 'sent') then
      v_why := 'duplicate';
    end if;
    if v_why is not null then
      update public.welcome_email_outbox set status = 'skipped', skip_reason = v_why, sent_at = now() where id = r.id and sent_at is null;
      continue;
    end if;
    v_end := public._trial_effective_end(r.org_id);
    v_trial := public._is_trial_org(r.org_id)
      or (v_end is not null and v_end > now()
          and not exists (select 1 from public.subscription_payments sp where sp.org_id = r.org_id and sp.voided_at is null));
    update public.welcome_email_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'to', r.email, 'safe', 'r119-0327',
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = r.user_id),
      'trial', v_trial,
      'trial_ends_at', case when v_trial and v_end is not null and v_end > now() then v_end end));
  end loop;
  return v_out;
end $$;

-- ---- 5) billing reminders: never late, never after the studio paid ---------------------------------------------
-- 'send' = go ahead; anything else = the row was closed (sent_at = now(), channel 'skipped', skip_reason) and must not
-- be sent. 'gone' = no such unsent row (already handled).
create or replace function public.billing_reminder_recheck(p_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r119-0327
declare b record; s record; v_why text; v_paid_ever boolean; v_paid_since boolean;
begin
  select * into b from public.billing_reminders x where x.id = p_id and x.sent_at is null for update;
  if not found then return 'gone'; end if;
  select * into s from public.studio_subscriptions ss where ss.org_id = b.org_id;
  v_paid_ever := exists (select 1 from public.subscription_payments sp where sp.org_id = b.org_id and sp.voided_at is null);
  v_paid_since := exists (select 1 from public.subscription_payments sp where sp.org_id = b.org_id and sp.voided_at is null
                            and sp.recorded_at > b.created_at);
  v_why := case
    when b.created_at < now() - interval '3 days' then 'stale'
    when not exists (select 1 from public.organizations o where o.id = b.org_id) then 'no_studio'
    when exists (select 1 from public.organizations o where o.id = b.org_id and coalesce(o.is_sample_master, false)) then 'sample'
    when s.org_id is null then 'no_plan'
    when b.kind in ('trial_7d', 'trial_3d', 'trial_1d') and (s.status <> 'trial' or v_paid_ever) then 'trial_over'
    when b.kind = 'trial_ended' and (s.status not in ('trial', 'past_due') or v_paid_ever) then 'trial_over'
    when b.kind = 'past_due' and (s.status <> 'past_due' or v_paid_since) then 'paid_since'
    when b.kind = 'due_soon' and (s.status not in ('active', 'trial') or v_paid_since
                                  or s.current_period_end is distinct from b.period_end) then 'paid_since'
    else null end;
  if v_why is null then return 'send'; end if;
  update public.billing_reminders set sent_at = now(), channel = 'skipped', skip_reason = v_why where id = b.id and sent_at is null;
  return v_why;
end $$;

-- ---- 6) privileges: service role only (the senders) -------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array['public.welcome_email_switch()', 'public.welcome_email_outbox_claim(integer)', 'public.billing_reminder_recheck(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', s); end if;
  end loop;
end $$;


notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 the welcome switch exists and is OFF until the owner turns it on (one row)',
     to_regclass('public.helm_welcome_mail_settings') is not null
     and (select count(*) from public.helm_welcome_mail_settings) = 1
     and to_regprocedure('public.welcome_email_switch()') is not null),
  ('02 welcome_email_outbox_claim(integer) is the 0327 body (48 hours, re-checks, switch)',
     pg_get_functiondef('public.welcome_email_outbox_claim(integer)'::regprocedure) like '%r119-0327%'
     and pg_get_functiondef('public.welcome_email_outbox_claim(integer)'::regprocedure) like '%interval ''48 hours''%'),
  ('03 the 0057 claim body is kept once as __pre0327 with no privilege at all',
     to_regprocedure('public.welcome_email_outbox_claim__pre0327(integer)') is not null
     and not has_function_privilege('service_role', 'public.welcome_email_outbox_claim__pre0327(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.welcome_email_outbox_claim__pre0327(integer)', 'execute')
     and not has_function_privilege('anon', 'public.welcome_email_outbox_claim__pre0327(integer)', 'execute')),
  ('04 the senders (service role) may call the switch, the claim and the billing re-check',
     has_function_privilege('service_role', 'public.welcome_email_switch()', 'execute')
     and has_function_privilege('service_role', 'public.welcome_email_outbox_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.billing_reminder_recheck(uuid)', 'execute')),
  ('05 nobody signed in (or anon) may call them',
     not has_function_privilege('authenticated', 'public.welcome_email_outbox_claim(integer)', 'execute')
     and not has_function_privilege('anon', 'public.welcome_email_outbox_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.billing_reminder_recheck(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.welcome_email_switch()', 'execute')),
  ('06 skip_reason columns added (nullable) on welcome_email_outbox + billing_reminders',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'welcome_email_outbox' and column_name = 'skip_reason' and is_nullable = 'YES')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_reminders' and column_name = 'skip_reason' and is_nullable = 'YES')),
  ('07 the settings table is closed to the app (RLS on, no grants to anon / authenticated)',
     (select c.relrowsecurity from pg_class c where c.oid = 'public.helm_welcome_mail_settings'::regclass)
     and not has_table_privilege('authenticated', 'public.helm_welcome_mail_settings', 'select')
     and not has_table_privilege('anon', 'public.helm_welcome_mail_settings', 'select')),
  ('08 info: welcome switch state (false until APPLY-0327-WELCOME-ON.sql) - this row is ok either way',
     public.welcome_email_switch() in (true, false))
) v(item, ok);
