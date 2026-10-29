-- APPLY-0301.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0277 (any order with 0293-0300). It stops with "STOP 0301" if a function / table it needs is missing.
-- R60 database hardening (audit 2026-10-28, findings I-05 / I-06 / I-07 + the layouts / saved views write check):
--   * the signed-out role (anon) loses its table privileges on 60 studio tables (quotes, quote_otps, work_tokens,
--     audit_log, organizations, role_access, ...). Nothing leaked before (row level security refused every row),
--     but now the table privilege is gone too. Signed-out pages keep working: they only use link functions.
--   * two old copies of the upload name check (storage_object_name_ok__pre0069 / __pre0256) can no longer be called
--     by the app; the live check still uses them.
--   * layouts_quarantined_count() is for Helm HQ staff (two-step) only - a studio member now gets "not authorized".
--   * saving a floor layout or a saved view FOR ANOTHER STUDIO (or a saved view for another person) is refused with
--     "not authorized" instead of being silently moved into the caller's studio. The app never does this.
-- Three functions re-issued in place (previous bodies kept as *__pre0301, not callable by the app). No table, column,
-- row, policy, trigger or index created, changed or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  No site deploy needed (database only).
--   3  Check: open a client quote link, a client portal link and an invitation site while signed out - they load.
--      Signed in, save a floor layout and a saved view (Leads -> Save view) - both save as before.
begin;
-- 0301_r60_db_hardening.sql - CANONICAL forward-only.
-- REQUIRES the base schema (layouts, _layouts_stamp_org, layouts_quarantined_count), 0048 / 0069 / 0256 (the upload name
--          guard storage_object_name_ok and its kept copies), 0064 (saved_views + tg_saved_views_guard), 0277
--          (is_platform_admin: Helm HQ staff with two-step). Production has all of them.
--
-- In plain words (database audit 2026-10-28, findings I-05, I-06, I-07 + the layouts / saved_views write check):
--   I-05  The signed-out role (anon) still held table privileges (read / add / change / delete) on 60 studio tables,
--         among them quotes, quote_otps, work_tokens, audit_log, organizations and role_access. Nothing leaked: no
--         row level security policy lets anon see or write a single row, so every attempt already failed. But the
--         only wall was row level security - one careless future policy would have opened the table. Every page
--         that works signed out (client quote / approve page, portal, booklet, invitation sites, crew / vendor /
--         delivery links, enquiry and sign-up forms) reads and writes through SECURITY DEFINER functions, which
--         run as the table owner and do not use anon's table privileges. So anon's table privileges on those 60
--         tables are taken away (the same step 0204 took for profiles / layouts / venues / client_booklets /
--         coupons / event_sites). The signed-in role, service_role and every function keep exactly what they had.
--   I-06  Two superseded copies of the upload name guard (storage_object_name_ok__pre0069 / __pre0256) were still
--         callable by the app (anon + signed-in). The live guard (storage_object_name_ok, used by the storage
--         policies) calls them as its owner (SECURITY DEFINER), so nobody needs to call them directly: execute is
--         taken away from anon / authenticated, like every other kept __preNNNN copy.
--   I-07  layouts_quarantined_count() answered any signed-in person of any studio with the platform-wide number of
--         layouts that have no studio. It is a number only, but it is a Helm HQ maintenance figure: now only Helm
--         HQ staff (two-step) or a direct database / service session may read it; a studio member gets 42501.
--   W     Saving a floor layout or a saved view "for another studio" used to be silently rewritten to the caller's
--         own studio (and a saved view's owner to the caller). The app never sends another studio (it sends no
--         studio / owner at all and lets the database fill them in), so a mismatch can only be a forged request:
--         it is now refused with 42501 instead of being quietly changed. Leaving the studio / owner out still
--         fills in the caller's own, exactly as before.
--         A layout written by a direct database / service session (no signed-in caller) now keeps the studio it
--         names instead of being set to "no studio" (the old trigger always used the caller's studio, which for
--         such a session is none, so such a write failed on the required studio column).
-- The previous bodies are kept once as _layouts_stamp_org__pre0301, tg_saved_views_guard__pre0301 and
-- layouts_quarantined_count__pre0301 (not callable by the app).
-- ZERO DATA LOSS: privileges narrowed + 3 functions re-issued in place (same names, arguments, results; the two
-- triggers keep pointing at them) + 3 kept copies. No table, column, row, policy, trigger or index is created,
-- changed or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): grant select, insert, update, delete on <table> to anon (per table);
--   re-create the three functions from their __pre0301 copies (pg_get_functiondef + rename back);
--   grant execute on function public.storage_object_name_ok__pre0069(text, text), ...__pre0256(text, text) to anon, authenticated.

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.layouts') is null or to_regclass('public.saved_views') is null then
    raise exception 'STOP 0301: public.layouts / public.saved_views missing - run the base schema + 0064 first'; end if;
  if to_regprocedure('public._layouts_stamp_org()') is null then
    raise exception 'STOP 0301: public._layouts_stamp_org() missing (base schema)'; end if;
  if to_regprocedure('public.tg_saved_views_guard()') is null then
    raise exception 'STOP 0301: public.tg_saved_views_guard() missing - run 0064 first'; end if;
  if to_regprocedure('public.layouts_quarantined_count()') is null then
    raise exception 'STOP 0301: public.layouts_quarantined_count() missing (base schema)'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0301: current_org_id() / is_admin() missing'; end if;
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP 0301: public.is_platform_admin() missing - run 0277 first'; end if;
  if to_regprocedure('auth.jwt()') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'STOP 0301: auth.jwt() / auth.uid() missing'; end if;
