-- =========================================================================
-- Phase 94 — Seed Control Center: object/item prices, coupons, 5 templates.
-- SAFE + IDEMPOTENT + ADDITIVE. Run in the Supabase SQL editor (as owner).
--
--   • No ON CONFLICT (works without unique constraints on key/code).
--   • Detects whether coupons / checklist_templates have an org_id column and
--     stamps it only when present (so it also works on databases that never ran
--     the multi-tenant migration).
--   • assetPrices only added to the global pricing blob if not already set.
--   • Coupons / templates inserted only when missing.
--   • Reports what it did via RAISE NOTICE (see the "Messages"/log output).
--
-- Nothing is ever overwritten or deleted. Re-running changes nothing further.
--
-- RUN THIS BLOCK ON ITS OWN, then run the separate verify query at the bottom
-- in a SECOND run (so a verify error can never roll the seed back).
-- =========================================================================

do $$
declare
  v_org uuid;
  v_has_coupon_org  boolean;
  v_has_tpl_org     boolean;
  v_before_coupons  bigint;
  v_before_tpl      bigint;
  v_after_coupons   bigint;
  v_after_tpl       bigint;
begin
  -- 1) Resolve the target studio (org) --------------------------------------
  select p.org_id into v_org
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(u.email) = 'admin@helm.com'
   limit 1;
  if v_org is null then
    v_org := '00000000-0000-4000-8000-000000000001';  -- default Helm org (phase56)
  end if;

  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='coupons' and column_name='org_id')
    into v_has_coupon_org;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='checklist_templates' and column_name='org_id')
    into v_has_tpl_org;

  select count(*) into v_before_coupons from public.coupons;
  select count(*) into v_before_tpl      from public.checklist_templates;
  raise notice 'org=%  coupons.org_id=%  templates.org_id=%  (before: coupons=%, templates=%)',
    v_org, v_has_coupon_org, v_has_tpl_org, v_before_coupons, v_before_tpl;

  -- 2) Object & item prices: add assetPrices to the global pricing blob ------
  if not exists (select 1 from public.app_config where key = 'pricing') then
    insert into public.app_config(key, value)
    values ('pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"cateringGstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb);
  end if;

  update public.app_config
     set value = value || jsonb_build_object('assetPrices', jsonb_build_object(
           'stage',45000,'tent',35000,'canopy',25000,'mandap',75000,'arch',9000,'floralarch',15000,
           'dancefloor',20000,'redcarpet',8000,'viprisers',18000,'truss',6000,
           'videowall',120000,'ledscreen',60000,'linearray',40000,'subwoofer',12000,'foh',20000,
           'piano',30000,'press',15000,'dj',10000,'photobooth',12000,
           'bar',12000,'buffet',9000,'truck',25000,'greenroom',8000,'generator',15000,'parking',10000,
           'chandelier',12000,'fountain',20000,'restroom',12000,'coatcheck',5000,'firstaid',4000
         )),
         updated_at = now()
   where key = 'pricing'
     and not (value ? 'assetPrices');

  -- 3) Coupons (idempotent by code; org_id only if the column exists) --------
  if v_has_coupon_org then
    insert into public.coupons(code, kind, value, note, active, org_id)
    select x.code, x.kind, x.value, x.note, true, v_org
      from (values
        ('WELCOME10','percent',10::numeric,'10% off for new clients'),
        ('EARLYBIRD','percent',15::numeric,'Early-booking discount'),
        ('FLAT5000', 'flat',   5000::numeric,'INR 5,000 off large events'),
        ('FESTIVE20','percent',20::numeric,'Festive-season promotion'),
        ('REFERRAL', 'flat',   2500::numeric,'Referral reward')
      ) as x(code, kind, value, note)
     where not exists (select 1 from public.coupons c where c.code = x.code);
  else
    insert into public.coupons(code, kind, value, note, active)
    select x.code, x.kind, x.value, x.note, true
      from (values
        ('WELCOME10','percent',10::numeric,'10% off for new clients'),
        ('EARLYBIRD','percent',15::numeric,'Early-booking discount'),
        ('FLAT5000', 'flat',   5000::numeric,'INR 5,000 off large events'),
        ('FESTIVE20','percent',20::numeric,'Festive-season promotion'),
        ('REFERRAL', 'flat',   2500::numeric,'Referral reward')
      ) as x(code, kind, value, note)
     where not exists (select 1 from public.coupons c where c.code = x.code);
  end if;

  -- 4) Five checklist templates (idempotent by name; org_id only if present) --
  if v_has_tpl_org then
    insert into public.checklist_templates(name, section, items, notes, org_id)
    select v.name, v.section, v.items, v.notes, v_org
      from (values
        ('Wedding — day-of run','logistics',
          '["Confirm venue access time","Vendor load-in schedule","Mandap / stage setup","Sound check","Catering headcount lock","Guest welcome desk","Photographer shot list","Teardown & handover"]'::jsonb,'Standard wedding day-of checklist'),
        ('Corporate conference','logistics',
          '["Registration desk setup","AV & projector test","Speaker green room","Wi-Fi credentials posted","Lunch & tea breaks","Signage & wayfinding","Recording / streaming check","Feedback forms"]'::jsonb,'Conference / seminar setup'),
        ('Compliance & permits','compliance',
          '["Venue fire-safety clearance","Public-liability insurance","Music/PPL licence","Alcohol permit (if bar)","Local authority noise permit","Vendor GST invoices on file"]'::jsonb,'Regulatory sign-offs before the event'),
        ('Client communications','comms',
          '["Send proposal for approval","Share advance-payment link","Confirm final guest count","Circulate run-sheet to client","Post-event thank-you note","Request review / testimonial"]'::jsonb,'Client touch-points across the lifecycle'),
        ('Guest management','guests',
          '["Import guest list","Send digital invitations","Track RSVPs","Assign seating / tables","Prepare name badges","Arrange special-access / VIP list"]'::jsonb,'Guest list & RSVP workflow')
      ) as v(name, section, items, notes)
     where not exists (select 1 from public.checklist_templates t where t.name = v.name and t.org_id = v_org);
  else
    insert into public.checklist_templates(name, section, items, notes)
    select v.name, v.section, v.items, v.notes
      from (values
        ('Wedding — day-of run','logistics',
          '["Confirm venue access time","Vendor load-in schedule","Mandap / stage setup","Sound check","Catering headcount lock","Guest welcome desk","Photographer shot list","Teardown & handover"]'::jsonb,'Standard wedding day-of checklist'),
        ('Corporate conference','logistics',
          '["Registration desk setup","AV & projector test","Speaker green room","Wi-Fi credentials posted","Lunch & tea breaks","Signage & wayfinding","Recording / streaming check","Feedback forms"]'::jsonb,'Conference / seminar setup'),
        ('Compliance & permits','compliance',
          '["Venue fire-safety clearance","Public-liability insurance","Music/PPL licence","Alcohol permit (if bar)","Local authority noise permit","Vendor GST invoices on file"]'::jsonb,'Regulatory sign-offs before the event'),
        ('Client communications','comms',
          '["Send proposal for approval","Share advance-payment link","Confirm final guest count","Circulate run-sheet to client","Post-event thank-you note","Request review / testimonial"]'::jsonb,'Client touch-points across the lifecycle'),
        ('Guest management','guests',
          '["Import guest list","Send digital invitations","Track RSVPs","Assign seating / tables","Prepare name badges","Arrange special-access / VIP list"]'::jsonb,'Guest list & RSVP workflow')
      ) as v(name, section, items, notes)
     where not exists (select 1 from public.checklist_templates t where t.name = v.name);
  end if;

  select count(*) into v_after_coupons from public.coupons;
  select count(*) into v_after_tpl      from public.checklist_templates;
  raise notice 'DONE. coupons % -> %  templates % -> %  (assetPrices set)',
    v_before_coupons, v_after_coupons, v_before_tpl, v_after_tpl;
end $$;
