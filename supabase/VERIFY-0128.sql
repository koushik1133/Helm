-- VERIFY 0128 (read-only; expect every ok = true)
select '0128 _trial_test_mode_ok exists' as item, to_regprocedure('public._trial_test_mode_ok(uuid)') is not null as ok
union all select '0128 _trial_test_mode_ok not callable by anon', not has_function_privilege('anon', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 _trial_test_mode_ok not callable by authenticated', not has_function_privilege('authenticated', 'public._trial_test_mode_ok(uuid)', 'execute')
union all select '0128 trial_test_mode_for_token callable by anon', has_function_privilege('anon', 'public.trial_test_mode_for_token(uuid)', 'execute')
union all select '0128 trial_test_approve callable by anon', has_function_privilege('anon', 'public.trial_test_approve(uuid, text, text, text, text, text)', 'execute')
union all select '0128 trial_test_approve security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')), false)
union all select '0128 trial_test_approve gates on active trial', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%_trial_test_mode_ok(v_org)%', false)
union all select '0128 trial_test_approve reuses verify_and_consent', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) like '%public.verify_and_consent(p_token%', false)
union all select '0128 trial_test_approve sends nothing (no _notify)', coalesce(pg_get_functiondef(to_regprocedure('public.trial_test_approve(uuid, text, text, text, text, text)')) not like '%_notify(%', false)
union all select '0128 no non-trial studio is in trial test mode', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_test_mode_ok(o.id))
union all select '0128 verify_and_consent unchanged (no trial marker)', coalesce(pg_get_functiondef(to_regprocedure('public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)')) not like '%helm-0128%', false);
