-- 0203_trial_gates.sql - CANONICAL forward-only.
-- REQUIRES 0173 (_tl173_trial_locked), 0166 (_is_trial_org), 0179 (_tb179_no_send), 0183 (_trial_locked,
--          status-based), 0159 (my_checkout_status + _studio_payment_pending), 0181 (catalog = prices only),
--          base nurture (nurture_due / queue_nurture_greeting / run_nurture_auto / nurture_automation),
--          phase26 templates (checklist_templates / task_templates), phase47 audit_log.
--
-- In plain words (FREE TRIAL studios only: studio_subscriptions.status 'trial' via _is_trial_org /
-- _tl173_trial_locked, never organizations.trial_ends_at; a paid studio never reaches any new check):
--   1  Greetings (Nurture): a trial studio sends no greeting to a client.
--        * "Send greeting" (queue_nurture_greeting) is refused: "Greetings are sent once you choose a plan."
--          (42501, hint trial_no_send).
--        * "Run today's greetings" / the automatic run (run_nurture_auto) does nothing and returns 0.
--        * Automatic greetings cannot be switched ON from the app (nurture_automation.enabled); switching
--          them off still works.
--        * The upcoming-occasions list (nurture_due) still shows the sample contacts, with auto-greet
--          shown as off.
--        The same rule as 0179 (_tb179_no_send): free trial, ended unpaid trial and the sample master.
--   2  Menu packages: in the trial only the price per plate changes. A package's dish list can no
--      longer be changed from the app (0181 still allowed it; new dishes had a back door through the
--      package text box). Helm's own functions (trial seed, clone, Clear sample data) are unchanged.
--   3  Activity log: a trial studio cannot read audit_log (new RESTRICTIVE select policy) and the
--      audit page's name lookup (audit_actor_names) returns nothing for it. Free trial or ended unpaid
--      trial; the sample master and paid studios unchanged.
--   4  Templates are not part of the trial: a trial studio cannot add, change or remove checklist /
--      task templates from the app (the sample templates stay readable, so the sample events work).
--   5  Checkout status: my_checkout_status() said has_subscription = true / reason 'subscribed' for a
--      studio on its free trial (the trial row IS a studio_subscriptions row). It now says
--      has_subscription = false, trial = true and reason 'trial' (or 'trial_ended' for an ended,
--      unpaid trial). "required" is unchanged, so nobody is sent to /checkout who was not before.
--   Already refused on the server before this file (kept, re-tested in tests/db/trial-gates-0203.sql):
--   data export + studio archive, Excel / CSV smart import (staff / menu / inventory / vendors), photo
--   render (0173); the inventory "Load starter items" bulk insert is held by the 2-per-list cap (0181).
--
-- Changes: 3 functions wrapped (originals kept as <name>__pre0202, no app grants), 2 functions
-- re-issued with the same signature + grants (audit_actor_names, my_checkout_status), 4 invoker
-- triggers, 1 restrictive policy, 2 small helpers. No table or column is created, changed or dropped;
-- no row is written, deleted or rewritten. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): for each wrapped f: drop function
-- public.f(args); alter function public.f__pre0202(args) rename to f; grant execute on it to
-- authenticated, service_role; drop the zzzz_tl202_* triggers; drop policy tl202_trial_no_read on
-- public.audit_log; re-run 0159 section 4 (my_checkout_status) and 0041 (audit_actor_names).

do $$ begin
  if to_regprocedure('public._tl173_trial_locked(uuid)') is null then raise exception 'STOP: 0173 (trial lockdown) is not applied'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then raise exception 'STOP: 0166 (_is_trial_org) is not applied'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP: 0179 (_tb179_no_send) is not applied'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then raise exception 'STOP: 0183 (_trial_locked) is not applied'; end if;
  if to_regprocedure('public._studio_payment_pending(uuid)') is null then raise exception 'STOP: 0159 (_studio_payment_pending) is not applied'; end if;
  if to_regprocedure('public.queue_nurture_greeting(uuid)') is null or to_regprocedure('public.run_nurture_auto(integer)') is null
     or to_regprocedure('public.nurture_due(integer)') is null then raise exception 'STOP: nurture functions are missing'; end if;
end $$;

