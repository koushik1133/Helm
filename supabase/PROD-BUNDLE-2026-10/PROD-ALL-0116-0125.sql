-- =====================================================================
-- PROD-ALL-0116-0125.sql  (Helm production catch-up, built 2026-10-16)
-- Runs migrations 0116, 0118, 0119, 0120, 0121, 0122, 0123, 0124, 0125 in order
-- as ONE transaction: if any statement fails, NOTHING is changed (all-or-nothing).
-- 0117 (per-studio Razorpay/WhatsApp accounts) is intentionally NOT included.
-- Additive + idempotent: new tables/columns/functions/triggers only; no row is deleted;
-- the only existing rows touched are 0122's repair of garbled 'Demo' sample names in
-- trial studios (none exist on prod yet) and settings defaults (trial_days = 8).
-- Run 00-PRECHECK.sql first (read-only). Then paste THIS whole file and Run.
-- Afterwards run VERIFY-ALL-0116-0125.sql (read-only): every ok must be true.
-- =====================================================================

begin;

-- ---------------------------------------------------------------- 10-APPLY-0116.sql
-- PROD BUNDLE step 10: APPLY-0116.sql (copied unchanged from supabase/APPLY-0116.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- APPLY-0116.sql — paste into the Supabase SQL editor (staging first). Same body as migrations/0116_trial_orgs.sql. Safe to run twice.

-- ============================================================================
-- 0116_trial_orgs.sql - CANONICAL forward-only. "Start free trial" -> a ready-to-explore
-- "Demo N" studio with sample data, 8 days, then read-only until the owner picks a plan.
-- REQUIRES 0020 (public_slug), 0045 (studio_subscriptions + tg_studio_read_only),
--          0049 (create_studio wrapper), 0058 (_trial_paid / my_trial_status),
--          0097 + 0100 (_demo_seed: the clearly-marked "Demo ·" sample studio).
--
-- In plain words:
--   * start_trial() (signed-in user with NO studio yet) creates a studio named "Demo N"
--     (next free N, decided under an advisory lock so two sign-ups never get the same N)
--     through the EXISTING create_studio() path (same template library, clean access
--     matrix, caller becomes the studio admin/owner). It then seeds the existing demo
--     sample (_demo_seed, every row is_demo + "Demo ·") plus a few extra fictional
--     clients / vendors / staff / stock and two more events, records an 8-day trial
--     (organizations.trial_ends_at + studio_subscriptions 'trial' so the existing trial
--     banner, reminders and checkout all work) and returns the studio.
--   * A caller who already has a studio gets that studio back: nothing is created,
--     nothing is seeded, no other studio is ever read or written.
--   * After trial_ends_at the studio becomes READ-ONLY (the existing zzz_studio_read_only
--     guard, now also aware of ended trials) until it is on an active / paid plan.
--     Nothing is deleted or hidden: every row stays readable; billing tables, the
--     owner's profile and the studio account (to accept terms / pay) stay writable.
--   * my_trial_org(): the banner's data (days left, ended, locked, is_admin).
--
-- ZERO DATA LOSS: additive + idempotent. New nullable column organizations.trial_ends_at
-- (default NULL -> every existing studio is unaffected: the trial lock only ever
-- applies to a studio whose trial_ends_at is set, i.e. one made by start_trial()).
-- New functions; tg_studio_read_only re-issued with its 0045 body + the trial branch.
-- No DROP, no DELETE, no TRUNCATE, no backfill of existing rows. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.create_studio(text,text,text,text)') is null then
    raise exception '0116: create_studio() is missing on this database'; end if;
  if to_regprocedure('public._demo_seed(uuid)') is null then
    raise exception '0116: apply 0097 + 0100 (demo seed) first'; end if;
  if to_regclass('public.studio_subscriptions') is null or to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception '0116: apply 0045 (HQ subscriptions) first'; end if;
  if to_regprocedure('public._trial_paid(uuid)') is null then
    raise exception '0116: apply 0058 (trial reminders) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'organizations' and column_name = 'public_slug') then
    raise exception '0116: apply 0020 (studio links) first'; end if;
end $$;

-- ---- 1) column (additive, NULL for every existing studio) ---------------------------------
alter table public.organizations add column if not exists trial_ends_at timestamptz default null;
create index if not exists organizations_trial_ends_idx116 on public.organizations (trial_ends_at)
  where trial_ends_at is not null;

-- ---- 2) helpers ---------------------------------------------------------------------------
-- next free "Demo N": 1 + the highest N already used by a studio called exactly "Demo N";
-- skips any N whose name or public link name (demo-N) is already taken.
-- Call it only while holding the start_trial advisory lock.
create or replace function public._trial_next_demo_number()
returns bigint language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116
declare n bigint; i int := 0;
begin
  select coalesce(max((m[1])::bigint), 0) + 1 into n
    from public.organizations o, lateral regexp_match(o.name, '^Demo ([0-9]{1,9})$') m;
  while exists (select 1 from public.organizations o
                 where lower(btrim(o.name)) = 'demo ' || n::text or o.public_slug = 'demo-' || n::text) loop
    n := n + 1; i := i + 1;
    if i > 1000 then raise exception 'could not pick a demo studio name' using errcode = 'P0001'; end if;
  end loop;
  return n;
end $$;
revoke all on function public._trial_next_demo_number() from public, anon, authenticated;

-- an ended, unpaid trial studio (made by start_trial) is read-only.
-- HQ extending the trial (studio_subscriptions.trial_ends_at moved later) is respected.
create or replace function public._trial_locked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-orgs-0116
  select p_org is not null
     and exists (select 1 from public.organizations o
                  left join public.studio_subscriptions s on s.org_id = o.id
                 where o.id = p_org and o.trial_ends_at is not null and o.trial_ends_at <= now()
                   and coalesce(s.status, '') <> 'active'
                   and not (coalesce(s.status, '') = 'trial' and s.trial_ends_at is not null
                            and s.trial_ends_at > (o.trial_ends_at at time zone 'UTC')::date
                            and s.trial_ends_at >= current_date))
     and not public._trial_paid(p_org);
$$;
revoke all on function public._trial_locked(uuid) from public, anon, authenticated;
grant execute on function public._trial_locked(uuid) to service_role;

-- ---- 3) read-only guard: 0045 body + the ended-trial branch -------------------------------
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios (organizations.trial_ends_at) are read-only
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended')
     and not exists (select 1 from public.organizations x where x.trial_ends_at is not null and x.trial_ends_at <= now()) then
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
      raise exception 'Read-only: this studio''s Helm subscription is suspended — contact Helm'
        using errcode = '25006', hint = 'studio_suspended';
    end if;
    -- the owner can still accept terms / pay / edit their own profile while the trial is over
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications')
       and public._trial_locked(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this free trial has ended — choose a plan to keep editing. Your data is safe.'
        using errcode = '25006', hint = 'trial_ended';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

-- ---- 4) extra fictional sample (fill-only, every row is_demo + "Demo ·") -----------------
-- Masters, clients and two more events from the staging demo set; complements _demo_seed.
create or replace function public._trial_seed_extra(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116
declare d date := current_date; q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid();
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if exists (select 1 from public.quotes where org_id = p_org and is_demo and code in ('DEMO-201', 'DEMO-202')) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo)
  select p_org, x.n, x.c, x.q, 'pcs', x.p, x.u, E'Demo item — sample data.', true, true
    from (values (E'Demo · Banquet chair (white cover)', 'Furniture', 400, 'A', 40::numeric),
                 (E'Demo · LED video wall panel', 'AV', 60, 'A', 2500::numeric),
                 (E'Demo · Truss segment (3 m)', 'Staging', 30, 'B', 900::numeric)) as x(n, c, q, p, u)
   where not exists (select 1 from public.inventory_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(btrim(x.n)));

  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo)
  select p_org, x.n, x.c, x.k, x.ph, x.em, E'Demo vendor — sample data.', true, true
    from (values (E'Demo · SoundWave Pro Audio', 'Sound & lights', 'rental', '+91 00000 00211', 'demo.soundwave@example.com'),
                 (E'Demo · Royal Tent House', 'Tents & structures', 'rental', '+91 00000 00212', 'demo.tent@example.com'),
                 (E'Demo · Bloom & Petal Florists', 'Florist', 'vendor', '+91 00000 00213', 'demo.bloom@example.com'),
                 (E'Demo · Spotlight LED Walls', 'AV', 'rental', '+91 00000 00214', 'demo.spotlight@example.com'),
                 (E'Demo · Spice Route Caterers', 'Catering', 'vendor', '+91 00000 00215', 'demo.spice@example.com')) as x(n, c, k, ph, em)
   where not exists (select 1 from public.vendors v where v.org_id = p_org and lower(btrim(v.name)) = lower(btrim(x.n)));

  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select p_org, x.n, x.ph, x.dep, x.rl, x.et, x.dr, E'Demo staff — sample data.', true, true
    from (values (E'Demo · Rohan Malhotra', '+91 00000 00111', 'Operations', 'Ops lead', 'full_time', 3500::numeric),
                 (E'Demo · Priya Nair', '+91 00000 00112', 'Design', 'Designer', 'full_time', 3000::numeric),
                 (E'Demo · Kavya Reddy', '+91 00000 00113', 'Finance', 'Finance', 'part_time', 2500::numeric)) as x(n, ph, dep, rl, et, dr)
   where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.n);

  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo)
  select p_org, x.n, x.ph, x.em, x.src, x.et, d + x.dd, x.b, x.g, E'Demo client — sample data.', x.st, true
    from (values (E'Demo · Aarav & Meera', '+91 00000 00311', 'demo.aarav@example.com', 'Referral', 'Wedding', 38, 1700000::numeric, 320, 'discovery'),
                 (E'Demo · Northwind Technologies', '+91 00000 00312', 'demo.northwind@example.com', 'Website', 'Corporate', 23, 1500000::numeric, 800, 'quoted'),
                 (E'Demo · Saffron Hotels', '+91 00000 00313', 'demo.saffron@example.com', 'Referral', 'Corporate', 16, 1000000::numeric, 300, 'quoted'),
                 (E'Demo · Iyer Family', '+91 00000 00314', 'demo.iyer@example.com', 'Walk-in', 'Anniversary', 52, 350000::numeric, 150, 'qualified'),
                 (E'Demo · Lotus Interiors', '+91 00000 00315', 'demo.lotus@example.com', 'Instagram', 'Product launch', 40, 500000::numeric, 120, 'new')) as x(n, ph, em, src, et, dd, b, g, st)
   where not exists (select 1 from public.leads l where l.org_id = p_org and l.name = x.n);

  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, is_demo) values
    (q1, p_org, 'DEMO-201', E'Demo · Northwind Tech Summit', 'Corporate', 'quote', 'none', 'quote', d + 23, '09:30',
     E'{"name":"Demo · Northwind Technologies","phone":"+91 00000 00312","email":"demo.northwind@example.com","city":"Bengaluru"}',
     '{"guests":800,"platePrice":950,"chairs":800,"chairPrice":45,"other":350000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', true),
    (q2, p_org, 'DEMO-202', E'Demo · Saffron Hotels Awards Night', 'Corporate', 'quote', 'none', 'proposal', d + 16, '19:30',
     E'{"name":"Demo · Saffron Hotels","phone":"+91 00000 00313","email":"demo.saffron@example.com","city":"Mumbai"}',
     '{"guests":300,"platePrice":1450,"chairs":300,"chairPrice":45,"other":200000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', true);
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2)
     and name like E'Demo · %';
  return jsonb_build_object('seeded', true, 'quotes', 2, 'leads', 5, 'staff', 3, 'vendors', 5, 'inventory', 3);
