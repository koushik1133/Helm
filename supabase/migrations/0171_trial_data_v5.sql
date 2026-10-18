-- ============================================================================
-- 0171_trial_data_v5.sql - CANONICAL forward-only. Free-trial sample data v5: the owner's full
-- rental price list (142 builder products) as sample inventory, owner rates in the master's item
-- price list (rate cards), + 8 sample leads and + 3 sample events (2 confirmed, 1 quoted) so a new
-- trial looks lived-in; every new trial studio gets them.
-- REQUIRES 0166 + 0167 + 0168 + 0169 + 0170 (sample master, manifest, clone wrappers, publish, v4).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md.
--
-- In plain words:
--   1  Inventory: the owner's price list (rental rate per unit per event; owner rates override the
--      builder defaults). 18 owner products already had a sample row; those rows are updated IN
--      PLACE (same id, only while they still carry their 0167 / 0170 values) to the owner's rate
--      and stock: Lectern + Podium -> "Lectern / Podium", Reg Desk -> "Registration Desk", LED Wall,
--      Generator (125 kVA, without diesel), Chandelier, Uplight, Line Array (per cabinet), Moving
--      Light, Floral Arch, Flower Wall, Decor Mandap, Carpet / Aisle, Air Cooler / Fan, Cocktail
--      Table, Rectangular Table, Lounge Set, Flower Urli; Round Table already matched (500).
--      The other 118 are added once by name. Items with no owner qty get a sensible stock (Chair
--      (single) 400, Banquet / Rectangular table 40, Round table 30, Decor item 50, Rangoli 10,
--      Dancers 2 groups). The 5 zero-rate layout zones (Chair Row, Seating Block, Parking Zone,
--      Exit Zone, Ambulance Bay) are not stock and are not added. Size / unit notes are in notes.
--   2  Item price list (rate cards) of the master, only where a leaf still has the 0086 default:
--      generator base 0 + 40 / kVA / day (= Rs 5,000 for 125 kVA, diesel extra), chandelier
--      medium 4,000, moving head 1,800, uplighter 300, DJ console 5,000, chocolate fountain small
--      4,000. public/builder.js defaults are NOT changed.
--   3  Leads: + 8 (won / quoted / qualified (= contacted) / discovery / new / lost) across sangeet,
--      product launch, housewarming, haldi, birthday, conference, college fest, wedding.
--   4  Events: + Kapoor Family Sangeet (confirmed, Gold - Vegetarian 700), Zenith Mobiles Product
--      Launch (confirmed, Standard - Non-veg 650), Lakshmi Housewarming (quote, Standard -
--      Vegetarian 450). GST 18 % intra-state; D8 prices the totals; the 2 confirmed events have a
--      simulated 30 % advance (paid, no money moves) + 70 % balance, and inventory reservations
--      within stock. Dates are relative to the sample anchor date (shifted at clone).
--   5  Dummy contacts only: demo.*@example.com, +91 00000 003xx (reserved, not dialable). Nothing is
--      sent: the master is a sample studio, so every outbox row is queued as skipped (0166).
--   6  Manifest v5 is published once. Only NEW trials get it. Roll back: set_current_sample_manifest(4).
--
-- ZERO DATA LOSS: every row written or changed here belongs to the sample master studio (fixed id
-- a5a5a5a5-0166-4000-8000-000000000001). No other studio's row is touched. Nothing is deleted.
-- Matching is on the 0167-0170 values, so owner edits made in the app are never overwritten.
-- ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null or to_regprocedure('public._demo_clear__pre0169(uuid)') is null
     or to_regclass('public.helm_trial_seed_manifest') is null or to_regprocedure('public.publish_sample_manifest(text)') is null then
    raise exception '0171 needs 0166 + 0167 + 0168 + 0169 + 0170 first'; end if;
end $$;

