-- 0272_hq_metrics.sql - CANONICAL forward-only.
-- REQUIRES 0029 + 0045 (_hq_gate, organizations / profiles / studio_subscriptions / helm_plans / subscription_payments),
--          0244 (sales_requests; optional - counted when present), 0271 (sales_enquiries + suggestions; optional).
--
-- In plain words (owner, r25: "Helm HQ looks boring" - the redesign needs a few more numbers):
--   1  hq_metrics()  READ-ONLY numbers for the HQ Overview page, for Helm HQ operators only (_hq_gate: platform operator,
--      every call kept in the HQ log as 'hq.view'). HELM'S OWN DATA ONLY - studios, their people / sign-ins and what they
--      paid Helm. Like every hq_* function since 0045 it never reads a studio's business tables (quotes, clients, leads,
--      crew, events, inventory, chat ...; the hq-subscriptions DB suite scans every hq_* body for them):
--        * studios: total / paying / on trial / past due / suspended / cancelled / no plan / signed in within 30 days
--        * new studios per week (12 weeks), Helm money per month (12 months: received, and MRR = each payment spread
--          over the months it covers, before tax, in rupees)
--        * plan mix (paying studios per plan), trial -> paid % (studios whose trial has ended and that paid Helm),
--          a 90-day funnel (signed up -> added a teammate -> paid) and churn (cancelled / suspended in 90 days)
--        * "needs attention": trials ending in 7 days, past-due studios, paying studios with no sign-in for 14+ days,
--          new plan requests / sales enquiries / suggestions
--        * most active studios (people who signed in within 30 days, team size) - numbers only
--        * system health: every e-mail / WhatsApp queue (waiting, failed in 7 days, sent in 24 h, oldest waiting) and
--          the helm_* scheduled jobs (last run, last result, failures in 24 h) when pg_cron is readable
--      Sample-data master studios (is_sample_master) are left out of every number.
--   2  hq_studio_usage(org)  READ-ONLY numbers for one studio in the HQ studio drawer ("Activity" tab): people, people
--      who signed in within 7 / 30 days, last sign-in, payments to Helm, and the last 30 changes Helm HQ made
--      to this studio (from the HQ log). Gated the same way.
--   3  ONE small partial index on audit_log (HQ changes only, never the 'hq.view' rows) so (2) stays fast.
--   No table / column / policy / row is changed or deleted. Two new functions + one index. Additive + idempotent:
--   safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop function public.hq_metrics(); drop function public.hq_studio_usage(uuid);
-- drop index if exists public.audit_log_hq_changes_0272. Nothing else depends on them.

do $$ begin
  if to_regprocedure('public._hq_gate(text,text)') is null then raise exception 'STOP 0272: 0029 (_hq_gate) is not applied'; end if;
  if to_regclass('public.studio_subscriptions') is null or to_regclass('public.subscription_payments') is null
     or to_regclass('public.helm_plans') is null then raise exception 'STOP 0272: 0045 (Helm subscriptions) is not applied'; end if;
  if to_regclass('public.audit_log') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0272: audit_log / profiles missing'; end if;
end $$;

