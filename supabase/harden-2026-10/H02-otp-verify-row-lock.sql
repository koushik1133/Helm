-- ============================================================================
-- H02 — OTP verification: lock the active OTP row (FOR UPDATE) for concurrency
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Apply order: H01 → H02 → H03. NOT APPLIED.
-- Verify with the OTP race tests in supabase/tests/ on an ISOLATED test DB first.
--
-- BASELINE: verify_and_consent was already fixed this cycle (C2b / PROD-FINAL (A))
-- to PERSIST the wrong-attempt increment by RETURNING {approved:false,...} instead
-- of RAISE (a raise rolled the counter back). That fix is preserved verbatim here.
--
-- WHAT THIS ADDS: `SELECT ... FOR UPDATE` on the active OTP row. Two concurrent
-- verifications now serialize on that row:
--   * single-use: only ONE txn can set verified_at; the other re-evaluates the
--     `verified_at is null` predicate after the first commits (EvalPlanQual),
--     finds no active row, and returns 'no_active_code' — so only one succeeds.
--   * attempt accounting: the increment can't be lost to a concurrent read.
-- Expiry, 5-attempt lockout, hashed-code compare, and generic client-safe
-- responses are unchanged. Codes remain hashed (extensions.crypt); no plaintext.
--
-- Additive + idempotent (create or replace). Grants unchanged (public approval
-- endpoint stays callable exactly as before — we do NOT touch grants here).
-- ============================================================================

-- ---- PRECHECK (read-only) — expect has_for_update = false (not yet locked) ----
select (pg_get_functiondef(oid) ilike '%for update%') as has_for_update,
       (pg_get_functiondef(oid) ilike '%''incorrect_code''%') as has_c2b_fix
from pg_proc where proname = 'verify_and_consent' and pronamespace = 'public'::regnamespace;

-- ---- APPLY ----------------------------------------------------------------
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

  -- lock the active OTP row: concurrent verifications serialize here (single-use
  -- + attempt accounting are race-safe). EvalPlanQual re-checks verified_at/expiry
  -- after the lock, so a code that was just consumed/expired is treated as inactive.
  select * into rec from public.quote_otps
    where quote_id = q.id and phone = p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1
    for update;

  if rec.id is null then
    return jsonb_build_object('approved', false, 'error','no_active_code', 'message','no active code — request a new OTP');
  end if;
  if rec.attempts >= 5 then
    return jsonb_build_object('approved', false, 'error','locked', 'message','too many attempts — request a new OTP');
  end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts + 1 where id = rec.id;   -- persists (C2b)
    return jsonb_build_object('approved', false, 'error','incorrect_code', 'message','incorrect code',
      'remaining', greatest(0, 5 - (rec.attempts + 1)));
  end if;
  if p_agreed is not true then
    return jsonb_build_object('approved', false, 'error','not_agreed', 'message','you must accept the terms to confirm');
  end if;

  update public.quote_otps set verified_at = now() where id = rec.id;        -- single-use
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status = 'approved', updated_at = now() where id = q.id;
  return jsonb_build_object('approved', true);
end; $function$;

-- ---- VERIFY (expect both true) --------------------------------------------
select (pg_get_functiondef(oid) ilike '%for update%') as now_locks_row,
       (pg_get_functiondef(oid) ilike '%''incorrect_code''%'
         and pg_get_functiondef(oid) not ilike '%raise exception ''incorrect code''%') as c2b_fix_preserved
from pg_proc where proname = 'verify_and_consent' and pronamespace = 'public'::regnamespace;

-- ---- ROLLBACK -------------------------------------------------------------
-- Re-apply supabase/prod-fix/PROD-FINAL-DB-ADDS.sql section (A) (the pre-lock,
-- C2b-fixed body) to revert to the baseline.
