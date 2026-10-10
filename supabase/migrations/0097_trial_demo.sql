-- ============================================================================
-- 0097_trial_demo.sql — CANONICAL forward-only. Free-trial "Try with demo data".
-- REQUIRES 0056 (my_start_trial), 0058 (my_trial_status), 0085 (venues),
--          0052 / 0093 wrappers (payment_link_begin, create_payment, otp_send_authorize).
--
-- In plain words: when a studio starts its 14-day trial the owner picks
--   "Try with demo data"  → seed_demo_data() fills the studio with a clearly-marked
--                            sample studio (every name starts with "Demo ·"), or
--   "Start with my own data" → set_trial_mode('own') and the onboarding wizard.
-- Any time later: reset_demo_data() (wipe + re-seed the sample) or clear_demo_data()
-- (remove the sample, keep everything real) — both studio-admin only.
--
--   * organizations.trial_mode ('demo' | 'own' | null).
--   * is_demo boolean (default false) on every table the sample writes. Only the
--     database functions below may set it: the app (anon / authenticated) can never
--     flag a real row as demo or un-flag a demo row (trigger zz_a97_demo_flag_guard).
--   * ZERO DATA LOSS: clear/reset delete ONLY rows with is_demo = true AND org_id =
--     the caller's studio. A demo master row (staff, vendor, item, dish, package)
--     that one of the studio's REAL events still uses is kept (deactivated) instead
--     of deleted, so no real row is ever cascaded away or has a link nulled.
--     Venues are never deleted (0085 rule) — demo venues are deactivated.
--     Each function is one statement = one transaction: all or nothing.
--   * No real messages or money for demo records: whatsapp_authorize,
--     otp_send_authorize, payment_link_begin and create_payment refuse a demo event
--     (and WhatsApp refuses a demo contact's number); comms_outbox / pkg_outbox rows
--     for a demo event are stored as 'skipped' so the senders never pick them up.
--   * Billing / HQ: Helm bills per studio subscription (0045) — no usage counter
--     reads these tables, and HQ revenue reads only subscription payments, so demo
--     rows never count. my_demo_status() reports the counts for the UI.
-- Additive + idempotent. No real row is deleted or overwritten; seeding is fill-only.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.my_start_trial(text,text)') is null then
    raise exception '0097: 0056 (onboarding checkout) is not installed on this database'; end if;
  if to_regprocedure('public.my_trial_status()') is null then
    raise exception '0097: 0058 (trial reminders) is not installed on this database'; end if;
  if to_regclass('public.venues') is null then
    raise exception '0097: 0085 (venues) is not installed on this database'; end if;
end $$;

-- ---- 0) keep this database's own gate bodies (rename once) ------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['whatsapp_authorize', 'uuid, text'],
    ['otp_send_authorize', 'uuid, text'],
    ['payment_link_begin', 'uuid, integer'],
    ['create_payment',     'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0097', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0097: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0097');
    end if;
  end loop;
end $$;

-- ---- 1) columns (additive) ----------------------------------------------------------------
alter table public.organizations add column if not exists trial_mode text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_trial_mode_chk97') then
    alter table public.organizations add constraint organizations_trial_mode_chk97
      check (trial_mode is null or trial_mode in ('demo','own'));
  end if;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads','quotes','venues','menu_templates','dish_catalog','inventory_items',
                           'crew_members','vendors','layouts','event_checklist','quote_payments','payment_milestones'] loop
    execute format('alter table public.%I add column if not exists is_demo boolean not null default false', t);
    execute format('create index if not exists %I on public.%I (org_id) where is_demo', t || '_demo_idx97', t);
  end loop;
end $$;

