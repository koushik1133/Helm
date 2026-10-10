-- ============================================================================
-- 0100_demo_seed_fix.sql - CANONICAL forward-only. Fixes "Try with demo data" on prod.
-- REQUIRES 0097 (_demo_seed / _demo_clear / seed_demo_data / reset_demo_data), 0001+0089
--          (D8 server pricing authority: helm_quote_total + zz_enforce_pricing_total).
--
-- In plain words: production refused the demo seed with
--   23514 quote_payments violates check constraint "quote_payments_amount_pos".
-- The demo events' pricing carried guests + gstPct but no plate price / chairs, so the
-- server pricing engine (D8, the only authority for a quote total) priced every demo
-- event at 0, the advance came out as 0, and prod's amount > 0 CHECK (W16-01, not in
-- the canonical chain) rejected the whole seed.
--
-- Fix (functions only - no table, no data change):
--   * demo events carry the raw pricing inputs the server engine uses
--     (guests x platePrice, chairs x chairPrice, other, discount, gstPct 18), so the
--     server total is a realistic India figure (the wedding is about Rs 8 lakh).
--   * milestones + the advance payment are computed from the server-enforced total
--     re-read AFTER the insert, and any money row whose amount would be <= 0 is skipped.
--   * a kept (inactive) demo master is only switched back on when no active row of the
--     studio already uses that name (the active-name unique indexes).
--   * seed_demo_data / reset_demo_data / clear_demo_data bodies unchanged, re-issued
--     with the same grants. Idempotent: CREATE OR REPLACE only.
-- ============================================================================
do $$ begin
  if to_regprocedure('public._demo_seed(uuid)') is null or to_regprocedure('public._demo_clear(uuid)') is null then
    raise exception '0100: apply 0097_trial_demo.sql first';
  end if;
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then
    raise exception '0100: helm_quote_total() is not installed';
  end if;
end $$;

