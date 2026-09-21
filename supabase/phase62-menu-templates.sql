-- ============================================================================
-- Phase 62 — Fixed menu packages (templates): Standard / Gold / Premium × veg / nonveg
-- ---------------------------------------------------------------------------
-- Six curated menu packages the studio offers. Each carries a per-plate price
-- (set in the Control Centre) and a pre-populated dish list (JSONB, so the
-- create_studio generic seeder copies it to new studios with no FK remap).
-- Picking a package on plan.html applies its dishes to the event menu in one
-- click (no step-by-step flow) via apply_menu_template(). The free-text
-- "menu / service details" notes box on plan.html stays as-is.
-- Multi-tenant: org_id + cfg-style RLS, mirrors dish_catalog (phase55/57).
-- Idempotent. Run AFTER phase55 + phase57 + phase58.
-- ============================================================================

-- 1) table -------------------------------------------------------------------
create table if not exists public.menu_templates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org_id() references public.organizations(id),
  tier           text not null check (tier in ('standard','gold','premium')),
  diet           text not null check (diet in ('veg','nonveg')),
  name           text not null,
  price_per_plate numeric not null default 0,
  dishes         jsonb not null default '[]'::jsonb,   -- [{c:category, n:name, k:veg|nonveg|special}]
  active         boolean not null default true,
  seq            int not null default 0,
  created_at     timestamptz not null default now(),
  unique (org_id, tier, diet)
);
create index if not exists menu_templates_org_idx on public.menu_templates(org_id);

-- event_plan: remember which package was applied + its per-plate price ---------
alter table public.event_plan add column if not exists menu_template   text;
alter table public.event_plan add column if not exists menu_plate_price numeric;

-- 2) RLS: any signed-in user in the org reads; Control-Centre editors write ----
alter table public.menu_templates enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='menu_templates'
  loop execute format('drop policy if exists %I on public.menu_templates', p.policyname); end loop;
end $$;
create policy "cfg read"  on public.menu_templates for select to authenticated
  using ( org_id = (select public.current_org_id()) );
create policy "cfg write" on public.menu_templates for all to authenticated
  using ( public.has_area('controls','edit') and org_id = (select public.current_org_id()) )
  with check ( public.has_area('controls','edit') and org_id = (select public.current_org_id()) );

