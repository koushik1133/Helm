-- APPLY-0182.sql - paste into the Supabase SQL editor (STAGING first; production only when the owner says go).
-- Run AFTER APPLY-0171.sql, APPLY-0175.sql and APPLY-0177.sql. Free trial: the layout builder prices items at the
-- owner's inventory rates (Round Table 500, LED Wall 5000, Stage Barrier 1000 ...; chair 100); the Kapoor Sangeet
-- sample event moves to chair 100; a sample dish / package / inventory row edited in a trial stays sample data.
-- Additive + idempotent: functions + config keys only, nothing deleted, safe to run twice (the 2nd run changes nothing).
begin;
-- 0182_trial_builder_prices.sql - CANONICAL forward-only. REQUIRES 0097 + 0156 + 0166..0171 (+ 0175 for v6).
--
-- In plain words:
--   I-11  The layout builder in a free trial priced items from its in-code defaults (Round Table 1500,
--         LED Wall 18000, Stage Barrier 9000 ...) instead of the owner's inventory rates (500 / 5000 / 1000).
--         The builder reads the studio's pricing config (app_config 'pricing': assetPrices + chairPrice).
--         1  The sample master studio gets assetPrices = the owner's 2026-10-18 rate for EVERY builder
--            item type (142, one per item in public/builder.js ASSETS) and chairPrice 100 (Chair (single)).
--         2  The published snapshot keeps assetPrices + chairPrice, so every NEW trial gets them.
--         3  Existing TRIAL studios cloned from the sample (subscription status trial right now) get
--            assetPrices / chairPrice only where they have none yet; their own edits are kept.
--         4  The Kapoor Family Sangeet sample event (master only) gets chairPrice 100 (was 45). The server
--            pricing engine (D8) re-prices it (452,530 -> 472,000) and its 2 sample milestones and the
--            simulated advance follow (30 % advance 141,600 paid + 70 % balance 330,400), only while they
--            still carry their 0171 values. No money moves; sample rows only.
--         5  A new sample manifest is published once (current + 1). Only NEW trials get it.
--         Steps 1, 4 and 5 run once (marker: the manifest note below), so later owner edits to the
--         master in the app are never overwritten by a re-run.
--   I-14  In a free trial, editing (for example renaming) a sample dish, menu package or inventory item
--         no longer turns it into an own row: it keeps is_demo = true, so "Clear demo data" still
--         removes it and it never counts toward the trial cap. Only rows already is_demo, in a studio
--         cloned from the sample (organizations.sample_batch_id set), whose subscription is trial right
--         now (_is_trial_org), edited by that studio's own member. Every other table, every paid studio
--         and every converted studio keep the 0097 rule (a renamed demo row is adopted as own).
--   No table or column is added or dropped. Nothing is deleted. ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._a97_tg_demo_flag_guard()') is null or to_regprocedure('public._a156_patch(regprocedure,text,text)') is null
     or to_regprocedure('public._is_trial_org(uuid)') is null or to_regclass('public.app_config') is null
     or to_regclass('public.helm_trial_seed_manifest') is null or to_regprocedure('public._sample_studio_settings(uuid)') is null then
    raise exception '0182 needs 0097 + 0156 + 0166 + 0167 + 0168 first'; end if;
end $$;

