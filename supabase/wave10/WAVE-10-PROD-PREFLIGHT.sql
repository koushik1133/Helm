-- ============================================================================
-- WAVE-10-PROD-PREFLIGHT.sql   (READ-ONLY — run in PRODUCTION first)
-- ----------------------------------------------------------------------------
-- Robust detection: the FIXED versions add distinctive markers —
--   D1 fixed  -> soft-return key 'incorrect_code' (underscore) present
--   D2 fixed  -> 'approval_token_expires_at' present in public_get_portal
-- OLD/vulnerable = those markers ABSENT. Changes nothing.
-- Expected on un-patched prod: both rows PASS (old present, safe to upgrade).
-- ============================================================================
select 'D1 verify_and_consent is OLD (attempts increment rolled back by raise)' as check,
       case when pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure)
                 not like '%incorrect_code%'
            then 'PASS — old vulnerable version present (safe to upgrade)'
            else 'STOP — already patched (soft-return present); do NOT re-apply'
       end as result
union all
select 'D2 public_get_portal is OLD (no expiry predicate)',
       case when pg_get_functiondef('public.public_get_portal(uuid)'::regprocedure)
                 not like '%approval_token_expires_at%'
            then 'PASS — old vulnerable version present (safe to upgrade)'
            else 'STOP — already patched (expiry predicate present); do NOT re-apply'
       end;