-- 3) apply a package to an event's menu (one click; replaces current dishes) ---
create or replace function public.apply_menu_template(p_quote uuid, p_template uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.menu_templates; locked boolean; d jsonb; i int := 0;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change the package'; end if;
  select * into t from public.menu_templates where id = p_template and org_id = public.current_org_id();
  if t.id is null then raise exception 'no such package'; end if;

  -- replace the current dish selection with the package's dishes
  delete from public.event_menu_items where quote_id = p_quote;
  for d in select * from jsonb_array_elements(t.dishes) loop
    i := i + 1;
    insert into public.event_menu_items(quote_id, dish_id, dish_name, category, kind, seq)
    values (
      p_quote,
      (select dc.id from public.dish_catalog dc
         where dc.org_id = public.current_org_id() and dc.name = (d->>'n') limit 1),
      d->>'n', d->>'c', coalesce(d->>'k','veg'), i);
  end loop;

  -- stamp the plan with the chosen package + its per-plate price
  update public.event_plan
     set package = t.name, menu_template = t.name, menu_plate_price = t.price_per_plate
   where quote_id = p_quote;
  if not found then
    insert into public.event_plan(quote_id, package, menu_template, menu_plate_price)
    values (p_quote, t.name, t.name, t.price_per_plate);
  end if;
end; $$;
revoke all on function public.apply_menu_template(uuid,uuid) from anon;
grant execute on function public.apply_menu_template(uuid,uuid) to authenticated;

-- 4) seed the 6 packages for the Helm/default org (new studios get them copied
--    by create_studio below). Non-veg packages deliberately include veg dishes.
insert into public.menu_templates (org_id, tier, diet, name, price_per_plate, seq, dishes) values
('00000000-0000-4000-8000-000000000001','standard','veg','Standard — Vegetarian',450,1,'[
  {"c":"Welcome drinks","n":"Lemon mint cooler","k":"veg"},
  {"c":"Starters (veg)","n":"Paneer tikka","k":"veg"},
  {"c":"Starters (veg)","n":"Gobi Manchurian","k":"veg"},
  {"c":"Soups","n":"Sweet corn soup","k":"veg"},
  {"c":"Salads","n":"Green salad","k":"veg"},
  {"c":"Main course (veg)","n":"Paneer butter masala","k":"veg"},
  {"c":"Main course (veg)","n":"Mix veg curry","k":"veg"},
  {"c":"Main course (veg)","n":"Dal tadka","k":"veg"},
  {"c":"Breads","n":"Butter naan","k":"veg"},
  {"c":"Breads","n":"Tandoori roti","k":"veg"},
  {"c":"Rice & biryani","n":"Veg biryani","k":"veg"},
  {"c":"Rice & biryani","n":"Jeera rice","k":"veg"},
  {"c":"Desserts","n":"Gulab jamun","k":"veg"},
  {"c":"Beverages","n":"Soft drinks","k":"veg"}
]'::jsonb),
('00000000-0000-4000-8000-000000000001','gold','veg','Gold — Vegetarian',700,2,'[
  {"c":"Welcome drinks","n":"Watermelon cooler","k":"veg"},
  {"c":"Welcome drinks","n":"Badam milk","k":"special"},
  {"c":"Starters (veg)","n":"Paneer tikka","k":"veg"},
  {"c":"Starters (veg)","n":"Mushroom tikka","k":"veg"},
  {"c":"Starters (veg)","n":"Corn cheese balls","k":"veg"},
  {"c":"Soups","n":"Hot and sour soup","k":"veg"},
  {"c":"Salads","n":"Russian salad","k":"veg"},
  {"c":"Main course (veg)","n":"Paneer lababdar","k":"veg"},
  {"c":"Main course (veg)","n":"Dal makhani","k":"veg"},
  {"c":"Main course (veg)","n":"Kadai paneer","k":"veg"},
  {"c":"Main course (veg)","n":"Malai kofta","k":"veg"},
  {"c":"Breads","n":"Garlic naan","k":"veg"},
  {"c":"Breads","n":"Laccha paratha","k":"veg"},
  {"c":"Rice & biryani","n":"Veg biryani","k":"veg"},
  {"c":"Rice & biryani","n":"Ghee rice","k":"veg"},
  {"c":"Chaat & live counters","n":"Live chaat counter","k":"special"},
  {"c":"Desserts","n":"Rasmalai","k":"veg"},
  {"c":"Desserts","n":"Gajar halwa","k":"veg"},
  {"c":"Beverages","n":"Mango lassi","k":"veg"}
]'::jsonb),
('00000000-0000-4000-8000-000000000001','premium','veg','Premium — Vegetarian',1000,3,'[
  {"c":"Welcome drinks","n":"Rose milk","k":"veg"},
  {"c":"Welcome drinks","n":"Fresh coconut water","k":"veg"},
  {"c":"Starters (veg)","n":"Paneer 65","k":"veg"},
  {"c":"Starters (veg)","n":"Mushroom tikka","k":"veg"},
  {"c":"Starters (veg)","n":"Cheese corn nuggets","k":"veg"},
  {"c":"Starters (veg)","n":"Tandoori aloo","k":"veg"},
  {"c":"Soups","n":"Cream of mushroom soup","k":"veg"},
  {"c":"Salads","n":"Caesar salad","k":"veg"},
  {"c":"Main course (veg)","n":"Paneer butter masala","k":"veg"},
  {"c":"Main course (veg)","n":"Palak paneer","k":"veg"},
  {"c":"Main course (veg)","n":"Veg kolhapuri","k":"veg"},
  {"c":"Main course (veg)","n":"Malai kofta","k":"veg"},
  {"c":"Main course (veg)","n":"Dal makhani","k":"veg"},
  {"c":"Breads","n":"Butter naan","k":"veg"},
  {"c":"Breads","n":"Rumali roti","k":"veg"},
  {"c":"Rice & biryani","n":"Hyderabadi dum biryani","k":"special"},
  {"c":"Rice & biryani","n":"Veg pulao","k":"veg"},
  {"c":"Chaat & live counters","n":"Live dosa counter","k":"special"},
  {"c":"Chaat & live counters","n":"Live pasta counter","k":"special"},
  {"c":"Desserts","n":"Moong dal halwa","k":"special"},
  {"c":"Desserts","n":"Kaju katli","k":"special"},
  {"c":"Desserts","n":"Assorted ice cream","k":"veg"},
  {"c":"Beverages","n":"Cold coffee","k":"veg"}
]'::jsonb),
('00000000-0000-4000-8000-000000000001','standard','nonveg','Standard — Non-veg',650,4,'[
  {"c":"Welcome drinks","n":"Lemon mint cooler","k":"veg"},
  {"c":"Starters (veg)","n":"Paneer tikka","k":"veg"},
  {"c":"Starters (nonveg)","n":"Chicken 65","k":"nonveg"},
  {"c":"Soups","n":"Chicken clear soup","k":"nonveg"},
  {"c":"Salads","n":"Kachumber salad","k":"veg"},
  {"c":"Main course (veg)","n":"Paneer butter masala","k":"veg"},
  {"c":"Main course (veg)","n":"Dal tadka","k":"veg"},
  {"c":"Main course (nonveg)","n":"Chicken curry","k":"nonveg"},
  {"c":"Breads","n":"Butter naan","k":"veg"},
  {"c":"Breads","n":"Tandoori roti","k":"veg"},
  {"c":"Rice & biryani","n":"Chicken biryani","k":"nonveg"},
  {"c":"Rice & biryani","n":"Veg biryani","k":"veg"},
  {"c":"Rice & biryani","n":"Jeera rice","k":"veg"},
  {"c":"Desserts","n":"Gulab jamun","k":"veg"},
  {"c":"Beverages","n":"Soft drinks","k":"veg"}
]'::jsonb),
('00000000-0000-4000-8000-000000000001','gold','nonveg','Gold — Non-veg',950,5,'[
  {"c":"Welcome drinks","n":"Watermelon cooler","k":"veg"},
  {"c":"Starters (veg)","n":"Paneer tikka","k":"veg"},
  {"c":"Starters (nonveg)","n":"Chicken tikka","k":"nonveg"},
  {"c":"Starters (nonveg)","n":"Mutton seekh kabab","k":"nonveg"},
  {"c":"Soups","n":"Hot and sour soup","k":"veg"},
  {"c":"Salads","n":"Russian salad","k":"veg"},
  {"c":"Main course (veg)","n":"Kadai paneer","k":"veg"},
  {"c":"Main course (veg)","n":"Dal makhani","k":"veg"},
  {"c":"Main course (nonveg)","n":"Butter chicken","k":"nonveg"},
  {"c":"Main course (nonveg)","n":"Mutton rogan josh","k":"special"},
  {"c":"Breads","n":"Garlic naan","k":"veg"},
  {"c":"Breads","n":"Laccha paratha","k":"veg"},
  {"c":"Rice & biryani","n":"Chicken biryani","k":"nonveg"},
  {"c":"Rice & biryani","n":"Veg biryani","k":"veg"},
  {"c":"Rice & biryani","n":"Ghee rice","k":"veg"},
  {"c":"Chaat & live counters","n":"Live tandoor counter","k":"special"},
  {"c":"Desserts","n":"Rasmalai","k":"veg"},
  {"c":"Desserts","n":"Gajar halwa","k":"veg"},
  {"c":"Beverages","n":"Mango lassi","k":"veg"}
]'::jsonb),
('00000000-0000-4000-8000-000000000001','premium','nonveg','Premium — Non-veg',1400,6,'[
  {"c":"Welcome drinks","n":"Rose milk","k":"veg"},
  {"c":"Welcome drinks","n":"Fresh coconut water","k":"veg"},
  {"c":"Starters (veg)","n":"Paneer 65","k":"veg"},
  {"c":"Starters (nonveg)","n":"Chicken malai kabab","k":"nonveg"},
  {"c":"Starters (nonveg)","n":"Fish tikka","k":"nonveg"},
  {"c":"Starters (nonveg)","n":"Prawn koliwada","k":"special"},
  {"c":"Soups","n":"Chicken clear soup","k":"nonveg"},
  {"c":"Salads","n":"Caesar salad","k":"veg"},
  {"c":"Main course (veg)","n":"Paneer lababdar","k":"veg"},
  {"c":"Main course (veg)","n":"Dal makhani","k":"veg"},
  {"c":"Main course (nonveg)","n":"Butter chicken","k":"nonveg"},
  {"c":"Main course (nonveg)","n":"Mutton curry","k":"special"},
  {"c":"Main course (nonveg)","n":"Prawn masala","k":"special"},
  {"c":"Main course (nonveg)","n":"Fish curry","k":"nonveg"},
  {"c":"Breads","n":"Butter naan","k":"veg"},
  {"c":"Breads","n":"Rumali roti","k":"veg"},
  {"c":"Rice & biryani","n":"Mutton biryani","k":"special"},
  {"c":"Rice & biryani","n":"Chicken biryani","k":"nonveg"},
  {"c":"Rice & biryani","n":"Veg biryani","k":"veg"},
  {"c":"Chaat & live counters","n":"Live dosa counter","k":"special"},
  {"c":"Desserts","n":"Moong dal halwa","k":"special"},
  {"c":"Desserts","n":"Double ka meetha","k":"special"},
  {"c":"Desserts","n":"Assorted ice cream","k":"veg"},
  {"c":"Beverages","n":"Cold coffee","k":"veg"}
]'::jsonb)
on conflict (org_id, tier, diet) do nothing;

