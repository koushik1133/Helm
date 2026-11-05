-- APPLY-0333.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0333: ..." if 0329 (R121) or an earlier migration it builds on is missing.
-- [numbering: 0331 is intentionally unused]
-- R124 (owner): after a free trial ends without a plan, the studio's current owner gets four follow-up e-mails:
--   Day 0  "Your Helm free trial has ended. <Studio> is safe."    Day 2  "<Studio> is waiting for you"
--   Day 7  "One place for your next event" (replaces the old +7)  Day 14 "Should we keep <Studio> for you?"
--   They stop as soon as the studio gets a plan or the owner unsubscribes. They apply ONLY to trials that end after
--   this file first runs: old studios get nothing, and running it again does not move that moment.
--   Nothing is dropped or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true. Rows starting "info" only
--      report counts (they are always true) - read the number in the text.
--   2  Deploy comms-dispatch: supabase functions deploy comms-dispatch --no-verify-jwt --use-api --project-ref <ref>
--      Until then the Day 0 / 2 / 14 rows wait (an older dispatcher never touches them). Do it the same day: a row not
--      sent within 2 days is skipped, not sent late.
--   3  Deploy the site (store-api.js: /checkout now survives the sign-in step).
--   TO STOP THE WHOLE SERIES: update public.helm_trial_followups set enabled = false, updated_at = now() where id;
begin;
-- 0333_r124_trial_followup_emails.sql - CANONICAL forward-only. R124 (owner): after a free trial ends without a plan, the
-- studio's CURRENT OWNER gets four follow-up e-mails (Day 0, 2, 7, 14). Never a client.
-- REQUIRES 0184 (trial_retention_*), 0165 (email_is_opted_out), 0248 (reserved_email_domain, platform_admins),
--          0283 (_r283_owner, _r283_is_off), 0290 (send window trigger), 0300 (studio_billing_email),
--          0329 (trial_retention_email_claim current body).
-- [numbering: 0331 is intentionally unused]
--
-- In plain words:
--   1  Queue: the hourly trial_retention_tick also queues kinds x0, x2, x7, x14 in trial_retention_notices. x7 is the
--      old single "+7" e-mail (same kind, new words); it now counts from the same day as the others.
--   2  Days are counted from the calendar day the trial really ended, in the studio's time zone. Each e-mail has that
--      day plus one catch-up day (a missed tick), so the offsets 0-1, 2-3, 7-8, 14-15 can never overlap. The notices
--      are queued ON their day, never ahead, so the dispatcher's "older than 2 days = skipped" rule does not eat
--      Day 7 or Day 14: it only applies if the sender is down for 2 days after a row was queued.
--   3  ONLY trials that end after this file first ran: helm_trial_followups.starts_at is set once, a re-run never moves
--      it. No old studio is mailed on the first run, whatever the tick finds. That includes the old +7 e-mail: a trial
--      that ended before this file ran gets no follow-up at all (deletion warnings are separate and unchanged).
--   4  Once per kind per studio, ever: x0 / x2 / x14 have a one-per-studio dedupe key; x7 keeps its 0184 key and the
--      queue looks for any earlier x7 of the studio, so a trial extended and ended again does not repeat one.
--   5  Stops at once: every claim re-checks at send time. A plan, a suspension, a cancellation, a later trial end or an
--      unsubscribe closes the row as skipped (kept), and nothing further is queued.
--   6  Not for: paid / suspended / cancelled / past-paid studios and the sample master (_trial_retention_block, 0184);
--      studios owned by Helm staff or on a test address (_r124_stop). There is no "HQ test studio" flag in the
--      database, so these are recognised by the owner's address: helm.events / helm.com, HQ staff list, example.* ,
--      *.test, *.invalid, *.example, *.localhost.
--   7  Goes to the current owner's login e-mail (0283), else studio_billing_email only when no usable owner exists.
--   8  Marketing mail: the Helm-level unsubscribe (0165) applies to all four, Day 0 too, the same as the existing
--      "trial ends today" and +7 e-mails and billing-reminder's trial_ended. Deletion warnings stay service notices.
--   9  Works with helm_trial_retention.delete_enabled OFF: the claim needs no deletion date. The date is passed only
--      when a deletion is really scheduled.
--  10  Send window: the existing zz_sw290_send_window trigger holds these rows (staff window 08:00-21:00 studio time)
--      because they sit in trial_retention_notices. Held, not dropped.
--  11  Safe in either deploy order: x0 / x2 / x14 are handed out only by the NEW trial_followup_email_claim, and the old
--      claim no longer offers them, so a comms-dispatch that has not been redeployed cannot mark them skipped.
--      A comms-dispatch redeployed before this file finds no new claim function and carries on.
--  12  Kill switch: update public.helm_trial_followups set enabled = false, updated_at = now() where id;
-- ZERO DATA LOSS: no table, column, row or policy is dropped or deleted. One new settings table. Two check constraints
-- replaced by supersets (the old rows all pass). trial_retention_tick, _tr184_notice and trial_retention_email_claim
-- re-issued; old bodies kept once as *__pre0333 with NO app privilege. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): first the kill switch above. Then, per re-issued function F(args):
--   drop function public.F(args); alter function public.F__pre0333(args) rename to F;
--   and re-grant execute on trial_retention_tick() + trial_retention_email_claim(integer) to service_role.

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.trial_retention_notices') is null or to_regprocedure('public.trial_retention_tick()') is null
     or to_regprocedure('public._tr184_notice(uuid,text,timestamptz,date)') is null
     or to_regprocedure('public._trial_retention_block(uuid)') is null then
    raise exception 'STOP 0333: 0184 (trial retention) is not applied'; end if;
  if to_regprocedure('public.trial_retention_email_claim__pre0329(integer)') is null
     and position('r121-0329' in coalesce(pg_get_functiondef('public.trial_retention_email_claim(integer)'::regprocedure), '')) = 0 then
    raise exception 'STOP 0333: 0329 (R121) is not applied - run APPLY-0329.sql first'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is null then
    raise exception 'STOP 0333: 0165 (email_is_opted_out) is not applied'; end if;
  if to_regprocedure('public.reserved_email_domain(text)') is null or to_regclass('public.platform_admins') is null then
    raise exception 'STOP 0333: 0248 (reserved e-mail domains) is not applied'; end if;
  if to_regprocedure('public._r283_owner(uuid)') is null or to_regprocedure('public._r283_is_off(uuid,uuid)') is null then
    raise exception 'STOP 0333: 0283 (current studio owner) is not applied'; end if;
  if to_regprocedure('public.studio_billing_email(uuid)') is null then
    raise exception 'STOP 0333: 0300 (studio_billing_email) is not applied'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.trial_retention_notices'::regclass and tgname = 'zz_sw290_send_window') then
    raise exception 'STOP 0333: 0290 (send window) is not applied'; end if;
