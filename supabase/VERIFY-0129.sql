-- VERIFY 0129 (read-only; expect every ok = true)
select '0129 organizations.event_reminder_days exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'event_reminder_days') as ok
union all select '0129 every studio has 1-30 reminder days', not exists (select 1 from public.organizations o where o.event_reminder_days is null or o.event_reminder_days not between 1 and 30)
union all select '0129 event_reminders ledger exists', to_regclass('public.event_reminders') is not null
union all select '0129 event_reminders RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.event_reminders')), false)
union all select '0129 event_reminders not writable by authenticated', not has_table_privilege('authenticated', 'public.event_reminders', 'insert')
union all select '0129 event_reminders not readable by anon', not has_table_privilege('anon', 'public.event_reminders', 'select')
union all select '0129 dedupe key unique', to_regclass('public.event_reminders_dedupe_key129') is not null
union all select '0129 tick exists + security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.event_reminders_tick()')), false)
union all select '0129 tick not callable by anon', not has_function_privilege('anon', 'public.event_reminders_tick()', 'execute')
union all select '0129 tick not callable by authenticated', not has_function_privilege('authenticated', 'public.event_reminders_tick()', 'execute')
union all select '0129 tick sends nothing outside the app (no _notify / comms_outbox)', coalesce(pg_get_functiondef(to_regprocedure('public.event_reminders_tick()')) not like '%_notify(%' and pg_get_functiondef(to_regprocedure('public.event_reminders_tick()')) not like '%comms_outbox%', false)
union all select '0129 settings_get callable by authenticated', has_function_privilege('authenticated', 'public.event_reminder_settings_get()', 'execute')
union all select '0129 settings_set not callable by anon', not has_function_privilege('anon', 'public.event_reminder_settings_set(integer)', 'execute')
union all select '0129 upcoming not callable by anon', not has_function_privilege('anon', 'public.event_reminder_upcoming()', 'execute')
union all select '0129 milestone: 7 days in a 7-day window', public._event_reminder_milestone(7, 7) = 'window'
union all select '0129 milestone: 8 days in a 7-day window = none', public._event_reminder_milestone(8, 7) is null
union all select '0129 milestone: 1 day = d1', public._event_reminder_milestone(1, 7) = 'd1'
union all select '0129 milestone: today = none', public._event_reminder_milestone(0, 7) is null;
