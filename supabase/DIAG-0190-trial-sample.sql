-- DIAG-0190-trial-sample.sql - READ ONLY. Paste into the Supabase SQL editor (production or staging).
-- Answers "did this new free trial get the sample data, and if not, why?". Changes nothing.

-- 1) the switch + the current published sample
select t.active, t.org_id as master, t.version as template_version, public._sample_template_ready() as ready,
       m.version as current_manifest, m.counts ->> 'inventory_items' as inv, m.counts ->> 'dish_catalog' as dishes,
       m.counts ->> 'menu_templates' as packages, m.counts ->> 'quotes' as events
  from public.helm_sample_template t left join public.helm_trial_seed_manifest m on m.is_current where t.id;

-- 2) the newest 20 trial studios: how each was started and what it holds now
--    trial_mode 'own' = "Start with my own data" (or Create studio -> switch to trial): nothing is seeded BY DESIGN
select o.name, o.created_at, o.trial_mode, o.sample_version, o.sample_cloned_at is not null as cloned,
       (select a.changed -> 'seed' ->> 'error' from public.audit_log a where a.org_id = o.id and a.action = 'subscription.trial_started' order by a.at desc limit 1) as seed_error,
       (select a.changed -> 'seed' ->> 'reason' from public.audit_log a where a.org_id = o.id and a.action = 'subscription.trial_started' order by a.at desc limit 1) as seed_reason,
       (select count(*) from public.venues x where x.org_id = o.id) as venues,
       (select count(*) from public.inventory_items x where x.org_id = o.id) as inventory,
       (select count(*) from public.vendors x where x.org_id = o.id) as vendors,
       (select count(*) from public.crew_members x where x.org_id = o.id) as staff,
       (select count(*) from public.leads x where x.org_id = o.id) as leads,
       (select count(*) from public.quotes x where x.org_id = o.id) as events,
       (select count(*) from public.menu_templates x where x.org_id = o.id) as packages,
       (select count(*) from public.dish_catalog x where x.org_id = o.id) as dishes
  from public.organizations o
 where o.trial_ends_at is not null and not coalesce(o.is_sample_master, false)
 order by o.created_at desc limit 20;

-- 3) every sample event of the last 7 days (cloned / not cloned + the reason)
select a.at, o.name, a.action, a.changed ->> 'version' as version, a.changed -> 'counts' ->> 'inventory_items' as inv,
       a.changed -> 'counts' ->> 'dish_catalog' as dishes_added, a.changed -> 'kept_existing' as kept_existing_0190,
       a.changed ->> 'reason' as reason
  from public.audit_log a left join public.organizations o on o.id = a.org_id
 where a.action in ('trial.sample_cloned', 'trial.sample_not_cloned') and a.at > now() - interval '7 days'
 order by a.at desc;

-- 4) create_studio copies the Helm library studio's dishes + packages into EVERY new studio first;
--    the clone then keeps those (same names / tier+diet). Does the library match the published sample?
with lib as (select tier, diet, name, price_per_plate from public.menu_templates where org_id = '00000000-0000-4000-8000-000000000001'),
     smp as (select e.j ->> 'tier' tier, e.j ->> 'diet' diet, e.j ->> 'name' name, (e.j ->> 'price_per_plate')::numeric price_per_plate
               from public.helm_trial_seed_manifest m, jsonb_array_elements(m.payload #> '{tables,menu_templates}') e(j) where m.is_current)
select coalesce(s.tier, l.tier) tier, coalesce(s.diet, l.diet) diet, s.price_per_plate as sample_price, l.price_per_plate as library_price,
       s.price_per_plate is not distinct from l.price_per_plate as same
  from smp s full join lib l on l.tier = s.tier and l.diet = s.diet order by 1, 2;
select count(*) as sample_dishes_missing_from_library
  from public.helm_trial_seed_manifest m, jsonb_array_elements(m.payload #> '{tables,dish_catalog}') e(j)
 where m.is_current and not exists (select 1 from public.dish_catalog d
        where d.org_id = '00000000-0000-4000-8000-000000000001' and lower(btrim(d.name)) = lower(btrim(e.j ->> 'name')));

-- 5) the API time limit for signed-in calls (Supabase default 8s) + the time zone list cost the 0119 sign-up paid
select rolname, rolconfig from pg_roles where rolname in ('authenticated', 'anon', 'authenticator');
explain analyze select exists (select 1 from pg_catalog.pg_timezone_names t where t.name = 'Asia/Kolkata');
