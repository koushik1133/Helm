-- ============================================================================
-- Phase 89 — Tenant isolation for the legacy `layouts` table (SEC-01)
-- ---------------------------------------------------------------------------
-- WHY: supabase/schema.sql shipped `layouts` with the policy
--        create policy "anon full access to layouts" on public.layouts
--          for all to anon using (true) with check (true);
--      Because the anon/public key is embedded in public/config.js (by design,
--      RLS-protected) and store-api.js persists floor layouts through the
--      Supabase path (`supa.from('layouts')…`, incl. .delete()), ANY holder of
--      the public key could read / overwrite / DELETE every saved layout across
--      ALL organizations. `layouts` also has no org_id, so it was never
--      multi-tenant scoped.  → SEC-01 (CRITICAL).
--
-- FIX (additive, idempotent, NON-destructive, deny-by-default):
--   1. Add a nullable org_id (server-derived; never client-supplied).
--   2. Stamp org_id = current_org_id() on INSERT via column default + BEFORE
--      trigger (belt-and-suspenders; the client cannot forge it).
--   3. Drop the anon "using(true)" policy; add authenticated, org-scoped
--      SELECT/INSERT/UPDATE/DELETE policies. Anon gets NO policy → denied.
--   4. Legacy ownerless rows (org_id IS NULL) are QUARANTINED, not deleted:
--      no policy matches a NULL org_id, so they become invisible/immutable to
--      everyone until an operator deliberately assigns an org. We never guess
--      ownership and we never DELETE rows (zero-data-loss guardrail).
--
-- DO NOT BREAK: legitimate authenticated layout save / reopen / Blueprint
--   editor workflow (org_id is stamped automatically, so existing client code
--   needs no change), and existing layout data (preserved; only quarantined if
--   ownerless).
--
-- Run in the numbered-phase order (AFTER phase56/57 which create organizations
-- + current_org_id()). Idempotent & safe to re-run.
-- ============================================================================

-- 1) additive org_id column (nullable so existing rows are preserved) --------
alter table public.layouts add column if not exists org_id uuid references public.organizations(id);

-- 2) server-derived stamping (default + trigger). The client can send anything;
--    the trigger overwrites org_id with the caller's own org, so a forged
--    org_id in the request body cannot place a row in another tenant.
alter table public.layouts alter column org_id set default public.current_org_id();

create or replace function public._layouts_stamp_org() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Always bind the row to the caller's org (ignore any client-supplied value).
  new.org_id := public.current_org_id();
  return new;
end; $$;

drop trigger if exists layouts_stamp_org on public.layouts;
create trigger layouts_stamp_org before insert on public.layouts
  for each row execute function public._layouts_stamp_org();

-- 3) deny-by-default RLS: remove the anon-open policy, add org-scoped ones ----
alter table public.layouts enable row level security;

do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
end $$;

-- NO policy is granted to `anon` → the anonymous/public key is denied entirely.
-- Legacy rows with org_id IS NULL match none of these predicates → quarantined
-- (invisible & immutable, but NOT deleted).
create policy "layouts read"   on public.layouts for select to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) );
create policy "layouts insert" on public.layouts for insert to authenticated
  with check ( org_id = (select public.current_org_id()) );
create policy "layouts update" on public.layouts for update to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) )
  with check ( org_id = (select public.current_org_id()) );
create policy "layouts delete" on public.layouts for delete to authenticated
  using ( org_id is not null and org_id = (select public.current_org_id()) );

-- 4) table grants: authenticated only; strip anon. (RLS is the real gate; this
--    removes even the ability to attempt a query as anon.)
grant select, insert, update, delete on public.layouts to authenticated;
revoke all on public.layouts from anon;

-- helper for operators: how many legacy ownerless rows are quarantined.
-- (SELECT only; assign org deliberately later — do not auto-assign.)
create or replace function public.layouts_quarantined_count() returns bigint
  language sql stable security definer set search_path = public as $$
  select count(*) from public.layouts where org_id is null; $$;
revoke all on function public.layouts_quarantined_count() from anon;
grant execute on function public.layouts_quarantined_count() to authenticated;

notify pgrst, 'reload schema';

-- verify: expect the four org-scoped policies and NO anon policy on layouts.
select policyname, roles::text from pg_policies
 where schemaname='public' and tablename='layouts' order by policyname;
