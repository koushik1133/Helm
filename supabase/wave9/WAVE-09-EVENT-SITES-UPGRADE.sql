-- ============================================================================
-- WAVE-09-EVENT-SITES-UPGRADE.sql   (STAGING ONLY — forward-only, atomic)
-- ----------------------------------------------------------------------------
-- Re-scopes the four event_sites policies from role `public` -> `authenticated`.
-- Postgres cannot ALTER a policy's role, so each is dropped + recreated inside
-- ONE transaction. Policy NAMES, COMMANDS, USING predicates, WITH CHECK
-- predicates, org scoping and has_area(...) are preserved byte-for-byte —
-- only the grantee role changes. RLS stays enabled throughout the txn.
--
-- Predicates are copied verbatim from the production snapshot (2026-09-25).
-- Do NOT run against production. Run PREFLIGHT first; VERIFY after.
-- ============================================================================
begin;

drop policy if exists "event_sites_select" on public.event_sites;
create policy "event_sites_select" on public.event_sites
  for select to authenticated
  using (has_area('quotes'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_insert" on public.event_sites;
create policy "event_sites_insert" on public.event_sites
  for insert to authenticated
  with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_update" on public.event_sites;
create policy "event_sites_update" on public.event_sites
  for update to authenticated
  using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)))
  with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy if exists "event_sites_delete" on public.event_sites;
create policy "event_sites_delete" on public.event_sites
  for delete to authenticated
  using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

commit;
