-- APPLY-0170.sql - paste into the Supabase SQL editor (STAGING first; production only when the owner says go).
-- Run AFTER APPLY-0169.sql. Free-trial sample data v4 in the sample master studio: the owner's 145-dish catalog (no Demo
-- prefix), the owner's 6 menu packages (Standard / Gold / Premium x Vegetarian / Non-veg), sample events on the packages
-- (server reprices), + 7 owner vendors + a fireworks vendor, + the owner's 10 inventory items (3 duplicates merged),
-- + 2 staff; every new trial studio gets them; manifest v4 ('v4: owner menus, dishes, vendors, inventory') is published once.
-- Additive + idempotent: only rows of the sample master studio change. Safe to run twice. ASCII only.
-- Roll back the data for new trials: select public.set_current_sample_manifest(3);
-- (Existing trial studios are never re-seeded; the master rows stay as v4 until edited in the app.)
begin;
-- ============================================================================
-- 0170_trial_data_v4.sql - CANONICAL forward-only. Free-trial sample data v4: the owner's dish
-- catalog (145 dishes), the owner's 6 menu packages, 7 owner vendors + a fireworks vendor, 10 owner
-- inventory items, 2 corporate-event staff; every new trial studio gets them.
-- REQUIRES 0166 + 0167 + 0168 + 0169 (sample master, manifest, clone wrappers, publish).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md.
--
-- In plain words:
--   1  Dishes: the 30 v1 sample dishes ("Demo . ...") of the master are replaced by the owner's
--      full catalog (145 dishes in 18 categories). Dish names are real menu items, not personal
--      data, so they carry NO "Demo ." prefix. The old rows are removed only if they still have
--      their exact 0167 name and no event menu line points at them (master rows only).
--   2  Menu packages: the 6 packages are updated IN PLACE (same ids, matched by the old 0167 name
--      of their tier x diet) to the owner's names, prices and dish lists:
--      Standard / Gold / Premium - Vegetarian Rs 450 / 700 / 1000; - Non-veg Rs 650 / 950 / 1400.
--   3  Sample events use the packages: wedding -> Gold - Non-veg (950), engagement (sent) ->
--      Premium - Vegetarian (1000), corporate -> Standard - Non-veg (650). The server pricing
--      engine (D8) reprices the totals; the wedding's simulated advance (30 %) and balance (70 %)
--      follow the new total. The closed engagement is settled and is not touched.
--   4  Vendors: + 7 owner vendors (AV, furniture, stage, LED & lighting, catering, logistics,
--      print & branding) + "Demo . Sky Fireworks & Cold Pyro" (Fireworks). The 8 v1 vendors stay.
--      Dummy contacts: demo.*@example.com, +91 00000 002xx (reserved, not dialable).
--   5  Inventory: + the owner's 10 items (rental rate per unit). Duplicates of v1 rows are merged
--      in place (same id): LED par light, cordless microphone and round table 6 ft take the owner's
--      name, category, qty and rate. The sample wedding's reservations of those are capped at the
--      new stock (round tables 30, LED par lights 20) so the sample shows no shortage.
--   6  Staff: + 2 (registration desk lead, AV technician); the 10 v1 staff stay.
--   7  Every row of these 5 tables in the master is marked is_demo (the trial copies always were).
--   8  Manifest v4 is published once. Only NEW trials get it. Roll back: set_current_sample_manifest(3).
--
-- ZERO DATA LOSS: every row written, changed or removed here belongs to the sample master studio
-- (fixed id a5a5a5a5-0166-4000-8000-000000000001). No other studio's row is touched. Matching is on
-- the 0167-0169 values, so owner edits made in the app are never overwritten. ASCII only. Safe to
-- run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null or to_regprocedure('public._demo_clear__pre0169(uuid)') is null
     or to_regclass('public.helm_trial_seed_manifest') is null then
    raise exception '0170 needs 0166 + 0167 + 0168 + 0169 first'; end if;
end $$;

