-- APPLY-0159.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: one new private marker table (new studios only, no backfill), re-issued functions (create_studio keeps its old body as create_studio__pre0159), Starter/Studio plans only when no active plan exists. No rows deleted or changed. Safe to run twice.
begin;
-- 0159_direct_studio_plan_gate.sql - CANONICAL forward-only.
-- REQUIRES 0045 (HQ subscriptions, read-only guard), 0056 (checkout), 0058 (_trial_paid),
--          0097 (organizations.trial_mode), 0119 (one free trial, _trial_days), 0122 (read-only guard body).
--
-- In plain words - two ways to start with Helm:
--   1. "Start free trial" (start_self_serve_trial, 8 days, demo or own data) - NOT changed.
--   2. "Create studio" directly (create_studio, no trial). Until now that studio could use the app
--      for free with no plan. From now on a studio created this way must pick a plan and pay first:
--        * create_studio() now also writes one marker row (studio_payment_gate) for the NEW studio.
--          start_self_serve_trial() goes through create_studio() too, but sets the free trial in the
--          same call, so a trial studio is never waiting.
--        * _studio_payment_pending(org) = has a marker, no free trial, no paid / HQ-granted
--          subscription and no payment yet.
--        * the read-only guard (tg_studio_read_only) refuses every studio write while that is true
--          (hint 'payment_pending'); the owner can still fill billing details / accept the Terms /
--          edit their profile, and the rows create_studio writes in its own transaction still go in.
--        * my_checkout_status() says required + pending_payment, so the app sends the owner to
--          /checkout before any page shows.
--        * my_pending_start_trial(): while online payment is NOT live, the owner can switch the
--          studio to the normal 8-day free trial (own data) instead.
--   3. "No plans available" on /checkout: when there is NO active plan at all, the two plans from
--      the public pricing page (Starter, Studio; INR, proposed prices) are added. Nothing is added
--      when HQ already set up any active plan, and no existing plan or price is changed.
--
-- ZERO DATA LOSS / existing studios unaffected: additive + idempotent. One new private table
-- (studio_payment_gate: only studios created from now on get a row; NO backfill, so every
-- existing studio is grandfathered), new rows in helm_plans / helm_plan_prices only when there is
-- no active plan. No DROP / DELETE / TRUNCATE. Trial studios and paid studios are never gated.
-- create_studio keeps its signature and grants (the previous body is kept as
-- create_studio__pre0159, same pattern as 0143). Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.my_checkout_status()') is null or to_regprocedure('public.my_checkout_options()') is null then
    raise exception '0159: apply 0056 (onboarding checkout) first'; end if;
  if to_regprocedure('public._trial_days()') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0159: apply 0116 + 0119 (free trial) first'; end if;
  if to_regprocedure('public._trial_paid(uuid)') is null then
    raise exception '0159: apply 0058 (trial reminders) first'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null or to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0159: apply 0045 (read-only guard) first'; end if;
  if to_regprocedure('public.create_studio(text,text,text,text)') is null then
    raise exception '0159: create_studio() is missing on this database'; end if;
end $$;

-- ---- 1) marker: which studios were created directly (from now on only) ----------------------
create table if not exists public.studio_payment_gate (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid
);
alter table public.studio_payment_gate enable row level security;
revoke all on table public.studio_payment_gate from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.studio_payment_gate from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.studio_payment_gate from authenticated'; end if;
end $$;

do $$ begin
  if to_regprocedure('public.create_studio__pre0159(text,text,text,text)') is null then
    alter function public.create_studio(text, text, text, text) rename to create_studio__pre0159;
  end if;
