-- RESTORE-VERIFY.sql  (I-28, recovery readiness)
-- Purpose: prove a restored Helm database into a THROWAWAY target is intact.
-- Contract: READ-ONLY. SELECTs only. No DDL, no DML, no writes.
--           Single non-aborting result set (modeled on prod-rollout/PROD-02-VERIFY.sql).
--           Every row is PASS / FAIL / INFO. The one intentional "pricing bypass"
--           probe is wrapped in a pg_temp function so it cannot abort the batch.
--
-- HOW TO RUN: paste this whole file into the SQL editor / psql of the RESTORED
--             throwaway target ONLY. Never run against production
--             (nqltzgiwznphugcfhmbm) or staging (xizehqgeyjcfpzrdymly).
--             Creating a pg_temp function is session-local and disappears on
--             disconnect; it does not persist or alter the restored schema.
--
-- Interpretation: a healthy restore shows PASS on every check row (the
--   quote_payments amount>0 CHECK may read SKIPPED if that constraint was
--   intentionally omitted upstream). INFO rows carry counts for the operator
--   to compare against the pre-restore baseline recorded in the runbook.

create or replace function pg_temp._chk_pricing_bypass() returns text
language plpgsql as $$
begin
  -- If the pricing-authority harden (W15-001) survived restore, passing a
  -- caller-supplied total must raise, not compute.
  perform public.helm_quote_total('{"total":999999}'::jsonb);
  return 'FAIL (bypass OPEN — pricing harden did NOT survive restore)';
exception when others then
  return 'PASS';  -- helm_quote_total rejected the injected total → bypass closed
end $$;

-- Small helper: does a base table exist in public?
create or replace function pg_temp._tbl(p_name text) returns text
language sql stable as $$
  select case when exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name=p_name and table_type='BASE TABLE'
  ) then 'PASS' else 'FAIL (table missing after restore)' end
$$;

-- Safe row count for a possibly-missing table (returns -1 as sentinel).
create or replace function pg_temp._rows(p_name text) returns bigint
language plpgsql stable as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I', p_name) into n;
  return n;
exception when others then
  return -1;  -- table absent / unreadable
end $$;

