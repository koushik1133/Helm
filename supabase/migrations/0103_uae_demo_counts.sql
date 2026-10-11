-- ============================================================================
-- 0103_uae_demo_counts.sql - CANONICAL forward-only. UAE demo seed reports what it really inserted.
-- REQUIRES 0102 (_demo_seed_ae).
--
-- In plain words: "Try with demo data" for a UAE studio said {"packages":2} even when no demo
-- package was added (the studio already uses all 6 menu-package slots, one per tier x diet, and the
-- seed never overwrites a real package). Now it returns the ACTUAL number inserted plus
-- "packages_skipped". Same body as 0102 otherwise.
-- Zero data loss: functions only (CREATE OR REPLACE _demo_seed_ae). India _demo_seed (0100 body),
-- _demo_seed_for, seed_demo_data, reset_demo_data and _demo_clear are NOT touched. No table / data change.
-- Idempotent.
-- ============================================================================
do $$ begin
  if to_regprocedure('public._demo_seed_ae(uuid)') is null then
    raise exception '0103: apply 0102_uae_demo_seed.sql first';
  end if;
end $$;

create or replace function public._demo_seed_ae(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- demo-seed-0103-ae: Dubai sample studio data, AED + VAT 5%, only is_demo rows; returns ACTUAL inserted package count
declare
  d date := current_date;
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  v_total numeric; v_a1 numeric; v_a2 numeric; v_a3 numeric;
  n_pk int := 0;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if exists (select 1 from public.quotes where org_id = p_org and is_demo) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  if exists (select 1 from public.venues where org_id = p_org and is_demo) then
    update public.venues set active = true where org_id = p_org and is_demo and not active;
  else
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                              event_types, restrictions, cost_min, cost_max, cost_basis, parking_spaces, rooms, power_backup_kw,
                              green_rooms, washrooms, address, city, contact_name, notes, is_demo)
    values
      (p_org, E'Demo \u00b7 Al Noor Grand Ballroom', 'banquet_hall', 'ac', 'indoor', 500, 800, 45, 28, 'm',
       array['wedding','corporate','conference','product_launch'], array['no_outside_catering','sound_curfew'], 45000, 90000, 'per_day',
       300, 2, 500, 2, 10, E'Demo \u00b7 Sheikh Zayed Road, P.O. Box 00000', 'Dubai', E'Demo \u00b7 Banquet manager',
       E'Demo venue \u2014 sample data. In-house halal catering; alcohol only under the hotel licence.', true),
      (p_org, E'Demo \u00b7 Desert Pearl Camp', 'lawn', 'non_ac', 'outdoor', 300, 600, 60, 40, 'm',
       array['wedding','corporate','other'], array['generator_required','no_fireworks'], 30000, 60000, 'per_day',
       120, 1, 0, 1, 6, E'Demo \u00b7 Al Qudra Road, P.O. Box 00000', 'Dubai', E'Demo \u00b7 Camp manager',
       E'Demo venue \u2014 sample data. Majlis seating; best October to April.', true);
  end if;

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

  -- halal menu (all meat halal; no pork, no alcohol in the packages)
  insert into public.dish_catalog(org_id, category, name, kind, is_demo) values
    (p_org, 'Cold mezze', E'Demo \u00b7 Hummus & moutabal', 'veg', true),
    (p_org, 'Cold mezze', E'Demo \u00b7 Fattoush', 'veg', true),
    (p_org, 'Hot mezze', E'Demo \u00b7 Lamb kibbeh (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Lamb ouzi with oriental rice (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Chicken machboos (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Hammour fillet, saffron sauce', 'nonveg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Luqaimat with date syrup', 'veg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Umm Ali', 'veg', true)
  on conflict do nothing;
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  select x.* from (values
    (m1, p_org, 'gold', 'nonveg', E'Demo \u00b7 Arabic Mezze & Grill', 295::numeric,
     E'[{"n":"Demo \u00b7 Hummus & moutabal","c":"Cold mezze","k":"veg"},{"n":"Demo \u00b7 Fattoush","c":"Cold mezze","k":"veg"},{"n":"Demo \u00b7 Chicken machboos (halal)","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Luqaimat with date syrup","c":"Desserts","k":"veg"}]'::jsonb,
     true, 901, E'Demo package \u2014 sample data. AED per person, halal, no pork / alcohol.', 50, 800, true),
    (m2, p_org, 'premium', 'nonveg', E'Demo \u00b7 Emirati Royal Feast', 425::numeric,
     E'[{"n":"Demo \u00b7 Lamb kibbeh (halal)","c":"Hot mezze","k":"nonveg"},{"n":"Demo \u00b7 Lamb ouzi with oriental rice (halal)","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Hammour fillet, saffron sauce","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Umm Ali","c":"Desserts","k":"veg"}]'::jsonb,
     true, 902, E'Demo package \u2014 sample data. AED per person, halal, no pork / alcohol.', 80, 1000, true)
  ) as x(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  where not exists (select 1 from public.menu_templates t where t.org_id = p_org and t.tier = x.tier and t.diet = x.diet);
  get diagnostics n_pk = row_count;   -- 0103: a studio using every tier x diet slot gets 0, not a claimed 2

  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Chiavari chairs (gold)', 'Furniture', 500, 'pcs', 'A', 15, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Round tables (1.8 m)', 'Furniture', 60, 'pcs', 'A', 60, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Majlis floor seating set', 'Furniture', 10, 'sets', 'A', 900, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 LED par lights', 'Lighting', 48, 'pcs', 'B', 120, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Stage platforms (2.4 x 1.2 m)', 'Staging', 24, 'pcs', 'A', 250, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Ramadan lantern set', 'Decor', 40, 'pcs', 'B', 80, E'Demo item \u2014 sample data. AED.', true, true)
  on conflict do nothing;

  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select * from (values
    (p_org, E'Demo \u00b7 Omar Al Mansoori', '+971 00 000 0101', 'Operations', 'Event manager', 'full_time', 900, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Maria Santos', '+971 00 000 0102', 'Decor', 'Decor lead', 'full_time', 700, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Rahul Menon', '+971 00 000 0103', 'Logistics', 'Logistics supervisor', 'part_time', 550, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Layla Haddad', '+971 00 000 0104', 'Hospitality', 'Guest coordinator', 'on_call', 450::numeric, E'Demo staff \u2014 sample data. Day rate in AED.', true, true)
  ) as x(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.name);
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Jumeirah Blooms', 'Florist', 'vendor', '+971 00 000 0201', 'demo.florist@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Gulf Sound & Lights', 'Sound & lights', 'rental', '+971 00 000 0202', 'demo.sound@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Marina Lens Studio', 'Photography', 'freelancer', '+971 00 000 0203', 'demo.photo@example.com', E'Demo vendor \u2014 sample data.', true, true)
  on conflict do nothing;

  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo) values
    (p_org, E'Demo \u00b7 Noura Al Hashimi', '+971 00 000 0301', 'demo.noura@example.com', 'Instagram', 'Wedding', d + 45, 350000, 400, E'Demo lead \u2014 sample data.', 'won', true),
    (p_org, E'Demo \u00b7 Khalid Rahman', '+971 00 000 0302', 'demo.khalid@example.com', 'Referral', 'Engagement', d + 30, 120000, 150, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 Falcon Tech FZ-LLC', '+971 00 000 0303', 'demo.falcon@example.com', 'Website', 'Gala dinner', d + 60, 250000, 300, E'Demo lead \u2014 sample data. B2B client, VAT registered.', 'quoted', true),
    (p_org, E'Demo \u00b7 Sara Khan', '+971 00 000 0304', 'demo.sara@example.com', 'Walk-in', 'Iftar', d + 20, 60000, 120, E'Demo lead \u2014 sample data.', 'discovery', true),
    (p_org, E'Demo \u00b7 Daniel Wright', '+971 00 000 0305', 'demo.daniel@example.com', 'Google', 'Product launch', d + 90, 180000, 250, E'Demo lead \u2014 sample data. Just enquired.', 'new', true),
    (p_org, E'Demo \u00b7 Aisha Siddiqui', '+971 00 000 0306', 'demo.aisha@example.com', 'Instagram', 'Wedding', d + 75, 300000, 350, E'Demo lead \u2014 sample data. Went with another planner.', 'lost', true);

  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, is_demo) values
    (q1, p_org, 'DEMO-101', E'Demo \u00b7 Noura & Saeed Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 45, '20:00',
     E'{"name":"Demo \u00b7 Noura Al Hashimi","phone":"+971 00 000 0301","email":"demo.noura@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":400,"platePrice":425,"chairs":400,"chairPrice":15,"other":60000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', now(), true),
    (q2, p_org, 'DEMO-102', E'Demo \u00b7 Khalid & Huda Engagement', 'Engagement', 'quote', 'none', 'proposal', d + 30, '19:30',
     E'{"name":"Demo \u00b7 Khalid Rahman","phone":"+971 00 000 0302","email":"demo.khalid@example.com","city":"Sharjah","state":"Sharjah"}',
     '{"guests":150,"platePrice":295,"chairs":150,"chairPrice":15,"other":25000,"discount":3000,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true),
    (q3, p_org, 'DEMO-103', E'Demo \u00b7 Falcon Tech Annual Gala', 'Gala dinner', 'quote', 'none', 'quote', d + 60, '19:00',
     E'{"name":"Demo \u00b7 Falcon Tech FZ-LLC","company":"Falcon Tech FZ-LLC","trn":"100000000000003","phone":"+971 00 000 0303","email":"demo.falcon@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":300,"platePrice":295,"chairs":300,"chairPrice":15,"other":45000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true),
    (q4, p_org, 'DEMO-104', E'Demo \u00b7 Ramadan Iftar Majlis', 'Iftar', 'quote', 'none', 'discovery', d + 20, '18:15',
     E'{"name":"Demo \u00b7 Sara Khan","phone":"+971 00 000 0304","email":"demo.sara@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":120,"platePrice":295,"chairs":0,"chairPrice":0,"other":12000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true);
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2, q3, q4)
     and name like E'Demo \u00b7 %';

  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end
    into v_total from public.quotes q where q.id = q1;
  v_total := coalesce(v_total, 0);
  v_a1 := round(v_total * 0.5); v_a2 := round(v_total * 0.3); v_a3 := v_total - v_a1 - v_a2;
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq, is_demo)
  select q1, p_org, x.label, x.due, x.amt, x.st, x.pa, E'Demo \u2014 sample data.', x.seq, true
    from (values
      (E'Demo \u00b7 Booking deposit (50%)', d - 5, v_a1, 'paid', now() - interval '5 days', 1),
      (E'Demo \u00b7 Second payment (30%)', d + 15, v_a2, 'invoiced', null::timestamptz, 2),
      (E'Demo \u00b7 Balance (20%)', d + 38, v_a3, 'due', null::timestamptz, 3)
    ) as x(label, due, amt, st, pa, seq)
   where x.amt > 0;
  if v_a1 > 0 then
    insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note, is_demo)
      values (q1, p_org, 'bank', v_a1, 'AED', 'paid', true, now() - interval '5 days', 'bank', 'DEMO-R-0001',
              E'Demo payment \u2014 sample data (bank transfer), no money moved.', true);
  end if;

  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq, is_demo) values
    (q1, p_org, 'logistics', E'Demo \u00b7 Confirm ballroom booking with Al Noor', 'Deposit receipt filed.', E'Demo \u00b7 Omar Al Mansoori', d - 3, 'done', 1, true),
    (q1, p_org, 'compliance', E'Demo \u00b7 DET event permit + civil defence approval', 'Apply 3 weeks before.', E'Demo \u00b7 Omar Al Mansoori', d + 20, 'open', 2, true),
    (q1, p_org, 'guests', E'Demo \u00b7 Separate ladies majlis seating plan', null, E'Demo \u00b7 Layla Haddad', d + 10, 'open', 3, true),
    (q1, p_org, 'comms', E'Demo \u00b7 Send final halal menu to client', null, E'Demo \u00b7 Maria Santos', d + 25, 'open', 4, true),
    (q1, p_org, 'teardown', E'Demo \u00b7 Return rental lights to Gulf Sound', null, E'Demo \u00b7 Rahul Menon', d + 46, 'open', 5, true);

  insert into public.layouts(name, data, org_id, is_demo) values
    (E'Demo \u00b7 Noura & Saeed Wedding \u2014 Al Noor Ballroom', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('id','demo-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label',E'Demo \u00b7 Kosha stage','properties','{}'::jsonb),
        jsonb_build_object('id','demo-dance','type','dancefloor','category','structure','x',88,'y',30,'width',24,'height',24,'rotation',0,'label',E'Demo \u00b7 Zaffa walkway floor','properties','{}'::jsonb),
        jsonb_build_object('id','demo-t1','type','table','category','seating','x',30,'y',40,'width',6,'height',6,'rotation',0,'label','Table 1','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t2','type','table','category','seating','x',44,'y',40,'width',6,'height',6,'rotation',0,'label','Table 2','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t3','type','table','category','seating','x',58,'y',40,'width',6,'height',6,'rotation',0,'label','Table 3','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t4','type','table','category','seating','x',136,'y',40,'width',6,'height',6,'rotation',0,'label','Table 4','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t5','type','table','category','seating','x',150,'y',40,'width',6,'height',6,'rotation',0,'label','Table 5','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t6','type','table','category','seating','x',164,'y',40,'width',6,'height',6,'rotation',0,'label','Table 6','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Halal buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Arabic coffee & dates','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit1','type','exit','category','safety','x',0,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit2','type','exit','category','safety','x',188,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb)),
      'grid', jsonb_build_object('snap', true, 'show', true, 'unit', 'm', 'sizeFt', 2),
      'margins', jsonb_build_object('left', 0, 'right', 0, 'top', 0, 'bottom', 0),
      'venue', jsonb_build_object('capacity', 500),
      'scale', jsonb_build_object('pxPerFt', 12, 'worldFt', jsonb_build_object('w', 200, 'h', 140)),
      'demo', true), p_org, true);

  update public.organizations set trial_mode = 'demo' where id = p_org;
  return jsonb_build_object('seeded', true, 'country', 'AE', 'quotes', 4, 'leads', 6, 'staff', 4, 'vendors', 3, 'inventory', 6,
                            'venues', 2, 'packages', n_pk, 'packages_skipped', 2 - n_pk, 'dishes', 8, 'layouts', 1);
end $$;
revoke all on function public._demo_seed_ae(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._demo_seed_ae(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._demo_seed_ae(uuid) from authenticated'; end if;
end $$;