-- 5) wire create_studio() to seed menu_templates for new studios --------------
--    (adds 'menu_templates' to the copied library; dishes JSONB copies verbatim)
create or replace function public.create_studio(
  p_name text, p_email text default null, p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_existing uuid;
  helm constant uuid := '00000000-0000-4000-8000-000000000001';
  t text; cols text; has_name boolean;
  lib text[] := array['role_access','task_templates','checklist_templates','plate_types',
                      'chair_types','dish_catalog','menu_templates','nurture_templates','nurture_automation','app_config'];
  v_slug text;
begin
  if v_uid is null then raise exception 'must be signed in to create a studio' using errcode='42501'; end if;
  select org_id into v_existing from public.profiles where id = v_uid;
  if v_existing is not null then return v_existing; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'studio name required'; end if;

  v_org := gen_random_uuid();
  v_slug := left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || left(v_org::text, 8);
  insert into public.organizations(id, name, slug, business_email, currency, timezone, created_by)
    values (v_org, p_name, v_slug, p_email, coalesce(p_currency,'INR'), coalesce(p_timezone,'Asia/Kolkata'), v_uid);

  insert into public.profiles(id, email, org_id, role)
    values (v_uid, coalesce(p_email, (select email from auth.users where id = v_uid)), v_org, 'admin')
  on conflict (id) do update set org_id = v_org, role = 'admin';

  foreach t in array lib loop
    if to_regclass('public.'||t) is null then continue; end if;
    select string_agg(quote_ident(column_name), ',') into cols
      from information_schema.columns
      where table_schema='public' and table_name=t
        and column_name not in ('id','org_id','created_at','updated_at','created_by','updated_by','locked_at','locked_by');
    if cols is null then continue; end if;
    has_name := exists(select 1 from information_schema.columns
                       where table_schema='public' and table_name=t and column_name='name');
    execute format(
      'insert into public.%I (org_id,%s) select %L,%s from public.%I where org_id=%L %s',
      t, cols, v_org, cols, t, helm,
      case when has_name then 'and coalesce(name,'''') not ilike ''%(testing)%''' else '' end);
  end loop;

  return v_org;
end; $$;
revoke all on function public.create_studio(text,text,text,text) from anon;
grant execute on function public.create_studio(text,text,text,text) to authenticated;

notify pgrst, 'reload schema';

-- verify
select 'menu_templates' t, count(*)::text n from public.menu_templates
union all select 'helm_packages', count(*)::text from public.menu_templates where org_id='00000000-0000-4000-8000-000000000001'
union all select 'apply_menu_template', 'ok';
