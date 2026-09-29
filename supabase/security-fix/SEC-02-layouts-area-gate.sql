-- =====================================================================
-- SEC-02 (HIGH, within-org) — re-add an area gate to public.layouts
-- =====================================================================
-- FINDING: phase89 replaced layouts RLS with org-only, dropping the has_area gate.
-- Any authenticated org member could hit /rest/v1/layouts regardless of matrix.
-- NOTE: legacy policies here are SPACE-NAMED ("layouts read/insert/update/delete"),
-- so a targeted drop-by-name is fragile. This version drops EVERY policy on the
-- table first, then recreates the gated set — robust regardless of prior names.
--
-- FIX: keep org isolation AND gate on the QUOTES area (builder is quote-scoped).
-- Verified on staging 2026-09-29: admin/planner (quotes access) keep builder;
-- crew/client denied (0 rows). Builder confirmed working.
-- Idempotent, reversible. Apply on STAGING → verify builder → PRODUCTION.
-- =====================================================================

-- ---- PRECHECK ----
select policyname, cmd, coalesce(qual,'')||coalesce(with_check,'') as expr
from pg_policies where schemaname='public' and tablename='layouts' order by cmd, policyname;

-- ---- APPLY (drop ALL existing policies, then recreate gated) ----
alter table public.layouts enable row level security;
do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', pol.policyname); end loop;
end $$;

create policy layouts_select on public.layouts for select
  using (org_id = public.current_org_id() and public.has_area('quotes','view'));
create policy layouts_ins on public.layouts for insert
  with check (org_id = public.current_org_id() and public.has_area('quotes','edit'));
create policy layouts_upd on public.layouts for update
  using (org_id = public.current_org_id() and public.has_area('quotes','edit'))
  with check (org_id = public.current_org_id() and public.has_area('quotes','edit'));
create policy layouts_del on public.layouts for delete
  using (org_id = public.current_org_id() and public.has_area('quotes','edit'));

-- ---- VERIFY (must be all_gated = t, exactly 4 policies) ----
select 'layouts' as tbl,
       bool_and(coalesce(qual,'')||coalesce(with_check,'') like '%has_area%') as all_gated,
       count(*) as policies
from pg_policies where schemaname='public' and tablename='layouts';

-- ---- ROLLBACK (restore phase89 org-only) ----
-- do $$ declare pol record; begin
--   for pol in select policyname from pg_policies where schemaname='public' and tablename='layouts'
--   loop execute format('drop policy if exists %I on public.layouts', pol.policyname); end loop; end $$;
-- create policy layouts_rw on public.layouts for all
--   using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());
