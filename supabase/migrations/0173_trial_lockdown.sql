-- 0173_trial_lockdown.sql - CANONICAL forward-only. REQUIRES 0166 (_is_trial_org), 0097 (is_demo), 0164 (_is_system_change).
--
-- In plain words (FREE TRIAL studios only; a paid studio never reaches any new check):
--   1  Creation cap: a trial studio may add at most 2 of its OWN rows (is_demo = false) per main
--      list: leads (clients), events / quotes, inventory items, vendors, staff, venues. Sample rows
--      (is_demo) do not count. The 3rd is refused: "Free trial limit reached (2). Upgrade to add more."
--   2  Menu & catalog: a trial studio can edit prices of existing dishes / packages / chair and plate
--      types, but cannot ADD new ones (dish_catalog, menu_templates, chair_types, plate_types).
--   3  Studio settings: a trial studio cannot change its studio / branding / billing details
--      (direct organizations UPDATE from the app), the studio account, the client link name,
--      client-link auto-expire, notification rules, photo-render settings.
--   4  Downloads / import / photo renders: the studio data archive + data export, Excel/CSV
--      smart import and photo renders (photo_render_begin) are refused for a trial studio.
--   5  my_trial_limits(): {trial, cap, used{...}} so the app can say so before the server refuses.
--   Every guard first asks _is_trial_org(); false -> unchanged behaviour. The sample master studio
--   and system work (clone, seed, migrations: no API claims) are exempt.
--   Wrapped RPCs: the original is kept as <name>__pre0173 (no grants) and a same-signature wrapper
--   (original grants copied) checks the trial, then calls it. Nothing is deleted. Safe to run twice.
--   A re-run only re-creates the wrappers (create or replace keeps their grants); nothing is dropped.
--   ROLLBACK (manual, only if ever needed): for each wrapped f: drop function public.f(args);
--   alter function public.f__pre0173(args) rename to f; re-grant execute as before; drop the
--   zzzz_tl173_* triggers. No data is touched either way.

-- ---- helpers --------------------------------------------------------------------------------------
create or replace function public._tl173_trial_locked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-lockdown-0173: a trial studio (not the sample master) acting through the app
  select p_org is not null and public._is_trial_org(p_org)
     and not coalesce((select o.is_sample_master from public.organizations o where o.id = p_org), false);
$$;

create or replace function public._tl173_guard()
returns void language plpgsql stable security definer set search_path = '' as $$
-- trial-lockdown-0173: refuse a studio setting / download / import / render in the free trial
begin
  if public._tl173_trial_locked(public.current_org_id()) then
    raise exception 'Not available in the free trial. Upgrade to use this.' using errcode = '42501', hint = 'trial_locked';
  end if;
end $$;

-- ---- 1) creation cap (2 own rows per main list) ------------------------------------------------
create or replace function public._tl173_tg_create_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-lockdown-0173
declare v_n integer;
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  execute format('select count(*) from public.%I x where x.org_id = $1 and not x.is_demo', tg_table_name) into v_n using new.org_id;
  if v_n >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl173_cap') then
      execute format('create trigger zzzz_tl173_cap before insert on public.%I for each row execute function public._tl173_tg_create_cap()', t);
    end if;
  end loop;
end $$;

-- ---- 2) menu & catalog: prices editable, no new rows -------------------------------------------
create or replace function public._tl173_tg_no_add()
returns trigger language plpgsql set search_path = '' as $$
-- trial-lockdown-0173: SECURITY INVOKER on purpose (current_user = the app role). Only direct app
-- inserts are refused; Helm's own functions (trial start seed, clone) still add the starter catalog.
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if new.org_id is null or coalesce((to_jsonb(new) ->> 'is_demo')::boolean, false) then return new; end if;
  if public._tl173_trial_locked(new.org_id) then
    raise exception 'In the free trial you can change prices, but not add new menu or catalog items. Upgrade to add more.'
      using errcode = '42501', hint = 'trial_locked';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['dish_catalog', 'menu_templates', 'chair_types', 'plate_types'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tl173_no_add') then
      execute format('create trigger zzzz_tl173_no_add before insert on public.%I for each row execute function public._tl173_tg_no_add()', t);
    end if;
  end loop;
end $$;

-- ---- 3a) studio / branding / billing details: no direct app edits in the trial ---------------------
create or replace function public._tl173_tg_org_lock()
returns trigger language plpgsql set search_path = '' as $$
-- trial-lockdown-0173: SECURITY INVOKER on purpose (current_user = the app role). Only direct app
-- edits are refused; Helm's own functions (welcome set-up, clone) still work.
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if public._tl173_trial_locked(old.id) then
    raise exception 'Studio settings are fixed in the free trial. Upgrade to change them.' using errcode = '42501', hint = 'trial_locked';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname = 'zzzz_tl173_org_lock') then
    create trigger zzzz_tl173_org_lock before update on public.organizations for each row execute function public._tl173_tg_org_lock();
  end if;
