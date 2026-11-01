-- 0328_r120_hq_notify_trial_wording.sql - CANONICAL forward-only. R120 (owner: HQ plan activation tells the studio,
-- a fresh two-step code for "Extend trial", trial-preview wording in the event activity).
-- REQUIRES 0244 (hq_activate_plan, helm_notice_outbox + helm_notice_outbox_claim), 0287 (hq_activate_plan / hq_extend_trial
--          re-issued with studio_today), 0277 (_hq_wgate, _hq27_require, _hq27_mfa_at, _hq27_write_perm, _hq27_sensitive,
--          helm_hq_settings.hq_reauth_minutes), 0283 + 0285 (claim filter + _r285_admins), 0166 (_is_trial_org),
--          0165 (email_is_opted_out), 0058 (notifications kind 'trial_reminder' = admin-only bell rows),
--          0144 / 0250 / 0254 / 0261 (event_activity chain).
--
-- In plain words:
--   1  HQ "Activate plan" now TELLS THE STUDIO. Until now hq_activate_plan made the plan active (payment + GST invoice)
--      but nobody in the studio heard about it. Now, when the plan really becomes active (not on a replay of the same
--      payment, not when an older payment leaves a newer period as it is):
--        * a bell notice for the studio's owner + admins ("Your <Plan> plan is active - thank you", billing interval,
--          next renewal date; kind 'trial_reminder' = the 0058 admin-only bell kind, source 'r120_plan_active', opens
--          the plan page), once per plan period (dedupe);
--        * an e-mail to the owner + every admin (not deactivated, not unsubscribed) through the existing Helm notice
--          lane: helm_notice_outbox kind 'plan_active' (dedupe 'plan_active:<studio>:<period start>:<period end>'),
--          handed out by helm_notice_outbox_claim (one branch added in place, recipients resolved there - never from
--          the row) and written by comms-dispatch (helm-notices.mjs). If the studio was on its FREE TRIAL the e-mail
--          also says the trial test mode is now off (real e-mails to clients go out from now on) and what was chosen
--          for the sample data (or how to choose: the dashboard asks the admin once).
--      A notice that cannot be queued NEVER blocks the activation (the payment + plan are kept; a warning is logged).
--      The 0244 / 0287 body is kept once as hq_activate_plan__pre0328 with NO app privilege (house wrapper pattern).
--   2  HQ "Extend trial" asks for a FRESH two-step code like the other big changes. _hq_wgate (every HQ change goes
--      through it) is wrapped once (0277 body kept as _hq_wgate__pre0328, no app privilege): after the usual role /
--      session checks, an action listed in _hq_fresh_code_action() needs a two-step code entered within the HQ
--      "fresh code" minutes (default 15) - else HQ_REAUTH, which /hq already answers by asking for the code and
--      retrying. Listed now: 'hq.trial.extend' only. Rename / business details (also studios.edit) are unchanged
--      (owner decision - add them to the list in one line).
--   3  Event activity in a free trial: event_activity marks a "link sent" line whose bell row says nothing was sent
--      (trial simulation 0323: suppressed_by trial_simulation / trial, or skipped free_trial 0195 / 0200 / 0212) with
--      trial_preview = true, so the event page reads "Approval link ready (trial preview - not sent)" - the same
--      words as the bell (store-api.js bellLabel). Paid studios never carry those markers: unchanged.
--      The 0261 body is kept once as event_activity__pre0328 with NO app privilege.
-- ZERO DATA LOSS: no table, column, row or policy is dropped or rewritten. The outbox kind check is widened to a
-- superset (every existing row still passes); one claim branch is added in place; three functions are wrapped (old
-- bodies kept). Additive + idempotent: safe to run twice. ASCII only. Goes after 0327 (independent of it).
-- ROLLBACK (manual, only if ever needed - SQL editor):
--   drop function public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric);
--   alter function public.hq_activate_plan__pre0328(uuid,text,text,numeric,text,date,date,text,text,numeric) rename to hq_activate_plan;
--   grant execute on function public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric) to authenticated;
--   drop function public._hq_wgate(text,text,text,jsonb); alter function public._hq_wgate__pre0328(text,text,text,jsonb) rename to _hq_wgate;
--   drop function public.event_activity(uuid); alter function public.event_activity__pre0328(uuid) rename to event_activity;
--   grant execute on function public.event_activity(uuid) to authenticated, service_role;
--   (queued 'plan_active' rows are then skipped by the claim; they can stay)

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)') is null then
    raise exception 'STOP 0328: hq_activate_plan (0244 / 0287) is missing'; end if;
  if to_regprocedure('public._sub_activate(uuid,uuid,text,date,date,uuid,text)') is null then
    raise exception 'STOP 0328: _sub_activate (0244) is missing'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0328: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public._hq27_mfa_at()') is null
     or to_regprocedure('public._hq27_write_perm(text)') is null or to_regprocedure('public._hq27_sensitive(text)') is null
     or to_regclass('public.helm_hq_settings') is null then
    raise exception 'STOP 0328: 0277 (HQ staff roles / fresh code) is not applied'; end if;
  if to_regprocedure('public._r285_admins(uuid)') is null then raise exception 'STOP 0328: 0285 (_r285_admins) is not applied'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then raise exception 'STOP 0328: 0166 (_is_trial_org) is not applied'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is null then raise exception 'STOP 0328: 0165 (email_is_opted_out) is not applied'; end if;
  if to_regprocedure('public.event_activity(uuid)') is null then raise exception 'STOP 0328: event_activity (0144 / 0261) is missing'; end if;
  if to_regclass('public.notifications') is null or to_regclass('public.helm_plans') is null or to_regclass('public.studio_subscriptions') is null then
    raise exception 'STOP 0328: notifications / helm_plans / studio_subscriptions missing'; end if;
