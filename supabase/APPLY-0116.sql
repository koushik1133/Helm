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
