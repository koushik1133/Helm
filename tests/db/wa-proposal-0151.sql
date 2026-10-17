-- wa-proposal-0151.sql -- 0151: proposal on WhatsApp + WhatsApp / e-mail OTP + audit trail.
-- saved it (#16). Fixture: a_admin/a_staff studio A, b_admin studio B, quoteA. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _wf(name text, result text); grant all on _wf to anon, authenticated, service_role;
create temp table _wkv(k text primary key, v text); grant all on _wkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _wf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _wkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _wkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

do $$ declare e text; r jsonb; v_code text; n int;
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; tA uuid := 'a0000000-0000-4000-8000-0000000000aa';
begin
  perform pg_temp.su();
  update public.quotes set client = '{"name":"Alice","phone":"98765 43210","email":"alice@example.com"}'::jsonb,
         event_date = current_date + 30, event_type = 'wedding' where id = qA;
  insert into public.app_config(key, value, org_id) values
    ('channels', '{"otp_dev_echo":true,"sms_live":false}', 'a0000000-0000-4000-8000-000000000001')
  on conflict (org_id, key) do update set value = excluded.value;

  -- studio side
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.wa_proposal_prepare('a0000000-0000-4000-8000-00000000da01', 'proposal_sent', '+919876543210', false, null, true)$q$);
  perform pg_temp.res('01 no opt-in -> refused', e like 'P0001%opt%' or e like 'P0001%agreed%', e);
  e := pg_temp.try($q$select public.wa_proposal_prepare('a0000000-0000-4000-8000-00000000da01', 'proposal_sent', '+919999999999', true, 'Client agreed', true)$q$);
  perform pg_temp.res('02 a number not on the quote -> refused', e like '22023%', e);
  r := public.wa_proposal_prepare(qA, 'proposal_sent', '9876543210', true, 'Client agreed to receive WhatsApp updates', true);
  perform pg_temp.res('03 simulated send ok + E.164', r ->> 'status' = 'simulated' and r ->> 'to_e164' = '+919876543210', r::text);
  perform pg_temp.res('04 template vars', r -> 'vars' ->> 'client_name' = 'Alice' and r -> 'vars' ->> 'studio_name' = 'Studio A'
       and r -> 'vars' ->> 'total' = 'INR 236,000' and r ->> 'token' = tA::text, r::text);
  perform pg_temp.put('aid', r ->> 'audit_id');
  r := public.wa_proposal_state(qA);
  perform pg_temp.res('05 state shows simulated + opt-in', r ->> 'status' = 'simulated' and (r ->> 'opted_in')::boolean, r::text);
  perform pg_temp.res('06 studio reads own audit + opt-in rows', (select count(*) from public.wa_proposal_audit) = 1
       and (select count(*) from public.wa_proposal_optins where recorded_by = auth.uid()) = 1);
  e := pg_temp.try($q$update public.wa_proposal_audit set status = 'x'$q$);
  perform pg_temp.res('07 studio cannot update audit', e <> '', e);
  e := pg_temp.try($q$select public.wa_proposal_mark(1, 'sent', 'wamid.X')$q$);
  perform pg_temp.res('08 mark is service-role only', e like '42501%', e);

  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('09 other studio sees no rows', (select count(*) from public.wa_proposal_audit) = 0 and (select count(*) from public.wa_proposal_optins) = 0);
  e := pg_temp.try($q$select public.wa_proposal_prepare('a0000000-0000-4000-8000-00000000da01', 'proposal_sent', '+919876543210', true, 'x', true)$q$);
  perform pg_temp.res('10 other studio cannot prepare', e like '42501%', e);

  -- live send result + webhook delivered/read
  perform pg_temp.su();
  perform public.wa_proposal_mark(pg_temp.get('aid')::bigint, 'sent', 'wamid.TEST151');
  perform public.wa_record_event('status:wamid.TEST151:delivered', null, 'message_status', 'wamid.TEST151', 'delivered', '919876543210', '{}'::jsonb);
  perform public.wa_record_event('status:wamid.TEST151:read', null, 'message_status', 'wamid.TEST151', 'read', '919876543210', '{}'::jsonb);
  perform pg_temp.res('11 webhook adds delivered + read rows', (select count(*) from public.wa_proposal_audit where step = 'wa_status' and wamid = 'wamid.TEST151') = 2);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('12 state = read', public.wa_proposal_state(qA) ->> 'status' = 'read', public.wa_proposal_state(qA)::text);
  perform pg_temp.su();
  e := pg_temp.try($q$delete from public.wa_proposal_audit$q$);
  perform pg_temp.res('13 even the owner cannot delete audit rows', e like '42501%', e);

  -- client side (anon)
  perform pg_temp.anon();
  r := public.wa_request_otp(tA, 'whatsapp', 'UA-test');
  perform pg_temp.res('14 OTP to the number on the quote (masked)', r ->> 'masked' like '+%3210' and r ->> 'dev_code' ~ '^[0-9]{6}$', r::text);
  perform pg_temp.put('code', r ->> 'dev_code');
  e := pg_temp.try($q$select public.wa_request_otp('a0000000-0000-4000-8000-0000000000aa', 'whatsapp', null)$q$);
  perform pg_temp.res('15 resend cooldown', e like 'HL429%', e);
  perform pg_temp.res('16 anon cannot read audit', pg_temp.try('select count(*) from public.wa_proposal_audit') like '42501%');
  e := pg_temp.try($q$select public.wa_otp_begin('a0000000-0000-4000-8000-0000000000aa', 'email', null)$q$);
  perform pg_temp.res('17 otp_begin not callable by anon', e like '42501%', e);
  r := public.wa_verify_and_consent(tA, 'whatsapp', '000000', true, 'v1', 'I agree', 'Alice', 'UA-test');
  perform pg_temp.res('18 wrong code counted', (r ->> 'approved')::boolean is false, r::text);
  r := public.wa_verify_and_consent(tA, 'whatsapp', pg_temp.get('code'), true, 'v1', 'I agree', 'Alice', 'UA-test');
  perform pg_temp.res('19 right code approves', (r ->> 'approved')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('20 audit has otp_sent / otp_verify x2 / approved with sha + UA',
    (select count(*) from public.wa_proposal_audit where quote_id = qA and step = 'otp_sent') = 1
    and (select count(*) from public.wa_proposal_audit where quote_id = qA and step = 'otp_verify') = 2
    and exists (select 1 from public.wa_proposal_audit where quote_id = qA and step = 'approved' and snapshot_sha256 ~ '^[0-9a-f]{64}$' and user_agent = 'UA-test'));
  perform pg_temp.res('21 only a hash is stored', not exists (select 1 from public.quote_otps where code_hash = pg_temp.get('code')));
  -- e-mail fallback path via begin (service role)
  r := public.wa_otp_begin(tA, 'email', null);
  perform pg_temp.res('22 e-mail goes to the address on the quote (masked)', r ->> 'email' = 'alice@example.com' and r ->> 'masked' = 'a***@example.com', r::text);
  -- resend cap: 4 per channel per 30 min
  insert into public.wa_proposal_audit(org_id, quote_id, step, channel, status, created_at)
    select 'a0000000-0000-4000-8000-000000000001', qA, 'otp_sent', 'email', 'requested', now() - interval '5 minutes' from generate_series(1, 3);
  e := pg_temp.try($q$select public.wa_otp_begin('a0000000-0000-4000-8000-0000000000aa', 'email', null)$q$);
  perform pg_temp.res('23 at most 3 resends', e like 'HL429%', e);
  perform pg_temp.res('24 anon grants', has_function_privilege('anon', 'public.wa_request_otp(uuid, text, text)', 'execute')
    and has_function_privilege('anon', 'public.wa_verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_proposal_mark(bigint, text, text)', 'execute'));
exception when others then perform pg_temp.su(); insert into _wf values ('2x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _wf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'WA-PROPOSAL-0151: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'WA-PROPOSAL-0151: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _wf;
rollback;