end $$;

-- ---- 1) the switch + the one fixed start moment --------------------------------------------------------------------------
create table if not exists public.helm_trial_followups (
  id         boolean primary key default true check (id),
  enabled    boolean not null default true,
  starts_at  timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.helm_trial_followups is
  'r124-0333: one row. The follow-up e-mails apply only to trials that ended at or after starts_at (set once, never moved '
  'by a re-run). enabled = false stops the whole series.';
insert into public.helm_trial_followups(id) values (true) on conflict (id) do nothing;
alter table public.helm_trial_followups enable row level security;
revoke all on table public.helm_trial_followups from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.helm_trial_followups from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.helm_trial_followups from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.helm_trial_followups from service_role';
    execute 'grant select on table public.helm_trial_followups to service_role';
  end if;
end $$;
-- no policies: only the SECURITY DEFINER functions below read it

-- ---- 2) the two check constraints become supersets (new one added first, so the table is never unguarded) ---------------
do $$ declare c record; begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.trial_retention_notices'::regclass
                                               and conname = 'trial_retention_notices_kind_r124_chk') then
    alter table public.trial_retention_notices add constraint trial_retention_notices_kind_r124_chk
      check (kind in ('x0', 'x2', 'x7', 'x14', 'del30', 'del7', 'del1'));
    alter table public.trial_retention_notices add constraint trial_retention_notices_date_r124_chk
      check (kind in ('x0', 'x2', 'x7', 'x14') or delete_on is not null);
    for c in
      select x.conname from pg_constraint x
       where x.conrelid = 'public.trial_retention_notices'::regclass and x.contype = 'c'
         and x.conname not in ('trial_retention_notices_kind_r124_chk', 'trial_retention_notices_date_r124_chk')
         and pg_get_constraintdef(x.oid) like '%kind%'
    loop
      execute format('alter table public.trial_retention_notices drop constraint %I', c.conname);
    end loop;
  end if;
end $$;

-- ---- 3) keep the current bodies once (__pre0333, no app privilege) ---------------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values ('trial_retention_tick', ''), ('_tr184_notice', 'uuid,text,timestamptz,date'),
                                 ('trial_retention_email_claim', 'integer')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0333(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r124-0333' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0333');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0333(' || f.a || ')');
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    end if;
  end loop;
