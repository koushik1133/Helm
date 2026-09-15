-- Blueprint Stage — Supabase schema
-- Run this in your Supabase project's SQL editor, then paste your Project URL
-- and anon key into public/config.js.

create table if not exists public.layouts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Untitled layout',
  data        jsonb not null default '{"items":[]}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists layouts_updated_at_idx on public.layouts (updated_at desc);

-- Row Level Security.
-- The app uses the anon/public key from the browser, so enable RLS and add a
-- policy that matches how you want to gate access.
alter table public.layouts enable row level security;

-- OPTION A — quick start / single-user or trusted use:
-- allow the anon key full access to the table.
create policy "anon full access to layouts"
  on public.layouts for all
  to anon
  using (true) with check (true);

-- OPTION B — recommended once you add Supabase Auth: scope rows to the owner.
-- alter table public.layouts add column owner uuid references auth.users(id) default auth.uid();
-- drop policy if exists "anon full access to layouts" on public.layouts;
-- create policy "owners manage their layouts" on public.layouts
--   for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- keep updated_at fresh on updates
create or replace function public.set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists layouts_set_updated_at on public.layouts;
create trigger layouts_set_updated_at before update on public.layouts
  for each row execute function public.set_updated_at();
