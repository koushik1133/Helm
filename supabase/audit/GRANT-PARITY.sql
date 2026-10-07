-- ============================================================================
-- GRANT-PARITY.sql — READ-ONLY. Run in the Supabase SQL Editor (prod or staging).
-- Lists every public function / view whose anon / authenticated privileges differ
-- from the intended canonical state (migrations 0001-0033). Changes nothing.
--
-- Result: one row per problem. NO ROWS = parity. Columns:
--   kind     function | view | table
--   object   signature / name
--   issue    what differs
--   fix_hint the statement that would restore the intended state (review first;
--            0032 applies these for functions automatically)
--
-- Intended state (source: 0005 least-privilege + later migrations, 0032 rescore2,
-- 0033 rescore3 — _notify / export_tenant_organization_package keep their own
-- bodies as *__base, which are never callable by API roles):
--   * anon may EXECUTE only the client-link RPCs in "anon_allow" below (the token
--     pages approve / proposal / portal / work / invite / branded links / login
--     invite banner) plus a few pure helpers. Trigger functions are ignored.
--   * authenticated may EXECUTE every app function EXCEPT the internal-only ones
--     in "auth_deny" (and anything named *__base).
--   * views: security_invoker = true, no anon privilege, no API write privilege.
--   * event_closure: no direct INSERT / UPDATE / DELETE for anon / authenticated.
-- "canonical" is every function name the canonical path creates (generated from
-- the disposable test DB after 0033). A function that exists on this database
-- but not in that list is reported only if anon can call it (prod-only drift).
-- ============================================================================
with
anon_allow(n) as (values
  ('public_get_quote'),('public_get_portal'),('public_get_proposal'),('public_event_site'),
  ('request_otp'),('create_payment'),('verify_and_consent'),
  ('worker_get_tasks'),('worker_get_equipment'),('worker_respond'),('worker_checkin_equipment'),
  ('invitation_preview'),('invite_media_on_published_site'),('public_link_studio'),
  ('helm_norm_phone'),('mfa_ok'),('studio_slug_reserved'),('studio_slug_valid'),('studio_slugify'),
  ('try_date'),('client_link_window_days'),
  -- 0038 crew work link evidence (token-checked inside; storage policy helper)
  ('worker_evidence_upload'),('worker_respond_evidence'),('task_proof_upload_ok')),
auth_deny(n) as (values
  ('_admin_create_user_core'),('_flag'),('_hq_gate'),('_hq_num'),('_hq_studio_rows'),('_notify'),
  ('_password_ok'),('_work_token_live'),('admin_store_otp'),('create_helm_user'),('helm_total_paid'),
  ('messaging_rate_hit'),('otp_send_authorize'),('payment_link_attach'),('payment_link_begin'),
  ('payment_link_fail'),('razorpay_settle'),
  -- 0041 member profile internals (definer helpers; only the app RPCs below are callable)
  ('_mp_text'),('_mp_mobile'),('_mp_any_phone'),('_mp_skills'),('_mp_mask'),('_mp_pw_pending'),
  ('_mp_is_operator'),('_mp_row_json'),('_mp_sync_staff'),('_mp_apply')),
