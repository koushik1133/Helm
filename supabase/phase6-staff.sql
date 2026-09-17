-- =========================================================================
-- PHASE 6 — In-house staff directory  (Block B: Resource Management)
-- Idempotent. Safe to re-run. Depends on: operations.sql (crew_members).
-- Extends crew_members with role / skills / department details so you can
-- plan in-house people first, before reaching for vendors or freelancers.
-- No new table — we enrich the existing crew_members the tasks module uses.
-- =========================================================================

alter table public.crew_members add column if not exists role      text;
alter table public.crew_members add column if not exists skills    jsonb not null default '[]'::jsonb;
alter table public.crew_members add column if not exists email     text;
alter table public.crew_members add column if not exists emp_type  text;   -- full_time | part_time | on_call
alter table public.crew_members add column if not exists day_rate  numeric;
alter table public.crew_members add column if not exists notes     text;

create index if not exists crew_role_idx on public.crew_members(role) where active;

-- guard emp_type values (allow null) without failing if the constraint exists
do $$ begin
  alter table public.crew_members
    add constraint crew_emp_type_chk
    check (emp_type is null or emp_type in ('full_time','part_time','on_call'));
exception when duplicate_object then null; end $$;

-- crew_members already has RLS: read = any signed-in user, write = can_edit,
-- delete = can_edit (the "write crew" ALL policy). Nothing else to add.
