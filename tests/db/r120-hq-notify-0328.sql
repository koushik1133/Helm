-- r120-hq-notify-0328.sql -- R120: HQ "Activate plan" tells the studio, a fresh two-step code for "Extend trial",
-- trial-preview lines in the event activity.
-- Proves: activating a TRIAL studio's plan writes ONE admin-only bell row (plan, billing, next renewal, trial test mode
-- off) + ONE queued 'plan_active' e-mail; the claim hands it to the owner / admins only (never a client or a member)
-- with plan / interval / renewal / was_trial / choice / has_sample; the same payment again (replay) adds nothing; a PAID
-- studio's activation says was_trial false; the activation never fails because of the notice; HQ "Extend trial" with a
-- two-step code entered an hour ago -> HQ_REAUTH (nothing changed), with a fresh code -> extended; another studios.edit
-- change is not asked for a fresh code; event_activity marks only the trial-preview "link sent" line (trial_preview),
-- a real send stays unmarked; kept __pre0328 bodies have no app privilege; re-run safe.
-- Re-applies 0328 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0328_r120_hq_notify_trial_wording.sql
\ir ../../supabase/migrations/0328_r120_hq_notify_trial_wording.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
-- the HQ owner; p_code_age = when the two-step code was entered (null = a token without amr)
create or replace function pg_temp.op(p_code_age interval default null) returns void language plpgsql as $$
declare u uuid; c jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  c := jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2');
  if p_code_age is not null then
    c := c || jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_code_age)::bigint)));
  end if;
  perform set_config('request.jwt.claims', c::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;

-- ---- setup: HQ owner, an active plan, trial studios T (activate) and X (extend), paid fixture studio B --------------------
do $$ declare t uuid; x uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active', require_mfa = false where email = 'admin@helm.events';
  update public.helm_hq_settings set hq_reauth_minutes = 15 where id;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r120studio', 'R120 Studio', 2999, 'INR', true)
    on conflict (code) do update set active = true, name = 'R120 Studio';
  update public.helm_sample_template set active = true where id;
  t := pg_temp.trial('r120_t@t.test'); perform pg_temp.put('T', t::text);
  x := pg_temp.trial('r120_x@t.test'); perform pg_temp.put('X', x::text);
  perform pg_temp.newuser('r120_t_mgr@t.test', t, 'manager');
  perform pg_temp.newuser('r120_t_cli@t.test', t, 'client');
  perform pg_temp.newuser('r120_t_adm2@t.test', t, 'admin');
  delete from public.helm_notice_outbox where kind = 'plan_active';   -- only this file's rows below
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + privileges -----------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 the three wrappers carry the 0328 marker; the old bodies are kept once as __pre0328',
    (select bool_and(position('r120-0328' in p.prosrc) > 0) from pg_proc p where p.oid in (
       'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)'::regprocedure,
       'public._hq_wgate(text,text,text,jsonb)'::regprocedure, 'public.event_activity(uuid)'::regprocedure))
    and to_regprocedure('public.hq_activate_plan__pre0328(uuid,text,text,numeric,text,date,date,text,text,numeric)') is not null
    and to_regprocedure('public._hq_wgate__pre0328(text,text,text,jsonb)') is not null
    and to_regprocedure('public.event_activity__pre0328(uuid)') is not null
    and position('r120-0328' in (select p.prosrc from pg_proc p where p.oid = 'public._hq_wgate__pre0328(text,text,text,jsonb)'::regprocedure)) = 0);
  perform pg_temp.res('02 kept bodies + internal helpers: no app privilege (anon / authenticated / service_role)',
    not has_function_privilege('authenticated', 'public.hq_activate_plan__pre0328(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq_wgate__pre0328(text,text,text,jsonb)', 'execute')
    and not has_function_privilege('service_role', 'public.event_activity__pre0328(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_activity__pre0328(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq_wgate(text,text,text,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r120_plan_active_notice(uuid,boolean,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r120_plan_mail(uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public._r120_plan_mail(uuid,jsonb)', 'execute'));
  perform pg_temp.res('03 public entry points keep their grants (authenticated yes, anon no)',
    has_function_privilege('authenticated', 'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
    and not has_function_privilege('anon', 'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
    and has_function_privilege('authenticated', 'public.event_activity(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_activity(uuid)', 'execute'));
  perform pg_temp.res('04 outbox kind check: superset with plan_active; claim has ONE plan_active branch (re-run safe)',
    (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass
       and c.conname = 'helm_notice_outbox_kind_check') ~ 'plan_active.*studio_security|studio_security.*plan_active'
    and (select (length(d) - length(replace(d, 'r120-plan-0328', ''))) / length('r120-plan-0328')
           from (select pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure) d) z) = 1);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) activate a TRIAL studio: bell + e-mail ----------------------------------------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; r jsonb; n jsonb; k text; s public.studio_subscriptions; begin
  perform pg_temp.res('05 before: T is on its free trial', public._is_trial_org(t));
  perform pg_temp.op();
  r := public.hq_activate_plan(t, 'r120studio', 'yearly', 35388, 'bank', date '2026-11-01', date '2026-11-01', 'NEFT-R120');
  perform pg_temp.su();
  select * into s from public.studio_subscriptions where org_id = t;
  perform pg_temp.res('06 activation unchanged: active, yearly, 1 Nov 2026 - 31 Oct 2027, result activated + studio_notice queued',
    r ->> 'result' = 'activated' and s.status = 'active' and s.billing_interval = 'yearly'
    and s.current_period_start = date '2026-11-01' and s.current_period_end = date '2027-10-31'
    and (r -> 'studio_notice' ->> 'queued')::boolean and (r -> 'studio_notice' ->> 'bell')::boolean and (r -> 'studio_notice' ->> 'email')::boolean, r::text);
  select n2.detail into n from public.notifications n2 where n2.org_id = t and n2.kind = 'trial_reminder' and n2.detail ->> 'source' = 'r120_plan_active';
  perform pg_temp.res('07 ONE bell row (kind trial_reminder = admins only): plan, yearly, next renewal 1 Nov 2027, trial test mode off',
    (select count(*) from public.notifications n2 where n2.org_id = t and n2.detail ->> 'source' = 'r120_plan_active') = 1
    and n ->> 'label' = 'Your R120 Studio plan is active - thank you. Billing: yearly, next renewal 1 Nov 2027. Trial test mode is off: e-mails to your clients now really go out.'
    and n ->> 'renews_on' = '2027-11-01' and (n ->> 'was_trial')::boolean and n ->> 'plan_code' = 'r120studio', coalesce(n::text, '<none>'));
  k := 'plan_active:' || t::text || ':2026-11-01:2027-10-31';
  perform pg_temp.res('08 ONE queued e-mail (kind plan_active, dedupe per plan period), no recipients stored in the row',
    (select count(*) from public.helm_notice_outbox o where o.org_id = t and o.kind = 'plan_active') = 1
    and exists (select 1 from public.helm_notice_outbox o where o.dedupe_key = k and o.status = 'pending'
                  and (o.payload ->> 'was_trial')::boolean and o.payload ->> 'renews_on' = '2027-11-01' and not (o.payload ? 'to')));
  perform pg_temp.login('r120_t_mgr@t.test');
  perform pg_temp.res('09 a non-admin member of the studio cannot read the bell row (0058 admin-only kind)',
    not exists (select 1 from public.notifications n2 where n2.org_id = t and n2.detail ->> 'source' = 'r120_plan_active'));
  perform pg_temp.login('r120_t@t.test');
  perform pg_temp.res('10 the studio admin can read it',
    exists (select 1 from public.notifications n2 where n2.org_id = t and n2.detail ->> 'source' = 'r120_plan_active'));
  perform pg_temp.su();
  -- the same payment again (double click): replay, nothing new
  perform pg_temp.op();
  r := public.hq_activate_plan(t, 'r120studio', 'yearly', 35388, 'bank', date '2026-11-01', date '2026-11-01', 'NEFT-R120');
  perform pg_temp.su();
  perform pg_temp.res('11 the same payment again: replay, still ONE bell row and ONE e-mail',
    r ->> 'result' = 'replay' and not (r -> 'studio_notice' ->> 'queued')::boolean
    and (select count(*) from public.notifications n2 where n2.org_id = t and n2.detail ->> 'source' = 'r120_plan_active') = 1
    and (select count(*) from public.helm_notice_outbox o where o.org_id = t and o.kind = 'plan_active') = 1, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) the claim: owner + admins only, data for the template --------------------------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; j jsonb; x jsonb; v_to text[]; begin
  perform pg_temp.svc();
  j := public.helm_notice_outbox_claim(100);
  perform pg_temp.su();
  select e into x from jsonb_array_elements(j) e where e ->> 'kind' = 'plan_active' limit 1;
  select array_agg(v order by v) into v_to from jsonb_array_elements_text(x -> 'to') v;
  perform pg_temp.res('12 claim: the plan_active e-mail goes to the owner + every admin (not the manager, not the client)',
    v_to @> array['r120_t@t.test', 'r120_t_adm2@t.test'] and not (v_to && array['r120_t_mgr@t.test', 'r120_t_cli@t.test']), coalesce(x::text, j::text));
  perform pg_temp.res('13 claim data: studio, plan, yearly, period, renews_on, was_trial true, choice null, has_sample',
    x -> 'data' ->> 'plan' = 'R120 Studio' and x -> 'data' ->> 'interval' = 'yearly' and x -> 'data' ->> 'renews_on' = '2027-11-01'
    and x -> 'data' ->> 'period_start' = '2026-11-01' and x -> 'data' ->> 'period_end' = '2027-10-31'
    and (x -> 'data' ->> 'was_trial')::boolean and x -> 'data' -> 'choice' = 'null'::jsonb and x -> 'data' ? 'has_sample'
    and x -> 'data' ->> 'studio' = (select o.name from public.organizations o where o.id = t), coalesce(x::text, ''));
  perform pg_temp.svc();
  j := public.helm_notice_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('14 a second claim right away does not hand it out again',
    not exists (select 1 from jsonb_array_elements(j) e where e ->> 'kind' = 'plan_active'), j::text);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) a PAID studio (fixture B, never a trial): was_trial false ------------------------------------------------------------
