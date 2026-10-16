-- VERIFY 0118 (read-only; expect every ok = true)
select '0118 start_trial(text,text) exists' as item, to_regprocedure('public.start_trial(text,text)') is not null as ok
union all select '0118 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_trial(text,text)')), false)
union all select '0118 authenticated may run', has_function_privilege('authenticated', 'public.start_trial(text,text)', 'execute')
union all select '0118 anon may NOT run', not has_function_privilege('anon', 'public.start_trial(text,text)', 'execute')
union all select '0118 validates time zone', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%pg_timezone_names%', false)
union all select '0118 keeps advisory lock + create_studio', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%pg_advisory_xact_lock%create_studio(%', false)
union all select '0118 old start_trial() still there', to_regprocedure('public.start_trial()') is not null;
