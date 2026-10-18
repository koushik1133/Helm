-- 0192_menu_package_validation.sql - CANONICAL forward-only.
-- REQUIRES the base menu_templates table (price_per_plate numeric not null, dishes jsonb, active boolean).
--
-- In plain words (Control Center > Menus & catalog > Menu packages):
--   Clearing the price of a package and pressing "Save package" used to save the package with no
--   price. The page now refuses that, and this file makes the database refuse it too, so no other
--   screen or a hand-made API call can do it either.
--   A BEFORE INSERT / UPDATE trigger on public.menu_templates refuses a write made straight from the
--   app (signed-in user or client link: current_user anon / authenticated) when:
--     * an ACTIVE package would have no price, a price of 0 or less, or no dishes;
--     * a price is cleared (null) or changed to 0 or less, also on an inactive package;
--     * a NEW price is above 1,00,000 per plate or has more than 2 decimal places;
--     * a NEW dish list is not a list, has a dish with no name, a name over 120 characters,
--       a category over 80 characters, a type other than veg / nonveg / special, the same dish
--       twice, or more than 500 dishes.
--   Only NEW or CHANGED values are checked. An existing row that already has a 0 price or an empty
--   list is never re-checked: changing its name, order or description still works, and nothing
--   already stored is rewritten. Helm's own functions (trial start, the 0167 sample clone, demo
--   seed / clear, 0170 refresh) and SQL run by the owner do not run as anon / authenticated, so
--   they are unchanged. The 0173 free-trial "no new packages" refusal still fires first (trigger
--   name order), with its own message.
--   Additive + idempotent: create or replace function, trigger created only when missing.
--   No DROP of data, DELETE, UPDATE or TRUNCATE. Safe to run twice.
--   ROLLBACK (manual, only if ever needed): drop trigger zzzzz_menu_pkg_validate_0192 on
--   public.menu_templates; drop function public.tg_menu_pkg_validate_0192(). No data is touched.
-- ============================================================================

do $$ begin
  if to_regclass('public.menu_templates') is null then raise exception '0192: public.menu_templates is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_templates' and column_name = 'price_per_plate') then
    raise exception '0192: menu_templates.price_per_plate is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_templates' and column_name = 'dishes') then
    raise exception '0192: menu_templates.dishes is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_templates' and column_name = 'active') then
    raise exception '0192: menu_templates.active is missing'; end if;
end $$;

create or replace function public.tg_menu_pkg_validate_0192()
returns trigger language plpgsql set search_path = '' as $$
-- menu-pkg-validate-0192: SECURITY INVOKER on purpose (current_user = the app role). Only direct app
-- writes are checked; Helm's own SECURITY DEFINER functions and owner SQL keep working as before.
declare
  v_ins boolean := tg_op = 'INSERT';
  v_price_new boolean; v_dishes_new boolean; v_on boolean;
  v_n integer; v_bad integer; v_dup integer;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  v_price_new := v_ins or new.price_per_plate is distinct from old.price_per_plate;
  v_dishes_new := v_ins or new.dishes is distinct from old.dishes;
  v_on := coalesce(new.active, false) and (v_ins or not coalesce(old.active, false));   -- created active / switched on

  -- price ----------------------------------------------------------------------------------------
  if v_price_new and new.price_per_plate is null then
    raise exception 'Enter a price per plate. A package price cannot be cleared.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;
  if v_price_new and not v_ins and new.price_per_plate <= 0 then
    raise exception 'Enter a price per plate above 0. A package price cannot be cleared or set to 0.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;
  if coalesce(new.active, false) and (v_price_new or v_on) and coalesce(new.price_per_plate, 0) <= 0 then
    raise exception 'Enter a price per plate above 0 for an active package.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;
  if v_price_new and new.price_per_plate > 100000 then
    raise exception 'Price per plate can be at most 1,00,000.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;
  if v_price_new and new.price_per_plate <> round(new.price_per_plate, 2) then
    raise exception 'Price per plate can have at most 2 decimal places.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;

  -- dishes ---------------------------------------------------------------------------------------
  if v_dishes_new then
    if new.dishes is null or jsonb_typeof(new.dishes) <> 'array' then
      raise exception 'The dish list must be a list of dishes.' using errcode = '23514', hint = 'menu_pkg_invalid';
    end if;
    v_n := jsonb_array_length(new.dishes);
    if v_n > 500 then
      raise exception 'A package can have at most 500 dishes.' using errcode = '23514', hint = 'menu_pkg_invalid';
    end if;
    -- a dish is a {n|name, c|category, k|kind} object, or (older rows) a plain name string
    select count(*) filter (where
             case jsonb_typeof(e.j)
               when 'string' then btrim(e.j #>> '{}') = '' or char_length(e.j #>> '{}') > 120
               when 'object' then btrim(coalesce(e.j ->> 'n', e.j ->> 'name', '')) = ''
                               or char_length(coalesce(e.j ->> 'n', e.j ->> 'name', '')) > 120
                               or char_length(coalesce(e.j ->> 'c', e.j ->> 'category', '')) > 80
                               or lower(coalesce(e.j ->> 'k', e.j ->> 'kind', 'veg')) not in ('veg', 'nonveg', 'special')
               else true end),
           count(*) - count(distinct lower(btrim(coalesce(e.j ->> 'c', e.j ->> 'category', ''))) || chr(1)
                                     || lower(btrim(case jsonb_typeof(e.j) when 'string' then e.j #>> '{}'
                                                         else coalesce(e.j ->> 'n', e.j ->> 'name', '') end)))
      into v_bad, v_dup
      from jsonb_array_elements(new.dishes) e(j);
    if v_bad > 0 then
      raise exception 'Every dish needs a name (at most 120 characters), a category of at most 80 characters and a type of veg, nonveg or special.'
        using errcode = '23514', hint = 'menu_pkg_invalid';
    end if;
    if v_dup > 0 then
      raise exception 'The same dish is in this package twice. Remove the duplicate.' using errcode = '23514', hint = 'menu_pkg_invalid';
    end if;
  end if;
  if coalesce(new.active, false) and (v_dishes_new or v_on)
     and (new.dishes is null or jsonb_typeof(new.dishes) <> 'array' or jsonb_array_length(new.dishes) = 0) then
    raise exception 'Add at least one dish to an active package.' using errcode = '23514', hint = 'menu_pkg_invalid';
  end if;
  return new;
end $$;
revoke all on function public.tg_menu_pkg_validate_0192() from public, anon, authenticated;

-- after zzzz_tl173_no_add (BEFORE triggers fire in name order): the free-trial refusal keeps its message
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.menu_templates'::regclass
                  and tgname = 'zzzzz_menu_pkg_validate_0192' and not tgisinternal) then
    create trigger zzzzz_menu_pkg_validate_0192 before insert or update on public.menu_templates
      for each row execute function public.tg_menu_pkg_validate_0192();
  end if;
end $$;

notify pgrst, 'reload schema';
