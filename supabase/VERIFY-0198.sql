-- VERIFY-0198.sql - read-only checks after APPLY-0198.sql (every row should say ok = true).
select item, ok from (values
  ('01 close gate refuses before the event day (HL425, no override)', position('HL425' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0
      and position('_a198_org_today' in pg_get_functiondef('public._a49_close_gate(uuid,text)'::regprocedure)) > 0),
  ('02 close gate keeps the balance / equipment / booking checks', position('helm_invoice_total' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0
      and position('not_booked' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0
      and position('too_early' in pg_get_functiondef('public._a49_close_blockers(uuid)'::regprocedure)) > 0),
  ('03 close_event still runs the gate', position('_a49_close_gate' in pg_get_functiondef('public.close_event(uuid,boolean)'::regprocedure)) > 0
      and position('_a49_close_gate' in pg_get_functiondef('public.close_event(uuid,boolean,text)'::regprocedure)) > 0),
  ('04 set_lifecycle_stage uses the 0198 rules', position('helm-0198-stages' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text,text)'::regprocedure)) > 0
      and position('_a198_stage_blockers' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text,text)'::regprocedure)) > 0),
  ('05 2-arg set_lifecycle_stage goes through the 3-arg one', position('set_lifecycle_stage(p_quote_id, p_stage, null::text)' in pg_get_functiondef('public.set_lifecycle_stage(uuid,text)'::regprocedure)) > 0),
  ('06 lifecycle_stage_blockers explains the 0198 gates', position('_a198_stage_blockers' in pg_get_functiondef('public.lifecycle_stage_blockers(uuid,text)'::regprocedure)) > 0),
  ('07 cancel_event + conflict ack RPCs for signed-in users only', to_regprocedure('public.cancel_event(uuid,text)') is not null
      and has_function_privilege('authenticated', 'public.cancel_event(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.cancel_event(uuid,text)', 'execute')
      and has_function_privilege('authenticated', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.unack_calendar_conflict(uuid,text)', 'execute')),
  ('08 helpers not callable by the app', not has_function_privilege('authenticated', 'public._a198_org_today(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._a198_stage_blockers(uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public._a49_close_gate(uuid,text)', 'execute')),
  ('09 new tables have RLS on, no direct app writes', (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_cancellations'::regclass, 'public.calendar_conflict_acks'::regclass))
      and not has_table_privilege('authenticated', 'public.event_cancellations', 'insert')
      and not has_table_privilege('authenticated', 'public.calendar_conflict_acks', 'insert')
      and not has_table_privilege('anon', 'public.calendar_conflict_acks', 'select')),
  ('10 studio today works for every studio', not exists (select 1 from public.organizations o where public._a198_org_today(o.id) is null)),
  ('11 no trigger added on quotes / event_closure', not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid in ('public.quotes'::regclass, 'public.event_closure'::regclass) and p.proname like '%198%')),
  ('12 trial retention (0184, if installed) classifies the new tables', to_regprocedure('public._tr184_purge_tables()') is null
      or ('event_cancellations' = any(public._tr184_purge_tables()) and 'calendar_conflict_acks' = any(public._tr184_purge_tables())))
) v(item, ok) order by item;