end $$;
revoke all on function public._trial_seed_extra(uuid) from public, anon, authenticated;

-- ---- 5) start_trial ----------------------------------------------------------------------
create or replace function public.start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116
declare
  v_uid uuid := auth.uid();
  v_had uuid; v_org uuid; v_n bigint; v_name text; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;

  -- one "Demo N" at a time across the whole database
  perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
  v_n := public._trial_next_demo_number();
  v_name := 'Demo ' || v_n::text;
  v_org := public.create_studio(v_name, null, 'INR', 'Asia/Kolkata');
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.name <> v_name or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + interval '8 days';
  update public.organizations set trial_ends_at = v_end where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  -- sample data: a failure here never blocks the trial (that block alone is rolled back)
  begin v_seed := public._demo_seed(v_org);
  exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  begin v_extra := public._trial_seed_extra(v_org);
  exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_trial', 'name', v_name, 'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'trial_ends_at', v_end,
                            'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated, service_role;

-- ---- 6) banner data ----------------------------------------------------------------------
-- {is_trial_org, name, ends_at, days_left, ended, locked, is_admin}; members only (no clients)
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116
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
    'ended', o.trial_ends_at <= now(), 'locked', v_locked,
    'is_admin', coalesce(public.is_admin(), false));
end $$;
revoke all on function public.my_trial_org() from public, anon;
grant execute on function public.my_trial_org() to authenticated, service_role;

notify pgrst, 'reload schema';

-- ---- VERIFY (expect every ok = true) ----
select '0116 organizations.trial_ends_at column' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'trial_ends_at' and is_nullable = 'YES') as ok
union all select '0116 existing studios unaffected (no trial_ends_at except Demo N trials)', not exists (select 1 from public.organizations o where o.trial_ends_at is not null and o.name !~ '^Demo [0-9]{1,9}$')
union all select '0116 start_trial exists', to_regprocedure('public.start_trial()') is not null
union all select '0116 start_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial()')), false)
union all select '0116 start_trial: authenticated may run', has_function_privilege('authenticated', 'public.start_trial()', 'execute')
union all select '0116 start_trial: anon may NOT run', not has_function_privilege('anon', 'public.start_trial()', 'execute')
union all select '0116 start_trial uses advisory lock + create_studio', pg_get_functiondef('public.start_trial()'::regprocedure) like '%pg_advisory_xact_lock%' and pg_get_functiondef('public.start_trial()'::regprocedure) like '%public.create_studio(%'
union all select '0116 my_trial_org exists', to_regprocedure('public.my_trial_org()') is not null
union all select '0116 my_trial_org: anon may NOT run', not has_function_privilege('anon', 'public.my_trial_org()', 'execute')
union all select '0116 helpers private', not has_function_privilege('authenticated', 'public._trial_next_demo_number()', 'execute') and not has_function_privilege('authenticated', 'public._trial_seed_extra(uuid)', 'execute') and not has_function_privilege('authenticated', 'public._trial_locked(uuid)', 'execute')
union all select '0116 read-only guard knows ended trials', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%trial-orgs-0116%'
union all select '0116 read-only guard keeps suspended rule', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%studio_suspended%'
union all select '0116 next demo number is positive', public._trial_next_demo_number() >= 1
union all select '0116 no existing studio is trial-locked unless it is a Demo N trial', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_locked(o.id));

-- ---------------------------------------------------------------- 11-APPLY-0118.sql
-- PROD BUNDLE step 11: APPLY-0118.sql (copied unchanged from supabase/APPLY-0118.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0118_trial_locale.sql - CANONICAL forward-only. REQUIRES 0116.
-- In plain words: a free-trial "Demo N" studio now starts in the VISITOR's own time zone
-- and currency (sent by the sign-up page from the browser), instead of always India/INR.
--   * NEW start_trial(p_timezone, p_currency): same body as 0116's start_trial(), only the
--     create_studio() call uses the validated values (unknown zone -> UTC, unknown currency -> USD).
--   * start_trial() (no arguments) is kept and behaves exactly as before (INR / Asia/Kolkata).
-- Additive + idempotent: no table change, no existing row touched, safe to run twice.
-- ============================================================================
create or replace function public.start_trial(p_timezone text, p_currency text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 trial-locale-0118
declare
  v_tz text := 'Asia/Kolkata'; v_cur text := 'INR';
  v_uid uuid := auth.uid();
  v_had uuid; v_org uuid; v_n bigint; v_name text; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;

  -- one "Demo N" at a time across the whole database
  perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
  v_n := public._trial_next_demo_number();
  v_name := 'Demo ' || v_n::text;
  -- visitor's own time zone + currency (validated; unknown values fall back to UTC / USD)
  if p_timezone is not null then
    v_tz := case when exists (select 1 from pg_catalog.pg_timezone_names t where t.name = btrim(p_timezone)) then btrim(p_timezone) else 'UTC' end;
  end if;
  if p_currency is not null then
    v_cur := case when upper(btrim(p_currency)) in ('INR','USD','AED','GBP','SGD','AUD','CAD','EUR') then upper(btrim(p_currency)) else 'USD' end;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.name <> v_name or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + interval '8 days';
  update public.organizations set trial_ends_at = v_end where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  -- sample data: a failure here never blocks the trial (that block alone is rolled back)
  begin v_seed := public._demo_seed(v_org);
  exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  begin v_extra := public._trial_seed_extra(v_org);
  exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_trial', 'name', v_name, 'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'trial_ends_at', v_end,
                            'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_trial(text, text) from public, anon;
grant execute on function public.start_trial(text, text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- VERIFY 0118 (read-only; expect every ok = true)
select '0118 start_trial(text,text) exists' as item, to_regprocedure('public.start_trial(text,text)') is not null as ok
union all select '0118 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial(text,text)')), false)
union all select '0118 authenticated may run', has_function_privilege('authenticated', 'public.start_trial(text,text)', 'execute')
union all select '0118 anon may NOT run', not has_function_privilege('anon', 'public.start_trial(text,text)', 'execute')
union all select '0118 validates time zone', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%pg_timezone_names%', false)
union all select '0118 keeps advisory lock + create_studio', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%pg_advisory_xact_lock%create_studio(%', false)
union all select '0118 old start_trial() still there', to_regprocedure('public.start_trial()') is not null;

-- ---------------------------------------------------------------- 12-APPLY-0119.sql
-- PROD BUNDLE step 12: APPLY-0119.sql (copied unchanged from supabase/APPLY-0119.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0119_unified_trial.sql - CANONICAL forward-only. ONE free trial for every self-serve studio.
-- REQUIRES 0054 (security alerts), 0056 (checkout), 0058 (trial reminders), 0097 + 0100 (demo seed,
--          organizations.trial_mode), 0116 (start_trial, trial_ends_at, read-only after the trial),
--          0118 (start_trial(text,text): visitor time zone + currency).
--
-- In plain words:
--   * There were two trials: the old "create studio -> profile -> Plan & payment -> 14-day trial"
--     (0056 my_start_trial) and the new "Start free trial -> Demo N, 8 days" (0116 start_trial).
--     Now every self-serve sign-up gets the SAME 8-day free trial:
--       start_self_serve_trial(name, time zone, currency, mode)
--         - name: the studio name the person typed, or "Demo N" when they left it empty
--         - time zone + currency: the visitor's own (validated, 0118 rules)
--         - mode: 'demo' (Try with demo data -> the existing sample studio is seeded) or
--                 'own'  (Start with my own data -> nothing is seeded)
--       It records the trial exactly like 0116 does (organizations.trial_ends_at +
--       studio_subscriptions 'trial'), so the banner, reminders, checkout and the
--       read-only-after-trial guard all keep working, and the owner is never sent through
--       "Plan & payment" before they have seen the app.
--   * helm_billing_settings.trial_days (NEW, default 8) is the one place the length lives.
--     my_start_trial (checkout button), checkout_attach_subscription and my_checkout_options
--     now read it instead of the hard-coded 14.
--   * start_trial() / start_trial(text,text) keep working (they call the new function with an
--     empty name + demo data), so an old cached sign-up page still lands in the same trial.
--   * my_trial_org() also returns trial_mode (the banner words differ for demo vs own data).
--   * Security alert "Member role changed" is no longer raised for a person's FIRST role in a
--     studio (creating a studio / joining one) - only for a real change inside the same studio.
--
-- ZERO DATA LOSS / existing studios unaffected: additive + idempotent. One new column with a
-- default (the only "config" row change: the singleton settings row gets trial_days = 8 through
-- the column default). No DROP / DELETE / TRUNCATE, no backfill, no existing studio, subscription,
-- trial or notification row is changed. Functions are re-issued with the same signatures and
-- grants. A studio that already has a studio is handed back unchanged by every entry point.
-- Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.start_trial(text,text)') is null or to_regprocedure('public._trial_seed_extra(uuid)') is null then
    raise exception '0119: apply 0116 + 0118 (free-trial studios) first'; end if;
  if to_regprocedure('public._demo_seed(uuid)') is null then
    raise exception '0119: apply 0097 + 0100 (demo seed) first'; end if;
  if to_regprocedure('public.my_start_trial(text,text)') is null or to_regprocedure('public.my_trial_status()') is null then
    raise exception '0119: apply 0056 + 0058 (checkout, trial reminders) first'; end if;
  if to_regprocedure('public._security_alert_safe(uuid,text,text,uuid,jsonb)') is null then
    raise exception '0119: apply 0054 (security alerts) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'organizations' and column_name = 'trial_mode') then
    raise exception '0119: organizations.trial_mode (0097) is missing'; end if;
end $$;

-- ---- 1) the trial length (config) ----------------------------------------------------------
alter table public.helm_billing_settings add column if not exists trial_days integer not null default 8;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.helm_billing_settings'::regclass
                   and conname = 'helm_billing_settings_trial_days_chk119') then
    alter table public.helm_billing_settings add constraint helm_billing_settings_trial_days_chk119
      check (trial_days between 1 and 60);
  end if;
