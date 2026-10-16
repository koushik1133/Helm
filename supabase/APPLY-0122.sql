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