-- ---- helpers ----------------------------------------------------------------------------------------
create or replace function public._tl202_no_send(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-gates-0203: free trial / ended unpaid trial / sample master never greets a client (0179 rule)
  select coalesce(public._tb179_no_send(p_org), false);
$$;

create or replace function public._tl202_caller_trial()
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-gates-0203: the caller's studio is on its free trial or an ended, unpaid free trial
  -- (status-based; the sample master and paid studios -> false). Used by the audit_log policy.
  select coalesce(public._tl173_trial_locked(public.current_org_id()), false)
      or coalesce(public._trial_locked(public.current_org_id()), false);
$$;

-- ---- 1) nurture: keep the originals once, then wrap ---------------------------------------------------
do $$
declare f text; v_name text; v_idargs text;
begin
  foreach f in array array['public.queue_nurture_greeting(uuid)', 'public.run_nurture_auto(integer)', 'public.nurture_due(integer)'] loop
    select p.proname, oidvectortypes(p.proargtypes) into v_name, v_idargs from pg_proc p where p.oid = to_regprocedure(f);
    if to_regprocedure(format('public.%I(%s)', v_name || '__pre0202', v_idargs)) is null then
      -- first run only: the original moves to __pre0202 (its grants go with it and are removed below)
      execute format('alter function public.%I(%s) rename to %I', v_name, v_idargs, v_name || '__pre0202');
    end if;
  end loop;
end $$;

create or replace function public.queue_nurture_greeting(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-gates-0203: no greeting to a client from a free-trial studio, then the original
begin
  if public._tl202_no_send(public.current_org_id()) then
    raise exception 'Greetings are sent once you choose a plan.' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.queue_nurture_greeting__pre0202(p_id);
end $$;

create or replace function public.run_nurture_auto(p_within_days integer default null::integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- trial-gates-0203: automatic greetings are off in the free trial (nothing queued), then the original
begin
  if public._tl202_no_send(public.current_org_id()) then return 0; end if;
  return public.run_nurture_auto__pre0202(p_within_days);
end $$;

create or replace function public.nurture_due(p_within_days integer default 30)
returns table(id uuid, name text, email text, phone text, occasion text, occasion_type text, occasion_date date,
              next_date date, years integer, auto_on boolean, greeted_this_year boolean, quote_id uuid, last_event text)
language plpgsql stable security definer set search_path = '' as $$
-- trial-gates-0203: same list; in the free trial auto-greet shows as off (nothing is sent automatically)
declare v_off boolean := public._tl202_no_send(public.current_org_id());
begin
  return query
    select d.id, d.name, d.email, d.phone, d.occasion, d.occasion_type, d.occasion_date, d.next_date, d.years,
           (d.auto_on and not v_off), d.greeted_this_year, d.quote_id, d.last_event
      from public.nurture_due__pre0202(p_within_days) d;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.queue_nurture_greeting(uuid)', 'public.run_nurture_auto(integer)', 'public.nurture_due(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- the kept originals: definer only (the wrappers call them)
  foreach f in array array['public.queue_nurture_greeting__pre0202(uuid)', 'public.run_nurture_auto__pre0202(integer)', 'public.nurture_due__pre0202(integer)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- automatic greetings cannot be switched ON from the app in the free trial (off stays possible)
create or replace function public._tl202_tg_nurture_auto()
returns trigger language plpgsql set search_path = '' as $$
-- trial-gates-0203: SECURITY INVOKER on purpose (current_user = the app role); Helm's own functions
-- (trial seed / clone) are not checked
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if coalesce(new.enabled, false) and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and public._tl173_trial_locked(new.org_id) then
    raise exception 'Automatic greetings start once you choose a plan.' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.nurture_automation') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.nurture_automation'::regclass and tgname = 'zzzz_tl202_nurture_auto') then
    create trigger zzzz_tl202_nurture_auto before insert or update on public.nurture_automation
      for each row execute function public._tl202_tg_nurture_auto();
  end if;
end $$;

-- ---- 2) menu packages: the dish list is fixed in the free trial (price per plate stays editable) ----------
create or replace function public._tl202_tg_menu_dishes()
returns trigger language plpgsql set search_path = '' as $$
-- trial-gates-0203: SECURITY INVOKER on purpose (current_user = the app role). Only direct app edits are
-- checked; Helm's own functions (trial seed, clone, Clear sample data) still change the dishes.
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if new.dishes is distinct from old.dishes and public._tl173_trial_locked(old.org_id) then
    raise exception 'In the free trial you can change the price per plate, but not the dishes in a package. Upgrade to change them.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.menu_templates') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.menu_templates'::regclass and tgname = 'zzzz_tl202_menu_dishes') then
    create trigger zzzz_tl202_menu_dishes before update on public.menu_templates
      for each row execute function public._tl202_tg_menu_dishes();
  end if;
end $$;

-- ---- 3) activity log: not readable in the free trial --------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_policy where polrelid = 'public.audit_log'::regclass and polname = 'tl202_trial_no_read') then
    create policy tl202_trial_no_read on public.audit_log as restrictive for select to authenticated
      using (not (select public._tl202_caller_trial()));
  end if;