-- ---- 2) only the database may set / clear the demo flag ------------------------------------
-- One exception keeps the owner's work safe: when someone renames a demo row so it no
-- longer starts with "Demo ·", they have adopted it — it becomes a real row (is_demo
-- false) and clear / reset will never remove it.
create or replace function public._a97_tg_demo_flag_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_label text;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.is_demo then
      raise exception 'demo data is managed by Helm, not by the app' using errcode = '42501', hint = 'demo_flag';
    end if;
    if tg_op = 'UPDATE' and old.is_demo then
      v_label := coalesce(to_jsonb(new) ->> 'name', to_jsonb(new) ->> 'title', to_jsonb(new) ->> 'label');
      if v_label is not null and v_label not like 'Demo ·%' then
        new.is_demo := false;                       -- adopted by the studio: now real
        return new;
      end if;
    end if;
    if tg_op = 'UPDATE' and new.is_demo is distinct from old.is_demo then
      raise exception 'demo data is managed by Helm, not by the app' using errcode = '42501', hint = 'demo_flag';
    end if;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads','quotes','venues','menu_templates','dish_catalog','inventory_items',
                           'crew_members','vendors','layouts','event_checklist','quote_payments','payment_milestones'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_a97_demo_flag_guard') then
      execute format('create trigger zz_a97_demo_flag_guard before insert or update on public.%I for each row execute function public._a97_tg_demo_flag_guard()', t);
    end if;
  end loop;
end $$;

-- ---- 3) helpers ----------------------------------------------------------------------------
create or replace function public._is_demo_quote(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select q.is_demo from public.quotes q where q.id = p_quote), false);
$$;
revoke all on function public._is_demo_quote(uuid) from public, anon, authenticated;

-- a phone number that belongs to a demo contact of this studio (never message it)
create or replace function public._is_demo_phone(p_org uuid, p_phone text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_phone is not null and length(regexp_replace(p_phone, '\D', '', 'g')) >= 7 and (
       exists (select 1 from public.crew_members c where c.org_id = p_org and c.is_demo
                 and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
    or exists (select 1 from public.vendors v where v.org_id = p_org and v.is_demo
                 and right(regexp_replace(coalesce(v.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
    or exists (select 1 from public.leads l where l.org_id = p_org and l.is_demo
                 and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)));
$$;
revoke all on function public._is_demo_phone(uuid, text) from public, anon, authenticated;

-- ---- 4) gates: no real messages / payments for demo records ---------------------------------
create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if public._is_demo_quote(p_quote)
     or public._is_demo_phone(coalesce((select q.org_id from public.quotes q where q.id = p_quote), public.current_org_id()), p_recipient) then
    raise exception 'Demo data: messages are switched off for demo events and contacts' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.whatsapp_authorize__pre0097(p_quote, p_recipient);
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo) then
    raise exception 'Demo data: approval codes are not sent for demo events' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.otp_send_authorize__pre0097(p_token, p_phone);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo) then
    return jsonb_build_object('action', 'not_approved', 'reason', 'demo_data');
  end if;
  return public.payment_link_begin__pre0097(p_token, p_ttl_minutes);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo) then
    raise exception 'Demo data: payments are switched off for demo events' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.create_payment__pre0097(p_token);
end $$;

-- each wrapper gets exactly the callers its migration documents (0027 / 0033 / 0052);
-- the wrapped body is reachable only through its wrapper (and the service role)
do $$ declare f text[]; begin
  foreach f slice 1 in array array[['whatsapp_authorize','uuid, text'],['otp_send_authorize','uuid, text'],
                                   ['payment_link_begin','uuid, integer'],['create_payment','uuid']] loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1], f[2]);
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0097', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0097', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1], f[2]);
  end loop;
end $$;
grant execute on function public.whatsapp_authorize(uuid, text) to authenticated;
grant execute on function public.create_payment(uuid) to anon, authenticated;

-- outbox rows for a demo event are kept as 'skipped' — the senders never claim them
create or replace function public._a97_tg_outbox_demo_skip()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.quote_id is not null and public._is_demo_quote(new.quote_id) then new.status := 'skipped'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['comms_outbox','pkg_outbox'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_a97_outbox_demo_skip') then
      execute format('create trigger zz_a97_outbox_demo_skip before insert or update of status on public.%I for each row execute function public._a97_tg_outbox_demo_skip()', t);
    end if;
  end loop;
end $$;

-- ---- 5) status ------------------------------------------------------------------------------
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode into v_mode from public.organizations o where o.id = v_org;
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
    'is_admin', coalesce(public.is_admin(), false));
end $$;

