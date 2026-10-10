-- 0093_country_terms.sql - CANONICAL forward-only. Client approval OTP works for UAE / USA numbers.
--
-- In plain words:
--   The client approval page now shows country terms (India v1-2026-09 unchanged; new
--   v1-2026-09-AE / v1-2026-09-US). The server stores whatever terms id the page sent
--   (quote_consents.terms_version, no allow-list) - nothing to change for that.
--   What did need fixing: the OTP checks compare phone numbers the Indian way (a 10-digit
--   number becomes +91..., or the last 10 digits are compared). A UAE client whose number
--   is on file as "050 123 4567" and who types +971 50 123 4567 was refused, and the live
--   SMS would have gone to a +91 number. Now, for a UAE / USA quote only (its tax country
--   snapshot, else the studio's country), when the typed number and the number on file are
--   the same number with the country code added, the OTP functions use the on-file number
--   consistently and the SMS goes to the number with its own code (+971 / +1).
--   India quotes take exactly the old path. Functions only: the four OTP entry points are
--   renamed once to <fn>__pre0093 and wrapped. No table, column, row or old consent touched.
--   Idempotent (safe to run twice). Needs 0042 and 0092.
-- ============================================================================
do $$ begin
  if to_regprocedure('public.helm_norm_phone_cc(text, text)') is null or to_regprocedure('public._comms_country(uuid)') is null then
    raise exception '0093: apply 0092_country_templates.sql first';
  end if;
  if to_regprocedure('public.request_otp(uuid, text)') is null
     or to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)') is null
     or to_regprocedure('public.otp_send_authorize(uuid, text)') is null then
    raise exception '0093: approval OTP functions missing (apply 0042 first)';
  end if;
end $$;

-- The number to use for this link's OTP. India quotes: exactly what was typed (unchanged).
-- UAE / USA quotes: when the typed number and the number on file are the same number once
-- both carry the quote's country code (+971 / +1), the on-file string is used, so every
-- older check (which reads numbers the Indian way) sees one consistent number.
create or replace function public._otp_canon_phone(p_token uuid, p_phone text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_cc text; v_file text; v_dial text; v_to text;
begin
  select case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
           when 'AE' then 'AE' when 'US' then 'US' else 'IN' end,
         coalesce(q.client ->> 'phone', '')
    into v_cc, v_file
    from public.quotes q where q.approval_token = p_token;
  if v_cc is null or v_cc = 'IN' or v_file = '' or p_phone is null then return p_phone; end if;
  v_dial := case v_cc when 'AE' then '971' else '1' end;
  v_to := public.helm_norm_phone_cc(p_phone, v_dial);
  if v_to ~ '^[0-9]{8,15}$' and v_to = public.helm_norm_phone_cc(v_file, v_dial) then return v_file; end if;
  return p_phone;
end $$;

-- keep this database's own bodies (rename once, only while the name is free)
do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['request_otp', 'uuid, text'],
    ['verify_and_consent', 'uuid, text, text, boolean, text, text, text, text'],
    ['otp_send_authorize', 'uuid, text'],
    ['admin_store_otp', 'uuid, text, text']]
  loop
    if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is not null
       and to_regprocedure(format('public.%s(%s)', f[1] || '__pre0093', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0093');
    end if;
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0093', f[2])) is not null then
      execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0093', f[2]);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0093', f[2]); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0093', f[2]); end if;
    end if;
  end loop;
end $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: UAE / US numbers (see _otp_canon_phone); everything else is the earlier body
begin
  return public.request_otp__pre0093(p_token, public._otp_canon_phone(p_token, p_phone));
end $$;

create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: UAE / US numbers (see _otp_canon_phone); terms_version is stored as given (any id)
begin
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    -- a NULL / malformed code: the 0042 body counts it as a wrong code (C-01), never approves
    return public.verify_and_consent__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code, false,
                                              p_terms_version, p_consent_text, p_client_name, p_user_agent);
  end if;
  return public.verify_and_consent__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code, p_agreed,
                                            p_terms_version, p_consent_text, p_client_name, p_user_agent);
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0093: a UAE / US client gets the SMS at their number with its own country code
declare v_p text := public._otp_canon_phone(p_token, p_phone); v_out jsonb; v_cc text;
begin
  v_out := public.otp_send_authorize__pre0093(p_token, v_p);
  if v_p is distinct from p_phone and v_out ? 'mobile' then
    select case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(q.org_id)))
             when 'AE' then '971' when 'US' then '1' else '91' end
      into v_cc from public.quotes q where q.approval_token = p_token;
    v_out := v_out || jsonb_build_object('mobile', public.helm_norm_phone_cc(v_p, v_cc));
  end if;
  return v_out;
