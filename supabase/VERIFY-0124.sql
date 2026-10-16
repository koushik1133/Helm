-- VERIFY 0124 (read-only; expect every ok = true)
select '0124 vendor_bills table exists' as item, to_regclass('public.vendor_bills') is not null as ok
union all select '0124 vendor_payouts table exists', to_regclass('public.vendor_payouts') is not null
union all select '0124 RLS forced on vendor_bills', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_bills')), false)
union all select '0124 RLS forced on vendor_payouts', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_payouts')), false)
union all select '0124 no delete policy on bills or payouts', not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('vendor_bills', 'vendor_payouts') and cmd in ('DELETE', 'ALL'))
union all select '0124 users cannot delete bills', not has_table_privilege('authenticated', 'public.vendor_bills', 'delete')
union all select '0124 users cannot write payouts directly', not has_table_privilege('authenticated', 'public.vendor_payouts', 'insert') and not has_table_privilege('authenticated', 'public.vendor_payouts', 'delete')
union all select '0124 bills need finance area', coalesce((select bool_and(coalesce(qual, with_check) like '%has_area%finance%') from pg_policies where schemaname = 'public' and tablename = 'vendor_bills'), false)
union all select '0124 record_vendor_payout exists', to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)') is not null
union all select '0124 payout refuses overpayment', coalesce(pg_get_functiondef(to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)')) like '%overpay%', false)
union all select '0124 payout idempotency index', to_regclass('public.ux_vendor_payouts_idem') is not null
union all select '0124 event_pnl exists', to_regprocedure('public.event_pnl(uuid)') is not null
union all select '0124 vendor_payables_summary exists', to_regprocedure('public.vendor_payables_summary()') is not null
union all select '0124 business_pnl exists', to_regprocedure('public.business_pnl(date, date)') is not null
union all select '0124 anon may NOT run event_pnl', not has_function_privilege('anon', 'public.event_pnl(uuid)', 'execute')
union all select '0124 helper is private', not has_function_privilege('authenticated', 'public._vb_event_pnl(uuid, uuid)', 'execute')
union all select '0124 bill guard trigger', exists (select 1 from pg_trigger where tgname = 'vendor_bills_guard' and tgrelid = to_regclass('public.vendor_bills'))
union all select '0124 payouts immutable trigger', exists (select 1 from pg_trigger where tgname = 'vendor_payouts_immutable' and tgrelid = to_regclass('public.vendor_payouts'));
