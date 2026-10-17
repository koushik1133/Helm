-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- ==========================================================================================
-- =========================================================================
-- Control Center: global pricing config, vendors, coupons. Run ONCE (idempotent).
-- Central rates (chair/plate/GST) live here so the confirm modal doesn't re-enter
-- them each time; discounts/coupons are per-event. All synced via Supabase.
-- =========================================================================
create extension if not exists pgcrypto with schema extensions;

create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- 0) global pricing defaults (in app_config; created by otp-payments.sql, ensure row) ------
create table if not exists public.app_config (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
insert into public.app_config(key,value) values
  ('pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"cateringGstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb)
  on conflict (key) do nothing;

create or replace function public.get_pricing_config() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_config where key='pricing'),
    '{"chairPrice":200,"platePrice":500,"gstPct":18,"cateringGstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb); $$;
create or replace function public.set_pricing_config(p jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.app_config(key,value,updated_at) values ('pricing', p, now())
    on conflict (key) do update set value=excluded.value, updated_at=now();
  return p;
end; $$;
grant execute on function public.get_pricing_config() to authenticated;
grant execute on function public.set_pricing_config(jsonb) to authenticated;

-- 1) vendors -------------------------------------------------------------------
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,            -- catering / decor / lighting / transport / general
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name)
);
alter table public.vendors enable row level security;

-- 2) coupons -------------------------------------------------------------------
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  kind text not null default 'percent' check (kind in ('percent','flat')),
  value numeric not null default 0,     -- percent (0-100) or flat ₹
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.coupons enable row level security;

-- 3) RLS: authenticated read; managers write ----------------------------------
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('vendors','coupons')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read vendors"  on public.vendors for select to authenticated using ( true );
create policy "write vendors" on public.vendors for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read coupons"  on public.coupons for select to authenticated using ( true );
create policy "write coupons" on public.coupons for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- seed a couple of common catering vendors (safe to re-run)
insert into public.vendors(name,category) values
  ('In-house','catering'),('Spice Route Caterers','catering'),('Grand Feast','catering')
  on conflict (name) do nothing;

-- 4) manager-triggered notification (e.g. "text the approval link to the client")
create or replace function public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public._notify(p_quote_id, p_channel, p_to, p_kind, p_detail);
  return jsonb_build_object('logged', true);
end; $$;
grant execute on function public.mgr_notify(uuid,text,text,text,jsonb) to authenticated;

-- verify
select 'pricing' t, (get_pricing_config())::text n
union all select 'vendors', count(*)::text from public.vendors
union all select 'coupons', count(*)::text from public.coupons;
