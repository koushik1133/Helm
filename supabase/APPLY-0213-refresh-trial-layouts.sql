-- APPLY-0213-refresh-trial-layouts.sql - OPTIONAL, owner-run. Paste into the Supabase SQL editor AFTER APPLY-0213.sql
-- (it runs as postgres; no auth.uid()). STAGING first; production when the owner says go.
-- Gives EXISTING free-trial studios the 0213 sample floor plans (new trials already get them from the sample manifest):
--   for every studio ON its free trial (subscription 'trial', sample copied, trial not ended, never the sample master),
--   each of its sample events SMP-1000 / 1002 / 1004 / 1005 / 1006 whose floor is STILL EMPTY (no saved layout
--   version with any object on it) gets the plan on its current layout version: the empty version is filled, or the
--   version is added when there is none.
-- Never touched: a sample event the studio has drawn on (any object in any version), the studio's own events, paid
-- studios, ended trials, the quote rows. Nothing deleted. Outbound stays quiet (helm.maintenance on).
-- Safe to run twice (the 2nd run changes nothing). ASCII only.
-- (A full re-copy of the newest sample - which REPLACES the trial's sample data - is APPLY-0178-refresh-trials.sql;
--  this file is the gentle alternative that only adds floor plans.)

-- ---- 1) BEFORE: the trial sample events that would get a floor plan ------------------------------------
select o.name as studio, q.code, q.current_version,
       (select count(*) from public.quote_versions v where v.quote_id = q.id) as versions
  from public.quotes q
  join public.organizations o on o.id = q.org_id
  join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
 where o.id <> 'a5a5a5a5-0166-4000-8000-000000000001' and not coalesce(o.is_sample_master, false)
   and o.sample_cloned_at is not null and (o.trial_ends_at is null or o.trial_ends_at > now())
   and q.is_demo and q.deleted_at is null and public._a213_sample_layout(q.code) is not null
   and not exists (select 1 from public.quote_versions v where v.quote_id = q.id
                    and (v.object_count > 0 or (jsonb_typeof(v.data -> 'items') = 'array' and jsonb_array_length(v.data -> 'items') > 0)))
 order by o.name, q.code;

-- ---- 2) REFRESH (fill-empty / insert only; returns how many sample events got a floor plan) ------------
begin;
select public._a213_fill_trial_layouts() as sample_events_given_a_floor_plan;
commit;

-- ---- 3) VERIFY: should return NO rows (no active trial still has an empty sample floor that 0213 has a plan for) --
select o.name as studio, q.code as still_empty
  from public.quotes q
  join public.organizations o on o.id = q.org_id
  join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
 where o.id <> 'a5a5a5a5-0166-4000-8000-000000000001' and not coalesce(o.is_sample_master, false)
   and o.sample_cloned_at is not null and (o.trial_ends_at is null or o.trial_ends_at > now())
   and q.is_demo and q.deleted_at is null and public._a213_sample_layout(q.code) is not null
   and not exists (select 1 from public.quote_versions v where v.quote_id = q.id
                    and (v.object_count > 0 or (jsonb_typeof(v.data -> 'items') = 'array' and jsonb_array_length(v.data -> 'items') > 0)))
 order by o.name, q.code;
