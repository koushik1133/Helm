-- ============================================================================
-- Phase 55 — Menu dish catalog (searchable) + per-event dish selection
-- ---------------------------------------------------------------------------
-- A library of dishes (dish_catalog) the studio can search and add to an event's
-- menu, with an optional quantity per dish (event_menu_items). The free-text
-- "menu / service details" notes box on plan.html stays as-is — this is additive.
-- Mirrors the plate_types (phase39) library pattern. Idempotent.
-- ============================================================================

-- 1) the library ------------------------------------------------------------
create table if not exists public.dish_catalog (
  id         uuid primary key default gen_random_uuid(),
  category   text not null,
  name       text not null unique,
  kind       text not null default 'veg' check (kind in ('veg','nonveg','special')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists dish_cat_idx on public.dish_catalog(category) where active;

-- 2) per-event selected dishes (one row per dish; qty optional) --------------
create table if not exists public.event_menu_items (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  dish_id    uuid references public.dish_catalog(id) on delete set null,
  dish_name  text not null,          -- snapshot so catalog edits never corrupt a saved menu
  category   text,
  kind       text,
  qty        numeric,                -- optional
  seq        int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists event_menu_quote_idx on public.event_menu_items(quote_id, seq);

-- 3) RLS --------------------------------------------------------------------
alter table public.dish_catalog     enable row level security;
alter table public.event_menu_items enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('dish_catalog','event_menu_items')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
-- prices/dishes aren't sensitive → any signed-in user reads; Control-Center editors write
create policy "dish read"  on public.dish_catalog for select to authenticated using ( true );
create policy "dish write" on public.dish_catalog for all to authenticated
  using ( public.has_area('controls','edit') ) with check ( public.has_area('controls','edit') );
-- event menu: managers read; writes go through the SECURITY DEFINER RPCs below
create policy "emenu read" on public.event_menu_items for select to authenticated using ( true );

-- 4) RPCs: add / remove / set-qty (respect the menu lock + plan edit rights) --
create or replace function public.add_event_dish(p_quote uuid, p_dish uuid)
returns public.event_menu_items language plpgsql security definer set search_path = public as $$
declare d public.dish_catalog; locked boolean; nextseq int; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change dishes'; end if;
  select * into d from public.dish_catalog where id = p_dish;
  if d.id is null then raise exception 'no such dish'; end if;
  select coalesce(max(seq),0)+1 into nextseq from public.event_menu_items where quote_id = p_quote;
  insert into public.event_menu_items(quote_id,dish_id,dish_name,category,kind,seq)
    values (p_quote, d.id, d.name, d.category, d.kind, nextseq)
  returning * into row;
  return row;
end; $$;

