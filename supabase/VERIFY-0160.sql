-- VERIFY 0160 (read-only; expect every ok = true)
select item, ok from (values
  ('01 client_timeline exists', to_regprocedure('public.client_timeline(uuid,integer)') is not null),
  ('02 still security definer + stable', coalesce((select prosecdef and provolatile = 's' from pg_proc where oid = to_regprocedure('public.client_timeline(uuid,integer)')), false)),
  ('03 due counts confirmed events only', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%when st = ''confirmed'' then greatest(inv - pd, 0)%', false)),
  ('04 due includes approved change orders', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%change_requests%', false)),
  ('05 Status now maps confirmed-on-stage-quote', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%then ''confirmed'' else%', false)),
  ('06 callable by authenticated', has_function_privilege('authenticated', 'public.client_timeline(uuid,integer)', 'execute')),
  ('07 not callable by anon', not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.client_timeline(uuid,integer)', 'execute'))
) v(item, ok);
