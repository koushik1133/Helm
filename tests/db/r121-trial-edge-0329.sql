-- r121-trial-edge-0329.sql -- R121: free-trial edge cases.
-- Proves: (A5) an invitation of a studio whose free trial ended is PAUSED: invitation_preview says trial_paused + the
-- owner's display name + the plain sentence (valid stays true), accept_invitation refuses (hint trial_paused) and joins
-- nobody, the invitation row is untouched (still pending, same expiry), the invitation e-mail queue closes its unsent
-- e-mail as skipped (kept), invite_open_for_email no longer offers it, and it all works again once the trial is
-- extended / paid; an active trial is unchanged; (B8) the trial reminder + trial retention e-mails go to the CURRENT
-- owner after an ownership transfer (not organizations.created_by), dedupe keys unchanged; (C18) a client-role
-- invitation in a trial studio is refused for an app caller (insert + role switch), nothing queued, paid studio and
-- staff changes unchanged; (fresh code) rename + business details need a fresh two-step code (HQ_REAUTH, nothing
-- changed) and go through with one; (plan_active) the plan-active bell row has its own kind plan_active, admin-only,
-- in the catalog as "Plan active", mutable separately from billing_trial, an old trial_reminder row still dedupes;
-- kept __pre0329 bodies have no app privilege; re-run safe.
-- Re-applies 0329 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0329_r121_trial_edge_fixes.sql
\ir ../../supabase/migrations/0329_r121_trial_edge_fixes.sql
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
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); execute 'set role anon'; end $$;
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
declare h text; begin execute p_sql; return ''; exception when others then
  get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin', p_name text default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at, full_name) values (u, p_email, p_role, p_org, false, now(), p_name)
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email, full_name = coalesce(p_name, public.profiles.full_name);
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_name text default null) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email, null, 'admin', p_name); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.end_trial(p_org uuid) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '1 hour' where id = p_org;
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = p_org;
end $$;

-- ---- setup: HQ owner, trial studio P (Priya owns it; its trial will end), trial studio Q (stays active) --------------------
do $$ declare p uuid; q uuid; i uuid; t text; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active', require_mfa = false where email = 'admin@helm.events';
  update public.helm_hq_settings set hq_reauth_minutes = 15 where id;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r121studio', 'R121 Studio', 2999, 'INR', true)
    on conflict (code) do update set active = true, name = 'R121 Studio';
  update public.helm_sample_template set active = true where id;
  p := pg_temp.trial('r121_p@t.test', 'Priya Owner'); perform pg_temp.put('P', p::text);
  q := pg_temp.trial('r121_q@t.test', 'Quinn Owner'); perform pg_temp.put('Q', q::text);
  -- an open manager invitation of P, made while the trial was on (its e-mail is queued by the 0131 trigger)
  perform pg_temp.su();
  insert into public.invitations(org_id, email, role, status, expires_at, invited_by)
    values (p, 'r121_inv@t.test', 'manager', 'pending', now() + interval '7 days', (select id from auth.users where email = 'r121_p@t.test'))
    returning id, token into i, t;
  perform pg_temp.put('INV', i::text); perform pg_temp.put('TOK', t);
  perform pg_temp.put('EXP', (select expires_at::text from public.invitations where id = i));
  perform pg_temp.newuser('r121_inv@t.test', null, 'admin');            -- the invitee already has a login (no studio yet)
  update public.profiles set org_id = null where email = 'r121_inv@t.test';
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + privileges -----------------------------------------------------------------------------------------
do $$ declare f text; ok boolean := true; begin
  perform pg_temp.su();
  foreach f in array array['invitation_preview(text)', 'accept_invitation(text)', 'invite_email_outbox_claim(integer,uuid)',
      'invite_open_for_email(text)', 'trial_reminder_email_claim(integer)', 'trial_retention_email_claim(integer)',
      'notification_catalog()', 'notification_type_of(text,text)', 'notify_default(uuid,text,text,text)'] loop
    ok := ok and position('r121-0329' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || f))) > 0
      and to_regprocedure('public.' || replace(f, '(', '__pre0329(')) is not null
      and position('r121-0329' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || replace(f, '(', '__pre0329(')))) = 0
      and not has_function_privilege('anon', 'public.' || replace(f, '(', '__pre0329('), 'execute')
      and not has_function_privilege('authenticated', 'public.' || replace(f, '(', '__pre0329('), 'execute')
      and not has_function_privilege('service_role', 'public.' || replace(f, '(', '__pre0329('), 'execute');
  end loop;
  perform pg_temp.res('01 nine wrappers carry the 0329 marker; old bodies kept ONCE as __pre0329 with no app privilege', ok);
  perform pg_temp.res('02 entry points keep exactly their old roles',
    has_function_privilege('anon', 'public.invitation_preview(text)', 'execute')
    and has_function_privilege('authenticated', 'public.accept_invitation(text)', 'execute')
    and not has_function_privilege('anon', 'public.accept_invitation(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_email_outbox_claim(integer,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.invite_email_outbox_claim(integer,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_open_for_email(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_reminder_email_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.trial_retention_email_claim(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')
    and not has_function_privilege('anon', 'public.notification_catalog()', 'execute')
    and not has_function_privilege('authenticated', 'public.notify_default(uuid,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r329_pause_text(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r329_owner_name(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq_fresh_code_action(text)', 'execute'));
  perform pg_temp.res('03 the client-invite trigger is there once',
    (select count(*) from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'a329_trial_client_invite') = 1);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) A5: active trial unchanged; ended trial -> paused -------------------------------------------------------------------
