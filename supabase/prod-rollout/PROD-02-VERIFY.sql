-- PROD-02-VERIFY — run AFTER PROD-01. Every row should read PASS.
select 'W15-001 unshaped total rejected' as check,
  case when (select public.helm_quote_total('{"total":999999}'::jsonb)) is not null then 'FAIL' else 'PASS' end as result
-- (the call above should ERROR 22023; if it returns a number, the harden did not apply)
;
select 'W16 checks present' as check, case when count(*)=3 then 'PASS' else 'FAIL ('||count(*)||'/3)' end
  from pg_constraint where conname in ('inventory_items_total_qty_nonneg','inventory_items_unit_cost_nonneg','quote_payments_amount_pos')
union all select 'overpayment trigger present', case when count(*)=1 then 'PASS' else 'FAIL' end from pg_trigger where tgname='trg_no_overpayment'
union all select 'overpayment trigger on milestones', case when count(*)=1 then 'PASS' else 'FAIL' end from pg_trigger where tgname='trg_no_overpayment_ms'
union all select 'cascade FK RESTRICT (payments+consents)', case when count(*)=2 then 'PASS' else 'FAIL' end
  from pg_constraint where conname in ('quote_payments_quote_id_fkey','quote_consents_quote_id_fkey') and confdeltype='r'
union all select 'OTP CSPRNG (request_otp uses gen_random_bytes)', case when pg_get_functiondef((select oid from pg_proc where proname='request_otp' limit 1)) ilike '%gen_random_bytes%' then 'PASS' else 'FAIL' end
union all select 'manager authority (can_create+can_edit)', case when pg_get_functiondef((select oid from pg_proc where proname='can_create' limit 1)) ilike '%manager%' and pg_get_functiondef((select oid from pg_proc where proname='can_edit' limit 1)) ilike '%manager%' then 'PASS' else 'FAIL' end;
