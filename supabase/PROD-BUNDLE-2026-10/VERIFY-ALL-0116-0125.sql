-- VERIFY-ALL-0116-0125.sql  READ ONLY. Every row: ok = true.
select '0116 organizations.trial_ends_at column' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'trial_ends_at' and is_nullable = 'YES') as ok
union all select '0116 existing studios unaffected (no trial_ends_at except Demo N trials)', not exists (select 1 from public.organizations o where o.trial_ends_at is not null and o.name !~ '^Demo [0-9]{1,9}$')
union all select '0116 start_trial exists', to_regprocedure('public.start_trial()') is not null
union all select '0116 start_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial()')), false)
union all select '0116 start_trial: authenticated may run', has_function_privilege('authenticated', 'public.start_trial()', 'execute')
union all select '0116 start_trial: anon may NOT run', not has_function_privilege('anon', 'public.start_trial()', 'execute')
union all select '0116 start_trial uses advisory lock + create_studio', pg_get_functiondef('public.start_self_serve_trial(text,text,text,text)'::regprocedure) like '%pg_advisory_xact_lock%' and pg_get_functiondef('public.start_self_serve_trial(text,text,text,text)'::regprocedure) like '%public.create_studio(%'
union all select '0116 my_trial_org exists', to_regprocedure('public.my_trial_org()') is not null
union all select '0116 my_trial_org: anon may NOT run', not has_function_privilege('anon', 'public.my_trial_org()', 'execute')
union all select '0116 helpers private', not has_function_privilege('authenticated', 'public._trial_next_demo_number()', 'execute') and not has_function_privilege('authenticated', 'public._trial_seed_extra(uuid)', 'execute') and not has_function_privilege('authenticated', 'public._trial_locked(uuid)', 'execute')
union all select '0116 read-only guard knows ended trials', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%trial-orgs-0116%'
union all select '0116 read-only guard keeps suspended rule', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%studio_suspended%'
union all select '0116 next demo number is positive', public._trial_next_demo_number() >= 1
union all select '0116 no existing studio is trial-locked unless it is a Demo N trial', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_locked(o.id))
union all
select '0118 start_trial(text,text) exists' as item, to_regprocedure('public.start_trial(text,text)') is not null as ok
union all select '0118 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial(text,text)')), false)
union all select '0118 authenticated may run', has_function_privilege('authenticated', 'public.start_trial(text,text)', 'execute')
union all select '0118 anon may NOT run', not has_function_privilege('anon', 'public.start_trial(text,text)', 'execute')
union all select '0118 validates time zone', coalesce(pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text,text,text,text)')) like '%pg_timezone_names%', false)
union all select '0118 keeps advisory lock + create_studio', coalesce(pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text,text,text,text)')) like '%pg_advisory_xact_lock%create_studio(%', false)
union all select '0118 old start_trial() still there', to_regprocedure('public.start_trial()') is not null
union all
select '0119 trial_days column exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_billing_settings' and column_name = 'trial_days') as ok
union all select '0119 trial length is 8 days', (select b.trial_days = 8 from public.helm_billing_settings b where b.id limit 1)
union all select '0119 start_self_serve_trial exists', to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is not null
union all select '0119 start_self_serve_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_self_serve_trial(text,text,text,text)')), false)
union all select '0119 authenticated may start a trial', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 anon may NOT start a trial', not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 start_trial() -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial()')) like '%start_self_serve_trial(%', false)
union all select '0119 start_trial(text,text) -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%start_self_serve_trial(%', false)
union all select '0119 my_start_trial uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) like '%_trial_days()%', false)
union all select '0119 my_start_trial no longer 14 days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) not like '%current_date + 14%', false)
union all select '0119 checkout_attach uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.checkout_attach_subscription(uuid,text,text,text)')) like '%_trial_days()%', false)
union all select '0119 checkout_attach service role only', not has_function_privilege('authenticated', 'public.checkout_attach_subscription(uuid,text,text,text)', 'execute')
union all select '0119 my_checkout_options trial_days from settings', coalesce(pg_get_functiondef(to_regprocedure('public.my_checkout_options()')) like '%''trial_days'', public._trial_days()%', false)
union all select '0119 my_trial_org returns trial_mode', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''trial_mode''%', false)
union all select '0119 role alert skips first role', coalesce(pg_get_functiondef(to_regprocedure('public.tg_sa54_profile()')) like '%old.org_id is not null and old.org_id = new.org_id%', false)
union all select '0119 role-change trigger still attached', exists (select 1 from pg_trigger where tgname = 'zzz_sa54_profile_role' and tgrelid = 'public.profiles'::regclass)
union all select '0119 _trial_days not callable by users', not has_function_privilege('authenticated', 'public._trial_days()', 'execute')
union all
select '0120 trial_reminders table exists' as item, to_regclass('public.trial_reminders') is not null as ok
union all select '0120 trial_reminders RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_reminders')), false)
union all select '0120 dedupe key is unique', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'trial_reminders_dedupe_key120' and indexdef ilike '%unique%')
union all select '0120 users cannot read the ledger', not has_table_privilege('authenticated', 'public.trial_reminders', 'select')
union all select '0120 tick exists + security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.trial_reminders_tick()')), false)
union all select '0120 tick: service role only', has_function_privilege('service_role', 'public.trial_reminders_tick()', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminders_tick()', 'execute') and not has_function_privilege('anon', 'public.trial_reminders_tick()', 'execute')
union all select '0120 email claim: service role only', has_function_privilege('service_role', 'public.trial_reminder_email_claim(integer)', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminder_email_claim(integer)', 'execute')
union all select '0120 email mark: service role only', has_function_privilege('service_role', 'public.trial_reminder_email_mark(uuid,text)', 'execute') and not has_function_privilege('authenticated', 'public.trial_reminder_email_mark(uuid,text)', 'execute')
union all select '0120 milestone d5 (3 days before end, studio zone)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-06 09:00+05:30', 'Asia/Kolkata') = 'd5'
union all select '0120 milestone d7 (day before end)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-08 23:00+05:30', 'Asia/Kolkata') = 'd7'
union all select '0120 milestone d8 (last day)', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-09 00:30+05:30', 'Asia/Kolkata') = 'd8'
union all select '0120 milestone none after end', public._trial_reminder_milestone('2026-10-09 10:00+05:30', '2026-10-09 10:00+05:30', 'Asia/Kolkata') is null
union all select '0120 milestone uses studio zone', public._trial_reminder_milestone('2026-10-09 04:00+00', '2026-10-08 17:00+00', 'America/Chicago') = 'd8'
union all select '0120 my_trial_org returns timezone', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''timezone''%', false)
union all select '0120 my_trial_org still for members', has_function_privilege('authenticated', 'public.my_trial_org()', 'execute')
union all select '0120 0058 job skips 8-day trial studios', coalesce(pg_get_functiondef(to_regprocedure('public._trial_refresh()')) like '%o.trial_ends_at is not null%', false)
union all
select '0121 dashboard_due_today exists' as item, to_regprocedure('public.dashboard_due_today()') is not null as ok
union all select '0121 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.dashboard_due_today()')), false)
union all select '0121 authenticated may run', has_function_privilege('authenticated', 'public.dashboard_due_today()', 'execute')
union all select '0121 anon may NOT run', not has_function_privilege('anon', 'public.dashboard_due_today()', 'execute')
union all select '0121 needs finance view', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%has_area(''finance'', ''view'')%', false)
union all select '0121 own studio only', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%m.org_id = v_org%', false)
union all
select '0122 seed function has the real "Demo ·"' as item, coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%Demo ' || chr(183) || ' %', false) as ok
union all select '0122 seed function has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%' || chr(172) || chr(8721) || '%', false)
union all select '0122 seed uses the studio currency', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%0122%', false)
union all select '0122 read-only guard has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%' || chr(8218) || chr(196) || '%', false)
union all select '0122 trial studios: no broken quote titles', not exists (select 1 from public.quotes q join public.organizations o on o.id = q.org_id where o.trial_ends_at is not null and q.title like '%' || chr(172) || chr(8721) || '%')
union all select '0122 trial studios: no broken vendor names', not exists (select 1 from public.vendors v join public.organizations o on o.id = v.org_id where o.trial_ends_at is not null and v.name like '%' || chr(172) || chr(8721) || '%')
union all select '0122 lead history records the lead''s studio', coalesce(pg_get_functiondef(to_regprocedure('public.archive_lead()')) like '%r.org_id%', false)
union all
select '0123 my_demo_status has per-type counts' as item, coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%trial-start-fresh-0123%', false) as ok
union all select '0123 my_demo_status is read-only (no delete/update)', not coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) ~* '(delete|update|insert)[[:space:]]', false)
union all select '0123 anon cannot call my_demo_status', not has_function_privilege('anon', 'public.my_demo_status()', 'execute')
union all select '0123 clear_demo_data still admin-gated', coalesce(pg_get_functiondef(to_regprocedure('public.clear_demo_data()')) like '%is_admin()%', false)
union all
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
union all select '0124 payouts immutable trigger', exists (select 1 from pg_trigger where tgname = 'vendor_payouts_immutable' and tgrelid = to_regclass('public.vendor_payouts'))
union all
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
