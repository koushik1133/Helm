-- APPLY-0085-0086.sql  --  ONE paste: 0085 (venues: studio venue list, Control Center tab, sample loader)
-- and 0086 (item specifications: per-studio rate cards for DJ, generator, stage, lighting, LED, etc).
-- Run on STAGING first, then PROD, AFTER APPLY-0084. Idempotent: safe to paste twice. Pure ASCII.
-- The LAST result grid is the combined VERIFY (22 rows): every ok = true.

-- ===================== APPLY-0085 =====================
-- APPLY-0085.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0084.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 12 rows, every ok = true.
-- Adds the venues list only. Nothing existing is deleted or rewritten.
-- 0085_venues.sql - CANONICAL forward-only. Studio venue list (Control Center -> Venues).
--
-- In plain words:
--   Each studio keeps a list of the venues it works with: name, type, AC / non-AC, indoor /
--   outdoor, seated + floating capacity, hall size (stored in METERS), event types allowed,
--   restrictions (sound curfew, no fireworks, no outside catering ...), an approximate cost
--   range, amenities, address / city / map link, contact, notes and an active flag.
--   The quote flow and the builder can pick a saved venue to fill in the venue details.
--
--   Changes (all additive, idempotent; nothing is ever deleted or rewritten):
--     * table venues (one row per venue, org_id = the studio). Row level security on:
--       a signed-in member reads only their OWN studio's venues and only with the new
--       "venues" area (view) in the access matrix - admins always. No insert / update /
--       delete grants: every write goes through the functions below.
--     * venues can never be hard-deleted (trigger) - "remove" = deactivate (active = false).
--     * suspended studios are read-only (0045 guard) + every change is written to audit_log.
--     * venue_save(id, data)      - add (id null) or edit; needs venues EDIT, own studio only.
--     * venue_set_active(id, on)  - deactivate / re-activate; needs venues EDIT.
--     * venue_load_samples()      - ADMIN only; adds 3 clearly marked "SAMPLE - ..." venues,
--       and only when the studio has NO venues at all (running it again adds nothing).
--   No role_access rows are seeded: an admin ticks "Venues" for the roles that need it.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0085: has_area(text,text) is not installed'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception '0085: tg_studio_read_only() is not installed (apply 0045 first)'; end if;
  if to_regprocedure('public._a84_phone_ok(text)') is null then
    raise exception '0085: _a84_phone_ok(text) is not installed (apply 0084 first)'; end if;
end $$;

