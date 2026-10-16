-- VERIFY 0120 (read-only; expect every ok = true)
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
union all select '0120 0058 job skips 8-day trial studios', coalesce(pg_get_functiondef(to_regprocedure('public._trial_refresh()')) like '%o.trial_ends_at is not null%', false);
-- if pg_cron is installed, also run: select jobname, schedule from cron.job where jobname = 'helm_trial_reminders';
