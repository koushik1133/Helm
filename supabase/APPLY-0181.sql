-- APPLY-0181.sql - paste into the Supabase SQL editor (staging first, then production). Needs 0173 applied first.
-- Free-trial server guards. Affects FREE TRIAL studios only (studio_subscriptions.status = 'trial'); paid studios unchanged.
-- Additive + idempotent: 1 new table (trial_create_log, starts empty, RLS on, no app access), new helper / trigger
-- functions + triggers, 8 RPCs wrapped (originals kept as *__pre0181), my_trial_limits re-created (same shape).
-- No existing table, column or row is changed or removed. Safe to run twice.
-- Rollback note: see the ROLLBACK paragraph at the top of the migration below (manual, function/trigger level only; no data involved).
begin;
-- 0181_trial_guards.sql - CANONICAL forward-only.
-- REQUIRES 0173 (_tl173_trial_locked / _tl173_guard / my_trial_limits / zzzz_tl173_cap), 0166 (_is_trial_org),
--          0164 (_is_system_change), 0097 (is_demo + zz_a97_demo_flag_guard), 0088 (custom_field_defs),
--          0096 (studio_template_*), 0129 (event_reminder_settings_set), 0157 (privacy_pin_set / _reset),
--          0078 / 0092 (payment_reminder_send_now).
--
-- In plain words (FREE TRIAL studios only: _is_trial_org() = studio_subscriptions.status 'trial', never
-- trial_ends_at; a paid studio never reaches a new check; the sample master studio and Helm's own system
-- work (seed, clone, Clear sample data, migrations) are exempt, exactly as in 0173):
--   1  More settings are refused on the server in the trial (same-signature wrappers, originals kept as
--      <name>__pre0181 with no app grants): layout templates (studio_template_save / _set_archived /
--      _set_default / _duplicate), the team event-reminder days (event_reminder_settings_set), the privacy
--      PIN (privacy_pin_set / privacy_pin_reset) and "Send reminder now" to a client
--      (payment_reminder_send_now). Reading is unchanged: the sample layouts still load in the builder and
--      privacy_pin_status / privacy_pin_check still unlock with the default PIN.
--   2  Custom fields: a trial studio cannot add, change or remove custom field definitions (custom_field_defs).
--   3  Menu & catalog (dish_catalog, menu_templates, chair_types, plate_types): in the trial only prices
--      change (chair / plate price, a package's price per plate, and a package's dish list). Rename, switching
--      an item off / on and removing it (delete) are refused. A price change keeps a sample row a sample row
--      (is_demo stays true), so "Clear sample data" still removes it.
--   4  Creation cap = 2 created IN TOTAL per list (leads, events / quotes, inventory items, vendors, staff,
--      venues). New table trial_create_log remembers every own row a trial studio adds, so deleting a row
--      never frees a slot; every own row that still exists (soft-deleted, shelved, archived, inactive) counts
--      too. A restored row with an id that was already counted comes back without using a new slot.
--      my_trial_limits() reports the same numbers. The 0173 cap trigger stays (it can only be stricter-or-equal).
--   Nothing is deleted or rewritten: 1 new table (starts empty), new functions + triggers, 8 RPCs wrapped.
--   No DELETE / TRUNCATE / DROP of data. Safe to run twice (a re-run only re-creates the wrappers and
--   functions; triggers are added only when missing).
--   ROLLBACK (manual, only if ever needed; no data involved): for each wrapped f: drop function public.f(args);
--   alter function public.f__pre0181(args) rename to f; re-grant execute as before; drop the zzzz_tl181_*
--   triggers. trial_create_log can stay (nothing reads it then).

do $$ begin
  if to_regprocedure('public._tl173_trial_locked(uuid)') is null or to_regprocedure('public._tl173_guard()') is null then
    raise exception 'STOP: 0173 (trial lockdown) is not applied'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then raise exception 'STOP: 0166 (_is_trial_org) is not applied'; end if;
  if to_regprocedure('public._is_system_change()') is null then raise exception 'STOP: 0164 (_is_system_change) is not applied'; end if;
