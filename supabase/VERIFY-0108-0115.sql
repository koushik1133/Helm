-- VERIFY-0108-0115.sql - READ ONLY. Paste into the Supabase SQL editor (prod and/or staging). Changes nothing.
-- Every row's ok must be true.
select '0108 dashboard_money exists' as item, to_regprocedure('public.dashboard_money(integer)') is not null as ok
union all select '0109 user_dashboard_prefs table', to_regclass('public.user_dashboard_prefs') is not null
union all select '0109 row level security on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.user_dashboard_prefs')), false)
union all select '0109 my_dashboard_prefs()', to_regprocedure('public.my_dashboard_prefs()') is not null
union all select '0109 anon cannot read prefs', to_regclass('public.user_dashboard_prefs') is not null and not has_table_privilege('anon', 'public.user_dashboard_prefs', 'select')
union all select '0110 helm_invoice_total exists', to_regprocedure('public.helm_invoice_total(uuid)') is not null
union all select '0110 studio users cannot call helm_invoice_total', to_regprocedure('public.helm_invoice_total(uuid)') is not null and not has_function_privilege('authenticated', 'public.helm_invoice_total(uuid)', 'execute')
union all select '0110 payment guard uses invoice total', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment()')) like '%helm_invoice_total%', false)
union all select '0110 milestone guard uses invoice total', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%helm_invoice_total%', false)
union all select '0110 close gate uses invoice total', coalesce(pg_get_functiondef(to_regprocedure('public._a49_close_blockers(uuid)')) like '%helm_invoice_total%', false)
union all select '0110 overpayment trigger present', exists (select 1 from pg_trigger where tgname = 'trg_no_overpayment' and tgrelid = to_regclass('public.quote_payments'))
union all select '0111 booklet total incl changes', coalesce(pg_get_functiondef(to_regprocedure('public._bk_payments(uuid, uuid, jsonb)')) like '%invoice-total-0111%', false)
union all select '0112 confirmed_at stamp trigger', exists (select 1 from pg_trigger where tgname = 'zz_quotes_stamp_confirmed_at' and tgrelid = to_regclass('public.quotes'))
union all select '0113 insights_events_ex_tax exists', to_regprocedure('public.insights_events_ex_tax(date, date)') is not null
union all select '0113 anon cannot run insights ex-tax', to_regprocedure('public.insights_events_ex_tax(date, date)') is not null and not has_function_privilege('anon', 'public.insights_events_ex_tax(date, date)', 'execute')
union all select '0114 booklet lists change lines', coalesce(pg_get_functiondef(to_regprocedure('public._bk_payments(uuid, uuid, jsonb)')) like '%change-lines-0114%', false)
union all select '0114 anon can still open booklets', to_regprocedure('public.public_get_booklet(uuid)') is not null and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
union all select '0115 reworked tasks re-queue', coalesce(pg_get_functiondef(to_regprocedure('public.tg_task_verify()')) like '%task-requeue-0115%', false)
union all select '0115 task verify trigger attached', exists (select 1 from pg_trigger where tgname = 'task_verify_trg' and tgrelid = to_regclass('public.event_tasks') and not tgisinternal);