do $$ declare p uuid := pg_temp.get('P')::uuid; tok text := pg_temp.get('TOK'); v jsonb; e text; j jsonb; begin
  perform pg_temp.anon();
  v := public.invitation_preview(tok);
  perform pg_temp.su();
  perform pg_temp.res('04 active trial: preview valid, trial_paused false (nothing else changed)',
    (v ->> 'valid')::boolean and not (v ->> 'trial_paused')::boolean and not (v ? 'message'), v::text);
  perform pg_temp.end_trial(p);
  perform pg_temp.res('05 the studio is now a locked (ended) trial', public._trial_locked(p));
  perform pg_temp.anon();
  v := public.invitation_preview(tok);
  perform pg_temp.su();
  perform pg_temp.res('06 ended trial: preview says trial_paused with the owner''s name and the plain sentence; valid stays true',
    (v ->> 'valid')::boolean and (v ->> 'trial_paused')::boolean and v ->> 'owner_name' = 'Priya Owner'
    and v ->> 'message' = 'This studio''s free trial has ended. Ask Priya Owner to choose a plan, then open this invitation again.'
    and not (v ? 'email'), v::text);
  perform pg_temp.login('r121_inv@t.test');
  e := pg_temp.try(format('select public.accept_invitation(%L)', tok));
  perform pg_temp.su();
  perform pg_temp.res('07 accept refused with the sentence (hint trial_paused); the invitee joined nothing',
    e like '42501 This studio''s free trial has ended. Ask Priya Owner%[trial_paused]'
    and (select org_id from public.profiles where email = 'r121_inv@t.test') is null, e);
  perform pg_temp.res('08 the invitation is untouched: still pending, same expiry (paused, not expired)',
    (select status = 'pending' and expires_at::text = pg_temp.get('EXP') from public.invitations where id = pg_temp.get('INV')::uuid));
  perform pg_temp.svc();
  j := public.invite_email_outbox_claim(100, null);
  perform pg_temp.su();
  perform pg_temp.res('09 the unsent invitation e-mail is closed as skipped (kept), not handed out',
    not exists (select 1 from jsonb_array_elements(j) x where x ->> 'token' = tok)
    and exists (select 1 from public.invite_email_outbox o where o.invitation_id = pg_temp.get('INV')::uuid and o.status = 'skipped'), j::text);
  perform pg_temp.svc();
  v := public.invite_open_for_email('r121_inv@t.test');
  perform pg_temp.su();
  perform pg_temp.res('10 the trial sign-up is not offered the paused invitation', not (v ->> 'found')::boolean, v::text);
  -- HQ extends the trial: the same invitation works again
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = p;
  update public.studio_subscriptions set trial_ends_at = current_date + 3, status = 'trial' where org_id = p;
  perform pg_temp.anon();
  v := public.invitation_preview(tok);
  perform pg_temp.su();
  perform pg_temp.svc();
  j := public.invite_open_for_email('r121_inv@t.test');
  perform pg_temp.su();
  perform pg_temp.res('11 once the studio is unlocked the same invitation is valid again (preview + sign-up offer)',
    (v ->> 'valid')::boolean and not (v ->> 'trial_paused')::boolean and (j ->> 'found')::boolean and j ->> 'token' = tok, v::text || j::text);
  perform pg_temp.login('r121_inv@t.test');
  e := pg_temp.try(format('select public.accept_invitation(%L)', tok));
  perform pg_temp.su();
  perform pg_temp.res('12 ... and accept joins the studio as before',
    e = '' and (select org_id from public.profiles where email = 'r121_inv@t.test') = p, e);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) B8: trial e-mails go to the CURRENT owner after a transfer --------------------------------------------------------