end $$;

-- the audit page's "who is who" lookup: same body as 0041 + nothing for a trial studio
create or replace function public.audit_actor_names()
returns table(id uuid, full_name text, email text) language sql stable security definer set search_path = '' as $$
  -- trial-gates-0203 (body of 0041 + the free-trial check)
  select p.id, p.full_name, p.email
    from public.profiles p
   where auth.uid() is not null
     and p.org_id = public.current_org_id()
     and (public.is_admin() or public.has_area('controls', 'view'))
     and not public._tl202_caller_trial()
   order by p.id;
$$;

-- ---- 4) checklist / task templates: not part of the free trial ----------------------------------------
create or replace function public._tl202_tg_templates()
returns trigger language plpgsql set search_path = '' as $$
-- trial-gates-0203: SECURITY INVOKER on purpose (current_user = the app role); Helm's own functions are
-- not checked, reading is unchanged (the sample events keep their checklists)
declare v_org uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; else v_org := new.org_id; end if;
  if current_user in ('anon', 'authenticated') and public._tl173_trial_locked(v_org) then
    raise exception 'Templates are not part of the free trial. Upgrade to make your own templates.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['checklist_templates', 'task_templates'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl202_templates') then
      execute format('create trigger zzzz_tl202_templates before insert or update or delete on public.%I for each row execute function public._tl202_tg_templates()', t);
    end if;
  end loop;
end $$;

-- ---- 5) checkout status: a free trial is not a subscription -------------------------------------------
create or replace function public.my_checkout_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- direct-studio-0159 + trial-gates-0203: has_subscription / reason say "trial" for a studio on its free
-- trial (or an ended, unpaid one); "required" is exactly as in 0159
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; s public.studio_subscriptions;
  v_admin boolean := coalesce(public.is_admin(), false); v_created timestamptz; v_pending boolean;
  v_trial boolean; v_ended boolean;
begin
  if v_org is null then return jsonb_build_object('required', false, 'reason', 'no_studio'); end if;
  select * into b from public.helm_billing_settings where id;
  select * into s from public.studio_subscriptions where org_id = v_org;
  select o.created_at into v_created from public.organizations o where o.id = v_org;
  v_pending := public._studio_payment_pending(v_org);
  v_trial := s.org_id is not null and s.status = 'trial';
  v_ended := s.org_id is not null and not v_trial and coalesce(public._trial_locked(v_org), false);
  return jsonb_build_object(
    'required', v_admin and (v_pending or (s.org_id is null and b.checkout_required_after is not null
                and coalesce(v_created, '-infinity'::timestamptz) >= b.checkout_required_after)),
    'is_admin', v_admin, 'has_subscription', s.org_id is not null and not v_trial and not v_ended,
    'trial', v_trial or v_ended,
    'status', s.status, 'pending_payment', v_pending,
    'reason', case when not v_admin then 'member' when v_pending then 'pending_payment'
                   when v_trial then 'trial'
                   when v_ended then 'trial_ended'
                   when s.org_id is not null then 'subscribed'
                   when b.checkout_required_after is null or coalesce(v_created, '-infinity'::timestamptz) < b.checkout_required_after then 'existing_studio'
                   else 'needs_checkout' end);
end $$;

-- ---- privileges --------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._tl202_no_send(uuid)', 'public._tl202_caller_trial()', 'public._tl202_tg_nurture_auto()',
                           'public._tl202_tg_menu_dishes()', 'public._tl202_tg_templates()',
                           'public.audit_actor_names()', 'public.my_checkout_status()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public._tl202_caller_trial() to authenticated;   -- the audit_log policy asks it
    grant execute on function public.audit_actor_names() to authenticated;
    grant execute on function public.my_checkout_status() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.audit_actor_names() to service_role;
    grant execute on function public.my_checkout_status() to service_role;
  end if;
end $$;