-- ---- 1) owner rates (one place, so the test and VERIFY read the same list) ----------------------
create or replace function public._a182_owner_asset_prices()
returns jsonb language sql immutable set search_path = '' as $$
  -- trial-prices-0182: owner inventory rates 2026-10-18, by builder item type (INR per unit). Zero = a
  -- layout zone / seat grouping (chairs are charged per seat at chairPrice).
  select '{"aircooler":800,"aislefloral":1000,"altar":3500,"ambulance":0,"arch":6000,"armchair":500,"backdrop":3500,"balloonarch":3500,"balloonbunch":400,"bar":5000,"barricade":150,"barstool":300,"bench":350,"bleacher":12000,"booth":6500,"brandwall":6000,"buffet":2500,"cableramp":300,"caketable":500,"canopy":2000,"centrepiece":1800,"chairrow":0,"chandelier":4000,"chariot":12000,"checkpoint":1500,"chiavari":100,"chocolatefountain":4000,"coatcheck":2500,"cocktail":350,"coffee":1800,"coffeetable":400,"counter":1500,"couplesofa":2500,"dais":12000,"dancefloor":15000,"dancers":12000,"decorbox":500,"desk":800,"dessert":1500,"distro":2000,"diyastand":800,"dj":5000,"doli":7000,"drape":1200,"easel":250,"entrancegate":12000,"exit":0,"extinguisher":500,"fairylights":6000,"fence":500,"firstaid":2500,"flagstand":500,"floral":900,"floralarch":9000,"floralentrance":16000,"floralpillar":2500,"floralstand":900,"flowerwall":8000,"foh":7000,"fountain":8000,"gaddi":1500,"generator":5000,"gifttable":350,"greenroom":6000,"haldi":9000,"hangingfloral":12000,"havankund":1500,"headtable":1500,"heater":1500,"hoarding":3000,"interpreter":12000,"jhoola":7000,"kalash":250,"kidszone":10000,"kiosk":2500,"lanterns":800,"lectern":1500,"led":5000,"ledscreen":8000,"lighting":2500,"lightingtree":1000,"linearray":3500,"livecounter":4000,"longtable":400,"lounge":4500,"loveseat":1000,"mandap":50000,"mehendi":9000,"micstand":150,"monitor":1200,"movinghead":1800,"neonsign":3000,"ottoman":200,"parking":0,"patower":3500,"phoolchadar":4000,"photobooth":10000,"piano":25000,"pillar":1000,"planter":250,"plinth":500,"podium":1500,"press":6000,"projector":2000,"pyro":2500,"rangoli":1200,"recttable":400,"redcarpet":2500,"restroom":8000,"seatblock":0,"selfieframe":2000,"shoerack":350,"signage":700,"smoke":1500,"sofa":1200,"speaker":2500,"stage":18000,"stagebackdrop":22000,"stagebarrier":1000,"stageroof":35000,"stall":4000,"stanchion":250,"subwoofer":2500,"table":500,"teleprompter":4000,"tent":12000,"ticketbooth":3500,"toran":1500,"towerlight":3500,"trophytable":1200,"truck":12000,"truss":2500,"tvstand":4500,"umbrellas":2500,"uplight":300,"urli":1200,"varmala":12000,"videowall":25000,"viprisers":6000,"walkway":3500,"watchtower":6500,"welcomeboard":1000}'::jsonb;
$$;

-- the one-time marker (manifest note); a function so the migration, APPLY, VERIFY and test agree
create or replace function public._a182_manifest_note()
returns text language sql immutable set search_path = '' as $$
  select 'owner builder prices + chair 100 (0182)'::text;
$$;

