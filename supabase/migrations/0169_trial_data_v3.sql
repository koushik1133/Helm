-- ============================================================================
-- 0169_trial_data_v3.sql - CANONICAL forward-only. Free-trial sample data v3: the owner's wedding
-- floor layout as a studio layout template (and as the sample wedding's floor plan), GST 18 %
-- (CGST 9 + SGST 9, intra-state Telangana), complete sample leads / events, 3 discount coupons,
-- run sheets on 3 events, sample terms & conditions; every new trial studio gets them.
-- REQUIRES 0166 + 0167 + 0168 (sample master, manifest, clone wrapper, _sample_studio_settings)
--          and 0096 (studio_layout_templates).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md.
--
-- In plain words:
--   1  Layout templates: the owner's wedding layout (71 objects, 200 x 140 ft) is saved in the
--      sample master's own layout templates ("Load a template" in the builder) as
--      "Demo . Wedding - Grand Lawn (450+ guests)", and becomes the floor plan (layout version 1)
--      of the sample wedding, whose venue moves to Green Meadows Lawn (the lawn it was drawn for).
--      Tidy-ups of the owner JSON: the DJ booth now sits squarely in front of the LED screen,
--      centred on it with the same rotation (150); the duplicate fence at x 160 and a carpet piece
--      running past the checkpoint are dropped; two overlapping carpet pieces are trimmed / moved
--      so the aisle runs end to end without overlap. Nothing else in the design changes.
--      TODO (owner JSONs pending): "Corporate" and "Corporate - round tables" templates. Adding one
--      is ONE new row in the values list of section 1 (name, event type, description, layout JSON).
--   2  GST: every sample event keeps gstPct 18 and is marked intra-state (placeOfSupply 'intra'), so
--      the quote shows CGST 9 % + SGST 9 %. The studio default tax is 18 % (pricing gstPct).
--   3  Sample leads carry full notes (requirement, venue, budget, guests, next step); the 3 open /
--      confirmed events carry the client's guests, budget, address, source and notes, plus a
--      discovery meeting record (date, mode, place, attendees, notes, budget range).
--   4  Coupons: DEMO-WELCOME10 (10 %), DEMO-FLAT5000 (Rs 5,000 off), DEMO-WEEKDAY15 (15 %, the note
--      says Mon-Thu events; the app does not enforce weekdays).
--   5  Run sheets: the sent engagement and the corporate event get one (the wedding keeps its 15 rows).
--   6  Terms & conditions (clearly sample) in the studio pricing config (termsText). The booklet
--      share box starts with them when its Terms field is empty.
--   7  The snapshot now also carries coupons, studio layout templates and discovery records, and the
--      studio settings carry gstPct / placeOfSupply / termsText. "Clear demo data" turns the sample
--      coupons off and archives the sample templates (never deletes them).
--   8  Manifest v3 is published once. Only NEW trials get it. Roll back: set_current_sample_manifest(2).
--
-- ZERO DATA LOSS: every row written or changed here belongs to the sample master studio (fixed id
-- a5a5a5a5-0166-4000-8000-000000000001); the clear wrapper only touches the ONE trial studio being
-- cleared and only its sample rows (DEMO- coupons, "Demo ." templates), turning them off / archiving.
-- Matching is on the 0167 / 0168 values, so owner edits made in the app are never overwritten.
-- ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null or to_regprocedure('public._sample_studio_settings(uuid)') is null
     or to_regclass('public.studio_layout_templates') is null or to_regclass('public.coupons') is null then
    raise exception '0169 needs 0096 + 0166 + 0167 + 0168 first'; end if;
end $$;

-- ---- 1-6) the owner's data in the sample master ---------------------------------------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q1 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a1';
  q2 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a2';
  q3 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a3';
  q4 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a4';
  D constant text := E'Demo \u00b7 ';
  WED constant text := E'Demo \u00b7 Wedding \u2014 Grand Lawn (450+ guests)';
  t record; v_wed jsonb; d0 date;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  select coalesce(anchor_date, current_date) into d0 from public.helm_sample_template where id;
  d0 := coalesce(d0, current_date);

  -- 1) layout templates of the master. ONE row per template.
  --    TODO (owner): add the Corporate + Corporate round-table layouts here as two more rows when their
  --    JSON arrives: (name, event_type, description, '<builder layout JSON>'::jsonb). Nothing else changes.
  for t in select * from (values
    (WED, 'wedding',
     'Sample template. Open-lawn wedding for 450+ guests on 200 x 140 ft: main stage with arch, dance floor, '
     || 'DJ booth in front of the LED screen, LED video wall, centre aisle, two seat blocks (20 x 25 + 16 x 25), '
     || '16 front-row sofas, 7 buffet lines, cake table, floral arches, fountain, restrooms, fence line.',
     '{"items":[
{"x":52,"y":26,"id":"obj_1omo","type":"dancefloor","color":"#2f6fed","label":"Dance Floor","width":20,"height":19,"category":"structure","rotation":0,"properties":{}},
{"x":92,"y":51,"id":"obj_2pe9","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":110,"y":46,"id":"obj_439d","type":"seatblock","color":"#0d9488","label":"Seating 20\u00d725","width":60,"height":48,"category":"seating","rotation":0,"properties":{"cols":25,"rows":20,"pitch":2.4}},
{"x":20,"y":56,"id":"obj_59gi","type":"seatblock","color":"#0d9488","label":"Seating 16\u00d725","width":60,"height":38.4,"category":"seating","rotation":0,"properties":{"cols":25,"rows":16,"pitch":2.4}},
{"x":56,"y":1,"id":"obj_6v6l","type":"stage","color":"#2f6fed","label":"Main Stage","width":76,"height":15,"category":"structure","rotation":0,"properties":{}},
{"x":89,"y":18,"id":"obj_b6on","type":"arch","color":"#2f6fed","label":"Arch / Backdrop","width":12,"height":1.5,"category":"structure","rotation":0,"properties":{}},
{"x":92,"y":21,"id":"obj_ccy4","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":92,"y":81,"id":"obj_djme","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":92,"y":111,"id":"obj_emvd","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":8,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":110,"y":101,"id":"obj_fscj","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":270,"properties":{},"colorCustom":false},
{"x":140,"y":101,"id":"obj_gz7v","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":270,"properties":{},"colorCustom":false},
{"x":170,"y":101,"id":"obj_h188","type":"redcarpet","color":"#e5484d","label":"Carpet / Aisle","width":6,"height":30,"category":"security","rotation":270,"properties":{},"colorCustom":false},
{"x":112,"y":40,"id":"obj_k4kq","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":119,"y":40,"id":"obj_ldjm","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":126,"y":40,"id":"obj_mgnj","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":133,"y":40,"id":"obj_niyb","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":140,"y":40,"id":"obj_ol5d","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":147,"y":40,"id":"obj_pni0","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":154,"y":40,"id":"obj_qpwy","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":161,"y":40,"id":"obj_rsan","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":23,"y":50,"id":"obj_s0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":30,"y":50,"id":"obj_t0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":37,"y":50,"id":"obj_u0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":44,"y":50,"id":"obj_v0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":51,"y":50,"id":"obj_w0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":58,"y":50,"id":"obj_x0a2","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":65,"y":50,"id":"obj_y0a3","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":72,"y":50,"id":"obj_z0a3","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":112,"y":36,"id":"obj_109hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":119,"y":36,"id":"obj_119hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":126,"y":36,"id":"obj_129hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":133,"y":36,"id":"obj_139hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":140,"y":36,"id":"obj_149hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":147,"y":36,"id":"obj_159hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":154,"y":36,"id":"obj_169hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":161,"y":36,"id":"obj_179hp","type":"sofa","color":"#0d9488","label":"Sofa","width":7,"height":3,"category":"seating","rotation":180,"properties":{}},
{"x":91,"y":9,"id":"obj_18v6y","type":"armchair","color":"#e5484d","label":"Armchair","width":3,"height":3,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":95,"y":9,"id":"obj_19zvm","type":"armchair","color":"#e5484d","label":"Armchair","width":3,"height":3,"category":"security","rotation":0,"properties":{},"colorCustom":false},
{"x":27.0,"y":26.0,"id":"obj_1b1xh","type":"dj","color":"#7c5cff","label":"DJ Booth","width":8,"height":5,"category":"av","rotation":150,"properties":{}},
{"x":19,"y":24,"id":"obj_1cdzc","type":"ledscreen","color":"#7c5cff","label":"LED Screen","width":20,"height":2,"category":"av","rotation":150,"properties":{}},
{"x":166,"y":9,"id":"obj_1d4fn","type":"videowall","color":"#7c5cff","label":"LED Video Wall","width":24,"height":14,"category":"av","rotation":30,"properties":{}},
{"x":160,"y":139,"id":"obj_1eu1s","type":"fence","color":"#e5484d","label":"Fence Line","width":40,"height":1,"category":"security","rotation":0,"properties":{}},
{"x":120,"y":139,"id":"obj_1fyrm","type":"fence","color":"#e5484d","label":"Fence Line","width":40,"height":1,"category":"security","rotation":0,"properties":{}},
{"x":80,"y":139,"id":"obj_1h5nu","type":"fence","color":"#e5484d","label":"Fence Line","width":40,"height":1,"category":"security","rotation":0,"properties":{}},
{"x":40,"y":139,"id":"obj_1iadh","type":"fence","color":"#e5484d","label":"Fence Line","width":40,"height":1,"category":"security","rotation":0,"properties":{}},
{"x":0,"y":139,"id":"obj_1jdux","type":"fence","color":"#e5484d","label":"Fence Line","width":40,"height":1,"category":"security","rotation":0,"properties":{}},
{"x":186,"y":115,"id":"obj_1kuue","type":"checkpoint","color":"#e5484d","label":"Checkpoint","width":6,"height":3,"category":"security","rotation":90,"properties":{}},
{"x":0,"y":0,"id":"obj_1leei","type":"restroom","color":"#e8912d","label":"Restrooms","width":12,"height":8,"category":"logistics","rotation":0,"properties":{}},
{"x":188,"y":132,"id":"obj_1mhas","type":"restroom","color":"#e8912d","label":"Restrooms","width":12,"height":8,"category":"logistics","rotation":0,"properties":{}},
{"x":10,"y":131,"id":"obj_1nmqz","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":30,"y":131,"id":"obj_1oq1w","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":50,"y":131,"id":"obj_1psqs","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":71,"y":131,"id":"obj_1quhm","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":91,"y":131,"id":"obj_1rx34","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":112,"y":132,"id":"obj_1szlv","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":0,"properties":{}},
{"x":0,"y":114,"id":"obj_1t4w2","type":"buffet","color":"#e8912d","label":"Buffet Line","width":18,"height":3,"category":"logistics","rotation":90,"properties":{}},
{"x":136,"y":131,"id":"obj_1ufkh","type":"caketable","color":"#e8912d","label":"Cake Table","width":4,"height":4,"category":"logistics","rotation":0,"properties":{}},
{"x":188,"y":102,"id":"obj_1wzb4","type":"exit","color":"#18a558","label":"Exit Zone","width":12,"height":6,"category":"safety","rotation":0,"properties":{}},
{"x":56,"y":17,"id":"obj_1x6dr","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":60,"y":17,"id":"obj_1ycc1","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":65,"y":17,"id":"obj_1zisi","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":69,"y":17,"id":"obj_20isi","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":114,"y":18,"id":"obj_25tth","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":118,"y":18,"id":"obj_26tti","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":123,"y":18,"id":"obj_27tti","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":127,"y":18,"id":"obj_28tti","type":"floral","color":"#d6549a","label":"Floral Centerpiece","width":2.5,"height":2.5,"category":"decor","rotation":0,"properties":{}},
{"x":161,"y":115,"id":"obj_29yze","type":"floralarch","color":"#d6549a","label":"Floral Arch","width":10,"height":2,"category":"decor","rotation":270,"properties":{}},
{"x":165,"y":115,"id":"obj_2a6pa","type":"floralarch","color":"#d6549a","label":"Floral Arch","width":10,"height":2,"category":"decor","rotation":270,"properties":{}},
{"x":168,"y":115,"id":"obj_2bb5q","type":"floralarch","color":"#d6549a","label":"Floral Arch","width":10,"height":2,"category":"decor","rotation":270,"properties":{}},
{"x":158,"y":115,"id":"obj_2cfk3","type":"floralarch","color":"#d6549a","label":"Floral Arch","width":10,"height":2,"category":"decor","rotation":270,"properties":{}},
{"x":84,"y":111,"id":"obj_2drx3","type":"fountain","color":"#d6549a","label":"Fountain","width":6,"height":6,"category":"decor","rotation":0,"properties":{}}
],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":450},"scale":{"pxPerFt":12,"worldFt":{"w":200,"h":140}}}'::jsonb)
  ) x(name, event_type, description, data) loop
    if not exists (select 1 from public.studio_layout_templates s where s.org_id = M and s.name = t.name) then
      insert into public.studio_layout_templates(org_id, name, event_type, description, data)
      values (M, t.name, t.event_type, t.description, t.data);
    end if;
  end loop;

  -- the wedding's floor plan = the template (only while version 1 is still the 0167 sample layout)
  select s.data into v_wed from public.studio_layout_templates s where s.org_id = M and s.name = WED;
  if v_wed is not null then
    update public.quote_versions set data = v_wed, object_count = jsonb_array_length(v_wed -> 'items'),
           label = 'Sample layout - Grand Lawn'
     where org_id = M and quote_id = q1 and version_no = 1 and data #>> '{items,0,id}' = 'smp-stage';
  end if;
  update public.quotes set client = jsonb_set(client, '{venue}', to_jsonb(D || 'Green Meadows Lawn'))
   where org_id = M and id = q1 and client ->> 'venue' = D || 'Royal Banquet Hall';

  -- 2) GST 18 % intra-state (CGST 9 + SGST 9) on every sample event; studio default 18 %
  update public.quotes set pricing = pricing || '{"gstPct":18,"placeOfSupply":"intra","taxCountry":"IN"}'::jsonb
   where org_id = M and id in (q1, q2, q3, q4) and jsonb_typeof(pricing) = 'object'
     and (pricing ->> 'placeOfSupply') is null and coalesce(pricing ->> 'gstPct', '18') = '18'
     and lifecycle_stage is distinct from 'closed';

  -- 6) + 2) studio pricing config: tax 18 % intra-state + sample terms (only keys still missing)
  insert into public.app_config(org_id, key, value)
  values (M, 'pricing', jsonb_build_object('gstPct', 18))
  on conflict (org_id, key) do nothing;
  update public.app_config c set value = jsonb_build_object(
      'gstPct', 18, 'placeOfSupply', 'intra', 'taxState', 'Telangana',
      'termsText',
      'SAMPLE TERMS AND CONDITIONS - edit these to your own before sending to a client.' || E'\n\n'
      || '1. Booking: a date is held only after the advance is received and this quotation is approved in writing.' || E'\n\n'
      || '2. Payment: 30% advance to confirm; the balance is due 3 days before the event. GST 18% (CGST 9% + SGST 9%) is extra unless shown as included.' || E'\n\n'
      || '3. Guest count: the final count is confirmed 7 days before the event; billing is on the confirmed count or the actual count, whichever is higher.' || E'\n\n'
      || '4. Cancellation and refund: more than 60 days before the event - advance refunded less 10% processing; 30 to 60 days - 50% of the advance refunded; under 30 days - the advance is not refundable. A date change is subject to availability.' || E'\n\n'
      || '5. Damages: loss of or damage to rented items, decor or the venue caused by guests is charged at replacement or repair cost.' || E'\n\n'
      || '6. Venue rules: the venue''s timings, sound curfew, fire safety and decor rules apply. Overtime is charged per hour.' || E'\n\n'
      || '7. Force majeure: neither party is liable for delays or cancellation caused by events beyond reasonable control (weather, government orders, strikes, epidemics); amounts paid are adjusted to a new date.' || E'\n\n'
      || '8. Sample text only - not legal advice.') || c.value
   where c.org_id = M and c.key = 'pricing'
     and not (c.value ? 'termsText' and c.value ? 'placeOfSupply' and c.value ? 'gstPct');

  -- 3) complete sample leads (only rows still on the 0167 / 0168 notes)
  update public.leads l set notes = x.n
    from (values
      ('demo.karthik@example.com', 'Sample lead. Just enquired. Reception for 400 guests, venue open (lawn preferred), budget Rs 9 lakh. Next: call back and share packages.'),
      ('demo.priya@example.com',   'Sample lead. Called back, budget confirmed. 1st birthday for 120 guests at a banquet hall, budget Rs 2.5 lakh, theme: jungle. Next: send menu options.'),
      ('demo.neha@example.com',    'Sample lead. Site visit at Green Meadows Lawn booked. Wedding for 700 guests, budget Rs 20 lakh, wants a mandap + sangeet night. Next: site visit and discovery call.'),
      ('demo.fatima@example.com',  'Sample lead. Went with another planner. Wedding for 450 guests, budget Rs 12 lakh. Reason lost: price. Follow up for future events.'),
      ('demo.ananya@example.com',  'Sample lead. Booked. Wedding for 450 guests at Green Meadows Lawn, budget Rs 15 lakh. Advance received.'),
      ('demo.rohit@example.com',   'Sample lead. Quote sent for approval. Engagement for 220 guests at Square Garden Pavilion, budget Rs 6 lakh. Next: follow up in 2 days.'),
      ('demo.technova@example.com','Sample lead. Draft quote in progress. Annual day for 300 staff at Grand Convention Centre, budget Rs 8 lakh, needs stage + LED wall + awards. Next: finalise the quote.'),
      ('demo.meera@example.com',   'Sample lead. Event done and settled. Engagement for 250 guests at Royal Banquet Hall. 5-star feedback.')
    ) x(e, n)
   where l.org_id = M and l.email = x.e and l.notes not like '%Next:%' and l.notes not like '%Reason lost%'
     and l.notes not like '%feedback%' and l.notes not like '%Advance received%';

  -- 3) complete client details on the sample events (keys the client box does not have yet)
  update public.quotes q set client = jsonb_strip_nulls(x.c) || q.client
    from (values
      (q1, '{"guests":450,"budget":1500000,"source":"Instagram","address":"Demo \u00b7 Shamshabad Road, Hyderabad","notes":"Sample event. Telugu wedding, muhurtham 19:30. Veg + non-veg buffet."}'::jsonb),
      (q2, '{"guests":220,"budget":600000,"source":"Referral","address":"Demo \u00b7 Gachibowli, Hyderabad","notes":"Sample event. Ring ceremony + dinner. Wants pastel florals."}'::jsonb),
      (q3, '{"guests":300,"budget":800000,"source":"Website","address":"Demo \u00b7 Hitec City, Hyderabad","notes":"Sample event. Annual day: awards, cultural show, dinner. GST invoice to company."}'::jsonb),
      (q4, '{"guests":250,"budget":700000,"source":"Referral","address":"Demo \u00b7 Banjara Hills, Hyderabad","notes":"Sample event. Done and settled."}'::jsonb)
    ) x(id, c)
   where q.org_id = M and q.id = x.id and not (q.client ? 'source');

  -- 3) discovery meeting records (quote_id is the key; only if none yet)
  insert into public.event_discovery(quote_id, org_id, meet_date, mode, location, attendees, notes, budget_min, budget_max)
  select x.q, M, d0 + x.off, x.mode, x.loc, x.att, x.notes, x.bmin, x.bmax
    from (values
      (q1, -20, 'in_person', D || 'Green Meadows Lawn', 'Ananya, Vikram, both mothers; Ravi (planner)',
       'Sample discovery. Must-haves: floral mandap, LED wall for live feed, 2 buffets, sofas for elders. Colours: ivory + gold. Curfew 10 pm.', 1200000, 1500000),
      (q2, -5, 'video', 'Video call', 'Rohit, Meera; Ravi (planner)',
       'Sample discovery. Ring ceremony at 18:30, dinner after. Pastel florals, DJ for 2 hours, photo booth.', 500000, 600000),
      (q3, -3, 'call', 'Phone call', 'TechNova HR lead; Ravi (planner)',
       'Sample discovery. 300 staff. Stage + LED wall, awards segment, cultural show, buffet dinner. Needs GST invoice.', 700000, 800000)
    ) x(q, off, mode, loc, att, notes, bmin, bmax)
   where exists (select 1 from public.quotes qq where qq.id = x.q and qq.org_id = M)
  on conflict (quote_id) do nothing;

  -- 4) discount coupons
  insert into public.coupons(org_id, code, kind, value, note, active) values
    (M, 'DEMO-WELCOME10', 'percent', 10,   'Sample coupon. 10% off for a first booking.', true),
    (M, 'DEMO-FLAT5000',  'flat',    5000, 'Sample coupon. Rs 5,000 off any event.', true),
    (M, 'DEMO-WEEKDAY15', 'percent', 15,   'Sample coupon. 15% off weekday events (Mon-Thu). Check the date before applying.', true)
  on conflict (org_id, code) do nothing;

  -- 5) run sheets: the sent engagement (q2) and the corporate event (q3), only if they have none
  if not exists (select 1 from public.run_sheet_items r where r.org_id = M and r.quote_id = q2) then
    insert into public.run_sheet_items(quote_id, org_id, start_time, duration_min, title, owner, location, note, seq)
    select q2, M, x.t::time, x.dur, x.title, x.own, x.loc, x.note, x.seq from (values
      ('10:00', 180, 'Decor load-in and pastel florals', D || 'Lakshmi Prasanna', 'Pavilion', null, 1),
      ('13:00', 60, 'Stage, ring platform and photo booth', D || 'Kavya Menon', 'Stage', null, 2),
      ('15:00', 45, 'Sound check and DJ setup', D || 'DJ Nawab Beats', 'Stage', null, 3),
      ('16:00', 90, 'Buffet counters setup', D || 'Chef Venkat Rao', 'Buffet', null, 4),
      ('17:30', 30, 'Staff briefing', D || 'Ravi Kumar', 'Entrance', 'Guest flow, gifts table, timings.', 5),
      ('18:00', 30, 'Welcome drinks', D || 'Arjun Naidu', 'Entrance', null, 6),
      ('18:30', 45, 'Ring ceremony', D || 'Ravi Kumar', 'Stage', null, 7),
      ('19:15', 120, 'DJ and dance floor', D || 'DJ Nawab Beats', 'Dance floor', null, 8),
      ('20:00', 90, 'Dinner service', D || 'Arjun Naidu', 'Buffet', null, 9),
      ('22:00', 15, 'Music off (sound curfew)', D || 'Ravi Kumar', 'Stage', null, 10),
      ('22:15', 120, 'Teardown and rentals loaded', D || 'Raju Goud', 'Pavilion', null, 11)
    ) as x(t, dur, title, own, loc, note, seq);
  end if;
  if not exists (select 1 from public.run_sheet_items r where r.org_id = M and r.quote_id = q3) then
    insert into public.run_sheet_items(quote_id, org_id, start_time, duration_min, title, owner, location, note, seq)
    select q3, M, x.t::time, x.dur, x.title, x.own, x.loc, x.note, x.seq from (values
      ('06:00', 120, 'Venue access, stage and LED wall build', D || 'Imran Shaikh', 'Hall', 'Setup window from 06:00.', 1),
      ('09:00', 90, 'Lighting focus and LED content test', D || 'Deccan Sound & Lights', 'Stage', null, 2),
      ('11:00', 60, 'Branding, standees and registration desk', D || 'Kavya Menon', 'Foyer', null, 3),
      ('14:00', 60, 'Rehearsal: awards + cultural show', D || 'Ravi Kumar', 'Stage', null, 4),
      ('15:30', 90, 'Buffet and hi-tea setup', D || 'Chef Venkat Rao', 'Dining', null, 5),
      ('16:30', 30, 'Registration opens, hi-tea', D || 'Sneha Reddy', 'Foyer', null, 6),
      ('17:00', 30, 'Welcome address by the CEO', D || 'Ravi Kumar', 'Stage', null, 7),
      ('17:30', 60, 'Awards segment', D || 'Ravi Kumar', 'Stage', null, 8),
      ('18:30', 60, 'Cultural show', D || 'Deccan Sound & Lights', 'Stage', null, 9),
      ('19:30', 90, 'Dinner service', D || 'Arjun Naidu', 'Dining', null, 10),
      ('21:30', 120, 'Teardown and rentals loaded', D || 'Raju Goud', 'Hall', null, 11)
    ) as x(t, dur, title, own, loc, note, seq);
  end if;

  update public.helm_sample_template
     set notes = 'Sample dataset v3 (India): wedding layout template, coupons, T&C, GST, run sheets (0169). Edit the master studio, then publish_sample_manifest(). Switch: active.',
         updated_at = now()
   where id and org_id = M and coalesce(notes, '') not like 'Sample dataset v3%';
