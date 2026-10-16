-- VERIFY 0132 (read-only; expect every ok = true)
select '0132 run_sheet_items.assign_changed_at exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'run_sheet_items' and column_name = 'assign_changed_at') as ok
union all select '0132 event_tasks.assign_changed_at exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'assign_changed_at')
union all select '0132 assign_notify_outbox exists', to_regclass('public.assign_notify_outbox') is not null
union all select '0132 outbox RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.assign_notify_outbox')), false)
union all select '0132 outbox not readable by anon', not has_table_privilege('anon', 'public.assign_notify_outbox', 'select')
union all select '0132 outbox not writable by authenticated', not has_table_privilege('authenticated', 'public.assign_notify_outbox', 'insert')
union all select '0132 run-sheet trigger installed', exists (select 1 from pg_trigger where tgname = 'zz_runsheet_assign132' and tgrelid = 'public.run_sheet_items'::regclass)
union all select '0132 task trigger installed', exists (select 1 from pg_trigger where tgname = 'zz_task_assign132' and tgrelid = 'public.event_tasks'::regclass)
union all select '0132 enqueue not callable by authenticated', not has_function_privilege('authenticated', 'public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text)', 'execute')
union all select '0132 claim not callable by anon', not has_function_privilege('anon', 'public.assign_notify_claim(integer)', 'execute')
union all select '0132 claim not callable by authenticated', not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute')
union all select '0132 mark not callable by authenticated', not has_function_privilege('authenticated', 'public.assign_notify_mark(uuid, text)', 'execute')
union all select '0132 worker updates callable by anon (token link)', has_function_privilege('anon', 'public.worker_assignment_updates(uuid)', 'execute')
union all select '0132 group post not callable by anon', not has_function_privilege('anon', 'public.runsheet_post_to_group(uuid, text)', 'execute')
union all select '0132 group post callable by authenticated', has_function_privilege('authenticated', 'public.runsheet_post_to_group(uuid, text)', 'execute')
union all select '0132 group status not callable by anon', not has_function_privilege('anon', 'public.runsheet_group_status(uuid)', 'execute')
union all select '0132 phone: 10 digits -> +91', public._assign132_phone('98765 43210') = '919876543210'
union all select '0132 phone: garbage -> null', public._assign132_phone('abc') is null
union all select '0132 nothing sent yet by the database (outbox only)', coalesce(pg_get_functiondef(to_regprocedure('public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text)')) not like '%http%', false);