end $$;

-- ---- 2) I-05: anon loses its table privileges on the 60 studio tables ------------------------------------------
-- (checked: no row level security policy on any of them lets anon through; no function anon can call reads them
--  as anon; the storage policies anon meets call SECURITY DEFINER helpers only; no public page reads them directly)
do $$ declare t text; r record; begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;
  foreach t in array array[
    'app_config', 'audit_log', 'chair_types', 'change_requests', 'chat_conversations', 'chat_members',
    'chat_messages', 'chat_reactions', 'checklist_templates', 'crew_members', 'design_stages', 'dish_catalog',
    'event_attendees', 'event_checklist', 'event_costs', 'event_day', 'event_discovery', 'event_files',
    'event_guests', 'event_issues', 'event_media', 'event_menu_items', 'event_plan', 'event_proposal',
    'event_ratings', 'event_refunds', 'event_requirements', 'event_resource_needs', 'event_resources',
    'event_stock_requests', 'event_tasks', 'expense_claims', 'inventory_checkouts', 'inventory_items',
    'inventory_reservations', 'layout_rules', 'lead_archive', 'leads', 'menu_templates', 'notification_seen',
    'notifications', 'nurture', 'nurture_automation', 'nurture_templates', 'organizations', 'payment_milestones',
    'plate_types', 'proposal_risks', 'quotation_versions', 'quote_consents', 'quote_otps', 'quote_payments',
    'quote_versions', 'quotes', 'role_access', 'run_sheet_items', 'task_templates', 'vendor_bills', 'vendors',
    'work_tokens'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon', t);
      -- a column-level grant to anon (if one was ever made) goes too
      for r in select a.attname from pg_attribute a
                where a.attrelid = to_regclass('public.' || t) and a.attnum > 0 and not a.attisdropped
                  and a.attacl is not null
                  and exists (select 1 from aclexplode(a.attacl) x where x.grantee = 'anon'::regrole) loop
        execute format('revoke all (%I) on table public.%I from anon', r.attname, t);
      end loop;
    end if;
  end loop;
end $$;

-- ---- 3) I-06: the two kept copies of the upload name guard are no longer callable by the app ------------------
do $$ declare f text; begin
  foreach f in array array['public.storage_object_name_ok__pre0069(text,text)', 'public.storage_object_name_ok__pre0256(text,text)'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public', f);
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on function %s from anon', f); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on function %s from authenticated', f); end if;
    end if;
  end loop;
end $$;

-- ---- 4) keep the previous bodies once (copy-once; a re-run leaves the kept copies alone) ----------------------
-- (copied, not renamed: the layouts / saved_views triggers point at the functions themselves and must keep doing so)
do $$
declare f record; v_src text;
begin
  for f in select * from (values
      ('_layouts_stamp_org'), ('tg_saved_views_guard'), ('layouts_quarantined_count')) v(n) loop
    v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || f.n || '()'));
    if to_regprocedure('public.' || f.n || '__pre0301()') is null and v_src is not null
       and position('r60-db-0301' in v_src) = 0 then
      execute replace(pg_get_functiondef(to_regprocedure('public.' || f.n || '()')),
                      'public.' || f.n || '(', 'public.' || f.n || '__pre0301(');
    end if;
    if to_regprocedure('public.' || f.n || '__pre0301()') is not null then
      execute format('revoke all on function public.%I() from public', f.n || '__pre0301');
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on function public.%I() from anon', f.n || '__pre0301'); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on function public.%I() from authenticated', f.n || '__pre0301'); end if;
    end if;
  end loop;