-- ---- 1) small helpers (internal, nobody may call them) ----------------------------------------------------------------
-- Helm's own money for one payment in rupees, before tax (non-INR needs its recorded rate, else 0)
create or replace function public._hq72_inr(p_amount numeric, p_net numeric, p_currency text, p_fx numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(coalesce(p_net, p_amount, 0) * case when coalesce(p_currency, 'INR') = 'INR' then 1 else coalesce(p_fx, 0) end, 2)
$$;

-- the studios HQ counts (sample-data masters left out) with their plan state - read as jsonb so an older column set works
create or replace function public._hq72_orgs()
returns table(org_id uuid, name text, created_at timestamptz, status text, plan_name text, plan_code text,
              trial_end timestamptz, current_period_end date, updated_at timestamptz, paid boolean, last_sign_in timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.created_at, coalesce(s.status, 'none'), hp.name, hp.code,
         coalesce(s.trial_ends_at::timestamptz, nullif(to_jsonb(o) ->> 'trial_ends_at', '')::timestamptz),
         s.current_period_end, s.updated_at,
         exists (select 1 from public.subscription_payments sp where sp.org_id = o.id and sp.voided_at is null),
         (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.id where p.org_id = o.id)
    from public.organizations o
    left join public.studio_subscriptions s on s.org_id = o.id
    left join public.helm_plans hp on hp.id = s.plan_id
   where not coalesce(nullif(to_jsonb(o) ->> 'is_sample_master', '')::boolean, false)
$$;

-- ---- 2) hq_metrics: the HQ Overview numbers ---------------------------------------------------------------------------
create or replace function public.hq_metrics()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r jsonb; v jsonb; today date := (now() at time zone 'Asia/Kolkata')::date;
  q record; n_wait bigint; n_fail bigint; n_sent bigint; v_old timestamptz; v_queues jsonb := '[]'::jsonb;
  v_cron jsonb := jsonb_build_object('readable', false, 'jobs', '[]'::jsonb);
  n_plan bigint := null; n_sales bigint := null; n_sugg bigint := null;
begin
  perform public._hq_gate('hq_metrics');

  r := jsonb_build_object('generated_at', now(), 'today', today,
    'studios', (select jsonb_build_object(
        'total', count(*),
        'paying', count(*) filter (where status = 'active'),
        'trial', count(*) filter (where status = 'trial'),
        'past_due', count(*) filter (where status = 'past_due'),
        'suspended', count(*) filter (where status = 'suspended'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'none', count(*) filter (where status = 'none'),
        'active_30d', count(*) filter (where last_sign_in >= now() - interval '30 days'),
        'new_30d', count(*) filter (where created_at >= now() - interval '30 days'),
        'new_prev_30d', count(*) filter (where created_at >= now() - interval '60 days' and created_at < now() - interval '30 days'))
      from public._hq72_orgs()));

  -- new studios per week (Monday weeks, India time), 12 weeks
  select coalesce(jsonb_agg(jsonb_build_object('week', w::date, 'studios', coalesce(c.n, 0)) order by w), '[]'::jsonb) into v
    from generate_series(date_trunc('week', today::timestamp) - interval '11 weeks', date_trunc('week', today::timestamp), interval '1 week') w
    left join (select date_trunc('week', (created_at at time zone 'Asia/Kolkata'))::date k, count(*) n from public._hq72_orgs() group by 1) c on c.k = w::date;
  r := r || jsonb_build_object('signups_weekly', v);

  -- Helm money per month (12 months): received (incl. tax, rupees) and MRR (before tax, spread over the months covered)
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'collected', coalesce(col.amt, 0), 'mrr', coalesce(mr.amt, 0)) order by m), '[]'::jsonb) into v
    from generate_series(date_trunc('month', today::timestamp) - interval '11 months', date_trunc('month', today::timestamp), interval '1 month') m
    left join lateral (
      select sum(round(sp.amount * case when sp.currency = 'INR' then 1 else coalesce(sp.fx_rate_to_inr, 0) end, 2)) amt
        from public.subscription_payments sp
       where sp.voided_at is null and sp.paid_on >= m::date and sp.paid_on < (m + interval '1 month')::date) col on true
    left join lateral (
      select sum(public._hq72_inr(sp.amount, sp.net_amount, sp.currency, sp.fx_rate_to_inr)
                 / greatest(1, round((coalesce(sp.period_end, (sp.paid_on + interval '1 month')::date - 1)
                                      - coalesce(sp.period_start, sp.paid_on) + 1)::numeric / 30.44))) amt
        from public.subscription_payments sp
       where sp.voided_at is null
         and coalesce(sp.period_start, sp.paid_on) <= least((m + interval '1 month')::date - 1, today)
         and coalesce(sp.period_end, (sp.paid_on + interval '1 month')::date - 1) >= least((m + interval '1 month')::date - 1, today)) mr on true;
  r := r || jsonb_build_object('mrr_monthly', (select coalesce(jsonb_agg(x || jsonb_build_object('mrr', round((x ->> 'mrr')::numeric, 0))), '[]'::jsonb)
                                                 from jsonb_array_elements(v) x));

  -- plan mix (paying + past due studios per plan)
  select coalesce(jsonb_agg(jsonb_build_object('plan', coalesce(plan_name, 'No plan'), 'code', plan_code, 'studios', n) order by n desc, plan_name), '[]'::jsonb) into v
    from (select plan_name, plan_code, count(*) n from public._hq72_orgs() where status in ('active', 'past_due') group by 1, 2) t;
  r := r || jsonb_build_object('plan_mix', v);

  -- trial -> paid: studios whose trial has ended; paid = any (not voided) payment to Helm or an active plan
  r := r || (select jsonb_build_object('conversion', jsonb_build_object(
        'trials_ended', count(*), 'converted', count(*) filter (where paid or status = 'active'),
        'pct', case when count(*) > 0 then round(100.0 * count(*) filter (where paid or status = 'active') / count(*), 1) else null end))
      from public._hq72_orgs() where trial_end is not null and trial_end < now());

  -- 90-day funnel: signed up -> added a teammate (2+ people) -> paid
  r := r || (select jsonb_build_object('funnel', jsonb_build_object('window_days', 90,
        'signed_up', count(*),
        'added_team', count(*) filter (where (select count(*) from public.profiles p where p.org_id = h.org_id) >= 2),
        'on_trial', count(*) filter (where h.status = 'trial'),
        'paid', count(*) filter (where h.paid or h.status = 'active')))
      from public._hq72_orgs() h where h.created_at >= now() - interval '90 days');
  r := r || (select jsonb_build_object('churn_90d', count(*)) from public._hq72_orgs()
              where status in ('cancelled', 'suspended') and updated_at >= now() - interval '90 days');

  -- needs attention
  if to_regclass('public.sales_requests') is not null then execute 'select count(*) from public.sales_requests where status = ''new''' into n_plan; end if;
  if to_regclass('public.sales_enquiries') is not null then execute 'select count(*) from public.sales_enquiries where status = ''new''' into n_sales; end if;
  if to_regclass('public.suggestions') is not null then execute 'select count(*) from public.suggestions where status = ''new''' into n_sugg; end if;
  r := r || jsonb_build_object('attention', jsonb_build_object(
    'trials_ending', (select coalesce(jsonb_agg(jsonb_build_object('org_id', org_id, 'name', name, 'ends_at', trial_end) order by trial_end), '[]'::jsonb)
                        from (select * from public._hq72_orgs() where status = 'trial' and trial_end >= now() and trial_end < now() + interval '7 days'
                               order by trial_end limit 10) t),
    'trials_ending_count', (select count(*) from public._hq72_orgs() where status = 'trial' and trial_end >= now() and trial_end < now() + interval '7 days'),
    'past_due', (select coalesce(jsonb_agg(jsonb_build_object('org_id', org_id, 'name', name, 'period_end', current_period_end) order by current_period_end), '[]'::jsonb)
                   from (select * from public._hq72_orgs() where status = 'past_due' order by current_period_end nulls last limit 10) t),
    'at_risk', (select coalesce(jsonb_agg(jsonb_build_object('org_id', org_id, 'name', name, 'last_sign_in', last_sign_in) order by last_sign_in nulls first), '[]'::jsonb)
                  from (select * from public._hq72_orgs() where status = 'active' and (last_sign_in is null or last_sign_in < now() - interval '14 days')
                         order by last_sign_in nulls first limit 10) t),
    'new_plan_requests', n_plan, 'new_sales_enquiries', n_sales, 'new_suggestions', n_sugg));

  -- most active studios: people who signed in within 30 days (numbers only)
  select coalesce(jsonb_agg(t.j order by t.a30 desc, t.ppl desc, t.name), '[]'::jsonb) into v from (
    select jsonb_build_object('org_id', h.org_id, 'name', h.name, 'status', h.status, 'plan', h.plan_name,
             'active_30d', c.a30, 'people', c.ppl, 'last_sign_in', h.last_sign_in) j, c.a30, c.ppl, h.name
      from public._hq72_orgs() h
      join (select p.org_id, count(*) filter (where u.last_sign_in_at >= now() - interval '30 days') a30, count(*) ppl
              from public.profiles p left join auth.users u on u.id = p.id group by p.org_id) c on c.org_id = h.org_id
     where c.a30 > 0
     order by c.a30 desc, c.ppl desc, h.name limit 8) t;
  r := r || jsonb_build_object('top_usage', v);

  -- system health: the queues (same shape: status pending / sent / skipped / failed)
  for q in select * from (values
      ('helm_notice_outbox', 'Helm e-mails (sales, trial, digests)'), ('comms_outbox', 'Client e-mails (reminders)'),
      ('invite_email_outbox', 'Invite e-mails'), ('welcome_email_outbox', 'Welcome e-mails'),
      ('security_alert_outbox', 'Security alert e-mails'), ('pkg_outbox', 'Package e-mails'),
      ('assign_notify_outbox', 'WhatsApp notices (team)')) x(t, label) loop
    if to_regclass('public.' || q.t) is null then continue; end if;
    begin
      execute format('select count(*) filter (where status = ''pending''),
                             count(*) filter (where status = ''failed'' and created_at >= now() - interval ''7 days''),
                             count(*) filter (where status = ''sent'' and sent_at >= now() - interval ''24 hours''),
                             min(created_at) filter (where status = ''pending'') from public.%I', q.t)
        into n_wait, n_fail, n_sent, v_old;
      v_queues := v_queues || jsonb_build_object('name', q.t, 'label', q.label, 'waiting', n_wait, 'failed_7d', n_fail,
                                                 'sent_24h', n_sent, 'oldest_waiting', v_old);
    exception when others then null;
    end;
  end loop;
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    begin
      execute $c$select coalesce(jsonb_agg(jsonb_build_object('name', t.jobname, 'schedule', t.schedule, 'active', t.active,
                       'last_run', t.last_run, 'last_status', t.last_status, 'failed_24h', t.failed_24h) order by t.jobname), '[]'::jsonb)
                   from (select j.jobname, j.schedule, j.active, max(d.start_time) last_run,
                                (array_agg(d.status order by d.start_time desc))[1] last_status,
                                count(*) filter (where d.status = 'failed' and d.start_time >= now() - interval '24 hours') failed_24h
                           from cron.job j
                           left join cron.job_run_details d on d.jobid = j.jobid and d.start_time >= now() - interval '7 days'
                          where j.jobname like 'helm%' group by j.jobname, j.schedule, j.active) t$c$ into v;
      v_cron := jsonb_build_object('readable', true, 'jobs', v);
    exception when others then v_cron := jsonb_build_object('readable', false, 'jobs', '[]'::jsonb);
    end;
  end if;
  r := r || jsonb_build_object('health', jsonb_build_object('queues', v_queues, 'cron', v_cron));
  return r;
end $$;

-- ---- 3) hq_studio_usage: one studio's numbers + what HQ changed on it ---------------------------------------------------
create or replace function public.hq_studio_usage(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public._hq_gate('hq_studio_usage', p_org::text);
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then return null; end if;
  select jsonb_build_object('payments_to_helm', count(*), 'last_payment_on', max(sp.paid_on))
    into r from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null;
  r := r || (select jsonb_build_object('people', count(*), 'people_active_30d', count(*) filter (where u.last_sign_in_at >= now() - interval '30 days'),
                                       'people_active_7d', count(*) filter (where u.last_sign_in_at >= now() - interval '7 days'),
                                       'last_sign_in', max(u.last_sign_in_at))
               from public.profiles p left join auth.users u on u.id = p.id where p.org_id = p_org);
  r := r || jsonb_build_object('hq_changes', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'actor_email', a.actor_email, 'action', a.action) order by a.at desc), '[]'::jsonb)
      from (select a.at, a.actor_email, a.action from public.audit_log a
             where a.entity_id = p_org::text and a.action like 'hq.%' and a.action <> 'hq.view'
             order by a.at desc limit 30) a));
  return r;
end $$;

-- ---- 4) the index for (3): HQ changes only (tiny) ----------------------------------------------------------------------
create index if not exists audit_log_hq_changes_0272 on public.audit_log (entity_id, at desc)
  where action like 'hq.%' and action <> 'hq.view';

-- ---- 5) grants ----------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._hq72_inr(numeric, numeric, text, numeric)', 'public._hq72_orgs()', 'public.hq_metrics()', 'public.hq_studio_usage(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- HQ: each checks the platform operator inside (_hq_gate)
    execute 'grant execute on function public.hq_metrics() to authenticated';
    execute 'grant execute on function public.hq_studio_usage(uuid) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
