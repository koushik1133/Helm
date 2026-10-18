-- ============================================================================
-- 0168_trial_data_v2.sql - CANONICAL forward-only. Free-trial sample data v2: the owner's venues
-- + studio payment terms, and every new trial studio takes the master's studio settings.
-- REQUIRES 0166 + 0167 (sample master studio, helm_trial_seed_manifest, _sample_clone_into,
--          publish_sample_manifest) and 0101 (app_config 'pricing' advancePct / balanceDueDays).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md.
--
-- In plain words:
--   1  Venues: the 4 sample master venues become the owner's 4 Hyderabad venues (Grand Convention
--      Centre, Green Meadows Lawn, Royal Banquet Hall, Square Garden Pavilion). The rows are
--      updated in place (same ids), matched by their old 0167 name; a new venue is added only if
--      no row with its name exists. INR, per day, dummy contacts (@example.com, +91 00000).
--   2  The sample events, checklist and lead that named the old venues now name the new ones.
--   3  Payment terms on the master studio (app_config 'pricing'): advance 30 %, balance due 3 days
--      before the event, payment note. Sample milestones follow them: 30 % advance, balance
--      (70 %) due on event date - 3 (the old 40 % "second instalment" row of the wedding is
--      folded into the balance; its 30 % balance row is removed - master sample rows only).
--   4  The snapshot now also carries the master's studio settings (currency, time zone, country,
--      payment terms). _sample_clone_into is renamed *__pre0168 once and wrapped: after a clone,
--      the trial studio gets INR + Asia/Kolkata + IN + the payment terms (merged into its own
--      pricing config) and the master's item rate cards (all 11 builder item types).
--   5  Manifest v2 is published once ('v2: owner venues + payment terms'). Only NEW trials get it.
--      Roll back: select public.set_current_sample_manifest(1);
--
-- ZERO DATA LOSS: every row written or changed here belongs to the sample master studio (fixed id
-- a5a5a5a5-0166-4000-8000-000000000001), except the clone wrapper, which only writes into the
-- NEW trial studio it has just cloned. No other studio's row is changed or removed. Matching is by
-- the old 0167 values, so owner edits made in the app are never overwritten. ASCII only. Safe to
-- run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into(uuid)') is null or to_regclass('public.helm_trial_seed_manifest') is null then
    raise exception '0168 needs 0166 + 0167 first'; end if;
end $$;

