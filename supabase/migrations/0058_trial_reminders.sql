-- ============================================================================
-- 0058_trial_reminders.sql — CANONICAL forward-only. Trial-ending reminders.
-- REQUIRES 0045 (studio_subscriptions, billing_reminders, _billing_refresh),
-- 0054 (notification catalog wrappers) and 0056 (14-day trial, checkout RPCs).
-- Independent of 0057 (welcome); MANIFEST keeps 0057 before 0058.
--
-- In plain words: a studio on the 14-day free trial is reminded 7, 3 and 1 day(s)
-- before the trial ends, and once when it has ended. Each reminder is queued ONCE per
-- studio per kind per trial end date (billing_reminders unique key) — it e-mails the
-- studio through the dormant billing-reminder edge function and drops ONE bell
-- notification for the studio's admins. When a trial ends without a payment the
-- studio moves to past_due (the same state an unpaid renewal reaches). past_due is
-- NOT read-only: only HQ suspends a studio, by hand, exactly as before.
--
--   * billing_reminders.kind: + trial_7d, trial_3d, trial_1d, trial_ended (check widened).
--   * _trial_refresh(): the daily job; _billing_refresh() (pg_cron + HQ refresh) now
--     also runs it (rename-once wrapper — this database's own body is kept).
--   * Bell: notification kind 'trial_reminder' → catalog type 'billing_trial', shown to
--     admins only by default (like security alerts); clients can never write those rows.
--   * my_trial_status(): studio members read trial state (days left, ends at, can_pay).
--   * Checkout: a studio whose trial ended unpaid (past_due, never paid) may still pay
--     (my_checkout_prepare + checkout_attach_subscription). An in-trial studio already could.
-- Additive + idempotent. NO row is deleted; no existing value is overwritten.
-- ============================================================================

do $$ begin
  if to_regclass('public.billing_reminders') is null or to_regclass('public.studio_subscriptions') is null then
    raise exception '0058: 0045 (HQ subscriptions) is not installed on this database'; end if;
  if to_regprocedure('public._billing_refresh()') is null then
    raise exception '0058: public._billing_refresh() (0045) is missing'; end if;
  if to_regprocedure('public.my_start_trial(text,text)') is null then
    raise exception '0058: 0056 (onboarding checkout) is not installed on this database'; end if;
  if to_regprocedure('public.notification_type_of(text,text)') is null or to_regprocedure('public.notification_catalog()') is null
     or to_regprocedure('public.notify_default(uuid,text,text,text)') is null then
    raise exception '0058: notification catalog (0036 / 0054) is missing'; end if;
end $$;

-- ---- 1) reminder kinds (widen the check; existing rows all still pass) --------------------------
do $$ declare c record; begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.billing_reminders'::regclass and con.contype = 'c'
              and pg_get_constraintdef(con.oid) like '%due_soon%' and con.conname <> 'billing_reminders_kind_chk58' loop
    execute format('alter table public.billing_reminders drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.billing_reminders'::regclass and conname = 'billing_reminders_kind_chk58') then
    alter table public.billing_reminders add constraint billing_reminders_kind_chk58
      check (kind in ('due_soon','past_due','trial_7d','trial_3d','trial_1d','trial_ended'));
  end if;
end $$;

-- ---- 2) keep this database's own bodies (rename once) -------------------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['notification_catalog', ''],
    ['notification_type_of', 'text, text'],
    ['notify_default',       'uuid, text, text, text'],
    ['_billing_refresh',     '']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0058', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0058');
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0058', f[2]);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0058', f[2]); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0058', f[2]); end if;
  end loop;
end $$;

-- ---- 3) bell catalog: + billing_trial (admins only by default) ----------------------------------
create or replace function public.notification_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  -- trial-reminders-0058: the database's own catalog + the Billing trial type (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'billing_trial') then c
    else c || $cat$[
    {"type":"billing_trial","group":"Billing","label":"Free trial reminders",
     "description":"Your Helm free trial ends in 7, 3 or 1 day(s), or has ended. Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0058() as c) x;
$$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_kind, ''))) = 'trial_reminder' then 'billing_trial'
              else public.notification_type_of__pre0058(p_kind, p_channel) end;