end $$;

-- ---- 1) keep the current bodies once (__pre0328, no app privilege) -----------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values
      ('hq_activate_plan', 'uuid,text,text,numeric,text,date,date,text,text,numeric'),
      ('_hq_wgate', 'text,text,text,jsonb'),
      ('event_activity', 'uuid')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0328(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r120-0328' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0328');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0328(' || f.a || ')');
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    end if;
  end loop;
end $$;

-- ---- 2) the plan-active notice ------------------------------------------------------------------------------------------
-- "12 Nov 2026" (ASCII)
create or replace function public._r120_day(p date)
returns text language sql immutable set search_path = '' as $$
  -- r120-0328
  select case when p is null then null else ltrim(to_char(p, 'DD'), '0') || ' ' || to_char(p, 'Mon YYYY') end;
$$;

-- the bell line (plan name, billing, next renewal - never amounts, e-mails or links)
create or replace function public._r120_plan_label(p_plan text, p_interval text, p_renews date, p_was_trial boolean)
returns text language sql immutable set search_path = '' as $$
  -- r120-0328
  select left('Your ' || coalesce(nullif(btrim(p_plan), ''), 'Helm') || ' plan is active - thank you. Billing: '
    || case when p_interval = 'yearly' then 'yearly' else 'monthly' end
    || coalesce(', next renewal ' || public._r120_day(p_renews), '') || '.'
    || case when coalesce(p_was_trial, false) then ' Trial test mode is off: e-mails to your clients now really go out.' else '' end, 240);
$$;

