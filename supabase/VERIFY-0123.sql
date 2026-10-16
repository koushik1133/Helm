-- VERIFY 0123 (read-only; expect every ok = true)
select '0123 my_demo_status has per-type counts' as item, coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%trial-start-fresh-0123%', false) as ok
union all select '0123 my_demo_status is read-only (no delete/update)', not coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) ~* '(delete|update|insert)[[:space:]]', false)
union all select '0123 anon cannot call my_demo_status', not has_function_privilege('anon', 'public.my_demo_status()', 'execute')
union all select '0123 clear_demo_data still admin-gated', coalesce(pg_get_functiondef(to_regprocedure('public.clear_demo_data()')) like '%is_admin()%', false);