create table if not exists public.venues (
  id                 uuid        primary key default gen_random_uuid(),
  org_id             uuid        not null,
  name               text        not null,
  venue_type         text        not null default 'other',
  ac_type            text        not null default 'ac',
  setting            text        not null default 'indoor',
  seated_capacity    integer     null,
  floating_capacity  integer     null,
  length_m           numeric(9,2) null,
  width_m            numeric(9,2) null,
  dim_unit           text        not null default 'm',
  event_types        text[]      not null default '{}',
  restrictions       text[]      not null default '{}',
  restrictions_note  text        null,
  sound_curfew       time        null,
  setup_window       text        null,
  cost_min           numeric(14,2) null,
  cost_max           numeric(14,2) null,
  cost_basis         text        not null default 'per_day',
  parking_spaces     integer     null,
  rooms              integer     null,
  power_backup_kw    numeric(9,2) null,
  green_rooms        integer     null,
  washrooms          integer     null,
  address            text        null,
  city               text        null,
  map_url            text        null,
  contact_name       text        null,
  contact_phone      text        null,
  contact_email      text        null,
  notes              text        null,
  active             boolean     not null default true,
  is_sample          boolean     not null default false,
  created_by         uuid        null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'venues_name_ck') then
    alter table public.venues add constraint venues_name_ck check (length(btrim(name)) between 1 and 200); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_type_ck') then
    alter table public.venues add constraint venues_type_ck check (venue_type in
      ('convention_centre', 'banquet_hall', 'lawn', 'hotel_ballroom', 'resort', 'community_hall', 'rooftop', 'other')); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_ac_ck') then
    alter table public.venues add constraint venues_ac_ck check (ac_type in ('ac', 'non_ac', 'partial')); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_setting_ck') then
    alter table public.venues add constraint venues_setting_ck check (setting in ('indoor', 'outdoor', 'both')); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_capacity_ck') then
    alter table public.venues add constraint venues_capacity_ck check (
      (seated_capacity is null or seated_capacity between 1 and 1000000)
      and (floating_capacity is null or floating_capacity between 1 and 1000000)
      and coalesce(seated_capacity, floating_capacity) is not null); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_dims_ck') then
    alter table public.venues add constraint venues_dims_ck check (
      (length_m is null or (length_m > 0 and length_m <= 10000)) and (width_m is null or (width_m > 0 and width_m <= 10000))); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_unit_ck') then
    alter table public.venues add constraint venues_unit_ck check (dim_unit in ('m', 'ft')); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_event_types_ck') then
    alter table public.venues add constraint venues_event_types_ck check (event_types <@ array['wedding', 'reception', 'engagement',
      'birthday', 'corporate', 'product_launch', 'conference', 'political', 'concert', 'festival', 'other']::text[]); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_restrictions_ck') then
    alter table public.venues add constraint venues_restrictions_ck check (restrictions <@ array['sound_curfew', 'no_open_flame',
      'no_fireworks', 'no_outside_catering', 'decor_vendor_tieup', 'no_alcohol', 'parking_limited', 'generator_required',
      'generator_not_allowed', 'setup_window']::text[]); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_cost_ck') then
    alter table public.venues add constraint venues_cost_ck check (
      (cost_min is null or cost_min >= 0) and (cost_max is null or cost_max >= 0)
      and (cost_min is null or cost_max is null or cost_min <= cost_max)); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_basis_ck') then
    alter table public.venues add constraint venues_basis_ck check (cost_basis in ('per_day', 'per_slot', 'per_plate')); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_amenities_ck') then
    alter table public.venues add constraint venues_amenities_ck check (
      coalesce(parking_spaces, 0) between 0 and 100000 and coalesce(rooms, 0) between 0 and 100000
      and coalesce(power_backup_kw, 0) between 0 and 100000 and coalesce(green_rooms, 0) between 0 and 1000
      and coalesce(washrooms, 0) between 0 and 10000); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_text_len_ck') then
    alter table public.venues add constraint venues_text_len_ck check (
      coalesce(length(restrictions_note), 0) <= 2000 and coalesce(length(setup_window), 0) <= 200
      and coalesce(length(address), 0) <= 1000 and coalesce(length(city), 0) <= 120
      and coalesce(length(map_url), 0) <= 1000 and coalesce(length(contact_name), 0) <= 200
      and coalesce(length(contact_phone), 0) <= 40 and coalesce(length(contact_email), 0) <= 254
      and coalesce(length(notes), 0) <= 4000); end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_map_url_ck') then
    alter table public.venues add constraint venues_map_url_ck check (map_url is null or map_url ~* '^https://[^[:space:]<>"]+$'); end if;
end $$;

create index if not exists venues_org_idx on public.venues (org_id, active, name);

alter table public.venues enable row level security;
revoke all on table public.venues from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.venues from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.venues from authenticated';
    execute 'grant select on table public.venues to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert, update on table public.venues to service_role'; end if;
end $$;

drop policy if exists "a85 venues read" on public.venues;
create policy "a85 venues read" on public.venues for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('venues', 'view'));

-- never hard-delete a venue (deactivate instead)
create or replace function public._a85_tg_venue_no_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Venues are never deleted - deactivate the venue instead.' using errcode = '42501', hint = 'venue_no_delete';
end $$;
revoke all on function public._a85_tg_venue_no_delete() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a85_tg_venue_no_delete() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a85_tg_venue_no_delete() from authenticated'; end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_a85_venue_no_delete' and tgrelid = 'public.venues'::regclass) then
    execute 'create trigger zz_a85_venue_no_delete before delete on public.venues for each row execute function public._a85_tg_venue_no_delete()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.venues'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.venues for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
  if to_regprocedure('public.tg_audit()') is not null
     and not exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = 'public.venues'::regclass) then
    execute 'create trigger audit_trg after insert or delete or update on public.venues for each row execute function public.tg_audit()';
  end if;
