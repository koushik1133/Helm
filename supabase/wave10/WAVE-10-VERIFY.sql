-- WAVE-10-VERIFY.sql  (READ-ONLY — run in STAGING after UPGRADE)
-- Confirms both Wave-10 fixes are in place (source-level).
select 'W10-D1 verify_and_consent soft-returns (attempts persist)' as check,
       case when pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure)
            like '%incorrect_code%' then 'PASS' else 'FAIL' end as result
union all
select 'W10-D2 public_get_portal enforces token expiry',
       case when pg_get_functiondef('public.public_get_portal(uuid)'::regprocedure)
            like '%approval_token_expires_at%' then 'PASS' else 'FAIL' end;
