-- VERIFY-0116.sql - READ ONLY. Paste into the Supabase SQL editor (staging first, then prod). Changes nothing.
-- Every row's ok must be true.
select '0116 organizations.trial_ends_at column' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'trial_ends_at' and is_nullable = 'YES') as ok
union all select '0116 existing studios unaffected (no trial_ends_at except Demo N trials)', not exists (select 1 from public.organizations o where o.trial_ends_at is not null and o.name !~ '^Demo [0-9]{1,9}$')
union all select '0116 start_trial exists', to_regprocedure('public.start_trial()') is not null
union all select '0116 start_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial()')), false)
union all select '0116 start_trial: authenticated may run', has_function_privilege('authenticated', 'public.start_trial()', 'execute')
union all select '0116 start_trial: anon may NOT run', not has_function_privilege('anon', 'public.start_trial()', 'execute')
union all select '0116 start_trial uses advisory lock + create_studio', pg_get_functiondef('public.start_trial()'::regprocedure) like '%pg_advisory_xact_lock%' and pg_get_functiondef('public.start_trial()'::regprocedure) like '%public.create_studio(%'
union all select '0116 my_trial_org exists', to_regprocedure('public.my_trial_org()') is not null
union all select '0116 my_trial_org: anon may NOT run', not has_function_privilege('anon', 'public.my_trial_org()', 'execute')
union all select '0116 helpers private', not has_function_privilege('authenticated', 'public._trial_next_demo_number()', 'execute') and not has_function_privilege('authenticated', 'public._trial_seed_extra(uuid)', 'execute') and not has_function_privilege('authenticated', 'public._trial_locked(uuid)', 'execute')
union all select '0116 read-only guard knows ended trials', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%trial-orgs-0116%'
union all select '0116 read-only guard keeps suspended rule', pg_get_functiondef('public.tg_studio_read_only()'::regprocedure) like '%studio_suspended%'
union all select '0116 next demo number is positive', public._trial_next_demo_number() >= 1
union all select '0116 no existing studio is trial-locked unless it is a Demo N trial', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_locked(o.id));
