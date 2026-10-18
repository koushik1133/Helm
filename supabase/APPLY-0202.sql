-- APPLY-0202.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0182.sql and APPLY-0190.sql (APPLY-RELEASE-1018.sql runs everything in the right order in one paste).
-- Free trial: the sample events carry the client's requirements (Must-have / Nice-to-have / Optional: Catering,
-- Decor & flowers, Stage & lighting, Photography, Sound / PA, Entertainment / DJ, Transport ...), so Budget & margin
-- has requirement lines on every sample event. The sample master's 7 events get 41 requirements (only events that
-- have none) and their empty quote budget / guests are filled from the CRM lead (the 0199 rule; never overwrites),
-- the sample copy includes the requirements, and a new sample version is published once. Only NEW trials get it;
-- existing trials move to it with APPLY-0178-refresh-trials.sql (the last section of APPLY-RELEASE-1018.sql).
-- Additive + idempotent: rows added to the sample master only, functions re-issued, nothing deleted, paid studios
-- untouched. Safe to run twice (the 2nd run changes nothing). ASCII only.
begin;
-- ============================================================================
-- 0202_trial_sample_requirements.sql - CANONICAL forward-only. Free-trial sample events get the
-- client's requirements (quote step 3: Must-have / Nice-to-have / Optional), so Budget & margin
-- (0196) has requirement lines to work with on every sample event.
-- REQUIRES 0167 (sample master + publish_sample_manifest), 0168 (_sample_snapshot with studio
--          settings), 0169 (_sample_clone_tables), 0171 (the 7 sample events), 0182 (latest manifest),
--          0190 (set-wise clone), 0199 (_b199_amount / _b199_guests; the fill is skipped without them),
--          phase3-discovery / base (event_requirements).
--
-- In plain words:
--   1  The sample copy now includes event_requirements: _sample_clone_tables() gets
--      'event_requirements' right after 'event_discovery' (its parent, quotes, is copied earlier).
--      The snapshot (_sample_snapshot) and the clone (_sample_clone_into, 0190 body) both walk this
--      list, so publishing takes the master's requirement rows and every NEW trial gets them, with
--      new ids, its own studio, the quote link remapped and created_by cleared (the 0190 rules).
--      Requirement rows have no is_demo column: they belong to a sample event and go with it
--      ("Clear demo data" hard-deletes sample events; event_requirements.quote_id cascades).
--   2  The sample master's 7 events get 4-7 requirements each (Catering, Decor & flowers, Stage &
--      lighting, Photography, Sound / PA, Entertainment / DJ, Transport ...; the names of the quote
--      step 3 suggestions), written ONLY for a master event that has no requirement yet - an owner
--      edit in the master is never overwritten. Fixed ids, ON CONFLICT DO NOTHING.
--   3  The 0199 "quote is the single source of budget / guests" fill, which 0199 left out for the
--      sample master, is done for the master's events too (EMPTY values only, never overwritten): the
--      three 0171 sample events had a budget / guest count on their CRM lead but not on the quote.
--   4  A new sample manifest is published once (current + 1, marker = the note below). Only NEW
--      trials get it; existing trials move to it with the owner-run APPLY-0178-refresh-trials.sql
--      (the last section of APPLY-RELEASE-1018.sql).
--   No table, column, index or trigger is added or dropped; paid studios are not touched; nothing is
--   deleted or overwritten (rows are added / blanks filled in the sample master studio only). ASCII only (the e-acute of "Decor" is chr(233)). Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regclass('public.event_requirements') is null or to_regclass('public.helm_trial_seed_manifest') is null
     or to_regprocedure('public._sample_clone_tables()') is null or to_regprocedure('public._sample_snapshot(uuid)') is null
     or to_regprocedure('public.publish_sample_manifest(text)') is null or to_regprocedure('public._sample_clone_into__pre0168(uuid)') is null then
    raise exception '0202 needs 0167 + 0168 + 0169 (+ 0190) and event_requirements first'; end if;
end $$;

-- ---- 1) the sample copy includes the requirements ----------------------------------------------
create or replace function public._sample_clone_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-data-0169 (trial-sample-0167, trial-sandbox-0166) + trial-reqs-0202 (event_requirements)
  select array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates',
               'item_rate_cards', 'checklist_templates', 'task_templates', 'coupons', 'studio_layout_templates',
               'leads', 'quotes', 'quote_versions', 'event_discovery', 'event_requirements', 'payment_milestones', 'quote_payments',
               'event_checklist', 'event_tasks', 'run_sheet_items', 'inventory_reservations',
               'event_costs', 'event_closure', 'nurture']::text[];
