-- phone-verify.sql — 0055: WhatsApp phone verification codes + international mobiles.
-- Fixture: a_staff (studio A), b_staff (studio B). One transaction, rolled back at the end.
-- Phone numbers are fake test values.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _pv(name text, result text); grant all on _pv to anon, authenticated, service_role;
create temp table _code(k text primary key, v text); grant all on _code to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _pv values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR:'||sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
-- issue a code as the edge function would (service role); returns code or 'ERR:<sqlstate>'
create or replace function pg_temp.issue(p_email text, p_phone text) returns text language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.su(); execute 'set role service_role';
  j := public.phone_verify_request(pg_temp.uid(p_email), p_phone);
  execute 'reset role'; return j ->> 'code';
exception when others then execute 'reset role'; return 'ERR:' || sqlstate;
end $$;
create or replace function pg_temp.vat(p_email text) returns timestamptz language sql security definer as $$ select phone_verified_at from public.member_profiles where user_id = pg_temp.uid(p_email) $$;
create or replace function pg_temp.mph(p_email text) returns text language sql security definer as $$ select phone from public.member_profiles where user_id = pg_temp.uid(p_email) $$;
grant execute on function pg_temp.vat(text) to anon, authenticated, service_role;
grant execute on function pg_temp.mph(text) to anon, authenticated, service_role;
create or replace function pg_temp.age(p_email text, p_secs int) returns void language sql security definer as $$
  update public.phone_verifications set created_at = created_at - make_interval(secs => p_secs) where user_id = pg_temp.uid(p_email) $$;

do $$ begin perform pg_temp.su();
  delete from public.phone_verifications;   -- disposable test DB, rolled back
  insert into public.member_profiles (user_id) select id from public.profiles where email in ('a_staff@a.test','b_staff@b.test')
    on conflict (user_id) do nothing;
end $$;

-- ---- privileges ---------------------------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.res('01 authenticated cannot read codes table', not has_table_privilege('authenticated', 'public.phone_verifications', 'select'));
  perform pg_temp.res('02 anon cannot read codes table', not has_table_privilege('anon', 'public.phone_verifications', 'select'));
  perform pg_temp.res('03 request not callable by authenticated', not has_function_privilege('authenticated', 'public.phone_verify_request(uuid,text)', 'execute'));
  perform pg_temp.res('04 request not callable by anon', not has_function_privilege('anon', 'public.phone_verify_request(uuid,text)', 'execute'));
  perform pg_temp.res('05 check not callable by anon', not has_function_privilege('anon', 'public.phone_verify_check(text)', 'execute'));
  perform pg_temp.res('06 RLS on', (select relrowsecurity from pg_class where oid = 'public.phone_verifications'::regclass));
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.phone_verify_request(auth.uid(), '+919876543210')$q$);
  perform pg_temp.res('07 signed-in member cannot mint a code', s = '42501', s);
end $$;

-- ---- issue + store hashed --------------------------------------------------------------------
do $$ declare c text; begin
  c := pg_temp.issue('a_staff@a.test', '98765 43210');
  insert into _code values ('a1', c);
  perform pg_temp.res('08 code is 6 digits', c ~ '^[0-9]{6}$', c);
  perform pg_temp.res('09 only a hash is stored', (select code_hash <> c and code_hash like '$2%' from public.phone_verifications where user_id = pg_temp.uid('a_staff@a.test')), '');
  perform pg_temp.res('10 phone normalised to E.164', (select phone from public.phone_verifications where user_id = pg_temp.uid('a_staff@a.test')) = '+919876543210', '');
  perform pg_temp.res('11 expires in 10 minutes', (select expires_at between now() + interval '9 minutes' and now() + interval '11 minutes' from public.phone_verifications where user_id = pg_temp.uid('a_staff@a.test')), '');
  perform pg_temp.res('12 resend inside 60 s refused (HL429)', pg_temp.issue('a_staff@a.test', '98765 43210') = 'ERR:HL429');
  perform pg_temp.res('13 invalid number refused (22023)', pg_temp.issue('b_staff@b.test', '12345') = 'ERR:22023');
  perform pg_temp.res('14 Indian rule enforced (22023)', pg_temp.issue('b_staff@b.test', '+91 12345 67890') = 'ERR:22023');
end $$;

-- ---- wrong codes counted, 5 attempts --------------------------------------------------------------
do $$ declare j jsonb; c text := (select v from _code where k = 'a1'); w text; i int; begin
  w := case when c = '000000' then '111111' else '000000' end;
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_check(w);
  perform pg_temp.res('15 wrong code → ok:false, 4 remaining', j ->> 'ok' = 'false' and (j ->> 'remaining')::int = 4, j::text);
  perform pg_temp.res('16 wrong attempt is persisted', (select attempts from public.phone_verifications where user_id = pg_temp.uid('a_staff@a.test')) = 1, '');
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_check('abc');
  perform pg_temp.res('17 non-numeric code counted as wrong', j ->> 'reason' = 'wrong', j::text);
  perform pg_temp.login('a_staff@a.test');
  for i in 1..3 loop j := public.phone_verify_check(w); end loop;
  perform pg_temp.res('18 fifth wrong try locks', j ->> 'reason' = 'locked', j::text);
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('19 right code after lock still refused', j ->> 'ok' = 'false' and j ->> 'reason' = 'locked', j::text);
  perform pg_temp.res('20 profile not verified', pg_temp.vat('a_staff@a.test') is null, '');
