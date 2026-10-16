-- VERIFY 0126 (read-only; expect every ok = true)
select '0126 _trial_member_blocked exists' as item, to_regprocedure('public._trial_member_blocked(uuid)') is not null as ok
union all select '0126 _trial_member_blocked uses _trial_locked', coalesce(pg_get_functiondef(to_regprocedure('public._trial_member_blocked(uuid)')) like '%_trial_locked(p_org)%', false)
union all select '0126 _trial_member_blocked spares the owner', coalesce(pg_get_functiondef(to_regprocedure('public._trial_member_blocked(uuid)')) like '%created_by <> auth.uid()%', false)
union all select '0126 _trial_member_blocked not callable by authenticated', not coalesce(has_function_privilege('authenticated', 'public._trial_member_blocked(uuid)', 'execute'), false)
union all select '0126 current_org_id has trial-staff gate', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%trial-staff-0126%', false)
union all select '0126 current_org_id keeps 2FA gate', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%mfa_ok()%', false)
union all select '0126 current_org_id still wraps pre0043 body', coalesce(pg_get_functiondef(to_regprocedure('public.current_org_id()')) like '%current_org_id__pre0043()%', false)
union all select '0126 current_org_id still security definer + stable', coalesce((select prosecdef and provolatile = 's' from pg_proc where oid = to_regprocedure('public.current_org_id()')), false)
union all select '0126 my_trial_access exists', to_regprocedure('public.my_trial_access()') is not null
union all select '0126 my_trial_access callable by authenticated', coalesce(has_function_privilege('authenticated', 'public.my_trial_access()', 'execute'), false)
union all select '0126 my_trial_access not callable by anon', not coalesce(has_function_privilege('anon', 'public.my_trial_access()', 'execute'), false)
union all select '0126 read-only guard (0116) still present', coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%trial_ended%', false)
union all select '0126 no paid studio is blocked (non-trial studios count with blocked members = 0)', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_member_blocked(o.id));
