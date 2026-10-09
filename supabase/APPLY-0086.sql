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
select item, ok from (values
  ('01 item_rate_cards table with RLS on', (select relrowsecurity from pg_class where oid = to_regclass('public.item_rate_cards'))),
  ('02 every studio has all 11 rate cards', not exists (select 1 from public.organizations o
      where (select count(*) from public.item_rate_cards c where c.org_id = o.id) < 11)),
  ('03 defaults valid', (select bool_and(public._a86_rates_ok(d.value)) from jsonb_each(public._a86_default_rates()) d)),
  ('04 validator rejects bad rates', not public._a86_rates_ok('{"x":-1}') and not public._a86_rates_ok('{"x":"1"}')
      and not public._a86_rates_ok('{"x":{"y":{"z":1}}}') and not public._a86_rates_ok('{}') and public._a86_rates_ok('{"perSqM":450}')),
  ('05 get/set RPCs: authenticated yes, anon no', has_function_privilege('authenticated', 'public.get_item_rate_cards()', 'execute')
      and has_function_privilege('authenticated', 'public.set_item_rate_card(text,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.get_item_rate_cards()', 'execute')
      and not has_function_privilege('anon', 'public.set_item_rate_card(text,jsonb)', 'execute')),
  ('06 set_item_rate_card gated by item_pricing edit + audited', (select prosrc like '%has_area(''item_pricing'', ''edit'')%' and prosrc like '%item_rates_update%'
      from pg_proc where oid = 'public.set_item_rate_card(text,jsonb)'::regprocedure)),
  ('07 no direct writes for signed-in users', not has_table_privilege('authenticated', 'public.item_rate_cards', 'insert')
      and not has_table_privilege('authenticated', 'public.item_rate_cards', 'update') and not has_table_privilege('authenticated', 'public.item_rate_cards', 'delete')
      and not has_table_privilege('anon', 'public.item_rate_cards', 'select')),
  ('08 seed fn internal only', not has_function_privilege('authenticated', 'public._a86_seed_org(uuid)', 'execute')),
  ('09 new studios seeded on creation', exists (select 1 from pg_trigger where tgname = 'zz_a86_seed_item_rates' and tgrelid = 'public.organizations'::regclass)),
  ('10 definer functions search_path empty', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.get_item_rate_cards()'::regprocedure, 'public.set_item_rate_card(text,jsonb)'::regprocedure,
                      'public._a86_seed_org(uuid)'::regprocedure, 'public._a86_tg_seed_new_org()'::regprocedure)))
) v(item, ok)
order by item;
