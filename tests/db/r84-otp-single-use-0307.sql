-- r84-otp-single-use-0307.sql - 0307: one approval per quote; an older unused approval code cannot approve again.
-- Proves: (1) after a newer code B approves, the older code A no longer creates a second consent (already_approved);
-- (2) a successful verify expires every other open code for the quote; (3) a wrong code on an approved quote never
-- adds a consent; (4) when re-approval is pending (status back to sent) a fresh code still approves normally;
-- (5) grants: anon can call the live function, not the kept __pre0307 copy. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0307_r84_otp_single_use.sql
\ir ../../supabase/migrations/0307_r84_otp_single_use.sql
set client_min_messages = warning;
begin;
drop table if exists _g307; create temp table _g307(name text, result text); grant all on _g307 to anon, authenticated;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g307 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.seed(p_q uuid, p_code text, p_age interval) returns uuid language sql as $$
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id, created_at)
  select q.id, public._otp_canon_phone(q.approval_token, q.client ->> 'phone'), extensions.crypt(p_code, extensions.gen_salt('bf', 4)),
         now() + interval '10 minutes', q.org_id, now() - p_age
    from public.quotes q where q.id = p_q returning id $$;

do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; tok text := 'a0000000-0000-4000-8000-0000000000aa';
  a uuid; b uuid; c uuid; n0 int; vsql text;
begin
  delete from public.a156_quote_served where quote_id = q;
  update public.quotes set approval_status = 'sent', consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null, client = client || '{"phone":"+919800000156"}'::jsonb where id = q;
  delete from public.quote_otps where quote_id = q;
  select count(*) into n0 from public.quote_consents where quote_id = q;
  vsql := $q$select public.verify_and_consent(%L, '+919800000156', %L, true, 'v1', 'I agree', 'R84', 'ua')::text$q$;
  a := pg_temp.seed(q, '111111', interval '1 minute');
  b := pg_temp.seed(q, '222222', interval '0');
  r := pg_temp.as_val('anon', format(vsql, tok, '222222'));
  perform pg_temp.t('01 newer code B approves', r like '%"approved": true%' and r not like '%already_approved%', r);
  perform pg_temp.t('02 the older open code A is expired by the successful verify',
    (select expires_at <= now() and verified_at is null from public.quote_otps where id = a), null);
  r := pg_temp.as_val('anon', format(vsql, tok, '111111'));
  perform pg_temp.t('03 old code A returns already_approved (app shows the approved step)',
    r like '%"approved": true%' and r like '%"already_approved": true%', r);
  perform pg_temp.t('04 exactly ONE consent for the quote', (select count(*) from public.quote_consents where quote_id = q) = n0 + 1, null);
  r := pg_temp.as_val('anon', format(vsql, tok, '999999'));
  perform pg_temp.t('05 a wrong code on an approved quote adds no consent',
    (select count(*) from public.quote_consents where quote_id = q) = n0 + 1, r);
  perform pg_temp.t('06 quote stays approved', (select approval_status from public.quotes where id = q) = 'approved', null);
  -- re-approval pending (price changed after approval -> status back to sent): a fresh code approves normally
  update public.quotes set approval_status = 'sent' where id = q;
  c := pg_temp.seed(q, '333333', interval '0');
  r := pg_temp.as_val('anon', format(vsql, tok, '333333'));
  perform pg_temp.t('07 re-approval with a fresh code still works', r like '%"approved": true%' and r not like '%already_approved%'
    and (select count(*) from public.quote_consents where quote_id = q) = n0 + 2, r);
  perform pg_temp.t('08 live function: empty search_path, marker, anon may execute',
    coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r84-otp-once-0307' in p.prosrc) > 0
       from pg_proc p where p.oid = 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure), false)
    and has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute'), null);
  perform pg_temp.t('09 __pre0307 kept, not callable by anon / authenticated',
    to_regprocedure('public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)') is not null
    and not has_function_privilege('anon', 'public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)', 'execute'), null);
end $$;

select name, result from _g307 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R84-OTP-SINGLE-USE-0307: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R84-OTP-SINGLE-USE-0307: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g307;
rollback;
