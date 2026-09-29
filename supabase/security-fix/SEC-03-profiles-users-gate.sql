-- =====================================================================
-- SEC-03 (MED, within-org PII) — gate profiles reads on the 'users' area
-- =====================================================================
-- FINDING: a legacy SPACE-NAMED policy "profiles read" (id=auth.uid() OR org match)
-- let any org member read every colleague's email+role via /rest/v1/profiles, even
-- though 'users' is admin-only. It coexisted with the gated profiles_select and,
-- being permissive, was OR'd in — defeating the gate.
--
-- FIX: drop ALL profiles policies, recreate a single SELECT policy = self OR
-- has_area('users','view'). Profiles has no direct write policies (writes go through
-- is_admin-guarded admin_* RPCs), so no write policy is (re)created — matching prior state.
-- Verified on staging 2026-09-29: admin sees all org profiles; planner/crew/client
-- see ONLY their own row. Assignment uses crew_members (staff area), not profiles.
-- Idempotent, reversible. Apply on STAGING → click-through as planner/operations → PRODUCTION.
-- =====================================================================

-- ---- PRECHECK ----
select policyname, cmd, coalesce(qual,'')||coalesce(with_check,'') as expr
from pg_policies where schemaname='public' and tablename='profiles' order by cmd, policyname;

-- ---- APPLY (drop ALL existing policies, recreate the gated SELECT) ----
alter table public.profiles enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='profiles'
  loop execute format('drop policy if exists %I on public.profiles', pol.policyname); end loop;
end $$;

create policy profiles_select on public.profiles for select
  using (
    id = auth.uid()
    or (org_id = public.current_org_id() and public.has_area('users','view'))
  );

-- ---- VERIFY (all_gated = t; 1 policy) ----
select 'profiles' as tbl,
       bool_and(coalesce(qual,'')||coalesce(with_check,'') like '%has_area%') as all_gated,
       count(*) as policies
from pg_policies where schemaname='public' and tablename='profiles';

-- ---- ROLLBACK ----
-- do $$ declare pol record; begin
--   for pol in select policyname from pg_policies where schemaname='public' and tablename='profiles'
--   loop execute format('drop policy if exists %I on public.profiles', pol.policyname); end loop; end $$;
-- create policy profiles_select on public.profiles for select
--   using (id = auth.uid() or org_id = public.current_org_id());