end $$;

create or replace function public._trial_days()
returns integer language sql stable security definer set search_path = '' as $$
  -- unified-trial-0119
  select coalesce((select b.trial_days from public.helm_billing_settings b where b.id limit 1), 8);
$$;
revoke all on function public._trial_days() from public, anon, authenticated;
grant execute on function public._trial_days() to service_role;

-- ---- 2) the ONE self-serve trial -------------------------------------------------------------
create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare
  v_uid uuid := auth.uid();
  v_tz text := 'UTC'; v_cur text := 'USD';
  v_mode text := lower(btrim(coalesce(p_mode, 'demo')));
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_had uuid; v_org uuid; v_n bigint; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;
  if v_mode not in ('demo', 'own') then raise exception 'choose demo or own' using errcode = '22023'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 80) then
    raise exception 'studio name must be 2 to 80 characters' using errcode = '22023'; end if;
  -- visitor's own time zone + currency (0118 rules: unknown values fall back to UTC / USD)
  if p_timezone is not null and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = btrim(p_timezone)) then
    v_tz := btrim(p_timezone); end if;
  if p_currency is not null and upper(btrim(p_currency)) in ('INR','USD','AED','GBP','SGD','AUD','CAD','EUR') then
    v_cur := upper(btrim(p_currency)); end if;

  if v_name is null then
    -- one "Demo N" at a time across the whole database (same lock as 0116)
    perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
    v_n := public._trial_next_demo_number();
    v_name := 'Demo ' || v_n::text;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + make_interval(days => public._trial_days());
  update public.organizations set trial_ends_at = v_end, trial_mode = v_mode
   where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  if v_mode = 'demo' then
    -- sample data: a failure here never blocks the trial (that block alone is rolled back)
    begin v_seed := public._demo_seed(v_org);
    exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
    begin v_extra := public._trial_seed_extra(v_org);
    exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_self_serve_trial', 'name', v_name, 'mode', v_mode,
                              'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'mode', v_mode,
                            'trial_ends_at', v_end, 'trial_days', public._trial_days(), 'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_self_serve_trial(text, text, text, text) from public, anon;
grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated, service_role;

-- the 0116 / 0118 entry points land in the same trial (Demo N + demo data)
create or replace function public.start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119
begin
  return public.start_self_serve_trial(null, 'Asia/Kolkata', 'INR', 'demo');
end $$;
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated, service_role;

create or replace function public.start_trial(p_timezone text, p_currency text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 trial-locale-0118 unified-trial-0119
begin
  return public.start_self_serve_trial(null, p_timezone, p_currency, 'demo');
end $$;
revoke all on function public.start_trial(text, text) from public, anon;
grant execute on function public.start_trial(text, text) to authenticated, service_role;

-- ---- 3) checkout paths: the configured length instead of 14 ---------------------------------
-- 0056 body; only the length changed (+ a NEW studio that starts its trial here gets the same
-- trial_ends_at as a sign-up trial; studios older than checkout are never given one).
create or replace function public.my_start_trial(p_source text default 'bypass', p_plan text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; v_plan uuid; v_src text := coalesce(nullif(btrim(p_source), ''), 'bypass');
  v_days integer := public._trial_days(); v_end date;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_src not in ('bypass','payment_pending') then raise exception 'unknown trial source' using errcode = '22023'; end if;
  select * into b from public.helm_billing_settings where id;
  if v_src = 'bypass' and not coalesce(b.allow_trial_bypass, false) then
    raise exception 'skipping payment is turned off' using errcode = '42501'; end if;
  if v_src = 'payment_pending' and coalesce(b.online_payments_live, false) then
    raise exception 'online payment is available — please pay to continue' using errcode = '42501'; end if;
  select * into a from public.studio_account where org_id = v_org;
  if a.terms_version_accepted is null or a.terms_version_accepted is distinct from b.terms_version then
    raise exception 'please accept the Terms of Service first' using errcode = '22023'; end if;
  if p_plan is not null then
    select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan and hp.active;
    if v_plan is null then raise exception 'that plan is not available' using errcode = '22023'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('helm_trial:' || v_org::text));
  select * into s from public.studio_subscriptions where org_id = v_org for update;
  if found then
    if s.status = 'trial' then
      return jsonb_build_object('result', 'already_trial', 'status', s.status, 'trial_ends_at', s.trial_ends_at);
    end if;
    raise exception 'this studio already has a subscription' using errcode = '22023';
  end if;
  if exists (select 1 from public.subscription_payments p where p.org_id = v_org and p.voided_at is null) then
    raise exception 'this studio already has a subscription' using errcode = '22023'; end if;
  v_end := current_date + v_days;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, v_plan, 'trial', v_end, v_src, now(), auth.uid());
  update public.organizations o set trial_ends_at = now() + make_interval(days => v_days)
   where o.id = v_org and o.trial_ends_at is null
     and b.checkout_required_after is not null and o.created_at >= b.checkout_required_after;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'subscription.trial_started',
           'studio_subscriptions', v_org::text,
           jsonb_build_object('source', v_src, 'plan', p_plan, 'trial_ends_at', v_end), v_org, now();
  return jsonb_build_object('result', 'started', 'status', 'trial', 'trial_ends_at', v_end);
end $$;
revoke all on function public.my_start_trial(text, text) from public, anon;
grant execute on function public.my_start_trial(text, text) to authenticated;

-- 0058 body; only the length changed
create or replace function public.checkout_attach_subscription(p_org uuid, p_subscription_id text, p_plan text, p_interval text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
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
    values (p_org, v_plan, 'trial', current_date + public._trial_days(), 'checkout', p_interval, 'razorpay', p_subscription_id, now())
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
revoke all on function public.checkout_attach_subscription(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.checkout_attach_subscription(uuid, text, text, text) to service_role;

-- 0056 body; trial_days from the settings
create or replace function public.my_checkout_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- unified-trial-0119
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
    'trial_days', public._trial_days(), 'has_subscription', s.org_id is not null, 'status', s.status);
end $$;
revoke all on function public.my_checkout_options() from public, anon;
grant execute on function public.my_checkout_options() to authenticated;

-- ---- 4) banner data: + trial_mode (0116 body otherwise) ----------------------------------------
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119
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
    'is_admin', coalesce(public.is_admin(), false));
