-- FIX-0177-existing-trials.sql - OWNER-RUN, after APPLY-0177.sql. Staging first, then production.
-- Corrects EXISTING free-trial studios to India defaults: currency INR, timezone Asia/Kolkata,
-- country IN, GST state (Telangana when none / not Indian) and stamps trial_region = 'IN' so 0177 keeps them there.
-- Touches ONLY organizations rows that are self-serve free trials still on their trial:
--   trial_ends_at set + trial_mode set + not the sample master + subscription status 'trial' (or no row)
--   + an audit row showing the trial was started by start_self_serve_trial / start_trial / my_pending_start_trial.
-- Only these 5 columns of those rows change. No other table, row or column (brand, quotes, events) is touched.
-- Quotes keep the currency they were priced with. Idempotent: a second run updates 0 rows.

-- 1) PREVIEW (run first, read the list)
select o.id, o.name, o.created_at, o.currency, o.timezone, o.country, o.tax_region, o.trial_mode, o.trial_region
  from public.organizations o
 where o.trial_ends_at is not null and o.trial_mode is not null and not coalesce(o.is_sample_master, false)
   and coalesce((select s.status from public.studio_subscriptions s where s.org_id = o.id), 'trial') = 'trial'
   and exists (select 1 from public.audit_log a where a.org_id = o.id and a.action = 'subscription.trial_started'
                 and a.changed ->> 'source' in ('start_self_serve_trial', 'start_trial', 'my_pending_start_trial'))
 order by o.created_at;

-- 2) FIX
begin;
update public.organizations o
   set currency = 'INR', timezone = 'Asia/Kolkata', country = 'IN', trial_region = 'IN',
       tax_region = case when o.country = 'IN' and nullif(btrim(coalesce(o.tax_region, '')), '') is not null then o.tax_region else 'Telangana' end
 where o.trial_ends_at is not null and o.trial_mode is not null and not coalesce(o.is_sample_master, false)
   and coalesce((select s.status from public.studio_subscriptions s where s.org_id = o.id), 'trial') = 'trial'
   and exists (select 1 from public.audit_log a where a.org_id = o.id and a.action = 'subscription.trial_started'
                 and a.changed ->> 'source' in ('start_self_serve_trial', 'start_trial', 'my_pending_start_trial'))
   and (o.currency is distinct from 'INR' or o.timezone is distinct from 'Asia/Kolkata' or o.country is distinct from 'IN'
        or o.trial_region is distinct from 'IN' or nullif(btrim(coalesce(o.tax_region, '')), '') is null);
commit;

-- 3) VERIFY (should return 0 rows)
select o.id, o.name, o.currency, o.timezone, o.country, o.tax_region
  from public.organizations o
 where o.trial_ends_at is not null and o.trial_mode is not null and not coalesce(o.is_sample_master, false)
   and coalesce((select s.status from public.studio_subscriptions s where s.org_id = o.id), 'trial') = 'trial'
   and exists (select 1 from public.audit_log a where a.org_id = o.id and a.action = 'subscription.trial_started'
                 and a.changed ->> 'source' in ('start_self_serve_trial', 'start_trial', 'my_pending_start_trial'))
   and (o.currency <> 'INR' or o.timezone <> 'Asia/Kolkata' or o.country is distinct from 'IN' or o.trial_region is distinct from 'IN');