-- ---- 1-3) the owner's data in the sample master ---------------------------------------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q1 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a1';
  q2 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a2';
  q3 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a3';
  q4 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a4';
  D constant text := E'Demo \u00b7 ';
  v record; t1 numeric; t4 numeric; e1 date; e4 date; a1 numeric; b1 numeric;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;

  -- studio settings of the master (already INR / Kolkata / IN from 0166; kept in step)
  update public.organizations set currency = 'INR', timezone = 'Asia/Kolkata', country = 'IN'
   where id = M and (currency is distinct from 'INR' or timezone is distinct from 'Asia/Kolkata' or country is distinct from 'IN');

  -- 1) venues: old 0167 name -> owner venue (same row, same id)
  for v in select * from (values
    ('Sitara Convention Hall', 'Royal Banquet Hall', 'banquet_hall', 'ac', 'indoor', 450, 700, 35::numeric, 22::numeric, 'm',
     array['wedding','reception','engagement','birthday','corporate'], array['no_outside_catering','no_fireworks','sound_curfew'],
     150000, 250000, '23:00', null::text, 'Banjara Hills', 'Hall manager', '+91 00000 00401', 'demo.royalbanquet@example.com',
     'Sample venue. In-house catering only. No fireworks. Music off by 11 pm.'),
    ('Banjara Lawns', 'Green Meadows Lawn', 'lawn', 'non_ac', 'outdoor', null::integer, 2000, 80::numeric, 50::numeric, 'm',
     array['wedding','reception','festival','concert','political','birthday'], array['sound_curfew','generator_required','parking_limited'],
     200000, 400000, '22:00', null::text, 'Shamshabad Road', 'Lawn manager', '+91 00000 00402', 'demo.greenmeadows@example.com',
     'Sample venue. Music off by 10 pm. Generator required. Limited parking - plan valet.'),
    ('Golconda Grand Ballroom', 'Grand Convention Centre, Hitec City', 'convention_centre', 'ac', 'indoor', 1200, 2000, 60::numeric, 40::numeric, 'm',
     array['conference','corporate','product_launch','reception','wedding','concert'], array['decor_vendor_tieup','no_open_flame','setup_window'],
     350000, 600000, null::text, 'Setup from 06:00 on the event day', 'Hitec City', 'Banquet sales', '+91 00000 00403', 'demo.grandconvention@example.com',
     'Sample venue. Decor only through the venue tie-up. No open flame. Fixed setup window.'),
    ('Skyline Rooftop, Kondapur', 'Square Garden Pavilion, Gachibowli', 'lawn', 'non_ac', 'both', 2400, 4000, 60.96::numeric, 60.96::numeric, 'ft',
     array['wedding','reception','engagement','corporate','product_launch','festival','birthday'],
     array['sound_curfew','no_fireworks','no_open_flame','decor_vendor_tieup','parking_limited','setup_window'],
     250000, 450000, '22:00', 'Setup from 06:00 on the event day', 'Gachibowli', 'Pavilion manager', '+91 00000 00404', 'demo.squaregarden@example.com',
     'Sample venue. 200 x 200 ft. Music off by 10 pm. No fireworks or open flame. Decor tie-up only. Limited parking.')
  ) x(old_name, new_name, vtype, ac, setting, seated, floating, len_m, wid_m, unit, evs, rest, cmin, cmax, curfew, setup_win, area,
      cname, cphone, cemail, note) loop
    update public.venues set
           name = D || v.new_name, venue_type = v.vtype, ac_type = v.ac, setting = v.setting,
           seated_capacity = v.seated, floating_capacity = v.floating, length_m = v.len_m, width_m = v.wid_m, dim_unit = v.unit,
           event_types = v.evs, restrictions = v.rest, sound_curfew = v.curfew::time, setup_window = v.setup_win,
           cost_min = v.cmin, cost_max = v.cmax, cost_basis = 'per_day',
           address = D || v.area || ', Hyderabad', city = 'Hyderabad', contact_name = D || v.cname,
           contact_phone = v.cphone, contact_email = v.cemail, notes = v.note
     where org_id = M and name = D || v.old_name
       and not exists (select 1 from public.venues y where y.org_id = M and y.name = D || v.new_name);
    if not exists (select 1 from public.venues y where y.org_id = M and y.name = D || v.new_name) then
      insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                                event_types, restrictions, sound_curfew, setup_window, cost_min, cost_max, cost_basis,
                                address, city, contact_name, contact_phone, contact_email, notes)
      values (M, D || v.new_name, v.vtype, v.ac, v.setting, v.seated, v.floating, v.len_m, v.wid_m, v.unit,
              v.evs, v.rest, v.curfew::time, v.setup_win, v.cmin, v.cmax, 'per_day',
              D || v.area || ', Hyderabad', 'Hyderabad', D || v.cname, v.cphone, v.cemail, v.note);
    end if;
  end loop;

  -- 2) the sample events name the new venues (only where they still name the old 0167 venue)
  update public.quotes q set client = jsonb_set(q.client, '{venue}', to_jsonb(D || x.new_name))
    from (values (q1, 'Sitara Convention Hall', 'Royal Banquet Hall'),
                 (q2, 'Golconda Grand Ballroom', 'Square Garden Pavilion, Gachibowli'),
                 (q3, 'Skyline Rooftop, Kondapur', 'Grand Convention Centre, Hitec City'),
                 (q4, 'Banjara Lawns', 'Royal Banquet Hall')) x(id, old_name, new_name)
   where q.org_id = M and q.id = x.id and q.client ->> 'venue' = D || x.old_name;
  update public.event_checklist set title = 'Confirm hall booking with Royal Banquet Hall'
   where org_id = M and quote_id = q1 and title = 'Confirm hall booking with Sitara';
  update public.leads set notes = 'Sample lead. Site visit at Green Meadows Lawn booked.'
   where org_id = M and notes = 'Sample lead. Site visit at Banjara Lawns booked.';
  update public.quote_versions set data = jsonb_set(data, '{venue,capacity}', '450'::jsonb)
   where org_id = M and quote_id = q1 and version_no = 1 and data #>> '{venue,capacity}' = '600';

  -- 3) payment terms of the studio (merged into its pricing config; other keys kept)
  insert into public.app_config(org_id, key, value)
  values (M, 'pricing', jsonb_build_object('advancePct', 30, 'balanceDueDays', 3,
          'paymentTermsNote', '30% advance to confirm; balance due 3 days before event. Final terms subject to client agreement.'))
  on conflict (org_id, key) do update
    set value = public.app_config.value || excluded.value, updated_at = now()
  where coalesce(public.app_config.value ->> 'advancePct', '') = '' or not (public.app_config.value ? 'paymentTermsNote');

  -- sample milestones: 30 % advance, balance due event date - 3 (still on the 0167 shape only)
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end, q.event_date
    into t1, e1 from public.quotes q where q.id = q1 and q.org_id = M;
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end, q.event_date
    into t4, e4 from public.quotes q where q.id = q4 and q.org_id = M;
  a1 := round(coalesce(t1, 0) * 0.3); b1 := round(coalesce(t4, 0) * 0.3);

  if e1 is not null and exists (select 1 from public.payment_milestones pm
                                 where pm.org_id = M and pm.quote_id = q1 and pm.seq = 2 and pm.label = 'Second instalment (40%)') then
    delete from public.payment_milestones
     where org_id = M and quote_id = q1 and seq = 3 and label = 'Balance (30%)' and status <> 'paid';
    update public.payment_milestones set label = 'Balance (70%)', due_date = e1 - 3, amount = t1 - a1, status = 'due',
           note = 'Sample milestone - no money moves. Balance due 3 days before the event.'
     where org_id = M and quote_id = q1 and seq = 2 and label = 'Second instalment (40%)';
  end if;

  if e4 is not null and exists (select 1 from public.payment_milestones pm
                                 where pm.org_id = M and pm.quote_id = q4 and pm.label = 'Advance (50%)') then
    update public.payment_milestones set label = 'Advance (30%)', amount = b1
     where org_id = M and quote_id = q4 and seq = 1 and label = 'Advance (50%)';
    update public.payment_milestones set label = 'Balance (70%)', amount = t4 - b1, due_date = e4 - 3
     where org_id = M and quote_id = q4 and seq = 2 and label = 'Balance (50%)';
    update public.quote_payments set amount = b1 where org_id = M and quote_id = q4 and receipt_no = 'SMP-R-0002' and simulated;
    update public.quote_payments set amount = t4 - b1 where org_id = M and quote_id = q4 and receipt_no = 'SMP-R-0003' and simulated;
  end if;

  update public.helm_sample_template
     set notes = 'Sample dataset v2 (India): owner venues + payment terms (0168). Edit the master studio, then publish_sample_manifest(). Switch: active.',
         updated_at = now()
   where id and org_id = M and coalesce(notes, '') not like 'Sample dataset v2%';
