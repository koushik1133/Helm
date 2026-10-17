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
-- ============================================================================
-- WAVE-09-EVENT-SITES-ROLLBACK.sql   (STAGING ONLY — reverts UPGRADE)
-- ----------------------------------------------------------------------------
-- Restores the four event_sites policies to role `public`, matching the
-- production baseline exactly. Same names/commands/predicates. Atomic.
-- ============================================================================
begin;

drop policy if exists "event_sites_select" on public.event_sites;
create policy "event_sites_select" on public.event_sites
  for select to public
  using (has_area('quotes'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_insert" on public.event_sites;
create policy "event_sites_insert" on public.event_sites
  for insert to public
  with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_update" on public.event_sites;
create policy "event_sites_update" on public.event_sites
  for update to public
  using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)))
  with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_delete" on public.event_sites;
create policy "event_sites_delete" on public.event_sites
  for delete to public
  using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

commit;