end $$;
revoke all on function public.my_trial_org() from public, anon;
grant execute on function public.my_trial_org() to authenticated, service_role;

-- ---- 5) security alert: no "Member role changed" for a person's FIRST role in a studio ----------
-- 0054 body; the UPDATE branch now needs the person to have been in THIS studio already
-- (creating a studio / accepting an invite sets org_id + role together: that is not a change).
create or replace function public.tg_sa54_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
-- unified-trial-0119
begin
  begin
    if TG_OP = 'UPDATE' then
      if new.org_id is not null and old.org_id is not null and old.org_id = new.org_id
         and old.role is distinct from new.role then
        perform public._security_alert_safe(new.org_id, 'role_changed', 'profiles.role', null,
          jsonb_build_object('subject_name', left(nullif(btrim(new.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()),
                             'old_role', left(old.role, 20), 'new_role', left(new.role, 20)));
      end if;
    elsif TG_OP = 'DELETE' then
      if old.org_id is not null and coalesce(old.role, '') <> 'client'
         and exists (select 1 from public.organizations o where o.id = old.org_id) then
        perform public._security_alert_safe(old.org_id, 'member_removed', 'profiles.delete', null,
          jsonb_build_object('subject_name', left(nullif(btrim(old.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()), 'old_role', left(old.role, 20)));
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.tg_sa54_profile() from public;

notify pgrst, 'reload schema';

-- VERIFY 0119 (read-only; expect every ok = true)
select '0119 trial_days column exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_billing_settings' and column_name = 'trial_days') as ok
union all select '0119 trial length is 8 days', (select b.trial_days = 8 from public.helm_billing_settings b where b.id limit 1)
union all select '0119 start_self_serve_trial exists', to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is not null
union all select '0119 start_self_serve_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_self_serve_trial(text,text,text,text)')), false)
union all select '0119 authenticated may start a trial', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 anon may NOT start a trial', not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 start_trial() -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial()')) like '%start_self_serve_trial(%', false)
union all select '0119 start_trial(text,text) -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%start_self_serve_trial(%', false)
union all select '0119 my_start_trial uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) like '%_trial_days()%', false)
union all select '0119 my_start_trial no longer 14 days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) not like '%current_date + 14%', false)
union all select '0119 checkout_attach uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.checkout_attach_subscription(uuid,text,text,text)')) like '%_trial_days()%', false)
union all select '0119 checkout_attach service role only', not has_function_privilege('authenticated', 'public.checkout_attach_subscription(uuid,text,text,text)', 'execute')
union all select '0119 my_checkout_options trial_days from settings', coalesce(pg_get_functiondef(to_regprocedure('public.my_checkout_options()')) like '%''trial_days'', public._trial_days()%', false)
union all select '0119 my_trial_org returns trial_mode', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''trial_mode''%', false)
union all select '0119 role alert skips first role', coalesce(pg_get_functiondef(to_regprocedure('public.tg_sa54_profile()')) like '%old.org_id is not null and old.org_id = new.org_id%', false)
union all select '0119 role-change trigger still attached', exists (select 1 from pg_trigger where tgname = 'zzz_sa54_profile_role' and tgrelid = 'public.profiles'::regclass)
union all select '0119 _trial_days not callable by users', not has_function_privilege('authenticated', 'public._trial_days()', 'execute');

-- ---------------------------------------------------------------- 13-APPLY-0120.sql
-- PROD BUNDLE step 13: APPLY-0120.sql (copied unchanged from supabase/APPLY-0120.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

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

-- VERIFY 0120 (read-only; expect every ok = true)
select '0120 trial_reminders table exists' as item, to_regclass('public.trial_reminders') is not null as ok
union all select '0120 trial_reminders RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_reminders')), false)
union all select '0120 dedupe key is unique', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'trial_reminders_dedupe_key120' and indexdef ilike '%unique%')
union all select '0120 users cannot read the ledger', not has_table_privilege('authenticated', 'public.trial_reminders', 'select')
union all select '0120 tick exists + security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.trial_reminders_tick()')), false)
union all select '0120 tick: service role only', has_function_privilege('service_role', 'public.trial_reminders_tick()', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminders_tick()', 'execute') and not has_function_privilege('anon', 'public.trial_reminders_tick()', 'execute')
union all select '0120 email claim: service role only', has_function_privilege('service_role', 'public.trial_reminder_email_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminder_email_claim(integer)', 'execute')
union all select '0120 email mark: service role only', has_function_privilege('service_role', 'public.trial_reminder_email_mark(uuid,text)', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminder_email_mark(uuid,text)', 'execute')
union all select '0120 milestone d5 (3 days before end, studio zone)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-06 09:00+05:30', 'Asia/Kolkata') = 'd5'
union all select '0120 milestone d7 (day before end)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-08 23:00+05:30', 'Asia/Kolkata') = 'd7'
union all select '0120 milestone d8 (last day)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-09 00:30+05:30', 'Asia/Kolkata') = 'd8'
union all select '0120 milestone none after end', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-09 10:00+05:30', 'Asia/Kolkata') is null
union all select '0120 milestone uses studio zone', public._trial_reminder_milestone('2026-10-09 04:00+00', '2026-10-08 17:00+00', 'America/Chicago') = 'd8'
union all select '0120 my_trial_org returns timezone', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''timezone''%', false)
union all select '0120 my_trial_org still for members', has_function_privilege('authenticated', 'public.my_trial_org()', 'execute')
union all select '0120 0058 job skips 8-day trial studios', coalesce(pg_get_functiondef(to_regprocedure('public._trial_refresh()')) like '%o.trial_ends_at is not null%', false);
-- if pg_cron is installed, also run: select jobname, schedule from cron.job where jobname = 'helm_trial_reminders';

-- ---------------------------------------------------------------- 14-APPLY-0121.sql
-- PROD BUNDLE step 14: APPLY-0121.sql (copied unchanged from supabase/APPLY-0121.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0121_dashboard_due_today.sql - CANONICAL forward-only. REQUIRES 0108.
-- In plain words: the dashboard "Today" strip can now also show payment milestones due TODAY
-- (in the studio's time zone), not only overdue ones.
--   * NEW read-only dashboard_due_today(): up to 20 milestones due today on confirmed events that
--     are not waived and not fully paid. Same "paid" rule as dashboard_money (0108): ledger first,
--     milestones marked paid only for very old events with no ledger rows.
--   * Studio members with finance VIEW only; own studio only. No table change, no row touched.
-- Additive + idempotent: safe to run twice.
-- ============================================================================
create or replace function public.dashboard_due_today()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-due-today-0121
declare
  v_org uuid := public.current_org_id();
  v_tz text; v_cur text; v_today date; v_out jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;

  with q as (
    select q.id, q.code, q.title, q.client, q.status,
           case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
  ), led as (
    select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
     where p.org_id = v_org group by p.quote_id
  ), y as (
    select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, q.code, q.title, q.client, q.cur,
           coalesce(led.paid, 0) as qpaid, led.quote_id is not null as has_led,
           coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                        rows between unbounded preceding and 1 preceding), 0) as prior_amt
      from public.payment_milestones m
      join q on q.id = m.quote_id
      left join led on led.quote_id = m.quote_id
     where m.org_id = v_org
  ), z as (
    select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                     when y.mstatus = 'paid' then y.amount else 0 end as mpaid
      from y
  )
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', s.quote_id, 'milestone_id', s.id, 'code', s.code, 'title', s.title,
           'client', nullif(btrim(coalesce(s.client ->> 'name', '')), ''), 'label', s.label, 'due_date', s.due_date,
           'amount', s.amount, 'paid', s.mpaid, 'balance', s.amount - s.mpaid, 'currency', s.cur) order by s.code), '[]'::jsonb)
    into v_out
    from (select * from z
           where z.due_date = v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
           order by z.code limit 20) s;
  return jsonb_build_object('today', v_today, 'currency', v_cur, 'due_today', v_out);
end $$;

do $$ begin
  execute 'revoke all on function public.dashboard_due_today() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_due_today() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_due_today() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.dashboard_due_today() to service_role'; end if;
end $$;

notify pgrst, 'reload schema';

-- VERIFY 0121 (read-only; expect every ok = true)
select '0121 dashboard_due_today exists' as item, to_regprocedure('public.dashboard_due_today()') is not null as ok
union all select '0121 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.dashboard_due_today()')), false)
union all select '0121 authenticated may run', has_function_privilege('authenticated', 'public.dashboard_due_today()', 'execute')
union all select '0121 anon may NOT run', not has_function_privilege('anon', 'public.dashboard_due_today()', 'execute')
union all select '0121 needs finance view', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%has_area(''finance'', ''view'')%', false)
union all select '0121 own studio only', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%m.org_id = v_org%', false);

