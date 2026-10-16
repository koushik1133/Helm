-- VERIFY 0131 (read-only; expect every ok = true)
select '0131 invite_email_outbox exists' as item, to_regclass('public.invite_email_outbox') is not null as ok
union all select '0131 outbox RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.invite_email_outbox')), false)
union all select '0131 outbox no anon access', not has_table_privilege('anon', 'public.invite_email_outbox', 'select')
union all select '0131 outbox no authenticated access', not has_table_privilege('authenticated', 'public.invite_email_outbox', 'select')
union all select '0131 one row per invitation (unique)', to_regclass('public.invite_email_outbox_inv_uq') is not null
union all select '0131 trigger on invitations', exists (select 1 from pg_trigger where tgname = 'ie131_invitation_email' and tgrelid = 'public.invitations'::regclass and not tgisinternal)
union all select '0131 claim service_role only', has_function_privilege('service_role', 'public.invite_email_outbox_claim(integer, uuid)', 'execute') and not has_function_privilege('authenticated', 'public.invite_email_outbox_claim(integer, uuid)', 'execute') and not has_function_privilege('anon', 'public.invite_email_outbox_claim(integer, uuid)', 'execute')
union all select '0131 mark service_role only', has_function_privilege('service_role', 'public.invite_email_outbox_mark(uuid, text)', 'execute') and not has_function_privilege('authenticated', 'public.invite_email_outbox_mark(uuid, text)', 'execute') and not has_function_privilege('anon', 'public.invite_email_outbox_mark(uuid, text)', 'execute')
union all select '0131 enqueue private', not has_function_privilege('authenticated', 'public._ie131_enqueue(uuid)', 'execute') and not has_function_privilege('anon', 'public._ie131_enqueue(uuid)', 'execute')
union all select '0131 resend callable by authenticated, not anon', has_function_privilege('authenticated', 'public.resend_invitation_email(uuid)', 'execute') and not has_function_privilege('anon', 'public.resend_invitation_email(uuid)', 'execute')
union all select '0131 resend is admin + same-studio gated', coalesce(pg_get_functiondef(to_regprocedure('public.resend_invitation_email(uuid)')) like '%is_admin()%' and pg_get_functiondef(to_regprocedure('public.resend_invitation_email(uuid)')) like '%i.org_id = v_org%', false)
union all select '0131 resend rate-limited 10 minutes', coalesce(pg_get_functiondef(to_regprocedure('public.resend_invitation_email(uuid)')) like '%interval ''10 minutes''%', false)
union all select '0131 kick_org not callable by anon', not has_function_privilege('anon', 'public.invite_email_kick_org()', 'execute')
union all select '0131 create_invitation unchanged (no 0131 marker)', coalesce(pg_get_functiondef(to_regprocedure('public.create_invitation(text, text)')) not like '%helm-0131%', false);
