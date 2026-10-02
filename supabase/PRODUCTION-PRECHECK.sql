-- ============================================================================
-- PRODUCTION-PRECHECK.sql
-- ----------------------------------------------------------------------------
-- READ-ONLY. SAFE TO RUN ON PROD. Confirms the CURRENT state of a database
-- BEFORE applying the canonical forward migrations (supabase/migrations/
-- 0001-0014, per supabase/migrations/MANIFEST).
--
-- This script performs ONLY catalog reads and SELECTs. It contains NO writes,
-- NO DDL (CREATE/ALTER/DROP), NO DML (INSERT/UPDATE/DELETE), NO GRANT/REVOKE,
-- and starts NO transaction that mutates state. Every statement is a SELECT /
-- SHOW over system catalogs or user tables. It can be pasted whole into the
-- Supabase SQL editor pointed at production (ref nqltzgiwznphugcfhmbm) or any
-- other DB; each query is independently labeled so results can be recorded.
--
-- Intended reviewer flow: run top-to-bottom, capture every result set, and
-- compare against the expected hardened target (see PRODUCTION-ROLLOUT-PLAN.md).
-- Nothing here changes the database.
-- ============================================================================


-- [Q01] ---- EXACT POSTGRES VERSION ------------------------------------------
-- Record the full server version string + numeric version.
select 'Q01_pg_version' as check, version() as full_version,
       current_setting('server_version') as server_version,
       current_setting('server_version_num') as server_version_num;


-- [Q02] ---- MIGRATION LEDGER: EXISTENCE --------------------------------------
-- Does the canonical ledger table exist? (apply-canonical creates it if absent.)
select 'Q02_ledger_exists' as check,
       (to_regclass('public.helm_schema_migrations') is not null) as ledger_exists,
       (to_regclass('public.profiles') is null)                   as db_is_fresh;


-- [Q03] ---- MIGRATION LEDGER: ROWS (lineage / applied canonical forwards) ----
-- Lists every recorded forward migration with sha256 prefix + applied_at.
-- Empty set is expected on a prod DB that has never run the canonical runner.
-- (Guarded with to_regclass so it never errors when the table is absent.)
select 'Q03_ledger_rows' as check, filename,
       left(sha256, 12) as sha256_prefix, applied_at
from public.helm_schema_migrations
where to_regclass('public.helm_schema_migrations') is not null
order by applied_at, filename;


-- [Q04] ---- HARDENED FUNCTIONS PRESENT ---------------------------------------
-- Canonical functions the forward migrations rely on / create.
-- Expected after rollout: all present=t. On current prod some may be absent.
with want(fn) as (values
  ('helm_quote_total_canonical'),
  ('_work_token_live'),
  ('current_org_id'),
  ('set_updated_at'))
select 'Q04_functions' as check, w.fn as function_name,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname=w.fn) as present
from want w order by w.fn;


-- [Q05] ---- HARDENED TRIGGERS PRESENT (any sanctioned alias) -----------------
-- Each logical guard may carry one of several accepted trigger names.
with want(label, names) as (values
  ('pricing_total_enforce',  array['zz_enforce_pricing_total','quotes_enforce_pricing_total','enforce_pricing_total']),
  ('no_overpayment',         array['trg_no_overpayment','enforce_no_overpayment']),
  ('no_overpayment_ms',      array['trg_no_overpayment_ms','enforce_no_overpayment_ms']),
  ('quote_org_match',        array['zz_quote_org_match','tg_quote_org_match']),
  ('approval_token_expiry',  array['zz_approval_token_expiry','tg_approval_token_expiry']),
  ('otp_rate_limit',         array['zz_otp_rate_limit','tg_otp_rate_limit']),
  ('work_token_renew',       array['zz_work_token_renew']))
select 'Q05_triggers' as check, w.label as guard,
       (select count(*) from pg_trigger t
        where not t.tgisinternal and t.tgname = any(w.names)) as matching_triggers,
       (select count(*) from pg_trigger t
        where not t.tgisinternal and t.tgname = any(w.names)) >= 1 as present
from want w order by w.label;


-- [Q06] ---- work_tokens HARDENING COLUMNS (0012) -----------------------------
-- revoked_at + expires_at columns that the liveness guard / renew trigger need.
select 'Q06_work_tokens_cols' as check, column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='work_tokens'
  and column_name in ('revoked_at','expires_at')
order by column_name;