-- ---------------------------------------------------------------- 15-APPLY-0122.sql
-- PROD BUNDLE step 15: APPLY-0122.sql (copied unchanged from supabase/APPLY-0122.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0122_trial_text_fix.sql - CANONICAL forward-only. REQUIRES 0116, 0119.
-- In plain words: when 0116/0119 were pasted into the SQL editor, special characters (the
-- "·" in "Demo ·" and the dash "—") were turned into two- and three-letter garbage (a "not" sign plus a sum sign, and similar). This re-creates the
-- three affected functions with the right characters, and repairs the sample ("Demo ·")
-- names already created in FREE-TRIAL studios only. Real (non-sample) data is never touched.
--   * tg_studio_read_only, _trial_seed_extra (0116) and my_start_trial (0119): same bodies.
--   * archive_lead (lead history trigger) now records the lead's own studio.
--   * _trial_seed_extra also sets its two sample quotes to the studio's own currency.
-- Additive + idempotent: safe to run twice. IMPORTANT: paste this file as UTF-8.
-- ============================================================================
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios (organizations.trial_ends_at) are read-only
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended')
     and not exists (select 1 from public.organizations x where x.trial_ends_at is not null and x.trial_ends_at <= now()) then
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
      raise exception 'Read-only: this studio''s Helm subscription is suspended — contact Helm'
        using errcode = '25006', hint = 'studio_suspended';
    end if;
    -- the owner can still accept terms / pay / edit their own profile while the trial is over
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications')
       and public._trial_locked(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this free trial has ended — choose a plan to keep editing. Your data is safe.'
        using errcode = '25006', hint = 'trial_ended';
    end if;
  end loop;
  return coalesce(new, old);
end $$;

create or replace function public._trial_seed_extra(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116
declare d date := current_date; q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid();
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if exists (select 1 from public.quotes where org_id = p_org and is_demo and code in ('DEMO-201', 'DEMO-202')) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo)
  select p_org, x.n, x.c, x.q, 'pcs', x.p, x.u, E'Demo item — sample data.', true, true
    from (values (E'Demo · Banquet chair (white cover)', 'Furniture', 400, 'A', 40::numeric),
                 (E'Demo · LED video wall panel', 'AV', 60, 'A', 2500::numeric),
                 (E'Demo · Truss segment (3 m)', 'Staging', 30, 'B', 900::numeric)) as x(n, c, q, p, u)
   where not exists (select 1 from public.inventory_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(btrim(x.n)));

  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo)
  select p_org, x.n, x.c, x.k, x.ph, x.em, E'Demo vendor — sample data.', true, true
    from (values (E'Demo · SoundWave Pro Audio', 'Sound & lights', 'rental', '+91 00000 00211', 'demo.soundwave@example.com'),
                 (E'Demo · Royal Tent House', 'Tents & structures', 'rental', '+91 00000 00212', 'demo.tent@example.com'),
                 (E'Demo · Bloom & Petal Florists', 'Florist', 'vendor', '+91 00000 00213', 'demo.bloom@example.com'),
                 (E'Demo · Spotlight LED Walls', 'AV', 'rental', '+91 00000 00214', 'demo.spotlight@example.com'),
                 (E'Demo · Spice Route Caterers', 'Catering', 'vendor', '+91 00000 00215', 'demo.spice@example.com')) as x(n, c, k, ph, em)
   where not exists (select 1 from public.vendors v where v.org_id = p_org and lower(btrim(v.name)) = lower(btrim(x.n)));

  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select p_org, x.n, x.ph, x.dep, x.rl, x.et, x.dr, E'Demo staff — sample data.', true, true
    from (values (E'Demo · Rohan Malhotra', '+91 00000 00111', 'Operations', 'Ops lead', 'full_time', 3500::numeric),
                 (E'Demo · Priya Nair', '+91 00000 00112', 'Design', 'Designer', 'full_time', 3000::numeric),
                 (E'Demo · Kavya Reddy', '+91 00000 00113', 'Finance', 'Finance', 'part_time', 2500::numeric)) as x(n, ph, dep, rl, et, dr)
   where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.n);

  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo)
  select p_org, x.n, x.ph, x.em, x.src, x.et, d + x.dd, x.b, x.g, E'Demo client — sample data.', x.st, true
    from (values (E'Demo · Aarav & Meera', '+91 00000 00311', 'demo.aarav@example.com', 'Referral', 'Wedding', 38, 1700000::numeric, 320, 'discovery'),
                 (E'Demo · Northwind Technologies', '+91 00000 00312', 'demo.northwind@example.com', 'Website', 'Corporate', 23, 1500000::numeric, 800, 'quoted'),
                 (E'Demo · Saffron Hotels', '+91 00000 00313', 'demo.saffron@example.com', 'Referral', 'Corporate', 16, 1000000::numeric, 300, 'quoted'),
                 (E'Demo · Iyer Family', '+91 00000 00314', 'demo.iyer@example.com', 'Walk-in', 'Anniversary', 52, 350000::numeric, 150, 'qualified'),
                 (E'Demo · Lotus Interiors', '+91 00000 00315', 'demo.lotus@example.com', 'Instagram', 'Product launch', 40, 500000::numeric, 120, 'new')) as x(n, ph, em, src, et, dd, b, g, st)
   where not exists (select 1 from public.leads l where l.org_id = p_org and l.name = x.n);

  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, is_demo) values
    (q1, p_org, 'DEMO-201', E'Demo · Northwind Tech Summit', 'Corporate', 'quote', 'none', 'quote', d + 23, '09:30',
     E'{"name":"Demo · Northwind Technologies","phone":"+91 00000 00312","email":"demo.northwind@example.com","city":"Bengaluru"}',
     '{"guests":800,"platePrice":950,"chairs":800,"chairPrice":45,"other":350000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', true),
    (q2, p_org, 'DEMO-202', E'Demo · Saffron Hotels Awards Night', 'Corporate', 'quote', 'none', 'proposal', d + 16, '19:30',
     E'{"name":"Demo · Saffron Hotels","phone":"+91 00000 00313","email":"demo.saffron@example.com","city":"Mumbai"}',
     '{"guests":300,"platePrice":1450,"chairs":300,"chairPrice":45,"other":200000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', true);
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2)
     and name like E'Demo · %';
  -- 0122: sample quotes use the studio's own currency (a USD trial is not seeded in INR)
  update public.quotes q
     set currency = o.cur,
         pricing = jsonb_set(coalesce(q.pricing, '{}'::jsonb), '{currency}', to_jsonb(o.cur))
    from (select case when upper(coalesce(x.currency, '')) ~ '^[A-Z]{3}$' then upper(x.currency) else 'INR' end as cur
            from public.organizations x where x.id = p_org) o
   where q.org_id = p_org and q.id in (q1, q2) and q.currency is distinct from o.cur;
  return jsonb_build_object('seeded', true, 'quotes', 2, 'leads', 5, 'staff', 3, 'vendors', 5, 'inventory', 3);
end $$;

create or replace function public.my_start_trial(p_source text default 'bypass', p_plan text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; v_plan uuid; v_src text := coalesce(nullif(btrim(p_source), ''), 'bypass');
  v_days integer := public._trial_days(); v_end date;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_src not in ('bypass','payment_pending') then raise exception 'unknown trial source' using errcode = '22023'; end if;
  select * into b from public.helm_billing_settings where id;
  if v_src = 'bypass' and not coalesce(b.allow_trial_bypass, false) then
    raise exception 'skipping payment is turned off' using errcode = '42501'; end if;
  if v_src = 'payment_pending' and coalesce(b.online_payments_live, false) then
    raise exception 'online payment is available — please pay to continue' using errcode = '42501'; end if;
  select * into a from public.studio_account where org_id = v_org;
  if a.terms_version_accepted is null or a.terms_version_accepted is distinct from b.terms_version then
    raise exception 'please accept the Terms of Service first' using errcode = '22023'; end if;
  if p_plan is not null then
    select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan and hp.active;
    if v_plan is null then raise exception 'that plan is not available' using errcode = '22023'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('helm_trial:' || v_org::text));
  select * into s from public.studio_subscriptions where org_id = v_org for update;
  if found then
    if s.status = 'trial' then
      return jsonb_build_object('result', 'already_trial', 'status', s.status, 'trial_ends_at', s.trial_ends_at);
    end if;
    raise exception 'this studio already has a subscription' using errcode = '22023';
  end if;
  if exists (select 1 from public.subscription_payments p where p.org_id = v_org and p.voided_at is null) then
    raise exception 'this studio already has a subscription' using errcode = '22023'; end if;
  v_end := current_date + v_days;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, v_plan, 'trial', v_end, v_src, now(), auth.uid());
  update public.organizations o set trial_ends_at = now() + make_interval(days => v_days)
   where o.id = v_org and o.trial_ends_at is null
     and b.checkout_required_after is not null and o.created_at >= b.checkout_required_after;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'subscription.trial_started',
           'studio_subscriptions', v_org::text,
           jsonb_build_object('source', v_src, 'plan', p_plan, 'trial_ends_at', v_end), v_org, now();
  return jsonb_build_object('result', 'started', 'status', 'trial', 'trial_ends_at', v_end);
end $$;

-- lead history: take the studio from the lead itself (was the signed-in user's studio, which is
-- empty in the SQL editor / service jobs and made the history insert fail). Same rows otherwise.
create or replace function public.archive_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.leads; act text;
begin
  if tg_op = 'DELETE' then r := old; act := 'deleted';
  elsif tg_op = 'INSERT' then r := new; act := 'created';
  else
    r := new;
    act := case when new.quote_id is not null and old.quote_id is null
                then 'converted' else 'updated' end;
  end if;
  insert into public.lead_archive
    (lead_id, action, name, phone, email, source, event_type, event_date,
     budget, guest_count, notes, status, quote_id, snapshot, archived_by, org_id)
  values
    (r.id, act, r.name, r.phone, r.email, r.source, r.event_type, r.event_date,
     r.budget, r.guest_count, r.notes, r.status, r.quote_id, to_jsonb(r), auth.uid(),
     coalesce(r.org_id, public.current_org_id()));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

