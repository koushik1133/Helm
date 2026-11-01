-- r114-trial-sim-0323.sql - 0323 (R114 owner decision): a FREE TRIAL studio is a full SIMULATION.
-- Proves:
--   (1) a trial studio never e-mails its client: _tr212_email_ok is false, trial_email_gate answers {allowed:false,
--       trial:true} and takes no slot, my_trial_messaging says email:false, the app cannot take ANY trial e-mail slot
--       (42501 trial_no_send), a booklet link "Send to client" by e-mail is stored 'skipped' (never handed out);
--   (2) the simulated payment: refused before approval; after the test approval (000000) it records ONE test row per
--       open milestone (or one for the total), audit 'payment.simulated', receipt TEST-..., then "already" - and the
--       real money ledger (quote_payments, payment_milestones) is never touched;
--   (3) an ENDED trial / a viewer signed in to another studio cannot simulate; unknown links -> null / invalid link;
--   (4) the client pages' banner answer public_trial_simulation (approval link, booklet, invitation site);
--   (5) a PAID studio is unchanged: e-mail gate allowed, messaging email true, no simulation (trial_only);
--   (6) structure: grants, RLS, the kept 0212 body, the trigger, the trial-retention purge list.
-- Re-applies 0323 twice. Every case is rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0323_r114_trial_simulation.sql
\ir ../../supabase/migrations/0323_r114_trial_simulation.sql
set client_min_messages = warning;
begin;
drop table if exists _g323; create temp table _g323(name text, result text); grant all on _g323 to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g323 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who = 'service' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set local role service_role';
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;

-- one case: set the studio up (p_status 'trial' / 'active'; p_ended = trial over; p_ms = milestones), run p_kind, report,
-- roll back
create or replace function pg_temp.run_case(p_kind text, p_status text, p_ended boolean default false, p_ms int default 0,
                                            p_who text default 'anon')
returns text language plpgsql as $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; tok text := 'b0000000-0000-4000-8000-0000000000bb';
  b_org uuid := 'b0000000-0000-4000-8000-000000000001'; btok text := 'b0000000-0000-4000-8000-0000000000bc';
  r text := ''; v_p0 int; v_m0 text; v_a0 int; i int;
