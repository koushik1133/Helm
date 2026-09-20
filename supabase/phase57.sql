-- ============================================================================
-- Phase 57 — Tenant-isolating RLS everywhere   (Block F, step 2 of 3)
-- ---------------------------------------------------------------------------
-- Puts up the isolation walls: every tenant table's row-level policies now
-- require org_id = current_org_id() (combined with the existing role/area gate),
-- so a user in studio B can never see or touch studio A's rows. Config/library
-- tables, the role matrix and pricing become per-org. Anon token flows keep
-- working (SECURITY DEFINER RPCs bypass RLS) and their inserts inherit org_id
-- from the parent quote via a trigger.
--
-- Uses ENABLE (not FORCE) RLS so the trusted SECURITY DEFINER RPCs can still do
-- their token-scoped cross-cutting reads. Idempotent. Run AFTER phase56.
-- ============================================================================

-- 0) safety: make sure everything is stamped before we isolate ---------------
do $$ declare t text; helm constant uuid := '00000000-0000-4000-8000-000000000001';
begin
  for t in select table_name from information_schema.tables
           where table_schema='public' and table_type='BASE TABLE'
             and table_name not in ('organizations','profiles')
  loop execute format('update public.%I set org_id = %L where org_id is null', t, helm); end loop;
  update public.profiles set org_id = helm where org_id is null;
end $$;

-- 1) per-org uniqueness (global uniques would collide across studios) ---------
do $$
declare r record;
  fixes text[][] := array[
    ['vendors','vendors_name_key','vendors_org_name_key','(org_id, name)'],
    ['coupons','coupons_code_key','coupons_org_code_key','(org_id, code)'],
    ['plate_types','plate_types_name_key','plate_types_org_name_key','(org_id, name)'],
    ['chair_types','chair_types_name_key','chair_types_org_name_key','(org_id, name)'],
    ['dish_catalog','dish_catalog_name_key','dish_catalog_org_name_key','(org_id, name)'],
    ['quotes','quotes_code_key','quotes_org_code_key','(org_id, code)']
  ];
  f text[];
begin
  foreach f slice 1 in array fixes loop
    if to_regclass('public.'||f[1]) is null then continue; end if;
    execute format('alter table public.%I drop constraint if exists %I', f[1], f[2]);
    if not exists (select 1 from pg_constraint where conname = f[3]) then
      execute format('alter table public.%I add constraint %I unique %s', f[1], f[3], f[4]);
    end if;
  end loop;
end $$;

-- 2) per-org role matrix + pricing (composite PKs) ---------------------------
alter table public.role_access alter column org_id set not null;
alter table public.role_access drop constraint if exists role_access_pkey;
do $$ begin if not exists (select 1 from pg_constraint where conname='role_access_pkey')
  then alter table public.role_access add constraint role_access_pkey primary key (org_id, role, area); end if; end $$;

alter table public.app_config alter column org_id set not null;
alter table public.app_config drop constraint if exists app_config_pkey;
do $$ begin if not exists (select 1 from pg_constraint where conname='app_config_pkey')
  then alter table public.app_config add constraint app_config_pkey primary key (org_id, key); end if; end $$;

-- 3) helper + RPCs become org-aware ------------------------------------------
create or replace function public.has_area(p_area text, p_need text default 'view')
  returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.user_role() = 'admin' then true
    else coalesce((
      select case when p_need = 'edit' then ra.can_edit else ra.can_view end
      from public.role_access ra
      where ra.role = public.user_role() and ra.area = p_area
        and ra.org_id = public.current_org_id()
    ), false)
  end;
$$;

create or replace function public.admin_get_role_access()
  returns setof public.role_access language sql stable security definer set search_path = public as $$
  select * from public.role_access where org_id = public.current_org_id() order by role, area;
$$;

create or replace function public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
  returns public.role_access language plpgsql security definer set search_path = public as $$
declare row public.role_access;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'unknown role %', p_role; end if;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    values (public.current_org_id(), p_role, p_area, coalesce(p_view,false), coalesce(p_edit,false) and coalesce(p_view,false), now())
  on conflict (org_id, role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
  returning * into row;
  return row;
end; $$;

create or replace function public.get_pricing_config() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_config where key='pricing' and org_id = public.current_org_id()),
                  '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb);