do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q5 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b5';
  q6 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b6';
  q7 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b7';
  D constant text := E'Demo \u00b7 ';
  v record; d0 date; t numeric; a numeric;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  select coalesce(anchor_date, current_date) into d0 from public.helm_sample_template where id;
  d0 := coalesce(d0, current_date);

  -- 1a) inventory: owner products that already have a sample row take the owner's values (same row,
  --     only while it still carries its 0167 / 0170 values)
  for v in select * from (values
    ('Lectern / Podium', 1, 4500, 'Lectern / Podium', 2, 1500, 'Owner rate per lectern / podium.'),
    ('Registration Desk', 4, 1600, 'Registration Desk', 4, 800, 'Owner rate (Reg Desk).'),
    ('LED wall panel (0.5x0.5 m)', 64, 450, 'LED Wall', 4, 5000, '8x6 ft.'),
    ('Generator 125 kVA', 2, 18000, 'Generator', 2, 5000, '125 kVA, without diesel.'),
    ('Crystal chandelier', 6, 8000, 'Chandelier', 6, 4000, null),
    ('Uplighter (battery)', 40, 500, 'Uplight', 40, 300, null),
    ('Line array speaker', 8, 4000, 'Line Array', 4, 3500, 'Per cabinet.'),
    ('Moving head light', 12, 2500, 'Moving Light', 12, 1800, null),
    ('Entrance arch (floral)', 2, 9000, 'Floral Arch', 2, 9000, null),
    ('Artificial flower wall 8x8 ft', 4, 7000, 'Flower Wall', 2, 8000, null),
    ('Floral mandap set', 2, 45000, 'Decor Mandap', 1, 50000, null),
    ('Red carpet (30 m roll)', 4, 2500, 'Carpet / Aisle', 6, 2500, null),
    ('Air cooler (industrial)', 20, 1500, 'Air Cooler / Fan', 20, 800, null),
    ('Cocktail table (high)', 30, 250, 'Cocktail Table', 30, 350, null),
    ('Rectangular table 6x2.5 ft', 60, 200, 'Rectangular Table', 60, 400, null),
    ('Lounge sofa set (3 pc)', 10, 3500, 'Lounge Set', 6, 4500, null),
    ('Brass urli with floating candles', 20, 800, 'Flower Urli', 10, 1200, null)
  ) x(old_name, old_qty, old_rate, new_name, qty, rate, note) loop
    update public.inventory_items i set name = D || v.new_name, total_qty = v.qty, unit_cost = v.rate,
           notes = 'Sample item. Owner rental rate per unit per event.' || coalesce(' ' || v.note, '')
     where i.org_id = M and i.name = D || v.old_name and i.total_qty = v.old_qty and i.unit_cost = v.old_rate
       and not exists (select 1 from public.inventory_items y where y.org_id = M and lower(btrim(y.name)) = lower(btrim(D || v.new_name)) and y.id <> i.id)
       and not exists (select 1 from public.inventory_reservations r where r.org_id = M and r.item_id = i.id and r.qty > v.qty);
  end loop;

  -- 1b) the rest of the owner's price list, added once by name (the merged names above are never re-added)
  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, attributes, is_demo)
  select M, D || x.n, x.c, x.q, 'pcs', case when x.r >= 5000 then 'A' when x.r >= 1000 then 'B' else 'C' end, x.r, x.note, true,
         jsonb_build_object('replacement_cost', x.rc), true
    from (values
      ('Main Stage', 'Stage & Structure', 2, 18000, 'Sample item. Owner rental rate per unit per event.', 180000),
      ('Dance Floor', 'Stage & Structure', 2, 15000, 'Sample item. Owner rental rate per unit per event.', 150000),
      ('Canopy', 'Stage & Structure', 2, 2000, 'Sample item. Owner rental rate per unit per event.', 20000),
      ('Arch / Backdrop', 'Stage & Structure', 4, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('Tent', 'Stage & Structure', 2, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Truss Tower', 'Stage & Structure', 8, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Greenery', 'Stage & Structure', 40, 250, 'Sample item. Owner rental rate per unit per event.', 2500),
      ('Carpet / Aisle', 'Stage & Structure', 6, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('VIP Riser', 'Stage & Structure', 2, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('Walkway / Ramp', 'Stage & Structure', 4, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Entrance Gate', 'Stage & Structure', 2, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Dais with Chairs', 'Stage & Structure', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Banner / Hoarding Frame', 'Stage & Structure', 4, 3000, 'Sample item. Owner rental rate per unit per event.', 30000),
      ('Stage Roof Truss', 'Stage & Structure', 1, 35000, 'Sample item. Owner rental rate per unit per event.', 350000),
      ('Varmala Platform', 'Stage & Structure', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Podium', 'Sound, Light & AV', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Press Riser', 'Sound, Light & AV', 1, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('DJ Booth', 'Sound, Light & AV', 2, 5000, 'Sample item. Owner rental rate per unit per event.', 50000),
      ('Photo Booth', 'Sound, Light & AV', 2, 10000, 'Sample item. Owner rental rate per unit per event.', 100000),
      ('LED Screen', 'Sound, Light & AV', 2, 8000, 'Sample item. Owner rental rate per unit per event. 10x8 ft.', 80000),
      ('Speaker Stack', 'Sound, Light & AV', 8, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Uplight', 'Sound, Light & AV', 40, 300, 'Sample item. Owner rental rate per unit per event.', 3000),
      ('Grand Piano', 'Sound, Light & AV', 1, 25000, 'Sample item. Owner rental rate per unit per event.', 250000),
      ('Line Array', 'Sound, Light & AV', 4, 3500, 'Sample item. Owner rental rate per unit per event. Per cabinet.', 35000),
      ('Subwoofer', 'Sound, Light & AV', 4, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Stage Monitor', 'Sound, Light & AV', 6, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('FOH Console', 'Sound, Light & AV', 2, 7000, 'Sample item. Owner rental rate per unit per event.', 70000),
      ('Moving Light', 'Sound, Light & AV', 12, 1800, 'Sample item. Owner rental rate per unit per event.', 18000),
      ('LED Video Wall', 'Sound, Light & AV', 1, 25000, 'Sample item. Owner rental rate per unit per event. 20x12 ft.', 250000),
      ('Lighting Truss', 'Sound, Light & AV', 6, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('LED Wall', 'Sound, Light & AV', 4, 5000, 'Sample item. Owner rental rate per unit per event. 8x6 ft.', 50000),
      ('Smoke Machine', 'Sound, Light & AV', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Dancers', 'Sound, Light & AV', 2, 12000, 'Sample item. Owner rental rate per unit per event. Per group performance.', 120000),
      ('Lectern', 'Sound, Light & AV', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('PA Tower', 'Sound, Light & AV', 4, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Lighting Tree (T-Bar)', 'Sound, Light & AV', 8, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Mic Stand', 'Sound, Light & AV', 10, 150, 'Sample item. Owner rental rate per unit per event.', 1500),
      ('Teleprompter', 'Sound, Light & AV', 1, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Projector Screen', 'Sound, Light & AV', 2, 2000, 'Sample item. Owner rental rate per unit per event.', 20000),
      ('TV Screen on Stand', 'Sound, Light & AV', 4, 4500, 'Sample item. Owner rental rate per unit per event.', 45000),
      ('Interpreter Booth', 'Sound, Light & AV', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Cold Pyro / CO2 Jet', 'Sound, Light & AV', 8, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Round Table', 'Seating & Furniture', 30, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Banquet Table', 'Seating & Furniture', 40, 400, 'Sample item. Owner rental rate per unit per event.', 4000),
      ('Head Table', 'Seating & Furniture', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Cocktail Table', 'Seating & Furniture', 30, 350, 'Sample item. Owner rental rate per unit per event.', 3500),
      ('Lounge Set', 'Seating & Furniture', 6, 4500, 'Sample item. Owner rental rate per unit per event.', 45000),
      ('Sofa', 'Seating & Furniture', 20, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('Loveseat', 'Seating & Furniture', 6, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Armchair', 'Seating & Furniture', 20, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Ottoman', 'Seating & Furniture', 20, 200, 'Sample item. Owner rental rate per unit per event.', 2000),
      ('Bench', 'Seating & Furniture', 20, 350, 'Sample item. Owner rental rate per unit per event.', 3500),
      ('Coffee Table', 'Seating & Furniture', 10, 400, 'Sample item. Owner rental rate per unit per event.', 4000),
      ('Chair (single)', 'Seating & Furniture', 400, 100, 'Sample item. Owner rental rate per unit per event.', 1000),
      ('Bar Stool', 'Seating & Furniture', 20, 300, 'Sample item. Owner rental rate per unit per event.', 3000),
      ('Bleachers', 'Seating & Furniture', 2, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Couple Sofa', 'Seating & Furniture', 2, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Rectangular Table', 'Seating & Furniture', 40, 400, 'Sample item. Owner rental rate per unit per event.', 4000),
      ('Floor Seating (Gaddi)', 'Seating & Furniture', 10, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Barricade', 'Security & Barriers', 40, 150, 'Sample item. Owner rental rate per unit per event.', 1500),
      ('Fence Line', 'Security & Barriers', 40, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Checkpoint', 'Security & Barriers', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Stage Barrier', 'Security & Barriers', 4, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Stanchions', 'Security & Barriers', 20, 250, 'Sample item. Owner rental rate per unit per event.', 2500),
      ('Watch Tower / CCTV', 'Security & Barriers', 2, 6500, 'Sample item. Owner rental rate per unit per event.', 65000),
      ('Expo Booth', 'Logistics & Utilities', 10, 6500, 'Sample item. Owner rental rate per unit per event.', 65000),
      ('Reg Desk', 'Logistics & Utilities', 4, 800, 'Sample item. Owner rental rate per unit per event.', 8000),
      ('Food Truck', 'Logistics & Utilities', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Bar', 'Logistics & Utilities', 2, 5000, 'Sample item. Owner rental rate per unit per event.', 50000),
      ('Buffet Line', 'Logistics & Utilities', 6, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Gift Table', 'Logistics & Utilities', 2, 350, 'Sample item. Owner rental rate per unit per event.', 3500),
      ('Cake Table', 'Logistics & Utilities', 2, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Restrooms', 'Logistics & Utilities', 2, 8000, 'Sample item. Owner rental rate per unit per event.', 80000),
      ('Coat Check', 'Logistics & Utilities', 1, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Patio Heater', 'Logistics & Utilities', 6, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Signage Easel', 'Logistics & Utilities', 10, 250, 'Sample item. Owner rental rate per unit per event.', 2500),
      ('Generator', 'Logistics & Utilities', 2, 5000, 'Sample item. Owner rental rate per unit per event. 125 kVA, without diesel.', 50000),
      ('Power Distro', 'Logistics & Utilities', 4, 2000, 'Sample item. Owner rental rate per unit per event.', 20000),
      ('Cable Ramp', 'Logistics & Utilities', 20, 300, 'Sample item. Owner rental rate per unit per event.', 3000),
      ('Green Room', 'Logistics & Utilities', 2, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('Chocolate Fountain', 'Logistics & Utilities', 2, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Live Food Counter', 'Logistics & Utilities', 4, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Kids Zone', 'Logistics & Utilities', 1, 10000, 'Sample item. Owner rental rate per unit per event.', 100000),
      ('Air Cooler / Fan', 'Logistics & Utilities', 20, 800, 'Sample item. Owner rental rate per unit per event.', 8000),
      ('Trophy Display', 'Logistics & Utilities', 2, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('Signage / Standee', 'Logistics & Utilities', 10, 700, 'Sample item. Owner rental rate per unit per event.', 7000),
      ('Mobile Light Tower', 'Logistics & Utilities', 4, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Shoe Rack', 'Logistics & Utilities', 6, 350, 'Sample item. Owner rental rate per unit per event.', 3500),
      ('Dessert / Candy Table', 'Logistics & Utilities', 2, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Coffee / Tea Station', 'Logistics & Utilities', 4, 1800, 'Sample item. Owner rental rate per unit per event.', 18000),
      ('Food / Merch Stall', 'Logistics & Utilities', 6, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Display Counter', 'Logistics & Utilities', 4, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Check-in Kiosk', 'Logistics & Utilities', 2, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Ticket Booth', 'Logistics & Utilities', 2, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('First Aid', 'Safety', 2, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Fire Point', 'Safety', 10, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Floral Centerpiece', 'Decor', 40, 900, 'Sample item. Owner rental rate per unit per event.', 9000),
      ('Floral Arch', 'Decor', 2, 9000, 'Sample item. Owner rental rate per unit per event.', 90000),
      ('Decor Mandap', 'Decor', 1, 50000, 'Sample item. Owner rental rate per unit per event.', 500000),
      ('Decor Pillar', 'Decor', 12, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Pipe & Drape', 'Decor', 20, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('Chandelier', 'Decor', 6, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Fountain', 'Decor', 1, 8000, 'Sample item. Owner rental rate per unit per event.', 80000),
      ('Wedding Chariot', 'Decor', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Branding Wall', 'Decor', 2, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('Phoolon ki Chadar', 'Decor', 2, 4000, 'Sample item. Owner rental rate per unit per event.', 40000),
      ('Swing / Jhoola', 'Decor', 2, 7000, 'Sample item. Owner rental rate per unit per event.', 70000),
      ('Haldi Setup', 'Decor', 1, 9000, 'Sample item. Owner rental rate per unit per event.', 90000),
      ('Mehendi Lounge', 'Decor', 1, 9000, 'Sample item. Owner rental rate per unit per event.', 90000),
      ('Selfie Frame', 'Decor', 2, 2000, 'Sample item. Owner rental rate per unit per event.', 20000),
      ('Welcome Board', 'Decor', 4, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Fairy Light Canopy', 'Decor', 2, 6000, 'Sample item. Owner rental rate per unit per event.', 60000),
      ('Entrance Floral Arch', 'Decor', 1, 16000, 'Sample item. Owner rental rate per unit per event.', 160000),
      ('Stage Floral Backdrop', 'Decor', 1, 22000, 'Sample item. Owner rental rate per unit per event.', 220000),
      ('Flower Wall', 'Decor', 2, 8000, 'Sample item. Owner rental rate per unit per event.', 80000),
      ('Garland Toran', 'Decor', 6, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Floral Pillar', 'Decor', 8, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Aisle Floral Stand', 'Decor', 20, 1000, 'Sample item. Owner rental rate per unit per event.', 10000),
      ('Tall Centrepiece', 'Decor', 20, 1800, 'Sample item. Owner rental rate per unit per event.', 18000),
      ('Balloon Arch', 'Decor', 2, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Balloon Bouquet', 'Decor', 20, 400, 'Sample item. Owner rental rate per unit per event.', 4000),
      ('Flag Stand', 'Decor', 6, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Brass Deepam Stand', 'Decor', 4, 800, 'Sample item. Owner rental rate per unit per event.', 8000),
      ('Havan Kund', 'Decor', 1, 1500, 'Sample item. Owner rental rate per unit per event.', 15000),
      ('Rangoli / Kolam', 'Decor', 10, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('Lantern Cluster', 'Decor', 10, 800, 'Sample item. Owner rental rate per unit per event.', 8000),
      ('Hanging Floral Ceiling', 'Decor', 1, 12000, 'Sample item. Owner rental rate per unit per event.', 120000),
      ('Neon Sign Wall', 'Decor', 2, 3000, 'Sample item. Owner rental rate per unit per event.', 30000),
      ('Backdrop (generic)', 'Decor', 4, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Floral Stand', 'Decor', 10, 900, 'Sample item. Owner rental rate per unit per event.', 9000),
      ('Decor Item', 'Decor', 50, 500, 'Sample item. Owner rental rate per unit per event.', 5000),
      ('Flower Urli', 'Decor', 10, 1200, 'Sample item. Owner rental rate per unit per event.', 12000),
      ('Decor Umbrellas', 'Decor', 6, 2500, 'Sample item. Owner rental rate per unit per event.', 25000),
      ('Doli / Palki', 'Decor', 1, 7000, 'Sample item. Owner rental rate per unit per event.', 70000),
      ('Kalash', 'Decor', 10, 250, 'Sample item. Owner rental rate per unit per event.', 2500),
      ('Pooja Altar', 'Decor', 1, 3500, 'Sample item. Owner rental rate per unit per event.', 35000),
      ('Display Plinth', 'Decor', 6, 500, 'Sample item. Owner rental rate per unit per event.', 5000)
    ) x(n, c, q, r, note, rc)
   where x.n <> all (array['Lectern', 'Podium', 'Reg Desk', 'Round Table', 'LED Wall', 'Generator', 'Chandelier', 'Uplight', 'Line Array',
                           'Moving Light', 'Floral Arch', 'Flower Wall', 'Decor Mandap', 'Carpet / Aisle', 'Air Cooler / Fan',
                           'Cocktail Table', 'Rectangular Table', 'Lounge Set', 'Flower Urli'])
     and not exists (select 1 from public.inventory_items y where y.org_id = M and lower(btrim(y.name)) = lower(btrim(D || x.n)));

  -- 2) the master's item price list takes the owner's rates (only leaves still on the 0086 default)
  for v in select * from (values
    ('generator', '{base}', 2000, 0), ('generator', '{perKvaDay}', 60, 40),
    ('chandelier', '{each,medium}', 6000, 4000),
    ('lighting', '{each,moving_head}', 2500, 1800), ('lighting', '{each,uplighter}', 500, 300),
    ('dj', '{setup,console}', 15000, 5000),
    ('chocolatefountain', '{base,small}', 6000, 4000)
  ) x(it, path, old_v, new_v) loop
    update public.item_rate_cards c set rates = jsonb_set(c.rates, v.path::text[], to_jsonb(v.new_v))
     where c.org_id = M and c.item_type = v.it and jsonb_typeof(c.rates #> v.path::text[]) = 'number'
       and (c.rates #>> v.path::text[])::numeric = v.old_v;
  end loop;

  -- 3) leads (+8; added once by e-mail). "qualified" is the app's "contacted" stage.
  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status)
  select M, D || x.n, x.p, x.e, x.src, x.et, d0 + x.dd, x.b, x.g, x.note, x.st
    from (values
      ('Kapoor Family', '+91 00000 00311', 'demo.kapoor@example.com', 'Instagram', 'Sangeet', 18, 700000, 300, 'Sample lead. Booked: sangeet night, advance paid.', 'won'),
      ('Zenith Mobiles', '+91 00000 00312', 'demo.zenith@example.com', 'Website', 'Product launch', 35, 900000, 200, 'Sample lead. Booked: phone launch with press.', 'won'),
      ('Lakshmi Prasad', '+91 00000 00313', 'demo.lakshmi@example.com', 'Referral', 'Housewarming', 25, 250000, 150, 'Sample lead. Gruhapravesam; quote drafted.', 'quoted'),
      ('Sravani & Family', '+91 00000 00314', 'demo.sravani@example.com', 'WhatsApp', 'Haldi', 28, 300000, 120, 'Sample lead. Called back; wants a marigold haldi setup.', 'qualified'),
      ('Aarav''s 5th Birthday', '+91 00000 00315', 'demo.aarav@example.com', 'Google', 'Birthday', 45, 200000, 80, 'Sample lead. Just enquired: kids zone + magic show.', 'new'),
      ('Infosphere Tech Summit', '+91 00000 00316', 'demo.infosphere@example.com', 'LinkedIn', 'Conference', 55, 1500000, 400, 'Sample lead. Contacted; needs theatre seating and interpreter booth.', 'qualified'),
      ('Vasavi College Fest', '+91 00000 00317', 'demo.vasavi@example.com', 'Walk-in', 'College fest', 60, 600000, 800, 'Sample lead. Site visit planned; stage, line array, food stalls.', 'discovery'),
      ('Rahul & Divya', '+91 00000 00318', 'demo.rahuldivya@example.com', 'Referral', 'Wedding', -20, 1800000, 500, 'Sample lead. Went with the venue in-house team.', 'lost')
    ) x(n, p, e, src, et, dd, b, g, note, st)
   where not exists (select 1 from public.leads y where y.org_id = M and lower(y.email) = lower(x.e));

  -- 4) events (+3; the quote row IS the event; D8 prices the totals). Added once by id.
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, currency)
  select x.id, M, x.code, D || x.title, x.et, x.st, x.ap, x.lc, d0 + x.dd, x.tm,
         jsonb_build_object('name', D || x.cn, 'phone', x.cp, 'email', x.ce, 'city', 'Hyderabad', 'venue', D || x.venue),
         jsonb_build_object('guests', x.g, 'platePrice', x.pp, '_packageName', x.pkg, 'chairs', x.g, 'chairPrice', x.chp, 'other', x.oth,
                            'discount', 0, 'gstPct', 18, 'placeOfSupply', 'intra', 'currency', 'INR', 'taxCountry', 'IN'),
         case when x.st = 'confirmed' then now() - make_interval(days => x.conf) end, 'INR'
    from (values
      (q5, 'SMP-1004', 'Kapoor Family Sangeet', 'Sangeet', 'confirmed', 'paid', 'planning', 18, '19:00'::time, 'Kapoor Family', '+91 00000 00311',
       'demo.kapoor@example.com', 'Green Meadows Lawn', 300, 700, E'Gold \u2014 Vegetarian', 45, 160000, 6),
      (q6, 'SMP-1005', 'Zenith Mobiles Product Launch', 'Product launch', 'confirmed', 'paid', 'planning', 35, '11:00'::time, 'Zenith Mobiles', '+91 00000 00312',
       'demo.zenith@example.com', 'Grand Convention Centre, Hitec City', 200, 650, E'Standard \u2014 Non-veg', 25, 210000, 4),
      (q7, 'SMP-1006', 'Lakshmi Housewarming', 'Housewarming', 'quote', 'none', 'quote', 25, '10:30'::time, 'Lakshmi Prasad', '+91 00000 00313',
       'demo.lakshmi@example.com', 'Square Garden Pavilion, Gachibowli', 150, 450, E'Standard \u2014 Vegetarian', 25, 45000, 0)
    ) x(id, code, title, et, st, ap, lc, dd, tm, cn, cp, ce, venue, g, pp, pkg, chp, oth, conf)
   where not exists (select 1 from public.quotes y where y.id = x.id)
     and not exists (select 1 from public.quotes y where y.org_id = M and y.code = x.code);

  -- money for the 2 confirmed events: 30 % advance (simulated, paid) + 70 % balance; once per event
  for v in select * from (values (q5, 18, 6, 'SMP-R-0004', 'upi'), (q6, 35, 4, 'SMP-R-0005', 'bank_transfer')) x(q, dd, conf, rc, meth) loop
    if exists (select 1 from public.quotes q where q.id = v.q and q.org_id = M)
       and not exists (select 1 from public.payment_milestones pm where pm.quote_id = v.q) then
      select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end
        into t from public.quotes q where q.id = v.q and q.org_id = M;
      a := round(coalesce(t, 0) * 0.3);
      if a > 0 then
        insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq) values
          (v.q, M, 'Advance (30%)', d0 - v.conf, a, 'paid', now() - make_interval(days => v.conf), 'Sample milestone - no money moves.', 1),
          (v.q, M, 'Balance (70%)', d0 + v.dd - 3, t - a, 'due', null, 'Sample milestone - no money moves.', 2);
        insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note)
        values (v.q, M, case when v.meth = 'upi' then 'upi' else 'bank' end, a, 'INR', 'paid', true, now() - make_interval(days => v.conf), v.meth, v.rc,
                'Sample payment - simulated, no money moved.');
      end if;
    end if;
  end loop;

  -- inventory reserved for the 2 confirmed events (once per event; never above stock)
  insert into public.inventory_reservations(item_id, quote_id, org_id, qty, status, note)
  select i.id, x.q, M, least(x.qty, i.total_qty), 'reserved', 'Sample reservation.'
    from (values
      (q5, 'Chair (single)', 300), (q5, 'Banquet Table', 30), (q5, 'Dance Floor', 1), (q5, 'DJ Booth', 1), (q5, 'LED Wall', 2),
      (q5, 'Moving Light', 8), (q5, 'Fairy Light Canopy', 1), (q5, 'Generator', 1),
      (q6, 'Conference Chair', 200), (q6, 'LED Video Wall', 1), (q6, 'Lectern / Podium', 1), (q6, 'Line Array', 4),
      (q6, 'Press Riser', 1), (q6, 'Teleprompter', 1), (q6, 'Branding Wall', 1), (q6, 'Registration Desk', 2)
    ) x(q, n, qty)
    join public.inventory_items i on i.org_id = M and i.name = D || x.n
   where exists (select 1 from public.quotes q where q.id = x.q and q.org_id = M)
     and not exists (select 1 from public.inventory_reservations r where r.quote_id = x.q and r.item_id = i.id);

  update public.inventory_items set is_demo = true where org_id = M and not is_demo;

  update public.helm_sample_template
     set notes = 'Sample dataset v5 (India): owner price list, rate cards, more leads + events (0171). Edit the master studio, then publish_sample_manifest(). Switch: active.',
         updated_at = now()
   where id and org_id = M and coalesce(notes, '') not like 'Sample dataset v5%';
end $$;

-- ---- 5) publish v5 once ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001' and o.is_sample_master)
     and exists (select 1 from public.quotes x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid)
     and not exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'v5: owner price list, leads, events') then
    perform public.publish_sample_manifest('v5: owner price list, leads, events');
  end if;
end $$;
