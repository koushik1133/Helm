-- VERIFY-0189.sql - read-only checks after APPLY-0189.sql (every row should say ok = true). Safe to run any time.
select item, ok from (values
  ('01 helm_quote_status_label exists', to_regprocedure('public.helm_quote_status_label(text,text,text)') is not null),
  ('02 label: locked + sent is not confirmed', public.helm_quote_status_label('confirmed', 'quote', 'sent') = 'sent - awaiting client approval'),
  ('03 label: client approved reads confirmed', public.helm_quote_status_label('confirmed', 'quote', 'approved') = 'confirmed' and public.helm_quote_status_label('confirmed', 'quote', 'paid') = 'confirmed'),
  ('04 label: locked, link not sent', public.helm_quote_status_label('confirmed', 'quote', 'none') = 'locked - not sent yet'),
  ('05 label: later stages unchanged', public.helm_quote_status_label('confirmed', 'planning', 'none') = 'planning' and public.helm_quote_status_label('quote', 'quote', 'none') = 'quote'),
  ('06 client_timeline uses the label', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%helm_quote_status_label(q.status, q.lifecycle_stage, q.approval_status)%', false)),
  ('07 client_timeline still security definer + stable', coalesce((select prosecdef and provolatile = 's' from pg_proc where oid = to_regprocedure('public.client_timeline(uuid,integer)')), false)),
  ('08 Due still confirmed events only (0160)', coalesce(pg_get_functiondef(to_regprocedure('public.client_timeline(uuid,integer)')) like '%when st = ''confirmed'' then greatest(inv - pd, 0)%', false)),
  ('09 client_timeline callable by authenticated, not anon', has_function_privilege('authenticated', 'public.client_timeline(uuid,integer)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.client_timeline(uuid,integer)', 'execute'))),
  ('10 label helper not callable by anon', not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.helm_quote_status_label(text,text,text)', 'execute'))
) v(item, ok) order by item;