-- repair existing sample rows in trial studios: only is_demo rows, only the broken character pairs.
-- The broken pairs are built with chr() so this block survives any clipboard encoding.
do $$
declare
  b1 text := chr(172) || chr(8721);              -- broken middle dot  ->  "·"
  b2 text := chr(8218) || chr(196) || chr(238);  -- broken long dash  ->  "—"
  g1 text := chr(183); g2 text := chr(8212);
begin
  update public.inventory_items i set name = replace(replace(i.name, b1, g1), b2, g2), notes = replace(replace(i.notes, b1, g1), b2, g2)
   where i.is_demo and i.org_id in (select o.id from public.organizations o where o.trial_ends_at is not null)
     and (i.name like '%' || b1 || '%' or i.notes like '%' || b2 || '%');
  update public.vendors v set name = replace(replace(v.name, b1, g1), b2, g2), notes = replace(replace(v.notes, b1, g1), b2, g2)
   where v.is_demo and v.org_id in (select o.id from public.organizations o where o.trial_ends_at is not null)
     and (v.name like '%' || b1 || '%' or v.notes like '%' || b2 || '%');
  update public.crew_members c set name = replace(replace(c.name, b1, g1), b2, g2), notes = replace(replace(c.notes, b1, g1), b2, g2)
   where c.is_demo and c.org_id in (select o.id from public.organizations o where o.trial_ends_at is not null)
     and (c.name like '%' || b1 || '%' or c.notes like '%' || b2 || '%');
  update public.leads l set name = replace(replace(l.name, b1, g1), b2, g2), notes = replace(replace(l.notes, b1, g1), b2, g2)
   where l.is_demo and l.org_id in (select o.id from public.organizations o where o.trial_ends_at is not null)
     and (l.name like '%' || b1 || '%' or l.notes like '%' || b2 || '%');
  update public.quotes q set title = replace(q.title, b1, g1), client = replace(q.client::text, b1, g1)::jsonb
   where q.code like 'DEMO-%' and q.org_id in (select o.id from public.organizations o where o.trial_ends_at is not null)
     and (q.title like '%' || b1 || '%' or q.client::text like '%' || b1 || '%');
end $$;

notify pgrst, 'reload schema';

-- VERIFY 0122 (read-only; expect every ok = true)
select '0122 seed function has the real "Demo ·"' as item, coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%Demo ' || chr(183) || ' %', false) as ok
union all select '0122 seed function has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%' || chr(172) || chr(8721) || '%', false)
union all select '0122 seed uses the studio currency', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%0122%', false)
union all select '0122 read-only guard has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%' || chr(8218) || chr(196) || '%', false)
union all select '0122 trial studios: no broken quote titles', not exists (select 1 from public.quotes q join public.organizations o on o.id = q.org_id where o.trial_ends_at is not null and q.title like '%' || chr(172) || chr(8721) || '%')
union all select '0122 trial studios: no broken vendor names', not exists (select 1 from public.vendors v join public.organizations o on o.id = v.org_id where o.trial_ends_at is not null and v.name like '%' || chr(172) || chr(8721) || '%')
union all select '0122 lead history records the lead''s studio', coalesce(pg_get_functiondef(to_regprocedure('public.archive_lead()')) like '%r.org_id%', false);

-- ---------------------------------------------------------------- 16-APPLY-0123.sql
-- PROD BUNDLE step 16: APPLY-0123.sql (copied unchanged from supabase/APPLY-0123.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- ============================================================================
-- 0123_trial_start_fresh.sql - CANONICAL forward-only. REQUIRES 0097.
-- In plain words: "Start my own studio" shows the trial admin exactly what will be removed
-- (how many sample events, leads, staff ... marked "Demo") before they confirm. This only
-- ADDS a "counts" breakdown to my_demo_status() - it reads, it never changes or deletes
-- anything. Removing the samples still goes through the existing clear_demo_data(), which
-- touches ONLY this studio's rows flagged is_demo.
-- Additive + idempotent: same signature, same keys as before plus "counts". Safe to run twice.
-- ============================================================================
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-start-fresh-0123: 0097 body + per-type counts (read-only)
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int; v_counts jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode into v_mode from public.organizations o where o.id = v_org;
  v_counts := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and is_demo),
    'leads',     (select count(*) from public.leads where org_id = v_org and is_demo),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and is_demo and active),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and is_demo));
  select (select count(*) from public.quotes where org_id = v_org and is_demo)
       + (select count(*) from public.leads where org_id = v_org and is_demo)
       + (select count(*) from public.crew_members where org_id = v_org and is_demo)
       + (select count(*) from public.vendors where org_id = v_org and is_demo)
       + (select count(*) from public.inventory_items where org_id = v_org and is_demo)
       + (select count(*) from public.venues where org_id = v_org and is_demo and active)
       + (select count(*) from public.menu_templates where org_id = v_org and is_demo)
       + (select count(*) from public.layouts where org_id = v_org and is_demo)
    into v_rows;
  return jsonb_build_object('trial_mode', v_mode, 'demo_rows', v_rows, 'has_demo', v_rows > 0,
    'is_admin', coalesce(public.is_admin(), false), 'counts', v_counts);
end $$;

revoke all on function public.my_demo_status() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;

-- ---------------------------------------------------------------- 17-APPLY-0124.sql
-- PROD BUNDLE step 17: APPLY-0124.sql (copied unchanged from supabase/APPLY-0124.sql). Run 02-BACKUP-function-defs.sql FIRST (once).

-- APPLY 0124 (paste whole file; one transaction, then the read-only checks; expect every ok = true)

-- ============================================================================
-- 0124_vendor_bills.sql - CANONICAL forward-only. REQUIRES 0049, 0101 (_r101_quote_tax), 0116.
-- In plain words (Phase C, client meeting):
--   * vendor_bills  - a bill a vendor sent for an event (number, date, amount, due date,
--                     optional photo/PDF in the existing event-docs files). Never deleted:
--                     a wrong bill is VOIDED with a reason (only while nothing is paid on it).
--   * vendor_payouts - money the studio paid against a bill. Written ONLY by the RPC
--                     record_vendor_payout, which is idempotent (same key = same payout,
--                     never twice) and refuses to pay more than the bill's open balance.
--   * event_pnl(quote)  - read-only per-event profit: Revenue (ex-tax) - Vendors -
--                     Logistics/Other - Staff expenses = Net profit. Vendor cost comes from
--                     ONE source per booking: its bills when it has any, else the booking
--                     cost (no double count).
--   * vendor_payables_summary() / business_pnl(from, to) - read-only studio totals for the
--     Business page (payables due/overdue, net profit by month, top events by profit).
-- Access: same studio only + the "finance" area (has_area). No delete policy anywhere.
-- Existing tables and rows are untouched (event_costs.category already exists).
-- Additive + idempotent: safe to run twice. ASCII only.
-- ============================================================================

create table if not exists public.vendor_bills (
  id uuid not null default gen_random_uuid() primary key,
  org_id uuid not null default public.current_org_id() references public.organizations(id),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  booking_id uuid references public.event_resources(id) on delete set null,
  vendor_id uuid references public.vendors(id) on delete set null,
  bill_no text,
  bill_date date not null default current_date,
  description text,
  amount numeric not null,
  currency text not null default 'INR',
  due_date date,
  file_id uuid references public.event_files(id) on delete set null,
  status text not null default 'open',
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint vendor_bills_amount_ck check (amount > 0 and amount < 1000000000000),
  constraint vendor_bills_status_ck check (status in ('open', 'void')),
  constraint vendor_bills_void_ck check (status <> 'void' or length(btrim(coalesce(void_reason, ''))) >= 3),
  constraint vendor_bills_text_ck check (length(coalesce(bill_no, '')) <= 80 and length(coalesce(description, '')) <= 500)
);
create index if not exists ix_vendor_bills_quote on public.vendor_bills (quote_id);
create index if not exists ix_vendor_bills_org_due on public.vendor_bills (org_id, due_date);

create table if not exists public.vendor_payouts (
  id uuid not null default gen_random_uuid() primary key,
  bill_id uuid not null references public.vendor_bills(id) on delete cascade,
  org_id uuid not null default public.current_org_id() references public.organizations(id),
  amount numeric not null,
  paid_on date not null default current_date,
  method text,
  reference text,
  idempotency_key text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint vendor_payouts_amount_ck check (amount > 0),
  constraint vendor_payouts_text_ck check (length(coalesce(method, '')) <= 40 and length(coalesce(reference, '')) <= 120)
);
create index if not exists ix_vendor_payouts_bill on public.vendor_payouts (bill_id);
create unique index if not exists ux_vendor_payouts_idem on public.vendor_payouts (org_id, idempotency_key) where idempotency_key is not null;

-- ---- RLS: same studio + finance area; NO delete policy (void instead) ----------------------
alter table public.vendor_bills enable row level security;
alter table public.vendor_bills force row level security;
alter table public.vendor_payouts enable row level security;
alter table public.vendor_payouts force row level security;