-- one notice per plan period: bell row (owner + admins: kind 'trial_reminder' is admin-only, 0058) + queued e-mail.
-- Internal (no app privilege); called by hq_activate_plan after the plan really became active.
create or replace function public._r120_plan_active_notice(p_org uuid, p_was_trial boolean, p_res jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r120-0328
declare s public.studio_subscriptions; v_plan text; v_code text; v_key text; v_renews date; v_label text;
  v_bell boolean := false; v_mail boolean := false; v_id uuid;
begin
  if p_org is null or coalesce(p_res ->> 'result', '') <> 'activated'
     or coalesce(p_res -> 'activation' ->> 'result', '') <> 'activated' then
    return jsonb_build_object('queued', false, 'why', 'not_activated');
  end if;
  if exists (select 1 from public.organizations o where o.id = p_org and coalesce(o.is_sample_master, false)) then
    return jsonb_build_object('queued', false, 'why', 'sample');
  end if;
  select * into s from public.studio_subscriptions x where x.org_id = p_org;
  if s.org_id is null or s.status <> 'active' or s.current_period_start is null or s.current_period_end is null then
    return jsonb_build_object('queued', false, 'why', 'not_active');
  end if;
  select hp.name, hp.code into v_plan, v_code from public.helm_plans hp where hp.id = s.plan_id;
  v_renews := s.current_period_end + 1;
  v_key := 'plan_active:' || p_org::text || ':' || s.current_period_start::text || ':' || s.current_period_end::text;
  v_label := public._r120_plan_label(v_plan, s.billing_interval, v_renews, p_was_trial);
  if not exists (select 1 from public.notifications n where n.org_id = p_org and n.kind = 'trial_reminder'
                   and n.detail ->> 'dedupe' = v_key) then
    begin
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (null, 'in_app', 'trial_reminder', 'simulated',
                jsonb_build_object('label', v_label, 'source', 'r120_plan_active', 'plan', v_plan, 'plan_code', v_code,
                                   'interval', s.billing_interval, 'renews_on', v_renews, 'was_trial', coalesce(p_was_trial, false),
                                   'dedupe', v_key), p_org);
      v_bell := true;
    exception when others then raise warning 'r120-0328: plan-active bell row skipped (%)', sqlstate;
    end;
  end if;
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('plan_active', p_org, null,
              jsonb_build_object('plan', v_plan, 'plan_code', v_code, 'interval', s.billing_interval,
                                 'period_start', s.current_period_start, 'period_end', s.current_period_end,
                                 'renews_on', v_renews, 'was_trial', coalesce(p_was_trial, false)), v_key)
      on conflict (dedupe_key) do nothing
      returning id into v_id;
    v_mail := v_id is not null;
  exception when check_violation then raise warning 'r120-0328: outbox kind plan_active not allowed on this database - e-mail not queued';
  end;
  return jsonb_build_object('queued', v_bell or v_mail, 'bell', v_bell, 'email', v_mail);
end $$;

-- HQ "Activate plan": the kept body + the studio notice (never blocks the activation)
create or replace function public.hq_activate_plan(p_org uuid, p_plan_code text, p_interval text, p_amount numeric,
  p_method text, p_period_start date default null, p_paid_on date default null, p_reference text default null,
  p_currency text default 'INR', p_fx_rate_to_inr numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r120-0328: 0244 / 0287 body (hq_activate_plan__pre0328: gate, payment, activation) + tell the studio
declare v jsonb; v_n jsonb; v_status text; v_end date; v_was_trial boolean := false;
begin
  -- was the studio on its free trial (or a trial that just ended and never had a paid period) before this payment?
  if p_org is not null then
    select s.status, s.current_period_end into v_status, v_end from public.studio_subscriptions s where s.org_id = p_org;
    v_was_trial := public._is_trial_org(p_org)
      or (coalesce(v_status, '') = 'past_due' and v_end is null
          and (to_regprocedure('public._tu185_was_trial(uuid)') is null or public._tu185_was_trial(p_org)));
  end if;
  v := public.hq_activate_plan__pre0328(p_org, p_plan_code, p_interval, p_amount, p_method, p_period_start, p_paid_on,
                                        p_reference, p_currency, p_fx_rate_to_inr);
  begin
    v_n := public._r120_plan_active_notice(p_org, v_was_trial, v);
  exception when others then
    raise warning 'r120-0328: studio notice skipped (%)', sqlstate;
    v_n := jsonb_build_object('queued', false, 'why', 'error');
  end;
  return coalesce(v, '{}'::jsonb) || jsonb_build_object('studio_notice', v_n);
end $$;

-- the e-mail data + recipients (resolved at claim time - never from the row): owner + every admin, not deactivated
-- (_r285_admins), a real address, not unsubscribed from Helm's e-mails (0165). Never for the sample studio.
create or replace function public._r120_plan_mail(p_org uuid, p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r120-0328
declare o public.organizations; v_to jsonb; v_choice text; v_sample boolean := false; d jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  select * into o from public.organizations x where x.id = p_org;
  if o.id is null or coalesce(o.is_sample_master, false) then return null; end if;
  select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
    from public.profiles p
   where p.id in (select a from public._r285_admins(p_org) a)
     and p.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and not public.email_is_opted_out(null, p.email);
  v_choice := to_jsonb(o) ->> 'upgrade_choice';
  begin
    execute 'select exists (select 1 from public.quotes q where q.org_id = $1 and q.is_demo)' into v_sample using p_org;
  exception when others then v_sample := false;
  end;
  return jsonb_build_object('to', v_to, 'data', jsonb_build_object(
    'studio', o.name, 'plan', d ->> 'plan', 'interval', d ->> 'interval', 'period_start', d ->> 'period_start',
    'period_end', d ->> 'period_end', 'renews_on', d ->> 'renews_on',
    'was_trial', coalesce((d ->> 'was_trial')::boolean, false), 'choice', v_choice, 'has_sample', coalesce(v_sample, false)));
end $$;

-- outbox kind 'plan_active' (superset: every existing row still passes)
do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0328: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('''plan_active''' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0328: helm_notice_outbox kind check has an unexpected body - left unchanged (plan e-mails stay off; bells still work)'; return; end if;
  v_kinds := array(select distinct k from unnest(v_kinds || array['plan_active']) k order by k);
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0328 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0328 to helm_notice_outbox_kind_check;
end $$;

-- one claim branch (same place as 0285: at the end of the kind list, before the "never to a deactivated member" filter)
do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r120-plan-0328' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    -- r33-team-0283: never to a deactivated member';
  if position(v_old in v_def) = 0 then v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then'; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0328: helm_notice_outbox_claim has an unexpected body - left unchanged (plan e-mails are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind = ''plan_active'' and r.org_id is not null then\n'
        || E'      -- r120-plan-0328: HQ activated a plan -> the owner + every admin (resolved in _r120_plan_mail)\n'
        || E'      v_data := public._r120_plan_mail(r.org_id, r.payload);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 3) a fresh two-step code for chosen HQ changes (beyond the 0277 permission list) -----------------------------------
-- the list: add an HQ action here to make it ask for a fresh code (owner decision for 'hq.studio.identity' /
-- 'hq.studio_account.set')
create or replace function public._hq_fresh_code_action(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  -- r120-0328
  select coalesce(p_action, '') in ('hq.trial.extend');
$$;

create or replace function public._hq_wgate(p_action text, p_entity text, p_entity_id text, p_changed jsonb default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r120-0328: the 0277 gate (_hq_wgate__pre0328: role, sessions, fresh code by permission, audit row) + a fresh two-step
-- code for the actions in _hq_fresh_code_action (same rule and message as 0277: HQ_REAUTH; a token without amr skips it)
declare v_mfa timestamptz; v_min integer;
begin
  perform public._hq_wgate__pre0328(p_action, p_entity, p_entity_id, p_changed);
  if public._hq_fresh_code_action(p_action) then
    v_mfa := public._hq27_mfa_at();
    select x.hq_reauth_minutes into v_min from public.helm_hq_settings x where x.id;
    if v_mfa is not null and v_mfa < now() - make_interval(mins => coalesce(v_min, 15)) then
      raise exception 'not authorized: HQ_REAUTH enter a fresh two-step code to confirm this change' using errcode = '42501';
    end if;
  end if;
end $$;

-- ---- 4) event activity: trial previews are marked (the page words them like the bell) -----------------------------------
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r120-0328: the 0261 trail (event_activity__pre0328: studio + area checks) + trial_preview = true on a "link sent" line
-- whose bell row says nothing reached the client (trial simulation / free-trial skip)
declare v jsonb; v_org uuid := public.current_org_id();
begin
  v := public.event_activity__pre0328(p_quote);
  if v is null or jsonb_typeof(v) <> 'array' or v_org is null then return v; end if;
  if not exists (select 1 from public.notifications n where n.quote_id = p_quote and n.org_id = v_org
                   and (n.detail ->> 'suppressed_by' in ('trial_simulation', 'trial') or n.detail ->> 'skipped' = 'free_trial')) then
    return v;
  end if;
  return coalesce((select jsonb_agg(case
      when coalesce(e.i ->> 'kind', '') = 'notify' and exists (
             select 1 from public.notifications n
              where n.quote_id = p_quote and n.org_id = v_org
                and n.kind = btrim(split_part(replace(coalesce(e.i ->> 'text', ''), ' ' || chr(8594) || ' ', ' -> '), ' -> ', 1))
                and n.created_at = (e.i ->> 'at')::timestamptz
                and (n.detail ->> 'suppressed_by' in ('trial_simulation', 'trial') or n.detail ->> 'skipped' = 'free_trial'))
        then e.i || jsonb_build_object('trial_preview', true)
      else e.i end order by e.ord)
    from jsonb_array_elements(v) with ordinality e(i, ord)), v);
end $$;

-- ---- 5) privileges --------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: never callable by the API roles
  foreach f in array array['public._r120_day(date)', 'public._r120_plan_label(text, text, date, boolean)',
      'public._r120_plan_active_notice(uuid, boolean, jsonb)', 'public._r120_plan_mail(uuid, jsonb)',
      'public._hq_fresh_code_action(text)', 'public._hq_wgate(text, text, text, jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- signed-in only (each checks its caller inside), as before
  execute 'revoke all on function public.hq_activate_plan(uuid, text, text, numeric, text, date, date, text, text, numeric) from public';
  execute 'revoke all on function public.event_activity(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.hq_activate_plan(uuid, text, text, numeric, text, date, date, text, text, numeric) from anon';
    execute 'revoke all on function public.event_activity(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.hq_activate_plan(uuid, text, text, numeric, text, date, date, text, text, numeric) to authenticated';
    execute 'grant execute on function public.event_activity(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_activity(uuid) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
