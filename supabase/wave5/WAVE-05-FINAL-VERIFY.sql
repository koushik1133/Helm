-- ============================================================================
-- WAVE-05-FINAL-VERIFY.sql   —  100% READ ONLY.  DOES NOT MUTATE ANYTHING.
-- Columns: area | check_name | expected | actual | status | severity | notes
-- status: PASS | FAIL | REVIEW      severity: high | med | low | info
--
-- ROOT-CAUSE NOTE: pg_get_functiondef() throws 42809 ("array_agg is an aggregate
-- function") if evaluated against an aggregate/window row. Putting it in a WHERE
-- predicate lets the planner run it before the schema filter, hitting catalog
-- aggregates. So ALL function-body inspection goes through the `fns` CTE below,
-- which filters prokind='f' (normal functions only) in WHERE and computes the
-- definition in the SELECT list (projection runs after filtering) — never on an
-- aggregate. app_config is MULTI-TENANT: correct uniqueness is composite PK
-- (org_id,key); a standalone unique(key) is WRONG and this asserts it is ABSENT.
-- ============================================================================

with fns as (
  -- Safe, pre-filtered view of public NORMAL functions with their definitions.
  select p.oid,
         p.proname,
         p.prosecdef,
         p.proconfig,
         p.pronargs,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_functiondef(p.oid)                 as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'          -- exclude aggregates('a'), windows('w'), procedures('p')
),
checks as (

  -- 1) app_config integrity (multi-tenant: PK = (org_id, key)) -------------
  select 'app_config' area, 'no true duplicates per (org_id,key)' check_name, '0' expected,
         (select coalesce(count(*),0)::text from
            (select org_id, key from public.app_config group by org_id, key having count(*)>1) d) actual,
         'high' severity,
         'True duplicates impossible while composite PK exists; >0 means PK missing.' notes
  union all
  select 'app_config','composite PK (org_id,key) present','yes',
         case when exists (select 1 from pg_constraint c
           where c.conrelid='public.app_config'::regclass and c.contype='p'
             and pg_get_constraintdef(c.oid) ilike '%primary key (org_id, key)%')
         then 'yes' else 'no' end,'high','Correct uniqueness for multi-tenant app_config.'
  union all
  select 'app_config','NO standalone unique(key) constraint (must be absent)','absent',
         case when exists (select 1 from pg_constraint c
           where c.conrelid='public.app_config'::regclass and c.contype='u'
             and pg_get_constraintdef(c.oid) ilike '%unique (key)%')
         then 'PRESENT (harmful)' else 'absent' end,'high',
         'unique(key) breaks per-org config / set_pricing_config on conflict (org_id,key). phase97 drops it.'
  union all
  select 'app_config','channels rows: one per org (no per-org dup)','yes',
         case when exists (select 1 from public.app_config where key='channels'
           group by org_id, key having count(*)>1) then 'DUPLICATE PER ORG' else 'yes' end,'med',
         (select 'distinct orgs with channels row = '||count(distinct org_id)::text
            from public.app_config where key='channels')
  union all
  select 'app_config','pricing rows: one per org (no per-org dup)','yes',
         case when exists (select 1 from public.app_config where key='pricing'
           group by org_id, key having count(*)>1) then 'DUPLICATE PER ORG' else 'yes' end,'med',
         (select 'distinct orgs with pricing row = '||count(distinct org_id)::text
            from public.app_config where key='pricing')

  -- 2) SEC-01 layouts tenant isolation ------------------------------------
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
         'high','Unconditional true predicate (no org check) = cross-org leak.'
  union all
  select 'SEC-01','layouts_stamp_org trigger present','present',
         case when exists (select 1 from pg_trigger
              where tgname in ('layouts_stamp_org','_layouts_stamp_org') and not tgisinternal)
              then 'present' else 'MISSING' end,'high',''
  union all
  select 'SEC-01','stamp-org trigger FUNCTION present','present',
         case when exists (select 1 from fns where proname ~* 'stamp.*org|layouts_stamp')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'SEC-01','layouts_quarantined_count() fn present','present',
         case when exists (select 1 from fns where proname='layouts_quarantined_count')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'SEC-01','layouts with NULL org_id (should be 0)','0',
         (select count(*)::text from public.layouts where org_id is null),'high','Ownerless layouts remaining.'

  -- 3) MONEY-03/04/05 -----------------------------------------------------
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
         case when exists (select 1 from fns where proname='record_payment' and pronargs=7)
              then 'present' else 'MISSING' end,'high','Matched by arg count (names/types vary by PG).'
  union all
  select 'MONEY-03','obsolete 6-arg record_payment overload absent','absent',
         case when exists (select 1 from fns where proname='record_payment' and pronargs=6)
              then 'STILL PRESENT' else 'absent' end,'high','Older overload could bypass idempotency.'
  union all
  select 'MONEY-05','record_payment body handles idempotency','yes',
         case when exists (select 1 from fns where proname='record_payment'
              and def ilike '%idempotency%') then 'yes' else 'NO/OLD BODY' end,'high',''
  union all
  select 'MONEY-04','save_quotation_version rejects negative totals','yes',
         case when exists (select 1 from fns where proname='save_quotation_version'
              and def ilike '%negative%') then 'yes' else 'NO/OLD BODY' end,'med',''
  union all
  select 'MONEY-04','save_quotation_version has retry/collision handling','yes',
         case when exists (select 1 from fns where proname='save_quotation_version'
              and (def ilike '%loop%' or def ilike '%unique_violation%' or def ilike '%on conflict%'))
              then 'yes' else 'REVIEW' end,'low',''

  -- 4) OTP-01 -------------------------------------------------------------
  union all
  select 'OTP-01','channels.otp_dev_echo flag exists','present',
         case when exists (select 1 from public.app_config where key='channels' and value ? 'otp_dev_echo')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'OTP-01','otp_dev_echo false (prod-safe) in every channels row','false',
         case when exists (select 1 from public.app_config where key='channels'
                and coalesce(value->>'otp_dev_echo','true') <> 'false')
              then 'SOME TRUE' else 'false' end,'high','true would echo OTPs.'
  union all
  select 'OTP-01','every request_otp overload gates dev echo on otp_dev_echo','yes',
         case when (select count(*) from fns where proname='request_otp'
                     and def not ilike '%otp_dev_echo%')=0
               then 'yes' else 'AN OVERLOAD DOES NOT GATE' end,'high',''
  union all
  select 'OTP-01','no hardcoded 123456 OTP in any request_otp body','absent',
         case when exists (select 1 from fns where proname='request_otp'
              and def like '%123456%') then 'FOUND' else 'absent' end,'high',''
  union all
  select 'OTP-01','request_otp fail-closed when channel unavailable','yes',
         case when (select count(*) from fns where proname='request_otp'
                    and def ilike '%unavailable%')>0
              then 'yes' else 'REVIEW' end,'high',''
  union all
  select 'OTP-01','request_otp retains TTL/attempt/single-use controls','yes',
         case when (select count(*) from fns where proname='request_otp'
                    and (def ilike '%expires%' or def ilike '%attempt%' or def ilike '%interval%'))>0
              then 'yes' else 'REVIEW' end,'med',''

  -- 5) TOKEN-01 -----------------------------------------------------------
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
         case when exists (select 1 from fns where proname='revoke_approval_token')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'TOKEN-01','token consumers enforce expiry-if-set','yes',
         case when exists (select 1 from fns
              where proname in ('request_otp','public_get_proposal','verify_otp','mark_paid')
              and def ilike '%approval_token_expires_at is null or approval_token_expires_at > now()%')
              then 'yes' else 'REVIEW' end,'high',''
  union all
  select 'TOKEN-01','revoked token rejected (revoked_at checked)','yes',
         case when exists (select 1 from fns where def ilike '%approval_token_revoked_at%')
              then 'yes' else 'REVIEW' end,'high',''

  -- 6) SEC-03 -------------------------------------------------------------
  union all
  select 'SEC-03','generate_approval_token org-scoped','yes',
         case when exists (select 1 from fns where proname='generate_approval_token'
              and def ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end,'high',''
  union all
  select 'SEC-03','mark_paid org-scoped','yes',
         case when exists (select 1 from fns where proname='mark_paid'
              and def ilike '%assert_quote_org%') then 'yes' else 'NO/OLD BODY' end,'high',''
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
  select 'SEC-03','anon has NO execute on set_pricing_config','absent',
         case when exists (select 1 from information_schema.role_routine_grants
              where routine_schema='public' and routine_name='set_pricing_config' and grantee='anon')
              then 'STILL GRANTED' else 'absent' end,'high','Config-writing fn; anon must not execute. Revoked in this session.'
  union all
  select 'SEC-03','SECURITY DEFINER fns without explicit search_path','0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) c where c ilike 'search_path=%')),
         'high','No pinned search_path = privilege-escalation risk.'

  -- 7/8/9) phase91/92/93 --------------------------------------------------
  union all
  select 'phase91','organizations.location column','present',
         case when exists (select 1 from information_schema.columns where table_schema='public'
              and table_name='organizations' and column_name='location') then 'present' else 'MISSING' end,'low',''
  union all
  select 'phase92','sync_quote_to_lead fn present','present',
         case when exists (select 1 from fns where proname='sync_quote_to_lead')
              then 'present' else 'MISSING' end,'med',''
  union all
  select 'phase92','quotes_sync_lead_ins/upd triggers (expect 2)','2',
         (select count(*)::text from pg_trigger
            where tgname in ('quotes_sync_lead_ins','quotes_sync_lead_upd') and not tgisinternal),'med',''
  union all
  select 'phase92','no quote with client name but missing lead','0',
         (select count(*)::text from public.quotes q
            where coalesce(btrim(q.client->>'name'),'')<>''
              and not exists (select 1 from public.leads l where l.quote_id=q.id)),'med',''
  union all
  select 'phase93','public_get_proposal returns pricing + total','yes',
         case when exists (select 1 from fns where proname='public_get_proposal'
              and def ilike '%''pricing''%' and def ilike '%''total''%')
              then 'yes' else 'NO/OLD BODY' end,'med',''

  -- 10) General security scans (0 = clean) --------------------------------
  union all
  select 'GENERAL','anon policies using unconditional true','0',
         (select count(*)::text from pg_policies
            where schemaname='public' and 'anon'=any(roles)
              and (coalesce(qual,'')='true' or coalesce(with_check,'')='true')),'high',''
  union all
  select 'GENERAL','SECURITY DEFINER fns w/o safe search_path','0',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.prosecdef
              and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) c where c ilike 'search_path=%')),
         'high','Expand with drill-down A below.'
  union all
  select 'GENERAL','unexpected anon EXECUTE on privileged fns','0',
         (select count(*)::text from information_schema.role_routine_grants
            where routine_schema='public' and grantee='anon'
              and routine_name in ('generate_approval_token','mark_paid','record_payment',
                                    'revoke_approval_token','set_pricing_config','save_quotation_version')),'high',''
  union all
  select 'GENERAL','duplicate overloads on privileged fns','0',
         (select coalesce(count(*),0)::text from
            (select proname from fns
               where proname in ('record_payment','generate_approval_token','mark_paid',
                                 'request_otp','save_quotation_version','set_pricing_config','get_pricing_config')
               group by proname having count(*)>1) d),'med',''
)
select area, check_name, expected, actual,
       case
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
           then case when actual='0' then 'PASS' when severity='high' then 'FAIL' else 'REVIEW' end
         when actual = expected then 'PASS'
         when actual = 'REVIEW' then 'REVIEW'
         else case when severity='high' then 'FAIL' else 'REVIEW' end
       end as status,
       severity, notes
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
-- B) anon policies using unconditional true:
-- select schemaname, tablename, policyname, cmd, qual, with_check
--   from pg_policies where schemaname='public' and 'anon'=any(roles)
--    and (coalesce(qual,'')='true' or coalesce(with_check,'')='true');
-- C) authenticated layouts policies (inspect qual/with_check for org predicate):
-- select policyname, cmd, qual, with_check from pg_policies
--  where schemaname='public' and tablename='layouts' and 'authenticated'=any(roles);
-- D) all overloads of the privileged functions (normal functions only):
-- select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef, p.proconfig
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='public' and p.prokind='f'
--    and p.proname in ('record_payment','generate_approval_token','mark_paid',
--                      'request_otp','save_quotation_version','set_pricing_config','get_pricing_config')
--  order by p.proname, args;
-- E) app_config layout across orgs (confirms one row per (org_id,key)):
-- select org_id, key, count(*) from public.app_config group by org_id, key order by key, org_id;
-- F) anon EXECUTE grants on privileged fns:
-- select routine_name, grantee, privilege_type from information_schema.role_routine_grants
--  where routine_schema='public' and grantee='anon'
--    and routine_name in ('generate_approval_token','mark_paid','record_payment',
--                         'revoke_approval_token','set_pricing_config','save_quotation_version');
-- ============================================================================