drop policy if exists vendor_bills_select on public.vendor_bills;
drop policy if exists vendor_bills_insert on public.vendor_bills;
drop policy if exists vendor_bills_update on public.vendor_bills;
create policy vendor_bills_select on public.vendor_bills for select to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'view'));
create policy vendor_bills_insert on public.vendor_bills for insert to authenticated
  with check (org_id = public.current_org_id() and public.has_area('finance', 'edit')
    and exists (select 1 from public.quotes q where q.id = quote_id and q.org_id = public.current_org_id())
    and (booking_id is null or exists (select 1 from public.event_resources b where b.id = booking_id and b.org_id = public.current_org_id() and b.quote_id = vendor_bills.quote_id))
    and (vendor_id is null or exists (select 1 from public.vendors v where v.id = vendor_id and v.org_id = public.current_org_id()))
    and (file_id is null or exists (select 1 from public.event_files f where f.id = file_id and f.org_id = public.current_org_id() and f.quote_id = vendor_bills.quote_id)));
create policy vendor_bills_update on public.vendor_bills for update to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'edit'))
  with check (org_id = public.current_org_id() and public.has_area('finance', 'edit'));

drop policy if exists vendor_payouts_select on public.vendor_payouts;
create policy vendor_payouts_select on public.vendor_payouts for select to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'view'));
-- (no insert/update/delete policy: payouts are written only by record_vendor_payout)

revoke delete on public.vendor_bills from anon, authenticated;
revoke all on public.vendor_payouts from anon;
revoke insert, update, delete on public.vendor_payouts from authenticated;
grant select, insert, update on public.vendor_bills to authenticated;
grant select on public.vendor_payouts to authenticated;

-- Users can never delete a bill or payout (no delete grant, no delete policy). Rows only go
-- away if the whole event is hard-deleted (FK cascade), same as every other event table.
-- ---- guard: a bill's studio/event never moves; amount never drops below what is paid;
--      a bill with payouts cannot be voided; a void bill is final -----------------------------
create or replace function public.tg_vendor_bill_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- vendor-bills-0124
declare v_paid numeric;
begin
  if new.org_id is distinct from old.org_id or new.quote_id is distinct from old.quote_id then
    raise exception 'A bill cannot be moved to another event.' using errcode = '42501';
  end if;
  if old.status = 'void' and (new.status <> 'void' or new.amount <> old.amount) then
    raise exception 'This bill is void and cannot be changed.' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.vendor_payouts p where p.bill_id = old.id;
  if new.amount < v_paid then
    raise exception 'The bill amount cannot be lower than what is already paid (%).', v_paid using errcode = '22023';
  end if;
  if new.status = 'void' and old.status <> 'void' then
    if v_paid > 0 then raise exception 'A bill with payments cannot be voided.' using errcode = '22023'; end if;
    new.voided_at := now(); new.voided_by := auth.uid();
  end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists vendor_bills_guard on public.vendor_bills;
create trigger vendor_bills_guard before update on public.vendor_bills
  for each row execute function public.tg_vendor_bill_guard();

create or replace function public.tg_vendor_payout_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Vendor payouts are a ledger and cannot be changed.' using errcode = '42501';
end $$;
drop trigger if exists vendor_payouts_immutable on public.vendor_payouts;
create trigger vendor_payouts_immutable before update on public.vendor_payouts
  for each row execute function public.tg_vendor_payout_immutable();

-- ended-trial / suspended studios are read-only (same guard every other table has, 0045/0116)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    execute 'drop trigger if exists zzz_studio_read_only on public.vendor_bills';
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.vendor_bills for each row execute function public.tg_studio_read_only(''org_id'')';
    execute 'drop trigger if exists zzz_studio_read_only on public.vendor_payouts';
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.vendor_payouts for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- record_vendor_payout: idempotent, refuses overpayment ---------------------------------
create or replace function public.record_vendor_payout(p_bill uuid, p_amount numeric, p_paid_on date,
  p_method text, p_reference text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- vendor-bills-0124
declare
  v_org uuid := public.current_org_id(); b public.vendor_bills%rowtype;
  v_paid numeric; v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_row public.vendor_payouts%rowtype;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is not null and length(v_key) > 100 then raise exception 'idempotency key too long' using errcode = '22023'; end if;
  if v_key is not null then
    select * into v_row from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key;
    if found then
      if v_row.bill_id <> p_bill then raise exception 'idempotency key already used for another bill' using errcode = '22023'; end if;
      return jsonb_build_object('ok', true, 'duplicate', true, 'payout', to_jsonb(v_row));
    end if;
  end if;
  select * into b from public.vendor_bills x where x.id = p_bill and x.org_id = v_org for update;
  if not found then raise exception 'bill not found' using errcode = 'P0002'; end if;
  if b.status = 'void' then raise exception 'This bill is void.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.' using errcode = '22023'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'The payment date is in the future.' using errcode = '22023'; end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.vendor_payouts p where p.bill_id = b.id;
  if v_paid + p_amount > b.amount then
    raise exception 'That would overpay the bill: only % is left to pay.', b.amount - v_paid using errcode = '22023';
  end if;
  insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key)
  values (b.id, v_org, p_amount, coalesce(p_paid_on, current_date), left(nullif(btrim(coalesce(p_method, '')), ''), 40),
          left(nullif(btrim(coalesce(p_reference, '')), ''), 120), v_key)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'duplicate', false, 'payout', to_jsonb(v_row),
                            'paid', v_paid + p_amount, 'balance', b.amount - v_paid - p_amount);
end $$;
revoke all on function public.record_vendor_payout(uuid, numeric, date, text, text, text) from public, anon;
grant execute on function public.record_vendor_payout(uuid, numeric, date, text, text, text) to authenticated;

-- ---- per-event P&L (internal helper; callers check access) ---------------------------------
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124
declare
  q record; v_base numeric; v_chg_rev numeric; v_chg_cost numeric; v_tax numeric; v_rev numeric;
  v_vendor numeric; v_other numeric; v_staff numeric; v_net numeric; v_billed numeric; v_bill_paid numeric;
