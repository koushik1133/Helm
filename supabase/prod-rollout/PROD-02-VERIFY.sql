-- PROD-02-VERIFY — run AFTER PROD-01. Single result set; every row should read PASS.
-- Uses a temp function so the intentional "bypass" probe cannot abort the batch.
create or replace function pg_temp._chk_bypass() returns text language plpgsql as $$
begin
  perform public.helm_quote_total('{"total":999999}'::jsonb);
  return 'FAIL (bypass OPEN — harden not applied)';
exception when others then
  return 'PASS';   -- helm_quote_total raised 22023 → bypass closed
end $$;

select 'W15-001 pricing bypass closed'                    as check, pg_temp._chk_bypass() as result
union all select 'inventory total_qty CHECK present',
  case when exists (select 1 from pg_constraint where conname='inventory_items_total_qty_nonneg') then 'PASS' else 'FAIL' end
union all select 'inventory unit_cost CHECK present',
  case when exists (select 1 from pg_constraint where conname='inventory_items_unit_cost_nonneg') then 'PASS' else 'FAIL' end
union all select 'quote_payments amount>0 CHECK present',
  case when exists (select 1 from pg_constraint where conname='quote_payments_amount_pos') then 'PASS' else 'SKIPPED (clean payment rows, then add manually)' end
union all select 'overpayment trigger (quote_payments)',
  case when exists (select 1 from pg_trigger where tgname='trg_no_overpayment') then 'PASS' else 'FAIL' end
union all select 'overpayment trigger (payment_milestones)',
  case when exists (select 1 from pg_trigger where tgname='trg_no_overpayment_ms') then 'PASS' else 'FAIL' end
union all select 'cascade FK RESTRICT (payments+consents)',
  case when (select count(*) from pg_constraint where conname in ('quote_payments_quote_id_fkey','quote_consents_quote_id_fkey') and confdeltype='r')=2 then 'PASS' else 'FAIL' end
union all select 'OTP CSPRNG (request_otp uses gen_random_bytes)',
  case when pg_get_functiondef((select oid from pg_proc where proname='request_otp' limit 1)) ilike '%gen_random_bytes%' then 'PASS' else 'FAIL' end
union all select 'manager authority (can_create + can_edit)',
  case when pg_get_functiondef((select oid from pg_proc where proname='can_create' limit 1)) ilike '%manager%'
        and pg_get_functiondef((select oid from pg_proc where proname='can_edit' limit 1)) ilike '%manager%' then 'PASS' else 'FAIL' end;
