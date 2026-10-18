-- APPLY-0237.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0202.sql (APPLY-RELEASE-1018.sql runs everything in the right order in one paste).
-- Free trial sample data complete (QA of the release build, B11): a layout version 1 for every sample event, the
-- wedding (SMP-1001) and gala (SMP-1003) floor plans (+ the 3 matching layout templates) seat their guest count, the
-- sample events carry their menu
-- package in the event plan, the sample studio has layout rules / chair types / plate types, and the sample layout
-- templates are counted in the sample-data summary. A new sample version is published once (NEW trials get it).
-- Existing trials get only the MISSING rows (insert only); APPLY-0178-refresh-trials.sql (the last section of
-- APPLY-RELEASE-1018.sql) moves them to the new sample version. Nothing deleted; paid studios untouched.
-- Safe to run twice (the 2nd run changes nothing). ASCII only.
begin;
-- 0237_trial_seed_completeness.sql - CANONICAL forward-only. The free-trial sample data is complete and
-- consistent (local QA of the release build, bug B11).
-- REQUIRES 0167 (sample master + publish_sample_manifest), 0168 (_sample_snapshot), 0169 (_sample_clone_tables,
--          the wedding / round-tables floor plans), 0171 (the 7 sample events), 0190 (set-wise clone, rows
--          without an id), 0202 (current clone list), 0127 (my_demo_status), base (event_plan, layout_rules,
--          chair_types, plate_types, quote_versions).
--
-- In plain words:
--   1  Every sample event has a layout version 1. Five of the seven sample events had no quote_versions row
--      (the builder opened them with nothing to save onto). The sample master gets an EMPTY version 1
--      ({"items": []}, 0 objects - what a new event gets) for each event that has none.
--   2  The two sample floor plans seat the guest count (they were over capacity):
--        SMP-1001 wedding (450 guests): 974 seats against a 450 limit -> the two seating blocks become 8 x 25
--          and 8 x 22 (+ 24 sofas + 2 armchairs) = 450 seats; venue limit 520 (the lawn is open-air).
--        SMP-1003 corporate gala (120 guests): 132 seats against 120 -> tables T9-T12 seat 9 (were 12) =
--          120 seats; hall limit 140.
--      The matching sample layout templates (Wedding - Grand Lawn, Reception - Lawn reception (450 guests), Corporate -
--      Round tables gala (120 guests)) get the same fit, so a plan still equals its template. Only while a plan is
--      still the shipped one (an owner edit in the master is never overwritten).
--   3  The sample events carry their menu package in the event plan (event_plan.menu_template + price per
--      plate + venue name), taken from the event's own pricing; events past Planning have the menu locked
--      (the 0198 Planning gate). Only events with no event plan yet.
--   4  The sample studio gets layout rules (8 event types), 3 chair types (plastic 25 / cushioned banquet 45 /
--      Chiavari 100 - the sample events' chair prices) and 3 plate types (vegetarian 700 / non-vegetarian 950 /
--      special 1400), so Control Center -> Layout rules and Menus & catalog are not empty in a trial (where new
--      rows cannot be added). Only into an empty list; fixed ids; on conflict do nothing.
--   5  The sample copy includes them: _sample_clone_tables() + 'layout_rules', 'chair_types', 'plate_types'
--      (after the layout templates) and 'event_plan' (after the requirements). Chair / plate types and layout
--      rules have no is_demo column: they stay with the studio (price list / settings) when the sample is
--      cleared; event_plan goes with its sample event (quote_id cascades).
--   6  my_demo_status(): 'layouts' also counts the studio's sample layout templates (active, named "Demo . ...",
--      the ones "Clear sample data" archives) - it said 0 while 3 templates were there. has_demo / demo_rows are
--      unchanged (templates alone never count as "sample data still in the studio").
--   7  ONE new sample manifest is published (current + 1, marker 'sample completeness (0237)'): every NEW trial
--      gets all of the above.
--   8  Existing free-trial studios (subscription 'trial', sample already copied, never the master), INSERT ONLY,
--      only where missing: an empty version 1 for a sample event with none, the event plan from the sample
--      event's own pricing, and the master's layout rules / chair types / plate types when the studio has
--      none in that list. Their existing floor plans are not rewritten (no update of a trial's rows): the
--      owner-run APPLY-0178-refresh-trials.sql (last section of APPLY-RELEASE-1018.sql) moves them to the new
--      sample.
--   No table, column, index, policy or trigger is added or dropped; paid studios are not touched; nothing is
--   deleted. Rows are added (master + trial studios, where missing) and two shipped master floor plans
--   updated (+ the 3 matching templates). ASCII only (the multiplication sign of the seating labels is chr(215)). Safe to run twice.

do $$ begin
  if to_regclass('public.helm_trial_seed_manifest') is null or to_regprocedure('public._sample_clone_tables()') is null
     or to_regprocedure('public._sample_snapshot(uuid)') is null or to_regprocedure('public.publish_sample_manifest(text)') is null
     or to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null or to_regprocedure('public.my_demo_status()') is null then
    raise exception '0237 needs 0167 + 0168 + 0169 + 0190 + 0127 first'; end if;
  if to_regclass('public.event_plan') is null or to_regclass('public.layout_rules') is null
     or to_regclass('public.chair_types') is null or to_regclass('public.plate_types') is null
     or to_regclass('public.quote_versions') is null or to_regclass('public.studio_layout_templates') is null then
    raise exception '0237 needs event_plan, layout_rules, chair_types, plate_types, quote_versions, studio_layout_templates'; end if;
end $$;

-- ---- 5) the sample copy includes the settings lists + the event plan -------------------------------------
create or replace function public._sample_clone_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-data-0169 (trial-sample-0167, trial-sandbox-0166) + trial-reqs-0202 (event_requirements)
  -- + trial-seed-0237 (layout_rules, chair_types, plate_types, event_plan)
  select array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates',
               'item_rate_cards', 'checklist_templates', 'task_templates', 'coupons', 'studio_layout_templates',
               'layout_rules', 'chair_types', 'plate_types',
               'leads', 'quotes', 'quote_versions', 'event_discovery', 'event_requirements', 'event_plan', 'payment_milestones', 'quote_payments',
               'event_checklist', 'event_tasks', 'run_sheet_items', 'inventory_reservations',
               'event_costs', 'event_closure', 'nurture']::text[];