end $$;

-- ---- 4) helpers ---------------------------------------------------------------------------------------------------------
create or replace function public._r124_kinds()
returns text[] language sql immutable set search_path = '' as $$
  -- r124-0333: the kinds only trial_followup_email_claim hands out (x7 stays on the 0184 claim: both dispatchers know it)
  select array['x0', 'x2', 'x14']::text[];
$$;

create or replace function public._r124_to(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r124-0333: the current owner's login e-mail; the billing address only when the studio has no usable owner
  select coalesce(
    (select u.email from auth.users u join public.profiles p on p.id = u.id
      where u.id = public._r283_owner(p_org) and p.org_id = p_org and not public._r283_is_off(u.id, p_org)
        and coalesce(u.email, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    public.studio_billing_email(p_org));
$$;

-- NULL = this address may get a follow-up; otherwise why not. Trial state is _trial_retention_block's job.
create or replace function public._r124_stop(p_to text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r124-0333
declare v_e text := lower(btrim(coalesce(p_to, '')));
begin
  if not coalesce((select f.enabled from public.helm_trial_followups f where f.id), false) then return 'switched_off'; end if;
  if v_e !~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$' then return 'no_address'; end if;
  if public.email_is_opted_out(null, v_e) then return 'unsubscribed'; end if;
  if public.reserved_email_domain(v_e) is not null
     or exists (select 1 from public.platform_admins a where lower(a.email) = v_e) then return 'helm_staff'; end if;
  if v_e ~ '@(.+\.)?example\.(com|org|net)$' or v_e ~ '\.(test|invalid|example|localhost)$' then return 'test_address'; end if;
  return null;
end $$;

-- 0184's x7 line in the tick no longer queues anything: the series below decides, with the shared start day and rules
create or replace function public._tr184_notice(p_org uuid, p_kind text, p_expired timestamptz, p_delete_on date)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r124-0333: deletion warnings go straight through, unchanged
begin
  if p_kind = 'x7' then return false; end if;
  return public._tr184_notice__pre0333(p_org, p_kind, p_expired, p_delete_on);
end $$;

-- ---- 5) the series queue --------------------------------------------------------------------------------------------------
create or replace function public._r124_queue()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r124-0333: idempotent. One studio failing never stops the others.
declare
  cfg public.helm_trial_followups; o record; v_tz text; v_exp timestamptz; v_day integer; v_kind text;
  n_new integer := 0; n_x7 integer := 0; v_id uuid;
begin
  select * into cfg from public.helm_trial_followups f where f.id;
  if not found or not cfg.enabled then return jsonb_build_object('followups_new', 0, 'x7_new', 0); end if;
  for o in
    select org.id, org.timezone
      from public.organizations org join public.studio_subscriptions s on s.org_id = org.id
     where org.trial_ends_at is not null and s.status in ('trial', 'past_due')
       and public._trial_expired_at(org.id) >= cfg.starts_at       -- the guard against old studios
       and public._trial_expired_at(org.id) <= now()
       and public._trial_expired_at(org.id) > now() - interval '17 days'
  loop
    begin
      if public._trial_retention_block(o.id) is not null then continue; end if;
      v_tz := public._tr184_tz(o.timezone);
      v_exp := public._trial_expired_at(o.id);
      v_day := public._tr184_local_date(now(), v_tz) - public._tr184_local_date(v_exp, v_tz);
      v_kind := case when v_day in (0, 1) then 'x0' when v_day in (2, 3) then 'x2'
                     when v_day in (7, 8) then 'x7' when v_day in (14, 15) then 'x14' else null end;
      if v_kind is null then continue; end if;
      if exists (select 1 from public.trial_retention_notices n where n.org_id = o.id and n.kind = v_kind) then continue; end if;
      if public._r124_stop(public._r124_to(o.id)) is not null then continue; end if;
      if v_kind = 'x7' then
        if public._tr184_notice__pre0333(o.id, 'x7', v_exp, null) then n_x7 := n_x7 + 1; end if;
      else
        v_id := null;
        insert into public.trial_retention_notices(org_id, kind, expired_at, delete_on, dedupe_key)
          values (o.id, v_kind, v_exp, null, 'r124:' || v_kind || ':' || o.id::text)
          on conflict (dedupe_key) do nothing
          returning id into v_id;
        if v_id is not null then n_new := n_new + 1; end if;
      end if;
    exception when others then raise warning 'r124-0333: studio skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('followups_new', n_new, 'x7_new', n_x7);
end $$;

create or replace function public.trial_retention_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r124-0333: the 0184 tick (deletion schedule + warnings, unchanged), then the follow-up series. The cron job keeps its
-- name and call. A failure in the series never touches the deletion warnings.
declare v jsonb; f jsonb;
begin
  v := public.trial_retention_tick__pre0333();
  begin
    f := public._r124_queue();
  exception when others then
    raise warning 'r124-0333: follow-up queue skipped (%)', sqlstate;
    f := jsonb_build_object('followups_failed', true);
  end;
  return v || f;
end $$;

-- ---- 6) the claims ---------------------------------------------------------------------------------------------------------
-- 0329 body, three changes: follow-up kinds are left for trial_followup_email_claim; x7 goes to the current owner;
-- x7 also stops on _r124_stop. Deletion warnings: unchanged.
create or replace function public.trial_retention_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r124-0333: r121-0329 trial-retention-0184
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  r record; v_out jsonb := '[]'::jsonb; v_to text; v_ok boolean; v_del date;
  v_re constant text := '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$';
begin
  update public.trial_retention_notices set email_status = 'failed', email_sent_at = now()
   where email_sent_at is null and email_attempts >= 5;
  update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now()
   where email_sent_at is null and created_at < now() - interval '2 days';
  for r in
    select n.id, n.org_id, n.kind, n.expired_at, n.delete_on, o.name, public._tr184_tz(o.timezone) as tz
      from public.trial_retention_notices n join public.organizations o on o.id = n.org_id
     where n.email_sent_at is null and n.email_status = 'pending'
       and n.kind <> all (public._r124_kinds())
       and (n.email_claimed_at is null or n.email_claimed_at < now() - interval '10 minutes')
     order by n.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of n skip locked
  loop
    -- re-check at send time: still an expired never-paid trial, and (warnings) the same deletion date
    v_ok := public._trial_retention_block(r.org_id) is null;
    v_del := null;
    select t.delete_on into v_del from public.trial_retention_schedule t
     where t.org_id = r.org_id and t.status = 'scheduled' and cfg.delete_enabled;
    if r.kind = 'x7' then
      v_ok := v_ok and public._trial_expired_at(r.org_id) is not distinct from r.expired_at;
      v_to := public._r124_to(r.org_id);
      v_ok := v_ok and public._r124_stop(v_to) is null;
    else
      v_ok := v_ok and cfg.delete_enabled and v_del is not null and v_del = r.delete_on;
      v_to := public.studio_billing_email(r.org_id);
    end if;
    if not coalesce(v_ok, false) or coalesce(v_to, '') !~ v_re then
      update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now() where id = r.id;
      continue;
    end if;
    update public.trial_retention_notices set email_claimed_at = now(), email_attempts = email_attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', v_to, 'kind', r.kind,
      'studio', coalesce(r.name, ''), 'expired_at', r.expired_at,
      'delete_on', case when r.kind = 'x7' then v_del else r.delete_on end,
      'timezone', r.tz, 'retention_days', cfg.retention_days));
  end loop;
  return v_out;
