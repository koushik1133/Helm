-- APPLY 0127 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- ============================================================================
-- 0127_trial_fresh_start.sql - CANONICAL forward-only. REQUIRES 0042 (helm_env_settings),
-- 0097 (is_demo, _demo_clear), 0116/0119 (start_self_serve_trial), 0123 (my_demo_status).
--
-- In plain words:
--   1) Every free trial is still its OWN studio ("Demo 1", "Demo 2", ...). Nothing is shared.
--      Each one gets the same built-in sample data (0100 _demo_seed + 0116/0122
--      _trial_seed_extra): inventory, vendors, staff, menu packages (templates), venues,
--      dishes, sample leads and events. Every sample row is is_demo = true and named "Demo \u00b7 ...".
--
--   2) OWNER-REPLACEABLE SAMPLE DATA (marker: helm-0127-trial-seed-config).
--      The owner can add their own trial data later WITHOUT a code change: put a jsonb into
--      helm_env_settings under key 'trial_demo_seed' (service role / SQL editor only). Shape:
--        {"inventory":[{"name":"Chairs","category":"Furniture","qty":100,"unit":"pcs","unit_cost":40}],
--         "vendors":  [{"name":"ABC Tents","category":"Tents","kind":"rental","phone":"","email":""}],
--         "staff":    [{"name":"Ravi","department":"Operations","role":"Manager","emp_type":"full_time","day_rate":3000}],
--         "templates":[{"name":"Gold Veg","tier":"gold","diet":"veg","price_per_plate":900,"dishes":[]}]}
--      When the key is missing (the default) nothing extra happens and trials get exactly
--      today's built-in sample set. When it is set, each NEW trial also gets these rows,
--      tagged is_demo = true and prefixed "Demo \u00b7 " so "Start fresh" can find and remove them.
--      Hooked by an AFTER UPDATE trigger on organizations that fires only at the moment a
--      demo-mode trial starts (trial_ends_at null -> set, trial_mode = 'demo'); a failure is
--      swallowed and can never block the trial. Studios that are not trials never fire it.
--
--   3) CONVERSION CHOICE (marker: helm-0127-demo-choice). After a trial studio subscribes the
--      admin picks "Start fresh" (removes ONLY this studio's is_demo rows through the existing
--      _demo_clear - the same code clear_demo_data uses) or "Keep the sample data". The choice is
--      recorded on the studio (two NEW nullable columns) and in audit_log. Admin only, own studio
--      only, trial studios only (organizations.trial_ends_at not null).
--
--   4) my_demo_status(): 0123 body + two read-only keys: demo_choice, choice_pending.
--
--   Changes: 2 nullable columns added, 3 functions added, 1 function body re-issued, 1 trigger.
--   No table/row is dropped or rewritten. Non-trial studios: no behaviour change.
--   Additive + idempotent: safe to run twice. ASCII only (the dot is written as \u00b7).
-- ============================================================================

alter table public.organizations add column if not exists demo_choice text;
alter table public.organizations add column if not exists demo_choice_at timestamptz;
do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_demo_choice_chk127') then
    alter table public.organizations add constraint organizations_demo_choice_chk127
      check (demo_choice is null or demo_choice in ('fresh','keep'));
  end if;
end $do$;

-- ---- 1) owner-replaceable trial seed --------------------------------------------------------
create or replace function public._trial_seed_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- helm-0127-trial-seed-config: edit helm_env_settings key 'trial_demo_seed' to change it
  select coalesce((select s.value from public.helm_env_settings s where s.key = 'trial_demo_seed'), '{}'::jsonb)
$$;
revoke all on function public._trial_seed_config() from public, anon, authenticated;

