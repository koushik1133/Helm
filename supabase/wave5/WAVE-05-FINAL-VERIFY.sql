-- ============================================================================
-- WAVE-05-FINAL-VERIFY.sql   —  100% READ ONLY.  DOES NOT MUTATE ANYTHING.
-- ----------------------------------------------------------------------------
-- Post-Wave-5 live verification. SELECT-only against system catalogs + a few
-- read-only reads of app_config / quotes. NO INSERT / UPDATE / DELETE / ALTER /
-- CREATE / DROP / GRANT / REVOKE anywhere.
--
-- Unlike WAVE-05-VERIFY.sql (multiple statements), this returns ONE SINGLE
-- RESULT TABLE so the Supabase SQL Editor shows everything at once. Paste the
-- whole file and Run; read the final grid.
--
-- Columns: area | check_name | expected | actual | status | severity | notes
-- status  : PASS | FAIL | REVIEW
-- severity: high | med | low | info
--
-- IMPORTANT CORRECTION baked into the app_config checks:
--   app_config is MULTI-TENANT. Its correct uniqueness is the COMPOSITE PRIMARY
--   KEY (org_id, key) (phase57). A standalone UNIQUE(key) is WRONG and breaks
--   per-org config (set_pricing_config uses `on conflict (org_id,key)`), so this
--   script verifies the composite PK is present AND that no standalone unique(key)
--   exists. The same key ('pricing','channels') appearing once PER ORG is normal;
--   a true duplicate is two rows sharing the SAME (org_id,key), which the PK bars.
-- ============================================================================