do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q1 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a1';
  q2 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a2';
  q3 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a3';
  D constant text := E'Demo \u00b7 ';
  v record; t1 numeric; a1 numeric;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;

  -- 1) dishes: the owner's catalog (added once per category + name), then the v1 rows go
  insert into public.dish_catalog(org_id, category, name, kind, active, is_demo)
  select M, x.c, x.n, x.k, true, true
    from (values
      ('Beverages', 'Cold coffee', 'veg'),
      ('Beverages', 'Filter coffee', 'veg'),
      ('Beverages', 'Fresh lime soda', 'veg'),
      ('Beverages', 'Mango lassi', 'veg'),
      ('Beverages', 'Masala chai', 'veg'),
      ('Beverages', 'Mineral water', 'veg'),
      ('Beverages', 'Packaged Water 500 ml', 'veg'),
      ('Beverages', 'Soft drinks', 'veg'),
      ('Beverages', 'Sweet lassi', 'veg'),
      ('Beverages', 'Tea / Coffee', 'veg'),
      ('Beverages', 'Welcome Mocktail', 'veg'),
      ('Breads', 'Butter naan', 'veg'),
      ('Breads', 'Garlic naan', 'veg'),
      ('Breads', 'Kulcha', 'veg'),
      ('Breads', 'Laccha paratha', 'veg'),
      ('Breads', 'Missi roti', 'veg'),
      ('Breads', 'Poori', 'veg'),
      ('Breads', 'Rumali roti', 'veg'),
      ('Breads', 'Tandoori roti', 'veg'),
      ('Chaat & live counters', 'Bhel puri', 'veg'),
      ('Chaat & live counters', 'Chole bhature', 'veg'),
      ('Chaat & live counters', 'Dahi puri', 'veg'),
      ('Chaat & live counters', 'Live chaat counter', 'special'),
      ('Chaat & live counters', 'Live dosa counter', 'special'),
      ('Chaat & live counters', 'Live pasta counter', 'special'),
      ('Chaat & live counters', 'Live tandoor counter', 'special'),
      ('Chaat & live counters', 'Pani puri', 'veg'),
      ('Chaat & live counters', 'Papdi chaat', 'veg'),
      ('Chaat & live counters', 'Pav bhaji', 'veg'),
      ('Chaat & live counters', 'Ragda pattice', 'veg'),
      ('Chaat & live counters', 'Sev puri', 'veg'),
      ('Chinese', 'Chicken fried rice', 'nonveg'),
      ('Chinese', 'Chicken noodles', 'nonveg'),
      ('Chinese', 'Chilli garlic noodles', 'veg'),
      ('Chinese', 'Chilli paneer', 'veg'),
      ('Chinese', 'Manchurian gravy', 'veg'),
      ('Chinese', 'Schezwan fried rice', 'veg'),
      ('Chinese', 'Veg fried rice', 'veg'),
      ('Chinese', 'Veg noodles', 'veg'),
      ('Desserts', 'Assorted ice cream', 'veg'),
      ('Desserts', 'Double ka meetha', 'special'),
      ('Desserts', 'Fruit custard', 'veg'),
      ('Desserts', 'Gajar halwa', 'veg'),
      ('Desserts', 'Gulab jamun', 'veg'),
      ('Desserts', 'Jalebi', 'veg'),
      ('Desserts', 'Kaju katli', 'special'),
      ('Desserts', 'Kheer', 'veg'),
      ('Desserts', 'Moong dal halwa', 'special'),
      ('Desserts', 'Payasam', 'veg'),
      ('Desserts', 'Rasgulla', 'veg'),
      ('Desserts', 'Rasmalai', 'veg'),
      ('Indian Bread', 'Roti / Naan', 'veg'),
      ('Main course (nonveg)', 'Andhra chicken', 'nonveg'),
      ('Main course (nonveg)', 'Butter chicken', 'nonveg'),
      ('Main course (nonveg)', 'Chicken chettinad', 'nonveg'),
      ('Main course (nonveg)', 'Chicken curry', 'nonveg'),
      ('Main course (nonveg)', 'Egg curry', 'nonveg'),
      ('Main course (nonveg)', 'Fish curry', 'nonveg'),
      ('Main course (nonveg)', 'Hyderabadi chicken', 'nonveg'),
      ('Main course (nonveg)', 'Kadai chicken', 'nonveg'),
      ('Main course (nonveg)', 'Mutton curry', 'special'),
      ('Main course (nonveg)', 'Mutton rogan josh', 'special'),
      ('Main course (nonveg)', 'Prawn masala', 'special'),
      ('Main course (veg)', 'Aloo gobi', 'veg'),
      ('Main course (veg)', 'Bhindi masala', 'veg'),
      ('Main course (veg)', 'Chana masala', 'veg'),
      ('Main course (veg)', 'Dal makhani', 'veg'),
      ('Main course (veg)', 'Dal tadka', 'veg'),
      ('Main course (veg)', 'Dum aloo', 'veg'),
      ('Main course (veg)', 'Kadai paneer', 'veg'),
      ('Main course (veg)', 'Malai kofta', 'veg'),
      ('Main course (veg)', 'Mix veg curry', 'veg'),
      ('Main course (veg)', 'Palak paneer', 'veg'),
      ('Main course (veg)', 'Paneer butter masala', 'veg'),
      ('Main course (veg)', 'Paneer lababdar', 'veg'),
      ('Main course (veg)', 'Veg kolhapuri', 'veg'),
      ('Main course (veg)', 'Veg korma', 'veg'),
      ('Meals', 'Non-Veg Lunch Buffet', 'nonveg'),
      ('Meals', 'Veg Lunch Buffet', 'veg'),
      ('Rice', 'Vegetable Biryani', 'veg'),
      ('Rice & biryani', 'Chicken biryani', 'nonveg'),
      ('Rice & biryani', 'Curd rice', 'veg'),
      ('Rice & biryani', 'Egg biryani', 'nonveg'),
      ('Rice & biryani', 'Ghee rice', 'veg'),
      ('Rice & biryani', 'Hyderabadi dum biryani', 'special'),
      ('Rice & biryani', 'Jeera rice', 'veg'),
      ('Rice & biryani', 'Mutton biryani', 'special'),
      ('Rice & biryani', 'Steamed rice', 'veg'),
      ('Rice & biryani', 'Veg biryani', 'veg'),
      ('Rice & biryani', 'Veg pulao', 'veg'),
      ('Salads', 'Caesar salad', 'veg'),
      ('Salads', 'Fruit salad', 'veg'),
      ('Salads', 'Green salad', 'veg'),
      ('Salads', 'Kachumber salad', 'veg'),
      ('Salads', 'Russian salad', 'veg'),
      ('Salads', 'Sprouts salad', 'veg'),
      ('Snacks', 'Cookies and Biscuits', 'veg'),
      ('Snacks', 'Evening Snacks Box', 'veg'),
      ('Snacks', 'Mini Samosa', 'veg'),
      ('Snacks', 'Veg Sandwich', 'veg'),
      ('Soups', 'Chicken clear soup', 'nonveg'),
      ('Soups', 'Cream of mushroom soup', 'veg'),
      ('Soups', 'Hot and sour soup', 'veg'),
      ('Soups', 'Manchow soup', 'veg'),
      ('Soups', 'Sweet corn soup', 'veg'),
      ('Soups', 'Tomato shorba', 'veg'),
      ('South Indian', 'Idli sambar', 'veg'),
      ('South Indian', 'Lemon rice', 'veg'),
      ('South Indian', 'Masala dosa', 'veg'),
      ('South Indian', 'Medu vada', 'veg'),
      ('South Indian', 'Rava dosa', 'veg'),
      ('South Indian', 'Upma', 'veg'),
      ('South Indian', 'Uttapam', 'veg'),
      ('South Indian', 'Ven pongal', 'veg'),
      ('Starters (nonveg)', 'Apollo fish', 'special'),
      ('Starters (nonveg)', 'Chicken 65', 'nonveg'),
      ('Starters (nonveg)', 'Chicken lollipop', 'nonveg'),
      ('Starters (nonveg)', 'Chicken malai kabab', 'nonveg'),
      ('Starters (nonveg)', 'Chicken tikka', 'nonveg'),
      ('Starters (nonveg)', 'Chilli chicken', 'nonveg'),
      ('Starters (nonveg)', 'Fish Amritsari', 'nonveg'),
      ('Starters (nonveg)', 'Fish tikka', 'nonveg'),
      ('Starters (nonveg)', 'Mutton seekh kabab', 'nonveg'),
      ('Starters (nonveg)', 'Prawn koliwada', 'special'),
      ('Starters (nonveg)', 'Tandoori chicken', 'nonveg'),
      ('Starters (veg)', 'Aloo tikki', 'veg'),
      ('Starters (veg)', 'Cheese corn nuggets', 'veg'),
      ('Starters (veg)', 'Corn cheese balls', 'veg'),
      ('Starters (veg)', 'Crispy baby corn', 'veg'),
      ('Starters (veg)', 'Gobi Manchurian', 'veg'),
      ('Starters (veg)', 'Hara bhara kabab', 'veg'),
      ('Starters (veg)', 'Mushroom tikka', 'veg'),
      ('Starters (veg)', 'Paneer 65', 'veg'),
      ('Starters (veg)', 'Paneer tikka', 'veg'),
      ('Starters (veg)', 'Tandoori aloo', 'veg'),
      ('Starters (veg)', 'Veg seekh kabab', 'veg'),
      ('Starters (veg)', 'Veg spring roll', 'veg'),
      ('Welcome drinks', 'Aam panna', 'veg'),
      ('Welcome drinks', 'Badam milk', 'special'),
      ('Welcome drinks', 'Fresh coconut water', 'veg'),
      ('Welcome drinks', 'Jaljeera', 'veg'),
      ('Welcome drinks', 'Lemon mint cooler', 'veg'),
      ('Welcome drinks', 'Rose milk', 'veg'),
      ('Welcome drinks', 'Spiced buttermilk', 'veg'),
      ('Welcome drinks', 'Watermelon cooler', 'veg')
    ) x(c, n, k)
   where not exists (select 1 from public.dish_catalog y where y.org_id = M and y.category = x.c and lower(y.name) = lower(x.n));

  delete from public.dish_catalog d
   where d.org_id = M and d.name like E'Demo \u00b7 %'
     and d.name = any (array[E'Demo \u00b7 Rose Sharbat', E'Demo \u00b7 Masala Chaas', E'Demo \u00b7 Fresh Lime Soda', E'Demo \u00b7 Paneer Tikka',
       E'Demo \u00b7 Hara Bhara Kebab', E'Demo \u00b7 Corn Cheese Balls', E'Demo \u00b7 Apollo Fish', E'Demo \u00b7 Chicken 65',
       E'Demo \u00b7 Mutton Shikampuri Kebab', E'Demo \u00b7 Veg Dum Biryani', E'Demo \u00b7 Hyderabadi Chicken Dum Biryani',
       E'Demo \u00b7 Kacchi Mutton Biryani', E'Demo \u00b7 Bagara Baingan', E'Demo \u00b7 Mirchi ka Salan', E'Demo \u00b7 Paneer Butter Masala',
       E'Demo \u00b7 Dal Makhani', E'Demo \u00b7 Mutton Haleem', E'Demo \u00b7 Butter Chicken', E'Demo \u00b7 Gongura Mutton',
       E'Demo \u00b7 Butter Naan', E'Demo \u00b7 Rumali Roti', E'Demo \u00b7 Jeera Rice', E'Demo \u00b7 Curd Rice',
       E'Demo \u00b7 Double ka Meetha', E'Demo \u00b7 Qubani ka Meetha', E'Demo \u00b7 Gulab Jamun', E'Demo \u00b7 Kesar Rasmalai',
       E'Demo \u00b7 Mini Samosa', E'Demo \u00b7 Osmania Biscuits & Irani Chai', E'Demo \u00b7 Live Dosa Counter'])
     and not exists (select 1 from public.event_menu_items e where e.dish_id = d.id);

  -- 2) menu packages: same row per tier x diet, matched by the old 0167 name
  for v in select * from (values
      ('standard', 'veg', E'Standard \u2014 Vegetarian', 450, '[{"n":"Lemon mint cooler","c":"Welcome drinks","k":"veg"},{"n":"Paneer tikka","c":"Starters (veg)","k":"veg"},{"n":"Gobi Manchurian","c":"Starters (veg)","k":"veg"},{"n":"Sweet corn soup","c":"Soups","k":"veg"},{"n":"Green salad","c":"Salads","k":"veg"},{"n":"Paneer butter masala","c":"Main course (veg)","k":"veg"},{"n":"Mix veg curry","c":"Main course (veg)","k":"veg"},{"n":"Dal tadka","c":"Main course (veg)","k":"veg"},{"n":"Butter naan","c":"Breads","k":"veg"},{"n":"Tandoori roti","c":"Breads","k":"veg"},{"n":"Veg biryani","c":"Rice & biryani","k":"veg"},{"n":"Jeera rice","c":"Rice & biryani","k":"veg"},{"n":"Gulab jamun","c":"Desserts","k":"veg"},{"n":"Soft drinks","c":"Beverages","k":"veg"}]', 14),
      ('gold', 'veg', E'Gold \u2014 Vegetarian', 700, '[{"n":"Watermelon cooler","c":"Welcome drinks","k":"veg"},{"n":"Badam milk","c":"Welcome drinks","k":"special"},{"n":"Paneer tikka","c":"Starters (veg)","k":"veg"},{"n":"Mushroom tikka","c":"Starters (veg)","k":"veg"},{"n":"Corn cheese balls","c":"Starters (veg)","k":"veg"},{"n":"Hot and sour soup","c":"Soups","k":"veg"},{"n":"Russian salad","c":"Salads","k":"veg"},{"n":"Paneer lababdar","c":"Main course (veg)","k":"veg"},{"n":"Dal makhani","c":"Main course (veg)","k":"veg"},{"n":"Kadai paneer","c":"Main course (veg)","k":"veg"},{"n":"Malai kofta","c":"Main course (veg)","k":"veg"},{"n":"Garlic naan","c":"Breads","k":"veg"},{"n":"Laccha paratha","c":"Breads","k":"veg"},{"n":"Veg biryani","c":"Rice & biryani","k":"veg"},{"n":"Ghee rice","c":"Rice & biryani","k":"veg"},{"n":"Live chaat counter","c":"Chaat & live counters","k":"special"},{"n":"Rasmalai","c":"Desserts","k":"veg"},{"n":"Gajar halwa","c":"Desserts","k":"veg"},{"n":"Mango lassi","c":"Beverages","k":"veg"}]', 19),
      ('premium', 'veg', E'Premium \u2014 Vegetarian', 1000, '[{"n":"Rose milk","c":"Welcome drinks","k":"veg"},{"n":"Fresh coconut water","c":"Welcome drinks","k":"veg"},{"n":"Paneer 65","c":"Starters (veg)","k":"veg"},{"n":"Mushroom tikka","c":"Starters (veg)","k":"veg"},{"n":"Cheese corn nuggets","c":"Starters (veg)","k":"veg"},{"n":"Tandoori aloo","c":"Starters (veg)","k":"veg"},{"n":"Cream of mushroom soup","c":"Soups","k":"veg"},{"n":"Caesar salad","c":"Salads","k":"veg"},{"n":"Paneer butter masala","c":"Main course (veg)","k":"veg"},{"n":"Palak paneer","c":"Main course (veg)","k":"veg"},{"n":"Veg kolhapuri","c":"Main course (veg)","k":"veg"},{"n":"Malai kofta","c":"Main course (veg)","k":"veg"},{"n":"Dal makhani","c":"Main course (veg)","k":"veg"},{"n":"Butter naan","c":"Breads","k":"veg"},{"n":"Rumali roti","c":"Breads","k":"veg"},{"n":"Hyderabadi dum biryani","c":"Rice & biryani","k":"special"},{"n":"Veg pulao","c":"Rice & biryani","k":"veg"},{"n":"Live dosa counter","c":"Chaat & live counters","k":"special"},{"n":"Live pasta counter","c":"Chaat & live counters","k":"special"},{"n":"Moong dal halwa","c":"Desserts","k":"special"},{"n":"Kaju katli","c":"Desserts","k":"special"},{"n":"Assorted ice cream","c":"Desserts","k":"veg"},{"n":"Cold coffee","c":"Beverages","k":"veg"}]', 23),
      ('standard', 'nonveg', E'Standard \u2014 Non-veg', 650, '[{"n":"Lemon mint cooler","c":"Welcome drinks","k":"veg"},{"n":"Paneer tikka","c":"Starters (veg)","k":"veg"},{"n":"Chicken 65","c":"Starters (nonveg)","k":"nonveg"},{"n":"Chicken clear soup","c":"Soups","k":"nonveg"},{"n":"Kachumber salad","c":"Salads","k":"veg"},{"n":"Paneer butter masala","c":"Main course (veg)","k":"veg"},{"n":"Dal tadka","c":"Main course (veg)","k":"veg"},{"n":"Chicken curry","c":"Main course (nonveg)","k":"nonveg"},{"n":"Butter naan","c":"Breads","k":"veg"},{"n":"Tandoori roti","c":"Breads","k":"veg"},{"n":"Chicken biryani","c":"Rice & biryani","k":"nonveg"},{"n":"Veg biryani","c":"Rice & biryani","k":"veg"},{"n":"Jeera rice","c":"Rice & biryani","k":"veg"},{"n":"Gulab jamun","c":"Desserts","k":"veg"},{"n":"Soft drinks","c":"Beverages","k":"veg"}]', 15),
      ('gold', 'nonveg', E'Gold \u2014 Non-veg', 950, '[{"n":"Watermelon cooler","c":"Welcome drinks","k":"veg"},{"n":"Paneer tikka","c":"Starters (veg)","k":"veg"},{"n":"Chicken tikka","c":"Starters (nonveg)","k":"nonveg"},{"n":"Mutton seekh kabab","c":"Starters (nonveg)","k":"nonveg"},{"n":"Hot and sour soup","c":"Soups","k":"veg"},{"n":"Russian salad","c":"Salads","k":"veg"},{"n":"Kadai paneer","c":"Main course (veg)","k":"veg"},{"n":"Dal makhani","c":"Main course (veg)","k":"veg"},{"n":"Butter chicken","c":"Main course (nonveg)","k":"nonveg"},{"n":"Mutton rogan josh","c":"Main course (nonveg)","k":"special"},{"n":"Garlic naan","c":"Breads","k":"veg"},{"n":"Laccha paratha","c":"Breads","k":"veg"},{"n":"Chicken biryani","c":"Rice & biryani","k":"nonveg"},{"n":"Veg biryani","c":"Rice & biryani","k":"veg"},{"n":"Ghee rice","c":"Rice & biryani","k":"veg"},{"n":"Live tandoor counter","c":"Chaat & live counters","k":"special"},{"n":"Rasmalai","c":"Desserts","k":"veg"},{"n":"Gajar halwa","c":"Desserts","k":"veg"},{"n":"Mango lassi","c":"Beverages","k":"veg"}]', 19),
      ('premium', 'nonveg', E'Premium \u2014 Non-veg', 1400, '[{"n":"Rose milk","c":"Welcome drinks","k":"veg"},{"n":"Fresh coconut water","c":"Welcome drinks","k":"veg"},{"n":"Paneer 65","c":"Starters (veg)","k":"veg"},{"n":"Chicken malai kabab","c":"Starters (nonveg)","k":"nonveg"},{"n":"Fish tikka","c":"Starters (nonveg)","k":"nonveg"},{"n":"Prawn koliwada","c":"Starters (nonveg)","k":"special"},{"n":"Chicken clear soup","c":"Soups","k":"nonveg"},{"n":"Caesar salad","c":"Salads","k":"veg"},{"n":"Paneer lababdar","c":"Main course (veg)","k":"veg"},{"n":"Dal makhani","c":"Main course (veg)","k":"veg"},{"n":"Butter chicken","c":"Main course (nonveg)","k":"nonveg"},{"n":"Mutton curry","c":"Main course (nonveg)","k":"special"},{"n":"Prawn masala","c":"Main course (nonveg)","k":"special"},{"n":"Fish curry","c":"Main course (nonveg)","k":"nonveg"},{"n":"Butter naan","c":"Breads","k":"veg"},{"n":"Rumali roti","c":"Breads","k":"veg"},{"n":"Mutton biryani","c":"Rice & biryani","k":"special"},{"n":"Chicken biryani","c":"Rice & biryani","k":"nonveg"},{"n":"Veg biryani","c":"Rice & biryani","k":"veg"},{"n":"Live dosa counter","c":"Chaat & live counters","k":"special"},{"n":"Moong dal halwa","c":"Desserts","k":"special"},{"n":"Double ka meetha","c":"Desserts","k":"special"},{"n":"Assorted ice cream","c":"Desserts","k":"veg"},{"n":"Cold coffee","c":"Beverages","k":"veg"}]', 24)
  ) x(tier, diet, name, price, dishes, n) loop
    update public.menu_templates t set name = v.name, price_per_plate = v.price, dishes = v.dishes::jsonb, active = true,
           description = 'Sample package. ' || v.n || ' dishes. Edit the dishes and the price per plate to your own.'
     where t.org_id = M and t.tier = v.tier and t.diet = v.diet
       and t.name = any (array[E'Demo \u00b7 Silver Veg', E'Demo \u00b7 Gold Veg', E'Demo \u00b7 Royal Veg',
                               E'Demo \u00b7 Classic Non-veg', E'Demo \u00b7 Nizami Non-veg', E'Demo \u00b7 Royal Nizami Feast'])
       and not exists (select 1 from public.menu_templates y where y.org_id = M and y.name = v.name);
    if not exists (select 1 from public.menu_templates y where y.org_id = M and y.name = v.name) then
      insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
      values (M, v.tier, v.diet, v.name, v.price, v.dishes::jsonb, true,
              case v.tier when 'standard' then 1 when 'gold' then 2 else 3 end + case when v.diet = 'nonveg' then 3 else 0 end,
              'Sample package. ' || v.n || ' dishes. Edit the dishes and the price per plate to your own.', 100, 2000, true);
    end if;
  end loop;

  -- 3) the sample events use the packages (only while they still carry the 0167 plate price); D8 reprices
  update public.quotes q set pricing = q.pricing || jsonb_build_object('platePrice', x.price, '_packageName', x.pkg)
    from (values (q1, 1250, 950, E'Gold \u2014 Non-veg'), (q2, 1350, 1000, E'Premium \u2014 Vegetarian'),
                 (q3, 850, 650, E'Standard \u2014 Non-veg')) x(id, old_price, price, pkg)
   where q.org_id = M and q.id = x.id and jsonb_typeof(q.pricing) = 'object'
     and q.pricing ->> 'platePrice' = x.old_price::text and (q.pricing ->> '_packageName') is null
     and q.lifecycle_stage is distinct from 'closed';

  -- the wedding's simulated money follows its new total (still on the 0168 shape only)
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end
    into t1 from public.quotes q where q.id = q1 and q.org_id = M and q.pricing ->> '_packageName' = E'Gold \u2014 Non-veg';
  a1 := round(coalesce(t1, 0) * 0.3);
  if a1 > 0 and exists (select 1 from public.payment_milestones pm where pm.org_id = M and pm.quote_id = q1 and pm.seq = 2 and pm.label = 'Balance (70%)')
     and exists (select 1 from public.payment_milestones pm where pm.org_id = M and pm.quote_id = q1 and pm.seq = 1 and pm.label = 'Advance (30%)') then
    update public.payment_milestones set amount = a1 where org_id = M and quote_id = q1 and seq = 1 and label = 'Advance (30%)' and amount <> a1;
    update public.payment_milestones set amount = t1 - a1 where org_id = M and quote_id = q1 and seq = 2 and label = 'Balance (70%)' and amount <> t1 - a1;
    update public.quote_payments set amount = a1 where org_id = M and quote_id = q1 and receipt_no = 'SMP-R-0001' and simulated and amount <> a1;
  end if;

  -- 4) vendors: + the owner's 7 + fireworks (added once by name; the v1 vendors stay)
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo)
  select M, D || x.n, x.c, x.k, x.p, x.e, x.note, true, true
    from (values
      ('AV Solutions', 'Audio Visual', 'rental', '+91 00000 00211', 'demo.av@example.com', 'Sample vendor. PA, mics, projectors and LED walls for conferences and galas.'),
      ('Furniture Rentals', 'Furniture & Seating', 'rental', '+91 00000 00212', 'demo.furniture@example.com', 'Sample vendor. Conference chairs, round tables, lounge seating.'),
      ('Stage and Fabrication', 'Stage & Backdrop', 'vendor', '+91 00000 00213', 'demo.stage@example.com', 'Sample vendor. Stage platforms, backdrops, branded fabrication.'),
      ('LED and Lighting', 'LED & Lighting', 'rental', '+91 00000 00214', 'demo.led@example.com', 'Sample vendor. LED screens, par lights, trusses, moving heads.'),
      ('Corporate Catering', 'Catering', 'vendor', '+91 00000 00215', 'demo.corpcatering@example.com', 'Sample vendor. Corporate lunch buffets, hi-tea and snack boxes.'),
      ('Event Logistics', 'Logistics & Setup', 'vendor', '+91 00000 00216', 'demo.logistics@example.com', 'Sample vendor. Trucks, loading crew, setup and teardown.'),
      ('Print and Branding', 'Printing & Branding', 'vendor', '+91 00000 00217', 'demo.print@example.com', 'Sample vendor. Flex, standees, badges, branded backdrops.'),
      ('Sky Fireworks & Cold Pyro', 'Fireworks', 'vendor', '+91 00000 00218', 'demo.fireworks@example.com',
       'Sample vendor. Cold pyro, sparklers and licensed fireworks. Check the venue rules first: several sample venues do not allow fireworks or open flame.')
    ) x(n, c, k, p, e, note)
   where not exists (select 1 from public.vendors y where y.org_id = M and lower(btrim(y.name)) = lower(btrim(D || x.n)));

  -- 5) inventory: v1 duplicates take the owner's values (same row; only while still on the 0167 values)
  for v in select * from (values
    ('LED par light', 48, 600, 'LED Par Light', 'Lighting', 20, 950),
    ('Cordless microphone', 10, 800, 'Wireless Microphone', 'Audio', 6, 1800),
    ('Round table 6 ft', 80, 300, 'Round Table', 'Furniture', 30, 500)
  ) x(old_name, old_qty, old_rate, new_name, cat, qty, rate) loop
    update public.inventory_items i set name = D || v.new_name, category = v.cat, total_qty = v.qty, unit_cost = v.rate, unit = 'pcs'
     where i.org_id = M and i.name = D || v.old_name and i.total_qty = v.old_qty and i.unit_cost = v.old_rate
       and not exists (select 1 from public.inventory_items y where y.org_id = M and lower(btrim(y.name)) = lower(btrim(D || v.new_name)) and y.id <> i.id);
    -- the sample wedding never reserves more than the new stock
    update public.inventory_reservations r set qty = v.qty
      from public.inventory_items i
     where r.org_id = M and r.item_id = i.id and i.org_id = M and i.name = D || v.new_name and r.qty > v.qty and r.quote_id = q1;
  end loop;

  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, attributes, is_demo)
  select M, D || x.n, x.c, x.q, x.u, x.p, x.r, 'Sample item.', true, jsonb_build_object('replacement_cost', x.rc), true
    from (values
      ('Conference Chair', 'Seating', 400, 'pcs', 'A', 10, 1800),
      ('Round Table', 'Furniture', 30, 'pcs', 'A', 500, 6500),
      ('Registration Desk', 'Registration', 4, 'pcs', 'B', 1600, 15000),
      ('Lectern / Podium', 'Stage Equipment', 1, 'pcs', 'B', 4500, 35000),
      ('Wireless Microphone', 'Audio', 6, 'pcs', 'A', 1800, 12000),
      ('PA Speaker', 'Audio', 8, 'pcs', 'A', 7000, 60000),
      ('LED Par Light', 'Lighting', 20, 'pcs', 'A', 950, 7000),
      ('LED Screen Panel', 'LED / Display', 120, 'sq ft', 'A', 180, 2500),
      ('Branded Backdrop Frame', 'Branding', 1, 'pcs', 'B', 8500, 60000),
      ('Power Extension Cable', 'Electrical', 18, 'pcs', 'C', 400, 1500)
    ) x(n, c, q, u, p, r, rc)
   where not exists (select 1 from public.inventory_items y where y.org_id = M and lower(btrim(y.name)) = lower(btrim(D || x.n)));

  -- 6) staff: + 2 corporate-event roles (crew records only - never login users)
  insert into public.crew_members(org_id, name, phone, email, department, role, skills, emp_type, day_rate, notes, active, is_demo)
  select M, D || x.n, x.p, x.e, x.dep, x.r, x.sk::jsonb, x.t, x.rate, 'Sample staff.', true, true
    from (values
      ('Nikhil Varma', '+91 00000 00111', 'demo.nikhil@example.com', 'Hospitality', 'Registration desk lead',
       '["registration","badges","guest list","walk-ins"]', 'part_time', 1800),
      ('Sai Teja', '+91 00000 00112', 'demo.saiteja@example.com', 'Technical', 'AV technician',
       '["sound","mics","projector","LED wall"]', 'full_time', 2800)
    ) x(n, p, e, dep, r, sk, t, rate)
   where not exists (select 1 from public.crew_members y where y.org_id = M and y.name = D || x.n);

  -- 7) the master's rows of these tables are sample rows
  update public.dish_catalog set is_demo = true where org_id = M and not is_demo;
  update public.menu_templates set is_demo = true where org_id = M and not is_demo;
  update public.vendors set is_demo = true where org_id = M and not is_demo;
  update public.inventory_items set is_demo = true where org_id = M and not is_demo;
  update public.crew_members set is_demo = true where org_id = M and not is_demo;

  update public.helm_sample_template
     set notes = 'Sample dataset v4 (India): owner dishes, menus, vendors, inventory, staff (0170). Edit the master studio, then publish_sample_manifest(). Switch: active.',
         updated_at = now()
   where id and org_id = M and coalesce(notes, '') not like 'Sample dataset v4%';