$$;

-- the one-time marker (manifest note); a function so the migration, APPLY, VERIFY and test agree
create or replace function public._a202_manifest_note()
returns text language sql immutable set search_path = '' as $$
  select 'sample event requirements (0202)'::text;
$$;

-- the sample requirements: (quote, row id, service, priority, qty, note) - one place for the
-- migration, VERIFY and the test
create or replace function public._a202_sample_requirements()
returns table (quote_id uuid, id uuid, service text, priority text, qty integer, note text)
language sql immutable set search_path = '' as $$
  -- trial-reqs-0202
  select x.q::uuid, x.i::uuid, replace(x.s, 'Decor', 'D' || chr(233) || 'cor'), x.p, x.n, x.t
    from (values
      -- Demo . Ananya & Vikram Wedding (450 guests)
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000101', 'Catering', 'mandatory', 450, 'Veg + non-veg buffet, live counters'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000102', 'Decor & flowers', 'mandatory', null, 'Mandap, entrance and stage florals'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000103', 'Stage & lighting', 'mandatory', null, 'Wedding stage with warm wash lighting'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000104', 'Photography', 'mandatory', 2, 'Two photographers, full day'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000105', 'Videography', 'nice', 1, 'Highlights film'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000106', 'Entertainment / DJ', 'nice', null, 'DJ for the reception'),
      ('a5a5a5a5-0167-4000-8000-0000000000a1', 'a5a5a5a5-0202-4000-8000-000000000107', 'Transport', 'optional', 2, 'Guest shuttles from the hotel'),
      -- Demo . Rohit & Meera Engagement (220 guests, quote)
      ('a5a5a5a5-0167-4000-8000-0000000000a2', 'a5a5a5a5-0202-4000-8000-000000000201', 'Catering', 'mandatory', 220, 'Dinner buffet'),
      ('a5a5a5a5-0167-4000-8000-0000000000a2', 'a5a5a5a5-0202-4000-8000-000000000202', 'Decor & flowers', 'mandatory', null, 'Ring ceremony backdrop'),
      ('a5a5a5a5-0167-4000-8000-0000000000a2', 'a5a5a5a5-0202-4000-8000-000000000203', 'Photography', 'nice', 1, null),
      ('a5a5a5a5-0167-4000-8000-0000000000a2', 'a5a5a5a5-0202-4000-8000-000000000204', 'Entertainment / DJ', 'nice', null, null),
      ('a5a5a5a5-0167-4000-8000-0000000000a2', 'a5a5a5a5-0202-4000-8000-000000000205', 'Transport', 'optional', null, 'Family pick-up'),
      -- Demo . TechNova Annual Day (corporate, 120 guests)
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000301', 'Stage & lighting', 'mandatory', null, 'Stage for awards + speeches'),
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000302', 'Sound / PA', 'mandatory', null, 'Two handheld mics + podium mic'),
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000303', 'LED wall / screens', 'mandatory', 1, '12 x 8 ft LED wall'),
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000304', 'Catering', 'mandatory', 120, 'High tea + dinner'),
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000305', 'Photography', 'nice', 1, null),
      ('a5a5a5a5-0167-4000-8000-0000000000a3', 'a5a5a5a5-0202-4000-8000-000000000306', 'Transport', 'optional', null, 'Staff drop after the event'),
      -- Demo . Meera & Aditya Engagement (250 guests, confirmed)
      ('a5a5a5a5-0167-4000-8000-0000000000a4', 'a5a5a5a5-0202-4000-8000-000000000401', 'Catering', 'mandatory', 250, 'Dinner buffet'),
      ('a5a5a5a5-0167-4000-8000-0000000000a4', 'a5a5a5a5-0202-4000-8000-000000000402', 'Decor & flowers', 'mandatory', null, 'Floral stage + entrance'),
      ('a5a5a5a5-0167-4000-8000-0000000000a4', 'a5a5a5a5-0202-4000-8000-000000000403', 'Photography', 'mandatory', 1, null),
      ('a5a5a5a5-0167-4000-8000-0000000000a4', 'a5a5a5a5-0202-4000-8000-000000000404', 'Sound / PA', 'nice', null, null),
      ('a5a5a5a5-0167-4000-8000-0000000000a4', 'a5a5a5a5-0202-4000-8000-000000000405', 'Entertainment / DJ', 'optional', null, null),
      -- Demo . Kapoor Family Sangeet (300 guests, confirmed)
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000501', 'Stage & lighting', 'mandatory', null, 'Dance stage with moving heads'),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000502', 'Entertainment / DJ', 'mandatory', null, 'DJ + choreographed family performances'),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000503', 'Sound / PA', 'mandatory', null, null),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000504', 'Catering', 'mandatory', 300, 'Chaat counters + dinner'),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000505', 'Decor & flowers', 'nice', null, 'Marigold and lights theme'),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000506', 'Photography', 'nice', 1, null),
      ('a5a5a5a5-0171-4000-8000-0000000000b5', 'a5a5a5a5-0202-4000-8000-000000000507', 'Transport', 'optional', null, null),
      -- Demo . Zenith Mobiles Product Launch (200 guests, confirmed)
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000601', 'Stage & lighting', 'mandatory', null, 'Launch stage with reveal lighting'),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000602', 'LED wall / screens', 'mandatory', 1, 'Main LED wall + two side screens'),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000603', 'Sound / PA', 'mandatory', null, null),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000604', 'Photography', 'mandatory', 1, 'Press + product shots'),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000605', 'Catering', 'nice', 200, 'Cocktail snacks'),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000606', 'Security', 'optional', 4, null),
      ('a5a5a5a5-0171-4000-8000-0000000000b6', 'a5a5a5a5-0202-4000-8000-000000000607', 'Valet parking', 'optional', null, null),
      -- Demo . Lakshmi Housewarming (150 guests, quote)
      ('a5a5a5a5-0171-4000-8000-0000000000b7', 'a5a5a5a5-0202-4000-8000-000000000701', 'Catering', 'mandatory', 150, 'Traditional lunch on banana leaf'),
      ('a5a5a5a5-0171-4000-8000-0000000000b7', 'a5a5a5a5-0202-4000-8000-000000000702', 'Decor & flowers', 'mandatory', null, 'Toran, rangoli and pooja area'),
      ('a5a5a5a5-0171-4000-8000-0000000000b7', 'a5a5a5a5-0202-4000-8000-000000000703', 'Photography', 'nice', 1, null),
      ('a5a5a5a5-0171-4000-8000-0000000000b7', 'a5a5a5a5-0202-4000-8000-000000000704', 'Sound / PA', 'optional', null, 'Soft music during lunch')
    ) x(q, i, s, p, n, t);
