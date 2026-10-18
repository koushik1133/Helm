-- APPLY-0178-refresh-trials.sql -- paste into the Supabase SQL editor (runs as postgres; no auth.uid()).
-- Refreshes EVERY existing trial studio (studio_subscriptions.status = 'trial', never the sample master)
-- to the CURRENT published sample manifest (v5):
--   1 _demo_clear(org)       removes ONLY that studio's is_demo rows (studio-created rows are never touched)
--   2 sample_cloned_at/batch/version reset, then _demo_seed(org) re-clones via the 0166-0171 path
--   3 trial studios set to INR / Asia/Kolkata / IN / tax_region 'IN' (GST)
-- Idempotent: a studio already on the current manifest is skipped (set v_force := true to redo it).
-- Venues are never deleted (0085 rule): _demo_clear DEACTIVATES old sample venues, so a forced redo
-- leaves one more inactive copy per sample venue; the skip keeps a plain re-run from piling them up.
-- Sample venues are named 'Demo · ...' (0167 master); VERIFY counts the 4 ACTIVE ones. Outbound stays quiet (helm.maintenance on + trial outbox skip).
-- The sample switch is turned on for the clone only and restored to its previous value afterwards.

-- ---- 1) BEFORE: diagnostics --------------------------------------------------------------------
select o.id, o.name, o.currency, o.timezone, o.country, o.tax_region, o.sample_cloned_at, o.sample_version,
       (select string_agg(v.name, ' | ' order by v.name) from public.venues v where v.org_id = o.id) as venues,
       (select count(*) from public.venues v where v.org_id = o.id and not v.is_demo) as own_venues
  from public.organizations o
  join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
 where o.id <> 'a5a5a5a5-0166-4000-8000-000000000001' and not coalesce(o.is_sample_master, false)
 order by o.created_at;

-- ---- 2) REFRESH ----------------------------------------------------------------------------------
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  v_force constant boolean := false; v_cur integer; v_was boolean; o record; r jsonb; n integer := 0;
begin
  perform set_config('helm.maintenance', 'on', true);
  select m.version into v_cur from public.helm_trial_seed_manifest m where m.is_current;
  if v_cur is distinct from 5 then raise exception 'current sample manifest is %, expected 5 - stopping', v_cur; end if;
  select t.active into v_was from public.helm_sample_template t where t.id;
  update public.helm_sample_template set active = true where id and not active;

  for o in select x.id from public.organizations x
             join public.studio_subscriptions s on s.org_id = x.id and s.status = 'trial'
            where x.id <> M and not coalesce(x.is_sample_master, false)
              and (v_force or x.sample_version is distinct from v_cur or x.sample_cloned_at is null
                   or (x.currency, x.timezone, x.country, coalesce(x.tax_region, '')) is distinct from ('INR', 'Asia/Kolkata', 'IN', 'IN'))
            order by x.id for update of x loop
    perform public._demo_clear(o.id);
    update public.organizations
       set sample_cloned_at = null, sample_batch_id = null, sample_version = null,
           currency = 'INR', timezone = 'Asia/Kolkata', country = 'IN', tax_region = 'IN'
     where id = o.id;
    r := public._demo_seed(o.id);
    if coalesce((r ->> 'cloned')::boolean, false) is not true then
      raise exception 'clone failed for %: %', o.id, r; end if;
    -- the clone copies the master's studio settings; keep India regardless
    update public.organizations set currency = 'INR', timezone = 'Asia/Kolkata', country = 'IN', tax_region = 'IN'
     where id = o.id and (currency, timezone, country, coalesce(tax_region, '')) is distinct from ('INR', 'Asia/Kolkata', 'IN', 'IN');
    n := n + 1;
  end loop;

  update public.helm_sample_template set active = v_was where id and active is distinct from v_was;
  raise notice 'refreshed % trial studio(s) to manifest v%', n, v_cur;
end $$;

-- ---- 3) VERIFY: every row should say ok = true ---------------------------------------------------
select o.id, o.name, o.sample_version, o.currency, o.timezone, o.country, o.tax_region,
       (select count(*) from public.venues v where v.org_id = o.id and v.is_demo and v.active and v.name like E'Demo \u00b7 %') as active_sample_venues,
       (select count(*) - count(distinct v.name) from public.venues v where v.org_id = o.id and v.is_demo and v.active) as dup_venues,
       (select count(*) from public.comms_outbox c where c.org_id = o.id and c.status = 'pending') as pending_outbox,
       ( o.sample_version = 5 and o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.country = 'IN'
         and (select count(*) from public.venues v where v.org_id = o.id and v.is_demo and v.active and v.name like E'Demo \u00b7 %') = 4
         and (select count(*) - count(distinct v.name) from public.venues v where v.org_id = o.id and v.is_demo and v.active) = 0
         and not exists (select 1 from public.comms_outbox c where c.org_id = o.id and c.status = 'pending') ) as ok
  from public.organizations o
  join public.studio_subscriptions s on s.org_id = o.id and s.status = 'trial'
 where o.id <> 'a5a5a5a5-0166-4000-8000-000000000001' and not coalesce(o.is_sample_master, false)
 order by ok, o.created_at;