end $$;

-- ---- 8) publish v4 once ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001' and o.is_sample_master)
     and exists (select 1 from public.quotes x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid)
     and not exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'v4: owner menus, dishes, vendors, inventory') then
    perform public.publish_sample_manifest('v4: owner menus, dishes, vendors, inventory');
  end if;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 manifest v4 current', exists (select 1 from public.helm_trial_seed_manifest where is_current and notes = 'v4: owner menus, dishes, vendors, inventory')),
  ('02 145 owner dishes, no Demo prefix', (select count(*) from public.dish_catalog where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 145
       and not exists (select 1 from public.dish_catalog where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and name like 'Demo%')),
  ('03 6 owner packages + prices', (select string_agg(price_per_plate::int::text, ',' order by seq) from public.menu_templates where org_id = 'a5a5a5a5-0166-4000-8000-000000000001'
       and name like E'% \u2014 %') = '450,700,1000,650,950,1400'),
  ('04 every package dish is in the catalog', not exists (select 1 from public.menu_templates t, jsonb_array_elements(t.dishes) e where t.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'
       and not exists (select 1 from public.dish_catalog d where d.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and d.name = e ->> 'n' and d.category = e ->> 'c'))),
  ('05 sample events on packages (950 / 1000 / 650), closed one untouched', (select string_agg(pricing ->> 'platePrice', ',' order by code) from public.quotes
       where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = '950,950,1000,650'),
  ('06 wedding milestones sum to its total', (select sum(amount) from public.payment_milestones where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a1')
       = (select (pricing ->> 'total')::numeric from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a1')),
  ('07 16 vendors incl. fireworks', (select count(*) from public.vendors where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 16
       and exists (select 1 from public.vendors where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and category = 'Fireworks')),
  ('08 47 inventory items, reservations within stock', (select count(*) from public.inventory_items where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 47
       and not exists (select 1 from public.inventory_reservations r join public.inventory_items i on i.id = r.item_id where r.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and r.qty > i.total_qty)),
  ('09 12 staff', (select count(*) from public.crew_members where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 12),
  ('10 v4 snapshot counts', exists (select 1 from public.helm_trial_seed_manifest where is_current and (counts ->> 'dish_catalog')::int = 145
       and (counts ->> 'vendors')::int = 16 and (counts ->> 'inventory_items')::int = 47 and (counts ->> 'crew_members')::int = 12))
) v(item, ok) order by item;