end $$;

-- ---- 7a) what a snapshot holds: + coupons, studio layout templates, discovery records ------------
create or replace function public._sample_clone_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-data-0169 (trial-sample-0167, trial-sandbox-0166)
  select array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates',
               'item_rate_cards', 'checklist_templates', 'task_templates', 'coupons', 'studio_layout_templates',
               'leads', 'quotes', 'quote_versions', 'event_discovery', 'payment_milestones', 'quote_payments',
               'event_checklist', 'event_tasks', 'run_sheet_items', 'inventory_reservations',
               'event_costs', 'event_closure', 'nurture']::text[];
$$;

-- ---- 7b) studio settings: + tax and terms ---------------------------------------------------------
create or replace function public._sample_studio_settings(p_src uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- trial-data-0168 + trial-data-0169 (gstPct / placeOfSupply / taxState / termsText)
  select jsonb_build_object(
           'currency', o.currency, 'timezone', o.timezone, 'country', o.country,
           'pricing', coalesce((select jsonb_strip_nulls(jsonb_build_object(
                                  'advancePct', c.value -> 'advancePct', 'balanceDueDays', c.value -> 'balanceDueDays',
                                  'paymentTermsNote', c.value -> 'paymentTermsNote', 'gstPct', c.value -> 'gstPct',
                                  'placeOfSupply', c.value -> 'placeOfSupply', 'taxState', c.value -> 'taxState',
                                  'termsText', c.value -> 'termsText'))
                                from public.app_config c where c.org_id = o.id and c.key = 'pricing'), '{}'::jsonb))
    from public.organizations o where o.id = p_src;
$$;

-- ---- 7c) clear: the sample coupons go off, the sample templates are archived (never deleted) -------
do $$ begin
  if to_regprocedure('public._demo_clear__pre0169(uuid)') is null then
    alter function public._demo_clear(uuid) rename to _demo_clear__pre0169; end if;
