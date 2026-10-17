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
-- Phase 39 — Plate types & prices (catering categories)
--
-- Meeting: the per-plate price should be split into categories — veg / non-veg /
-- special — each with its own price, managed in the Control Center (like chair
-- types). Menu/diet is decided with the client, so pricing can use the right rate.
--
-- RUN AFTER phase29 (uses has_area). Idempotent.
-- =========================================================================

create table if not exists public.plate_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  price      numeric not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.plate_types (name, price) values
  ('Vegetarian', 800), ('Non-vegetarian', 1200), ('Special / premium', 1800)
on conflict (name) do nothing;

alter table public.plate_types enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='plate_types'
  loop execute format('drop policy if exists %I on public.plate_types', p.policyname); end loop;
end $$;
create policy "pt read"  on public.plate_types for select to authenticated using ( true );
create policy "pt write" on public.plate_types for all to authenticated
  using ( public.has_area('controls','edit') ) with check ( public.has_area('controls','edit') );

notify pgrst, 'reload schema';
