-- 0213_sample_event_layouts.sql - CANONICAL forward-only. The free-trial sample events get real floor plans.
-- REQUIRES 0167 (sample master + publish_sample_manifest + _sample_publish_ok), 0171 (sample events SMP-1004..1006),
--          base (quote_versions). Independent of 0237 (it may run before or after it).
--
-- In plain words:
--   1  Five of the seven sample events opened in the builder on an EMPTY floor (0237 only gave them an empty
--      version 1). Each now gets a floor plan made for its event type and guest count, built with the builder's
--      own pieces (stage / puja mandap, seating for every guest, buffet lines, decor, an entrance and exits):
--        SMP-1000 Meera Iyer - engagement, 250 guests, Royal Banquet Hall (115 x 72 ft, indoor): floral stage +
--          backdrop, DJ, dance floor, aisle carpet, 25 round tables x 10 = 250 seats, 3 buffet lines, photo booth,
--          entrance arch, 2 exits; limit 450.
--        SMP-1002 Rohit Sharma - engagement, 220 guests, Square Garden Pavilion (120 x 90 ft of the lawn): the same
--          set, 22 tables x 10 = 220 seats, 3 buffet lines, an emergency exit and a generator; limit 300.
--        SMP-1004 Kapoor Family - sangeet, 300 guests, Green Meadows Lawn (150 x 110 ft): sangeet stage, 2 LED
--          screens, DJ, 24 ft dance floor under a fairy-light canopy, 30 tables x 10 = 300 seats, 3 buffet lines,
--          restrooms, generator, emergency exit; limit 400.
--        SMP-1005 Zenith Mobiles - product launch, 200 guests, Grand Convention Centre hall (120 x 90 ft, indoor):
--          branding wall, lighting truss, launch stage, podium, 2 LED screens, line arrays, teleprompter, theatre
--          seating 2 x (10 rows x 10) = 200 seats, centre aisle, press riser, 2 buffet lines + coffee counter,
--          registration desks, photo wall, entrance, 3 exits; limit 300.
--        SMP-1006 Lakshmi Prasad - housewarming, 150 guests, Square Garden Pavilion (100 x 75 ft): puja mandap,
--          kalash + deepam stands, rangoli, 15 tables x 10 = 150 seats, 2 buffet lines, gift table, entrance
--          arch, 2 exits, generator; limit 200.
--      The wedding (SMP-1001, 450 guests) and the gala (SMP-1003, 120 guests) already had full floor plans and
--      are not touched.
--   2  Only an event whose floor is still EMPTY (no saved version with any object on it) gets its plan, on the
--      event's CURRENT version (quotes.current_version - the one the builder opens): the empty placeholder
--      version 0237 made (an empty items list, 0 objects - nothing on it to lose) is filled, or, on a fresh install
--      where 0237 has not run yet, that version is added. Any version with an object on it is never changed;
--      an owner-drawn floor in the master is never replaced; the quote rows are not touched; nothing deleted.
--   3  ONE new sample manifest is published (current + 1, marker 'sample floor plans (0213)', only when a plan
--      was added): every NEW free trial gets these floor plans. Existing trials are NOT changed here - the
--      owner-run supabase/APPLY-0213-refresh-trial-layouts.sql calls _a213_fill_trial_layouts(), which gives their
--      still-empty sample events the same plans the same way (fill-empty / insert only).
--   Helpers (internal, no app / anonymous access): _a213_sample_layout(code), _a213_fill_floor(quote),
--   _a213_fill_trial_layouts(org default all), _a213_manifest_note().
--   No table, column, index, policy or trigger is added or dropped; paid studios are not touched; nothing is
--   deleted. ASCII only. Safe to run twice (the 2nd run changes nothing).

do $$ begin
  if to_regclass('public.quote_versions') is null or to_regclass('public.helm_trial_seed_manifest') is null
     or to_regprocedure('public.publish_sample_manifest(text)') is null then
    raise exception '0213 needs 0167 (sample master + publish_sample_manifest) and quote_versions first'; end if;
end $$;

create or replace function public._a213_manifest_note()
returns text language sql immutable set search_path = '' as $$
  select 'sample floor plans (0213)'::text;
$$;

