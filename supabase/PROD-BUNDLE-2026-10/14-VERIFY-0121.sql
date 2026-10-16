-- VERIFY 0121 (read-only; expect every ok = true)
select '0121 dashboard_due_today exists' as item, to_regprocedure('public.dashboard_due_today()') is not null as ok
union all select '0121 is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.dashboard_due_today()')), false)
union all select '0121 authenticated may run', has_function_privilege('authenticated', 'public.dashboard_due_today()', 'execute')
union all select '0121 anon may NOT run', not has_function_privilege('anon', 'public.dashboard_due_today()', 'execute')
union all select '0121 needs finance view', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%has_area(''finance'', ''view'')%', false)
union all select '0121 own studio only', coalesce(pg_get_functiondef(to_regprocedure('public.dashboard_due_today()')) like '%m.org_id = v_org%', false);