with checks as (

  -- =====================================================================
  -- 1) app_config integrity  (multi-tenant: PK = (org_id, key))
  -- =====================================================================
  select 'app_config' area, 'no true duplicates per (org_id,key)' check_name,
         '0' expected,
         (select coalesce(count(*),0)::text from
            (select org_id, key from public.app_config group by org_id, key having count(*)>1) d) actual,
         'high' severity,
         'True duplicates are impossible while the composite PK exists; >0 means the PK is missing.' notes
  union all
  select 'app_config','composite PK (org_id,key) present','yes',
         case when exists (
           select 1 from pg_constraint c
           where c.conrelid='public.app_config'::regclass and c.contype='p'
             and (select array_agg(att.attname order by att.attnum)
                    from unnest(c.conkey) k join pg_attribute att
                      on att.attrelid=c.conrelid and att.attnum=k) = array['org_id','key']
         ) then 'yes' else 'no' end,
         'high',
         'This is the correct uniqueness for multi-tenant app_config.'
  union all
  select 'app_config','NO standalone unique(key) constraint (must be absent)','absent',
         case when exists (
           select 1 from pg_constraint c
           where c.conrelid='public.app_config'::regclass and c.contype='u'
             and (select array_agg(att.attname order by att.attnum)
                    from unnest(c.conkey) k join pg_attribute att
                      on att.attrelid=c.conrelid and att.attnum=k) = array['key']
         ) then 'PRESENT (harmful)' else 'absent' end,
         'high',
         'A unique(key) here breaks per-org config inserts / set_pricing_config on conflict (org_id,key). phase97 drops it.'
  union all
  select 'app_config','channels rows: one per org (no per-org dup)','yes',
         case when exists (
           select 1 from public.app_config where key='channels'
           group by org_id, key having count(*)>1
         ) then 'DUPLICATE PER ORG' else 'yes' end,
         'med',
         (select 'distinct orgs with channels row = '||count(distinct org_id)::text
            from public.app_config where key='channels')
  union all
  select 'app_config','pricing rows: one per org (no per-org dup)','yes',
         case when exists (
           select 1 from public.app_config where key='pricing'
           group by org_id, key having count(*)>1
         ) then 'DUPLICATE PER ORG' else 'yes' end,
         'med',
         (select 'distinct orgs with pricing row = '||count(distinct org_id)::text
            from public.app_config where key='pricing')

  -- =====================================================================
  -- 2) SEC-01  layouts tenant isolation
  -- =====================================================================
  union all
  select 'SEC-01','layouts.org_id column present','present',
         case when exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='layouts' and column_name='org_id')
              then 'present' else 'MISSING' end,'high',''
  union all
  select 'SEC-01','layouts RLS enabled','enabled',
         case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='public' and c.relname='layouts' and c.relrowsecurity)
              then 'enabled' else 'DISABLED' end,'high',''
  union all
  select 'SEC-01','anon has NO table CRUD grant on layouts','absent',
         case when exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='layouts' and grantee='anon')
              then 'STILL GRANTED' else 'absent' end,'high',''
  union all
  select 'SEC-01','no anon policy on layouts (old using(true) gone)','absent',
         case when exists (select 1 from pg_policies where schemaname='public'
              and tablename='layouts' and 'anon'=any(roles))
              then 'STILL PRESENT' else 'absent' end,'high',''
  union all
  select 'SEC-01','exactly 4 authenticated policies on layouts','4',
         (select count(*)::text from pg_policies where schemaname='public'
            and tablename='layouts' and 'authenticated'=any(roles)),'high',''
  union all
  select 'SEC-01','no authenticated policy grants global cross-org access','0',
         (select count(*)::text from pg_policies
            where schemaname='public' and tablename='layouts' and 'authenticated'=any(roles)
              and coalesce(qual,'') !~* 'org' and coalesce(with_check,'') !~* 'org'
              and (coalesce(qual,'true')='true' or coalesce(with_check,'true')='true')),
         'high','Any authenticated layouts policy whose predicate is unconditional true (no org check) is a cross-org leak.'
  union all
  select 'SEC-01','layouts_stamp_org trigger present','present',
         case when exists (select 1 from pg_trigger
              where tgname in ('layouts_stamp_org','_layouts_stamp_org') and not tgisinternal)
              then 'present' else 'MISSING' end,'high',
         'Preflight/upgrade name this trigger layouts_stamp_org.'
  union all
  select 'SEC-01','stamp-org trigger FUNCTION present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname ~* 'stamp.*org|layouts_stamp')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'SEC-01','layouts_quarantined_count() fn present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='layouts_quarantined_count')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'SEC-01','layouts with NULL org_id (should be 0)','0',
         (select count(*)::text from public.layouts where org_id is null),'high',
         'Quarantined/ownerless layouts remaining.'

  -- =====================================================================
  -- 3) MONEY-03 / 04 / 05
  -- =====================================================================
  union all
  select 'MONEY-03','receipt uniqueness index','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quote_payments_quote_receipt_uk') then 'present' else 'MISSING' end,'high',''
  union all
  select 'MONEY-04','quotation-version label uniqueness index','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quotation_versions_quote_label_uk') then 'present' else 'MISSING' end,'med',''
  union all
  select 'MONEY-05','quote_payments.idempotency_key column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quote_payments' and column_name='idempotency_key') then 'present' else 'MISSING' end,'high',''
  union all
  select 'MONEY-05','idempotency uniqueness index','present',
         case when exists (select 1 from pg_indexes where schemaname='public'
              and indexname='quote_payments_idempotency_uk') then 'present' else 'MISSING' end,'high',''
  union all
  select 'MONEY-03','record_payment intended 7-arg signature present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text, text')
              then 'present' else 'MISSING' end,'high',''
  union all
  select 'MONEY-03','obsolete 6-arg record_payment overload absent','absent',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_function_identity_arguments(p.oid)='uuid, numeric, text, text, uuid, text')
              then 'STILL PRESENT' else 'absent' end,'high',
         'An older overload could bypass idempotency; must be gone.'
  union all
  select 'MONEY-05','record_payment body handles idempotency','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='record_payment'
              and pg_get_functiondef(p.oid) ilike '%idempotency%') then 'yes' else 'NO/OLD BODY' end,'high',''
  union all
  select 'MONEY-04','save_quotation_version rejects negative totals','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version'
              and pg_get_functiondef(p.oid) ilike '%negative%') then 'yes' else 'NO/OLD BODY' end,'med',''
  union all
  select 'MONEY-04','save_quotation_version has retry/label-collision handling','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='save_quotation_version'
              and (pg_get_functiondef(p.oid) ilike '%loop%' or pg_get_functiondef(p.oid) ilike '%unique_violation%'
                   or pg_get_functiondef(p.oid) ilike '%on conflict%')) then 'yes' else 'REVIEW' end,'low',
         'Retry / conflict handling on concurrent version numbering.'

  -- =====================================================================
  -- 4) OTP-01
  -- =====================================================================
  union all
  select 'OTP-01','channels.otp_dev_echo flag exists','present',
         case when exists (select 1 from public.app_config where key='channels' and value ? 'otp_dev_echo')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'OTP-01','otp_dev_echo currently false (prod-safe) in every channels row','false',
         case when exists (select 1 from public.app_config where key='channels'
                and coalesce(value->>'otp_dev_echo','true') <> 'false')
              then 'SOME TRUE' else 'false' end,'high',
         'Any org whose channels.otp_dev_echo is true would echo OTPs.'
  union all
  select 'OTP-01','every request_otp overload gates dev echo on otp_dev_echo','yes',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.proname='request_otp'
                       and pg_get_functiondef(p.oid) not ilike '%otp_dev_echo%')=0
               then 'yes' else 'AN OVERLOAD DOES NOT GATE' end,'high',''
  union all
  select 'OTP-01','no hardcoded 123456 OTP in any request_otp body','absent',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='request_otp'
              and pg_get_functiondef(p.oid) like '%123456%') then 'FOUND' else 'absent' end,'high',''
  union all
  select 'OTP-01','request_otp fail-closed when channel unavailable','yes',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='request_otp'
                      and pg_get_functiondef(p.oid) ilike '%unavailable%')>0
              then 'yes' else 'REVIEW' end,'high',''
  union all
  select 'OTP-01','request_otp retains TTL / attempt / single-use controls','yes',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='request_otp'
                      and (pg_get_functiondef(p.oid) ilike '%expires%' or pg_get_functiondef(p.oid) ilike '%attempt%'
                           or pg_get_functiondef(p.oid) ilike '%interval%'))>0
              then 'yes' else 'REVIEW' end,'med','TTL / rate / consume protections present in body.'

  -- =====================================================================
  -- 5) TOKEN-01
  -- =====================================================================
  union all
  select 'TOKEN-01','quotes.approval_token_expires_at column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quotes' and column_name='approval_token_expires_at') then 'present' else 'MISSING' end,'med',''
  union all
  select 'TOKEN-01','quotes.approval_token_revoked_at column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='quotes' and column_name='approval_token_revoked_at') then 'present' else 'MISSING' end,'med',''
  union all
  select 'TOKEN-01','revoke_approval_token() fn present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='revoke_approval_token') then 'present' else 'MISSING' end,'med',''
  union all
  select 'TOKEN-01','token consumers enforce expiry-if-set','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname in ('request_otp','public_get_proposal','verify_otp','mark_paid')
              and pg_get_functiondef(p.oid) ilike '%approval_token_expires_at is null or approval_token_expires_at > now()%')
              then 'yes' else 'REVIEW' end,'high',
         'Expiry-if-set guard present in at least one token consumer.'
  union all
  select 'TOKEN-01','revoked token rejected (revoked_at checked)','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public'
              and pg_get_functiondef(p.oid) ilike '%approval_token_revoked_at%') then 'yes' else 'REVIEW' end,'high',''

  -- =====================================================================
  -- 6) SEC-03  privileged fns org-scoped + safe
  -- =====================================================================
  union all
  select 'SEC-03','generate_approval_token org-scoped','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='generate_approval_token'
              and pg_get_functiondef(p.oid) ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end,'high',''
  union all
  select 'SEC-03','mark_paid org-scoped','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='mark_paid'
              and pg_get_functiondef(p.oid) ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end,'high',''
  union all
  select 'SEC-03','anon has NO execute on generate_approval_token','absent',
         case when exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='generate_approval_token' and grantee='anon')
              then 'STILL GRANTED' else 'absent' end,'high',''
  union all
  select 'SEC-03','anon has NO execute on mark_paid','absent',
         case when exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='mark_paid' and grantee='anon')
              then 'STILL GRANTED' else 'absent' end,'high',''
  union all
  select 'SEC-03','SECURITY DEFINER fns without explicit search_path','0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) c where c ilike 'search_path=%')),
         'high','Any SECURITY DEFINER fn without a pinned search_path is a privilege-escalation risk. See general list rows below.'

  -- =====================================================================
  -- 7 / 8 / 9  phase91 / 92 / 93
  -- =====================================================================
  union all
  select 'phase91','organizations.location column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='organizations' and column_name='location') then 'present' else 'MISSING' end,'low',''
  union all
  select 'phase92','sync_quote_to_lead fn present','present',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='sync_quote_to_lead') then 'present' else 'MISSING' end,'med',''
  union all
  select 'phase92','quotes_sync_lead_ins/upd triggers (expect 2)','2',
         (select count(*)::text from pg_trigger
            where tgname in ('quotes_sync_lead_ins','quotes_sync_lead_upd') and not tgisinternal),'med',''
  union all
  select 'phase92','no quote with client name but missing lead','0',
         (select count(*)::text from public.quotes q
            where coalesce(btrim(q.client->>'name'),'')<>''
              and not exists (select 1 from public.leads l where l.quote_id=q.id)),'med',
         'Read-only data reconciliation of quote→lead sync.'
  union all
  select 'phase93','public_get_proposal returns pricing + total','yes',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='public_get_proposal'
              and pg_get_functiondef(p.oid) ilike '%''pricing''%'
              and pg_get_functiondef(p.oid) ilike '%''total''%') then 'yes' else 'NO/OLD BODY' end,'med',''

  -- =====================================================================
  -- 10) General database security scans (counts; 0 is clean)
  -- =====================================================================
  union all
  select 'GENERAL','anon policies using unconditional true','0',
         (select count(*)::text from pg_policies
            where schemaname='public' and 'anon'=any(roles)
              and (coalesce(qual,'')='true' or coalesce(with_check,'')='true')),'high',
         'Any such policy lets anonymous callers read/write without restriction.'
  union all
  select 'GENERAL','SECURITY DEFINER fns w/o safe search_path','0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) c where c ilike 'search_path=%')),
         'high','Duplicate of SEC-03 row for the general audit; expand with the diagnostic query below.'
  union all
  select 'GENERAL','unexpected anon EXECUTE on privileged fns','0',
         (select count(*)::text from information_schema.role_routine_grants
            where routine_schema='public' and grantee='anon'
              and routine_name in ('generate_approval_token','mark_paid','record_payment',
                                    'revoke_approval_token','set_pricing_config','save_quotation_version')),
         'high',''
  union all
  select 'GENERAL','duplicate overloads on privileged fns','0',
         (select coalesce(count(*),0)::text from
            (select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public'
                 and p.proname in ('record_payment','generate_approval_token','mark_paid',
                                   'request_otp','save_quotation_version','set_pricing_config','get_pricing_config')
               group by p.proname having count(*)>1) d),'med',
         'More than one overload can expose an older insecure implementation.'
)
select area, check_name, expected, actual,
       case
         -- rows expressed as counts where 0 is good
         when check_name in (
              'no true duplicates per (org_id,key)',
              'no authenticated policy grants global cross-org access',
              'layouts with NULL org_id (should be 0)',
              'no quote with client name but missing lead',
              'anon policies using unconditional true',
              'SECURITY DEFINER fns w/o safe search_path',
              'SECURITY DEFINER fns without explicit search_path',
              'unexpected anon EXECUTE on privileged fns',
              'duplicate overloads on privileged fns')
           then case when actual='0' then 'PASS'
                     when severity='high' then 'FAIL' else 'REVIEW' end
         -- exact-match rows
         when actual = expected then 'PASS'
         -- explicit soft outcomes
         when actual = 'REVIEW' then 'REVIEW'
         -- everything else missed its expectation
         else case when severity='high' then 'FAIL' else 'REVIEW' end
       end as status,
       severity,
       notes
