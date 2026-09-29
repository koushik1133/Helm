-- ============================================================================
-- HELM-STAGING-VERIFY.sql   (READ-ONLY — run in STAGING after HELM-STAGING-SCHEMA.sql)
-- ----------------------------------------------------------------------------
-- Compares the reconstructed staging schema against known-good PRODUCTION
-- values captured 2026-09-25. Emits one row per check with PASS/FAIL.
-- Changes nothing. Run this BEFORE loading any synthetic data and BEFORE WAVE-09.
--
-- NOTE: worker_respond() may still be pending (see schema file). Until you paste
-- it in, the "functions" check expects 100; after adding it, expect 101 — the
-- row tells you which so it is not a surprise.
-- ============================================================================
with checks as (
  select 'base tables (public)'::text as metric,
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r')::int as actual, 59 as expected
  union all
  select 'tables with RLS enabled',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' and c.relrowsecurity)::int, 59
  union all
  select 'tables with RLS FORCED (prod=0)',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='r' and c.relforcerowsecurity)::int, 0
  union all
  select 'RLS policies (public)',
         (select count(*) from pg_policies where schemaname='public')::int, 202
  union all
  select 'quote_otps policy count (deny-all=0)',
         (select count(*) from pg_policies where schemaname='public' and tablename='quote_otps')::int, 0
  union all
  select 'quote_otps RLS enabled',
         (select case when relrowsecurity then 1 else 0 end from pg_class where oid='public.quote_otps'::regclass), 1
  union all
  select 'event_sites policies (baseline)',
         (select count(*) from pg_policies where schemaname='public' and tablename='event_sites')::int, 4
  union all
  select 'event_sites policies on role public (pre-WAVE09)',
         (select count(*) from pg_policies where schemaname='public' and tablename='event_sites'
            and 'public' = any(roles))::int, 4
  union all
  select 'functions (public, prokind=f) [100 w/o worker_respond, 101 with]',
         (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.prokind='f')::int, 101
  union all
  select 'triggers (public, non-internal) [auth.users hook counted separately]',
         (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
            join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and not t.tgisinternal)::int, 67
  union all
  select 'auth.users -> handle_new_user hook present',
         (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
            join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='auth' and c.relname='users'
              and t.tgname='on_auth_user_created' and not t.tgisinternal)::int, 1
  union all
  select 'FK constraints (public)',
         (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace
            where n.nspname='public' and c.contype='f')::int, 146
  union all
  select 'CHECK constraints (public)',
         (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace
            where n.nspname='public' and c.contype='c')::int, 53
  union all
  select 'views (public)',
         (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind='v')::int, 1
  union all
  select 'app_config PK is (org_id,key)',
         (select case when pg_get_constraintdef(oid) = 'PRIMARY KEY (org_id, key)' then 1 else 0 end
            from pg_constraint where conname='app_config_pkey'), 1
  union all
  select 'quote_payments idempotency unique index present (phase99/D8)',
         (select count(*) from pg_indexes where schemaname='public'
            and indexname='quote_payments_idempotency_uk')::int, 1
  union all
  select 'enforce_pricing_total trigger on quotes (server pricing authority)',
         (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
            where c.oid='public.quotes'::regclass and t.tgname='quotes_enforce_pricing_total')::int, 1
  union all
  select 'profiles.must_change_password column (phase100)',
         (select count(*) from information_schema.columns
            where table_schema='public' and table_name='profiles' and column_name='must_change_password')::int, 1
  union all
  select 'ZERO business rows: quotes',
         (select count(*) from public.quotes)::int, 0
  union all
  select 'ZERO business rows: organizations',
         (select count(*) from public.organizations)::int, 0
  union all
  select 'ZERO business rows: profiles',
         (select count(*) from public.profiles)::int, 0
  union all
  select 'ZERO business rows: quote_payments',
         (select count(*) from public.quote_payments)::int, 0
  union all
  select 'ZERO business rows: quote_otps',
         (select count(*) from public.quote_otps)::int, 0
)
select metric, expected, actual,
       case when actual = expected then 'PASS' else 'FAIL — investigate' end as result
from checks
order by (actual = expected), metric;

-- FK/CHECK expected totals (146/53) are transcribed from the prod constraint export;
-- if only those two rows FAIL by a small margin, re-run the exact prod counts
-- and compare — every other row is the authoritative correctness signal.