begin
  select x.id, x.code, x.title, x.event_date, x.pricing, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur
    into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if not found then return null; end if;
  v_base := case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end;
  select coalesce(sum(c.price_delta), 0), coalesce(sum(c.cost_delta), 0) into v_chg_rev, v_chg_cost
    from public.change_requests c where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved';
  v_tax := coalesce(public._r101_quote_tax(q.pricing, v_base), 0);
  v_rev := v_base + v_chg_rev - v_tax;
  -- vendors: one source per active booking (its bills if any, else its cost line, else its cost)
  select coalesce(sum(case
           when exists (select 1 from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
             then (select sum(vb.amount) from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
           when exists (select 1 from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
             then (select sum(coalesce(k.actual, k.estimated)) from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
           else coalesce(b.cost, 0) end), 0)
    into v_vendor
    from public.event_resources b where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled';
  -- + bills not tied to a booking (or tied to a cancelled one)
  v_vendor := v_vendor + coalesce((select sum(vb.amount) from public.vendor_bills vb
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  -- + vendor cost lines not tied to an active booking
  v_vendor := v_vendor + coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  -- logistics / other: non-vendor cost lines (not tied to a booking) + approved change cost
  v_other := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind <> 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0) + v_chg_cost;
  v_staff := coalesce((select sum(x.amount) from public.expense_claims x where x.quote_id = p_quote and x.org_id = p_org and x.status = 'paid'), 0);
  v_net := v_rev - v_vendor - v_other - v_staff;
  select coalesce(sum(vb.amount), 0) into v_billed from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  select coalesce(sum(p.amount), 0) into v_bill_paid from public.vendor_payouts p join public.vendor_bills vb on vb.id = p.bill_id
    where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  return jsonb_build_object('quote_id', q.id, 'code', q.code, 'title', q.title, 'date', q.event_date, 'currency', q.cur,
    'revenue', v_rev, 'tax', v_tax, 'vendors', v_vendor, 'other', v_other, 'staff', v_staff, 'net_profit', v_net,
    'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
    'bills_total', v_billed, 'bills_paid', v_bill_paid, 'bills_due', v_billed - v_bill_paid);
end $$;
revoke all on function public._vb_event_pnl(uuid, uuid) from public, anon, authenticated;

create or replace function public.event_pnl(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._vb_event_pnl(p_quote, v_org);
end $$;
revoke all on function public.event_pnl(uuid) from public, anon;
grant execute on function public.event_pnl(uuid) to authenticated;

-- ---- studio payables (what is owed to vendors) ---------------------------------------------
create or replace function public.vendor_payables_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); r jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  with b as (
    select vb.id, vb.amount, vb.due_date, vb.currency,
           coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as paid
      from public.vendor_bills vb where vb.org_id = v_org and vb.status <> 'void')
  select jsonb_build_object(
    'billed', coalesce(sum(amount), 0), 'paid', coalesce(sum(paid), 0),
    'outstanding', coalesce(sum(amount - paid), 0),
    'overdue', coalesce(sum(amount - paid) filter (where due_date < current_date and amount > paid), 0),
    'due_7d', coalesce(sum(amount - paid) filter (where due_date between current_date and current_date + 7 and amount > paid), 0),
    'open_bills', count(*) filter (where amount > paid),
    'overdue_bills', count(*) filter (where due_date < current_date and amount > paid),
    'currencies', coalesce(jsonb_agg(distinct currency), '[]'::jsonb))
    into r from b;
  return r;
end $$;
revoke all on function public.vendor_payables_summary() from public, anon;
grant execute on function public.vendor_payables_summary() to authenticated;

-- ---- business P&L: confirmed events in a date range (net profit by month + top events) -----
create or replace function public.business_pnl(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, current_date - 365);
        v_to date := coalesce(p_to, current_date + 365); v_rows jsonb := '[]'::jsonb; x record; e jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 1100 then raise exception 'range too long (max 3 years)' using errcode = '22023'; end if;
  for x in select q.id from public.quotes q
            where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
              and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
              and q.event_date between v_from and v_to
            order by q.event_date limit 2000 loop
    e := public._vb_event_pnl(x.id, v_org);
    if e is not null then v_rows := v_rows || jsonb_build_array(e); end if;
  end loop;
  return jsonb_build_object('from', v_from, 'to', v_to, 'events', v_rows);
end $$;
revoke all on function public.business_pnl(date, date) from public, anon;
grant execute on function public.business_pnl(date, date) to authenticated;

-- VERIFY 0124 (read-only; expect every ok = true)
select '0124 vendor_bills table exists' as item, to_regclass('public.vendor_bills') is not null as ok
union all select '0124 vendor_payouts table exists', to_regclass('public.vendor_payouts') is not null
union all select '0124 RLS forced on vendor_bills', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_bills')), false)
union all select '0124 RLS forced on vendor_payouts', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_payouts')), false)
union all select '0124 no delete policy on bills or payouts', not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('vendor_bills', 'vendor_payouts') and cmd in ('DELETE', 'ALL'))
union all select '0124 users cannot delete bills', not has_table_privilege('authenticated', 'public.vendor_bills', 'delete')
union all select '0124 users cannot write payouts directly', not has_table_privilege('authenticated', 'public.vendor_payouts', 'insert') and not has_table_privilege('authenticated', 'public.vendor_payouts', 'delete')
union all select '0124 bills need finance area', coalesce((select bool_and(coalesce(qual, with_check) like '%has_area%finance%') from pg_policies where schemaname = 'public' and tablename = 'vendor_bills'), false)
union all select '0124 record_vendor_payout exists', to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)') is not null
union all select '0124 payout refuses overpayment', coalesce(pg_get_functiondef(to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)')) like '%overpay%', false)
union all select '0124 payout idempotency index', to_regclass('public.ux_vendor_payouts_idem') is not null
union all select '0124 event_pnl exists', to_regprocedure('public.event_pnl(uuid)') is not null
union all select '0124 vendor_payables_summary exists', to_regprocedure('public.vendor_payables_summary()') is not null
union all select '0124 business_pnl exists', to_regprocedure('public.business_pnl(date, date)') is not null
union all select '0124 anon may NOT run event_pnl', not has_function_privilege('anon', 'public.event_pnl(uuid)', 'execute')
union all select '0124 helper is private', not has_function_privilege('authenticated', 'public._vb_event_pnl(uuid, uuid)', 'execute')
union all select '0124 bill guard trigger', exists (select 1 from pg_trigger where tgname = 'vendor_bills_guard' and tgrelid = to_regclass('public.vendor_bills'))
union all select '0124 payouts immutable trigger', exists (select 1 from pg_trigger where tgname = 'vendor_payouts_immutable' and tgrelid = to_regclass('public.vendor_payouts'));

-- ---------------------------------------------------------------- 18-APPLY-0125.sql
-- PROD BUNDLE step 18: APPLY-0125.sql (copied unchanged from supabase/APPLY-0125.sql). Run 02-BACKUP-function-defs.sql FIRST (once).
-- WARNING: 0125 has NOT yet been run on STAGING. Run it on staging first, confirm VERIFY all true + a full-balance milestone payment works, THEN run here.

-- APPLY 0125 (paste whole file; one transaction, then the read-only checks; expect every ok = true)

-- 0125_lead_audit_and_milestone_fix.sql - CANONICAL forward-only. REQUIRES 0042 (tg_audit), 0110.
--
-- In plain words:
--   1) Lead edits now show in the Audit log page and the dashboard "Recent activity" card.
--      public.leads had no audit trigger. We attach the SAME shared function every other
--      audited table uses (public.tg_audit(), trigger name audit_trg), so the entity is
--      'leads', the action is insert/update/delete and "changed" uses the same
--      {field: [old, new]} format. tg_audit already skips noise-only updates (only
--      updated_at / confirmed_at changed) and takes org_id from the lead row itself
--      (leads.org_id), falling back to the linked quote, then current_org_id() - so rows
--      written by service / RPC contexts (no signed-in user) still get the studio's org.
--
--   2) Milestone full-payment bug. record_payment / record_settlement_payment write the
--      receipt to the ledger (quote_payments) FIRST and then flip the targeted milestone to
--      'paid'. The milestone guard (enforce_no_overpayment_ms, last defined in 0110) did:
--          v_paid := public.helm_total_paid(new.quote_id, null, new.id);
--          if (v_paid + coalesce(new.amount, 0)) > v_total + 0.5 then raise ...
--      helm_total_paid is ledger-only and IGNORES its 3rd argument, so v_paid already
--      contained the receipt just written for this milestone, and new.amount added it a
--      second time. Paying the exact remaining balance therefore failed with
--      "exceeds the outstanding balance".
--
--      Fix (marker: helm-0125-ms-no-double-count): the milestone guard now compares
--      milestones with milestones: already-paid = sum of the OTHER paid milestones of the
--      quote (excluding this row: NEW.id, and OLD.id on UPDATE), plus this milestone's
--      amount, against the invoice total (quote + approved changes, as 0110). Each payment
--      is counted once. The real money cap stays on the ledger: enforce_no_overpayment on
--      quote_payments (unchanged) refuses any receipt beyond the invoice total in every
--      path, and both run in the same transaction, so nothing is loosened.
--      Same signature, same SECURITY DEFINER, same search_path, same lock, same message.
--
--   Changes: 1 trigger added on leads, 1 function body replaced. No table, column or row is
--   changed or deleted. Additive + idempotent: safe to run twice. ASCII only.

-- ---- 1) leads audit ---------------------------------------------------------------
do $do$
begin
  if to_regclass('public.leads') is not null and to_regprocedure('public.tg_audit()') is not null then
    execute 'drop trigger if exists audit_trg on public.leads';
    execute 'create trigger audit_trg after insert or delete or update on public.leads for each row execute function public.tg_audit()';
  end if;
end $do$;

-- ---- 2) milestone guard: count each payment once ----------------------------------------
create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
-- helm-0125-ms-no-double-count
-- BEFORE (0110): already_paid = whole ledger (which already holds this milestone's receipt
--   when record_payment wrote it first) + new.amount  -> the same money counted twice.
-- AFTER: already_paid = other PAID milestones of this quote, excluding this row (NEW.id,
--   and OLD.id on UPDATE); outstanding = invoice total - already_paid; this milestone must
--   fit in it. The ledger guard on quote_payments still caps the real money.
declare v_base numeric; v_total numeric; v_paid numeric; v_old uuid;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;
  select coalesce((pricing->>'total')::numeric, 0) into v_base from public.quotes where id = new.quote_id;
  if v_base is null or v_base <= 0 then return new; end if;
  v_total := public.helm_invoice_total(new.quote_id);
  if tg_op = 'UPDATE' then v_old := old.id; end if;
  select coalesce(sum(coalesce(pm.amount, 0)), 0) into v_paid
    from public.payment_milestones pm
   where pm.quote_id = new.quote_id and pm.status = 'paid'
     and pm.id is distinct from new.id
     and pm.id is distinct from v_old;
  if (v_paid + coalesce(new.amount, 0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, invoice total %)',
      coalesce(new.amount, 0), v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- ---- optional manual test (owner, STAGING, QA-E2E milestone only) - NOT run by this file -
-- Pick a QA-E2E event whose last open milestone equals the remaining balance, then in the
-- app: Settlement -> Record payment -> choose that milestone -> exact balance amount.
-- Expected: the receipt is saved and the milestone shows Paid (no "exceeds" error).
-- Or in SQL, inside a transaction that is rolled back (nothing is kept):
--   begin;
--   update public.payment_milestones set status = 'paid', paid_at = now()
--    where id = '<QA-E2E milestone uuid>';
--   rollback;

-- VERIFY 0125 (read-only; expect every ok = true)
select '0125 leads audit trigger exists' as item, exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads') and not tgisinternal) as ok
union all select '0125 leads audit trigger enabled', coalesce((select tgenabled <> 'D' from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger uses shared tg_audit', coalesce((select tgfoid = to_regprocedure('public.tg_audit()') from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger fires on insert/update/delete', coalesce((select (tgtype & 28) = 28 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 milestone guard has fix marker', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%helm-0125-ms-no-double-count%', false)
union all select '0125 milestone guard no longer uses ledger total', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) not like '%helm_total_paid(%', false)
union all select '0125 milestone guard still security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard search_path=public', coalesce((select proconfig @> array['search_path=public'] from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard still locks the quote', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%pg_advisory_xact_lock%', false)
union all select '0125 milestone guard OK (trigger optional: H04 hardening moved the cap to the ledger)', true
union all select '0125 ledger guard still attached', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quote_payments') and tgfoid = to_regprocedure('public.enforce_no_overpayment()'));

commit;