create or replace function public.set_trial_mode(p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('demo','own') then raise exception 'choose demo or own' using errcode = '22023'; end if;
  update public.organizations set trial_mode = p_mode where id = v_org;
  return public.my_demo_status();
end $$;

-- ---- 6) seed (fill-only, idempotent) -----------------------------------------------------------
create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d date := current_date;
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  v_total numeric;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  -- fill-only: a studio that already has its demo events is left exactly as it is
  if exists (select 1 from public.quotes where org_id = p_org and is_demo) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  -- venues (re-use deactivated demo venues from an earlier clear instead of piling up)
  if exists (select 1 from public.venues where org_id = p_org and is_demo) then
    update public.venues set active = true where org_id = p_org and is_demo and not active;
  else
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                              event_types, restrictions, cost_min, cost_max, cost_basis, parking_spaces, rooms, power_backup_kw,
                              green_rooms, washrooms, address, city, contact_name, notes, is_demo)
    values
      (p_org, 'Demo · Sitara Convention Hall', 'banquet_hall', 'ac', 'indoor', 600, 900, 60, 30, 'm',
       array['wedding','reception','engagement','corporate'], array['sound_curfew','no_fireworks'], 250000, 400000, 'per_day',
       150, 4, 250, 2, 12, 'Demo · Plot 12, Hitech City Road, Madhapur', 'Hyderabad', 'Demo · Venue manager',
       'Demo venue — sample data. Sound off by 10:30 pm.', true),
      (p_org, 'Demo · Banjara Lawns', 'lawn', 'non_ac', 'outdoor', 1000, 1500, 90, 50, 'm',
       array['wedding','reception','birthday','festival'], array['generator_required'], 180000, 300000, 'per_day',
       300, 2, 0, 1, 8, 'Demo · Road No. 10, Jubilee Hills', 'Hyderabad', 'Demo · Lawn manager',
       'Demo venue — sample data. Generator needed after 8 pm.', true);
  end if;

  -- dishes + menu packages
  -- demo masters kept (inactive) by an earlier clear because a real event used them come
  -- back on; every insert below skips a name the studio already has (fill-only)
  update public.dish_catalog set active = true where org_id = p_org and is_demo and not active;
  update public.menu_templates set active = true where org_id = p_org and is_demo and not active;
  update public.inventory_items set active = true where org_id = p_org and is_demo and not active;
  update public.crew_members set active = true where org_id = p_org and is_demo and not active;
  update public.vendors set active = true where org_id = p_org and is_demo and not active;

  -- dishes + menu packages
  insert into public.dish_catalog(org_id, category, name, kind, is_demo) values
    (p_org, 'Starters', 'Demo · Paneer Tikka', 'veg', true),
    (p_org, 'Starters', 'Demo · Apollo Fish', 'nonveg', true),
    (p_org, 'Main course', 'Demo · Hyderabadi Chicken Dum Biryani', 'nonveg', true),
    (p_org, 'Main course', 'Demo · Veg Dum Biryani', 'veg', true),
    (p_org, 'Main course', 'Demo · Bagara Baingan', 'veg', true),
    (p_org, 'Main course', 'Demo · Mutton Haleem', 'nonveg', true),
    (p_org, 'Desserts', 'Demo · Double Ka Meetha', 'veg', true),
    (p_org, 'Desserts', 'Demo · Qubani Ka Meetha', 'veg', true)
  on conflict do nothing;
  -- packages: one per tier + diet per studio — only fill a slot the studio hasn't used
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  select x.* from (values
    (m1, p_org, 'gold', 'veg', 'Demo · Gold Veg Thali', 950::numeric,
     '[{"n":"Demo · Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo · Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo · Bagara Baingan","c":"Main course","k":"veg"},{"n":"Demo · Double Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 901, 'Demo package — sample data.', 100, 1500, true),
    (m2, p_org, 'premium', 'nonveg', 'Demo · Premium Nizami Feast', 1450::numeric,
     '[{"n":"Demo · Apollo Fish","c":"Starters","k":"nonveg"},{"n":"Demo · Hyderabadi Chicken Dum Biryani","c":"Main course","k":"nonveg"},{"n":"Demo · Mutton Haleem","c":"Main course","k":"nonveg"},{"n":"Demo · Qubani Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 902, 'Demo package — sample data.', 150, 2000, true)
  ) as x(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  where not exists (select 1 from public.menu_templates t where t.org_id = p_org and t.tier = x.tier and t.diet = x.diet);

  -- inventory
  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo) values
    (p_org, 'Demo · Chiavari chairs (gold)', 'Furniture', 600, 'pcs', 'A', 45, 'Demo item — sample data.', true, true),
    (p_org, 'Demo · Round tables (6 ft)', 'Furniture', 80, 'pcs', 'A', 300, 'Demo item — sample data.', true, true),
    (p_org, 'Demo · LED par lights', 'Lighting', 48, 'pcs', 'B', 600, 'Demo item — sample data.', true, true),
    (p_org, 'Demo · Stage platforms (8x4 ft)', 'Staging', 24, 'pcs', 'A', 1200, 'Demo item — sample data.', true, true),
    (p_org, 'Demo · Chafing dishes', 'Catering', 40, 'pcs', 'B', 250, 'Demo item — sample data.', true, true),
    (p_org, 'Demo · Floral mandap set', 'Decor', 2, 'sets', 'A', 35000, 'Demo item — sample data.', true, true)
  on conflict do nothing;

  -- staff + vendors (numbers are sample numbers; WhatsApp refuses every demo number)
  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select * from (values
    (p_org, 'Demo · Ravi Kumar', '+91 90000 00101', 'Operations', 'Event manager', 'full_time', 3500, 'Demo staff — sample data.', true, true),
    (p_org, 'Demo · Lakshmi Prasanna', '+91 90000 00102', 'Decor', 'Decor lead', 'full_time', 3000, 'Demo staff — sample data.', true, true),
    (p_org, 'Demo · Imran Shaikh', '+91 90000 00103', 'Logistics', 'Logistics supervisor', 'part_time', 2200, 'Demo staff — sample data.', true, true),
    (p_org, 'Demo · Sneha Reddy', '+91 90000 00104', 'Hospitality', 'Guest coordinator', 'on_call', 1800::numeric, 'Demo staff — sample data.', true, true)
  ) as x(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.name);
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo) values
    (p_org, 'Demo · Gulmohar Florists', 'Florist', 'vendor', '+91 90000 00201', 'demo.florist@example.com', 'Demo vendor — sample data.', true, true),
    (p_org, 'Demo · Deccan Sound & Lights', 'Sound & lights', 'rental', '+91 90000 00202', 'demo.sound@example.com', 'Demo vendor — sample data.', true, true),
    (p_org, 'Demo · Charminar Clicks', 'Photography', 'freelancer', '+91 90000 00203', 'demo.photo@example.com', 'Demo vendor — sample data.', true, true)
  on conflict do nothing;

  -- leads first (the quote→lead sync then matches THESE demo leads by their demo e-mail,
  -- never one of the studio's real leads)
  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo) values
    (p_org, 'Demo · Ananya Reddy', '+91 90000 00301', 'demo.ananya@example.com', 'Instagram', 'Wedding', d + 45, 1500000, 500, 'Demo lead — sample data.', 'won', true),
    (p_org, 'Demo · Rohit Sharma', '+91 90000 00302', 'demo.rohit@example.com', 'Referral', 'Engagement', d + 30, 600000, 200, 'Demo lead — sample data.', 'quoted', true),
    (p_org, 'Demo · TechNova HR team', '+91 90000 00303', 'demo.technova@example.com', 'Website', 'Corporate', d + 60, 800000, 350, 'Demo lead — sample data.', 'quoted', true),
    (p_org, 'Demo · Priya Varma', '+91 90000 00304', 'demo.priya@example.com', 'Walk-in', 'Birthday', d + 20, 250000, 120, 'Demo lead — sample data.', 'discovery', true),
    (p_org, 'Demo · Karthik Rao', '+91 90000 00305', 'demo.karthik@example.com', 'Google', 'Reception', d + 90, 900000, 400, 'Demo lead — sample data. Just enquired.', 'new', true),
    (p_org, 'Demo · Fatima Begum', '+91 90000 00306', 'demo.fatima@example.com', 'Instagram', 'Wedding', d + 75, 1200000, 450, 'Demo lead — sample data. Went with another planner.', 'lost', true);

  -- events in different stages
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, is_demo) values
    (q1, p_org, 'DEMO-101', 'Demo · Ananya & Vikram Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 45, '19:00',
     '{"name":"Demo · Ananya Reddy","phone":"+91 90000 00301","email":"demo.ananya@example.com","city":"Hyderabad"}',
     '{"guests":500,"subtotal":1250000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', now(), true),
    (q2, p_org, 'DEMO-102', 'Demo · Rohit & Meera Engagement', 'Engagement', 'quote', 'none', 'proposal', d + 30, '18:30',
     '{"name":"Demo · Rohit Sharma","phone":"+91 90000 00302","email":"demo.rohit@example.com","city":"Hyderabad"}',
     '{"guests":200,"subtotal":520000,"discount":20000,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q3, p_org, 'DEMO-103', 'Demo · TechNova Annual Day', 'Corporate', 'quote', 'none', 'quote', d + 60, '17:00',
     '{"name":"Demo · TechNova HR team","phone":"+91 90000 00303","email":"demo.technova@example.com","city":"Hyderabad"}',
     '{"guests":350,"subtotal":720000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q4, p_org, 'DEMO-104', 'Demo · Aarav''s 1st Birthday', 'Birthday', 'quote', 'none', 'discovery', d + 20, '12:30',
     '{"name":"Demo · Priya Varma","phone":"+91 90000 00304","email":"demo.priya@example.com","city":"Hyderabad"}',
     '{"guests":120,"subtotal":210000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true);
  -- any lead the quote→lead sync created or linked for a demo event is demo too
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2, q3, q4)
     and name like 'Demo · %';

  -- the confirmed wedding: advance paid, two instalments to go (the "invoices")
  select (pricing ->> 'total')::numeric into v_total from public.quotes where id = q1;
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq, is_demo) values
    (q1, p_org, 'Demo · Advance (30%)', d - 5, round(v_total * 0.3), 'paid', now() - interval '5 days', 'Demo — sample data.', 1, true),
    (q1, p_org, 'Demo · Second instalment (40%)', d + 15, round(v_total * 0.4), 'invoiced', null, 'Demo — sample data.', 2, true),
    (q1, p_org, 'Demo · Balance (30%)', d + 44, v_total - round(v_total * 0.3) - round(v_total * 0.4), 'due', null, 'Demo — sample data.', 3, true);
  insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note, is_demo)
    values (q1, p_org, 'upi', round(v_total * 0.3), 'INR', 'paid', true, now() - interval '5 days', 'upi', 'DEMO-R-0001',
            'Demo payment — sample data, no money moved.', true);

  -- checklist for the wedding
  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq, is_demo) values
    (q1, p_org, 'logistics', 'Demo · Confirm hall booking with Sitara', 'Advance receipt filed.', 'Demo · Ravi Kumar', d - 3, 'done', 1, true),
    (q1, p_org, 'logistics', 'Demo · Book generator backup (250 kVA)', null, 'Demo · Imran Shaikh', d + 30, 'open', 2, true),
    (q1, p_org, 'compliance', 'Demo · Police & fire NOC', 'Apply 3 weeks before.', 'Demo · Ravi Kumar', d + 20, 'open', 3, true),
    (q1, p_org, 'guests', 'Demo · Share guest list template with family', null, 'Demo · Sneha Reddy', d + 10, 'open', 4, true),
    (q1, p_org, 'comms', 'Demo · Send final menu to client', null, 'Demo · Lakshmi Prasanna', d + 25, 'open', 5, true),
    (q1, p_org, 'teardown', 'Demo · Return rental lights to Deccan Sound', null, 'Demo · Imran Shaikh', d + 46, 'open', 6, true);

  -- a finished floor layout for the wedding (opens in the 2D / 3D builder)
  insert into public.layouts(name, data, org_id, is_demo) values
    ('Demo · Ananya & Vikram Wedding — Sitara Hall', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('id','demo-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label','Demo · Main Stage','properties','{}'::jsonb),
        jsonb_build_object('id','demo-mandap','type','mandap','category','decor','x',92,'y',26,'width',16,'height',16,'rotation',0,'label','Demo · Mandap','properties','{}'::jsonb),
        jsonb_build_object('id','demo-dance','type','dancefloor','category','structure','x',88,'y',48,'width',24,'height',24,'rotation',0,'label','Demo · Dance Floor','properties','{}'::jsonb),
        jsonb_build_object('id','demo-t1','type','table','category','seating','x',30,'y',40,'width',6,'height',6,'rotation',0,'label','Table 1','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t2','type','table','category','seating','x',44,'y',40,'width',6,'height',6,'rotation',0,'label','Table 2','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t3','type','table','category','seating','x',58,'y',40,'width',6,'height',6,'rotation',0,'label','Table 3','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t4','type','table','category','seating','x',30,'y',56,'width',6,'height',6,'rotation',0,'label','Table 4','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t5','type','table','category','seating','x',44,'y',56,'width',6,'height',6,'rotation',0,'label','Table 5','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t6','type','table','category','seating','x',58,'y',56,'width',6,'height',6,'rotation',0,'label','Table 6','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t7','type','table','category','seating','x',136,'y',40,'width',6,'height',6,'rotation',0,'label','Table 7','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t8','type','table','category','seating','x',150,'y',40,'width',6,'height',6,'rotation',0,'label','Table 8','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t9','type','table','category','seating','x',164,'y',40,'width',6,'height',6,'rotation',0,'label','Table 9','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t10','type','table','category','seating','x',136,'y',56,'width',6,'height',6,'rotation',0,'label','Table 10','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t11','type','table','category','seating','x',150,'y',56,'width',6,'height',6,'rotation',0,'label','Table 11','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t12','type','table','category','seating','x',164,'y',56,'width',6,'height',6,'rotation',0,'label','Table 12','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label','Demo · Veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label','Demo · Non-veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-photo','type','photobooth','category','av','x',20,'y',10,'width',8,'height',8,'rotation',0,'label','Demo · Photo Booth','properties','{}'::jsonb),
        jsonb_build_object('id','demo-carpet','type','redcarpet','category','structure','x',97,'y',100,'width',6,'height',30,'rotation',0,'label','Demo · Aisle','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit1','type','exit','category','safety','x',0,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit2','type','exit','category','safety','x',188,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb)),
      'grid', jsonb_build_object('snap', true, 'show', true, 'unit', 'ft', 'sizeFt', 2),
      'margins', jsonb_build_object('left', 0, 'right', 0, 'top', 0, 'bottom', 0),
      'venue', jsonb_build_object('capacity', 600),
      'scale', jsonb_build_object('pxPerFt', 12, 'worldFt', jsonb_build_object('w', 200, 'h', 140)),
      'demo', true), p_org, true);

  update public.organizations set trial_mode = 'demo' where id = p_org;
  return jsonb_build_object('seeded', true, 'quotes', 4, 'leads', 6, 'staff', 4, 'vendors', 3, 'inventory', 6,
                            'venues', 2, 'packages', 2, 'dishes', 8, 'layouts', 1);