begin
  begin
    update public.quotes set pricing = jsonb_build_object('total', 118000, 'subtotal', 118000), approval_status = 'sent',
           status = 'quote', consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null,
           client = coalesce(client, '{}'::jsonb) || '{"phone":"+919800000323","email":"client323@example.com","name":"Client"}'::jsonb
     where id = q;
    delete from public.payment_milestones where quote_id = q;
    for i in 1 .. p_ms loop
      insert into public.payment_milestones(quote_id, org_id, label, amount, status, seq, due_date)
        values (q, b_org, 'Part ' || i, 1000 * i, 'due', i, current_date + i);
    end loop;
    insert into public.client_booklets(org_id, quote_id, token) values (b_org, q, btok::uuid);
    -- event_sites_guard needs the studio in context (claims only, still superuser), then publish (as audit-p2-0156)
    perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
    insert into public.event_sites(org_id, quote_id, slug, status, data) values (b_org, q, 'r114-sim-site', 'draft', '{}');
    update public.event_sites set status = 'published', published_at = now() where slug = 'r114-sim-site';
    perform set_config('request.jwt.claims', '', false);
    -- the plan last (an ended trial is read-only: the set-up rows above go in first)
    insert into public.studio_subscriptions(org_id, status, trial_ends_at)
      values (b_org, p_status, case when p_ended then current_date - 2 else current_date + 10 end)
      on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
    if p_ended then update public.organizations set trial_ends_at = now() - interval '1 day' where id = b_org; end if;
    select count(*) into v_p0 from public.quote_payments where quote_id = q;
    select count(*) into v_a0 from public.audit_log where entity_id = q::text and action = 'payment.simulated';
    if p_kind like 'approve+%' then   -- the client approves in test mode first (0322), then the rest of the kind runs
      perform pg_temp.as_val('anon', format($s$select public.trial_test_approve_code(%L, '000000', null, 'Client', 'v2', 'I agree', 'UA')::text$s$, tok));
      p_kind := substr(p_kind, 9);
    end if;
    -- the schedule as it is now (approval may create the default schedule, 0264 / 0321) - the simulation must not change it
    select coalesce(string_agg(status, ',' order by seq), '-') into v_m0 from public.payment_milestones where quote_id = q;
    if p_kind = 'gate' then
      r := pg_temp.as_val('service', format($s$select public.trial_email_gate(null, %L, null, 'client323@example.com', 'approval_link')::text$s$, q));
    elsif p_kind = 'email_ok' then
      r := pg_temp.as_val('service', format($s$select public._tr212_email_ok(%L)::text$s$, b_org));
    elsif p_kind = 'messaging' then
      r := pg_temp.as_val('b_admin@b.test', $s$select (public.my_trial_messaging() ->> 'email')$s$);
    elsif p_kind = 'slot' then        -- what a definer function (e.g. 0212 _tr212_take) called by the app would do
      begin
        perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
        insert into public.trial_email_sends(org_id, kind, recipient_hash) values (b_org, 'booklet_link', repeat('a', 64));
        r := 'inserted';
      exception when others then r := 'err:' || sqlstate || ':' || sqlerrm;
      end;
      perform set_config('request.jwt.claims', '', true);
    elsif p_kind = 'slot_by_hand' then
      insert into public.trial_email_sends(org_id, kind, recipient_hash) values (b_org, 'booklet_link', repeat('a', 64)); r := 'inserted';
    elsif p_kind = 'booklet_send' then
      r := pg_temp.as_val('b_admin@b.test', format($s$select public.booklet_send(%L, 'email', 'client323@example.com', false, null)::text$s$, q));
      r := r || ' |OUTBOX=' || coalesce((select string_agg(o.status, ',') from public.comms_outbox o where o.quote_id = q and o.created_at >= now()), '-');
    elsif p_kind = 'paysim' then
      r := pg_temp.as_val(p_who, format($s$select public.public_trial_payment_sim(%L)::text$s$, tok));
    elsif p_kind like 'simulate%' then  -- simulate x N (simulate, simulate2, simulate3)
      for i in 1 .. coalesce(nullif(substr(p_kind, 9), '')::int, 1) loop
        r := pg_temp.as_val(p_who, format($s$select public.trial_simulate_payment(%L, 'Client', 'UA')::text$s$, tok));
      end loop;
    elsif p_kind = 'banner' then
      r := pg_temp.as_val('anon', format($s$select public.public_trial_simulation('quote', %L)::text || '/' || public.public_trial_simulation('booklet', %L)::text
                                              || '/' || public.public_trial_simulation('site', 'r114-sim-site')::text$s$, tok, btok));
    elsif p_kind = 'studio_list' then
      perform pg_temp.as_val('anon', format($s$select public.trial_simulate_payment(%L, 'Client', 'UA')::text$s$, tok));
      r := pg_temp.as_val(p_who, format($s$select jsonb_array_length(public.trial_sim_payments_for_quote(%L))::text$s$, q))
        || '/' || pg_temp.as_val(p_who, format($s$select count(*)::text from public.trial_sim_payments where quote_id = %L$s$, q));
    end if;
    raise exception using errcode = 'HR114', message = 'R=' || r
      || ' |SIM=' || (select count(*) from public.trial_sim_payments s where s.quote_id = q)::text
      || ' |SIMAMT=' || coalesce((select string_agg(s.amount::text || ':' || s.test_mode::text, ',' order by s.created_at, s.amount)
                                    from public.trial_sim_payments s where s.quote_id = q), '-')
      || ' |AUD=' || ((select count(*) from public.audit_log where entity_id = q::text and action = 'payment.simulated') - v_a0)::text
      || ' |PAY=' || ((select count(*) from public.quote_payments where quote_id = q) - v_p0)::text
      || ' |MS=' || case when (select coalesce(string_agg(status, ',' order by seq), '-') from public.payment_milestones where quote_id = q) = v_m0
                         then 'same' else 'CHANGED' end
      || ' |SLOTS=' || (select count(*) from public.trial_email_sends s where s.org_id = b_org and s.created_at >= now())::text
      || ' |STAT=' || (select approval_status from public.quotes where id = q);
  exception when sqlstate 'HR114' then
    return sqlerrm;
  end;