do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; r jsonb; begin
  perform pg_temp.op();
  r := public.hq_activate_plan(b, 'r120studio', 'monthly', 3538.82, 'upi', current_date, current_date, 'UPI-R120');
  perform pg_temp.su();
  perform pg_temp.res('15 paid studio: activated, bell + e-mail queued with was_trial false (no trial wording)',
    r ->> 'result' = 'activated' and (r -> 'studio_notice' ->> 'queued')::boolean
    and exists (select 1 from public.helm_notice_outbox o where o.org_id = b and o.kind = 'plan_active' and not (o.payload ->> 'was_trial')::boolean)
    and exists (select 1 from public.notifications n where n.org_id = b and n.detail ->> 'source' = 'r120_plan_active'
                  and n.detail ->> 'label' not like '%Trial%' and n.detail ->> 'label' like '%Billing: monthly, next renewal %'), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) the notice never blocks the activation -------------------------------------------------------------------------------
do $$ declare r jsonb; v_def text; begin
  perform pg_temp.su();
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  -- an outbox that refuses the kind (a database where the check was not widened): the plan + bell still go through
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check check (kind in ('sales_request', 'upgrade_ask')) not valid;
  perform pg_temp.op();
  r := public.hq_activate_plan(pg_temp.get('X')::uuid, 'r120studio', 'monthly', 3538.82, 'cash', current_date, current_date, 'CASH-R120');
  perform pg_temp.su();
  perform pg_temp.res('16 outbox refuses plan_active: the plan is still activated (bell written, e-mail not queued, no error)',
    r ->> 'result' = 'activated' and (r -> 'studio_notice' ->> 'bell')::boolean and not (r -> 'studio_notice' ->> 'email')::boolean
    and (select status from public.studio_subscriptions where org_id = pg_temp.get('X')::uuid) = 'active', r::text);
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  execute 'alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check ' || v_def;
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) Extend trial needs a fresh two-step code ------------------------------------------------------------------------------
do $$ declare y uuid; z uuid; e text; e2 text; v_before timestamptz; n0 int; n1 int; begin
  perform pg_temp.su();
  y := pg_temp.trial('r120_y@t.test'); perform pg_temp.put('Y', y::text);
  select trial_ends_at into v_before from public.organizations where id = y;
  select count(*) into n0 from public.audit_log where action = 'hq.trial.extend' and entity_id = y::text;
  perform pg_temp.op(interval '1 hour');
  e := pg_temp.try(format($q$select public.hq_extend_trial(%L::uuid, 3, 'r120 customer asked for more time')$q$, y));
  perform pg_temp.su();
  select count(*) into n1 from public.audit_log where action = 'hq.trial.extend' and entity_id = y::text;
  perform pg_temp.res('17 Extend trial with a code entered 1 hour ago: HQ_REAUTH, trial end unchanged, no audit row kept',
    e like '42501%HQ_REAUTH%' and (select trial_ends_at from public.organizations where id = y) = v_before and n1 = n0, e);
  perform pg_temp.op(interval '2 minutes');
  e := pg_temp.try(format($q$select public.hq_extend_trial(%L::uuid, 3, 'r120 customer asked for more time')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('18 with a fresh code (2 min): extended by 3 days',
    e = '' and (select trial_ends_at from public.organizations where id = y) >= v_before + interval '3 days' - interval '1 minute', e);
  perform pg_temp.op(interval '1 hour');
  e2 := pg_temp.try(format($q$select public.hq_set_studio_identity(%L::uuid, 'R120 Renamed Studio', null, 'r120 owner asked by phone, call back confirmed')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('19 another studios.edit change (rename) is NOT asked for a fresh code (owner decision): it goes through',
    e2 = '' and (select name from public.organizations where id = y) = 'R120 Renamed Studio', e2);
  z := pg_temp.trial('r120_z@t.test');
  perform pg_temp.op();
  e := pg_temp.try(format($q$select public.hq_extend_trial(%L::uuid, 2, 'r120 token without amr list')$q$, z));
  perform pg_temp.su();
  perform pg_temp.res('20 a token without an amr list is not asked (same rule as 0277): extended', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) event activity: the trial preview line is marked ---------------------------------------------------------------------
do $$ declare y uuid := pg_temp.get('Y')::uuid; q uuid; a jsonb; v_prev jsonb; v_real jsonb; v_pay jsonb; begin
  perform pg_temp.su();
  select id into q from public.quotes where org_id = y order by created_at limit 1;
  if q is null then raise exception 'no quote in the trial studio'; end if;
  insert into public.notifications(quote_id, channel, kind, status, recipient, detail, org_id, created_at) values
    (q, 'email', 'approval_link', 'simulated', 'client@r120.test', '{"suppressed_by":"trial_simulation"}', y, now() - interval '3 hours'),
    (q, 'email', 'booklet_link', 'suppressed', 'client@r120.test', '{"skipped":"free_trial"}', y, now() - interval '2 hours'),
    (q, 'email', 'approval_link', 'sent', 'client@r120.test', '{}', y, now() - interval '1 hour'),
    (q, 'email', 'payment_link', 'sent', 'client@r120.test', '{}', y, now() - interval '30 minutes');
  perform pg_temp.login('r120_y@t.test');
  a := public.event_activity(q);
  perform pg_temp.su();
  select e into v_prev from jsonb_array_elements(a) e where e ->> 'kind' = 'notify' and e ->> 'text' like 'approval_link%'
    and (e ->> 'at')::timestamptz < now() - interval '150 minutes';
  select e into v_real from jsonb_array_elements(a) e where e ->> 'kind' = 'notify' and e ->> 'text' like 'approval_link%'
    and (e ->> 'at')::timestamptz > now() - interval '90 minutes';
  select e into v_pay from jsonb_array_elements(a) e where e ->> 'kind' = 'notify' and e ->> 'text' like 'payment_link%';
  perform pg_temp.res('21 trial-preview approval link + booklet link are marked trial_preview',
    (v_prev ->> 'trial_preview')::boolean
    and exists (select 1 from jsonb_array_elements(a) e where e ->> 'text' like 'booklet_link%' and (e ->> 'trial_preview')::boolean), coalesce(a::text, ''));
  perform pg_temp.res('22 a real send and other kinds stay unmarked; the trail is otherwise the same as the kept body',
    v_real is not null and not (v_real ? 'trial_preview') and v_pay is not null and not (v_pay ? 'trial_preview')
    and jsonb_array_length(a) = (select count(*) from jsonb_array_elements(a)), coalesce(a::text, ''));
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('23 another studio cannot read this event activity', pg_temp.try(format('select public.event_activity(%L::uuid)', q)) <> '');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R120-HQ-NOTIFY-0328: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R120-HQ-NOTIFY-0328: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