end $$;
revoke all on function public._demo_seed(uuid) from public, anon, authenticated;

-- ---- 7) clear (ONLY is_demo rows of ONE studio) -----------------------------------------------
create or replace function public._demo_clear(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_q uuid[]; n_q int := 0; n_l int := 0; n_c int := 0; n_v int := 0; n_i int := 0; n_d int := 0; n_m int := 0;
  n_lay int := 0; n_ven int := 0; n_kept int := 0; k int;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  select coalesce(array_agg(id), '{}') into v_q from public.quotes where org_id = p_org and is_demo;

  -- demo events: their own child rows go with them (they are part of the demo event).
  -- Money rows first (as the definer) so the 0029 delete guard sees no payments left.
  delete from public.quote_payments where org_id = p_org and quote_id = any(v_q);
  delete from public.payment_milestones where org_id = p_org and quote_id = any(v_q);
  delete from public.event_refunds where quote_id = any(v_q);
  delete from public.quote_consents where quote_id = any(v_q);
  -- a REAL lead linked to a demo event keeps its row; only the link is released
  update public.leads set quote_id = null where org_id = p_org and not is_demo and quote_id = any(v_q);
  delete from public.quotes where org_id = p_org and is_demo and id = any(v_q);
  get diagnostics n_q = row_count;
  delete from public.leads where org_id = p_org and is_demo;
  get diagnostics n_l = row_count;
  delete from public.layouts where org_id = p_org and is_demo;
  get diagnostics n_lay = row_count;

  -- demo master rows: delete only when NO remaining (real) row points at them; otherwise
  -- keep + deactivate so nothing real is cascaded away or loses its link
  delete from public.crew_members c where c.org_id = p_org and c.is_demo
     and not exists (select 1 from public.event_tasks t where t.crew_id = c.id)
     and not exists (select 1 from public.inventory_checkouts x where x.issued_to_id = c.id);
  get diagnostics n_c = row_count;
  update public.crew_members set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.vendors v where v.org_id = p_org and v.is_demo
     and not exists (select 1 from public.event_resources r where r.vendor_id = v.id)
     and not exists (select 1 from public.event_tasks t where t.vendor_id = v.id);
  get diagnostics n_v = row_count;
  update public.vendors set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.inventory_items i where i.org_id = p_org and i.is_demo
     and not exists (select 1 from public.inventory_reservations r where r.item_id = i.id)
     and not exists (select 1 from public.inventory_checkouts x where x.item_id = i.id)
     and not exists (select 1 from public.inv_shortage_alerts a where a.item_id = i.id)
     and not exists (select 1 from public.event_resource_needs e where e.item_id = i.id)
     and not exists (select 1 from public.event_stock_requests s where s.item_id = i.id);
  get diagnostics n_i = row_count;
  update public.inventory_items set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.menu_templates m where m.org_id = p_org and m.is_demo
     and not exists (select 1 from public.package_selections s where s.package_id = m.id);
  get diagnostics n_m = row_count;
  update public.menu_templates set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.dish_catalog x where x.org_id = p_org and x.is_demo
     and not exists (select 1 from public.event_menu_items e where e.dish_id = x.id);
  get diagnostics n_d = row_count;
  update public.dish_catalog set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  -- venues are never deleted (0085): demo venues are switched off
  update public.venues set active = false where org_id = p_org and is_demo and active;
  get diagnostics n_ven = row_count;

  return jsonb_build_object('cleared', true, 'quotes', n_q, 'leads', n_l, 'staff', n_c, 'vendors', n_v, 'inventory', n_i,
    'packages', n_m, 'dishes', n_d, 'layouts', n_lay, 'venues_deactivated', n_ven, 'kept_in_use', n_kept);
end $$;
revoke all on function public._demo_clear(uuid) from public, anon, authenticated;

-- ---- 8) studio-admin entry points ----------------------------------------------------------------
create or replace function public.seed_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._demo_seed(v_org);
end $$;

create or replace function public.clear_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  r := public._demo_clear(v_org);
  update public.organizations set trial_mode = 'own' where id = v_org;
  return r;
end $$;

create or replace function public.reset_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); c jsonb; s jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._demo_clear(v_org);
  s := public._demo_seed(v_org);
  return jsonb_build_object('cleared', c, 'seeded', s);
end $$;

-- ---- 9) grants -------------------------------------------------------------------------------------
revoke all on function public.my_demo_status() from public, anon;
revoke all on function public.set_trial_mode(text) from public, anon;
revoke all on function public.seed_demo_data() from public, anon;
revoke all on function public.clear_demo_data() from public, anon;
revoke all on function public.reset_demo_data() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;
grant execute on function public.set_trial_mode(text) to authenticated, service_role;
grant execute on function public.seed_demo_data() to authenticated, service_role;
grant execute on function public.clear_demo_data() to authenticated, service_role;
grant execute on function public.reset_demo_data() to authenticated, service_role;
revoke all on function public._a97_tg_outbox_demo_skip() from public, anon, authenticated;
revoke all on function public._a97_tg_demo_flag_guard() from public, anon, authenticated;
