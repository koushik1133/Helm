-- r25-hq-metrics-0272.sql -- 0272: read-only HQ numbers (hq_metrics for the Overview, hq_studio_usage for the studio
-- drawer): operators only, counts + Helm's own money only, MRR spread over the months a payment covers, trial -> paid,
-- needs-attention lists, queues, sample-data masters left out, nothing written except the HQ view log.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

-- ---- the migration, twice (safe to re-run) -------------------------------------------------------------------------
\ir ../../supabase/migrations/0272_hq_metrics.sql
\ir ../../supabase/migrations/0272_hq_metrics.sql

-- ---- baseline numbers before the fixture (other suites may have left Helm payments behind)
create temp table _base(mj jsonb); grant all on _base to authenticated;
do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  perform pg_temp.op(); insert into _base select public.hq_metrics(); perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('00 baseline', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- fixture: Studio A pays Helm (yearly), Studio B is on a trial ending in 3 days, a sample master is ignored ---------
do $$ declare pid uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r25pro', 'R25 Pro', 999, 'INR', true)
    on conflict (code) do update set name = excluded.name returning id into pid;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
    values ('a0000000-0000-4000-8000-000000000001', pid, 'active', current_date - 20, current_date - 10, current_date + 355)
    on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active', trial_ends_at = excluded.trial_ends_at,
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at)
    values ('b0000000-0000-4000-8000-000000000001', 'trial', current_date + 3)
    on conflict (org_id) do update set status = 'trial', plan_id = null, trial_ends_at = excluded.trial_ends_at;
  -- 14160 incl. 18% tax for 12 months -> 12000 before tax -> MRR 1000
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, net_amount, gst_amount)
    values ('a0000000-0000-4000-8000-000000000001', 14160, 'INR', current_date - 10, current_date - 10, current_date + 354, 'upi', 12000, 2160);
  -- a voided one never counts
  insert into public.subscription_payments(org_id, amount, currency, paid_on, method, voided_at, void_reason)
    values ('a0000000-0000-4000-8000-000000000001', 50000, 'INR', current_date - 5, 'cash', now(), 'test');
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_sample_master') then
    insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, is_sample_master)
      values ('c0000000-0000-4000-8000-0000000000aa', 'Sample Master R25', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now(), true)
      on conflict (id) do nothing;
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    values (null, 'admin@helm.events', 'hq.studio.suspend', 'studio_subscriptions', 'a0000000-0000-4000-8000-000000000001', null, now() - interval '1 day');
exception when others then insert into _tp values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) schema + grants ------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 grants: HQ RPCs signed-in only (checked inside); helpers nobody',
    has_function_privilege('authenticated', 'public.hq_metrics()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_studio_usage(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.hq_metrics()', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_usage(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq72_orgs()', 'execute')
    and not has_function_privilege('authenticated', 'public._hq72_inr(numeric, numeric, text, numeric)', 'execute'));
  perform pg_temp.res('02 the HQ-changes index exists (partial, never hq.view)',
    to_regclass('public.audit_log_hq_changes_0272') is not null
    and pg_get_indexdef(to_regclass('public.audit_log_hq_changes_0272')) like '%hq.view%');
  perform pg_temp.res('03 both functions are security definer with an empty search_path',
    (select count(*) from pg_proc where oid in ('public.hq_metrics()'::regprocedure, 'public.hq_studio_usage(uuid)'::regprocedure)
       and prosecdef and 'search_path=""' = any(proconfig)) = 2);
  perform pg_temp.res('04 never reads a studio business table (same scan as hq-subscriptions 46)',
    not exists (select 1 from pg_proc p where p.oid in ('public.hq_metrics()'::regprocedure, 'public.hq_studio_usage(uuid)'::regprocedure, 'public._hq72_orgs()'::regprocedure)
      and p.prosrc ~* '\m(quotes|quote_payments|payment_milestones|leads|lead_archive|clients|crew|crew_members|event_[a-z_]+|quotation_versions|invitations|vendors|inventory_[a-z_]+|chat_[a-z_]+|storage\.objects|member_profiles)\M'));
end $$;

-- ---- 2) who may read --------------------------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.anon(); e := pg_temp.try('select public.hq_metrics()');
  perform pg_temp.res('10 anon cannot read HQ numbers', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test'); e := pg_temp.try('select public.hq_metrics()');
  perform pg_temp.res('11 a studio admin cannot read HQ numbers', e like '42501%', e);
  e := pg_temp.try('select public.hq_studio_usage(''b0000000-0000-4000-8000-000000000001'')');
  perform pg_temp.res('12 a studio admin cannot read another studio''s usage', e like '42501%', e);
  perform pg_temp.su();
end $$;

-- ---- 3) hq_metrics numbers ------------------------------------------------------------------------------------------
do $$ declare r jsonb; b jsonb; n_log_before bigint; n_rows_before bigint; m jsonb; begin
  perform pg_temp.su();
  select count(*) into n_log_before from public.audit_log where action = 'hq.view' and entity = 'hq_metrics';
  select count(*) into n_rows_before from public.subscription_payments;
  perform pg_temp.op(); r := public.hq_metrics(); perform pg_temp.su();
  perform pg_temp.res('20 studios: A paying, B on trial, sample master left out',
    (r -> 'studios' ->> 'paying')::int >= 1 and (r -> 'studios' ->> 'trial')::int >= 1
    and (r -> 'studios' ->> 'total')::int = (select count(*) from public.organizations where not coalesce(is_sample_master, false)), left(r -> 'studios' #>> '{}', 300));
  perform pg_temp.res('21 signups per week: 12 Monday weeks', jsonb_array_length(r -> 'signups_weekly') = 12
    and extract(isodow from ((r -> 'signups_weekly' -> 11 ->> 'week')::date)) = 1, left(r -> 'signups_weekly' #>> '{}', 200));
  b := (select mj from _base);
  m := r -> 'mrr_monthly' -> 11;
  perform pg_temp.res('22 money per month: 12 months; this month MRR grows by 12000 / 12 = 1000 (before tax, voided ignored)',
    jsonb_array_length(r -> 'mrr_monthly') = 12 and (m ->> 'mrr')::numeric - (b -> 'mrr_monthly' -> 11 ->> 'mrr')::numeric = 1000, m::text);
  perform pg_temp.res('23 received grows by 14160 (incl. tax) in the payment month; the voided 50000 never counts',
    (select sum((x ->> 'collected')::numeric) from jsonb_array_elements(r -> 'mrr_monthly') x)
      - (select sum((x ->> 'collected')::numeric) from jsonb_array_elements(b -> 'mrr_monthly') x) = 14160, left(r -> 'mrr_monthly' #>> '{}', 400));
  perform pg_temp.res('24 plan mix names the plan of the paying studio',
    exists (select 1 from jsonb_array_elements(r -> 'plan_mix') x where x ->> 'plan' = 'R25 Pro' and (x ->> 'studios')::int = 1), r -> 'plan_mix' #>> '{}');
  perform pg_temp.res('25 trial -> paid: A (trial ended, paid) converted',
    (r -> 'conversion' ->> 'trials_ended')::int >= 1 and (r -> 'conversion' ->> 'converted')::int >= 1 and (r -> 'conversion' ->> 'pct') is not null, r -> 'conversion' #>> '{}');
  perform pg_temp.res('26 funnel: signed up >= added a teammate, paid counted',
    (r -> 'funnel' ->> 'signed_up')::int >= (r -> 'funnel' ->> 'added_team')::int and (r -> 'funnel' ->> 'added_team')::int >= 1
    and (r -> 'funnel' ->> 'paid')::int >= 1, r -> 'funnel' #>> '{}');
  perform pg_temp.res('27 needs attention: B trial ends within 7 days',
    exists (select 1 from jsonb_array_elements(r -> 'attention' -> 'trials_ending') x where x ->> 'name' = 'Studio B')
    and (r -> 'attention' ->> 'trials_ending_count')::int >= 1, r -> 'attention' #>> '{}');
  perform pg_temp.res('28 needs attention: request counts are numbers (tables present)',
    (r -> 'attention' ->> 'new_plan_requests') ~ '^\d+$' or (r -> 'attention' -> 'new_plan_requests') = 'null'::jsonb);
  perform pg_temp.res('29 most active: numbers only (no titles / clients / prices)',
    jsonb_array_length(r -> 'top_usage') >= 0
    and not exists (select 1 from jsonb_array_elements(r -> 'top_usage') x where x ? 'title' or x ? 'client' or x ? 'pricing' or x ? 'total')
    and position('Alice' in r::text) = 0 and position('Wedding A' in r::text) = 0, left(r -> 'top_usage' #>> '{}', 300));
  perform pg_temp.res('30 health: each present queue reported with waiting / failed / sent',
    jsonb_array_length(r -> 'health' -> 'queues') >= 1
    and not exists (select 1 from jsonb_array_elements(r -> 'health' -> 'queues') x where not (x ? 'waiting' and x ? 'failed_7d' and x ? 'sent_24h'))
    and (r -> 'health' -> 'cron') ? 'readable', left(r -> 'health' #>> '{}', 300));
  perform pg_temp.res('31 read-only: one HQ view log row, no payment row added',
    (select count(*) from public.audit_log where action = 'hq.view' and entity = 'hq_metrics') = n_log_before + 1
    and (select count(*) from public.subscription_payments) = n_rows_before);
exception when others then perform pg_temp.su(); insert into _tp values ('2x metrics', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) hq_studio_usage ------------------------------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.op(); r := public.hq_studio_usage('a0000000-0000-4000-8000-000000000001'); perform pg_temp.su();
  perform pg_temp.res('40 usage: people + sign-ins + payments to Helm, numbers only (no quote data)',
    (r ->> 'people')::int >= 1 and r ? 'people_active_30d' and r ? 'people_active_7d' and (r ->> 'payments_to_helm')::int >= 1
    and not (r ? 'quotes_total')
    and position('Alice' in r::text) = 0 and position('Wedding A' in r::text) = 0, left(r::text, 300));
  perform pg_temp.res('41 usage: the HQ changes on this studio (never hq.view rows)',
    exists (select 1 from jsonb_array_elements(r -> 'hq_changes') x where x ->> 'action' = 'hq.studio.suspend')
    and not exists (select 1 from jsonb_array_elements(r -> 'hq_changes') x where x ->> 'action' = 'hq.view'), left(r -> 'hq_changes' #>> '{}', 300));
  perform pg_temp.op(); r := public.hq_studio_usage('d0000000-0000-4000-8000-000000000999'); perform pg_temp.su();
  perform pg_temp.res('42 an unknown studio gives null', r is null);
  perform pg_temp.res('43 the view is logged with the studio id',
    exists (select 1 from public.audit_log where action = 'hq.view' and entity = 'hq_studio_usage' and entity_id = 'a0000000-0000-4000-8000-000000000001'));
exception when others then perform pg_temp.su(); insert into _tp values ('4x usage', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R25-HQ-METRICS-0272: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R25-HQ-METRICS-0272: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