end $$;

do $$ declare r text;
begin
  -- (1) no real client e-mail from a trial
  r := pg_temp.run_case('email_ok', 'trial');
  perform pg_temp.t('01 trial: _tr212_email_ok = false (active trial)', r like 'R=false %', r);
  r := pg_temp.run_case('gate', 'trial');
  perform pg_temp.t('02 trial: trial_email_gate -> not allowed, trial, no slot taken',
    r like 'R={%"trial": true%' and r like '%"allowed": false%' and r like '%|SLOTS=0 %', r);
  r := pg_temp.run_case('messaging', 'trial');
  perform pg_temp.t('03 trial: my_trial_messaging email = false (the app shows previews)', r like 'R=false %', r);
  r := pg_temp.run_case('slot', 'trial');
  perform pg_temp.t('04 trial: the app cannot take a trial e-mail slot of any kind (42501 trial_no_send)',
    r like 'R=err:42501:%simulation%' and r like '%|SLOTS=0 %', r);
  r := pg_temp.run_case('booklet_send', 'trial');
  perform pg_temp.t('05 trial: booklet "Send to client" by e-mail -> skipped (nothing queued to go out), no slot',
    r like 'R={%"status": "skipped"%' and r not like '%OUTBOX=%pending%' and r like '%|SLOTS=0 %', r);
  -- (2) the simulated payment
  r := pg_temp.run_case('paysim', 'trial');
  perform pg_temp.t('06 trial, not approved: payment sim = simulation, not approved, cannot pay',
    r like 'R={%"simulation": true%' and r like '%"approved": false%' and r like '%"can_pay": false%' and r like '%|SIM=0 %', r);
  r := pg_temp.run_case('simulate', 'trial');
  perform pg_temp.t('07 trial, not approved: simulate -> not_approved, nothing recorded',
    r like 'R={%"error": "not_approved"%' and r like '%|SIM=0 |SIMAMT=- |AUD=0 |PAY=0 |MS=same %', r);
  r := pg_temp.run_case('approve+paysim', 'trial');
  perform pg_temp.t('08 trial, approved (000000): payment sim = can pay the first open milestone of the schedule, not paid yet',
    r like 'R={%"can_pay": true%' and r like '%"label": "Advance%' and r not like '%"amount": 0,%' and r like '%"paid": false%' and r like '%|STAT=approved', r);
  r := pg_temp.run_case('approve+simulate', 'trial');
  perform pg_temp.t('09 trial, approved: simulate -> TEST receipt, one test row (the advance), audit payment.simulated, ledger + milestones untouched',
    r like 'R={%"simulated": true%' and r like '%"receipt": "TEST-%' and r like '%"real_payment": false%' and r like '%"more_due": true%'
    and r like '%|SIM=1 |SIMAMT=%:true |AUD=1 |PAY=0 |MS=same %', r);
  r := pg_temp.run_case('approve+simulate9', 'trial');
  perform pg_temp.t('10 trial: simulating again walks the schedule once per milestone, then "already" (bounded); ledger + milestones untouched',
    r like 'R={%"already": true%' and r like '%|PAY=0 |MS=same %'
    and (regexp_match(r, '[|]SIM=([0-9]+) '))[1]::int between 2 and 8
    and (regexp_match(r, '[|]SIM=([0-9]+) '))[1] = (regexp_match(r, '[|]AUD=([0-9]+) '))[1], r);
  r := pg_temp.run_case('approve+simulate3', 'trial', false, 2);
  perform pg_temp.t('11 trial with 2 milestones: one test row per milestone in order (1000, 2000), then already; milestones + ledger untouched',
    r like 'R={%"already": true%' and r like '%|SIM=2 |SIMAMT=1000:true,2000:true |AUD=2 |PAY=0 |MS=same %', r);
  r := pg_temp.run_case('approve+paysim', 'trial', false, 2);
  perform pg_temp.t('12 trial with milestones: payment sim shows the first open milestone', r like '%"amount": 1000%' and r like '%"label": "Part 1"%', r);
  -- (3) ended trial / another studio / unknown links
  r := pg_temp.run_case('simulate', 'trial', true);
  perform pg_temp.t('13 ended trial: simulate -> trial_ended, nothing recorded', r like 'R={%"error": "trial_ended"%' and r like '%|SIM=0 %', r);
  r := pg_temp.run_case('approve+simulate', 'trial', false, 0, 'a_admin@a.test');
  perform pg_temp.t('14 trial: a viewer signed in to ANOTHER studio -> trial_test_unavailable, nothing recorded',
    r like 'R={%"error": "trial_test_unavailable"%' and r like '%|SIM=0 %', r);
  r := pg_temp.run_case('approve+simulate', 'trial', false, 0, 'b_staff@b.test');
  perform pg_temp.t('15 trial: the studio''s own member can walk the simulated payment', r like 'R={%"simulated": true%' and r like '%|SIM=1 %', r);
  r := pg_temp.as_val('anon', $s$select coalesce(public.public_trial_payment_sim('00000000-0000-4000-8000-0000000000ff')::text, 'null')$s$);
  perform pg_temp.t('16 unknown link: public_trial_payment_sim -> null', r = 'null', r);
  r := pg_temp.as_val('anon', $s$select public.trial_simulate_payment('00000000-0000-4000-8000-0000000000ff', 'x', 'x')::text$s$);
  perform pg_temp.t('17 unknown link: trial_simulate_payment -> invalid link', r like 'err:P0001:invalid link%', r);
  -- (4) banner
  r := pg_temp.run_case('banner', 'trial');
  perform pg_temp.t('18 trial: approval link / booklet / invitation site pages show the simulation banner',
    r like 'R={"simulation": true}/{"simulation": true}/{"simulation": true} %', r);
  r := pg_temp.run_case('banner', 'active');
  perform pg_temp.t('19 paid: no simulation banner', r like 'R={"simulation": false}/{"simulation": false}/{"simulation": false} %', r);
  r := pg_temp.as_val('anon', $s$select coalesce(public.public_trial_simulation('quote', 'nope')::text, 'null') || '/' || coalesce(public.public_trial_simulation('x', 'y')::text, 'null')
                                    || '/' || coalesce(public.public_trial_simulation('site', 'no-such-site-r114')::text, 'null')$s$);
  perform pg_temp.t('20 malformed / unknown links and kinds -> null', r = 'null/null/null', r);
  -- (5) paid studio unchanged
  r := pg_temp.run_case('gate', 'active');
  perform pg_temp.t('21 paid: trial_email_gate allowed (not a trial)', r like 'R={%"allowed": true%' and r like '%"trial": false%', r);
  r := pg_temp.run_case('messaging', 'active');
  perform pg_temp.t('22 paid: my_trial_messaging email = true', r like 'R=true %', r);
  r := pg_temp.run_case('booklet_send', 'active');
  perform pg_temp.t('23 paid: booklet "Send to client" by e-mail is queued as before', r like 'R={%"status": "queued"%' and r like '%OUTBOX=pending%', r);
  r := pg_temp.run_case('paysim', 'active');
  perform pg_temp.t('24 paid: payment sim = {simulation:false} only', r like 'R={"simulation": false} %', r);
  r := pg_temp.run_case('simulate', 'active');
  perform pg_temp.t('25 paid: simulate -> trial_only, nothing recorded', r like 'R={%"error": "trial_only"%' and r like '%|SIM=0 |SIMAMT=- |AUD=0 |PAY=0 %', r);
  -- studio view + RLS
  r := pg_temp.run_case('approve+studio_list', 'trial', false, 0, 'b_admin@b.test');
  perform pg_temp.t('26 own studio: trial_sim_payments_for_quote lists it, the table is readable (RLS own studio)', r like 'R=1/1 %', r);
  r := pg_temp.run_case('approve+studio_list', 'trial', false, 0, 'a_admin@a.test');
  perform pg_temp.t('27 another studio: sees nothing (RLS + own-studio RPC)', r like 'R=0/0 %', r);
  r := pg_temp.run_case('approve+studio_list', 'trial', false, 0, 'anon');
  perform pg_temp.t('28 anon: cannot list (42501) nor read the table', r like 'R=err:42501:%/err:42501:%', r);
  -- (6) structure
  r := pg_temp.run_case('slot_by_hand', 'trial');
  perform pg_temp.t('29 SQL by hand (no API role) is not refused by the app-call trigger', r like 'R=inserted%', r);
