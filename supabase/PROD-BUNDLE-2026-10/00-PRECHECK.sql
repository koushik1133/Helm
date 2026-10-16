-- 00-PRECHECK.sql - READ ONLY. Changes nothing. Paste into the Supabase SQL editor on PROD.
-- ok = true  -> that migration is ALREADY on this database (skip its APPLY).
-- ok = false -> run that migration's APPLY file (see README order).
-- Expected on PROD today: 0108-0115 rows true (believed), 0116-0125 rows false, 0117 false (not run - correct).
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
union all select '0115 task verify trigger attached', exists (select 1 from pg_trigger where tgname = 'task_verify_trg' and tgrelid = to_regclass('public.event_tasks') and not tgisinternal)
union all select '0116 organizations.trial_ends_at column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='organizations' and column_name='trial_ends_at')
union all select '0116 start_trial() exists', to_regprocedure('public.start_trial()') is not null
union all select '0116 my_trial_org() exists', to_regprocedure('public.my_trial_org()') is not null
union all select '0116 read-only guard knows ended trials', coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%_trial_locked%', false)
union all select '0117 (DO NOT RUN YET) org_payment_accounts table', to_regclass('public.org_payment_accounts') is not null
union all select '0118 start_trial(text,text) exists', to_regprocedure('public.start_trial(text,text)') is not null
union all select '0119 helm_billing_settings.trial_days column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='helm_billing_settings' and column_name='trial_days')
union all select '0119 _trial_days() + start_self_serve_trial exist', to_regprocedure('public._trial_days()') is not null and to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is not null
union all select '0119 my_start_trial reads _trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) like '%_trial_days()%', false)
union all select '0120 trial_reminders table', to_regclass('public.trial_reminders') is not null
union all select '0120 trial_reminders_tick() exists', to_regprocedure('public.trial_reminders_tick()') is not null
union all select '0121 dashboard_due_today() exists', to_regprocedure('public.dashboard_due_today()') is not null
union all select '0122 archive_lead records lead studio', coalesce(pg_get_functiondef(to_regprocedure('public.archive_lead()')) like '%r.org_id%', false)
union all select '0122 seed function uses studio currency', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%0122%', false)
union all select '0123 my_demo_status returns counts', coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%trial-start-fresh-0123%', false)
union all select '0124 vendor_bills + vendor_payouts tables', to_regclass('public.vendor_bills') is not null and to_regclass('public.vendor_payouts') is not null
union all select '0124 event_pnl / business_pnl exist', to_regprocedure('public.event_pnl(uuid)') is not null and to_regprocedure('public.business_pnl(date,date)') is not null
union all select '0125 leads audit trigger', exists (select 1 from pg_trigger where tgname='audit_trg' and tgrelid=to_regclass('public.leads') and not tgisinternal)
union all select '0125 milestone guard fix marker', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%helm-0125-ms-no-double-count%', false)
-- prerequisites the bundle's own guards also check (must be TRUE before 0116):
union all select 'PREREQ create_studio(text,text,text,text)', to_regprocedure('public.create_studio(text,text,text,text)') is not null
union all select 'PREREQ _demo_seed(uuid) (0097/0100)', to_regprocedure('public._demo_seed(uuid)') is not null
union all select 'PREREQ studio_subscriptions (0045)', to_regclass('public.studio_subscriptions') is not null
union all select 'PREREQ my_start_trial + my_trial_status (0056/0058)', to_regprocedure('public.my_start_trial(text,text)') is not null and to_regprocedure('public.my_trial_status()') is not null
union all select 'PREREQ _trial_refresh (0058)', to_regprocedure('public._trial_refresh()') is not null
union all select 'PREREQ _security_alert_safe (0054)', to_regprocedure('public._security_alert_safe(uuid,text,text,uuid,jsonb)') is not null
union all select 'PREREQ organizations.trial_mode (0097)', exists (select 1 from information_schema.columns where table_schema='public' and table_name='organizations' and column_name='trial_mode')
union all select 'PREREQ notifications.org_id', exists (select 1 from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='org_id')
union all select 'PREREQ _r101_quote_tax (0101, needed by 0124)', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_r101_quote_tax')
union all select 'PREREQ tg_audit() (0042, needed by 0125)', to_regprocedure('public.tg_audit()') is not null
union all select 'PREREQ helm_invoice_total (0110, needed by 0125)', to_regprocedure('public.helm_invoice_total(uuid)') is not null;
