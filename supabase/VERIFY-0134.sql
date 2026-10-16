-- VERIFY 0134 (read-only; expect every ok = true)
select '0134 integrations_overview exists' as item, to_regprocedure('public.integrations_overview()') is not null as ok
union all select '0134 overview is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.integrations_overview()')), false)
union all select '0134 overview is read-only (stable)', coalesce((select provolatile = 's' from pg_proc where oid = to_regprocedure('public.integrations_overview()')), false)
union all select '0134 overview not callable by anon', not has_function_privilege('anon', 'public.integrations_overview()', 'execute')
union all select '0134 overview callable by authenticated', has_function_privilege('authenticated', 'public.integrations_overview()', 'execute')
union all select '0134 overview gated on Control Center view', coalesce(pg_get_functiondef(to_regprocedure('public.integrations_overview()')) like '%has_area(''controls'', ''view'')%', false)
union all select '0134 overview returns no tokens / keys', coalesce(pg_get_functiondef(to_regprocedure('public.integrations_overview()')) not like '%token%' and pg_get_functiondef(to_regprocedure('public.integrations_overview()')) not like '%secret%', false);