end $$;

-- ---- new code supersedes old; right code verifies; applies to profile when phone matches ---------------
do $$ declare j jsonb; c text; s text; begin
  perform pg_temp.age('a_staff@a.test', 61);
  c := pg_temp.issue('a_staff@a.test', '+91 98765 43210');
  perform pg_temp.res('21 resend after 60 s allowed', c ~ '^[0-9]{6}$', c);
  perform pg_temp.res('22 older open codes expired', (select count(*) from public.phone_verifications where user_id = pg_temp.uid('a_staff@a.test') and expires_at > now()) = 1, '');
  -- save the mobile first via the RPC (pre-verification): not verified yet
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"+919876543210"}')$q$);
  perform pg_temp.res('23 save mobile ok', s = '', s);
  perform pg_temp.res('24 unverified after save', pg_temp.vat('a_staff@a.test') is null, '');
  perform pg_temp.login('b_staff@b.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('25 another user cannot use a''s code', j ->> 'ok' = 'false', j::text);
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('26 right code verifies + applies', j ->> 'ok' = 'true' and j ->> 'applied' = 'true' and j ->> 'phone' = '+919876543210', j::text);
  perform pg_temp.res('27 profile phone_verified_at set', pg_temp.vat('a_staff@a.test') is not null, '');
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('28 code cannot be reused', j ->> 'ok' = 'false', j::text);
  perform pg_temp.login('a_staff@a.test');
  j := public.phone_verify_status();
  perform pg_temp.res('29 status shows verified', j ->> 'verified_at' is not null and j ->> 'phone' = '+919876543210', j::text);
  -- changing the mobile clears it
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"+44 7700 900123"}')$q$);
  perform pg_temp.res('30 international mobile saves', s = '' and pg_temp.mph('a_staff@a.test') = '+447700900123', s);
  perform pg_temp.res('31 mobile change clears verified', pg_temp.vat('a_staff@a.test') is null, '');
  -- changing back to the number verified <30 min ago re-applies it
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.update_my_profile('{"phone":"98765 43210"}')$q$);
  perform pg_temp.res('32 recently verified number re-applies on save', pg_temp.vat('a_staff@a.test') is not null, s);
end $$;

-- ---- verify-before-save, expiry, rate limits --------------------------------------------------------
do $$ declare j jsonb; c text; i int; n int; begin
  c := pg_temp.issue('b_staff@b.test', '+971 50 123 4567');
  perform pg_temp.login('b_staff@b.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('33 verify before save: ok, not applied', j ->> 'ok' = 'true' and j ->> 'applied' = 'false', j::text);
  perform pg_temp.login('b_staff@b.test');
  perform pg_temp.try($q$select public.update_my_profile('{"phone":"+971501234567"}')$q$);
  perform pg_temp.res('34 saving the verified number marks it verified', pg_temp.vat('b_staff@b.test') is not null, '');
  -- expiry
  perform pg_temp.age('b_staff@b.test', 61);
  c := pg_temp.issue('b_staff@b.test', '+971501234567');
  perform pg_temp.su(); update public.phone_verifications set expires_at = now() - interval '1 second' where user_id = pg_temp.uid('b_staff@b.test') and verified_at is null;
  perform pg_temp.login('b_staff@b.test');
  j := public.phone_verify_check(c);
  perform pg_temp.res('35 expired code refused', j ->> 'ok' = 'false' and j ->> 'reason' = 'expired', j::text);
  -- hourly cap: 5 per user per hour (b has 2 so far)
  for i in 1..3 loop perform pg_temp.age('b_staff@b.test', 61); c := pg_temp.issue('b_staff@b.test', '+971501234567'); end loop;
  perform pg_temp.age('b_staff@b.test', 61);
  perform pg_temp.res('36 sixth code in an hour refused', pg_temp.issue('b_staff@b.test', '+971501234567') = 'ERR:HL429');
  perform pg_temp.res('37 unknown user refused', pg_temp.val($q$select public.phone_verify_request('00000000-0000-0000-0000-000000000000'::uuid, '+971501234567')$q$) like 'ERR:%');
  -- per-number daily cap (10): age everything past the hour window, keep within the day
  perform pg_temp.su(); update public.phone_verifications set created_at = now() - interval '2 hours';
  insert into public.phone_verifications (user_id, phone, code_hash, expires_at, created_at)
    select pg_temp.uid('a_staff@a.test'), '+971501234567', 'x', now(), now() - interval '3 hours' from generate_series(1, 5);
  select count(*) into n from public.phone_verifications where phone = '+971501234567';
  perform pg_temp.res('38 per-number daily cap', n >= 10 and pg_temp.issue('a_staff@a.test', '+971501234567') = 'ERR:HL429', 'n=' || n);
  perform pg_temp.su();
  perform pg_temp.res('39 Indian mobile rule unchanged', public._mp_mobile('098765 43210', 'Mobile number') = '+919876543210'
    and pg_temp.val($q$select public._mp_mobile('+91 5876543210', 'Mobile number')$q$) = 'ERR:22023', '');
  perform pg_temp.res('40 international too short refused', pg_temp.val($q$select public._mp_mobile('+44 123', 'Mobile number')$q$) = 'ERR:22023', '');
end $$;

select name, result from _pv order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 40 then 'PHONE-VERIFY: ALL PASS (40/40)'
            else 'PHONE-VERIFY: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/40 ran' end from _pv;
rollback;
