-- =========================================================================
-- DEPRECATED (PR-AUTH-01 / PR-DEPLOY-01): this file previously overrode
-- request_otp() with a FIXED dev PIN (123456). A fixed/predictable OTP let any
-- holder of a quote's approval_token guess the code and self-approve, so it has
-- been removed. This file is kept only so that historically-applied databases
-- and any automation that still references it converge to the SAFE, random-code
-- implementation instead of reintroducing the bypass.
--
-- It now installs the SAME random-code request_otp() as otp-payments.sql. It is
-- idempotent and safe to run at any time; it can never restore the fixed PIN.
--
-- NOTE (OTP-01, Wave 4): the code is echoed via dev_code ONLY when the explicit
-- channels.otp_dev_echo flag is true (default false). With SMS not live and the
-- echo flag off, the flow reports 'unavailable' (fail closed) — it never leaks
-- the OTP to an anonymous token holder. This matches otp-payments.sql exactly,
-- so re-running this file can never reintroduce the echo bypass.
-- Depends on: otp-payments.sql.
-- =========================================================================
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- Random 6-digit code — never a hardcoded/predictable PIN (PR-AUTH-01).
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  -- OTP-01: echo ONLY behind the explicit otp_dev_echo flag (default false).
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $$;
