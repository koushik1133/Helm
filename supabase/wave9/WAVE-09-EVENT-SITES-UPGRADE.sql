-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
-- a156guard top: the transaction opened here stays open until the bundle's own first COMMIT, so a refusal
-- aborts everything up to it (psql too); the copy inside each later transaction stops the rest
begin;
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- ==========================================================================================
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
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- a156guard txn: the refusal above runs INSIDE a transaction, so under psql -f without ON_ERROR_STOP
-- every later statement fails too ("current transaction is aborted") and nothing is applied.

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
