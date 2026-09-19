-- =========================================================================
-- Phase 36 — Cluster C2: sectioned wedding task templates
--
-- Meeting: a wedding runs ~500 tasks organised into sections — stage setup,
-- carpets, backdrops, flower decoration, mandapam, lighting, catering, labour,
-- transport (and AV/sound). This seeds a comprehensive, sectioned starter set
-- into task_templates (category = section). Add more anytime — the Operations
-- page reads the sections dynamically. Idempotent (on conflict do nothing).
--
-- RUN AFTER operations.sql (task_templates). Safe to re-run.
-- =========================================================================

insert into public.task_templates (category, title, seq) values
 -- Stage setup
 ('Stage setup','Mark stage footprint',1),('Stage setup','Erect stage trusses',2),
 ('Stage setup','Fix stage platform / decking',3),('Stage setup','Level & anchor stage',4),
 ('Stage setup','Skirting & fascia',5),('Stage setup','Stage stairs & ramp',6),
 ('Stage setup','Safety railing',7),('Stage setup','Load-bearing check',8),
 ('Stage setup','Cable channels & covers',9),('Stage setup','Final stage inspection',10),
 -- Carpets
 ('Carpets','Measure aisle & stage carpet',1),('Carpets','Clean floor before laying',2),
 ('Carpets','Lay main aisle carpet',3),('Carpets','Lay stage carpet',4),
 ('Carpets','Tape & secure carpet edges',5),('Carpets','Walkway carpet to entrance',6),
 ('Carpets','Remove creases & inspect',7),
 -- Backdrops
 ('Backdrops','Install backdrop frame',1),('Backdrops','Hang main backdrop cloth',2),
 ('Backdrops','Fix couple-name panel',3),('Backdrops','Attach side drapes',4),
 ('Backdrops','Steam / iron drapes',5),('Backdrops','Backdrop lighting mounts',6),
 ('Backdrops','Final backdrop alignment',7),
 -- Flower decoration
 ('Flower decoration','Source & inspect flowers',1),('Flower decoration','Stage floral arrangement',2),
 ('Flower decoration','Aisle floral pillars',3),('Flower decoration','Entrance garland / toran',4),
 ('Flower decoration','Table centerpieces',5),('Flower decoration','Mandap floral work',6),
 ('Flower decoration','Car decoration flowers',7),('Flower decoration','Morning-of freshness check',8),
 -- Mandapam
 ('Mandapam','Erect mandap structure',1),('Mandapam','Fix mandap pillars',2),
 ('Mandapam','Canopy / ceiling drape',3),('Mandapam','Havan kund placement',4),
 ('Mandapam','Seating for rituals',5),('Mandapam','Mandap flooring',6),
 ('Mandapam','Priest essentials setup',7),('Mandapam','Mandap final check',8),
 -- Lighting
 ('Lighting','Rig par cans',1),('Lighting','Focus & gel wash lights',2),
 ('Lighting','Uplighters along walls',3),('Lighting','Stage spotlights',4),
 ('Lighting','Fairy / string lights',5),('Lighting','Entrance lighting',6),
 ('Lighting','DMX / console test',7),('Lighting','Generator / backup power check',8),
 -- Catering
 ('Catering','Kitchen / tent setup',1),('Catering','Buffet counters layout',2),
 ('Catering','Live counters setup',3),('Catering','Crockery & cutlery',4),
 ('Catering','Water & beverage station',5),('Catering','Serving staff briefing',6),
 ('Catering','Food safety & hygiene check',7),('Catering','Waste disposal plan',8),
 -- Labour
 ('Labour','Load-in manpower',1),('Labour','Unloading & staging',2),
 ('Labour','Setup crew allocation',3),('Labour','Housekeeping team',4),
 ('Labour','Teardown crew',5),('Labour','Night watch / security',6),
 ('Labour','Break & meal schedule',7),
 -- Transport
 ('Transport','Vehicle scheduling',1),('Transport','Load fragile items',2),
 ('Transport','Route & permit check',3),('Transport','Driver briefing',4),
 ('Transport','On-site parking plan',5),('Transport','Return logistics',6),
 ('Transport','Rental pickup & drop',7),
 -- AV & sound
 ('AV & sound','PA system setup',1),('AV & sound','Microphone check',2),
 ('AV & sound','Mixer soundcheck',3),('AV & sound','Speaker placement',4),
 ('AV & sound','Backup mic ready',5),('AV & sound','Projector / screen test',6)
on conflict (category, title) do nothing;

notify pgrst, 'reload schema';