$$;

create or replace function public._a237_manifest_note()
returns text language sql immutable set search_path = '' as $$
  select 'sample completeness (0237)'::text;
$$;

-- the sample settings lists: (kind, id, name / event type, price, rules, seq) - one place for the migration,
-- VERIFY and the test
create or replace function public._a237_sample_settings()
returns table (kind text, id uuid, name text, price numeric, rules jsonb, seq integer)
language sql immutable set search_path = '' as $$
  -- trial-seed-0237
  select x.k, x.i::uuid, x.n, x.p, x.r::jsonb, x.s
    from (values
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000101', 'wedding', null::numeric, '{"seatsPerGuest":1,"buffetPer":75,"bars":1,"stage":true,"dancefloor":true,"walkway":true,"dj":true}', 1),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000102', 'reception', null, '{"seatsPerGuest":1,"buffetPer":75,"bars":1,"stage":true,"dancefloor":true,"walkway":true,"dj":true}', 2),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000103', 'engagement', null, '{"seatsPerGuest":1,"buffetPer":80,"bars":1,"stage":true,"dancefloor":true,"walkway":false,"dj":true}', 3),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000104', 'sangeet', null, '{"seatsPerGuest":0.8,"buffetPer":80,"bars":1,"stage":true,"dancefloor":true,"walkway":false,"dj":true}', 4),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000105', 'corporate', null, '{"seatsPerGuest":1,"buffetPer":100,"bars":0,"stage":true,"dancefloor":false,"walkway":false,"dj":false}', 5),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000106', 'conference', null, '{"seatsPerGuest":1,"buffetPer":100,"bars":0,"stage":true,"dancefloor":false,"walkway":false,"dj":false}', 6),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000107', 'product launch', null, '{"seatsPerGuest":0.6,"buffetPer":100,"bars":1,"stage":true,"dancefloor":false,"walkway":true,"dj":true}', 7),
      ('layout_rule', 'a5a5a5a5-0237-4000-8000-000000000108', 'housewarming', null, '{"seatsPerGuest":0.7,"buffetPer":75,"bars":0,"stage":false,"dancefloor":false,"walkway":false,"dj":false}', 8),
      ('chair_type', 'a5a5a5a5-0237-4000-8000-000000000201', 'Plastic chair', 25, null, 1),
      ('chair_type', 'a5a5a5a5-0237-4000-8000-000000000202', 'Cushioned banquet chair', 45, null, 2),
      ('chair_type', 'a5a5a5a5-0237-4000-8000-000000000203', 'Chiavari chair', 100, null, 3),
      ('plate_type', 'a5a5a5a5-0237-4000-8000-000000000301', 'Vegetarian', 700, null, 1),
      ('plate_type', 'a5a5a5a5-0237-4000-8000-000000000302', 'Non-vegetarian', 950, null, 2),
      ('plate_type', 'a5a5a5a5-0237-4000-8000-000000000303', 'Special / premium', 1400, null, 3)
    ) x(k, i, n, p, r, s);