end $$;

-- ---- 4a) the snapshot carries the master's studio settings ----------------------------------------
create or replace function public._sample_studio_settings(p_src uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- trial-data-0168: currency / time zone / country + payment terms of one studio
  select jsonb_build_object(
           'currency', o.currency, 'timezone', o.timezone, 'country', o.country,
           'pricing', coalesce((select jsonb_strip_nulls(jsonb_build_object(
                                  'advancePct', c.value -> 'advancePct', 'balanceDueDays', c.value -> 'balanceDueDays',
                                  'paymentTermsNote', c.value -> 'paymentTermsNote'))
                                from public.app_config c where c.org_id = o.id and c.key = 'pricing'), '{}'::jsonb))
    from public.organizations o where o.id = p_src;
$$;

create or replace function public._sample_snapshot(p_src uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-sample-0167 + trial-data-0168 (studio settings)
declare t text; v_rows jsonb; v_tables jsonb := '{}'::jsonb; v_counts jsonb := '{}'::jsonb; v_has_created boolean;
begin
  foreach t in array public._sample_clone_tables() loop
    if to_regclass('public.' || t) is null then continue; end if;
    v_has_created := exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = format('public.%I', t)::regclass
                               and a.attname = 'created_at' and not a.attisdropped);
    execute format('select coalesce(jsonb_agg(to_jsonb(x) order by %s), ''[]''::jsonb) from public.%I x where x.org_id = $1',
                   case when v_has_created then 'x.created_at, to_jsonb(x)::text' else 'to_jsonb(x)::text' end, t)
      into v_rows using p_src;
    v_tables := v_tables || jsonb_build_object(t, v_rows);
    v_counts := v_counts || jsonb_build_object(t, jsonb_array_length(v_rows));
  end loop;
  return jsonb_build_object('tables', v_tables, 'counts', v_counts, 'studio', public._sample_studio_settings(p_src));
end $$;

create or replace function public.publish_sample_manifest(p_notes text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167: snapshot the sample master into a NEW frozen version and make it current
-- trial-data-0168: the payload also keeps the master's studio settings ('studio')
declare tpl public.helm_sample_template; v_snap jsonb; v_ver integer; v_real integer;
begin
  if not public._sample_publish_ok() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  if tpl.org_id is null then raise exception 'no sample master studio is configured' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:sample_publish', 0));
  v_snap := public._sample_snapshot(tpl.org_id);
  if coalesce((v_snap #>> '{counts,quotes}')::integer, 0) + coalesce((v_snap #>> '{counts,inventory_items}')::integer, 0) = 0 then
    raise exception 'the sample master studio is empty - nothing to publish' using errcode = '22023'; end if;
  -- warn-level check: contact values that are not obviously dummy (they are rewritten at seed time anyway)
  select count(*) into v_real
    from jsonb_each(v_snap -> 'tables') t(k, rows), jsonb_array_elements(t.rows) r(j)
   where (coalesce(r.j ->> 'email', '') <> '' and lower(r.j ->> 'email') not like '%@example.com')
      or (coalesce(r.j ->> 'phone', '') <> '' and right(regexp_replace(r.j ->> 'phone', '\D', '', 'g'), 10) not like '00000%');
  select coalesce(max(m.version), 0) + 1 into v_ver from public.helm_trial_seed_manifest m;
  update public.helm_trial_seed_manifest set is_current = false where is_current;
  insert into public.helm_trial_seed_manifest(version, source_org, anchor_date, payload, counts, is_current, published_by, notes)
    values (v_ver, tpl.org_id, tpl.anchor_date,
            jsonb_strip_nulls(jsonb_build_object('tables', v_snap -> 'tables', 'studio', v_snap -> 'studio')),
            v_snap -> 'counts', true, auth.uid(), left(p_notes, 2000));
  update public.helm_sample_template set version = v_ver, updated_at = now() where id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_published', 'helm_trial_seed_manifest', v_ver::text,
            jsonb_build_object('version', v_ver, 'counts', v_snap -> 'counts', 'non_dummy_contacts', v_real), tpl.org_id, now());
  return jsonb_build_object('version', v_ver, 'counts', v_snap -> 'counts', 'anchor_date', tpl.anchor_date,
                            'non_dummy_contacts_rewritten_at_seed', v_real);
end $$;

-- ---- 4b) clone wrapper: the new trial studio takes the master's studio settings --------------------
do $$ begin
  if to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null then
    alter function public._sample_clone_into(uuid) rename to _sample_clone_into__pre0168;
  end if;
end $$;

create or replace function public._sample_clone_into(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-data-0168 (wraps trial-sample-0167 / trial-sandbox-0166): clone, then the studio settings
declare r jsonb; m public.helm_trial_seed_manifest; s jsonb; v_terms jsonb; n integer := 0;
begin
  r := public._sample_clone_into__pre0168(p_org);
  if coalesce((r ->> 'cloned')::boolean, false) is not true then return r; end if;
  select * into m from public.helm_trial_seed_manifest x where x.is_current;
  -- the published settings; a manifest without them (v1) uses the sample master's live settings
  s := coalesce(m.payload -> 'studio', public._sample_studio_settings(m.source_org), '{}'::jsonb);
  if p_org = m.source_org or exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then return r; end if;

  update public.organizations o
     set currency = coalesce(nullif(s ->> 'currency', ''), o.currency),
         timezone = coalesce(nullif(s ->> 'timezone', ''), o.timezone),
         country  = coalesce(nullif(s ->> 'country', ''), o.country)
   where o.id = p_org;

  v_terms := coalesce(s -> 'pricing', '{}'::jsonb);
  if jsonb_typeof(v_terms) = 'object' and v_terms <> '{}'::jsonb then
    insert into public.app_config(org_id, key, value) values (p_org, 'pricing', v_terms)
    on conflict (org_id, key) do update set value = public.app_config.value || excluded.value, updated_at = now();
  end if;

  -- every builder item type at the master's rates (the studio trigger already seeded the defaults)
  if to_regclass('public.item_rate_cards') is not null then
    insert into public.item_rate_cards(org_id, item_type, rates)
    select p_org, e.j ->> 'item_type', e.j -> 'rates'
      from jsonb_array_elements(coalesce(m.payload #> '{tables,item_rate_cards}', '[]'::jsonb)) e(j)
     where coalesce(e.j ->> 'item_type', '') <> '' and jsonb_typeof(e.j -> 'rates') = 'object'
    on conflict (org_id, item_type) do update set rates = excluded.rates;
    get diagnostics n = row_count;
  end if;

  return r || jsonb_build_object('studio_settings', jsonb_build_object(
    'currency', s ->> 'currency', 'timezone', s ->> 'timezone', 'payment_terms', v_terms <> '{}'::jsonb, 'rate_cards', n));
end $$;

-- ---- privileges: the clone stays definer / service role only (publish keeps its 0167 grants) --------
do $$
declare f text;
begin
  foreach f in array array['public._sample_clone_into(uuid)', 'public._sample_clone_into__pre0168(uuid)',
                           'public._sample_studio_settings(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._sample_clone_into(uuid)', 'public._sample_clone_into__pre0168(uuid)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;

-- ---- 5) publish v2 once ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001' and o.is_sample_master)
     and exists (select 1 from public.quotes x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid)
     and not exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'v2: owner venues + payment terms') then
    perform public.publish_sample_manifest('v2: owner venues + payment terms');
  end if;
end $$;