$$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-reminders-0058: trial reminders reach admins only unless a studio admin opts a role in
  select case when p_type = 'billing_trial' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0058(p_org, p_role, p_type, p_channel) end;
$$;

-- ---- 4) notifications: trial rows are admin-readable only and never client-written --------------
drop policy if exists tr58_read on public.notifications;
create policy tr58_read on public.notifications as restrictive for select to authenticated
  using (coalesce(kind, '') <> 'trial_reminder' or (select public.is_admin()));
drop policy if exists tr58_ins on public.notifications;
create policy tr58_ins on public.notifications as restrictive for insert to authenticated
  with check (coalesce(kind, '') <> 'trial_reminder');
drop policy if exists tr58_upd on public.notifications;
create policy tr58_upd on public.notifications as restrictive for update to authenticated
  using (coalesce(kind, '') <> 'trial_reminder') with check (coalesce(kind, '') <> 'trial_reminder');
drop policy if exists tr58_del on public.notifications;
create policy tr58_del on public.notifications as restrictive for delete to authenticated
  using (coalesce(kind, '') <> 'trial_reminder');

-- ---- 5) the trial job --------------------------------------------------------------------------
-- paid = any non-voided payment that is open-ended or still covers today
create or replace function public._trial_paid(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subscription_payments sp
                  where sp.org_id = p_org and sp.voided_at is null
                    and (sp.period_end is null or sp.period_end >= current_date));
$$;

create or replace function public._trial_label(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind
    when 'trial_7d'    then 'Your free trial ends in 7 days'
    when 'trial_3d'    then 'Your free trial ends in 3 days'
    when 'trial_1d'    then 'Your free trial ends tomorrow'
    when 'trial_ended' then 'Your free trial has ended'
    else 'Free trial update' end;
$$;

create or replace function public._trial_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare n_pd int := 0; n_rem int := 0; rec record; v_kind text; v_id uuid;
begin
  -- a) trials that ended without a payment → past_due (never suspended here)
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

  -- b) one reminder per studio per kind per trial end date (only the most urgent that applies)
  for rec in
    select s.org_id, s.status, s.trial_ends_at, (s.trial_ends_at - current_date) as d
      from public.studio_subscriptions s
     where s.trial_ends_at is not null and not public._trial_paid(s.org_id)
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
      begin   -- the bell row must never block the reminder / status change
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

-- the existing refresh (pg_cron daily + HQ "refresh") keeps its own body and adds the trial job
create or replace function public._billing_refresh()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb; t jsonb;
begin
  r := public._billing_refresh__pre0058();
  t := public._trial_refresh();
  return coalesce(r, '{}'::jsonb) || jsonb_build_object(
    'past_due_set', coalesce((r ->> 'past_due_set')::int, 0) + (t ->> 'trial_past_due_set')::int,
    'reminders_queued', coalesce((r ->> 'reminders_queued')::int, 0) + (t ->> 'trial_reminders_queued')::int) || t;
end $$;

-- ---- 6) studio members: trial state ------------------------------------------------------------
-- state: 'trial' (days_left ≥ 0), 'ended' (trial over, never paid) or 'none'. Clients refused.
create or replace function public.my_trial_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.studio_subscriptions; v_admin boolean; v_state text := 'none';
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_admin := coalesce(public.is_admin(), false);
  select * into s from public.studio_subscriptions where org_id = v_org;
  if s.org_id is not null and s.trial_ends_at is not null and not public._trial_paid(v_org) then
    if s.status = 'trial' then v_state := case when s.trial_ends_at < current_date then 'ended' else 'trial' end;
    elsif s.status = 'past_due' and s.current_period_end is null then v_state := 'ended';
    end if;
  end if;
  return jsonb_build_object('state', v_state, 'status', s.status,
    'ends_at', case when v_state <> 'none' then s.trial_ends_at end,
    'days_left', case when v_state = 'trial' then s.trial_ends_at - current_date when v_state = 'ended' then 0 end,
    'is_admin', v_admin, 'can_pay', v_admin and v_state <> 'none');
