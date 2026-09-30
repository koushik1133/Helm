-- ============================================================================
-- C2b-PROD — fix verify_and_consent OTP lockout (attempt counter rollback bug)
-- PROBLEM on prod: the wrong-code branch does 'update quote_otps set attempts=attempts+1'
--   then RAISES — the raise aborts the txn and ROLLS BACK the increment, so attempts
--   never rises and the 5-attempt lockout never trips (unlimited OTP guesses).
-- FIX: return {approved:false, error:'incorrect_code', remaining:N} instead of raising,
--   so the increment COMMITS. Frontend already handles approved!==true (Wave-10 C1).
-- Minimal, forward-only, single-function replacement. Verified on staging.
-- Run order: PRECHECK -> UPGRADE -> VERIFY. ROLLBACK restores prior body if needed.
-- ============================================================================

-- ============================ PRECHECK (read-only) ===========================
-- Expect: definition still contains "raise exception 'incorrect code'" (buggy).
select case when pg_get_functiondef(oid) like '%raise exception ''incorrect code''%'
            then 'BUGGY (needs fix)' else 'already fixed / different' end as precheck
  from pg_proc where proname='verify_and_consent' and pronamespace='public'::regnamespace;

-- ============================ UPGRADE (forward) ==============================
CREATE OR REPLACE FUNCTION public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then
    return jsonb_build_object('approved', false, 'error','no_active_code', 'message','no active code — request a new OTP');
  end if;
  if rec.attempts >= 5 then
    return jsonb_build_object('approved', false, 'error','locked', 'message','too many attempts — request a new OTP');
  end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    return jsonb_build_object('approved', false, 'error','incorrect_code', 'message','incorrect code',
      'remaining', greatest(0, 5 - (rec.attempts+1)));
  end if;
  if p_agreed is not true then
    return jsonb_build_object('approved', false, 'error','not_agreed', 'message','you must accept the terms to confirm');
  end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $function$;

-- ============================ VERIFY (read-only) =============================
-- Expect fixed=true: no raising on wrong code; returns error='incorrect_code'.
select (pg_get_functiondef(oid) like '%''incorrect_code''%'
        and pg_get_functiondef(oid) not like '%raise exception ''incorrect code''%') as fixed
  from pg_proc where proname='verify_and_consent' and pronamespace='public'::regnamespace;