end $$;

-- ---- 3b / 4) wrapped RPCs ---------------------------------------------------------------------------
do $$
declare
  f text; v_new boolean; v_old regprocedure; v_pre regprocedure; v_name text; v_args text; v_idargs text; v_ret text; v_call text; n int; g record;
begin
  foreach f in array array[
    'public.export_tenant_organization_package()', 'public.export_org_data()',
    'public.smart_import_batch(text,jsonb,jsonb)',
    'public.my_studio_account_update(jsonb)', 'public.set_studio_link_name(text)',
    'public.admin_set_link_autoexpire(boolean,integer)', 'public.admin_set_link_expiry_shelf(text)',
    'public.admin_set_notification_pref(text,text,text,boolean,uuid)', 'public.admin_reset_notification_prefs()',
    'public.photo_render_settings_set(boolean,integer,integer)',
    'public.photo_render_begin(uuid,integer,text,text,text,numeric)'] loop
    v_old := to_regprocedure(f);
    if v_old is null then continue; end if;
    select p.proname, pg_get_function_arguments(p.oid), oidvectortypes(p.proargtypes), pg_get_function_result(p.oid), p.pronargs
      into v_name, v_args, v_idargs, v_ret, n from pg_proc p where p.oid = v_old;
    v_pre := to_regprocedure(format('public.%I(%s)', v_name || '__pre0173', v_idargs));
    v_new := false;
    if v_pre is null then
      -- first run: keep the original under __pre0173 (its grants move with it), then build the wrapper
      execute format('alter function public.%I(%s) rename to %I', v_name, v_idargs, v_name || '__pre0173');
      v_new := true;
    end if;
    select string_agg('$' || i, ', ' order by i) into v_call from generate_series(1, greatest(n, 1)) i where i <= n;
    execute format($w$create or replace function public.%I(%s) returns %s language plpgsql volatile security definer set search_path = '' as $b$
-- trial-lockdown-0173: free trial check, then the original
begin
  perform public._tl173_guard();
  return public.%I(%s);
end $b$
$w$, v_name, v_args, v_ret, v_name || '__pre0173', coalesce(v_call, ''));
    -- grants (only when the wrapper is new; a re-run keeps what is there): wrapper = the original's
    -- grants; the kept original = definer / service role only
    continue when not v_new;
    execute format('revoke all on function public.%I(%s) from public', v_name, v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name, v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name, v_idargs); end if;
    for g in select distinct r.rolname from pg_proc p, lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
              where p.oid = to_regprocedure(format('public.%I(%s)', v_name || '__pre0173', v_idargs)) and a.privilege_type = 'EXECUTE'
                and r.rolname in ('anon', 'authenticated', 'service_role') loop
      execute format('grant execute on function public.%I(%s) to %I', v_name, v_idargs, g.rolname);
    end loop;
    execute format('revoke all on function public.%I(%s) from public', v_name || '__pre0173', v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name || '__pre0173', v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name || '__pre0173', v_idargs); end if;
  end loop;
end $$;

-- ---- 5) what the app may show before the server refuses ----------------------------------------------
create or replace function public.my_trial_limits()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-lockdown-0173
declare v_org uuid := public.current_org_id(); v_used jsonb := '{}'::jsonb; t text; n integer;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._tl173_trial_locked(v_org) then return jsonb_build_object('trial', false); end if;
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    execute format('select count(*) from public.%I x where x.org_id = $1 and not x.is_demo', t) into n using v_org;
    v_used := v_used || jsonb_build_object(t, n);
  end loop;
  return jsonb_build_object('trial', true, 'cap', 2, 'used', v_used);
end $$;

-- ---- privileges --------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._tl173_trial_locked(uuid)', 'public._tl173_guard()', 'public._tl173_tg_create_cap()',
                           'public._tl173_tg_no_add()', 'public._tl173_tg_org_lock()', 'public.my_trial_limits()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_trial_limits() to authenticated;
    grant execute on function public._tl173_trial_locked(uuid) to authenticated;   -- the invoker org trigger asks it
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public._tl173_trial_locked(uuid) to anon;
  end if;
end $$;