end $$;

-- ---- 4a) the creation log (bookkeeping only: ids, no personal data) --------------------------------
create table if not exists public.trial_create_log (
  org_id     uuid        not null,
  entity     text        not null,
  row_id     text        not null,
  created_at timestamptz not null default now(),
  primary key (org_id, entity, row_id)
);
alter table public.trial_create_log enable row level security;
revoke all on table public.trial_create_log from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.trial_create_log from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.trial_create_log from authenticated'; end if;
  -- the same read-only guard as every studio table (a row is only logged when its own insert passed it anyway)
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.trial_create_log'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.trial_create_log for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- own rows a trial studio has created IN TOTAL in one list: remembered in the log (deleted ones included)
-- + own rows that exist but are not in the log (made before 0181, or sample rows the studio adopted)
create or replace function public._tl181_used(p_org uuid, p_table text)
returns integer language plpgsql stable security definer set search_path = '' as $$
-- trial-guards-0181
declare n integer;
begin
  if p_org is null or p_table is null
     or p_table not in ('leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues') then return 0; end if;
  execute format('select (select count(*) from public.trial_create_log l where l.org_id = $1 and l.entity = $2)::integer
                       + (select count(*) from public.%I x where x.org_id = $1 and not x.is_demo
                            and not exists (select 1 from public.trial_create_log l
                                             where l.org_id = $1 and l.entity = $2 and l.row_id = x.id::text))::integer', p_table)
    into n using p_org, p_table;
  return coalesce(n, 0);
end $$;

create or replace function public._tl181_tg_cap_check()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: 2 own rows created IN TOTAL per list in the free trial
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  -- a restored row (same id) that was already counted comes back without using a new slot
  if exists (select 1 from public.trial_create_log l
              where l.org_id = new.org_id and l.entity = tg_table_name and l.row_id = new.id::text) then
    return new;
  end if;
  if public._tl181_used(new.org_id, tg_table_name) >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

create or replace function public._tl181_tg_cap_log()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: remember the own row the trial studio just added (AFTER INSERT: only rows really saved)
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return null; end if;
  if public._is_system_change() then return null; end if;
  if not public._tl173_trial_locked(new.org_id) then return null; end if;
  insert into public.trial_create_log(org_id, entity, row_id) values (new.org_id, tg_table_name, new.id::text)
    on conflict do nothing;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl181_cap') then
      execute format('create trigger zzzz_tl181_cap before insert on public.%I for each row execute function public._tl181_tg_cap_check()', t);
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl181_cap_log') then
      execute format('create trigger zzzz_tl181_cap_log after insert on public.%I for each row execute function public._tl181_tg_cap_log()', t);
    end if;
  end loop;
end $$;

-- what the app may show before the server refuses (same shape as 0173; "used" now counts in total)
create or replace function public.my_trial_limits()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-lockdown-0173 + trial-guards-0181
declare v_org uuid := public.current_org_id(); v_used jsonb := '{}'::jsonb; t text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._tl173_trial_locked(v_org) then return jsonb_build_object('trial', false); end if;
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    v_used := v_used || jsonb_build_object(t, public._tl181_used(v_org, t));
  end loop;
  return jsonb_build_object('trial', true, 'cap', 2, 'used', v_used);
end $$;

-- ---- 3) menu & catalog: prices only ------------------------------------------------------------------
create or replace function public._tl181_tg_catalog_edit()
returns trigger language plpgsql set search_path = '' as $$
-- trial-guards-0181: SECURITY INVOKER on purpose (current_user = the app role). Only direct app edits are
-- checked; Helm's own functions (trial seed, clone, Clear sample data) still change these rows.
declare v_ok text[]; v_skip text[] := array['is_demo', 'updated_at', 'updated_by'];
begin
  if current_user not in ('anon', 'authenticated') or not public._tl173_trial_locked(old.org_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'In the free trial you can change prices, but not remove menu or catalog items. Upgrade to change them.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  v_ok := case tg_table_name when 'menu_templates' then array['price_per_plate', 'dishes']
                             when 'dish_catalog' then array[]::text[]
                             else array['price'] end;
  if (to_jsonb(new) - v_ok - v_skip) is distinct from (to_jsonb(old) - v_ok - v_skip) then
    raise exception 'In the free trial you can change prices, but not rename, switch off or remove menu or catalog items. Upgrade to change them.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  -- a price change keeps a sample row a sample row (0097 marks a renamed sample row as the studio's own;
  -- nothing can be renamed here), so Clear sample data still removes it
  if coalesce((to_jsonb(old) ->> 'is_demo')::boolean, false) and not coalesce((to_jsonb(new) ->> 'is_demo')::boolean, true) then
    new := jsonb_populate_record(new, jsonb_build_object('is_demo', true));
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['dish_catalog', 'menu_templates', 'chair_types', 'plate_types'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl181_catalog') then
      execute format('create trigger zzzz_tl181_catalog before update or delete on public.%I for each row execute function public._tl181_tg_catalog_edit()', t);
    end if;
  end loop;
end $$;

-- ---- 2) custom field definitions: not in the trial ------------------------------------------------
create or replace function public._tl181_tg_custom_fields()
returns trigger language plpgsql set search_path = '' as $$
-- trial-guards-0181: SECURITY INVOKER on purpose (current_user = the app role); Helm's own functions are not checked
declare v_org uuid;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; else v_org := new.org_id; end if;
  if current_user in ('anon', 'authenticated') and public._tl173_trial_locked(v_org) then
    raise exception 'Custom fields are not part of the free trial. Upgrade to add your own fields.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