end $$;

do $$ begin
  perform pg_temp.t('30 grants: client RPCs for anon; studio RPC not for anon; helpers / kept 0212 body / trigger fn not for the app',
    has_function_privilege('anon', 'public.public_trial_payment_sim(uuid)', 'execute')
    and has_function_privilege('anon', 'public.trial_simulate_payment(uuid,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_trial_simulation(text,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_sim_payments_for_quote(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.trial_sim_payments_for_quote(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tr212_email_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tr212_email_ok__pre0323(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r323_next_due(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r323_token_quote(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r323_tg_trial_email_slot()', 'execute')
    and has_function_privilege('service_role', 'public._tr212_email_ok(uuid)', 'execute'), null);
  perform pg_temp.t('31 table: RLS on, test_mode check, anon has no privilege, authenticated read only',
    (select relrowsecurity from pg_class where oid = 'public.trial_sim_payments'::regclass)
    and exists (select 1 from pg_constraint where conname = 'trial_sim_payments_test_only')
    and not has_table_privilege('anon', 'public.trial_sim_payments', 'select')
    and has_table_privilege('authenticated', 'public.trial_sim_payments', 'select')
    and not has_table_privilege('authenticated', 'public.trial_sim_payments', 'insert')
    and not has_table_privilege('authenticated', 'public.trial_sim_payments', 'delete'), null);
  perform pg_temp.t('32 the 0212 body is kept (_tr212_email_ok__pre0323) and the wrapper is the 0323 one',
    to_regprocedure('public._tr212_email_ok__pre0323(uuid)') is not null
    and pg_get_functiondef('public._tr212_email_ok(uuid)'::regprocedure) like '%r114-trial-sim-0323%'
    and pg_get_functiondef('public._tr212_email_ok__pre0323(uuid)'::regprocedure) like '%trial_email_settings%', null);
  perform pg_temp.t('33 trigger ab2_r323_trial_email_slot BEFORE INSERT on trial_email_sends, enabled; 0322 otp trigger still on',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.trial_email_sends'::regclass and t.tgname = 'ab2_r323_trial_email_slot'
              and t.tgenabled = 'O' and t.tgtype = 7)
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.trial_email_sends'::regclass and t.tgname = 'ab2_r322_trial_otp_slot'), null);
  perform pg_temp.t('34 trial retention: trial_sim_payments purged before quote_payments (0184 list)',
    to_regprocedure('public._tr184_purge_tables()') is null
    or array_position(public._tr184_purge_tables(), 'trial_sim_payments') < array_position(public._tr184_purge_tables(), 'quote_payments'), null);
  perform pg_temp.t('35 trial_sim_payments has the 0045 read-only guard + the G4 quote / studio match (like every studio table)',
    exists (select 1 from pg_trigger where tgrelid = 'public.trial_sim_payments'::regclass and tgname = 'zzz_studio_read_only')
    and exists (select 1 from pg_trigger where tgrelid = 'public.trial_sim_payments'::regclass and tgname = 'zz_quote_org_match'), null);
end $$;

select name, result from _g323 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R114-TRIAL-SIM-0323: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R114-TRIAL-SIM-0323: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g323;
rollback;
