-- VERIFY 0126-0128 (read-only)
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
union all select '0126 no paid studio is blocked (non-trial studios count with blocked members = 0)', not exists (select 1 from public.organizations o where o.trial_ends_at is null and public._trial_member_blocked(o.id))
union all
select '0127 organizations.demo_choice exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'demo_choice') as ok
union all select '0127 organizations.demo_choice_at exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'demo_choice_at')
union all select '0127 demo_choice check constraint', exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_demo_choice_chk127')
union all select '0127 seed config reader exists', to_regprocedure('public._trial_seed_config()') is not null
union all select '0127 custom seed has marker', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_custom(uuid)')) like '%helm-0127-trial-seed-config%', false)
union all select '0127 custom seed not callable by users', not coalesce(has_function_privilege('authenticated', 'public._trial_seed_custom(uuid)', 'execute'), true)
union all select '0127 seed trigger attached', exists (select 1 from pg_trigger where tgname = 'trial_seed_custom_127' and tgrelid = 'public.organizations'::regclass and not tgisinternal)
union all select '0127 trial_demo_choice exists + marker', coalesce(pg_get_functiondef(to_regprocedure('public.trial_demo_choice(text)')) like '%helm-0127-demo-choice%', false)
union all select '0127 trial_demo_choice uses _demo_clear only', coalesce(pg_get_functiondef(to_regprocedure('public.trial_demo_choice(text)')) like '%_demo_clear(v_org)%', false)
union all select '0127 trial_demo_choice not callable by anon', not coalesce(has_function_privilege('anon', 'public.trial_demo_choice(text)', 'execute'), true)
union all select '0127 my_demo_status has choice keys', coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%choice_pending%', false)
union all select '0127 my_demo_status keeps counts', coalesce(pg_get_functiondef(to_regprocedure('public.my_demo_status()')) like '%''counts''%', false)
union all select '0127 no non-trial studio has a demo choice', not exists (select 1 from public.organizations where trial_ends_at is null and demo_choice is not null)
union all
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
