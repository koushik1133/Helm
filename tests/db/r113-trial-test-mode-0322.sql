-- r113-trial-test-mode-0322.sql - 0322 (R113 owner decision): the client approval in a FREE TRIAL studio is a TEST.
-- Proves:
--   (1) a trial studio (active or ended) never gets a real approval code: admin_store_otp (the send-otp store step),
--       trial_email_otp_begin (0212 code by e-mail), request_otp / wa_request_otp are refused, nothing is stored;
--   (2) the test approval accepts ONLY 000000 (trial_test_approve_code): a wrong code / the old confirm without a code /
--       an old real code row for a trial quote are refused and save nothing; 000000 approves, the consent is flagged
--       test_mode (verified_via_otp false, the quote's studio), audit 'approval.test_mode', event Confirmed;
--   (3) 0318 still refuses an unpriced quote in test mode (HL409, nothing saved); an ENDED trial gets 'trial_ended';
--       a viewer signed in to another studio gets 'trial_test_unavailable';
--   (4) public_trial_approval_mode answers {test_mode, can_approve, ended} (null for an unknown link);
--   (5) a PAID studio is unchanged: real code stored + approves (test_mode false), the test code is refused;
--   (6) structure: grants, the column, SQL by hand stays free. Re-applies 0322 twice. Every case is rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0322_r113_trial_approval_test_mode.sql
\ir ../../supabase/migrations/0322_r113_trial_approval_test_mode.sql
set client_min_messages = warning;
begin;
drop table if exists _g322; create temp table _g322(name text, result text); grant all on _g322 to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g322 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
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

-- one case: set the studio up (p_status 'trial' / 'active'; p_ended = trial over), run p_kind, report, roll back
create or replace function pg_temp.run_case(p_kind text, p_status text, p_total numeric, p_ended boolean default false, p_who text default 'anon')
returns text language plpgsql as $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; tok text := 'b0000000-0000-4000-8000-0000000000bb';
  b_org uuid := 'b0000000-0000-4000-8000-000000000001'; r text := ''; v_key text; v_c0 int; v_o0 int; v_a0 int;
begin
  begin
    insert into public.studio_subscriptions(org_id, status, trial_ends_at)
      values (b_org, p_status, case when p_ended then current_date - 2 else current_date + 10 end)
      on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
    if p_ended then update public.organizations set trial_ends_at = now() - interval '1 day' where id = b_org; end if;
    update public.quotes set pricing = jsonb_build_object('total', p_total, 'subtotal', p_total), approval_status = 'sent',
           status = 'quote', consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null,
           client = coalesce(client, '{}'::jsonb) || '{"phone":"+919800000322","email":"client322@example.com"}'::jsonb
     where id = q;
    delete from public.a156_quote_served where quote_id = q;
    delete from public.quote_otps where quote_id = q;
    select count(*) into v_c0 from public.quote_consents where quote_id = q;
    select count(*) into v_a0 from public.audit_log where entity_id = q::text and action = 'approval.test_mode';
    if p_kind = 'store' then        -- send-otp's store step (service role) for the quote's phone
      v_key := pg_temp.as_val('service', format($s$select public._otp_canon_phone(%L, '+919800000322')$s$, tok));
      r := pg_temp.as_val('service', format($s$select public.admin_store_otp(%L, %L, '424242')::text$s$, tok, v_key));
    elsif p_kind = 'trial_email' then
      r := pg_temp.as_val('service', format($s$select public.trial_email_otp_begin(%L, 'UA')::text$s$, tok));
    elsif p_kind = 'request_otp' then
      r := pg_temp.as_val('anon', format($s$select public.request_otp(%L, '+919800000322')::text$s$, tok));
    elsif p_kind = 'wa_request' then
      r := pg_temp.as_val('anon', format($s$select public.wa_request_otp(%L, 'email', 'UA')::text$s$, tok));
    elsif p_kind = 'mode' then
      r := pg_temp.as_val(p_who, format($s$select public.public_trial_approval_mode(%L)::text$s$, tok));
    elsif p_kind like 'code:%' then  -- the client page's "Simulate approval"
      r := pg_temp.as_val(p_who, format($s$select public.trial_test_approve_code(%L, %L, null, 'Client', 'v2', 'I agree', 'UA')::text$s$,
                                         tok, substr(p_kind, 6)));
    elsif p_kind = 'old_confirm' then
      r := pg_temp.as_val(p_who, format($s$select public.trial_test_approve(%L, null, 'Client', 'v2', 'I agree', 'UA')::text$s$, tok));
    elsif p_kind = 'legacy_code' then -- a real code row stored before R113 (by hand), then the client verifies it by e-mail
      insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
        values (q, public._otp_canon_phone(tok::uuid, '+919800000322'), extensions.crypt('424242', extensions.gen_salt('bf', 4)), now() + interval '10 minutes');
      r := pg_temp.as_val('anon', format($s$select public.wa_verify_and_consent(%L, 'email', '424242', true, 'v2', 'I agree', 'Client', 'UA')::text$s$, tok));
    elsif p_kind = 'paid_real' then  -- the paid path: wa_otp_begin + admin_store_otp (service) -> the client verifies
      v_key := pg_temp.as_val('service', format($s$select public.wa_otp_begin(%L, 'email', 'UA') ->> 'phone_key'$s$, tok));
      r := pg_temp.as_val('service', format($s$select public.admin_store_otp(%L, %L, '424242')::text$s$, tok, v_key));
      r := 'STORE=' || r || ' R=' || pg_temp.as_val('anon', format($s$select public.wa_verify_and_consent(%L, 'email', '424242', true, 'v2', 'I agree', 'Client', 'UA')::text$s$, tok));
    elsif p_kind = 'paid_testcode' then
      v_key := pg_temp.as_val('service', format($s$select public.wa_otp_begin(%L, 'email', 'UA') ->> 'phone_key'$s$, tok));
      perform pg_temp.as_val('service', format($s$select public.admin_store_otp(%L, %L, '424242')::text$s$, tok, v_key));
      r := pg_temp.as_val('anon', format($s$select public.wa_verify_and_consent(%L, 'email', '000000', true, 'v2', 'I agree', 'Client', 'UA')::text$s$, tok));
    elsif p_kind = 'by_hand' then    -- SQL by hand (no API role) is not refused by the app-call triggers
      insert into public.quote_otps(quote_id, phone, code_hash, expires_at) values (q, '9800000322', 'x', now() + interval '1 minute');
      r := 'inserted';
    end if;
    raise exception using errcode = 'HR113', message = 'R=' || r
      || ' |NEW=' || ((select count(*) from public.quote_consents where quote_id = q) - v_c0)::text
      || ' |TEST=' || coalesce((select string_agg(c.test_mode::text || '/' || c.verified_via_otp::text || '/' || (c.org_id = b_org)::text, ',')
                                  from public.quote_consents c where c.quote_id = q and c.created_at >= now()), '-')
      || ' |AUD=' || ((select count(*) from public.audit_log where entity_id = q::text and action = 'approval.test_mode') - v_a0)::text
      || ' |STAT=' || (select approval_status || '/' || coalesce(status, '-') from public.quotes where id = q)
      || ' |OTPS=' || (select count(*) from public.quote_otps o where o.quote_id = q)::text
      || ' |SLOTS=' || (select count(*) from public.trial_email_sends s where s.org_id = b_org and s.kind = 'otp' and s.created_at >= now())::text;
  exception when sqlstate 'HR113' then
    return sqlerrm;
  end;
end $$;

do $$ declare r text;
begin
  -- (1) a trial (active) gets no real code on any path
  r := pg_temp.run_case('store', 'trial', 118000);
  perform pg_temp.t('01 trial: admin_store_otp (send-otp store step) refused 42501 trial_no_send, no code row', r like 'R=err:42501:%no approval code is sent%' and r like '%|OTPS=0 %', r);
  r := pg_temp.run_case('trial_email', 'trial', 118000);
  perform pg_temp.t('02 trial: trial_email_otp_begin (0212 code by e-mail) refused 42501, no otp slot', r like 'R=err:42501:%' and r like '%|SLOTS=0', r);
  r := pg_temp.run_case('request_otp', 'trial', 118000);
  perform pg_temp.t('03 trial: request_otp (SMS) refused, no code row', r like 'R=err:42501:%' and r like '%|OTPS=0 %', r);
  r := pg_temp.run_case('wa_request', 'trial', 118000);
  perform pg_temp.t('04 trial: wa_request_otp (e-mail) refused, no code row', r like 'R=err:42501:%' and r like '%|OTPS=0 %', r);
  -- (4) the page's test-mode answer
  r := pg_temp.run_case('mode', 'trial', 118000);
  perform pg_temp.t('05 trial: public_trial_approval_mode = test_mode, can approve, not ended',
    r like 'R={"ended": false, "test_mode": true, "can_approve": true} %', r);
  -- (2) only the test code approves
  r := pg_temp.run_case('code:123456', 'trial', 118000);
  perform pg_temp.t('06 trial: a wrong code -> test_code, nothing saved',
    r like 'R={%"error": "test_code"%' and r like '%"approved": false%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote |OTPS=0 %', r);
  r := pg_temp.run_case('old_confirm', 'trial', 118000);
  perform pg_temp.t('07 trial: the old confirm without a code (trial_test_approve) refused, nothing saved',
    r like 'R=err:42501:%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote |OTPS=0 %', r);
  r := pg_temp.run_case('legacy_code', 'trial', 118000);
  perform pg_temp.t('08 trial: an old REAL code row is not accepted (42501 trial_test_only), no consent',
    r like 'R=err:42501:%test code 000000%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('code:000000', 'trial', 118000);
  perform pg_temp.t('09 trial: 000000 approves; consent test_mode / not via OTP / quote studio; audit approval.test_mode; Confirmed',
    r like 'R={%"approved": true%' and r like '%"test_mode": true%'
    and r like '%|NEW=1 |TEST=true/false/true |AUD=1 |STAT=approved/confirmed %', r);
  r := pg_temp.run_case('code: 000 000 ', 'trial', 118000);
  perform pg_temp.t('10 trial: the test code with spaces is still the test code', r like 'R={%"approved": true%' and r like '%|NEW=1 %', r);
  r := pg_temp.run_case('code:000000', 'trial', 118000, false, 'a_admin@a.test');
  perform pg_temp.t('11 trial: a viewer signed in to ANOTHER studio -> trial_test_unavailable, nothing saved',
    r like 'R={%"error": "trial_test_unavailable"%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('code:000000', 'trial', 118000, false, 'b_staff@b.test');
  perform pg_temp.t('12 trial: the studio''s own member can try the test approval', r like 'R={%"approved": true%' and r like '%|NEW=1 |TEST=true/false/true |AUD=1 %', r);
  -- (3) 0318 + ended trial
  r := pg_temp.run_case('code:000000', 'trial', 0);
  perform pg_temp.t('13 trial: unpriced quote + 000000 -> 0318 HL409 no price, nothing saved',
    r like 'R=err:HL409:%no price%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('mode', 'trial', 118000, true);
  perform pg_temp.t('14 ended trial: still test mode (no code), cannot approve, ended',
    r like 'R={"ended": true, "test_mode": true, "can_approve": false} %', r);
  r := pg_temp.run_case('code:000000', 'trial', 118000, true);
  perform pg_temp.t('15 ended trial: 000000 -> trial_ended, nothing saved',
    r like 'R={%"error": "trial_ended"%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('store', 'trial', 118000, true);
  perform pg_temp.t('16 ended trial: no real code stored either', r like 'R=err:42501:%' and r like '%|OTPS=0 %', r);
  -- (5) paid studio unchanged
  r := pg_temp.run_case('mode', 'active', 118000);
  perform pg_temp.t('17 paid: public_trial_approval_mode = not test mode', r like 'R={"ended": false, "test_mode": false, "can_approve": false} %', r);
  r := pg_temp.run_case('code:000000', 'active', 118000);
  perform pg_temp.t('18 paid: the test code page path is refused (trial_test_unavailable), nothing saved',
    r like 'R={%"error": "trial_test_unavailable"%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('paid_real', 'active', 118000);
  perform pg_temp.t('19 paid: real code stored and approves; consent NOT test mode, via OTP',
    r like 'R=STORE={"stored": true}%' and r like '% R={"approved": true}%' and r like '%|NEW=1 |TEST=false/true/true |AUD=0 |STAT=approved/%', r);
  r := pg_temp.run_case('paid_testcode', 'active', 118000);
  perform pg_temp.t('20 paid: 000000 is just a wrong code (approved false), nothing saved',
    r like 'R={%"approved": false%' and r like '%|NEW=0 |TEST=- |AUD=0 |STAT=sent/quote %', r);
  r := pg_temp.run_case('store', 'active', 118000);
  perform pg_temp.t('21 paid: admin_store_otp still stores', r like 'R={"stored": true}%' and r like '%|OTPS=1 %', r);
  -- (6) structure
  r := pg_temp.run_case('by_hand', 'trial', 118000);
  perform pg_temp.t('22 SQL by hand (no API role) is not refused by the app-call triggers', r like 'R=inserted%' and r like '%|OTPS=1 %', r);
  r := pg_temp.as_val('anon', $s$select coalesce(public.public_trial_approval_mode('00000000-0000-4000-8000-0000000000ff')::text, 'null')$s$);
  perform pg_temp.t('23 unknown link: public_trial_approval_mode -> null', r = 'null', r);
  r := pg_temp.as_val('anon', $s$select public.trial_test_approve_code('00000000-0000-4000-8000-0000000000ff', '000000', null, 'x', 'v2', 'x', 'x')::text$s$);
  perform pg_temp.t('24 unknown link: trial_test_approve_code -> invalid link', r like 'err:P0001:invalid link%', r);
end $$;

do $$ begin
  perform pg_temp.t('25 grants: the two RPCs for anon / authenticated / service_role; helpers + trigger functions not for the app',
    has_function_privilege('anon', 'public.trial_test_approve_code(uuid,text,text,text,text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.trial_test_approve_code(uuid,text,text,text,text,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_trial_approval_mode(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r322_trial_quote(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r322_in_test(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r322_tg_trial_otp()', 'execute')
    and not has_function_privilege('authenticated', 'public._r322_tg_trial_consent()', 'execute')
    and not has_function_privilege('anon', 'public._r322_tg_trial_otp_slot()', 'execute'), null);
  perform pg_temp.t('26 quote_consents.test_mode: boolean not null default false; triggers before insert, enabled',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_consents'
              and column_name = 'test_mode' and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false')
    and (select count(*) from pg_trigger t where t.tgname in ('ab2_r322_trial_otp', 'ab2_r322_trial_otp_slot', 'ab2_r322_trial_consent')
           and t.tgenabled = 'O' and t.tgtype = 7) = 3, null);
  perform pg_temp.t('27 0319 org stamp still the first trigger after aa_api_write_block; 0318 no-price trigger still on',
    (select array_agg(tgname order by tgname) from pg_trigger where tgrelid = 'public.quote_consents'::regclass and not tgisinternal
       and tgtype & 2 = 2)[1:2] = array['aa_api_write_block', 'ab0_r109_consent_org']::name[]
    and exists (select 1 from pg_trigger where tgrelid = 'public.quote_consents'::regclass and tgname = 'zz_r318_consent_priced'), null);
  perform pg_temp.t('28 no test mark left behind', coalesce(current_setting('helm.r322_test', true), '') = '', current_setting('helm.r322_test', true));
end $$;

select name, result from _g322 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R113-TRIAL-TEST-MODE-0322: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R113-TRIAL-TEST-MODE-0322: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g322;
rollback;