-- ---- 2) the snapshot keeps assetPrices + chairPrice -------------------------------------------
create or replace function public._sample_studio_settings(p_src uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- trial-data-0168 + trial-data-0169 + trial-prices-0182 (assetPrices / chairPrice)
  select jsonb_build_object(
           'currency', o.currency, 'timezone', o.timezone, 'country', o.country,
           'pricing', coalesce((select jsonb_strip_nulls(jsonb_build_object(
                                  'advancePct', c.value -> 'advancePct', 'balanceDueDays', c.value -> 'balanceDueDays',
                                  'paymentTermsNote', c.value -> 'paymentTermsNote', 'gstPct', c.value -> 'gstPct',
                                  'placeOfSupply', c.value -> 'placeOfSupply', 'taxState', c.value -> 'taxState',
                                  'termsText', c.value -> 'termsText',
                                  'assetPrices', c.value -> 'assetPrices', 'chairPrice', c.value -> 'chairPrice'))
                                from public.app_config c where c.org_id = o.id and c.key = 'pricing'), '{}'::jsonb))
    from public.organizations o where o.id = p_src;
$$;

-- ---- 3) I-14: a sample catalog row edited in a trial stays demo ---------------------------------
create or replace function public._a182_keep_demo(p_table text, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-prices-0182: a sample dish / package / inventory row of the caller's own studio, cloned from
  -- the sample (sample_batch_id set), not the sample master, subscription trial right now
  select coalesce(p_table in ('dish_catalog', 'menu_templates', 'inventory_items')
     and p_org is not null and p_org = public.current_org_id()
     and exists (select 1 from public.organizations o where o.id = p_org
                    and o.sample_batch_id is not null and not coalesce(o.is_sample_master, false))
     and public._is_trial_org(p_org), false);
$$;

do $$
declare f text;
begin
  foreach f in array array['public._a182_owner_asset_prices()', 'public._a182_manifest_note()',
                           'public._sample_studio_settings(uuid)', 'public._a182_keep_demo(text, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- the 0097 guard is SECURITY INVOKER and runs as the signed-in member: it must be able to ask this
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public._a182_keep_demo(text, uuid) to authenticated; end if;
end $$;

select public._a156_patch('public._a97_tg_demo_flag_guard()'::regprocedure,
  $o$if v_label is not null and v_label not like$o$,
  $n$if v_label is not null and not coalesce(public._a182_keep_demo(tg_table_name, (to_jsonb(new) ->> 'org_id')::uuid), false) /* a182 */ and v_label not like$n$);

-- ---- 4) once: master rates + Kapoor chair price, then publish (current + 1) ----------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q5 constant uuid := 'a5a5a5a5-0171-4000-8000-0000000000b5';
  AP constant jsonb := public._a182_owner_asset_prices();
  N constant text := public._a182_manifest_note();
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
  t_old numeric; t_new numeric; a_old numeric; a_new numeric;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  if exists (select 1 from public.helm_trial_seed_manifest m where m.notes = N) then return; end if;
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows for this change

  -- 4a) master pricing: the owner's rate wins for every builder type; other keys are kept
  insert into public.app_config(org_id, key, value, updated_at)
  values (M, 'pricing', jsonb_build_object('assetPrices', AP, 'chairPrice', 100), now())
  on conflict (org_id, key) do update
    set value = public.app_config.value
                || jsonb_build_object('assetPrices', (case when jsonb_typeof(public.app_config.value -> 'assetPrices') = 'object'
                                                           then public.app_config.value -> 'assetPrices' else '{}'::jsonb end) || AP,
                                      'chairPrice', 100),
        updated_at = now();

  -- 4b) Kapoor Family Sangeet: chair 45 -> 100 (only while still on the 0171 value); D8 re-prices the total
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric end into t_old
    from public.quotes q where q.id = q5 and q.org_id = M and jsonb_typeof(q.pricing) = 'object' and q.pricing ->> 'chairPrice' = '45';
  if t_old is not null then
    update public.quotes q set pricing = q.pricing || '{"chairPrice":100}'::jsonb
     where q.id = q5 and q.org_id = M and q.pricing ->> 'chairPrice' = '45';
    select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric end into t_new
      from public.quotes q where q.id = q5 and q.org_id = M;
    -- the 0171 sample money: 30 % advance (paid, simulated) + 70 % balance; follow the new total
    a_old := round(t_old * 0.3); a_new := round(coalesce(t_new, 0) * 0.3);
    if t_new is not null and t_new > 0 and t_new <> t_old
       and exists (select 1 from public.payment_milestones pm where pm.quote_id = q5 and pm.org_id = M and pm.seq = 1
                     and pm.label = 'Advance (30%)' and pm.amount = a_old and pm.status = 'paid')
       and exists (select 1 from public.payment_milestones pm where pm.quote_id = q5 and pm.org_id = M and pm.seq = 2
                     and pm.label = 'Balance (70%)' and pm.amount = t_old - a_old and pm.status = 'due')
       and (select count(*) from public.payment_milestones pm where pm.quote_id = q5) = 2 then
      update public.payment_milestones set amount = a_new
       where quote_id = q5 and org_id = M and seq = 1 and label = 'Advance (30%)' and amount = a_old and status = 'paid';
      update public.payment_milestones set amount = t_new - a_new
       where quote_id = q5 and org_id = M and seq = 2 and label = 'Balance (70%)' and amount = t_old - a_old and status = 'due';
      update public.quote_payments set amount = a_new
       where quote_id = q5 and org_id = M and simulated and receipt_no = 'SMP-R-0004' and amount = a_old;
    end if;
  end if;

  -- 4c) publish once: the snapshot now carries assetPrices + chairPrice
  if to_regprocedure('public.publish_sample_manifest(text)') is not null
     and exists (select 1 from public.quotes x where x.org_id = M) then
    perform public.publish_sample_manifest(N);
  end if;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

