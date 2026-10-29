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
    raise notice '0305: no supabase_realtime publication here (plain Postgres test harness) - nothing to do'; return; end if;
  if not exists (select 1 from pg_catalog.pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads') then
    execute 'alter publication supabase_realtime add table public.leads';
  end if;
end $$;
