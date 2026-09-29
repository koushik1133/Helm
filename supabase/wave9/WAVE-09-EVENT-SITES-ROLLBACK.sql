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