from checks
order by
  case when severity='high' then 0 when severity='med' then 1 when severity='low' then 2 else 3 end,
  area, check_name;

-- ============================================================================
-- OPTIONAL READ-ONLY DRILL-DOWNS (run individually only if a row is FAIL/REVIEW).
-- Each is SELECT-only. Uncomment one at a time; the Editor shows the last result.
-- ----------------------------------------------------------------------------
-- A) SECURITY DEFINER functions missing a pinned search_path:
-- select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='public' and p.prosecdef
--    and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) c where c ilike 'search_path=%')
--  order by p.proname;
--
-- B) anon policies using unconditional true:
-- select schemaname, tablename, policyname, cmd, qual, with_check
--   from pg_policies where schemaname='public' and 'anon'=any(roles)
--    and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');
--
-- C) authenticated layouts policies without an org predicate:
-- select policyname, cmd, qual, with_check from pg_policies
--  where schemaname='public' and tablename='layouts' and 'authenticated'=any(roles);
--
-- D) all overloads of the privileged functions (spot older signatures):
-- select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='public'
--    and p.proname in ('record_payment','generate_approval_token','mark_paid',
--                      'request_otp','save_quotation_version','set_pricing_config','get_pricing_config')
--  order by p.proname, args;
--
-- E) app_config layout across orgs (confirms one row per (org_id,key)):
-- select org_id, key, count(*) from public.app_config group by org_id, key order by key, org_id;
--
-- F) anon EXECUTE grants on privileged fns:
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--  where routine_schema='public' and grantee='anon'
--    and routine_name in ('generate_approval_token','mark_paid','record_payment',
--                         'revoke_approval_token','set_pricing_config','save_quotation_version');
-- ============================================================================