$$;

-- the shipped over-capacity sample floor plans, fitted to their guest count (any other plan comes back unchanged):
--   450-guest lawn plan (wedding / reception): seating blocks 20 x 25 + 16 x 25 (+ 24 sofas, 2 armchairs) = 974 seats,
--     limit 450 -> 8 x 25 + 8 x 22 = 450 seats, limit 520
--   120-guest round tables gala: tables T9-T12 seat 12 = 132 seats, limit 120 -> they seat 9 = 120 seats, limit 140
create or replace function public._a237_fit_layout(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- trial-seed-0237
  select case
    when jsonb_typeof(p -> 'items') = 'array'
     and p @> '{"venue":{"capacity":450},"items":[{"id":"obj_439d","type":"seatblock","properties":{"rows":20,"cols":25}},{"id":"obj_59gi","type":"seatblock","properties":{"rows":16,"cols":25}}]}'::jsonb
    then jsonb_set(jsonb_set(p, '{items}',
           (select jsonb_agg(case e.i ->> 'id'
                     when 'obj_439d' then e.i || jsonb_build_object('height', 19.2, 'label', 'Seating 8' || chr(215) || '25',
                                            'properties', (e.i -> 'properties') || '{"rows":8,"cols":25}'::jsonb)
                     when 'obj_59gi' then e.i || jsonb_build_object('width', 52.8, 'height', 19.2, 'label', 'Seating 8' || chr(215) || '22',
                                            'properties', (e.i -> 'properties') || '{"rows":8,"cols":22}'::jsonb)
                     else e.i end order by e.n)
              from jsonb_array_elements(p -> 'items') with ordinality e(i, n))),
         '{venue,capacity}', '520'::jsonb, true)
    when jsonb_typeof(p -> 'items') = 'array'
     and p @> '{"venue":{"capacity":120},"items":[{"id":"obj_7uq7c","properties":{"seats":12}},{"id":"obj_7vq7c","properties":{"seats":12}},{"id":"obj_7wq7c","properties":{"seats":12}},{"id":"obj_7xq7c","properties":{"seats":12}}]}'::jsonb
    then jsonb_set(jsonb_set(p, '{items}',
           (select jsonb_agg(case when e.i ->> 'id' in ('obj_7uq7c', 'obj_7vq7c', 'obj_7wq7c', 'obj_7xq7c')
                     then e.i || jsonb_build_object('properties', (e.i -> 'properties') || '{"seats":9}'::jsonb)
                     else e.i end order by e.n)
              from jsonb_array_elements(p -> 'items') with ordinality e(i, n))),
         '{venue,capacity}', '140'::jsonb, true)
    else p end;
$$;

-- ---- 6) my_demo_status: the 0127 body; 'layouts' also counts the sample layout templates ------------------
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-start-fresh-0123 helm-0127-demo-choice trial-seed-0237 (sample layout templates counted)
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int; v_counts jsonb;
  v_choice text; v_trial boolean; v_tpl int;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode, o.demo_choice, o.trial_ends_at is not null into v_mode, v_choice, v_trial
    from public.organizations o where o.id = v_org;
  -- the sample templates the clone copies (0169 / 0175); "Clear sample data" archives exactly these
  select count(*) into v_tpl from public.studio_layout_templates t
   where t.org_id = v_org and not t.archived and t.name like E'Demo \u00b7 %';
  v_counts := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and is_demo),
    'leads',     (select count(*) from public.leads where org_id = v_org and is_demo),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and is_demo and active),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and is_demo) + v_tpl);
  select (select count(*) from public.quotes where org_id = v_org and is_demo)
       + (select count(*) from public.leads where org_id = v_org and is_demo)
       + (select count(*) from public.crew_members where org_id = v_org and is_demo)
       + (select count(*) from public.vendors where org_id = v_org and is_demo)
       + (select count(*) from public.inventory_items where org_id = v_org and is_demo)
       + (select count(*) from public.venues where org_id = v_org and is_demo and active)
       + (select count(*) from public.menu_templates where org_id = v_org and is_demo)
       + (select count(*) from public.layouts where org_id = v_org and is_demo)
    into v_rows;   -- the templates are only shown in counts.layouts, never in has_demo / demo_rows: 0175 gave EVERY
                   -- trial studio (also checkout trials and ones that had cleared their samples) a "Demo . Reception"
                   -- template, which must not bring back a "Demo data is still in your studio" card
  return jsonb_build_object('trial_mode', v_mode, 'demo_rows', v_rows, 'has_demo', v_rows > 0,
    'is_admin', coalesce(public.is_admin(), false), 'counts', v_counts,
    'demo_choice', v_choice, 'choice_pending', coalesce(v_trial, false) and v_choice is null and v_rows > 0);