-- the five sample floor plans (builder layout documents: items + grid + margins + venue + scale), by event code;
-- null for any other code. One place for the migration, VERIFY, the trial refresh and the tests.
create or replace function public._a213_sample_layout(p_code text)
returns jsonb language sql immutable set search_path = '' as $$
  -- sample-layouts-0213
  select case p_code
    when 'SMP-1000' then $j${"items":[{"id":"r19_smp1000_1","type":"stagebackdrop","category":"decor","x":42.5,"y":0.5,"width":30,"height":2,"rotation":0,"label":"Stage Floral Backdrop","color":"#d6549a","properties":{}},
{"id":"r19_smp1000_2","type":"stage","category":"structure","x":42.5,"y":3,"width":30,"height":12,"rotation":0,"label":"Engagement Stage","color":"#2f6fed","properties":{}},
{"id":"r19_smp1000_3","type":"floralpillar","category":"decor","x":39,"y":12.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1000_4","type":"floralpillar","category":"decor","x":73.5,"y":12.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1000_5","type":"speaker","category":"av","x":38.5,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1000_6","type":"speaker","category":"av","x":73.5,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1000_7","type":"dj","category":"av","x":78.5,"y":4,"width":8,"height":5,"rotation":0,"label":"DJ","color":"#7c5cff","properties":{}},
{"id":"r19_smp1000_8","type":"dancefloor","category":"structure","x":49.5,"y":18,"width":16,"height":16,"rotation":0,"label":"Dance Floor","color":"#2f6fed","properties":{}},
{"id":"r19_smp1000_9","type":"redcarpet","category":"structure","x":55.5,"y":35,"width":4,"height":31,"rotation":0,"label":"Aisle Carpet","color":"#2f6fed","properties":{}},
{"id":"r19_smp1000_10","type":"exit","category":"safety","x":1,"y":65,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1000_11","type":"exit","category":"safety","x":102,"y":65,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1000_12","type":"floralentrance","category":"decor","x":50.5,"y":67,"width":14,"height":4,"rotation":0,"label":"Entrance","color":"#d6549a","properties":{}},
{"id":"r19_smp1000_13","type":"welcomeboard","category":"decor","x":66.5,"y":67,"width":3,"height":2.5,"rotation":0,"label":"Welcome Board","color":"#d6549a","properties":{}},
{"id":"r19_smp1000_14","type":"planter","category":"structure","x":44.5,"y":67,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1000_15","type":"planter","category":"structure","x":70.5,"y":67,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1000_16","type":"buffet","category":"logistics","x":97,"y":26.5,"width":18,"height":3,"rotation":90,"label":"Buffet 1","color":"#e8912d","properties":{}},
{"id":"r19_smp1000_17","type":"buffet","category":"logistics","x":97,"y":47.5,"width":18,"height":3,"rotation":90,"label":"Buffet 2","color":"#e8912d","properties":{}},
{"id":"r19_smp1000_18","type":"photobooth","category":"av","x":1.5,"y":19,"width":8,"height":8,"rotation":0,"label":"Photo Booth","color":"#7c5cff","properties":{}},
{"id":"r19_smp1000_19","type":"buffet","category":"logistics","x":0,"y":36.5,"width":18,"height":3,"rotation":90,"label":"Buffet 3","color":"#e8912d","properties":{}},
{"id":"r19_smp1000_20","type":"table","category":"seating","x":14,"y":19,"width":6,"height":6,"rotation":0,"label":"T1","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_21","type":"table","category":"seating","x":25,"y":19,"width":6,"height":6,"rotation":0,"label":"T2","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_22","type":"table","category":"seating","x":36,"y":19,"width":6,"height":6,"rotation":0,"label":"T3","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_23","type":"table","category":"seating","x":73,"y":19,"width":6,"height":6,"rotation":0,"label":"T4","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_24","type":"table","category":"seating","x":84,"y":19,"width":6,"height":6,"rotation":0,"label":"T5","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_25","type":"table","category":"seating","x":95,"y":19,"width":6,"height":6,"rotation":0,"label":"T6","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_26","type":"table","category":"seating","x":14,"y":30,"width":6,"height":6,"rotation":0,"label":"T7","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_27","type":"table","category":"seating","x":25,"y":30,"width":6,"height":6,"rotation":0,"label":"T8","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_28","type":"table","category":"seating","x":36,"y":30,"width":6,"height":6,"rotation":0,"label":"T9","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_29","type":"table","category":"seating","x":73,"y":30,"width":6,"height":6,"rotation":0,"label":"T10","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_30","type":"table","category":"seating","x":84,"y":30,"width":6,"height":6,"rotation":0,"label":"T11","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_31","type":"table","category":"seating","x":95,"y":30,"width":6,"height":6,"rotation":0,"label":"T12","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_32","type":"table","category":"seating","x":14,"y":41,"width":6,"height":6,"rotation":0,"label":"T13","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_33","type":"table","category":"seating","x":25,"y":41,"width":6,"height":6,"rotation":0,"label":"T14","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_34","type":"table","category":"seating","x":36,"y":41,"width":6,"height":6,"rotation":0,"label":"T15","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_35","type":"table","category":"seating","x":47,"y":41,"width":6,"height":6,"rotation":0,"label":"T16","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_36","type":"table","category":"seating","x":62,"y":41,"width":6,"height":6,"rotation":0,"label":"T17","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_37","type":"table","category":"seating","x":73,"y":41,"width":6,"height":6,"rotation":0,"label":"T18","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_38","type":"table","category":"seating","x":84,"y":41,"width":6,"height":6,"rotation":0,"label":"T19","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_39","type":"table","category":"seating","x":95,"y":41,"width":6,"height":6,"rotation":0,"label":"T20","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_40","type":"table","category":"seating","x":25,"y":52,"width":6,"height":6,"rotation":0,"label":"T21","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_41","type":"table","category":"seating","x":36,"y":52,"width":6,"height":6,"rotation":0,"label":"T22","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_42","type":"table","category":"seating","x":47,"y":52,"width":6,"height":6,"rotation":0,"label":"T23","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_43","type":"table","category":"seating","x":62,"y":52,"width":6,"height":6,"rotation":0,"label":"T24","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1000_44","type":"table","category":"seating","x":73,"y":52,"width":6,"height":6,"rotation":0,"label":"T25","color":"#0d9488","properties":{"seats":10,"shape":"round"}}],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":450,"room":{"w":115,"h":72},"setting":"indoor"},"scale":{"pxPerFt":12,"worldFt":{"w":115,"h":72}}}$j$::jsonb
    when 'SMP-1002' then $j${"items":[{"id":"r19_smp1002_1","type":"stagebackdrop","category":"decor","x":44,"y":0.5,"width":32,"height":2,"rotation":0,"label":"Stage Floral Backdrop","color":"#d6549a","properties":{}},
{"id":"r19_smp1002_2","type":"stage","category":"structure","x":44,"y":3,"width":32,"height":12,"rotation":0,"label":"Engagement Stage","color":"#2f6fed","properties":{}},
{"id":"r19_smp1002_3","type":"floralpillar","category":"decor","x":40.5,"y":12.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1002_4","type":"floralpillar","category":"decor","x":77,"y":12.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1002_5","type":"speaker","category":"av","x":40,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1002_6","type":"speaker","category":"av","x":77,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1002_7","type":"dj","category":"av","x":82,"y":4,"width":8,"height":5,"rotation":0,"label":"DJ","color":"#7c5cff","properties":{}},
{"id":"r19_smp1002_8","type":"dancefloor","category":"structure","x":52,"y":18,"width":16,"height":16,"rotation":0,"label":"Dance Floor","color":"#2f6fed","properties":{}},
{"id":"r19_smp1002_9","type":"redcarpet","category":"structure","x":58,"y":35,"width":4,"height":49,"rotation":0,"label":"Aisle Carpet","color":"#2f6fed","properties":{}},
{"id":"r19_smp1002_10","type":"exit","category":"safety","x":1,"y":83,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1002_11","type":"exit","category":"safety","x":107,"y":83,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1002_12","type":"exit","category":"safety","x":0,"y":48,"width":12,"height":6,"rotation":90,"label":"Emergency Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1002_13","type":"floralentrance","category":"decor","x":53,"y":85,"width":14,"height":4,"rotation":0,"label":"Entrance","color":"#d6549a","properties":{}},
{"id":"r19_smp1002_14","type":"welcomeboard","category":"decor","x":69,"y":85,"width":3,"height":2.5,"rotation":0,"label":"Welcome Board","color":"#d6549a","properties":{}},
{"id":"r19_smp1002_15","type":"planter","category":"structure","x":47,"y":85,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1002_16","type":"planter","category":"structure","x":73,"y":85,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1002_17","type":"generator","category":"logistics","x":15,"y":85,"width":10,"height":4,"rotation":0,"label":"Generator","color":"#e8912d","properties":{}},
{"id":"r19_smp1002_18","type":"buffet","category":"logistics","x":102,"y":26.5,"width":18,"height":3,"rotation":90,"label":"Buffet 1","color":"#e8912d","properties":{}},
{"id":"r19_smp1002_19","type":"buffet","category":"logistics","x":102,"y":47.5,"width":18,"height":3,"rotation":90,"label":"Buffet 2","color":"#e8912d","properties":{}},
{"id":"r19_smp1002_20","type":"buffet","category":"logistics","x":102,"y":68.5,"width":18,"height":3,"rotation":90,"label":"Buffet 3","color":"#e8912d","properties":{}},
{"id":"r19_smp1002_21","type":"photobooth","category":"av","x":1.5,"y":19,"width":8,"height":8,"rotation":0,"label":"Photo Booth","color":"#7c5cff","properties":{}},
{"id":"r19_smp1002_22","type":"table","category":"seating","x":13.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T1","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_23","type":"table","category":"seating","x":25.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T2","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_24","type":"table","category":"seating","x":37.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T3","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_25","type":"table","category":"seating","x":76.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T4","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_26","type":"table","category":"seating","x":88.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T5","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_27","type":"table","category":"seating","x":100.5,"y":19,"width":6,"height":6,"rotation":0,"label":"T6","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_28","type":"table","category":"seating","x":13.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T7","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_29","type":"table","category":"seating","x":25.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T8","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_30","type":"table","category":"seating","x":37.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T9","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_31","type":"table","category":"seating","x":76.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T10","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_32","type":"table","category":"seating","x":88.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T11","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_33","type":"table","category":"seating","x":100.5,"y":31,"width":6,"height":6,"rotation":0,"label":"T12","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_34","type":"table","category":"seating","x":13.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T13","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_35","type":"table","category":"seating","x":25.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T14","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_36","type":"table","category":"seating","x":37.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T15","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_37","type":"table","category":"seating","x":49.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T16","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_38","type":"table","category":"seating","x":64.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T17","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_39","type":"table","category":"seating","x":76.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T18","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_40","type":"table","category":"seating","x":88.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T19","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_41","type":"table","category":"seating","x":100.5,"y":43,"width":6,"height":6,"rotation":0,"label":"T20","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_42","type":"table","category":"seating","x":49.5,"y":55,"width":6,"height":6,"rotation":0,"label":"T21","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1002_43","type":"table","category":"seating","x":64.5,"y":55,"width":6,"height":6,"rotation":0,"label":"T22","color":"#0d9488","properties":{"seats":10,"shape":"round"}}],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":300,"room":{"w":120,"h":90},"setting":"outdoor"},"scale":{"pxPerFt":12,"worldFt":{"w":120,"h":90}}}$j$::jsonb
    when 'SMP-1004' then $j${"items":[{"id":"r19_smp1004_1","type":"stagebackdrop","category":"decor","x":55,"y":0.5,"width":40,"height":2,"rotation":0,"label":"Stage Floral Backdrop","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_2","type":"stage","category":"structure","x":55,"y":3,"width":40,"height":14,"rotation":0,"label":"Sangeet Stage","color":"#2f6fed","properties":{}},
{"id":"r19_smp1004_3","type":"floralpillar","category":"decor","x":51.5,"y":14.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_4","type":"floralpillar","category":"decor","x":96,"y":14.5,"width":2.5,"height":2.5,"rotation":0,"label":"Floral Pillar","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_5","type":"speaker","category":"av","x":51,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_6","type":"speaker","category":"av","x":96,"y":4,"width":3,"height":3,"rotation":0,"label":"Speaker R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_7","type":"dj","category":"av","x":101,"y":4,"width":8,"height":5,"rotation":0,"label":"DJ","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_8","type":"led","category":"av","x":31,"y":2,"width":16,"height":1.5,"rotation":0,"label":"LED Screen L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_9","type":"led","category":"av","x":111,"y":2,"width":16,"height":1.5,"rotation":0,"label":"LED Screen R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_10","type":"dancefloor","category":"structure","x":63,"y":20,"width":24,"height":24,"rotation":0,"label":"Dance Floor","color":"#2f6fed","properties":{}},
{"id":"r19_smp1004_11","type":"fairylights","category":"decor","x":63,"y":20,"width":24,"height":24,"rotation":0,"label":"Fairy Light Canopy","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_12","type":"redcarpet","category":"structure","x":73,"y":45,"width":4,"height":59,"rotation":0,"label":"Aisle Carpet","color":"#2f6fed","properties":{}},
{"id":"r19_smp1004_13","type":"exit","category":"safety","x":1,"y":103,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1004_14","type":"exit","category":"safety","x":137,"y":103,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1004_15","type":"exit","category":"safety","x":0,"y":58,"width":12,"height":6,"rotation":90,"label":"Emergency Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1004_16","type":"floralentrance","category":"decor","x":68,"y":105,"width":14,"height":4,"rotation":0,"label":"Entrance","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_17","type":"welcomeboard","category":"decor","x":84,"y":105,"width":3,"height":2.5,"rotation":0,"label":"Welcome Board","color":"#d6549a","properties":{}},
{"id":"r19_smp1004_18","type":"planter","category":"structure","x":62,"y":105,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1004_19","type":"planter","category":"structure","x":88,"y":105,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1004_20","type":"generator","category":"logistics","x":15,"y":105,"width":10,"height":4,"rotation":0,"label":"Generator","color":"#e8912d","properties":{}},
{"id":"r19_smp1004_21","type":"buffet","category":"logistics","x":132,"y":28.5,"width":18,"height":3,"rotation":90,"label":"Buffet 1","color":"#e8912d","properties":{}},
{"id":"r19_smp1004_22","type":"buffet","category":"logistics","x":132,"y":49.5,"width":18,"height":3,"rotation":90,"label":"Buffet 2","color":"#e8912d","properties":{}},
{"id":"r19_smp1004_23","type":"buffet","category":"logistics","x":132,"y":70.5,"width":18,"height":3,"rotation":90,"label":"Buffet 3","color":"#e8912d","properties":{}},
{"id":"r19_smp1004_24","type":"photobooth","category":"av","x":1.5,"y":21,"width":8,"height":8,"rotation":0,"label":"Photo Booth","color":"#7c5cff","properties":{}},
{"id":"r19_smp1004_25","type":"restroom","category":"logistics","x":1,"y":80,"width":12,"height":8,"rotation":0,"label":"Restrooms","color":"#e8912d","properties":{}},
{"id":"r19_smp1004_26","type":"table","category":"seating","x":16.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T1","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_27","type":"table","category":"seating","x":28.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T2","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_28","type":"table","category":"seating","x":40.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T3","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_29","type":"table","category":"seating","x":52.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T4","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_30","type":"table","category":"seating","x":91.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T5","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_31","type":"table","category":"seating","x":103.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T6","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_32","type":"table","category":"seating","x":115.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T7","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_33","type":"table","category":"seating","x":127.5,"y":21,"width":6,"height":6,"rotation":0,"label":"T8","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_34","type":"table","category":"seating","x":4.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T9","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_35","type":"table","category":"seating","x":16.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T10","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_36","type":"table","category":"seating","x":28.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T11","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_37","type":"table","category":"seating","x":40.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T12","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_38","type":"table","category":"seating","x":52.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T13","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_39","type":"table","category":"seating","x":91.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T14","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_40","type":"table","category":"seating","x":103.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T15","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_41","type":"table","category":"seating","x":115.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T16","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_42","type":"table","category":"seating","x":127.5,"y":33,"width":6,"height":6,"rotation":0,"label":"T17","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_43","type":"table","category":"seating","x":4.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T18","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_44","type":"table","category":"seating","x":16.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T19","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_45","type":"table","category":"seating","x":28.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T20","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_46","type":"table","category":"seating","x":40.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T21","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_47","type":"table","category":"seating","x":52.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T22","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_48","type":"table","category":"seating","x":91.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T23","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_49","type":"table","category":"seating","x":103.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T24","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_50","type":"table","category":"seating","x":115.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T25","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_51","type":"table","category":"seating","x":127.5,"y":45,"width":6,"height":6,"rotation":0,"label":"T26","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_52","type":"table","category":"seating","x":52.5,"y":57,"width":6,"height":6,"rotation":0,"label":"T27","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_53","type":"table","category":"seating","x":64.5,"y":57,"width":6,"height":6,"rotation":0,"label":"T28","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_54","type":"table","category":"seating","x":79.5,"y":57,"width":6,"height":6,"rotation":0,"label":"T29","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1004_55","type":"table","category":"seating","x":91.5,"y":57,"width":6,"height":6,"rotation":0,"label":"T30","color":"#0d9488","properties":{"seats":10,"shape":"round"}}],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":400,"room":{"w":150,"h":110},"setting":"outdoor"},"scale":{"pxPerFt":12,"worldFt":{"w":150,"h":110}}}$j$::jsonb
    when 'SMP-1005' then $j${"items":[{"id":"r19_smp1005_1","type":"brandwall","category":"decor","x":48,"y":1,"width":24,"height":1.5,"rotation":0,"label":"Launch Branding Wall","color":"#d6549a","properties":{}},
{"id":"r19_smp1005_2","type":"lighting","category":"av","x":40,"y":3.5,"width":40,"height":1.5,"rotation":0,"label":"Lighting Truss","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_3","type":"stage","category":"structure","x":40,"y":6,"width":40,"height":14,"rotation":0,"label":"Launch Stage","color":"#2f6fed","properties":{"plain":true}},
{"id":"r19_smp1005_4","type":"podium","category":"av","x":73,"y":12.3,"width":3,"height":3,"rotation":0,"label":"Podium","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_5","type":"led","category":"av","x":20,"y":8,"width":16,"height":1.5,"rotation":0,"label":"LED Screen L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_6","type":"led","category":"av","x":84,"y":8,"width":16,"height":1.5,"rotation":0,"label":"LED Screen R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_7","type":"linearray","category":"av","x":36.5,"y":14,"width":2,"height":6,"rotation":0,"label":"Line Array L","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_8","type":"linearray","category":"av","x":81.5,"y":14,"width":2,"height":6,"rotation":0,"label":"Line Array R","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_9","type":"teleprompter","category":"av","x":58.5,"y":21.5,"width":3,"height":1.5,"rotation":0,"label":"Teleprompter","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_10","type":"exit","category":"safety","x":1,"y":83,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1005_11","type":"exit","category":"safety","x":107,"y":83,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1005_12","type":"exit","category":"safety","x":0,"y":48,"width":12,"height":6,"rotation":90,"label":"Emergency Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1005_13","type":"exit","category":"safety","x":54,"y":83,"width":12,"height":6,"rotation":0,"label":"Entrance","color":"#2563eb","properties":{},"colorCustom":true},
{"id":"r19_smp1005_14","type":"desk","category":"logistics","x":40,"y":84,"width":8,"height":2.5,"rotation":0,"label":"Registration","color":"#e8912d","properties":{}},
{"id":"r19_smp1005_15","type":"desk","category":"logistics","x":72,"y":84,"width":8,"height":2.5,"rotation":0,"label":"Registration","color":"#e8912d","properties":{}},
{"id":"r19_smp1005_16","type":"selfieframe","category":"decor","x":84,"y":85,"width":6,"height":2,"rotation":0,"label":"Photo Wall","color":"#d6549a","properties":{}},
{"id":"r19_smp1005_17","type":"press","category":"av","x":12,"y":68,"width":20,"height":10,"rotation":0,"label":"Press Riser","color":"#7c5cff","properties":{}},
{"id":"r19_smp1005_18","type":"planter","category":"structure","x":26,"y":15,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1005_19","type":"planter","category":"structure","x":90,"y":15,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1005_20","type":"buffet","category":"logistics","x":102,"y":31.5,"width":18,"height":3,"rotation":90,"label":"Buffet 1","color":"#e8912d","properties":{}},
{"id":"r19_smp1005_21","type":"buffet","category":"logistics","x":102,"y":52.5,"width":18,"height":3,"rotation":90,"label":"Buffet 2","color":"#e8912d","properties":{}},
{"id":"r19_smp1005_22","type":"livecounter","category":"logistics","x":110,"y":66,"width":8,"height":4,"rotation":0,"label":"Coffee Counter","color":"#e8912d","properties":{}},
{"id":"r19_smp1005_23","type":"seatblock","category":"seating","x":32,"y":29,"width":24,"height":30,"rotation":0,"label":"Seating Left","color":"#0d9488","properties":{"rows":10,"cols":10,"pitch":2.4}},
{"id":"r19_smp1005_24","type":"seatblock","category":"seating","x":64,"y":29,"width":24,"height":30,"rotation":0,"label":"Seating Right","color":"#0d9488","properties":{"rows":10,"cols":10,"pitch":2.4}},
{"id":"r19_smp1005_25","type":"redcarpet","category":"structure","x":58,"y":27,"width":4,"height":56,"rotation":0,"label":"Centre Aisle","color":"#2f6fed","properties":{}}],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":300,"room":{"w":120,"h":90},"setting":"indoor"},"scale":{"pxPerFt":12,"worldFt":{"w":120,"h":90}}}$j$::jsonb
    when 'SMP-1006' then $j${"items":[{"id":"r19_smp1006_1","type":"mandap","category":"decor","x":42,"y":3,"width":16,"height":16,"rotation":0,"label":"Puja Mandap","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_2","type":"kalash","category":"decor","x":39,"y":15,"width":1.5,"height":1.5,"rotation":0,"label":"Kalash","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_3","type":"kalash","category":"decor","x":59.5,"y":15,"width":1.5,"height":1.5,"rotation":0,"label":"Kalash","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_4","type":"diyastand","category":"decor","x":38,"y":5,"width":2,"height":2,"rotation":0,"label":"Deepam Stand","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_5","type":"diyastand","category":"decor","x":60,"y":5,"width":2,"height":2,"rotation":0,"label":"Deepam Stand","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_6","type":"rangoli","category":"decor","x":47,"y":21,"width":6,"height":6,"rotation":0,"label":"Rangoli","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_7","type":"redcarpet","category":"structure","x":48,"y":28,"width":4,"height":41,"rotation":0,"label":"Aisle Carpet","color":"#2f6fed","properties":{}},
{"id":"r19_smp1006_8","type":"exit","category":"safety","x":1,"y":68,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1006_9","type":"exit","category":"safety","x":87,"y":68,"width":12,"height":6,"rotation":0,"label":"Exit","color":"#18a558","properties":{}},
{"id":"r19_smp1006_10","type":"floralentrance","category":"decor","x":43,"y":70,"width":14,"height":4,"rotation":0,"label":"Entrance","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_11","type":"welcomeboard","category":"decor","x":59,"y":70,"width":3,"height":2.5,"rotation":0,"label":"Welcome Board","color":"#d6549a","properties":{}},
{"id":"r19_smp1006_12","type":"planter","category":"structure","x":37,"y":70,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1006_13","type":"planter","category":"structure","x":63,"y":70,"width":4,"height":4,"rotation":0,"label":"Greenery","color":"#2f6fed","properties":{}},
{"id":"r19_smp1006_14","type":"generator","category":"logistics","x":15,"y":70,"width":10,"height":4,"rotation":0,"label":"Generator","color":"#e8912d","properties":{}},
{"id":"r19_smp1006_15","type":"buffet","category":"logistics","x":82,"y":30.5,"width":18,"height":3,"rotation":90,"label":"Buffet 1","color":"#e8912d","properties":{}},
{"id":"r19_smp1006_16","type":"buffet","category":"logistics","x":82,"y":51.5,"width":18,"height":3,"rotation":90,"label":"Buffet 2","color":"#e8912d","properties":{}},
{"id":"r19_smp1006_17","type":"gifttable","category":"logistics","x":1.5,"y":23,"width":6,"height":2.5,"rotation":0,"label":"Gift Table","color":"#e8912d","properties":{}},
{"id":"r19_smp1006_18","type":"table","category":"seating","x":15.5,"y":23,"width":6,"height":6,"rotation":0,"label":"T1","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_19","type":"table","category":"seating","x":27.5,"y":23,"width":6,"height":6,"rotation":0,"label":"T2","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_20","type":"table","category":"seating","x":66.5,"y":23,"width":6,"height":6,"rotation":0,"label":"T3","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_21","type":"table","category":"seating","x":78.5,"y":23,"width":6,"height":6,"rotation":0,"label":"T4","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_22","type":"table","category":"seating","x":3.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T5","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_23","type":"table","category":"seating","x":15.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T6","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_24","type":"table","category":"seating","x":27.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T7","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_25","type":"table","category":"seating","x":39.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T8","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_26","type":"table","category":"seating","x":54.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T9","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_27","type":"table","category":"seating","x":66.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T10","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_28","type":"table","category":"seating","x":78.5,"y":35,"width":6,"height":6,"rotation":0,"label":"T11","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_29","type":"table","category":"seating","x":27.5,"y":47,"width":6,"height":6,"rotation":0,"label":"T12","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_30","type":"table","category":"seating","x":39.5,"y":47,"width":6,"height":6,"rotation":0,"label":"T13","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_31","type":"table","category":"seating","x":54.5,"y":47,"width":6,"height":6,"rotation":0,"label":"T14","color":"#0d9488","properties":{"seats":10,"shape":"round"}},
{"id":"r19_smp1006_32","type":"table","category":"seating","x":66.5,"y":47,"width":6,"height":6,"rotation":0,"label":"T15","color":"#0d9488","properties":{"seats":10,"shape":"round"}}],"grid":{"snap":true,"show":true,"unit":"ft","sizeFt":1},"margins":{"left":0,"right":0,"top":0,"bottom":0},"venue":{"capacity":200,"room":{"w":100,"h":75},"setting":"outdoor"},"scale":{"pxPerFt":12,"worldFt":{"w":100,"h":75}}}$j$::jsonb
    else null::jsonb end;
$$;

-- one sample event: when its floor is still EMPTY (no saved version with any object on it), its CURRENT version
-- (quotes.current_version - the one the builder opens) gets the plan: the empty placeholder version is filled (nothing
-- on it to lose), or the version is added when there is none. Returns true when a plan was put down. A floor with any
-- object on it, any other version and the quote row are never changed. Internal (migration / owner SQL only).
create or replace function public._a213_fill_floor(p_quote uuid)
returns boolean language plpgsql set search_path = '' as $$
-- sample-layouts-0213
declare q record; v_doc jsonb;
begin
  select x.id, x.org_id, x.code, greatest(coalesce(x.current_version, 1), 1) as cur into q
    from public.quotes x where x.id = p_quote and x.deleted_at is null;
  if q.id is null then return false; end if;
  v_doc := public._a213_sample_layout(q.code);
  if v_doc is null then return false; end if;
  if exists (select 1 from public.quote_versions v where v.quote_id = q.id
              and (v.object_count > 0 or (jsonb_typeof(v.data -> 'items') = 'array' and jsonb_array_length(v.data -> 'items') > 0))) then
    return false; end if;
  if exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = q.cur) then
    update public.quote_versions v
       set data = v_doc, object_count = jsonb_array_length(v_doc -> 'items'), label = 'Sample floor plan'
     where v.quote_id = q.id and v.version_no = q.cur and v.object_count = 0
       and coalesce(jsonb_array_length(case when jsonb_typeof(v.data -> 'items') = 'array' then v.data -> 'items' end), 0) = 0;
  else
    insert into public.quote_versions (id, quote_id, version_no, label, data, object_count, org_id, created_at)
    values (case when q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid
                 then ('a5a5a5a5-0213-4000-8000-0000000005' || substr(q.code, 7, 2))::uuid else gen_random_uuid() end,
            q.id, q.cur, 'Sample floor plan', v_doc, jsonb_array_length(v_doc -> 'items'), q.org_id, now())
    on conflict do nothing;
  end if;
  return found;
end $$;

-- EXISTING free-trial studios (owner-run, optional: supabase/APPLY-0213-refresh-trial-layouts.sql): every studio ON its
-- free trial (subscription 'trial', sample copied, trial not ended, never the master) - or only p_org - gets the plans
-- on its still-empty sample events. Returns how many events got one. Fill-empty / insert only; nothing deleted.
create or replace function public._a213_fill_trial_layouts(p_org uuid default null)
returns integer language plpgsql set search_path = '' as $$
-- sample-layouts-0213
declare r record; v_n integer := 0; v_prev text := coalesce(current_setting('helm.maintenance', true), '');
begin
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows, outbound quiet
  for r in select q.id from public.quotes q
             join public.organizations o on o.id = q.org_id
             join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
            where o.id <> 'a5a5a5a5-0166-4000-8000-000000000001'::uuid and not coalesce(o.is_sample_master, false)
              and (p_org is null or o.id = p_org)
              and o.sample_cloned_at is not null and (o.trial_ends_at is null or o.trial_ends_at > now())
              and q.is_demo and q.deleted_at is null and public._a213_sample_layout(q.code) is not null
            order by q.org_id, q.code loop
    if public._a213_fill_floor(r.id) then v_n := v_n + 1; end if;
  end loop;
  perform set_config('helm.maintenance', v_prev, true);
  return v_n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._a213_manifest_note()', 'public._a213_sample_layout(text)', 'public._a213_fill_floor(uuid)',
                           'public._a213_fill_trial_layouts(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- ---- 1-3) once: the sample master's still-empty events get their floor plan, then publish (current + 1) ----
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  N constant text := public._a213_manifest_note();
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
  r record; v_added integer := 0;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  if exists (select 1 from public.helm_trial_seed_manifest m where m.notes = N) then return; end if;
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows for this change

  for r in select q.id from public.quotes q
            where q.org_id = M and q.deleted_at is null and public._a213_sample_layout(q.code) is not null
            order by q.code loop
    if public._a213_fill_floor(r.id) then v_added := v_added + 1; end if;
  end loop;

  if v_added > 0 and exists (select 1 from public.quotes x where x.org_id = M) then
    perform public.publish_sample_manifest(N);
  end if;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

notify pgrst, 'reload schema';
