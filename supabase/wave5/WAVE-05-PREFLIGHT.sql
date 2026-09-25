-- ============================================================================
-- WAVE-05-PREFLIGHT.sql   —  READ ONLY.  DOES NOT MUTATE ANYTHING.
-- ----------------------------------------------------------------------------
-- Purpose: inspect the EXISTING Helm Supabase database and report whether each
-- Wave 1–4 hardening object is already present. Run this FIRST, review the
-- output, then decide/confirm WAVE-05-UPGRADE.sql.
--
-- Safe: SELECT-only against system catalogs. No INSERT/UPDATE/DELETE/CREATE/
-- ALTER/DROP/GRANT/REVOKE. Paste into the Supabase SQL Editor and Run.
--
-- Reads: information_schema, pg_proc, pg_policies, pg_indexes, pg_constraint,
--        pg_trigger, information_schema.role_table_grants, app_config.
-- ============================================================================

with checks as (

  -- SEC-01: layouts tenant isolation ---------------------------------------
  select 'SEC-01' area, 'layouts.org_id column' item,
         'present' expected,
         case when exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='layouts' and column_name='org_id')
              then 'present' else 'MISSING' end actual
  union all
  select 'SEC-01','layouts anon "using(true)" open policy','ABSENT (removed)',
         case when exists (select 1 from pg_policies where schemaname='public' and tablename='layouts'
                and 'anon' = any(roles)) then 'STILL PRESENT' else 'absent' end
  union all
  select 'SEC-01','layouts org-scoped authenticated policies (expect 4)','4',
         (select count(*)::text from pg_policies where schemaname='public' and tablename='layouts'
            and 'authenticated' = any(roles))
  union all
  select 'SEC-01','layouts RLS enabled','enabled',
         case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relname='layouts' and c.relrowsecurity) then 'enabled' else 'DISABLED' end
  union all
  select 'SEC-01','layouts_stamp_org trigger','present',
         case when exists (select 1 from pg_trigger where tgname='layouts_stamp_org' and not tgisinternal)
              then 'present' else 'MISSING' end
  union all
  select 'SEC-01','anon table grant on layouts','ABSENT (revoked)',
         case when exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='layouts' and grantee='anon')
              then 'STILL GRANTED' else 'revoked' end
  union all
  select 'SEC-01','layouts_quarantined_count() fn','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='layouts_quarantined_count') then 'present' else 'MISSING' end

  -- MONEY-03/04/05: numbering + idempotency ---------------------------------
  union all
  select 'MONEY-03','quote_payments (quote_id,receipt_no) unique idx','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quote_payments_quote_receipt_uk') then 'present' else 'MISSING' end
  union all
  select 'MONEY-05','quote_payments.idempotency_key column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quote_payments' and column_name='idempotency_key') then 'present' else 'MISSING' end
  union all
  select 'MONEY-05','quote_payments (quote_id,idempotency_key) unique idx','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quote_payments_idempotency_uk') then 'present' else 'MISSING' end
  union all
  select 'MONEY-04','quotation_versions (quote_id,label) unique idx','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quotation_versions_quote_label_uk') then 'present' else 'MISSING' end
  union all
  select 'MONEY-03','record_payment 7-arg signature','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text, text')
              then 'present' else 'MISSING' end
  union all
  select 'MONEY-03','record_payment 6-arg overload (should be gone)','ABSENT',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text')
              then 'STILL PRESENT (ambiguous)' else 'absent' end
  union all
  select 'MONEY-05','record_payment idempotency retry body','contains idempotency_key',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_functiondef(p.oid) ilike '%idempotency_key%'
              and pg_get_functiondef(p.oid) ilike '%unique_violation%') then 'yes' else 'NO/OLD BODY' end
  union all
  select 'MONEY-04','save_quotation_version retry + negative reject','hardened body',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version'
              and pg_get_functiondef(p.oid) ilike '%unique_violation%'
              and pg_get_functiondef(p.oid) ilike '%cannot be negative%') then 'yes' else 'NO/OLD BODY' end

  -- TOKEN-01: approval token expiry / revocation ----------------------------
  union all
  select 'TOKEN-01','quotes.approval_token_expires_at column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quotes' and column_name='approval_token_expires_at') then 'present' else 'MISSING' end
  union all
  select 'TOKEN-01','quotes.approval_token_revoked_at column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quotes' and column_name='approval_token_revoked_at') then 'present' else 'MISSING' end
  union all
  select 'TOKEN-01','revoke_approval_token(uuid) fn','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='revoke_approval_token') then 'present' else 'MISSING' end
  union all
  select 'TOKEN-01','request_otp enforces token expiry-if-set','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='request_otp'
              and pg_get_functiondef(p.oid) ilike '%approval_token_expires_at is null or approval_token_expires_at > now()%')
              then 'yes' else 'NO/OLD BODY' end

  -- OTP-01: dev-echo gating / fail-closed -----------------------------------
  union all
  select 'OTP-01','channels.otp_dev_echo flag exists','present',
         case when exists (select 1 from public.app_config where key='channels' and value ? 'otp_dev_echo')
              then 'present' else 'MISSING' end
  union all
  select 'OTP-01','otp_dev_echo currently','false (prod-safe)',
         coalesce((select (value->>'otp_dev_echo') from public.app_config where key='channels'),'(no row)')
  union all
  select 'OTP-01','request_otp gates echo on otp_dev_echo + fail-closed','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='request_otp'
              and pg_get_functiondef(p.oid) ilike '%otp_dev_echo%'
              and pg_get_functiondef(p.oid) ilike '%unavailable%') then 'yes' else 'NO/OLD BODY' end

  -- SEC-03: org-scoped privileged fns ---------------------------------------
  union all
  select 'SEC-03','generate_approval_token org-scoped','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='generate_approval_token'
              and pg_get_functiondef(p.oid) ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end
  union all
  select 'SEC-03','mark_paid org-scoped','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='mark_paid'
              and pg_get_functiondef(p.oid) ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end
  union all
  select 'SEC-03','anon grant on generate_approval_token (should be gone)','ABSENT',
         case when exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='generate_approval_token' and grantee='anon')
              then 'STILL GRANTED' else 'absent' end

  -- phase91/92/93 ------------------------------------------------------------
  union all
  select 'phase91','organizations.location column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='organizations' and column_name='location') then 'present' else 'MISSING' end
  union all
  select 'phase92','sync_quote_to_lead fn','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='sync_quote_to_lead') then 'present' else 'MISSING' end
  union all
  select 'phase92','quotes_sync_lead_ins/upd triggers (expect 2)','2',
         (select count(*)::text from pg_trigger where tgname in ('quotes_sync_lead_ins','quotes_sync_lead_upd') and not tgisinternal)
  union all
  select 'phase93','public_get_proposal returns pricing/total','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='public_get_proposal'
              and pg_get_functiondef(p.oid) ilike '%''pricing''%'
              and pg_get_functiondef(p.oid) ilike '%''total''%') then 'yes' else 'NO/OLD BODY' end

  -- Dependencies the upgrade assumes already exist (from earlier phases) -----
  union all
  select 'DEP','current_org_id() fn (phase56)','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='current_org_id') then 'present' else 'MISSING (run phase56 first)' end
  union all
  select 'DEP','assert_quote_org() fn (phase71+)','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='assert_quote_org') then 'present' else 'MISSING (run phase71+ first)' end
  union all
  select 'DEP','quote_payments.receipt_no column (phase76)','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quote_payments' and column_name='receipt_no') then 'present' else 'MISSING (run phase76 first)' end
  union all
  select 'DEP','quotation_versions table (phase77)','present',
         case when exists (select 1 from information_schema.tables where table_schema='public'
              and table_name='quotation_versions') then 'present' else 'MISSING (run phase77 first)' end
)
select area, item, expected, actual,
       case when actual = expected then 'PASS'
            when actual in ('present','absent','revoked','enabled','yes','4','2','false (prod-safe)') and expected=actual then 'PASS'
            when actual like 'MISSING%' or actual like 'STILL%' or actual like 'NO/%' or actual like 'DISABLED' then 'NEEDS UPGRADE'
            else 'REVIEW' end as status
from checks
order by area, item;

-- Legacy ownerless layouts (SEC-01 quarantine): how many need operator ownership?
-- (SELECT only. Function exists only after phase89/upgrade is applied.)
-- select public.layouts_quarantined_count() as layouts_without_org;
