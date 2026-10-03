-- payment-matrix.sql — all money-increasing paths share ONE per-quote serialization
-- boundary and keep total_paid<=quote_total. Structural invariants (behavioral
-- genuine-overlap is proven by concurrency-overpay.sh). Requires 0003.
set client_min_messages = warning;
drop table if exists _pm; create temp table _pm(name text, result text);
-- 1) the overpayment trigger guards BOTH ledger tables (shared boundary)
insert into _pm select 'enforce_no_overpayment on quote_payments',
  case when exists(select 1 from pg_trigger where tgname='trg_no_overpayment' and tgrelid='public.quote_payments'::regclass) then 'PASS' else 'FAIL' end;
insert into _pm select 'enforce_no_overpayment on payment_milestones',
  case when exists(select 1 from pg_trigger where tgname='trg_no_overpayment_ms' and tgrelid='public.payment_milestones'::regclass) then 'PASS' else 'FAIL' end;
-- 2) both guard functions take the SAME per-quote advisory lock key
insert into _pm select 'shared advisory-lock key (quote_payments path)',
  case when pg_get_functiondef('public.enforce_no_overpayment()'::regprocedure) ilike '%helm:pay:quote:%' then 'PASS' else 'FAIL' end;
insert into _pm select 'shared advisory-lock key (milestone path)',
  case when pg_get_functiondef('public.enforce_no_overpayment_ms()'::regprocedure) ilike '%helm:pay:quote:%' then 'PASS' else 'FAIL' end;
-- 3) every money-increasing RPC funnels through the ledger tables (so it inherits the boundary)
insert into _pm select 'record_payment writes quote_payments',
  case when pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_payment' limit 1)) ilike '%quote_payments%' then 'PASS' else 'FAIL' end;
insert into _pm select 'record_settlement_payment writes quote_payments',
  case when pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='record_settlement_payment' limit 1)) ilike '%quote_payments%' then 'PASS' else 'FAIL' end;
insert into _pm select 'mark_paid writes quote_payments',
  case when pg_get_functiondef('public.mark_paid(uuid,text)'::regprocedure) ilike '%quote_payments%' then 'PASS' else 'FAIL' end;
-- 4) helm_total_paid is ledger-only (no milestone double-count)
insert into _pm select 'helm_total_paid is ledger-only',
  case when pg_get_functiondef('public.helm_total_paid(uuid,uuid,uuid)'::regprocedure) not ilike '%payment_milestones%' then 'PASS' else 'FAIL' end;
-- 5) idempotency unique key on quote_payments (no duplicate receipt/effect)
insert into _pm select 'quote_payments idempotency unique index',
  case when exists(select 1 from pg_indexes where tablename='quote_payments' and indexdef ilike '%idempotency%') then 'PASS' else 'FAIL' end;
select name,result from _pm order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'PAYMENT-MATRIX: ALL PASS ('||count(*)||' invariants)' else 'PAYMENT-MATRIX: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _pm;
