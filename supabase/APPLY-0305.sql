-- APPLY-0305.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- R74: Leads page live updates. The page already listens for lead changes, but the leads table was never
-- switched on for live updates, so new leads only showed after a refresh. This switches it on.
-- Live updates obey the existing row security: people only receive leads of their OWN studio that their role
-- may view. Nothing else is created, changed or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. The VERIFY row at the end must say ok = true.
--   2  No site change is needed.
begin;
-- 0305_r74_leads_realtime.sql - CANONICAL forward-only. R74: the Leads page subscribes to live changes
-- (store-api.js channel "leads-rt") but public.leads was never added to the supabase_realtime publication, so
-- new / changed leads only appeared after a refresh. Add the table to the publication. Realtime delivers a change
-- only to subscribers whose RLS SELECT policy allows the row ("ra view": has_area(leads, view) AND own org), so no
-- cross-studio exposure. No table / column / row / policy / grant / index / trigger is created, changed or deleted.
-- Safe to run twice (skips when already published). ASCII only.
do $$
begin
  if to_regclass('public.leads') is null then raise exception 'STOP 0305: public.leads is missing'; end if;
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise exception 'STOP 0305: publication supabase_realtime is missing'; end if;
  if not exists (select 1 from pg_catalog.pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads') then
    execute 'alter publication supabase_realtime add table public.leads';
  end if;
end $$;
commit;

-- ---- VERIFY ---------------------------------------------------------------------------------------------------
select 'leads is in supabase_realtime' as check_name,
       exists (select 1 from pg_catalog.pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads') as ok
union all
select 'leads still has row security on',
       (select relrowsecurity from pg_catalog.pg_class where oid = 'public.leads'::regclass);
