-- 0203_anon_grant_tidy.sql - CANONICAL forward-only. REQUIRES 0004 (current_org_id), phase57 RLS.
--
-- In plain words (live audit 2026-10-18, security gaps "anonymous API errors name internal objects"):
-- with only the public (anon) key, a direct API read of a few studio tables answered
--   "permission denied for function current_org_id"   (profiles, layouts, client_booklets, coupons,
--                                                      event_sites)
-- and venues answered with a GRANT hint. The data was never exposed: every one of those tables only
-- shows a row to a signed-in member of the same studio (row level security). But the anon role still
-- held table privileges on them, so the database evaluated the studio rule for an anonymous caller
-- and the error named an internal function.
--
-- Nobody signed out ever reads those tables directly: the public pages (client quote / approve page,
-- client booklet, invitation sites /i/<slug>, portal, worker link, invite accept) all go through
-- SECURITY DEFINER functions (public_get_quote, public_get_booklet, public_event_site, ...), which run
-- as the table owner and are not affected by anon table privileges. So this migration takes the anon
-- table privileges away and points the studio-only policies at signed-in callers:
--   1) REVOKE ALL ... FROM anon on profiles, layouts, venues, client_booklets, coupons, event_sites;
--   2) the 14 studio-only PERMISSIVE policies on those tables that were created "to public" now say
--      "to authenticated" (their USING / WITH CHECK rules are unchanged). An anonymous read now gets a
--      plain "permission denied for table ..." and never runs current_org_id().
-- The signed-in role (authenticated), service_role and every function keep exactly what they had.
-- current_org_id() stays NOT executable by anon (unchanged).
--
-- Changes: privileges (REVOKE ... FROM anon) + the role list of 14 policies (public -> authenticated).
-- No table, column, function or row is created, changed or deleted; no policy rule (USING / WITH CHECK)
-- is changed; restrictive policies are untouched. Additive in effect (it only narrows what anon may do) + idempotent: safe to run
-- twice. ASCII only.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise notice '0203: no anon role on this database - nothing to do';
  end if;
end $$;

-- ---- 1) the named tables -------------------------------------------------------------------------
do $$ declare t text; begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then return; end if;
  foreach t in array array['profiles', 'layouts', 'venues', 'client_booklets', 'coupons', 'event_sites'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon', t);
    end if;
  end loop;
end $$;

-- ---- 2) studio-only policies apply to signed-in callers only ------------------------------------------
-- Taking the table privilege away is not enough on its own: PostgreSQL adds a table's row level security
-- policies for every role they name BEFORE it checks the table privilege, and these policies were created
-- "to public" (which includes anon). So an anonymous read still ran current_org_id() first and failed
-- with that function's name. Each policy below only ever lets a signed-in member of the row's studio
-- through (org_id = current_org_id(), or the caller's own profile row) - anon can never pass any of them -
-- so it is moved from "public" to "authenticated". USING / WITH CHECK are NOT changed; only the role list.
-- RESTRICTIVE policies are never touched (moving one could loosen a rule). A policy that does not exist
-- or no longer names "public" is skipped (another migration changed it - left as it is).
do $$ declare r record; begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then return; end if;
  for r in
    select p.tablename, p.policyname
      from pg_policies p
      join (values
        ('profiles', 'profiles_select'),
        ('layouts', 'layouts_select'), ('layouts', 'layouts_ins'), ('layouts', 'layouts_upd'), ('layouts', 'layouts_del'),
        ('client_booklets', 'client_booklets_read'),
        ('coupons', 'coupons_select'), ('coupons', 'coupons_ins'), ('coupons', 'coupons_upd'), ('coupons', 'coupons_del'),
        ('event_sites', 'event_sites_select'), ('event_sites', 'event_sites_insert'), ('event_sites', 'event_sites_update'),
        ('event_sites', 'event_sites_delete')
      ) w(t, pol) on w.t = p.tablename and w.pol = p.policyname
     where p.schemaname = 'public'
       and p.permissive = 'PERMISSIVE'
       and p.roles = array['public']::name[]
       and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'current_org_id\('
  loop
    execute format('alter policy %I on public.%I to authenticated', r.policyname, r.tablename);
    raise notice '0203: policy %.% now applies to signed-in callers only', r.tablename, r.policyname;
  end loop;
end $$;

notify pgrst, 'reload schema';
