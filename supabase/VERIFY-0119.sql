-- VERIFY 0119 (read-only; expect every ok = true)
select '0119 trial_days column exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_billing_settings' and column_name = 'trial_days') as ok
union all select '0119 trial length is 8 days', (select b.trial_days = 8 from public.helm_billing_settings b where b.id limit 1)
union all select '0119 start_self_serve_trial exists', to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is not null
union all select '0119 start_self_serve_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_self_serve_trial(text,text,text,text)')), false)
union all select '0119 authenticated may start a trial', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 anon may NOT start a trial', not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 start_trial() -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial()')) like '%start_self_serve_trial(%', false)
union all select '0119 start_trial(text,text) -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%start_self_serve_trial(%', false)
union all select '0119 my_start_trial uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) like '%_trial_days()%', false)
union all select '0119 my_start_trial no longer 14 days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) not like '%current_date + 14%', false)
union all select '0119 checkout_attach uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.checkout_attach_subscription(uuid,text,text,text)')) like '%_trial_days()%', false)
union all select '0119 checkout_attach service role only', not has_function_privilege('authenticated', 'public.checkout_attach_subscription(uuid,text,text,text)', 'execute')
union all select '0119 my_checkout_options trial_days from settings', coalesce(pg_get_functiondef(to_regprocedure('public.my_checkout_options()')) like '%''trial_days'', public._trial_days()%', false)
union all select '0119 my_trial_org returns trial_mode', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''trial_mode''%', false)
union all select '0119 role alert skips first role', coalesce(pg_get_functiondef(to_regprocedure('public.tg_sa54_profile()')) like '%old.org_id is not null and old.org_id = new.org_id%', false)
union all select '0119 role-change trigger still attached', exists (select 1 from pg_trigger where tgname = 'zzz_sa54_profile_role' and tgrelid = 'public.profiles'::regclass)
union all select '0119 _trial_days not callable by users', not has_function_privilege('authenticated', 'public._trial_days()', 'execute');