create or replace function public._trial_seed_custom(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- helm-0127-trial-seed-config: fill-only, every row is_demo + "Demo \u00b7 " prefix, own org only
declare cfg jsonb := public._trial_seed_config(); x jsonb; n text; v_out jsonb := '{}'::jsonb; c int;
  pfx constant text := E'Demo \u00b7 ';
begin
  if p_org is null then return jsonb_build_object('seeded', false, 'reason', 'no_org'); end if;
  if jsonb_typeof(cfg) is distinct from 'object' or cfg = '{}'::jsonb then
    return jsonb_build_object('seeded', false, 'reason', 'no_config'); end if;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'inventory') = 'array' then cfg->'inventory' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.inventory_items i where i.org_id = p_org and lower(btrim(i.name)) = lower(n)) then continue; end if;
      insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo)
        values (p_org, left(n, 200), coalesce(nullif(x->>'category', ''), 'General'),
                greatest(coalesce((x->>'qty')::numeric, 1), 0)::int, coalesce(nullif(x->>'unit', ''), 'pcs'),
                coalesce(nullif(x->>'priority', ''), 'B'), greatest(coalesce((x->>'unit_cost')::numeric, 0), 0),
                E'Demo item \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('inventory', c);
  exception when others then v_out := v_out || jsonb_build_object('inventory_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'vendors') = 'array' then cfg->'vendors' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.vendors v where v.org_id = p_org and lower(btrim(v.name)) = lower(n)) then continue; end if;
      insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo)
        values (p_org, left(n, 200), coalesce(nullif(x->>'category', ''), 'General'), coalesce(nullif(x->>'kind', ''), 'vendor'),
                nullif(x->>'phone', ''), nullif(x->>'email', ''), E'Demo vendor \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('vendors', c);
  exception when others then v_out := v_out || jsonb_build_object('vendors_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'staff') = 'array' then cfg->'staff' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      if exists (select 1 from public.crew_members m where m.org_id = p_org and m.name = n) then continue; end if;
      insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
        values (p_org, left(n, 200), nullif(x->>'phone', ''), nullif(x->>'department', ''), nullif(x->>'role', ''),
                coalesce(nullif(x->>'emp_type', ''), 'full_time'), greatest(coalesce((x->>'day_rate')::numeric, 0), 0),
                E'Demo staff \u2014 sample data.', true, true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('staff', c);
  exception when others then v_out := v_out || jsonb_build_object('staff_error', sqlstate); end;

  begin c := 0;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(cfg->'templates') = 'array' then cfg->'templates' else '[]'::jsonb end) loop
      n := btrim(coalesce(x->>'name', '')); if n = '' then continue; end if;
      if left(n, length(pfx)) <> pfx then n := pfx || n; end if;
      -- a package fills a free tier + diet slot only (same rule as _demo_seed)
      if exists (select 1 from public.menu_templates t where t.org_id = p_org
                  and (lower(btrim(t.name)) = lower(n) or (t.tier = x->>'tier' and t.diet = x->>'diet'))) then continue; end if;
      insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, is_demo)
        values (p_org, x->>'tier', x->>'diet', left(n, 200), greatest(coalesce((x->>'price_per_plate')::numeric, 0), 0),
                case when jsonb_typeof(x->'dishes') = 'array' then x->'dishes' else '[]'::jsonb end,
                true, 950 + c, E'Demo package \u2014 sample data.', true);
      c := c + 1;
    end loop;
    v_out := v_out || jsonb_build_object('templates', c);
  exception when others then v_out := v_out || jsonb_build_object('templates_error', sqlstate); end;

  return jsonb_build_object('seeded', true) || v_out;
end $$;
revoke all on function public._trial_seed_custom(uuid) from public, anon, authenticated;

create or replace function public._tg_trial_seed_custom()
returns trigger language plpgsql security definer set search_path = '' as $$
-- helm-0127-trial-seed-config: fires once, when a demo-mode trial starts; never blocks it
begin
  if old.trial_ends_at is null and new.trial_ends_at is not null and new.trial_mode = 'demo' then
    begin perform public._trial_seed_custom(new.id);
    exception when others then null; end;
  end if;
  return null;
end $$;
revoke all on function public._tg_trial_seed_custom() from public, anon, authenticated;

drop trigger if exists trial_seed_custom_127 on public.organizations;
create trigger trial_seed_custom_127 after update of trial_ends_at, trial_mode on public.organizations
  for each row execute function public._tg_trial_seed_custom();

-- ---- 2) conversion choice: start fresh / keep samples ------------------------------------------
create or replace function public.trial_demo_choice(p_choice text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0127-demo-choice: admin only, own studio only, trial studios only, is_demo rows only
declare v_org uuid := public.current_org_id(); v_choice text := lower(btrim(coalesce(p_choice, '')));
  o public.organizations; r jsonb := null;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_choice not in ('fresh', 'keep') then raise exception 'choose fresh or keep' using errcode = '22023'; end if;
  select * into o from public.organizations x where x.id = v_org for update;
  if o.id is null or o.trial_ends_at is null then
    raise exception 'only a trial studio has sample data to choose about' using errcode = '22023'; end if;
  if v_choice = 'fresh' then
    r := public._demo_clear(v_org);            -- removes ONLY this studio's is_demo rows (0097)
    update public.organizations set trial_mode = 'own' where id = v_org;
  end if;
  update public.organizations set demo_choice = v_choice, demo_choice_at = now() where id = v_org;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'trial.demo_choice',
           'organizations', v_org::text, jsonb_build_object('choice', v_choice, 'cleared', r), v_org, now();
  return jsonb_build_object('result', 'ok', 'choice', v_choice, 'cleared', r);
end $$;
revoke all on function public.trial_demo_choice(text) from public, anon;
grant execute on function public.trial_demo_choice(text) to authenticated, service_role;

-- ---- 3) my_demo_status: 0123 body + demo_choice / choice_pending (read-only) ----------------------
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-start-fresh-0123 helm-0127-demo-choice
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int; v_counts jsonb;
  v_choice text; v_trial boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode, o.demo_choice, o.trial_ends_at is not null into v_mode, v_choice, v_trial
    from public.organizations o where o.id = v_org;
  v_counts := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and is_demo),
    'leads',     (select count(*) from public.leads where org_id = v_org and is_demo),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and is_demo and active),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and is_demo));
  select (select count(*) from public.quotes where org_id = v_org and is_demo)
       + (select count(*) from public.leads where org_id = v_org and is_demo)
       + (select count(*) from public.crew_members where org_id = v_org and is_demo)
       + (select count(*) from public.vendors where org_id = v_org and is_demo)
       + (select count(*) from public.inventory_items where org_id = v_org and is_demo)
       + (select count(*) from public.venues where org_id = v_org and is_demo and active)
       + (select count(*) from public.menu_templates where org_id = v_org and is_demo)
       + (select count(*) from public.layouts where org_id = v_org and is_demo)
    into v_rows;
  return jsonb_build_object('trial_mode', v_mode, 'demo_rows', v_rows, 'has_demo', v_rows > 0,
    'is_admin', coalesce(public.is_admin(), false), 'counts', v_counts,
    'demo_choice', v_choice, 'choice_pending', coalesce(v_trial, false) and v_choice is null and v_rows > 0);
end $$;
revoke all on function public.my_demo_status() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;
commit;

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