end $$;

-- ---- 5) layouts: a layout for another studio is refused (no longer silently moved to the caller's studio) ------
create or replace function public._layouts_stamp_org()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r60-db-0301: an app caller (signed in / anon) may only save in its own studio: no studio given -> its own studio
-- (as before); its own studio -> kept; another studio -> 42501 (was: silently rewritten). A direct database /
-- service session keeps the studio it names (was: set to the caller's studio, i.e. none -> refused as no studio).
declare v_org uuid := public.current_org_id();
begin
  if coalesce(auth.jwt() ->> 'role', '') in ('authenticated', 'anon') then
    if new.org_id is not null and new.org_id is distinct from v_org then
      raise exception 'not authorized: a floor layout can only be saved in your own studio' using errcode = '42501';
    end if;
    new.org_id := v_org;
  else
    new.org_id := coalesce(new.org_id, v_org);
  end if;
  return new;
end $$;
revoke all on function public._layouts_stamp_org() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._layouts_stamp_org() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._layouts_stamp_org() from authenticated; end if;
end $$;

-- ---- 6) saved_views: another studio / another owner on insert is refused (was: silently rewritten) -------------
create or replace function public.tg_saved_views_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r60-db-0301 (saved-views-0064 + an explicit refusal of a forged studio / owner on insert)
declare v_me uuid := auth.uid(); v_org uuid; v_n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('authenticated', 'anon') then
    new.updated_at := now(); return new; end if;                                   -- service role / maintenance
  v_org := public.current_org_id();
  if v_me is null or v_org is null or not exists (
       select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and p.role is not null and p.role <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then
    if new.org_id is not null and new.org_id is distinct from v_org then
      raise exception 'not authorized: a saved view can only be saved in your own studio' using errcode = '42501'; end if;
    if new.user_id is not null and new.user_id is distinct from v_me then
      raise exception 'not authorized: a saved view belongs to the person who saves it' using errcode = '42501'; end if;
    new.user_id := v_me; new.org_id := v_org; new.created_at := now();
    select count(*) into v_n from public.saved_views s where s.user_id = v_me and s.page = new.page;
    if v_n >= 50 then raise exception 'too many saved views for this page' using errcode = '54000'; end if;
  else
    if new.user_id is distinct from old.user_id or new.org_id is distinct from old.org_id or new.id is distinct from old.id then
      raise exception 'owner and studio cannot change' using errcode = '42501'; end if;
    new.created_at := old.created_at;
  end if;
  if new.shared and (tg_op = 'INSERT' or not old.shared) and not public.is_admin() then
    raise exception 'only studio admins can share a view' using errcode = '42501'; end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.tg_saved_views_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.tg_saved_views_guard() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.tg_saved_views_guard() from authenticated; end if;
end $$;

-- ---- 7) I-07: the platform-wide "layouts without a studio" number is for Helm HQ only ---------------------------
create or replace function public.layouts_quarantined_count()
returns bigint language plpgsql stable security definer set search_path = '' as $$
-- r60-db-0301: Helm HQ staff (two-step) or a direct database / service session only; a studio member gets 42501
begin
  if coalesce(auth.jwt() ->> 'role', '') in ('authenticated', 'anon') and not coalesce(public.is_platform_admin(), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return (select count(*) from public.layouts l where l.org_id is null);
end $$;
revoke all on function public.layouts_quarantined_count() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.layouts_quarantined_count() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.layouts_quarantined_count() to authenticated; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 anon holds no privilege on any of the 60 studio tables',
     not exists (select 1 from pg_roles where rolname = 'anon') or not exists (
       select 1 from unnest(array['app_config', 'audit_log', 'chair_types', 'change_requests', 'chat_conversations', 'chat_members',
         'chat_messages', 'chat_reactions', 'checklist_templates', 'crew_members', 'design_stages', 'dish_catalog',
         'event_attendees', 'event_checklist', 'event_costs', 'event_day', 'event_discovery', 'event_files',
         'event_guests', 'event_issues', 'event_media', 'event_menu_items', 'event_plan', 'event_proposal',
         'event_ratings', 'event_refunds', 'event_requirements', 'event_resource_needs', 'event_resources',
         'event_stock_requests', 'event_tasks', 'expense_claims', 'inventory_checkouts', 'inventory_items',
         'inventory_reservations', 'layout_rules', 'lead_archive', 'leads', 'menu_templates', 'notification_seen',
         'notifications', 'nurture', 'nurture_automation', 'nurture_templates', 'organizations', 'payment_milestones',
         'plate_types', 'proposal_risks', 'quotation_versions', 'quote_consents', 'quote_otps', 'quote_payments',
         'quote_versions', 'quotes', 'role_access', 'run_sheet_items', 'task_templates', 'vendor_bills', 'vendors',
         'work_tokens']) t
        where to_regclass('public.' || t) is not null
          and (has_table_privilege('anon', to_regclass('public.' || t), 'select') or has_table_privilege('anon', to_regclass('public.' || t), 'insert')
               or has_table_privilege('anon', to_regclass('public.' || t), 'update') or has_table_privilege('anon', to_regclass('public.' || t), 'delete')
               or has_any_column_privilege('anon', to_regclass('public.' || t), 'select')))),
  ('02 signed-in members can still read and write their studio tables (quotes, leads, layouts, saved_views)',
     has_table_privilege('authenticated', 'public.quotes', 'select') and has_table_privilege('authenticated', 'public.leads', 'insert')
     and has_table_privilege('authenticated', 'public.layouts', 'insert') and has_table_privilege('authenticated', 'public.saved_views', 'insert')),
  ('03 signed-out link functions still callable by anon (portal, quote, event site)',
     not exists (select 1 from pg_roles where rolname = 'anon') or (
       has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
       and has_function_privilege('anon', 'public.public_event_site(text)', 'execute'))),
  ('04 kept upload-guard copies not callable by the app',
     not has_function_privilege('authenticated', 'public.storage_object_name_ok__pre0069(text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.storage_object_name_ok__pre0256(text,text)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or (not has_function_privilege('anon', 'public.storage_object_name_ok__pre0069(text,text)', 'execute')
              and not has_function_privilege('anon', 'public.storage_object_name_ok__pre0256(text,text)', 'execute')))),
  ('05 the live upload guard still callable (storage policies use it)',
     has_function_privilege('authenticated', 'public.storage_object_name_ok(text,text)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or has_function_privilege('anon', 'public.storage_object_name_ok(text,text)', 'execute'))),
  ('06 no storage policy calls a kept copy by name',
     not exists (select 1 from pg_policies p where coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'storage_object_name_ok__pre')),
  ('07 layouts_quarantined_count is the 0301 body (HQ two-step only)',
     position('r60-db-0301' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.layouts_quarantined_count()')), '')) > 0
     and position('is_platform_admin' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.layouts_quarantined_count()')), '')) > 0),
  ('08 layouts_quarantined_count: anon cannot call it',
     not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.layouts_quarantined_count()', 'execute')),
  ('09 layouts trigger is the 0301 body and still attached',
     position('r60-db-0301' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._layouts_stamp_org()')), '')) > 0
     and exists (select 1 from pg_trigger t where t.tgrelid = 'public.layouts'::regclass and not t.tgisinternal
                    and t.tgfoid = to_regprocedure('public._layouts_stamp_org()'))),
  ('10 saved views guard is the 0301 body and still attached',
     position('r60-db-0301' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.tg_saved_views_guard()')), '')) > 0
     and exists (select 1 from pg_trigger t where t.tgrelid = 'public.saved_views'::regclass and not t.tgisinternal
                    and t.tgfoid = to_regprocedure('public.tg_saved_views_guard()'))),
  ('11 previous bodies kept once as *__pre0301',
     to_regprocedure('public._layouts_stamp_org__pre0301()') is not null and to_regprocedure('public.tg_saved_views_guard__pre0301()') is not null
     and to_regprocedure('public.layouts_quarantined_count__pre0301()') is not null),
  ('12 the kept copies are not callable by the app',
     not has_function_privilege('authenticated', 'public._layouts_stamp_org__pre0301()', 'execute')
     and not has_function_privilege('authenticated', 'public.tg_saved_views_guard__pre0301()', 'execute')
     and not has_function_privilege('authenticated', 'public.layouts_quarantined_count__pre0301()', 'execute')),
  ('13 the three re-issued functions are security definer with an empty search path',
     (select count(*) from pg_proc p where p.oid in (to_regprocedure('public._layouts_stamp_org()'), to_regprocedure('public.tg_saved_views_guard()'),
        to_regprocedure('public.layouts_quarantined_count()')) and p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') = 3),
  ('14 nothing removed: layouts, saved_views, quotes, leads still there',
     to_regclass('public.layouts') is not null and to_regclass('public.saved_views') is not null
     and to_regclass('public.quotes') is not null and to_regclass('public.leads') is not null)
) v(item, ok) order by item;
