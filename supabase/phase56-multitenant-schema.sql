-- ============================================================================
-- Phase 56 — Multi-tenant foundation: schema + backfill   (Block F, step 1 of 3)
-- ---------------------------------------------------------------------------
-- Turns Blueprint Stage into a platform of isolated studios (tenants).
--   • organizations table = the tenant (name, business email, branding, currency…)
--   • profiles.org_id      = which studio a user belongs to
--   • org_id added to EVERY tenant table (driven dynamically off information_schema
--     so no table is missed), backfilled to a default "Helm Studio" so ALL EXISTING
--     DATA IS PRESERVED — nothing is deleted, and the app keeps working unchanged.
--   • current_org_id() helper + org_id column DEFAULT current_org_id() so new rows
--     auto-stamp the caller's studio.
--
-- ⚠️ STRICTLY ADDITIVE: no RLS isolation, no unique/PK changes yet — those land in
--    Phase 57 alongside the RPC updates, so nothing breaks in this step. Right now
--    everything lives under "Helm Studio" exactly as before.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1) organizations (the tenant) ----------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text unique,
  business_email text,
  currency       text not null default 'INR',
  timezone       text not null default 'Asia/Kolkata',
  gst_number     text,
  brand          jsonb not null default '{}'::jsonb,   -- {logo, accent, ...}
  plan           text not null default 'free',
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);
-- (idempotent add in case an older organizations table exists without these)
alter table public.organizations add column if not exists business_email text;
alter table public.organizations add column if not exists brand jsonb not null default '{}'::jsonb;

-- 2) the default studio that holds ALL existing data (fixed id → deterministic)
insert into public.organizations (id, name, slug, currency, timezone)
values ('00000000-0000-4000-8000-000000000001', 'Helm Studio', 'helm', 'INR', 'Asia/Kolkata')
on conflict (id) do nothing;

-- 3) which studio a user belongs to ------------------------------------------
alter table public.profiles add column if not exists org_id uuid references public.organizations(id);
update public.profiles set org_id = '00000000-0000-4000-8000-000000000001' where org_id is null;

-- 4) the helper every org-scoped policy will use -----------------------------
--    SECURITY DEFINER so it reads the caller's own profile regardless of RLS;
--    referenced in policies as (select public.current_org_id()) → runs once per
--    statement (initPlan), not per row.
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;
revoke all on function public.current_org_id() from public;
grant execute on function public.current_org_id() to anon, authenticated;

-- 5) add org_id to EVERY tenant table (dynamic — catches every current + future
--    base table in public except organizations/profiles), backfill to Helm, set
--    the auto-stamp default, index, and FK. All idempotent.
do $$
declare
  t text;
  helm constant uuid := '00000000-0000-4000-8000-000000000001';
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not in ('organizations','profiles')
  loop
    execute format('alter table public.%I add column if not exists org_id uuid', t);
    execute format('update public.%I set org_id = %L where org_id is null', t, helm);
    execute format('alter table public.%I alter column org_id set default public.current_org_id()', t);
    execute format('create index if not exists %I on public.%I(org_id)', t||'_org_idx', t);
    if not exists (select 1 from pg_constraint where conname = t||'_org_fk') then
      execute format('alter table public.%I add constraint %I foreign key (org_id) references public.organizations(id)', t, t||'_org_fk');
    end if;
  end loop;
end $$;

-- 6) organizations RLS: a user sees / edits only their own studio -------------
alter table public.organizations enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='organizations'
  loop execute format('drop policy if exists %I on public.organizations', p.policyname); end loop;
end $$;
create policy "org self read"  on public.organizations for select to authenticated
  using ( id = (select public.current_org_id()) );
create policy "org self write" on public.organizations for update to authenticated
  using ( id = (select public.current_org_id()) ) with check ( id = (select public.current_org_id()) );
-- creating a NEW org happens via the create_studio() onboarding RPC in Phase 58.

notify pgrst, 'reload schema';

-- verify ----------------------------------------------------------------------
select 'orgs' k, count(*)::text v from public.organizations
union all select 'profiles_in_helm', count(*)::text from public.profiles where org_id = '00000000-0000-4000-8000-000000000001'
union all select 'tables_with_org_id',
  count(*)::text from information_schema.columns where table_schema='public' and column_name='org_id'
union all select 'quotes_no_org_null', count(*)::text from public.quotes where org_id is null;