$$;
create or replace function public.set_pricing_config(p jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.has_area('controls','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.app_config(org_id, key, value, updated_at) values (public.current_org_id(), 'pricing', p, now())
    on conflict (org_id, key) do update set value=excluded.value, updated_at=now();
  return p;
end; $$;

-- 4) org-inheritance trigger for anon/definer inserts on quote-child tables ---
--    Any table with a quote_id gets org_id from its parent quote when unset,
--    so token-flow inserts (OTP / consent / payment, called by anon) are stamped.
create or replace function public.tg_org_from_quote() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null and NEW.quote_id is not null then
    select org_id into NEW.org_id from public.quotes where id = NEW.quote_id;
  end if;
  if NEW.org_id is null then NEW.org_id := public.current_org_id(); end if;
  return NEW;
end; $$;
do $$ declare t text; begin
  for t in select table_name from information_schema.columns
           where table_schema='public' and column_name='quote_id'
             and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')
  loop
    execute format('drop trigger if exists org_from_quote on public.%I', t);
    execute format('create trigger org_from_quote before insert on public.%I for each row execute function public.tg_org_from_quote()', t);
  end loop;
end $$;

-- 5) RLS rewrite: area + org on the standard tables --------------------------
do $$
declare
  amap jsonb := '{
    "leads":["leads"], "crm":["lead_archive"],
    "nurture":["nurture","nurture_automation","nurture_templates"],
    "discovery":["event_discovery","event_requirements"],
    "proposal":["event_proposal","proposal_risks"],
    "quotes":["quotes","quote_versions","layouts","quote_consents","quote_payments","notifications"],
    "staff":["crew_members","event_tasks","work_tokens"],
    "inventory":["inventory_items","inventory_reservations","inventory_checkouts"],
    "vendors":["vendors","event_resources","event_resource_needs"],
    "templates":["task_templates","checklist_templates"],
    "runsheet":["run_sheet_items"],
    "plan":["event_plan","event_checklist","event_menu_items"],
    "finance":["event_costs","change_requests","payment_milestones","expense_claims"],
    "settlement":["event_refunds"],
    "closure":["event_closure","event_ratings"],
    "command":["event_day","event_guests","event_stock_requests"],
    "issues":["event_issues"], "media":["event_media"]
  }'::jsonb;
  area text; t text; p record;
  org text := '(select public.current_org_id())';
begin
  for area in select jsonb_object_keys(amap) loop
    for t in select jsonb_array_elements_text(amap->area) loop
      if to_regclass('public.'||t) is null then continue; end if;
      for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      execute format('alter table public.%I enable row level security', t);
      execute format($f$create policy "ra view" on public.%I for select to authenticated using ( public.has_area(%L,'view') and org_id = %s )$f$, t, area, org);
      execute format($f$create policy "ra ins"  on public.%I for insert to authenticated with check ( public.has_area(%L,'edit') and org_id = %s )$f$, t, area, org);
      execute format($f$create policy "ra upd"  on public.%I for update to authenticated using ( public.has_area(%L,'edit') and org_id = %s ) with check ( public.has_area(%L,'edit') and org_id = %s )$f$, t, area, org, area, org);
      execute format($f$create policy "ra del"  on public.%I for delete to authenticated using ( public.has_area(%L,'edit') and org_id = %s )$f$, t, area, org);
    end loop;
  end loop;
end $$;

-- 6) config / library tables: any role in the org reads; Control-Center edits -
do $$ declare t text; p record; org text := '(select public.current_org_id())';
  cfg text[] := array['plate_types','chair_types','dish_catalog','coupons','app_config'];
begin
  foreach t in array cfg loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format($f$create policy "cfg read"  on public.%I for select to authenticated using ( org_id = %s )$f$, t, org);
    execute format($f$create policy "cfg write" on public.%I for all to authenticated using ( public.has_area('controls','edit') and org_id = %s ) with check ( public.has_area('controls','edit') and org_id = %s )$f$, t, org, org);
  end loop;
end $$;

-- 7) special tables ----------------------------------------------------------
-- profiles: a user sees their own row and everyone in their studio
alter table public.profiles enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='profiles' loop
    execute format('drop policy if exists %I on public.profiles', p.policyname); end loop;
end $$;
create policy "profiles read" on public.profiles for select to authenticated
  using ( id = auth.uid() or org_id = (select public.current_org_id()) );
-- writes to profiles go through the admin_* SECURITY DEFINER RPCs (definer bypasses RLS)

-- role_access: read your studio's matrix; writes via admin_set_role_access RPC
alter table public.role_access enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='role_access' loop
    execute format('drop policy if exists %I on public.role_access', p.policyname); end loop;
end $$;
create policy "ra read" on public.role_access for select to authenticated
  using ( org_id = (select public.current_org_id()) );

-- audit_log: admins / Control-Center viewers, scoped to their studio
do $$ begin if to_regclass('public.audit_log') is not null then
  execute 'alter table public.audit_log enable row level security';
  execute (select coalesce(string_agg(format('drop policy if exists %I on public.audit_log', policyname), '; '), 'select 1')
           from pg_policies where schemaname='public' and tablename='audit_log');
  execute $p$create policy "audit read" on public.audit_log for select to authenticated
    using ( (public.is_admin() or public.has_area('controls','view')) and org_id = (select public.current_org_id()) )$p$;
end if; end $$;

-- notification_seen: per-user (already), keep self scope
do $$ begin if to_regclass('public.notification_seen') is not null then
  execute 'alter table public.notification_seen enable row level security';
  execute (select coalesce(string_agg(format('drop policy if exists %I on public.notification_seen', policyname), '; '), 'select 1')
           from pg_policies where schemaname='public' and tablename='notification_seen');
  execute $p$create policy "seen self" on public.notification_seen for all to authenticated
    using ( user_id = auth.uid() ) with check ( user_id = auth.uid() )$p$;
end if; end $$;

notify pgrst, 'reload schema';

-- verify: policies now carry org scoping
select 'org-scoped policies' k, count(*)::text v from pg_policies
  where schemaname='public' and qual like '%current_org_id%';