do $$ declare q uuid := pg_temp.get('Q')::uuid; nw uuid; old uuid; j jsonb; k text; id1 uuid; id2 uuid; x jsonb; y jsonb; begin
  perform pg_temp.su();
  old := (select id from auth.users where email = 'r121_q@t.test');
  nw := pg_temp.newuser('r121_q_new@t.test', q, 'admin', 'New Owner');
  update public.organizations set business_email = null, business_email_confirmed = false where id = q;
  insert into public.team_owner_log(org_id, user_id, prev_user_id, source, reason) values (q, nw, old, 'transfer', 'r121 test hand-over');
  perform pg_temp.res('13 setup: created_by is still the first owner, the current owner is the new one',
    (select created_by from public.organizations where id = q) = old and public._r283_owner(q) = nw);
  k := 'r121-test:' || q::text || ':d5';
  insert into public.trial_reminders(org_id, milestone, trial_ends_at, dedupe_key)
    values (q, 'd5', (select trial_ends_at from public.organizations where id = q), k) returning id into id1;
  perform pg_temp.svc();
  j := public.trial_reminder_email_claim(100);
  perform pg_temp.su();
  select e into x from jsonb_array_elements(j) e where (e ->> 'id')::uuid = id1;
  perform pg_temp.res('14 trial reminder e-mail goes to the CURRENT owner (not created_by); key unchanged',
    x ->> 'to' = 'r121_q_new@t.test' and (select dedupe_key from public.trial_reminders where id = id1) = k, coalesce(x::text, j::text));
  -- ended trial: the +7 days notice
  perform pg_temp.end_trial(q);
  update public.studio_subscriptions set status = 'past_due' where org_id = q;
  insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key)
    values (q, 'x7', public._trial_expired_at(q), 'r121-test:' || q::text || ':x7') returning id into id2;
  perform pg_temp.svc();
  j := public.trial_retention_email_claim(100);
  perform pg_temp.su();
  select e into y from jsonb_array_elements(j) e where (e ->> 'id')::uuid = id2;
  perform pg_temp.res('15 trial-ended +7 days e-mail goes to the CURRENT owner too',
    y ->> 'to' = 'r121_q_new@t.test', coalesce(y::text, j::text));
  perform pg_temp.res('16 same address as the billing reminders (studio_billing_email)', public.studio_billing_email(q) = 'r121_q_new@t.test');
  -- a confirmed studio e-mail is preferred (0300 rule), an unconfirmed one never
  update public.organizations set business_email = 'r121-studio@t.test', business_email_confirmed = false where id = q;
  perform pg_temp.res('17 an unconfirmed studio e-mail is never used', public.studio_billing_email(q) = 'r121_q_new@t.test');
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) C18: no client-role invitations in a trial -------------------------------------------------------------------------
do $$ declare t uuid; b uuid := 'b0000000-0000-4000-8000-000000000001'; e text; n0 int; n1 int; i uuid; begin
  perform pg_temp.su();
  t := pg_temp.trial('r121_c@t.test');
  select count(*) into n0 from public.invite_email_outbox where org_id = t;
  perform pg_temp.login('r121_c@t.test');
  e := pg_temp.try($q$select public.create_invitation('r121_client@t.test', 'client')$q$);
  perform pg_temp.su();
  select count(*) into n1 from public.invite_email_outbox where org_id = t;
  perform pg_temp.res('18 trial: create_invitation(client) refused with the plain sentence; nothing inserted, no e-mail queued',
    e like '42501 Client invitations are switched off during the free trial - share the preview instead.%[trial_client_invite]'
    and not exists (select 1 from public.invitations where org_id = t and email = 'r121_client@t.test') and n1 = n0, e);
  perform pg_temp.login('r121_c@t.test');
  e := pg_temp.try(format($q$insert into public.invitations(org_id, email, role) values (%L, 'r121_client2@t.test', 'client')$q$, t));
  perform pg_temp.su();
  perform pg_temp.res('19 trial: a direct REST insert of a client invitation is refused too', e like '42501%' and e <> '', e);
  perform pg_temp.login('r121_c@t.test');
  e := pg_temp.try($q$select public.create_invitation('r121_mgr@t.test', 'manager')$q$);
  perform pg_temp.su();
  select id into i from public.invitations where org_id = t and email = 'r121_mgr@t.test';
  perform pg_temp.res('20 trial: a staff invitation still works', e = '' and i is not null, e);
  perform pg_temp.login('r121_c@t.test');
  e := pg_temp.try(format($q$update public.invitations set role = 'client' where id = %L$q$, i));
  perform pg_temp.su();
  perform pg_temp.res('21 trial: switching an open invitation to client is refused',
    e like '42501%' and (select role from public.invitations where id = i) = 'manager', e);
  -- staff / service (no app caller) is not held to it; its e-mail is still never sent in a trial
  insert into public.invitations(org_id, email, role, status, expires_at) values (t, 'r121_client3@t.test', 'client', 'pending', now() + interval '7 days')
    returning id into i;
  perform pg_temp.svc();
  perform public.invite_email_outbox_claim(100, t);
  perform pg_temp.su();
  perform pg_temp.res('22 a client invitation made by Helm staff in a trial: allowed, but its e-mail is closed as skipped',
    not exists (select 1 from public.invite_email_outbox o where o.invitation_id = i and o.status <> 'skipped'));
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try($q$select public.create_invitation('r121_paidclient@t.test', 'client')$q$);
  perform pg_temp.su();
  perform pg_temp.res('23 a paid studio is unchanged (no trial_client_invite refusal)', e not like '%trial_client_invite%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) fresh two-step code for rename + business details ----------------------------------------------------------------
do $$ declare y uuid; e text; v_name text; begin
  perform pg_temp.su();
  perform pg_temp.res('24 the fresh-code list: extend trial, rename, business details (and not the rest)',
    public._hq_fresh_code_action('hq.trial.extend') and public._hq_fresh_code_action('hq.studio.identity')
    and public._hq_fresh_code_action('hq.studio_account.set') and not public._hq_fresh_code_action('hq.sales_request.status'));
  y := pg_temp.trial('r121_y@t.test');
  select name into v_name from public.organizations where id = y;
  perform pg_temp.op(interval '1 hour');
  e := pg_temp.try(format($q$select public.hq_set_studio_identity(%L::uuid, 'R121 Renamed Studio', null, 'r121 owner asked by phone, call back confirmed')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('25 rename with a code entered 1 hour ago: HQ_REAUTH, name unchanged',
    e like '42501%HQ_REAUTH%' and (select name from public.organizations where id = y) = v_name, e);
  perform pg_temp.op(interval '2 minutes');
  e := pg_temp.try(format($q$select public.hq_set_studio_identity(%L::uuid, 'R121 Renamed Studio', null, 'r121 owner asked by phone, call back confirmed')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('26 rename with a fresh code goes through', e = '' and (select name from public.organizations where id = y) = 'R121 Renamed Studio', e);
  perform pg_temp.op(interval '1 hour');
  e := pg_temp.try(format($q$select public.hq_set_studio_account(%L::uuid, '{"city":"R121 Town"}')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('27 business details with an old code: HQ_REAUTH', e like '42501%HQ_REAUTH%', e);
  perform pg_temp.op(interval '2 minutes');
  e := pg_temp.try(format($q$select public.hq_set_studio_account(%L::uuid, '{"city":"R121 Town"}')$q$, y));
  perform pg_temp.su();
  perform pg_temp.res('28 business details with a fresh code go through', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) plan_active: its own bell kind --------------------------------------------------------------------------------------
do $$ declare t uuid; r jsonb; c jsonb; mgr uuid; begin
  perform pg_temp.su();
  select e into c from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'plan_active';
  perform pg_temp.res('29 catalog: plan_active "Plan active" (Billing, in-app), once; kind -> type plan_active; billing_trial kept',
    c ->> 'label' = 'Plan active' and c ->> 'group' = 'Billing'
    and (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'plan_active') = 1
    and (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'billing_trial') = 1
    and public.notification_type_of('plan_active', 'in_app') = 'plan_active'
    and public.notification_type_of('trial_reminder', 'in_app') = 'billing_trial', coalesce(c::text, ''));
  perform pg_temp.res('30 admins only by default',
    public.notify_default(null, 'admin', 'plan_active', 'in_app') and not public.notify_default(null, 'manager', 'plan_active', 'in_app'));
  t := pg_temp.trial('r121_t@t.test');
  mgr := pg_temp.newuser('r121_t_mgr@t.test', t, 'manager');
  perform pg_temp.op();
  r := public.hq_activate_plan(t, 'r121studio', 'monthly', 3538.82, 'bank', current_date, current_date, 'NEFT-R121');
  perform pg_temp.su();
  perform pg_temp.res('31 activation writes ONE bell row of kind plan_active (not trial_reminder)',
    r ->> 'result' = 'activated' and (r -> 'studio_notice' ->> 'bell')::boolean
    and (select count(*) from public.notifications n where n.org_id = t and n.detail ->> 'source' = 'r120_plan_active') = 1
    and exists (select 1 from public.notifications n where n.org_id = t and n.kind = 'plan_active'), r::text);
  perform pg_temp.login('r121_t_mgr@t.test');
  perform pg_temp.res('32 a manager cannot read it (admin-only policy)',
    not exists (select 1 from public.notifications n where n.org_id = t and n.kind = 'plan_active'));
  perform pg_temp.login('r121_t@t.test');
  perform pg_temp.res('33 the studio admin can read it, and cannot write one',
    exists (select 1 from public.notifications n where n.org_id = t and n.kind = 'plan_active')
    and pg_temp.try(format($q$insert into public.notifications(channel, kind, status, org_id) values ('in_app', 'plan_active', 'simulated', %L)$q$, t)) <> '');
  perform pg_temp.su();
  -- muting billing_trial does not hide it; muting plan_active does
  insert into public.notification_mutes(user_id, org_id, type) values ((select id from auth.users where email = 'r121_t@t.test'), t, 'billing_trial') on conflict do nothing;
  perform pg_temp.res('34 muting "Free trial reminders" leaves the Plan active notice visible',
    exists (select 1 from public._r23_visible(t, (select id from auth.users where email = 'r121_t@t.test')) v where v.kind = 'plan_active'));
  insert into public.notification_mutes(user_id, org_id, type) values ((select id from auth.users where email = 'r121_t@t.test'), t, 'plan_active') on conflict do nothing;
  perform pg_temp.res('35 muting "Plan active" hides it on its own',
    not exists (select 1 from public._r23_visible(t, (select id from auth.users where email = 'r121_t@t.test')) v where v.kind = 'plan_active'));
  -- an old 0328 row (kind trial_reminder) for the same period still counts: nothing is told twice
  delete from public.notifications n where n.org_id = t and n.kind = 'plan_active';
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    select null, 'in_app', 'trial_reminder', 'simulated', jsonb_build_object('source', 'r120_plan_active',
      'dedupe', 'plan_active:' || t::text || ':' || s.current_period_start::text || ':' || s.current_period_end::text), t
      from public.studio_subscriptions s where s.org_id = t;
  r := public._r120_plan_active_notice(t, false, '{"result":"activated","activation":{"result":"activated"}}');
  perform pg_temp.res('36 an old trial_reminder row for the same period still dedupes (no second bell)',
    not (r ->> 'bell')::boolean and not exists (select 1 from public.notifications n where n.org_id = t and n.kind = 'plan_active'), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R121-TRIAL-EDGE-0329: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R121-TRIAL-EDGE-0329: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