canonical(n) as (select unnest(array[
    '_admin_create_user_core', '_flag', '_hq_gate', '_hq_num', '_hq_studio_rows', '_next_occasion',
    '_notify', '_notify__base', '_password_ok', '_valid_role', '_work_token_live', 'accept_invitation', 'add_event_dish',
    'add_quote_version', 'adjust_inventory_total', 'admin_create_user', 'admin_create_user_temp',
    'admin_delete_user', 'admin_get_role_access', 'admin_set_role', 'admin_set_role_access',
    'admin_store_otp', 'apply_menu_template', 'assert_quote_org', 'assign_tasks', 'assign_tasks_vendor',
    'bell_feed', 'bell_mark_seen', 'can_create', 'can_delete', 'can_edit', 'can_view_finance',
    'can_view_ops', 'chat_add_members', 'chat_can_see', 'chat_create_group', 'chat_ensure_broadcast',
    'chat_is_member', 'chat_mark_read', 'chat_media_visible', 'chat_react', 'chat_send', 'chat_start_dm',
    'checkin_equipment', 'checkout_equipment', 'clear_password_change_required', 'client_link_deadline',
    'client_link_window_days', 'close_event', 'confirm_quote', 'convert_lead_to_quote', 'create_event_site',
    'create_helm_user', 'create_invitation', 'create_payment', 'create_payment__base', 'create_quote',
    'create_studio', 'current_org_id', 'design_advance', 'design_get', 'design_queue', 'event_activity',
    'event_site_live_until', 'export_org_data', 'export_tenant_organization_package', 'export_tenant_organization_package__base',
    'generate_approval_token', 'get_pricing_config', 'has_area', 'helm_contact_ok', 'helm_event_date_parse',
    'helm_norm_phone', 'helm_otp_phone_on_file', 'helm_pricing_assert_sane', 'helm_pricing_num',
    'helm_pw_change_pending', 'helm_quote_total', 'helm_quote_total__base', 'helm_quote_total_canonical',
    'helm_total_paid', 'hq_overview', 'hq_payments', 'hq_studio_detail', 'hq_studios', 'hq_users',
    'invitation_by_token', 'invitation_preview', 'invite_media_on_published_site', 'is_admin',
    'is_platform_admin', 'layouts_quarantined_count', 'list_event_files', 'mark_paid', 'mark_paid__base',
    'messaging_rate_hit', 'mfa_ok', 'mgr_notify', 'my_auth_info', 'my_pending', 'my_tasks', 'nurture_due',
    'otp_send_authorize', 'password_change_required', 'payment_link_attach', 'payment_link_begin',
    'payment_link_fail', 'public_event_site', 'public_event_site__base', 'public_get_portal',
    'public_get_proposal', 'public_get_proposal__base', 'public_get_quote', 'public_link_studio',
    'publish_event_site', 'publish_proposal', 'queue_nurture_greeting', 'razorpay_settle', 'reassign_task',
    'rebrand_quote_code', 'record_payment', 'record_settlement_payment', 'remove_event_dish', 'request_otp',
    'request_otp__base', 'resolve_payment_reconciliation', 'return_reservation', 'revoke_approval_token',
    'run_nurture_auto', 'run_task_reminders', 'run_task_triggers', 'save_quotation_version', 'set_closure',
    'set_discovery', 'set_event_dish_qty', 'set_event_plan', 'set_lifecycle_stage', 'set_plan_lock',
    'set_plan_signoff', 'set_pricing_config', 'set_proposal', 'set_studio_link_name', 'set_task_schedule',
    'set_task_special', 'settle_milestone', 'storage_key_ok', 'storage_upload_allowed', 'studio_slug_free',
    'studio_slug_pick', 'studio_slug_reserved', 'studio_slug_valid', 'studio_slugify', 'task_verify_summary',
    'try_date', 'user_role', 'verify_and_consent', 'verify_and_consent__base', 'verify_task',
    'whatsapp_authorize', 'work_token_expiry_for', 'worker_checkin_equipment', 'worker_get_equipment',
    'worker_get_tasks', 'worker_respond',
    'worker_evidence_upload', 'worker_respond_evidence', 'task_proof_upload_ok',
    -- 0041 member profile (signed-in app RPCs + the storage policy helper)
    'chat_directory', 'my_profile', 'my_profile_status', 'update_my_profile', 'complete_my_profile',
    'admin_update_member_profile', 'member_profile_list', 'set_my_avatar', 'audit_actor_names',
    'member_avatar_upload_ok',
    '_mp_text', '_mp_mobile', '_mp_any_phone', '_mp_skills', '_mp_mask', '_mp_pw_pending',
    '_mp_is_operator', '_mp_row_json', '_mp_sync_staff', '_mp_apply', 'chat_directory__base'
  ]::text[])),
fns as (
  select p.oid, p.oid::regprocedure::text as sig, p.proname as n,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
     and p.prorettype <> 'trigger'::regtype
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
problems as (
  -- anon can call something outside the allowlist
  select 'function' as kind, f.sig as object,
         case when f.n in (select n from canonical) then 'anon can EXECUTE (not a client-link RPC)'
              else 'anon can EXECUTE a function that is NOT in the canonical schema (prod-only?)' end as issue,
         format('revoke execute on function public.%s from public, anon;', f.sig) as fix_hint
    from fns f
   where f.anon_x and f.n not in (select n from anon_allow)
  union all
  -- a client-link RPC the public pages need is not callable signed out
  select 'function', f.sig, 'anon CANNOT execute a client-link RPC (a public page will break)',
         format('grant execute on function public.%s to anon;', f.sig)
    from fns f
   where not f.anon_x and f.n in (select n from anon_allow)
  union all
  select 'function', a.n || '(…)', 'client-link RPC is MISSING from this database',
         'apply the migration that defines it (invitation_preview: 0010 / 0032)'
    from anon_allow a where not exists (select 1 from fns f where f.n = a.n)
  union all
  -- internal-only helper reachable by signed-in users
  select 'function', f.sig, 'authenticated can EXECUTE an internal-only function',
         format('revoke execute on function public.%s from public, authenticated;', f.sig)
    from fns f
   where f.auth_x and (f.n in (select n from auth_deny)
                       -- helm_quote_total__base stays callable by staff on purpose (0026: the
                       -- pricing trigger runs as the caller)
                       or (f.n like '%\_\_base' and f.n <> 'helm_quote_total__base'))
  union all
  -- app function signed-in users can no longer call
  select 'function', f.sig, 'authenticated CANNOT execute an app function (the app may break)',
         format('grant execute on function public.%s to authenticated;', f.sig)
    from fns f
   where not f.auth_x and f.n in (select n from canonical)
     and f.n not in (select n from auth_deny) and (f.n not like '%\_\_base' or f.n = 'helm_quote_total__base')
  union all
  -- views
  select 'view', 'public.' || c.relname, 'view is not security_invoker (bypasses the caller''s RLS)',
         format('alter view public.%I set (security_invoker = true);', c.relname)
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  union all
  select 'view', 'public.' || c.relname, 'anon has privileges on a view',
         format('revoke all on public.%I from anon;', c.relname)
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
  union all
  select 'view', 'public.' || c.relname, 'authenticated can write through a view',
         format('revoke insert, update, delete on public.%I from authenticated;', c.relname)
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE')
  union all
  -- closure only through close_event / set_closure
  select 'table', 'public.event_closure', r || ' can write event_closure directly (bypasses close_event)',
         format('revoke insert, update, delete on public.event_closure from %s;', r)
    from unnest(array['anon','authenticated']) r
   where to_regclass('public.event_closure') is not null
     and has_table_privilege(r, 'public.event_closure', 'INSERT,UPDATE,DELETE')
)
select kind, object, issue, fix_hint from problems order by kind, issue, object;