end $$;

do $$ begin
  if to_regprocedure('public.admin_store_otp__pre0093(uuid, text, text)') is not null then
    execute $f$
create or replace function public.admin_store_otp(p_token uuid, p_phone text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $b$
-- 0093: same number the checks see (see _otp_canon_phone)
begin
  return public.admin_store_otp__pre0093(p_token, public._otp_canon_phone(p_token, p_phone), p_code);
end $b$;
$f$;
  end if;
end $$;

-- grants: same as before (public link RPCs for anon; Edge Function RPCs service role only)
do $$
declare r record;
begin
  for r in select * from (values
      ('public._otp_canon_phone(uuid, text)', false),
      ('public.request_otp(uuid, text)', true),
      ('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)', true),
      ('public.otp_send_authorize(uuid, text)', false),
      ('public.admin_store_otp(uuid, text, text)', false)) v(f, pub)
  loop
    continue when to_regprocedure(r.f) is null;
    execute format('revoke all on function %s from public', r.f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format(case when r.pub then 'grant execute on function %s to anon' else 'revoke all on function %s from anon' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format(case when r.pub then 'grant execute on function %s to authenticated' else 'revoke all on function %s from authenticated' end, r.f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.f); end if;
  end loop;
end $$;

-- ---- VERIFY (read-only) - same rows as supabase/APPLY-0092-0093.sql (0093 part)
-- select item, ok from (values
--   ('0093 01 OTP entry points wrapped once', to_regprocedure('public.request_otp__pre0093(uuid, text)') is not null
--        and to_regprocedure('public.verify_and_consent__pre0093(uuid, text, text, boolean, text, text, text, text)') is not null
--        and to_regprocedure('public.otp_send_authorize__pre0093(uuid, text)') is not null
--        and to_regprocedure('public.otp_send_authorize__pre0093__pre0093(uuid, text)') is null),
--   ('0093 02 wrappers use the country-aware number', pg_get_functiondef('public.request_otp(uuid, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'
--        and pg_get_functiondef('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'
--        and pg_get_functiondef('public.otp_send_authorize(uuid, text)'::regprocedure) like '%_otp_canon_phone(p_token, p_phone)%'),
--   ('0093 03 unknown link keeps the typed number', public._otp_canon_phone('00000000-0000-0000-0000-000000000000'::uuid, '+971501234567') = '+971501234567'),
--   ('0093 04 secdef with empty search_path', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
--        and p.proname in ('_otp_canon_phone', 'request_otp', 'verify_and_consent', 'otp_send_authorize')
--        and (not p.prosecdef or not ('search_path=""' = any(p.proconfig))))),
--   ('0093 05 public link RPCs still open to anon', has_function_privilege('anon', 'public.request_otp(uuid, text)', 'execute')
--        and has_function_privilege('anon', 'public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'execute')),
--   ('0093 06 SMS / helper / old bodies not executable by anon or authenticated', not has_function_privilege('anon', 'public.otp_send_authorize(uuid, text)', 'execute')
--        and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid, text)', 'execute')
--        and not has_function_privilege('anon', 'public._otp_canon_phone(uuid, text)', 'execute')
--        and not has_function_privilege('anon', 'public.request_otp__pre0093(uuid, text)', 'execute')
--        and not has_function_privilege('anon', 'public.verify_and_consent__pre0093(uuid, text, text, boolean, text, text, text, text)', 'execute'))
-- ) v(item, ok)
-- order by item;
