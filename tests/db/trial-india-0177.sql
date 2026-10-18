-- trial-india-0177.sql - 0177: every free-trial studio is INR / Asia/Kolkata / IN / GST while on trial.
-- Proves: a US-browser trial sign-up (USD + America/Chicago sent) lands on INR / Kolkata / IN / Telangana,
-- both demo and own mode; an owner edit to USD during the trial is pinned back; a paid "Create studio"
-- studio keeps its own currency (never stamped); after the trial converts the studio can change freely;
-- the sample master is never touched. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _t177; create temp table _t177(name text, result text); grant all on _t177 to anon, authenticated;
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform auth.login_as((select id from auth.users where email = p_who));
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _t177 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

do $$ begin
  execute 'reset role';
  if not exists (select 1 from auth.users where email = 't177_us@d.test') then perform auth.seed_user('t177_us@d.test'); end if;
  if not exists (select 1 from auth.users where email = 't177_own@d.test') then perform auth.seed_user('t177_own@d.test'); end if;
  if not exists (select 1 from auth.users where email = 't177_paid@d.test') then perform auth.seed_user('t177_paid@d.test'); end if;
  update public.profiles set org_id = null where email in ('t177_us@d.test', 't177_own@d.test', 't177_paid@d.test');
end $$;

-- 1) demo trial from a US browser
do $$ declare r text; o public.organizations; begin
  r := pg_temp.as_try('t177_us@d.test', $q$select public.start_self_serve_trial('T177 US Studio', 'America/Chicago', 'USD', 'demo')::text$q$);
  perform pg_temp.t('us demo: trial started', r like '%"result": "started"%', r);
  select x.* into o from public.organizations x join public.profiles p on p.org_id = x.id where p.email = 't177_us@d.test';
  perform pg_temp.t('us demo: currency INR', o.currency = 'INR', o.currency);
  perform pg_temp.t('us demo: timezone Asia/Kolkata', o.timezone = 'Asia/Kolkata', o.timezone);
  perform pg_temp.t('us demo: country IN', o.country = 'IN', o.country);
  perform pg_temp.t('us demo: GST state Telangana', o.tax_region = 'Telangana', o.tax_region);
  perform pg_temp.t('us demo: stamped trial_region IN', o.trial_region = 'IN', o.trial_region);
end $$;

-- 2) own-data trial, no name
do $$ declare r text; o public.organizations; begin
  r := pg_temp.as_try('t177_own@d.test', $q$select public.start_self_serve_trial(null, 'Europe/Berlin', 'EUR', 'own')::text$q$);
  perform pg_temp.t('own: trial started', r like '%"result": "started"%', r);
  select x.* into o from public.organizations x join public.profiles p on p.org_id = x.id where p.email = 't177_own@d.test';
  perform pg_temp.t('own: INR / Kolkata / IN', o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.country = 'IN', o.currency || ' ' || o.timezone);
  -- 0180: 'own' is ignored, every free trial is the sample trial
  perform pg_temp.t('own: trial_mode own (demo from 0180)', o.trial_mode = case when coalesce(pg_get_functiondef(coalesce(to_regprocedure('public.start_self_serve_trial__pre0186(text, text, text, text)'), to_regprocedure('public.start_self_serve_trial(text, text, text, text)'))) like '%trial-signup-0180%', false) then 'demo' else 'own' end, o.trial_mode);
end $$;

-- 3) during the trial an edit to USD / Chicago is pinned back; a chosen Indian state is kept
do $$ declare o public.organizations; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 't177_us@d.test';
  update public.organizations set currency = 'USD', timezone = 'America/Chicago', country = 'US', tax_region = 'Karnataka' where id = v_org;
  select * into o from public.organizations where id = v_org;
  perform pg_temp.t('trial edit: still INR / Kolkata / IN', o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.country = 'IN', o.currency || ' ' || o.timezone || ' ' || o.country);
  perform pg_temp.t('trial edit: chosen state kept', o.tax_region = 'Karnataka', o.tax_region);
  update public.organizations set name = 'T177 Renamed' where id = v_org;
  perform pg_temp.t('trial edit: other columns still save', (select name from public.organizations where id = v_org) = 'T177 Renamed', null);
end $$;

-- 4) paid "Create studio" studio: never stamped, keeps its currency (also after a checkout-style trial start)
do $$ declare r text; o public.organizations; v_org uuid; begin
  r := pg_temp.as_try('t177_paid@d.test', $q$select public.create_studio('T177 Paid Studio', null, 'USD', 'America/Chicago')::text$q$);
  perform pg_temp.t('paid: create_studio works', r like 'ok:%', r);
  select org_id into v_org from public.profiles where email = 't177_paid@d.test';
  update public.organizations set trial_ends_at = now() + interval '8 days' where id = v_org;   -- my_start_trial shape: no trial_mode
  select * into o from public.organizations where id = v_org;
  perform pg_temp.t('paid: keeps USD / Chicago, not stamped', o.currency = 'USD' and o.timezone = 'America/Chicago' and o.trial_region is null, o.currency || ' ' || o.timezone);
end $$;

-- 5) after the trial converts (subscription active) the studio may change currency
do $$ declare o public.organizations; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 't177_own@d.test';
  update public.studio_subscriptions set status = 'active' where org_id = v_org;
  update public.organizations set currency = 'AED', timezone = 'Asia/Dubai', country = 'AE' where id = v_org;
  select * into o from public.organizations where id = v_org;
  perform pg_temp.t('converted: free to change', o.currency = 'AED' and o.timezone = 'Asia/Dubai' and o.country = 'AE', o.currency);
end $$;

-- 6) sample master untouched + function not callable by app roles
do $$ begin
  perform pg_temp.t('sample master: trial_region never set',
    not exists (select 1 from public.organizations where is_sample_master and trial_region is not null), null);
  perform pg_temp.t('trigger fn: no execute for authenticated',
    not has_function_privilege('authenticated', 'public.tg_org_trial_india()', 'execute'), null);
end $$;

select case when count(*) filter (where result <> 'PASS') = 0
            then 'TRIAL-INDIA-0177: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-INDIA-0177: FAIL' end as summary from _t177;
select name, result from _t177 where result <> 'PASS';