end $$;

create or replace function public._demo_clear(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-data-0169 (wraps trial-sample-0167): + sample coupons off, sample layout templates archived
declare r jsonb; n_c integer; n_t integer;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  r := public._demo_clear__pre0169(p_org);
  if exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then return r; end if;
  update public.coupons set active = false where org_id = p_org and active and code like 'DEMO-%';
  get diagnostics n_c = row_count;
  update public.studio_layout_templates set archived = true, is_default = false, updated_at = now()
   where org_id = p_org and not archived and name like E'Demo \u00b7 %';
  get diagnostics n_t = row_count;
  return coalesce(r, '{}'::jsonb) || jsonb_build_object('coupons_off', n_c, 'layout_templates_archived', n_t);
end $$;

-- ---- privileges: definer / service role only -------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._sample_clone_tables()', 'public._sample_studio_settings(uuid)',
                           'public._demo_clear(uuid)', 'public._demo_clear__pre0169(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._demo_clear(uuid)', 'public._demo_clear__pre0169(uuid)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;

-- ---- 8) publish v3 once ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001' and o.is_sample_master)
     and exists (select 1 from public.quotes x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid)
     and not exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'v3: wedding layout template, coupons, T&C, GST, run sheets') then
    perform public.publish_sample_manifest('v3: wedding layout template, coupons, T&C, GST, run sheets');
  end if;
end $$;