end $$;
revoke all on function public.create_studio__pre0159(text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_studio__pre0159(text, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.create_studio__pre0159(text, text, text, text) from authenticated'; end if;
end $$;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- direct-studio-0159: a NEW studio gets a payment-gate marker (a free trial set in the same call lifts it)
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0159(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    insert into public.studio_payment_gate(org_id, created_by)
      select o.id, auth.uid() from public.organizations o
       where o.id = v_org and o.created_at = now() and o.trial_ends_at is null
    on conflict (org_id) do nothing;
  end if;
  return v_org;
end $$;
revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated, service_role;

-- ---- 2) is this studio waiting for its first payment? ---------------------------------------
create or replace function public._studio_payment_pending(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- direct-studio-0159
  select p_org is not null
     and exists (select 1 from public.studio_payment_gate g join public.organizations o on o.id = g.org_id
                  where g.org_id = p_org and o.trial_ends_at is null
                    and not exists (select 1 from public.studio_subscriptions s
                                     where s.org_id = o.id
                                       and (s.status in ('active', 'past_due', 'suspended', 'cancelled')
                                            or (s.status = 'trial' and coalesce(s.trial_source, '') <> 'checkout'))))
     and not public._trial_paid(p_org);
$$;
revoke all on function public._studio_payment_pending(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._studio_payment_pending(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._studio_payment_pending(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._studio_payment_pending(uuid) to service_role'; end if;
end $$;

-- ---- 3) read-only guard: 0122 body + the payment-pending branch -----------------------------
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios (organizations.trial_ends_at) are read-only
-- direct-studio-0159: + a directly created studio is read-only until its first payment
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended')
     and not exists (select 1 from public.organizations x where x.trial_ends_at is not null and x.trial_ends_at <= now())
     and not exists (select 1 from public.studio_payment_gate g join public.organizations x on x.id = g.org_id
                      where x.trial_ends_at is null) then
    return coalesce(new, old); end if;                                                      -- fast path
  foreach r in array (case tg_op when 'INSERT' then array[to_jsonb(new)]
                                  when 'DELETE' then array[to_jsonb(old)]
                                  else array[to_jsonb(new), to_jsonb(old)] end) loop
    v_key := r ->> v_how; o := null;
    if v_key is not null and v_key ~* '^[0-9a-f-]{36}$' then
      if v_how in ('org_id', 'id') then o := v_key::uuid;
      elsif v_how in ('user_id', 'owner') then select p.org_id into o from public.profiles p where p.id = v_key::uuid;
      elsif v_how = 'quote_id' then select q.org_id into o from public.quotes q where q.id = v_key::uuid;
      end if;
    end if;
    if o is not null then v_orgs := v_orgs || o; end if;
  end loop;
  foreach o in array v_orgs loop
    if not public._studio_writable(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this studio''s Helm subscription is suspended - contact Helm'
        using errcode = '25006', hint = 'studio_suspended';
    end if;
    -- the owner can still accept terms / pay / edit their own profile while the trial is over
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications')
       and public._trial_locked(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this free trial has ended - choose a plan to keep editing. Your data is safe.'
        using errcode = '25006', hint = 'trial_ended';
    end if;
    -- direct studio, not paid yet: only billing details / Terms / own profile / the studio row.
    -- The rows create_studio writes in the SAME transaction that created the studio still go in
    -- (organizations.created_at defaults to now(), the transaction start time).
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications', 'organizations')
       and public._studio_payment_pending(o) and not public.is_platform_admin()
       and not exists (select 1 from public.organizations x where x.id = o and x.created_at = now()) then
      raise exception 'Choose a plan and complete payment to start using Helm - or start a free trial instead.'
        using errcode = '25006', hint = 'payment_pending';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

-- ---- 4) my_checkout_status: 0056 body + pending_payment ---------------------------------------
create or replace function public.my_checkout_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- direct-studio-0159
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; s public.studio_subscriptions;
  v_admin boolean := coalesce(public.is_admin(), false); v_created timestamptz; v_pending boolean;
begin
  if v_org is null then return jsonb_build_object('required', false, 'reason', 'no_studio'); end if;
  select * into b from public.helm_billing_settings where id;
  select * into s from public.studio_subscriptions where org_id = v_org;
  select o.created_at into v_created from public.organizations o where o.id = v_org;
  v_pending := public._studio_payment_pending(v_org);
  return jsonb_build_object(
    'required', v_admin and (v_pending or (s.org_id is null and b.checkout_required_after is not null
                and coalesce(v_created, '-infinity'::timestamptz) >= b.checkout_required_after)),
    'is_admin', v_admin, 'has_subscription', s.org_id is not null,
    'status', s.status, 'pending_payment', v_pending,
    'reason', case when not v_admin then 'member' when v_pending then 'pending_payment'
                   when s.org_id is not null then 'subscribed'
                   when b.checkout_required_after is null or coalesce(v_created, '-infinity'::timestamptz) < b.checkout_required_after then 'existing_studio'
                   else 'needs_checkout' end);
end $$;
revoke all on function public.my_checkout_status() from public, anon;
grant execute on function public.my_checkout_status() to authenticated;

-- ---- 5) my_checkout_options: 0119 body + pending_payment --------------------------------------
create or replace function public.my_checkout_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- unified-trial-0119 direct-studio-0159
declare v_org uuid := public.current_org_id(); v_cur text; b public.helm_billing_settings; s public.studio_subscriptions;
  a public.studio_account; v_plans jsonb;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_cur := public._checkout_currency(v_org);
  select * into b from public.helm_billing_settings where id;
  select * into s from public.studio_subscriptions where org_id = v_org;
  select * into a from public.studio_account where org_id = v_org;
  select coalesce(jsonb_agg(x - 'id' - 'rzp_monthly' - 'rzp_yearly'
                              || jsonb_build_object('online_monthly', x ->> 'rzp_monthly' is not null,
                                                    'online_yearly', x ->> 'rzp_yearly' is not null)
                            order by (x ->> 'sort_order')::int, x ->> 'code'), '[]'::jsonb)
    into v_plans
    from (select public._checkout_plan_price(hp.code, v_cur) x from public.helm_plans hp where hp.active) q
   where x is not null and x ->> 'monthly' is not null;
  return jsonb_build_object('currency', v_cur, 'plans', v_plans,
    'terms_version', b.terms_version, 'terms_accepted', a.terms_version_accepted is not distinct from b.terms_version and a.terms_version_accepted is not null,
    'bypass_allowed', coalesce(b.allow_trial_bypass, false), 'online_payments_live', coalesce(b.online_payments_live, false),
    'trial_days', public._trial_days(), 'has_subscription', s.org_id is not null, 'status', s.status,
    'pending_payment', public._studio_payment_pending(v_org));
end $$;
revoke all on function public.my_checkout_options() from public, anon;
grant execute on function public.my_checkout_options() to authenticated;

-- ---- 6) switch a waiting studio to the normal free trial (only while payment is not live) ----
create or replace function public.my_pending_start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- direct-studio-0159
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); b public.helm_billing_settings;
  v_end timestamptz; v_n int;
begin
  if v_uid is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into b from public.helm_billing_settings where id;
  perform pg_advisory_xact_lock(hashtext('helm_trial:' || v_org::text));
  if not public._studio_payment_pending(v_org) then
    return jsonb_build_object('result', 'not_pending'); end if;
  if coalesce(b.online_payments_live, false) then
    raise exception 'online payment is available - please choose a plan to continue' using errcode = '42501'; end if;
  if exists (select 1 from public.studio_subscriptions s where s.org_id = v_org) then
    raise exception 'a payment for this studio is already in progress - contact Helm support' using errcode = '22023'; end if;
  v_end := now() + make_interval(days => public._trial_days());
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'payment_pending', now(), v_uid)
  on conflict (org_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'a payment for this studio is already in progress - contact Helm support' using errcode = '22023'; end if;
  update public.organizations set trial_ends_at = v_end, trial_mode = coalesce(trial_mode, 'own')
   where id = v_org and trial_ends_at is null;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'my_pending_start_trial', 'trial_ends_at', v_end), v_org, now();
  return jsonb_build_object('result', 'started', 'trial_ends_at', v_end, 'trial_days', public._trial_days());
end $$;
revoke all on function public.my_pending_start_trial() from public, anon;
grant execute on function public.my_pending_start_trial() to authenticated;

-- ---- 7) plans for /checkout when none exist (pricing page; INR; proposed) --------------------
do $$ begin
  if not exists (select 1 from public.helm_plans where active) then
    insert into public.helm_plans(code, name, price_monthly, currency, active, description, features, sort_order)
    values
      ('starter', 'Starter', 1999, 'INR', true, 'Solo planners and decorators',
       '["Up to 3 team members", "Leads, clients and follow-ups (CRM)", "2D layout builder and 3D view", "Quotes with tax and client approval links", "Tasks and event calendar", "Payments received and profit per event"]'::jsonb, 10),
      ('studio', 'Studio', 4999, 'INR', true, 'Growing event companies',
       '["Everything in Starter", "Up to 15 team members", "Roles and access matrix", "Inventory, stock check-out and shortages", "Staff and crew app, vendor tasks", "Client portal, booklet and invitation site"]'::jsonb, 20)
    on conflict (code) do nothing;
    insert into public.helm_plan_prices(plan_id, currency, price_monthly, price_yearly)
      select hp.id, 'INR', x.m, x.y
        from (values ('starter', 1999::numeric, 19990::numeric), ('studio', 4999::numeric, 49990::numeric)) x(code, m, y)
        join public.helm_plans hp on hp.code = x.code
    on conflict (plan_id, currency) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 marker table private', (select c.relrowsecurity from pg_class c where c.oid = 'public.studio_payment_gate'::regclass)
       and not has_table_privilege('authenticated', 'public.studio_payment_gate', 'select')),
  ('02 no existing studio gated (no backfill)', not exists (select 1 from public.studio_payment_gate g join public.organizations o on o.id = g.org_id
       where o.created_at < g.created_at - interval '1 minute')),
  ('03 create_studio writes the marker', position('direct-studio-0159' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.create_studio(text,text,text,text)'))) > 0),
  ('04 create_studio callable', has_function_privilege('authenticated', 'public.create_studio(text, text, text, text)', 'execute')),
  ('05 previous create_studio kept + closed', to_regprocedure('public.create_studio__pre0159(text,text,text,text)') is not null
       and not has_function_privilege('authenticated', 'public.create_studio__pre0159(text, text, text, text)', 'execute')),
  ('06 read-only guard has the payment gate', position('payment_pending' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_studio_read_only()'))) > 0),
  ('07 checkout status reports pending', position('pending_payment' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_checkout_status()'))) > 0),
  ('08 switch-to-trial callable, not by anon', has_function_privilege('authenticated', 'public.my_pending_start_trial()', 'execute')
       and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.my_pending_start_trial()', 'execute'))),
  ('09 helper closed to the app', not has_function_privilege('authenticated', 'public._studio_payment_pending(uuid)', 'execute')),
  ('10 at least one active plan', exists (select 1 from public.helm_plans where active))
) v(item, ok);
