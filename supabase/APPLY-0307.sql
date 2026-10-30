-- APPLY-0307.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0262 (any order with the other 03xx fixes). It stops with "STOP 0307" if a needed function is missing.
-- R84 (staging e2e r81, MEDIUM) "approval code reuse":
--   A client can ask for more than one approval code for the same quote. Only the code that was checked got used up,
--   so after a newer code approved the quote, an OLDER unused code could approve it AGAIN (two consent records for
--   one quote). This re-issues public.verify_and_consent as a small wrapper:
--     * if the quote is already approved / paid (and no re-approval is pending) every open code is cancelled and the
--       page gets the same "approved" answer it already shows - no second consent record, nothing else changes;
--     * after a successful approval every other unused code for that quote is cancelled.
--   The previous function is kept once (renamed) as verify_and_consent__pre0307 (not callable by the app); the live
--   name keeps the same grants (anon, authenticated, service_role). No table / column / row / policy / index / trigger is created, changed or deleted. Safe to run
--   twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  No site change is needed for this part (the approval page already handles the answer).
begin;
-- 0307_r84_otp_single_use.sql - CANONICAL forward-only. R84 (staging e2e r81, MEDIUM): client quote approval codes.
-- Bug: a client can request several codes for one quote (cap 3 per 10 minutes). The verify path only marks the ONE
-- code it checked as used (verified_at), so after a newer code B approved the quote, an OLDER unused code A for the
-- same quote was still "active" and verified again - a second consent record for one quote.
-- Fix (wrapper over the live public.verify_and_consent, which wa_verify_and_consent also calls):
--   * the quote row is locked first; when the quote is ALREADY approved / paid by the client (and no re-approval is
--     pending, i.e. consent_stale is false) every open code is expired and the call returns the same
--     {approved: true} result the approval page already handles, with already_approved = true - NO new consent row,
--     no status change;
--   * after a successful verify, every other unused code for that quote is expired (single use per approval).
-- House "wrap once" pattern (as 0262): the logic lives in NEW public._r307_verify (re-issued on every run); the live
-- verify_and_consent is renamed ONCE to verify_and_consent__pre0307 (app privileges taken away) and a thin wrapper with
-- the same signature and the same grants (anon, authenticated, service_role) takes its place. No table / column / row / policy / index / trigger is
-- created, changed or deleted (open codes only get expires_at = now() at call time). Safe to run twice. ASCII only.
do $$
begin
  if to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is null then
    raise exception 'STOP 0307: public.verify_and_consent is missing (needs 0026)'; end if;
  if to_regprocedure('public._a42_expire_open_otps(uuid)') is null then
    raise exception 'STOP 0307: public._a42_expire_open_otps(uuid) is missing (needs 0042)'; end if;
  if to_regclass('public.quote_otps') is null or to_regclass('public.quote_consents') is null then
    raise exception 'STOP 0307: quote_otps / quote_consents missing'; end if;
end $$;

-- ---- 1) the logic (re-issued on every run; not callable by the app) ----------------------------------------------
create or replace function public._r307_verify(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text,
                                               p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r84-otp-once-0307: one approval per quote; a successful verify expires every other open code for the quote
declare v_q uuid; v_status text; v_stale boolean; v_out jsonb;
begin
  if p_token is not null then
    select q.id, q.approval_status, coalesce(q.consent_stale, false) into v_q, v_status, v_stale
      from public.quotes q
     where q.approval_token = p_token
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
       for update;                                   -- concurrent verifies of one quote serialize here
  end if;
  if v_q is not null and v_status in ('approved', 'paid') and not v_stale then
    perform public._a42_expire_open_otps(v_q);       -- already approved: no second consent, old codes die
    return jsonb_build_object('approved', true, 'already_approved', true,
                              'message', 'This quote is already approved - nothing more to do.');
  end if;
  v_out := public.verify_and_consent__pre0307(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text,
                                              p_client_name, p_user_agent);
  if v_q is not null and coalesce((v_out ->> 'approved')::boolean, false) then
    perform public._a42_expire_open_otps(v_q);       -- every other unused code for this quote is now used up
  end if;
  return v_out;
end $$;

-- ---- 2) wrap once: a 2nd run (or a run after a LATER wrapper) never replaces what is there ------------------------
do $$ declare v_src text; begin
  if to_regprocedure('public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)') is null then
    alter function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) rename to verify_and_consent__pre0307;
    create function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text,
                                              p_consent_text text, p_client_name text, p_user_agent text)
      returns jsonb language sql volatile security definer set search_path = ''
      as 'select public._r307_verify(p_token, p_phone, p_code, p_agreed, p_terms_version, p_consent_text, p_client_name, p_user_agent) /* r84-otp-once-0307 */';
  else
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)');
    if position('_r307_verify' in coalesce(v_src, '')) = 0 then
      raise notice '0307: verify_and_consent was wrapped again after 0307 - left unchanged (check the chain still reaches _r307_verify)';
    end if;
  end if;
end $$;

-- ---- 3) privileges: the live name keeps the app grants; the kept body and the logic are not callable by the app ----
revoke all on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) from public;
revoke all on function public.verify_and_consent__pre0307(uuid, text, text, boolean, text, text, text, text) from public;
revoke all on function public._r307_verify(uuid, text, text, boolean, text, text, text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.verify_and_consent(uuid, text, text, boolean, text, text, text, text) to %I', r);
      if r <> 'service_role' then
        execute format('revoke all on function public.verify_and_consent__pre0307(uuid, text, text, boolean, text, text, text, text) from %I', r);
        execute format('revoke all on function public._r307_verify(uuid, text, text, boolean, text, text, text, text) from %I', r);
      end if;
    end if;
  end loop;
end $$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 verify_and_consent: security definer, empty search_path, carries the r84-otp-once-0307 marker',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                      and position('r84-otp-once-0307' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)')), false)),
  ('02 the approval page can still call it (anon + authenticated execute)',
     has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')),
  ('03 previous body kept once as verify_and_consent__pre0307, not callable by the app',
     to_regprocedure('public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)') is not null
     and not has_function_privilege('anon', 'public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)', 'execute')),
  ('04 the kept copy is the real previous body (not the 0307 wrapper); the logic is not callable by the app',
     coalesce((select position('r84-otp-once-0307' in p.prosrc) = 0 from pg_proc p
                where p.oid = to_regprocedure('public.verify_and_consent__pre0307(uuid,text,text,boolean,text,text,text,text)')), false)
     and not has_function_privilege('anon', 'public._r307_verify(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r307_verify(uuid,text,text,boolean,text,text,text,text)', 'execute'))
) v(item, ok);