create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- demo-seed-0100: raw pricing inputs + server total re-read + no money row <= 0
declare
  d date := current_date;
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  v_total numeric; v_a1 numeric; v_a2 numeric; v_a3 numeric;
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
      (p_org, E'Demo \u00b7 Sitara Convention Hall', 'banquet_hall', 'ac', 'indoor', 600, 900, 60, 30, 'm',
       array['wedding','reception','engagement','corporate'], array['sound_curfew','no_fireworks'], 250000, 400000, 'per_day',
       150, 4, 250, 2, 12, E'Demo \u00b7 Plot 12, Hitech City Road, Madhapur', 'Hyderabad', E'Demo \u00b7 Venue manager',
       E'Demo venue \u2014 sample data. Sound off by 10:30 pm.', true),
      (p_org, E'Demo \u00b7 Banjara Lawns', 'lawn', 'non_ac', 'outdoor', 1000, 1500, 90, 50, 'm',
       array['wedding','reception','birthday','festival'], array['generator_required'], 180000, 300000, 'per_day',
       300, 2, 0, 1, 8, E'Demo \u00b7 Road No. 10, Jubilee Hills', 'Hyderabad', E'Demo \u00b7 Lawn manager',
       E'Demo venue \u2014 sample data. Generator needed after 8 pm.', true);
  end if;

  -- dishes + menu packages
  -- demo masters kept (inactive) by an earlier clear because a real event used them come
  -- back on; every insert below skips a name the studio already has (fill-only)
  update public.dish_catalog x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.dish_catalog y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.category)) = lower(btrim(x.category)) and lower(btrim(y.name)) = lower(btrim(x.name)));
  update public.menu_templates x set active = true where x.org_id = p_org and x.is_demo and not x.active;
  update public.inventory_items x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.inventory_items y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.name)) = lower(btrim(x.name)));
  update public.crew_members set active = true where org_id = p_org and is_demo and not active;
  update public.vendors x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.vendors y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.name)) = lower(btrim(x.name)));

  -- dishes + menu packages
  insert into public.dish_catalog(org_id, category, name, kind, is_demo) values
    (p_org, 'Starters', E'Demo \u00b7 Paneer Tikka', 'veg', true),
    (p_org, 'Starters', E'Demo \u00b7 Apollo Fish', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Hyderabadi Chicken Dum Biryani', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Veg Dum Biryani', 'veg', true),
    (p_org, 'Main course', E'Demo \u00b7 Bagara Baingan', 'veg', true),
    (p_org, 'Main course', E'Demo \u00b7 Mutton Haleem', 'nonveg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Double Ka Meetha', 'veg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Qubani Ka Meetha', 'veg', true)
  on conflict do nothing;
  -- packages: one per tier + diet per studio - only fill a slot the studio hasn't used
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  select x.* from (values
    (m1, p_org, 'gold', 'veg', E'Demo \u00b7 Gold Veg Thali', 950::numeric,
     E'[{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Bagara Baingan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Double Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 901, E'Demo package \u2014 sample data.', 100, 1500, true),
    (m2, p_org, 'premium', 'nonveg', E'Demo \u00b7 Premium Nizami Feast', 1450::numeric,
     E'[{"n":"Demo \u00b7 Apollo Fish","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Hyderabadi Chicken Dum Biryani","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Mutton Haleem","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Qubani Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 902, E'Demo package \u2014 sample data.', 150, 2000, true)
  ) as x(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  where not exists (select 1 from public.menu_templates t where t.org_id = p_org and t.tier = x.tier and t.diet = x.diet);

  -- inventory
  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Chiavari chairs (gold)', 'Furniture', 600, 'pcs', 'A', 45, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Round tables (6 ft)', 'Furniture', 80, 'pcs', 'A', 300, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 LED par lights', 'Lighting', 48, 'pcs', 'B', 600, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Stage platforms (8x4 ft)', 'Staging', 24, 'pcs', 'A', 1200, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Chafing dishes', 'Catering', 40, 'pcs', 'B', 250, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Floral mandap set', 'Decor', 2, 'sets', 'A', 35000, E'Demo item \u2014 sample data.', true, true)
  on conflict do nothing;

  -- staff + vendors (numbers are sample numbers; WhatsApp refuses every demo number)
  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select * from (values
    (p_org, E'Demo \u00b7 Ravi Kumar', '+91 00000 00101', 'Operations', 'Event manager', 'full_time', 3500, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Lakshmi Prasanna', '+91 00000 00102', 'Decor', 'Decor lead', 'full_time', 3000, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Imran Shaikh', '+91 00000 00103', 'Logistics', 'Logistics supervisor', 'part_time', 2200, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Sneha Reddy', '+91 00000 00104', 'Hospitality', 'Guest coordinator', 'on_call', 1800::numeric, E'Demo staff \u2014 sample data.', true, true)
  ) as x(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.name);
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Gulmohar Florists', 'Florist', 'vendor', '+91 00000 00201', 'demo.florist@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Deccan Sound & Lights', 'Sound & lights', 'rental', '+91 00000 00202', 'demo.sound@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Charminar Clicks', 'Photography', 'freelancer', '+91 00000 00203', 'demo.photo@example.com', E'Demo vendor \u2014 sample data.', true, true)
  on conflict do nothing;

  -- leads first (the quote->lead sync then matches THESE demo leads by their demo e-mail,
  -- never one of the studio's real leads)
  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo) values
    (p_org, E'Demo \u00b7 Ananya Reddy', '+91 00000 00301', 'demo.ananya@example.com', 'Instagram', 'Wedding', d + 45, 1500000, 500, E'Demo lead \u2014 sample data.', 'won', true),
    (p_org, E'Demo \u00b7 Rohit Sharma', '+91 00000 00302', 'demo.rohit@example.com', 'Referral', 'Engagement', d + 30, 600000, 200, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 TechNova HR team', '+91 00000 00303', 'demo.technova@example.com', 'Website', 'Corporate', d + 60, 800000, 350, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 Priya Varma', '+91 00000 00304', 'demo.priya@example.com', 'Walk-in', 'Birthday', d + 20, 250000, 120, E'Demo lead \u2014 sample data.', 'discovery', true),
    (p_org, E'Demo \u00b7 Karthik Rao', '+91 00000 00305', 'demo.karthik@example.com', 'Google', 'Reception', d + 90, 900000, 400, E'Demo lead \u2014 sample data. Just enquired.', 'new', true),
    (p_org, E'Demo \u00b7 Fatima Begum', '+91 00000 00306', 'demo.fatima@example.com', 'Instagram', 'Wedding', d + 75, 1200000, 450, E'Demo lead \u2014 sample data. Went with another planner.', 'lost', true);

  -- events in different stages
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, is_demo) values
    (q1, p_org, 'DEMO-101', E'Demo \u00b7 Ananya & Vikram Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 45, '19:00',
     E'{"name":"Demo \u00b7 Ananya Reddy","phone":"+91 00000 00301","email":"demo.ananya@example.com","city":"Hyderabad"}',
     '{"guests":500,"platePrice":950,"chairs":500,"chairPrice":45,"other":180000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', now(), true),
    (q2, p_org, 'DEMO-102', E'Demo \u00b7 Rohit & Meera Engagement', 'Engagement', 'quote', 'none', 'proposal', d + 30, '18:30',
     E'{"name":"Demo \u00b7 Rohit Sharma","phone":"+91 00000 00302","email":"demo.rohit@example.com","city":"Hyderabad"}',
     '{"guests":200,"platePrice":1450,"chairs":200,"chairPrice":45,"other":120000,"discount":20000,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q3, p_org, 'DEMO-103', E'Demo \u00b7 TechNova Annual Day', 'Corporate', 'quote', 'none', 'quote', d + 60, '17:00',
     E'{"name":"Demo \u00b7 TechNova HR team","phone":"+91 00000 00303","email":"demo.technova@example.com","city":"Hyderabad"}',
     '{"guests":350,"platePrice":950,"chairs":350,"chairPrice":45,"other":150000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q4, p_org, 'DEMO-104', E'Demo \u00b7 Aarav''s 1st Birthday', 'Birthday', 'quote', 'none', 'discovery', d + 20, '12:30',
     E'{"name":"Demo \u00b7 Priya Varma","phone":"+91 00000 00304","email":"demo.priya@example.com","city":"Hyderabad"}',
     '{"guests":120,"platePrice":950,"chairs":120,"chairPrice":45,"other":60000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true);
  -- any lead the quote->lead sync created or linked for a demo event is demo too
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2, q3, q4)
     and name like E'Demo \u00b7 %';

  -- the confirmed wedding: advance paid, two instalments to go (the "invoices")
  -- amounts come from the SERVER-enforced total (D8 trigger), re-read after the insert;
  -- a money row that would be <= 0 is skipped (prod CHECK quote_payments_amount_pos)
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end
    into v_total from public.quotes q where q.id = q1;
  v_total := coalesce(v_total, 0);
  v_a1 := round(v_total * 0.3); v_a2 := round(v_total * 0.4); v_a3 := v_total - v_a1 - v_a2;
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq, is_demo)
  select q1, p_org, x.label, x.due, x.amt, x.st, x.pa, E'Demo \u2014 sample data.', x.seq, true
    from (values
      (E'Demo \u00b7 Advance (30%)', d - 5, v_a1, 'paid', now() - interval '5 days', 1),
      (E'Demo \u00b7 Second instalment (40%)', d + 15, v_a2, 'invoiced', null::timestamptz, 2),
      (E'Demo \u00b7 Balance (30%)', d + 44, v_a3, 'due', null::timestamptz, 3)
    ) as x(label, due, amt, st, pa, seq)
   where x.amt > 0;
  if v_a1 > 0 then
    insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note, is_demo)
      values (q1, p_org, 'upi', v_a1, 'INR', 'paid', true, now() - interval '5 days', 'upi', 'DEMO-R-0001',
              E'Demo payment \u2014 sample data, no money moved.', true);
  end if;

  -- checklist for the wedding
  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq, is_demo) values
    (q1, p_org, 'logistics', E'Demo \u00b7 Confirm hall booking with Sitara', 'Advance receipt filed.', E'Demo \u00b7 Ravi Kumar', d - 3, 'done', 1, true),
    (q1, p_org, 'logistics', E'Demo \u00b7 Book generator backup (250 kVA)', null, E'Demo \u00b7 Imran Shaikh', d + 30, 'open', 2, true),
    (q1, p_org, 'compliance', E'Demo \u00b7 Police & fire NOC', 'Apply 3 weeks before.', E'Demo \u00b7 Ravi Kumar', d + 20, 'open', 3, true),
    (q1, p_org, 'guests', E'Demo \u00b7 Share guest list template with family', null, E'Demo \u00b7 Sneha Reddy', d + 10, 'open', 4, true),
    (q1, p_org, 'comms', E'Demo \u00b7 Send final menu to client', null, E'Demo \u00b7 Lakshmi Prasanna', d + 25, 'open', 5, true),
    (q1, p_org, 'teardown', E'Demo \u00b7 Return rental lights to Deccan Sound', null, E'Demo \u00b7 Imran Shaikh', d + 46, 'open', 6, true);

  -- a finished floor layout for the wedding (opens in the 2D / 3D builder)
  insert into public.layouts(name, data, org_id, is_demo) values
    (E'Demo \u00b7 Ananya & Vikram Wedding \u2014 Sitara Hall', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('id','demo-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label',E'Demo \u00b7 Main Stage','properties','{}'::jsonb),
        jsonb_build_object('id','demo-mandap','type','mandap','category','decor','x',92,'y',26,'width',16,'height',16,'rotation',0,'label',E'Demo \u00b7 Mandap','properties','{}'::jsonb),
        jsonb_build_object('id','demo-dance','type','dancefloor','category','structure','x',88,'y',48,'width',24,'height',24,'rotation',0,'label',E'Demo \u00b7 Dance Floor','properties','{}'::jsonb),
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
        jsonb_build_object('id','demo-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Non-veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-photo','type','photobooth','category','av','x',20,'y',10,'width',8,'height',8,'rotation',0,'label',E'Demo \u00b7 Photo Booth','properties','{}'::jsonb),
        jsonb_build_object('id','demo-carpet','type','redcarpet','category','structure','x',97,'y',100,'width',6,'height',30,'rotation',0,'label',E'Demo \u00b7 Aisle','properties','{}'::jsonb),
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