end $$;
revoke all on function public.my_demo_status() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;

do $$
declare f text;
begin
  foreach f in array array['public._sample_clone_tables()', 'public._a237_manifest_note()', 'public._a237_sample_settings()',
                           'public._a237_fit_layout(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- ---- 1-4 + 7) once: the sample master, then publish (current + 1) -----------------------------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  q1 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a1';
  q3 constant uuid := 'a5a5a5a5-0167-4000-8000-0000000000a3';
  N constant text := public._a237_manifest_note();
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  if exists (select 1 from public.helm_trial_seed_manifest m where m.notes = N) then return; end if;
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows for this change

  -- 1) an empty version 1 for every master event that has none (fixed ids, created in event order)
  insert into public.quote_versions (id, quote_id, version_no, data, object_count, org_id, created_at)
  select ('a5a5a5a5-0237-4000-8000-0000000004' || lpad(row_number() over (order by q.code, q.id)::text, 2, '0'))::uuid,
         q.id, 1, '{"items":[]}'::jsonb, 0, M, now()
    from public.quotes q
   where q.org_id = M and q.deleted_at is null
     and not exists (select 1 from public.quote_versions v where v.quote_id = q.id)
  on conflict do nothing;

  -- 2) the shipped 450-guest lawn plans and the 120-guest gala plan seat the guest count: the two events' floor
  --    plans and the matching layout templates (only while they are still the shipped plans)
  update public.quote_versions v set data = public._a237_fit_layout(v.data)
   where v.org_id = M and v.quote_id in (q1, q3) and v.version_no = 1 and v.data is distinct from public._a237_fit_layout(v.data);
  update public.studio_layout_templates t set data = public._a237_fit_layout(t.data), updated_at = now()
   where t.org_id = M and t.data is distinct from public._a237_fit_layout(t.data);

  -- 3) the event plan: the event's own package + price per plate + venue; menu locked from Planning on
  insert into public.event_plan (quote_id, org_id, venue_name, menu_template, menu_plate_price, menu_locked, locked_at, updated_at)
  select q.id, M, nullif(btrim(coalesce(q.client ->> 'venue', '')), ''), left(btrim(q.pricing ->> '_packageName'), 200),
         case when coalesce(q.pricing ->> 'platePrice', '') ~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then (q.pricing ->> 'platePrice')::numeric end,
         coalesce(q.lifecycle_stage, '') in ('planning', 'resources', 'ready', 'event_day', 'settlement', 'closed'),
         case when coalesce(q.lifecycle_stage, '') in ('planning', 'resources', 'ready', 'event_day', 'settlement', 'closed') then now() end,
         now()
    from public.quotes q
   where q.org_id = M and q.deleted_at is null and jsonb_typeof(q.pricing) = 'object'
     and nullif(btrim(coalesce(q.pricing ->> '_packageName', '')), '') is not null
     and not exists (select 1 from public.event_plan p where p.quote_id = q.id)
  on conflict do nothing;

  -- 4) layout rules / chair types / plate types: only into an empty list
  if not exists (select 1 from public.layout_rules x where x.org_id = M) then
    insert into public.layout_rules (id, org_id, event_type, rules, active, seq, created_at)
    select s.id, M, s.name, s.rules, true, s.seq, now() + make_interval(secs => s.seq)
      from public._a237_sample_settings() s where s.kind = 'layout_rule'
    on conflict do nothing;
  end if;
  if not exists (select 1 from public.chair_types x where x.org_id = M) then
    insert into public.chair_types (id, org_id, name, price, active, created_at)
    select s.id, M, s.name, s.price, true, now() + make_interval(secs => s.seq)
      from public._a237_sample_settings() s where s.kind = 'chair_type'
    on conflict do nothing;
  end if;
  if not exists (select 1 from public.plate_types x where x.org_id = M) then
    insert into public.plate_types (id, org_id, name, price, active, created_at)
    select s.id, M, s.name, s.price, true, now() + make_interval(secs => s.seq)
      from public._a237_sample_settings() s where s.kind = 'plate_type'
    on conflict do nothing;
  end if;

  -- 7) publish once: the snapshot now carries all of it
  if exists (select 1 from public.quotes x where x.org_id = M) then
    perform public.publish_sample_manifest(N);
  end if;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