create or replace function public.remove_event_dish(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q uuid; locked boolean;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id;
  if q is null then return; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  delete from public.event_menu_items where id = p_id;
end; $$;

create or replace function public.set_event_dish_qty(p_id uuid, p_qty numeric)
returns public.event_menu_items language plpgsql security definer set search_path = public as $$
declare q uuid; locked boolean; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id;
  if q is null then raise exception 'no such menu item'; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'quantity cannot be negative'; end if;
  update public.event_menu_items set qty = p_qty where id = p_id returning * into row;
  return row;
end; $$;

revoke all on function public.add_event_dish(uuid,uuid)      from anon;
revoke all on function public.remove_event_dish(uuid)        from anon;
revoke all on function public.set_event_dish_qty(uuid,numeric) from anon;
grant execute on function public.add_event_dish(uuid,uuid)      to authenticated;
grant execute on function public.remove_event_dish(uuid)        to authenticated;
grant execute on function public.set_event_dish_qty(uuid,numeric) to authenticated;

-- 5) seed — a clean, varied catalog (veg / nonveg / special) -----------------
insert into public.dish_catalog (category, name, kind) values
 -- Welcome drinks
 ('Welcome drinks','Jaljeera','veg'),('Welcome drinks','Aam panna','veg'),('Welcome drinks','Spiced buttermilk','veg'),
 ('Welcome drinks','Watermelon cooler','veg'),('Welcome drinks','Rose milk','veg'),('Welcome drinks','Lemon mint cooler','veg'),
 ('Welcome drinks','Fresh coconut water','veg'),('Welcome drinks','Badam milk','special'),
 -- Starters (veg)
 ('Starters (veg)','Paneer tikka','veg'),('Starters (veg)','Veg spring roll','veg'),('Starters (veg)','Hara bhara kabab','veg'),
 ('Starters (veg)','Gobi Manchurian','veg'),('Starters (veg)','Aloo tikki','veg'),('Starters (veg)','Mushroom tikka','veg'),
 ('Starters (veg)','Corn cheese balls','veg'),('Starters (veg)','Veg seekh kabab','veg'),('Starters (veg)','Crispy baby corn','veg'),
 ('Starters (veg)','Paneer 65','veg'),('Starters (veg)','Cheese corn nuggets','veg'),('Starters (veg)','Tandoori aloo','veg'),
 -- Starters (nonveg)
 ('Starters (nonveg)','Chicken tikka','nonveg'),('Starters (nonveg)','Chicken 65','nonveg'),('Starters (nonveg)','Fish Amritsari','nonveg'),
 ('Starters (nonveg)','Mutton seekh kabab','nonveg'),('Starters (nonveg)','Chilli chicken','nonveg'),('Starters (nonveg)','Tandoori chicken','nonveg'),
 ('Starters (nonveg)','Prawn koliwada','special'),('Starters (nonveg)','Chicken lollipop','nonveg'),('Starters (nonveg)','Fish tikka','nonveg'),
 ('Starters (nonveg)','Chicken malai kabab','nonveg'),('Starters (nonveg)','Apollo fish','special'),
 -- Soups
 ('Soups','Sweet corn soup','veg'),('Soups','Hot and sour soup','veg'),('Soups','Tomato shorba','veg'),
 ('Soups','Manchow soup','veg'),('Soups','Chicken clear soup','nonveg'),('Soups','Cream of mushroom soup','veg'),
 -- Salads
 ('Salads','Green salad','veg'),('Salads','Kachumber salad','veg'),('Salads','Russian salad','veg'),
 ('Salads','Sprouts salad','veg'),('Salads','Caesar salad','veg'),('Salads','Fruit salad','veg'),
 -- Main course (veg)
 ('Main course (veg)','Paneer butter masala','veg'),('Main course (veg)','Dal makhani','veg'),('Main course (veg)','Palak paneer','veg'),
 ('Main course (veg)','Kadai paneer','veg'),('Main course (veg)','Veg kolhapuri','veg'),('Main course (veg)','Mix veg curry','veg'),
 ('Main course (veg)','Chana masala','veg'),('Main course (veg)','Malai kofta','veg'),('Main course (veg)','Aloo gobi','veg'),
 ('Main course (veg)','Bhindi masala','veg'),('Main course (veg)','Dum aloo','veg'),('Main course (veg)','Paneer lababdar','veg'),
 ('Main course (veg)','Dal tadka','veg'),('Main course (veg)','Veg korma','veg'),
 -- Main course (nonveg)
 ('Main course (nonveg)','Butter chicken','nonveg'),('Main course (nonveg)','Chicken curry','nonveg'),('Main course (nonveg)','Mutton rogan josh','special'),
 ('Main course (nonveg)','Chicken chettinad','nonveg'),('Main course (nonveg)','Fish curry','nonveg'),('Main course (nonveg)','Egg curry','nonveg'),
 ('Main course (nonveg)','Andhra chicken','nonveg'),('Main course (nonveg)','Prawn masala','special'),('Main course (nonveg)','Mutton curry','special'),
 ('Main course (nonveg)','Hyderabadi chicken','nonveg'),('Main course (nonveg)','Kadai chicken','nonveg'),
 -- Breads
 ('Breads','Butter naan','veg'),('Breads','Garlic naan','veg'),('Breads','Tandoori roti','veg'),('Breads','Laccha paratha','veg'),
 ('Breads','Missi roti','veg'),('Breads','Rumali roti','veg'),('Breads','Kulcha','veg'),('Breads','Poori','veg'),
 -- Rice & biryani
 ('Rice & biryani','Veg biryani','veg'),('Rice & biryani','Chicken biryani','nonveg'),('Rice & biryani','Mutton biryani','special'),
 ('Rice & biryani','Jeera rice','veg'),('Rice & biryani','Veg pulao','veg'),('Rice & biryani','Curd rice','veg'),
 ('Rice & biryani','Steamed rice','veg'),('Rice & biryani','Ghee rice','veg'),('Rice & biryani','Hyderabadi dum biryani','special'),
 ('Rice & biryani','Egg biryani','nonveg'),
 -- South Indian
 ('South Indian','Masala dosa','veg'),('South Indian','Idli sambar','veg'),('South Indian','Medu vada','veg'),
 ('South Indian','Uttapam','veg'),('South Indian','Ven pongal','veg'),('South Indian','Upma','veg'),
 ('South Indian','Rava dosa','veg'),('South Indian','Lemon rice','veg'),
 -- Chinese
 ('Chinese','Veg fried rice','veg'),('Chinese','Chicken fried rice','nonveg'),('Chinese','Veg noodles','veg'),
 ('Chinese','Chicken noodles','nonveg'),('Chinese','Schezwan fried rice','veg'),('Chinese','Chilli paneer','veg'),
 ('Chinese','Manchurian gravy','veg'),('Chinese','Chilli garlic noodles','veg'),
 -- Chaat & live counters
 ('Chaat & live counters','Pani puri','veg'),('Chaat & live counters','Bhel puri','veg'),('Chaat & live counters','Sev puri','veg'),
 ('Chaat & live counters','Dahi puri','veg'),('Chaat & live counters','Papdi chaat','veg'),('Chaat & live counters','Ragda pattice','veg'),
 ('Chaat & live counters','Pav bhaji','veg'),('Chaat & live counters','Chole bhature','veg'),
 ('Chaat & live counters','Live dosa counter','special'),('Chaat & live counters','Live chaat counter','special'),
 ('Chaat & live counters','Live pasta counter','special'),('Chaat & live counters','Live tandoor counter','special'),
 -- Desserts
 ('Desserts','Gulab jamun','veg'),('Desserts','Rasmalai','veg'),('Desserts','Gajar halwa','veg'),('Desserts','Rasgulla','veg'),
 ('Desserts','Assorted ice cream','veg'),('Desserts','Jalebi','veg'),('Desserts','Kheer','veg'),('Desserts','Moong dal halwa','special'),
 ('Desserts','Kaju katli','special'),('Desserts','Fruit custard','veg'),('Desserts','Double ka meetha','special'),('Desserts','Payasam','veg'),
 -- Beverages
 ('Beverages','Masala chai','veg'),('Beverages','Filter coffee','veg'),('Beverages','Soft drinks','veg'),('Beverages','Fresh lime soda','veg'),
 ('Beverages','Sweet lassi','veg'),('Beverages','Mango lassi','veg'),('Beverages','Cold coffee','veg'),('Beverages','Mineral water','veg')
on conflict (name) do nothing;

notify pgrst, 'reload schema';

-- verify
select 'dish_catalog' t, count(*) n from public.dish_catalog
union all select 'categories', count(distinct category) from public.dish_catalog
union all select 'event_menu_items', count(*) from public.event_menu_items;