do $$ begin
  if to_regclass('public.custom_field_defs') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.custom_field_defs'::regclass and tgname = 'zzzz_tl181_custom_fields') then
    create trigger zzzz_tl181_custom_fields before insert or update or delete on public.custom_field_defs
      for each row execute function public._tl181_tg_custom_fields();
  end if;
end $$;

-- ---- 1) wrapped RPCs (same pattern as 0173) ---------------------------------------------------------
do $$
declare
  f text; v_new boolean; v_old regprocedure; v_pre regprocedure; v_name text; v_args text; v_idargs text; v_ret text; v_call text; n int; g record;
begin
  foreach f in array array[
    'public.studio_template_save(uuid,jsonb)', 'public.studio_template_set_archived(uuid,boolean)',
    'public.studio_template_set_default(uuid,boolean)', 'public.studio_template_duplicate(uuid)',
    'public.event_reminder_settings_set(integer)',
    'public.privacy_pin_set(text,text)', 'public.privacy_pin_reset()',
    'public.payment_reminder_send_now(uuid)'] loop
    v_old := to_regprocedure(f);
    if v_old is null then continue; end if;
    select p.proname, pg_get_function_arguments(p.oid), oidvectortypes(p.proargtypes), pg_get_function_result(p.oid), p.pronargs
      into v_name, v_args, v_idargs, v_ret, n from pg_proc p where p.oid = v_old;
    v_pre := to_regprocedure(format('public.%I(%s)', v_name || '__pre0181', v_idargs));
    v_new := false;
    if v_pre is null then
      -- first run: keep the original under __pre0181 (its grants move with it), then build the wrapper
      execute format('alter function public.%I(%s) rename to %I', v_name, v_idargs, v_name || '__pre0181');
      v_new := true;
    end if;
    select string_agg('$' || i, ', ' order by i) into v_call from generate_series(1, greatest(n, 1)) i where i <= n;
    execute format($w$create or replace function public.%I(%s) returns %s language plpgsql volatile security definer set search_path = '' as $b$
-- trial-guards-0181: free trial check, then the original
begin
  perform public._tl173_guard();
  return public.%I(%s);
end $b$
$w$, v_name, v_args, v_ret, v_name || '__pre0181', coalesce(v_call, ''));
    -- grants (only when the wrapper is new; a re-run keeps what is there): wrapper = the original's
    -- grants; the kept original = definer / service role only
    continue when not v_new;
    execute format('revoke all on function public.%I(%s) from public', v_name, v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name, v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name, v_idargs); end if;
    for g in select distinct r.rolname from pg_proc p, lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
              where p.oid = to_regprocedure(format('public.%I(%s)', v_name || '__pre0181', v_idargs)) and a.privilege_type = 'EXECUTE'
                and r.rolname in ('anon', 'authenticated', 'service_role') loop
      execute format('grant execute on function public.%I(%s) to %I', v_name, v_idargs, g.rolname);
    end loop;
    execute format('revoke all on function public.%I(%s) from public', v_name || '__pre0181', v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name || '__pre0181', v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name || '__pre0181', v_idargs); end if;
  end loop;