-- ---- 8) existing free-trial studios: insert only, where missing ---------------------------------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
  o record;
begin
  perform set_config('helm.maintenance', 'on', true);
  for o in select x.id from public.organizations x
             join public.studio_subscriptions s on s.org_id = x.id and s.status = 'trial'
            where x.id <> M and not coalesce(x.is_sample_master, false) and x.sample_cloned_at is not null
            order by x.id loop
    -- an empty version 1 for a sample event with none
    insert into public.quote_versions (quote_id, version_no, data, object_count, org_id, created_at)
    select q.id, 1, '{"items":[]}'::jsonb, 0, o.id, now()
      from public.quotes q
     where q.org_id = o.id and q.is_demo and q.deleted_at is null
       and not exists (select 1 from public.quote_versions v where v.quote_id = q.id)
    on conflict do nothing;
    -- the event plan of a sample event, from its own pricing
    insert into public.event_plan (quote_id, org_id, venue_name, menu_template, menu_plate_price, menu_locked, locked_at, updated_at)
    select q.id, o.id, nullif(btrim(coalesce(q.client ->> 'venue', '')), ''), left(btrim(q.pricing ->> '_packageName'), 200),
           case when coalesce(q.pricing ->> 'platePrice', '') ~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then (q.pricing ->> 'platePrice')::numeric end,
           coalesce(q.lifecycle_stage, '') in ('planning', 'resources', 'ready', 'event_day', 'settlement', 'closed'),
           case when coalesce(q.lifecycle_stage, '') in ('planning', 'resources', 'ready', 'event_day', 'settlement', 'closed') then now() end,
           now()
      from public.quotes q
     where q.org_id = o.id and q.is_demo and q.deleted_at is null and jsonb_typeof(q.pricing) = 'object'
       and nullif(btrim(coalesce(q.pricing ->> '_packageName', '')), '') is not null
       and not exists (select 1 from public.event_plan p where p.quote_id = q.id)
    on conflict do nothing;
    -- the sample settings lists, only into an empty list (new ids)
    if not exists (select 1 from public.layout_rules x where x.org_id = o.id) then
      insert into public.layout_rules (org_id, event_type, rules, active, seq, created_at)
      select o.id, r.event_type, r.rules, r.active, r.seq, now() from public.layout_rules r where r.org_id = M
      on conflict do nothing;
    end if;
    if not exists (select 1 from public.chair_types x where x.org_id = o.id) then
      insert into public.chair_types (org_id, name, price, active, created_at)
      select o.id, c.name, c.price, c.active, now() from public.chair_types c where c.org_id = M
      on conflict do nothing;
    end if;
    if not exists (select 1 from public.plate_types x where x.org_id = o.id) then
      insert into public.plate_types (org_id, name, price, active, created_at)
      select o.id, c.name, c.price, c.active, now() from public.plate_types c where c.org_id = M
      on conflict do nothing;
    end if;
  end loop;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 the sample copy includes layout rules, chair / plate types and the event plan',
     array_position(public._sample_clone_tables(), 'event_plan') > array_position(public._sample_clone_tables(), 'quotes')
     and 'layout_rules' = any(public._sample_clone_tables()) and 'chair_types' = any(public._sample_clone_tables())
     and 'plate_types' = any(public._sample_clone_tables()) and 'event_requirements' = any(public._sample_clone_tables())),
  ('02 sample master: every event has a layout version 1; no floor plan seats more than its guests or its limit',
     not exists (select 1 from public.quotes q where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null
                  and not exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = 1))
     and not exists (select 1 from public.quote_versions v join public.quotes q on q.id = v.quote_id
                      where v.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and v.version_no = 1
                        and (v.data #>> '{venue,capacity}') ~ '^[0-9]+$' and (q.client ->> 'guests') ~ '^[0-9]+$'
                        and (select coalesce(sum(case when (i -> 'properties' ->> 'rows') ~ '^[0-9]+$' and (i -> 'properties' ->> 'cols') ~ '^[0-9]+$'
                                                        then (i -> 'properties' ->> 'rows')::int * (i -> 'properties' ->> 'cols')::int
                                                      when (i -> 'properties' ->> 'seats') ~ '^[0-9]+$' then (i -> 'properties' ->> 'seats')::int
                                                      else case i ->> 'type' when 'sofa' then 3 when 'loveseat' then 2 when 'bench' then 2
                                                             when 'lounge' then 4 when 'armchair' then 1 when 'ottoman' then 1 when 'chiavari' then 1
                                                             when 'barstool' then 1 else 0 end end), 0)
                               from jsonb_array_elements(coalesce(v.data -> 'items', '[]'::jsonb)) i)
                            > least((v.data #>> '{venue,capacity}')::int, (q.client ->> 'guests')::int))),
  ('03 sample master: event plans, 8 layout rules, 3 chair types, 3 plate types',
     (select count(*) from public.event_plan where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and menu_template is not null) >= 6
     and (select count(*) from public.layout_rules where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') >= 8
     and (select count(*) from public.chair_types where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') >= 3
     and (select count(*) from public.plate_types where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') >= 3),
  ('04 the 0237 sample version was published once and is current (or a later one), with the new lists',
     (select count(*) from public.helm_trial_seed_manifest where notes = public._a237_manifest_note()) = 1
     and exists (select 1 from public.helm_trial_seed_manifest c where c.is_current
                   and c.version >= (select m.version from public.helm_trial_seed_manifest m where m.notes = public._a237_manifest_note())
                   and jsonb_array_length(coalesce(c.payload #> '{tables,chair_types}', '[]'::jsonb)) >= 3
                   and jsonb_array_length(coalesce(c.payload #> '{tables,event_plan}', '[]'::jsonb)) >= 6)),
  ('05 existing free-trial studios (sample copied): every sample event has a layout version 1',
     not exists (select 1 from public.quotes q join public.studio_subscriptions s on s.org_id = q.org_id and s.status = 'trial'
                  join public.organizations o on o.id = q.org_id and o.sample_cloned_at is not null and not coalesce(o.is_sample_master, false)
                  where q.is_demo and q.deleted_at is null
                    and not exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = 1))),
  ('06 sample-data summary counts the sample layout templates; helpers internal',
     position('trial-seed-0237' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_demo_status()')), '')) > 0
     and not has_function_privilege('authenticated', 'public._a237_sample_settings()', 'execute')
     and not has_function_privilege('anon', 'public._a237_manifest_note()', 'execute'))
) v(item, ok) order by item;
