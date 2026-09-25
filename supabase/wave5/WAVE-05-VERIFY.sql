-- ============================================================================
-- WAVE-05-VERIFY.sql   —  READ ONLY.  DOES NOT MUTATE ANYTHING.
-- ----------------------------------------------------------------------------
-- Run AFTER WAVE-05-UPGRADE.sql to prove each intended result. SELECT-only.
-- Every row should read status = PASS. Investigate any FAIL / REVIEW.
-- ============================================================================

with v as (
  -- SEC-01 --------------------------------------------------------------------
  select 'SEC-01' area,'layouts.org_id present' check_name,'yes' expected,
    case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='layouts' and column_name='org_id') then 'yes' else 'no' end actual
  union all select 'SEC-01','layouts RLS enabled','yes',
    case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='layouts' and c.relrowsecurity) then 'yes' else 'no' end
  union all select 'SEC-01','layouts has NO anon policy','yes',
    case when not exists (select 1 from pg_policies where schemaname='public' and tablename='layouts' and 'anon' = any(roles)) then 'yes' else 'no' end
  union all select 'SEC-01','layouts 4 authenticated policies','yes',
    case when (select count(*) from pg_policies where schemaname='public' and tablename='layouts' and 'authenticated' = any(roles))=4 then 'yes' else 'no' end
  union all select 'SEC-01','layouts_stamp_org trigger','yes',
    case when exists (select 1 from pg_trigger where tgname='layouts_stamp_org' and not tgisinternal) then 'yes' else 'no' end
  union all select 'SEC-01','anon has NO grant on layouts','yes',
    case when not exists (select 1 from information_schema.role_table_grants where table_schema='public' and table_name='layouts' and grantee='anon') then 'yes' else 'no' end

  -- MONEY ---------------------------------------------------------------------
  union all select 'MONEY-03','receipt uniqueness index','yes',
    case when exists (select 1 from pg_indexes where schemaname='public' and indexname='quote_payments_quote_receipt_uk') then 'yes' else 'no' end
  union all select 'MONEY-05','idempotency_key column','yes',
    case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='quote_payments' and column_name='idempotency_key') then 'yes' else 'no' end
  union all select 'MONEY-05','idempotency uniqueness index','yes',
    case when exists (select 1 from pg_indexes where schemaname='public' and indexname='quote_payments_idempotency_uk') then 'yes' else 'no' end
  union all select 'MONEY-04','version label uniqueness index','yes',
    case when exists (select 1 from pg_indexes where schemaname='public' and indexname='quotation_versions_quote_label_uk') then 'yes' else 'no' end
  union all select 'MONEY-03','record_payment 7-arg only (no ambiguous 6-arg)','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_payment' and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text, text')
          and not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_payment' and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text')
         then 'yes' else 'no' end
  union all select 'MONEY-04','save_quotation_version rejects negative','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='save_quotation_version' and pg_get_functiondef(p.oid) ilike '%cannot be negative%') then 'yes' else 'no' end

  -- TOKEN-01 ------------------------------------------------------------------
  union all select 'TOKEN-01','approval_token_expires_at column','yes',
    case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_expires_at') then 'yes' else 'no' end
  union all select 'TOKEN-01','approval_token_revoked_at column','yes',
    case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_revoked_at') then 'yes' else 'no' end
  union all select 'TOKEN-01','revoke_approval_token fn + not anon','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='revoke_approval_token')
          and not exists (select 1 from information_schema.role_routine_grants where routine_schema='public' and routine_name='revoke_approval_token' and grantee='anon')
         then 'yes' else 'no' end
  union all select 'TOKEN-01','request_otp enforces expiry-if-set','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='request_otp' and pg_get_functiondef(p.oid) ilike '%approval_token_expires_at is null or approval_token_expires_at > now()%') then 'yes' else 'no' end

  -- OTP-01 --------------------------------------------------------------------
  union all select 'OTP-01','otp_dev_echo flag present & false','yes',
    case when coalesce((select (value->>'otp_dev_echo') from public.app_config where key='channels'),'true')='false' then 'yes' else 'no' end
  union all select 'OTP-01','request_otp fail-closed + dev-echo gated','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='request_otp' and pg_get_functiondef(p.oid) ilike '%otp_dev_echo%' and pg_get_functiondef(p.oid) ilike '%unavailable%') then 'yes' else 'no' end

  -- SEC-03 --------------------------------------------------------------------
  union all select 'SEC-03','generate_approval_token org-scoped & not anon','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='generate_approval_token' and pg_get_functiondef(p.oid) ilike '%assert_quote_org%')
          and not exists (select 1 from information_schema.role_routine_grants where routine_schema='public' and routine_name='generate_approval_token' and grantee='anon')
         then 'yes' else 'no' end
  union all select 'SEC-03','mark_paid org-scoped & not anon','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_paid' and pg_get_functiondef(p.oid) ilike '%assert_quote_org%')
          and not exists (select 1 from information_schema.role_routine_grants where routine_schema='public' and routine_name='mark_paid' and grantee='anon')
         then 'yes' else 'no' end

  -- phase91/92/93 -------------------------------------------------------------
  union all select 'phase91','organizations.location column','yes',
    case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='organizations' and column_name='location') then 'yes' else 'no' end
  union all select 'phase92','sync_quote_to_lead + 2 triggers','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='sync_quote_to_lead')
          and (select count(*) from pg_trigger where tgname in ('quotes_sync_lead_ins','quotes_sync_lead_upd') and not tgisinternal)=2
         then 'yes' else 'no' end
  union all select 'phase92','no quote has a client but missing lead','yes',
    case when not exists (select 1 from public.quotes q where coalesce(btrim(q.client->>'name'),'')<>'' and not exists (select 1 from public.leads l where l.quote_id=q.id)) then 'yes' else 'no' end
  union all select 'phase93','public_get_proposal returns pricing+total','yes',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='public_get_proposal' and pg_get_functiondef(p.oid) ilike '%''total''%') then 'yes' else 'no' end
)
select area, check_name, expected, actual,
       case when actual=expected then 'PASS' else 'FAIL' end as status
from v order by area, check_name;

-- Operator note: legacy ownerless layouts still needing an org (SEC-01 quarantine):
select public.layouts_quarantined_count() as layouts_without_org;