end $$;

-- ---- privileges --------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._tl181_used(uuid,text)', 'public._tl181_tg_cap_check()', 'public._tl181_tg_cap_log()',
                           'public._tl181_tg_catalog_edit()', 'public._tl181_tg_custom_fields()', 'public.my_trial_limits()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_trial_limits() to authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 8 RPCs wrapped (original kept)', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0181') = 8),
  ('02 wrappers carry the trial check', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and position('trial-guards-0181' in p.prosrc) > 0
       and to_regprocedure('public.' || p.proname || '__pre0181(' || oidvectortypes(p.proargtypes) || ')') is not null) = 8),
  ('03 kept originals not callable by the app', not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0181'
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  ('04 wrappers still callable by signed-in users', has_function_privilege('authenticated', 'public.studio_template_save(uuid,jsonb)', 'execute')
       and has_function_privilege('authenticated', 'public.event_reminder_settings_set(integer)', 'execute')
       and has_function_privilege('authenticated', 'public.privacy_pin_set(text,text)', 'execute')
       and has_function_privilege('authenticated', 'public.payment_reminder_send_now(uuid)', 'execute')),
  ('05 cap check + log triggers on 6 tables', (select count(*) from pg_trigger where tgname = 'zzzz_tl181_cap') = 6
       and (select count(*) from pg_trigger where tgname = 'zzzz_tl181_cap_log') = 6),
  ('06 catalog prices-only trigger on 4 tables', (select count(*) from pg_trigger where tgname = 'zzzz_tl181_catalog') = 4),
  ('07 custom field trigger', exists (select 1 from pg_trigger where tgrelid = 'public.custom_field_defs'::regclass and tgname = 'zzzz_tl181_custom_fields')),
  ('08 trial_create_log: RLS on, no app access, read-only guard', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_create_log')), false)
       and not has_table_privilege('authenticated', 'public.trial_create_log', 'select')
       and not has_table_privilege('anon', 'public.trial_create_log', 'select')
       and exists (select 1 from pg_trigger where tgrelid = to_regclass('public.trial_create_log') and tgname = 'zzz_studio_read_only')),
  ('09 helper / trigger functions not callable by the app', not has_function_privilege('authenticated', 'public._tl181_used(uuid,text)', 'execute')
       and not has_function_privilege('authenticated', 'public._tl181_tg_cap_check()', 'execute')
       and not has_function_privilege('authenticated', 'public._tl181_tg_cap_log()', 'execute')
       and not has_function_privilege('authenticated', 'public._tl181_tg_catalog_edit()', 'execute')
       and not has_function_privilege('authenticated', 'public._tl181_tg_custom_fields()', 'execute')),
  ('10 my_trial_limits callable by signed-in users, counts in total', has_function_privilege('authenticated', 'public.my_trial_limits()', 'execute')
       and position('_tl181_used' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_limits()'))) > 0),
  ('11 0173 still in place', (select count(*) from pg_trigger where tgname = 'zzzz_tl173_cap') = 6),
  ('12 trial studios affected: ' || (select count(*) from public.studio_subscriptions where status = 'trial')::text, true)
) v(item, ok) order by item;