-- ---- 5) existing free-trial studios cloned from the sample: only keys they do not have yet ---------
do $$
declare
  AP constant jsonb := public._a182_owner_asset_prices();
  F constant jsonb := jsonb_build_object('assetPrices', public._a182_owner_asset_prices(), 'chairPrice', 100);
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
begin
  perform set_config('helm.maintenance', 'on', true);
  insert into public.app_config(org_id, key, value, updated_at)
  select o.id, 'pricing', F, now()
    from public.organizations o
   where not coalesce(o.is_sample_master, false) and o.sample_batch_id is not null and public._is_trial_org(o.id)
  on conflict (org_id, key) do update
    -- the studio's own keys win; an empty / non-object assetPrices counts as missing
    set value = (F || public.app_config.value)
                || case when jsonb_typeof(public.app_config.value -> 'assetPrices') = 'object'
                             and public.app_config.value -> 'assetPrices' <> '{}'::jsonb then '{}'::jsonb
                        else jsonb_build_object('assetPrices', AP) end,
        updated_at = now()
    where not (jsonb_typeof(public.app_config.value -> 'assetPrices') = 'object' and public.app_config.value -> 'assetPrices' <> '{}'::jsonb)
       or not (public.app_config.value ? 'chairPrice');
  perform set_config('helm.maintenance', v_prev, true);
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true; run right after the apply)
select item, ok from (values
  ('01 master: builder rates = owner list (142 types) + chair 100', coalesce((select c.value -> 'assetPrices' @> public._a182_owner_asset_prices() and c.value ->> 'chairPrice' = '100'
       from public.app_config c where c.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and c.key = 'pricing'), false)
     and (select count(*) from jsonb_object_keys(public._a182_owner_asset_prices())) = 142),
  ('02 the 0182 sample manifest (or a later one, e.g. 0202) is current, published once, carries the rates + chair price', (select count(*) from public.helm_trial_seed_manifest where notes = public._a182_manifest_note()) = 1
     and exists (select 1 from public.helm_trial_seed_manifest m where m.is_current
                   and m.version >= (select x.version from public.helm_trial_seed_manifest x where x.notes = public._a182_manifest_note())
                   and m.payload #> '{studio,pricing,assetPrices}' @> public._a182_owner_asset_prices() and m.payload #>> '{studio,pricing,chairPrice}' = '100')),
  ('03 Kapoor Sangeet: chair 100, milestones add up to the total, advance = 30 %', coalesce((select q.pricing ->> 'chairPrice' = '100'
       and (select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id) = (q.pricing ->> 'total')::numeric
       and (select p.amount from public.quote_payments p where p.quote_id = q.id and p.simulated) = round((q.pricing ->> 'total')::numeric * 0.3)
       from public.quotes q where q.id = 'a5a5a5a5-0171-4000-8000-0000000000b5'), false)),
  ('04 demo guard patched once (a182)', (select (length(prosrc) - length(replace(prosrc, '/* a182 */', ''))) / length('/* a182 */')
       from pg_proc where oid = 'public._a97_tg_demo_flag_guard()'::regprocedure) = 1),
  ('05 every trial studio cloned from the sample has builder rates + a chair price', not exists (select 1 from public.organizations o
       join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
      where not coalesce(o.is_sample_master, false) and o.sample_batch_id is not null
        and not exists (select 1 from public.app_config c where c.org_id = o.id and c.key = 'pricing'
                          and jsonb_typeof(c.value -> 'assetPrices') = 'object' and c.value -> 'assetPrices' <> '{}'::jsonb and c.value ? 'chairPrice'))),
  ('06 no paid studio given the owner list just now', not exists (select 1 from public.app_config c join public.organizations o on o.id = c.org_id
      where c.key = 'pricing' and c.updated_at > now() - interval '15 minutes' and not coalesce(o.is_sample_master, false)
        and c.value -> 'assetPrices' = public._a182_owner_asset_prices()
        and not exists (select 1 from public.studio_subscriptions s where s.org_id = o.id and s.status = 'trial'))),
  ('07 grants: keep-demo check for signed-in members only; rates not callable from the app', has_function_privilege('authenticated', 'public._a182_keep_demo(text, uuid)', 'execute')
     and not has_function_privilege('anon', 'public._a182_keep_demo(text, uuid)', 'execute')
     and not has_function_privilege('anon', 'public._a182_owner_asset_prices()', 'execute')
     and not has_function_privilege('authenticated', 'public._a182_owner_asset_prices()', 'execute')
     and not has_function_privilege('authenticated', 'public._sample_studio_settings(uuid)', 'execute'))
) v(item, ok) order by item;