end $$;

-- x0 / x2 / x14 (service role; comms-dispatch). Needs no deletion date: delete_on is passed only when one is scheduled.
create or replace function public.trial_followup_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r124-0333: the same lease, attempts and 2-day rules as trial_retention_email_claim
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  r record; v_out jsonb := '[]'::jsonb; v_to text; v_ok boolean; v_del date;
begin
  update public.trial_retention_notices set email_status = 'failed', email_sent_at = now()
   where email_sent_at is null and email_attempts >= 5 and kind = any (public._r124_kinds());
  update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now()
   where email_sent_at is null and created_at < now() - interval '2 days' and kind = any (public._r124_kinds());
  for r in
    select n.id, n.org_id, n.kind, n.expired_at, o.name, public._tr184_tz(o.timezone) as tz
      from public.trial_retention_notices n join public.organizations o on o.id = n.org_id
     where n.email_sent_at is null and n.email_status = 'pending'
       and n.kind = any (public._r124_kinds())
       and (n.email_claimed_at is null or n.email_claimed_at < now() - interval '10 minutes')
     order by n.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of n skip locked
  loop
    -- re-check at send time: a plan, suspension, later trial end or unsubscribe closes the row, it is never sent
    v_to := public._r124_to(r.org_id);
    v_ok := public._trial_retention_block(r.org_id) is null
            and public._trial_expired_at(r.org_id) is not distinct from r.expired_at
            and public._r124_stop(v_to) is null;
    if not coalesce(v_ok, false) then
      update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now() where id = r.id;
      continue;
    end if;
    v_del := null;
    select t.delete_on into v_del from public.trial_retention_schedule t
     where t.org_id = r.org_id and t.status = 'scheduled' and cfg.delete_enabled;
    update public.trial_retention_notices set email_claimed_at = now(), email_attempts = email_attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', v_to, 'kind', r.kind,
      'studio', coalesce(r.name, ''), 'expired_at', r.expired_at, 'delete_on', v_del,
      'timezone', r.tz, 'retention_days', cfg.retention_days));
  end loop;
  return v_out;