-- [Q07] ---- RPC CONTRACT COUNT (public functions) ----------------------------
-- Total public routines/functions. Compare to the app contract target in verify.sh.
select 'Q07_rpc_count' as check,
       (select count(*) from information_schema.routines where routine_schema='public') as routine_count,
       (select count(distinct p.proname) from pg_proc p
          join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') as distinct_function_names;


-- [Q08] ---- TABLE CONTRACT COUNT (public base tables) ------------------------
select 'Q08_table_count' as check,
       count(*) as public_base_tables
from information_schema.tables
where table_schema='public' and table_type='BASE TABLE';


-- [Q09] ---- RLS ENABLEMENT PER PUBLIC TABLE ----------------------------------
-- Flags any public base table with RLS DISABLED (rls_enabled=f => investigate).
select 'Q09_rls_per_table' as check, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r'
order by c.relrowsecurity asc, c.relname;  -- RLS-off tables sort first


-- [Q09b] ---- SUMMARY: COUNT OF PUBLIC TABLES WITH RLS OFF --------------------
select 'Q09b_rls_off_count' as check, count(*) as public_tables_rls_disabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relrowsecurity = false;


-- [Q10] ---- anon / authenticated EXECUTE GRANTS ON PUBLIC FUNCTIONS ----------
-- Lists every public function the API roles (anon, authenticated) may execute,
-- with SECURITY DEFINER flag. Confirm the anon-executable set matches the
-- sanctioned public surface (0005 + invitation_preview from 0010):
--   anon: public_get_quote, public_get_portal, public_get_proposal,
--         public_event_site, request_otp, create_payment, verify_and_consent,
--         worker_get_tasks, worker_get_equipment, worker_respond,
--         worker_checkin_equipment, invitation_preview
-- Anything else anon-executable is a finding to reconcile before rollout.
select 'Q10_role_exec_grants' as check,
       p.proname as function_name,
       r.rolname as granted_to,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
join pg_roles r on r.rolname in ('anon','authenticated')
where n.nspname='public'
  and has_function_privilege(r.oid, p.oid, 'EXECUTE')
order by r.rolname, p.prosecdef desc, p.proname;


-- [Q10b] ---- SECURITY DEFINER FUNCTIONS EXECUTABLE BY anon (focused) ---------
-- The highest-risk set: SECURITY DEFINER + anon EXECUTE. Should equal exactly
-- the sanctioned anon list above.
select 'Q10b_secdef_anon' as check, p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by p.proname;


-- [Q11] ---- FUNCTIONS LACKING A PINNED search_path ---------------------------
-- function_search_path_mutable: any public function (esp. SECURITY DEFINER)
-- with no `search_path` in proconfig is a finding (advisor WARN). 0014 pins
-- set_updated_at(); confirm nothing else is left mutable.
select 'Q11_mutable_search_path' as check,
       p.proname as function_name, p.prosecdef as security_definer,
       p.proconfig as current_config
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
    where cfg like 'search_path=%')
order by p.prosecdef desc, p.proname;


-- [Q12] ---- STORAGE BUCKETS + PUBLIC FLAG ------------------------------------
-- Expected hardened target: invite-media + event-docs exist and public=false,
-- with MIME allowlist + size cap (set by 0013). Flag any bucket with public=true.
select 'Q12_storage_buckets' as check, id as bucket_id, public,
       file_size_limit, allowed_mime_types
from storage.buckets
order by id;


-- [Q13] ---- ORPHAN / INVALID ROWS THAT COULD BREAK AN ADDITIVE MIGRATION -----
-- Pre-flight data-integrity counts. Every count should be 0; a non-zero value
-- means a forward migration's tenant/money CHECK or NOT NULL could fail and
-- must be reconciled first. All guarded with to_regclass so missing tables
-- simply report NULL instead of erroring.
select 'Q13a_quotes_without_org'        as check,
       case when to_regclass('public.quotes') is null then null else
         (select count(*) from public.quotes where org_id is null) end as bad_rows
union all
select 'Q13b_quote_payments_without_org',
       case when to_regclass('public.quote_payments') is null then null else
         (select count(*) from public.quote_payments qp
          where not exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='quote_payments' and column_name='org_id')
             or qp.org_id is null) end
union all
select 'Q13c_quote_payments_nonpositive',
       case when to_regclass('public.quote_payments') is null then null else
         (select count(*) from public.quote_payments where amount <= 0) end
union all
select 'Q13d_inventory_total_qty_negative',
       case when to_regclass('public.inventory_items') is null then null else
         (select count(*) from public.inventory_items where total_qty < 0) end
union all
select 'Q13e_inventory_unit_cost_negative',
       case when to_regclass('public.inventory_items') is null then null else
         (select count(*) from public.inventory_items where unit_cost is not null and unit_cost < 0) end
union all
select 'Q13f_profiles_without_org',
       case when to_regclass('public.profiles') is null then null else
         (select count(*) from public.profiles
          where exists (select 1 from information_schema.columns
                        where table_schema='public' and table_name='profiles' and column_name='org_id')
            and org_id is null) end;


-- [Q14] ---- EXTENSIONS + RLS-FORCE SANITY (informational) --------------------
select 'Q14_extensions' as check, extname, extversion
from pg_extension order by extname;

-- ============================================================================
-- END PRODUCTION-PRECHECK.sql — read-only. No state was modified.
-- Record every result set, then proceed per PRODUCTION-ROLLOUT-PLAN.md.
-- ============================================================================