end $$;

-- ---- 7) checkout: a trial that ended unpaid can still pay (0056 bodies + that one case) ----------
create or replace function public._trial_unpaid_past_due(s public.studio_subscriptions)
returns boolean language sql stable security definer set search_path = '' as $$
  select s.status = 'past_due' and s.trial_ends_at is not null and s.current_period_end is null
     and not exists (select 1 from public.subscription_payments p where p.org_id = s.org_id and p.voided_at is null);
$$;

create or replace function public.my_checkout_prepare(p_plan text, p_interval text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; q jsonb;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into b from public.helm_billing_settings where id;
  select * into a from public.studio_account where org_id = v_org;
  if a.terms_version_accepted is null or a.terms_version_accepted is distinct from b.terms_version then
    raise exception 'please accept the Terms of Service first' using errcode = '22023'; end if;
  select * into s from public.studio_subscriptions where org_id = v_org;
  if s.status in ('active','past_due','suspended') and not public._trial_unpaid_past_due(s) then
    raise exception 'this studio already has a subscription' using errcode = '22023'; end if;
  q := public._checkout_quote(v_org, p_plan, p_interval);
  if q ->> 'razorpay_plan_id' is null then
    raise exception 'online payment is not set up for this plan yet' using errcode = '22023'; end if;
  return q || jsonb_build_object('org_id', v_org);
end $$;

create or replace function public.checkout_attach_subscription(p_org uuid, p_subscription_id text, p_plan text, p_interval text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_plan uuid; v_n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]{6,40}$' then
    raise exception 'bad subscription id' using errcode = '22023'; end if;
  if p_interval not in ('monthly','yearly') then raise exception 'bad interval' using errcode = '22023'; end if;
  select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan;
  if v_plan is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio or plan' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, billing_interval,
                                          provider, provider_subscription_id, updated_at)
    values (p_org, v_plan, 'trial', current_date + 14, 'checkout', p_interval, 'razorpay', p_subscription_id, now())
  on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
      provider = 'razorpay', provider_subscription_id = excluded.provider_subscription_id, updated_at = now()
    where public.studio_subscriptions.status not in ('active','past_due','suspended')
       or (public.studio_subscriptions.status = 'past_due' and public.studio_subscriptions.trial_ends_at is not null
           and public.studio_subscriptions.current_period_end is null
           and not exists (select 1 from public.subscription_payments p where p.org_id = excluded.org_id and p.voided_at is null));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'subscription.checkout_created', 'studio_subscriptions', p_org::text,
              jsonb_build_object('plan', p_plan, 'interval', p_interval, 'provider_subscription_id', p_subscription_id), p_org, now());
  end if;
  return v_n > 0;
end $$;

-- ---- 8) grants ---------------------------------------------------------------------------------
do $$ declare fn text; begin
  foreach fn in array array['public._trial_paid(uuid)', 'public._trial_label(text)', 'public._trial_refresh()',
      'public._billing_refresh()', 'public._trial_unpaid_past_due(public.studio_subscriptions)',
      'public.notification_catalog()', 'public.notification_type_of(text,text)', 'public.notify_default(uuid,text,text,text)',
      'public.my_trial_status()', 'public.my_checkout_prepare(text,text)', 'public.checkout_attach_subscription(uuid,text,text,text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_trial_status() to authenticated;                    -- member gate inside
    grant execute on function public.my_checkout_prepare(text, text) to authenticated;      -- admin gate inside
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._billing_refresh() to service_role;
    grant execute on function public.checkout_attach_subscription(uuid, text, text, text) to service_role;
  end if;
end $$;