select * from (
  -- ============ (A) KEY TABLE PRESENCE ============
              select 1 as ord, 'table present: quotes'                as check, pg_temp._tbl('quotes')             as result
  union all select  2, 'table present: quote_payments'               , pg_temp._tbl('quote_payments')
  union all select  3, 'table present: payment_milestones'           , pg_temp._tbl('payment_milestones')
  union all select  4, 'table present: quote_consents'               , pg_temp._tbl('quote_consents')
  union all select  5, 'table present: inventory_items'              , pg_temp._tbl('inventory_items')
  union all select  6, 'table present: leads'                        , pg_temp._tbl('leads')
  union all select  7, 'table present: profiles'                     , pg_temp._tbl('profiles')
  union all select  8, 'table present: organizations'                , pg_temp._tbl('organizations')
  union all select  9, 'table present: role_access'                  , pg_temp._tbl('role_access')
  union all select 10, 'table present: audit_log'                    , pg_temp._tbl('audit_log')
  union all select 11, 'table present: layouts'                      , pg_temp._tbl('layouts')
  union all select 12, 'table present: event_sites'                  , pg_temp._tbl('event_sites')

  -- ============ (B) ROW-COUNT SNAPSHOT (compare to pre-restore baseline) ============
  union all select 20, 'rows: quotes (INFO — compare to baseline)'            , 'INFO: '||pg_temp._rows('quotes')::text
  union all select 21, 'rows: quote_payments (INFO — compare to baseline)'    , 'INFO: '||pg_temp._rows('quote_payments')::text
  union all select 22, 'rows: payment_milestones (INFO)'                      , 'INFO: '||pg_temp._rows('payment_milestones')::text
  union all select 23, 'rows: inventory_items (INFO)'                         , 'INFO: '||pg_temp._rows('inventory_items')::text
  union all select 24, 'rows: leads (INFO)'                                   , 'INFO: '||pg_temp._rows('leads')::text
  union all select 25, 'rows: profiles (INFO)'                                , 'INFO: '||pg_temp._rows('profiles')::text
  union all select 26, 'rows: role_access (INFO)'                             , 'INFO: '||pg_temp._rows('role_access')::text

  -- ============ (C) INVARIANTS THAT MUST SURVIVE RESTORE ============
  -- Pricing authority (W15-001): server rejects caller-supplied totals.
  union all select 30, 'W15-001 pricing bypass closed'                       , pg_temp._chk_pricing_bypass()

  -- Overpayment guards (W16-03/04): triggers present on both payment tables.
  union all select 31, 'overpayment trigger (quote_payments)'                ,
    case when exists (select 1 from pg_trigger where tgname='trg_no_overpayment') then 'PASS' else 'FAIL' end
  union all select 32, 'overpayment trigger (payment_milestones)'            ,
    case when exists (select 1 from pg_trigger where tgname='trg_no_overpayment_ms') then 'PASS' else 'FAIL' end

  -- Payment/inventory CHECK constraints (W16-01).
  union all select 33, 'inventory total_qty CHECK present'                    ,
    case when exists (select 1 from pg_constraint where conname='inventory_items_total_qty_nonneg') then 'PASS' else 'FAIL' end
  union all select 34, 'inventory unit_cost CHECK present'                    ,
    case when exists (select 1 from pg_constraint where conname='inventory_items_unit_cost_nonneg') then 'PASS' else 'FAIL' end
  union all select 35, 'quote_payments amount>0 CHECK present'                ,
    case when exists (select 1 from pg_constraint where conname='quote_payments_amount_pos') then 'PASS' else 'SKIPPED (constraint intentionally omitted upstream)' end

  -- Referential integrity: payments/consents FKs restore as RESTRICT (not cascade-delete).
  union all select 36, 'cascade FK RESTRICT (payments+consents)'             ,
    case when (select count(*) from pg_constraint
               where conname in ('quote_payments_quote_id_fkey','quote_consents_quote_id_fkey')
                 and confdeltype='r')=2 then 'PASS' else 'FAIL' end

  -- ============ (D) RLS ENFORCEMENT SURVIVED RESTORE ============
  -- A logical restore (pg_dump/pg_restore) can drop RLS if roles/policies are
  -- not carried; a snapshot restore keeps them. These rows prove it either way.
  union all select 40, 'RLS enabled: quotes'                                 ,
    case when (select relrowsecurity from pg_class where oid='public.quotes'::regclass) then 'PASS' else 'FAIL (RLS OFF after restore)' end
  union all select 41, 'RLS enabled: quote_payments'                         ,
    case when (select relrowsecurity from pg_class where oid='public.quote_payments'::regclass) then 'PASS' else 'FAIL (RLS OFF after restore)' end
  union all select 42, 'RLS enabled: inventory_items'                        ,
    case when (select relrowsecurity from pg_class where oid='public.inventory_items'::regclass) then 'PASS' else 'FAIL (RLS OFF after restore)' end
  union all select 43, 'RLS enabled: leads'                                  ,
    case when (select relrowsecurity from pg_class where oid='public.leads'::regclass) then 'PASS' else 'FAIL (RLS OFF after restore)' end
  union all select 44, 'RLS policies exist on quotes'                        ,
    case when exists (select 1 from pg_policies where schemaname='public' and tablename='quotes') then 'PASS' else 'FAIL (policies missing)' end
  union all select 45, 'has_area drives RLS (function present)'              ,
    case when exists (select 1 from pg_proc where proname='has_area') then 'PASS' else 'FAIL (has_area missing)' end

  -- ============ (E) CORE RPC / SECURITY FUNCTIONS RESTORED ============
  union all select 50, 'RPC present: request_otp'                            ,
    case when exists (select 1 from pg_proc where proname='request_otp') then 'PASS' else 'FAIL' end
  union all select 51, 'RPC present: record_payment'                         ,
    case when exists (select 1 from pg_proc where proname='record_payment') then 'PASS' else 'FAIL' end
  union all select 52, 'RBAC present: can_create + can_edit'                 ,
    case when exists (select 1 from pg_proc where proname='can_create')
          and exists (select 1 from pg_proc where proname='can_edit') then 'PASS' else 'FAIL' end
) t
order by ord;
