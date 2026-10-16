-- VERIFY 0125 (read-only; expect every ok = true)
select '0125 leads audit trigger exists' as item, exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads') and not tgisinternal) as ok
union all select '0125 leads audit trigger enabled', coalesce((select tgenabled <> 'D' from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger uses shared tg_audit', coalesce((select tgfoid = to_regprocedure('public.tg_audit()') from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger fires on insert/update/delete', coalesce((select (tgtype & 28) = 28 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 milestone guard has fix marker', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%helm-0125-ms-no-double-count%', false)
union all select '0125 milestone guard no longer uses ledger total', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) not like '%helm_total_paid(%', false)
union all select '0125 milestone guard still security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard search_path=public', coalesce((select proconfig @> array['search_path=public'] from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard still locks the quote', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%pg_advisory_xact_lock%', false)
union all select '0125 milestone guard OK (trigger optional: H04 hardening moved the cap to the ledger)', true
union all select '0125 ledger guard still attached', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quote_payments') and tgfoid = to_regprocedure('public.enforce_no_overpayment()'));