end $$;

-- ---- 7) privileges: the service role gets the two claims + the tick, nothing else -------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r124_kinds()', 'public._r124_to(uuid)', 'public._r124_stop(text)', 'public._r124_queue()',
                           'public._tr184_notice(uuid, text, timestamptz, date)', 'public.trial_retention_tick()',
                           'public.trial_retention_email_claim(integer)', 'public.trial_followup_email_claim(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.trial_retention_tick() to service_role';
    execute 'grant execute on function public.trial_retention_email_claim(integer) to service_role';
    execute 'grant execute on function public.trial_followup_email_claim(integer) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true; "info" rows just report a number)
select item, ok from (values
  ('01 one settings row: on, with its start moment', (select count(*) = 1 and bool_and(enabled) and bool_and(starts_at <= now()) from public.helm_trial_followups)),
  ('02 the new kinds are allowed and an unknown kind is not',
     (select count(*) = 2 from pg_constraint where conrelid = 'public.trial_retention_notices'::regclass
       and conname in ('trial_retention_notices_kind_r124_chk', 'trial_retention_notices_date_r124_chk'))
     and pg_get_constraintdef((select oid from pg_constraint where conrelid = 'public.trial_retention_notices'::regclass
       and conname = 'trial_retention_notices_kind_r124_chk')) like '%x14%'),
  ('03 no older check on kind is left behind',
     (select count(*) = 2 from pg_constraint where conrelid = 'public.trial_retention_notices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%kind%')),
  ('04 tick, notice and claim are the 0333 versions; old bodies kept',
     position('r124-0333' in pg_get_functiondef('public.trial_retention_tick()'::regprocedure)) > 0
     and position('r124-0333' in pg_get_functiondef('public._tr184_notice(uuid,text,timestamptz,date)'::regprocedure)) > 0
     and position('r124-0333' in pg_get_functiondef('public.trial_retention_email_claim(integer)'::regprocedure)) > 0
     and to_regprocedure('public.trial_retention_tick__pre0333()') is not null
     and to_regprocedure('public._tr184_notice__pre0333(uuid,text,timestamptz,date)') is not null
     and to_regprocedure('public.trial_retention_email_claim__pre0333(integer)') is not null),
  ('05 the service role runs the tick and both claims',
     has_function_privilege('service_role', 'public.trial_retention_tick()', 'execute')
     and has_function_privilege('service_role', 'public.trial_followup_email_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.trial_retention_email_claim(integer)', 'execute')),
  ('06 the app cannot run them, the helpers or the kept bodies, and cannot read the switch',
     not has_function_privilege('authenticated', 'public.trial_followup_email_claim(integer)', 'execute')
     and not has_function_privilege('anon', 'public.trial_followup_email_claim(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.trial_retention_tick()', 'execute')
     and not has_function_privilege('authenticated', 'public._r124_queue()', 'execute')
     and not has_function_privilege('authenticated', 'public._r124_stop(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.trial_retention_tick__pre0333()', 'execute')
     and not has_function_privilege('anon', 'public.trial_retention_email_claim__pre0333(integer)', 'execute')
     and not has_table_privilege('authenticated', 'public.helm_trial_followups', 'select')),
  ('07 the send window still guards the queue',
     exists (select 1 from pg_trigger where tgrelid = 'public.trial_retention_notices'::regclass and tgname = 'zz_sw290_send_window')),
  ('08 no follow-up row exists for a trial that ended before the start moment',
     not exists (select 1 from public.trial_retention_notices n cross join public.helm_trial_followups f
                  where n.kind in ('x0', 'x2', 'x14') and n.expired_at < f.starts_at)),
  ('09 info: the series applies to trials ending from ' || (select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') from public.helm_trial_followups where id) || ' UTC on', true),
  ('10 info: ' || (select count(*) from public.trial_retention_notices where kind in ('x0', 'x2', 'x14'))::text
     || ' follow-up row(s) so far (0 right after the first run is normal)', true)
) v(item, ok);
