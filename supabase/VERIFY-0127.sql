-- VERIFY 0127 (read-only; expect every ok = true)
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
union all select '0127 no non-trial studio has a demo choice', not exists (select 1 from public.organizations where trial_ends_at is null and demo_choice is not null);