end $$;

-- text helper: trimmed, empty -> null
create or replace function public._a85_txt(p jsonb, k text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(coalesce(p ->> k, '')), '');
$$;

-- jsonb array of strings -> distinct sorted text[] (non-array -> empty)
create or replace function public._a85_arr(p jsonb, k text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce((select array_agg(distinct btrim(x) order by btrim(x)) from jsonb_array_elements_text(
    case when jsonb_typeof(p -> k) = 'array' then p -> k else '[]'::jsonb end) x where btrim(x) <> ''), '{}'::text[]);
$$;

create or replace function public.venue_save(p_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- venues-0085
declare
  v_org uuid := public.current_org_id();
  v_name text; v_seat int; v_float int; v_len numeric; v_wid numeric; v_cmin numeric; v_cmax numeric;
  v_phone text; v_map text; v_curfew time; r public.venues;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('venues', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'venue data must be an object' using errcode = '22023'; end if;

  v_name := public._a85_txt(p, 'name');
  if v_name is null or length(v_name) > 200 then raise exception 'Give the venue a name (up to 200 characters).' using errcode = '22023'; end if;
  begin
    v_seat  := nullif(p ->> 'seated_capacity', '')::numeric::int;
    v_float := nullif(p ->> 'floating_capacity', '')::numeric::int;
    v_len   := nullif(p ->> 'length_m', '')::numeric;
    v_wid   := nullif(p ->> 'width_m', '')::numeric;
    v_cmin  := nullif(p ->> 'cost_min', '')::numeric;
    v_cmax  := nullif(p ->> 'cost_max', '')::numeric;
    v_curfew := nullif(p ->> 'sound_curfew', '')::time;
  exception when others then
    raise exception 'A number or time in the venue form is not valid.' using errcode = '22023';
  end;
  if coalesce(v_seat, v_float) is null or coalesce(v_seat, 1) <= 0 or coalesce(v_float, 1) <= 0 then
    raise exception 'Capacity must be more than 0 (seated or floating).' using errcode = '22023'; end if;
  if (v_len is not null and v_len <= 0) or (v_wid is not null and v_wid <= 0) then
    raise exception 'Length and width must be more than 0.' using errcode = '22023'; end if;
  if (v_cmin is not null and v_cmin < 0) or (v_cmax is not null and v_cmax < 0) then
    raise exception 'Cost cannot be negative.' using errcode = '22023'; end if;
  if v_cmin is not null and v_cmax is not null and v_cmin > v_cmax then
    raise exception 'The minimum cost cannot be more than the maximum cost.' using errcode = '22023'; end if;
  v_phone := public._a85_txt(p, 'contact_phone');
  if not public._a84_phone_ok(v_phone) then
    raise exception 'Phone numbers need 7-15 digits (an optional leading + is fine).' using errcode = '22023', hint = 'invalid_phone'; end if;
  v_map := public._a85_txt(p, 'map_url');
  if v_map is not null and v_map !~* '^https://[^[:space:]<>"]+$' then
    raise exception 'The map link must start with https://' using errcode = '22023'; end if;

  if p_id is null then
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m,
        dim_unit, event_types, restrictions, restrictions_note, sound_curfew, setup_window, cost_min, cost_max, cost_basis,
        parking_spaces, rooms, power_backup_kw, green_rooms, washrooms, address, city, map_url, contact_name, contact_phone,
        contact_email, notes, active, created_by)
      values (v_org, v_name, coalesce(public._a85_txt(p, 'venue_type'), 'other'), coalesce(public._a85_txt(p, 'ac_type'), 'ac'),
        coalesce(public._a85_txt(p, 'setting'), 'indoor'), v_seat, v_float, round(v_len, 2), round(v_wid, 2),
        coalesce(public._a85_txt(p, 'dim_unit'), 'm'), public._a85_arr(p, 'event_types'), public._a85_arr(p, 'restrictions'),
        public._a85_txt(p, 'restrictions_note'), v_curfew, public._a85_txt(p, 'setup_window'), v_cmin, v_cmax,
        coalesce(public._a85_txt(p, 'cost_basis'), 'per_day'),
        nullif(p ->> 'parking_spaces', '')::numeric::int, nullif(p ->> 'rooms', '')::numeric::int,
        nullif(p ->> 'power_backup_kw', '')::numeric, nullif(p ->> 'green_rooms', '')::numeric::int,
        nullif(p ->> 'washrooms', '')::numeric::int, public._a85_txt(p, 'address'), public._a85_txt(p, 'city'), v_map,
        public._a85_txt(p, 'contact_name'), v_phone, public._a85_txt(p, 'contact_email'), public._a85_txt(p, 'notes'),
        coalesce((p ->> 'active')::boolean, true), auth.uid())
      returning * into r;
  else
    update public.venues v set
        name = v_name, venue_type = coalesce(public._a85_txt(p, 'venue_type'), 'other'),
        ac_type = coalesce(public._a85_txt(p, 'ac_type'), 'ac'), setting = coalesce(public._a85_txt(p, 'setting'), 'indoor'),
        seated_capacity = v_seat, floating_capacity = v_float, length_m = round(v_len, 2), width_m = round(v_wid, 2),
        dim_unit = coalesce(public._a85_txt(p, 'dim_unit'), 'm'), event_types = public._a85_arr(p, 'event_types'),
        restrictions = public._a85_arr(p, 'restrictions'), restrictions_note = public._a85_txt(p, 'restrictions_note'),
        sound_curfew = v_curfew, setup_window = public._a85_txt(p, 'setup_window'), cost_min = v_cmin, cost_max = v_cmax,
        cost_basis = coalesce(public._a85_txt(p, 'cost_basis'), 'per_day'),
        parking_spaces = nullif(p ->> 'parking_spaces', '')::numeric::int, rooms = nullif(p ->> 'rooms', '')::numeric::int,
        power_backup_kw = nullif(p ->> 'power_backup_kw', '')::numeric, green_rooms = nullif(p ->> 'green_rooms', '')::numeric::int,
        washrooms = nullif(p ->> 'washrooms', '')::numeric::int, address = public._a85_txt(p, 'address'),
        city = public._a85_txt(p, 'city'), map_url = v_map, contact_name = public._a85_txt(p, 'contact_name'),
        contact_phone = v_phone, contact_email = public._a85_txt(p, 'contact_email'), notes = public._a85_txt(p, 'notes'),
        active = coalesce((p ->> 'active')::boolean, v.active), updated_at = now()
      where v.id = p_id and v.org_id = v_org
      returning * into r;
    if r.id is null then raise exception 'no such venue' using errcode = '42501'; end if;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.venue_set_active(p_id uuid, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- venues-0085
declare v_org uuid := public.current_org_id(); r public.venues;
begin
  if auth.uid() is null or v_org is null or not public.has_area('venues', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  update public.venues v set active = coalesce(p_active, false), updated_at = now()
   where v.id = p_id and v.org_id = v_org returning * into r;
  if r.id is null then raise exception 'no such venue' using errcode = '42501'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.venue_load_samples()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- venues-0085
declare v_org uuid := public.current_org_id(); n int;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') <> 'admin' then
    raise exception 'Only an admin can load sample venues.' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('venues.samples:' || v_org::text));
  if exists (select 1 from public.venues v where v.org_id = v_org) then
    return jsonb_build_object('ok', true, 'added', 0, 'reason', 'studio already has venues');
  end if;
  insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m,
      dim_unit, event_types, restrictions, restrictions_note, sound_curfew, setup_window, cost_min, cost_max, cost_basis,
      parking_spaces, rooms, power_backup_kw, green_rooms, washrooms, address, city, notes, is_sample, created_by)
  values
    (v_org, 'SAMPLE - Grand Convention Centre, Hitec City', 'convention_centre', 'ac', 'indoor', 1200, 2000, 60, 40, 'm',
     array['conference', 'corporate', 'product_launch', 'reception', 'wedding', 'concert']::text[],
     array['decor_vendor_tieup', 'no_open_flame', 'setup_window']::text[],
     'Sample data - edit or deactivate. Fire NOC needed for pyro; load-in through the service gate only.', null,
     '06:00-23:00 (setup from 6 AM on event day)', 350000, 600000, 'per_day', 400, 0, 500, 4, 24,
     'Hitec City Main Road, Madhapur', 'Hyderabad', 'Sample venue (not real).', true, auth.uid()),
    (v_org, 'SAMPLE - Royal Banquet Hall', 'banquet_hall', 'ac', 'indoor', 450, 700, 35, 22, 'm',
     array['wedding', 'reception', 'engagement', 'birthday', 'corporate']::text[],
     array['no_outside_catering', 'no_fireworks', 'sound_curfew']::text[],
     'Sample data - in-house catering only.', '23:00', null, 150000, 250000, 'per_day', 120, 6, 250, 2, 10,
     'Road No. 12, Banjara Hills', 'Hyderabad', 'Sample venue (not real).', true, auth.uid()),
    (v_org, 'SAMPLE - Green Meadows Lawn', 'lawn', 'non_ac', 'outdoor', null, 2000, 80, 50, 'm',
     array['wedding', 'reception', 'festival', 'concert', 'political', 'birthday']::text[],
     array['sound_curfew', 'generator_required', 'parking_limited']::text[],
     'Sample data - no permanent power; bring generators. Rain plan needed June-September.', '22:00', null,
     200000, 400000, 'per_day', 150, 0, 0, 1, 8,
     'Shamshabad Road, near ORR exit 15', 'Hyderabad', 'Sample venue (not real).', true, auth.uid());
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'added', n);
end $$;

do $$ declare f text; begin
  foreach f in array array['public.venue_save(uuid,jsonb)', 'public.venue_set_active(uuid,boolean)', 'public.venue_load_samples()',
                           'public._a85_txt(jsonb,text)', 'public._a85_arr(jsonb,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- verify -----------------------------------------------------------------------------

-- ===================== APPLY-0086 =====================
-- APPLY-0086.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0084 (0085 not required).
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 10 rows, every ok = true.
-- Nothing is deleted or overwritten: existing studio rate cards and role_access rows are kept as they are.
-- 0086_item_specs.sql - CANONICAL forward-only. Item specifications + per-studio item rate cards.
--
-- In plain words:
--   1. item_rate_cards: ONE row per studio per item type (dj, generator, stage, lighting, led,
--      chandelier, photobooth, chocolatefountain, chariot, smoke, dancers). The row holds that
--      studio's rates (e.g. stage: rate per square metre; generator: rate per kVA per day).
--      Default Indian market rates (docs/ITEM-PRICING-DEFAULTS.md) are seeded for every studio
--      ONLY where the studio has no row yet - a studio's own edits are never overwritten.
--   2. get_item_rate_cards(): any signed-in member of a studio reads its rates (defaults filled
--      in for any type the studio never saved) plus whether they may edit them.
--   3. set_item_rate_card(type, rates): only roles with the NEW access-matrix area
--      "item_pricing" EDIT right (admins always) can change a rate card. Suspended studios are
--      read-only. Every change is written to audit_log. Rates must be numbers 0..10,000,000.
--   4. item_pricing view right is seeded (view only, never edit) for every role that can
--      already view quotes; existing role_access rows are never changed.
--   Quote totals are NOT touched: the spec price feeds the existing pricing.other figure, which
--   helm_quote_total (D8, 0001/0079) already prices. Items without a spec keep catalog prices.
--   Additive + idempotent: safe to run twice. Nothing is deleted.

create table if not exists public.item_rate_cards (
  org_id     uuid        not null,
  item_type  text        not null,
  rates      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        null,
  primary key (org_id, item_type)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'item_rate_cards_type_ck') then
    alter table public.item_rate_cards add constraint item_rate_cards_type_ck check (item_type in
      ('dj','generator','stage','lighting','led','chandelier','photobooth','chocolatefountain','chariot','smoke','dancers')); end if;
  if not exists (select 1 from pg_constraint where conname = 'item_rate_cards_rates_ck') then
    alter table public.item_rate_cards add constraint item_rate_cards_rates_ck check (jsonb_typeof(rates) = 'object' and pg_column_size(rates) <= 8192); end if;
end $$;
create index if not exists item_rate_cards_org_idx on public.item_rate_cards (org_id);
alter table public.item_rate_cards enable row level security;
revoke all on table public.item_rate_cards from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.item_rate_cards from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.item_rate_cards from authenticated';
    execute 'grant select on table public.item_rate_cards to authenticated';      -- RLS below: own studio only
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert, update on table public.item_rate_cards to service_role'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'item_rate_cards' and policyname = 'item_rate_cards_read_own_org') then
    execute 'create policy item_rate_cards_read_own_org on public.item_rate_cards for select to authenticated using (org_id = public.current_org_id())';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.item_rate_cards'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.item_rate_cards for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- the shipped default rates (INR). Mirrors ITEM_SPEC.DEFAULT_RATES in public/store-api.js.
create or replace function public._a86_default_rates()
returns jsonb language sql immutable set search_path = '' as $$
  select '{
    "dj":        {"setup": {"console": 15000, "speakers2": 25000, "speakers4": 40000}, "power": {"pin2": 0, "pin3": 1500, "pin4": 4000}, "perExtraSpeaker": 3000},
    "generator": {"base": 2000, "perKvaDay": 60, "dieselPerKvaDay": 100, "operatorPerDay": 1000},
    "stage":     {"base": 0, "perSqM": 450, "stdHeightM": 0.6, "heightPerSqMPerM": 150},
    "lighting":  {"each": {"par": 600, "moving_head": 2500, "uplighter": 500}, "perM": {"fairy": 40, "truss_wash": 800}},
    "led":       {"perSqMDay": {"p39_indoor": 1100, "p48_outdoor": 900, "p6_outdoor": 650}},
    "chandelier":{"each": {"small": 3000, "medium": 6000, "large": 12000, "grand": 25000}},
    "photobooth":{"perHour": {"standard": 2500, "spin360": 5000, "mirror": 4000}, "minHours": 2},
    "chocolatefountain": {"base": {"small": 6000, "medium": 9000, "large": 14000}, "perServing": 40},
    "chariot":   {"perTrip": {"horse": 15000, "vintage_car": 12000, "flower": 20000}},
    "smoke":     {"perUnit": {"cold_pyro": 2500, "low_fog": 6000, "dry_ice": 5000}},
    "dancers":   {"perDancerShow": 3500, "perDancerHour": 1500}
  }'::jsonb
$$;
revoke all on function public._a86_default_rates() from public, anon;
grant execute on function public._a86_default_rates() to authenticated, service_role;

-- a numeric leaf in [0, 10,000,000]
create or replace function public._a86_num_ok(v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric between 0 and 10000000 else false end
$$;
-- rates: an object of 1..40 keys; each value a number or an object of 1..40 numbers (one level)
create or replace function public._a86_rates_ok(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb; k2 text; v2 jsonb; n int := 0; n2 int;
begin
  if p is null or jsonb_typeof(p) <> 'object' or pg_column_size(p) > 8192 then return false; end if;
  for k, v in select * from jsonb_each(p) loop
    n := n + 1;
    if n > 40 or k !~ '^[A-Za-z0-9_]{1,40}$' then return false; end if;
    if jsonb_typeof(v) = 'object' then
      n2 := 0;
      for k2, v2 in select * from jsonb_each(v) loop
        n2 := n2 + 1;
        if n2 > 40 or k2 !~ '^[A-Za-z0-9_]{1,40}$' or not public._a86_num_ok(v2) then return false; end if;
      end loop;
      if n2 = 0 then return false; end if;
    elsif not public._a86_num_ok(v) then return false;
    end if;
  end loop;
  return n > 0;
end $$;
revoke all on function public._a86_num_ok(jsonb) from public, anon;
revoke all on function public._a86_rates_ok(jsonb) from public, anon;
grant execute on function public._a86_num_ok(jsonb) to authenticated, service_role;
grant execute on function public._a86_rates_ok(jsonb) to authenticated, service_role;

-- seed defaults for ONE studio: only types it has no row for (ON CONFLICT DO NOTHING - edits kept)
create or replace function public._a86_seed_org(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  if p_org is null then return 0; end if;
  insert into public.item_rate_cards(org_id, item_type, rates)
    select p_org, d.key, d.value from jsonb_each(public._a86_default_rates()) d
  on conflict (org_id, item_type) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._a86_seed_org(uuid) from public, anon, authenticated;
grant execute on function public._a86_seed_org(uuid) to service_role;

-- read: own studio's cards, defaults filled in for types never saved
create or replace function public.get_item_rate_cards()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_saved jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(c.item_type, c.rates), '{}'::jsonb) into v_saved
    from public.item_rate_cards c where c.org_id = v_org;
  return jsonb_build_object(
    'rates',   public._a86_default_rates() || v_saved,
    'canEdit', public.has_area('item_pricing', 'edit'),
    'custom',  coalesce((select jsonb_agg(c.item_type order by c.item_type) from public.item_rate_cards c
                          where c.org_id = v_org and c.updated_by is not null), '[]'::jsonb));
end $$;
revoke all on function public.get_item_rate_cards() from public, anon;
grant execute on function public.get_item_rate_cards() to authenticated, service_role;

-- write: has_area('item_pricing','edit'), own studio, writable, valid rates; audited
create or replace function public.set_item_rate_card(p_type text, p_rates jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_old jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('item_pricing', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if coalesce(p_type, '') not in ('dj','generator','stage','lighting','led','chandelier','photobooth','chocolatefountain','chariot','smoke','dancers') then
    raise exception 'unknown item type' using errcode = '22023'; end if;
  if not public._a86_rates_ok(p_rates) then
    raise exception 'rates must be numbers between 0 and 10000000' using errcode = '22023'; end if;
  select c.rates into v_old from public.item_rate_cards c where c.org_id = v_org and c.item_type = p_type for update;
  insert into public.item_rate_cards(org_id, item_type, rates, updated_at, updated_by)
    values (v_org, p_type, p_rates, now(), auth.uid())
  on conflict (org_id, item_type) do update set rates = excluded.rates, updated_at = now(), updated_by = auth.uid();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'item_rates_update', 'item_rate_cards',
            p_type, jsonb_build_object('type', p_type, 'from', v_old, 'to', p_rates), v_org);
  return jsonb_build_object('type', p_type, 'rates', p_rates);
end $$;
revoke all on function public.set_item_rate_card(text, jsonb) from public, anon;
grant execute on function public.set_item_rate_card(text, jsonb) to authenticated, service_role;

-- seed every existing studio (never overwrites)
do $$ declare o uuid; begin
  for o in select id from public.organizations loop perform public._a86_seed_org(o); end loop;
end $$;

-- new studios get their defaults on creation
create or replace function public._a86_tg_seed_new_org()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public._a86_seed_org(new.id); return new; end $$;
revoke all on function public._a86_tg_seed_new_org() from public, anon, authenticated;
drop trigger if exists zz_a86_seed_item_rates on public.organizations;
create trigger zz_a86_seed_item_rates after insert on public.organizations
  for each row execute function public._a86_tg_seed_new_org();

-- item_pricing VIEW for roles that already view quotes (edit stays off until an admin grants it)
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
  select ra.role, 'item_pricing', true, false, ra.org_id, now()
    from public.role_access ra where ra.area = 'quotes' and ra.can_view
on conflict (role, area, org_id) do nothing;

-- ---- verify -----------------------------------------------------------------------------

-- COMBINED VERIFY (ALL ok = true)
select item, ok from (values
('0085 01 venues table present', to_regclass('public.venues') is not null),
  ('0085 02 RLS on', (select relrowsecurity from pg_class where oid = 'public.venues'::regclass)),
  ('0085 03 read policy tenant + area scoped', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'venues'
      and policyname = 'a85 venues read' and qual like '%current_org_id%' and qual like '%has_area%')),
  ('0085 04 authenticated: select only', has_table_privilege('authenticated', 'public.venues', 'select')
      and not has_table_privilege('authenticated', 'public.venues', 'insert')
      and not has_table_privilege('authenticated', 'public.venues', 'update')
      and not has_table_privilege('authenticated', 'public.venues', 'delete')),
  ('0085 05 anon: no access', not has_table_privilege('anon', 'public.venues', 'select')),
  ('0085 06 no-delete trigger', exists (select 1 from pg_trigger where tgname = 'zz_a85_venue_no_delete' and tgrelid = 'public.venues'::regclass)),
  ('0085 07 suspended-studio guard', exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.venues'::regclass)),
  ('0085 08 audit trigger', exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = 'public.venues'::regclass)),
  ('0085 09 cost / capacity / size checks', (select count(*) from pg_constraint where conrelid = 'public.venues'::regclass
      and conname in ('venues_cost_ck', 'venues_capacity_ck', 'venues_dims_ck')) = 3),
  ('0085 10 RPCs: authenticated yes, anon no', has_function_privilege('authenticated', 'public.venue_save(uuid,jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.venue_set_active(uuid,boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.venue_load_samples()', 'execute')
      and not has_function_privilege('anon', 'public.venue_save(uuid,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.venue_load_samples()', 'execute')),
  ('0085 11 RPCs definer-safe (search_path empty)', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.venue_save(uuid,jsonb)'::regprocedure, 'public.venue_set_active(uuid,boolean)'::regprocedure,
                      'public.venue_load_samples()'::regprocedure, 'public._a85_tg_venue_no_delete()'::regprocedure))),
  ('0085 12 edit gated by venues area', (select bool_and(prosrc like '%has_area(''venues'', ''edit'')%') from pg_proc
      where oid in ('public.venue_save(uuid,jsonb)'::regprocedure, 'public.venue_set_active(uuid,boolean)'::regprocedure))),
('0086 01 item_rate_cards table with RLS on', (select relrowsecurity from pg_class where oid = to_regclass('public.item_rate_cards'))),
  ('0086 02 every studio has all 11 rate cards', not exists (select 1 from public.organizations o
      where (select count(*) from public.item_rate_cards c where c.org_id = o.id) < 11)),
  ('0086 03 defaults valid', (select bool_and(public._a86_rates_ok(d.value)) from jsonb_each(public._a86_default_rates()) d)),
  ('0086 04 validator rejects bad rates', not public._a86_rates_ok('{"x":-1}') and not public._a86_rates_ok('{"x":"1"}')
      and not public._a86_rates_ok('{"x":{"y":{"z":1}}}') and not public._a86_rates_ok('{}') and public._a86_rates_ok('{"perSqM":450}')),
  ('0086 05 get/set RPCs: authenticated yes, anon no', has_function_privilege('authenticated', 'public.get_item_rate_cards()', 'execute')
      and has_function_privilege('authenticated', 'public.set_item_rate_card(text,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.get_item_rate_cards()', 'execute')
      and not has_function_privilege('anon', 'public.set_item_rate_card(text,jsonb)', 'execute')),
  ('0086 06 set_item_rate_card gated by item_pricing edit + audited', (select prosrc like '%has_area(''item_pricing'', ''edit'')%' and prosrc like '%item_rates_update%'
      from pg_proc where oid = 'public.set_item_rate_card(text,jsonb)'::regprocedure)),
  ('0086 07 no direct writes for signed-in users', not has_table_privilege('authenticated', 'public.item_rate_cards', 'insert')
      and not has_table_privilege('authenticated', 'public.item_rate_cards', 'update') and not has_table_privilege('authenticated', 'public.item_rate_cards', 'delete')
      and not has_table_privilege('anon', 'public.item_rate_cards', 'select')),
  ('0086 08 seed fn internal only', not has_function_privilege('authenticated', 'public._a86_seed_org(uuid)', 'execute')),
  ('0086 09 new studios seeded on creation', exists (select 1 from pg_trigger where tgname = 'zz_a86_seed_item_rates' and tgrelid = 'public.organizations'::regclass)),
  ('0086 10 definer functions search_path empty', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.get_item_rate_cards()'::regprocedure, 'public.set_item_rate_card(text,jsonb)'::regprocedure,
                      'public._a86_seed_org(uuid)'::regprocedure, 'public._a86_tg_seed_new_org()'::regprocedure)))
) v(item, ok)
order by item;