$$;

do $$
declare f text;
begin
  foreach f in array array['public._sample_clone_tables()', 'public._a202_manifest_note()', 'public._a202_sample_requirements()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- ---- 2) once: the master's sample requirements, then publish (current + 1) ---------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  N constant text := public._a202_manifest_note();
  v_prev text := coalesce(current_setting('helm.maintenance', true), '');
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  if exists (select 1 from public.helm_trial_seed_manifest m where m.notes = N) then return; end if;
  perform set_config('helm.maintenance', 'on', true);          -- maintenance: no bell rows for this change

  -- only a master event that exists (not deleted) and has NO requirement yet; listing order = created_at
  insert into public.event_requirements (id, quote_id, service, priority, qty, note, created_at, org_id)
  select r.id, r.quote_id, r.service, r.priority, r.qty, r.note,
         now() + make_interval(secs => row_number() over (order by r.id)), M
    from public._a202_sample_requirements() r
    join public.quotes q on q.id = r.quote_id and q.org_id = M and q.deleted_at is null
   where not exists (select 1 from public.event_requirements e where e.quote_id = r.quote_id)
  on conflict (id) do nothing;

  -- the 0199 single-source rule on the MASTER too (0199 left the master alone): fill only EMPTY
  -- values, never overwrite - quote budget <- Discovery (max, else min) else the linked lead; quote
  -- guests <- the linked lead; Discovery budget <- quote; lead budget / guests <- quote. Without this
  -- the published sample would give every trial events with no budget on the quote (the 0171 events)
  -- while their CRM lead has one, and a second paste of 0199 would fill them in each trial afterwards.
  if to_regprocedure('public._b199_amount(text)') is not null and to_regprocedure('public._b199_guests(text)') is not null then
    update public.quotes q
       set client = jsonb_set(coalesce(q.client, '{}'::jsonb), '{budget}', to_jsonb(s.v), true)
      from (select q2.id,
                   coalesce(public._b199_amount(d.budget_max::text), public._b199_amount(d.budget_min::text),
                            (select public._b199_amount(l.budget::text) from public.leads l
                              where l.quote_id = q2.id and l.org_id = q2.org_id and l.budget is not null
                              order by l.updated_at desc limit 1)) as v
              from public.quotes q2
              left join public.event_discovery d on d.quote_id = q2.id and d.org_id = q2.org_id
             where q2.org_id = M and q2.deleted_at is null
               and (q2.client is null or jsonb_typeof(q2.client) = 'object')
               and nullif(btrim(coalesce(q2.client ->> 'budget', '')), '') is null) s
     where q.id = s.id and s.v is not null;
    update public.quotes q
       set client = jsonb_set(coalesce(q.client, '{}'::jsonb), '{guests}', to_jsonb(s.v), true)
      from (select q2.id,
                   (select l.guest_count from public.leads l
                     where l.quote_id = q2.id and l.org_id = q2.org_id and l.guest_count is not null
                       and l.guest_count between 0 and 100000
                     order by l.updated_at desc limit 1) as v
              from public.quotes q2
             where q2.org_id = M and q2.deleted_at is null
               and (q2.client is null or jsonb_typeof(q2.client) = 'object')
               and nullif(btrim(coalesce(q2.client ->> 'guests', '')), '') is null) s
     where q.id = s.id and s.v is not null;
    update public.event_discovery d
       set budget_max = public._b199_amount(q.client ->> 'budget')
      from public.quotes q
     where q.id = d.quote_id and q.org_id = d.org_id and q.org_id = M and q.deleted_at is null
       and d.budget_min is null and d.budget_max is null
       and public._b199_amount(q.client ->> 'budget') is not null;
    update public.leads l
       set budget      = coalesce(l.budget, public._b199_amount(q.client ->> 'budget')),
           guest_count = coalesce(l.guest_count, public._b199_guests(q.client ->> 'guests'))
      from public.quotes q
     where q.id = l.quote_id and q.org_id = l.org_id and q.org_id = M and q.deleted_at is null
       and ( (l.budget is null and public._b199_amount(q.client ->> 'budget') is not null)
          or (l.guest_count is null and public._b199_guests(q.client ->> 'guests') is not null) );
  end if;

  -- publish once: the snapshot now carries event_requirements
  if exists (select 1 from public.quotes x where x.org_id = M) then
    perform public.publish_sample_manifest(N);
  end if;
  perform set_config('helm.maintenance', v_prev, true);
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 the sample copy includes event_requirements (after quotes)', array_position(public._sample_clone_tables(), 'event_requirements')
       > array_position(public._sample_clone_tables(), 'quotes') and array_length(public._sample_clone_tables(), 1) = 25),
  ('02 sample master: all 7 sample events have requirements (41)', (select count(*) from public.event_requirements
       where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') >= 41
       and not exists (select 1 from public.quotes q where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null
                         and not exists (select 1 from public.event_requirements r where r.quote_id = q.id))),
  ('03 the 0202 sample version was published once and is current (or a later one), with the requirements',
       (select count(*) from public.helm_trial_seed_manifest where notes = public._a202_manifest_note()) = 1
       and exists (select 1 from public.helm_trial_seed_manifest c where c.is_current
                     and c.version >= (select m.version from public.helm_trial_seed_manifest m where m.notes = public._a202_manifest_note())
                     and jsonb_array_length(coalesce(c.payload #> '{tables,event_requirements}', '[]'::jsonb)) >= 41)),
  ('05 sample master: every event with a budget / guests on its CRM lead has them on the quote too (0199 rule)',
       not exists (select 1 from public.quotes q join public.leads l on l.quote_id = q.id and l.org_id = q.org_id
                    where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null
                      and ((l.budget is not null and nullif(btrim(coalesce(q.client ->> 'budget', '')), '') is null)
                        or (l.guest_count is not null and nullif(btrim(coalesce(q.client ->> 'guests', '')), '') is null)))),
  ('04 app roles cannot run the 0202 helpers', not has_function_privilege('authenticated', 'public._a202_sample_requirements()', 'execute')
       and not has_function_privilege('anon', 'public._a202_sample_requirements()', 'execute')
       and not has_function_privilege('authenticated', 'public._a202_manifest_note()', 'execute'))
) v(item, ok) order by item;
