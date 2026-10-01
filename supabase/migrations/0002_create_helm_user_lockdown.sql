-- ============================================================================
-- 0002_create_helm_user_lockdown.sql — CANONICAL forward-only (SEC-01, CRITICAL).
-- Reuses supabase/security-fix/SEC-01, now wired into the deterministic path so a
-- clean deploy is NOT exposed. Idempotent. Forward-only.
--
-- CLOSES: public.create_helm_user(text,text,text) is SECURITY DEFINER with the
-- default PUBLIC EXECUTE and no caller-auth check — any anon/authenticated caller
-- could reset ANY user's password by email and set role=admin (account takeover).
-- Behaviorally FAIL-before confirmed on PG17 (anon EXECUTE = true, no is_admin
-- check). The app's real user-creation path is admin_create_user() (is_admin +
-- org gated), which is unaffected.
--
-- FIX: revoke EXECUTE from anon/authenticated/public on create_helm_user + _notify.
-- The dev-seed helper remains callable only by the table owner / superuser (the
-- Supabase SQL editor), so seeding still works; it is no longer reachable via the
-- anon or authenticated API roles.
-- ============================================================================
do $$
declare fn record;
begin
  for fn in
    select 'public.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in ('create_helm_user','_notify')
  loop
    execute 'revoke all on function '||fn.sig||' from anon';
    execute 'revoke all on function '||fn.sig||' from authenticated';
    execute 'revoke all on function '||fn.sig||' from public';
    raise notice 'SEC-01 locked down %', fn.sig;
  end loop;
end $$;

-- ---- VERIFY (expect status = PASS — locked) --------------------------------
-- select p.proname,
--   case when bool_or(r.rolname in ('anon','authenticated')
--                     and has_function_privilege(r.oid,p.oid,'EXECUTE'))
--        then 'FAIL — still reachable' else 'PASS — locked' end as status
-- from pg_proc p join pg_namespace n on n.oid=p.pronamespace
-- cross join (select oid,rolname from pg_roles where rolname in ('anon','authenticated')) r
-- where n.nspname='public' and p.proname in ('create_helm_user','_notify')
-- group by p.proname;
-- ---- ROLLBACK: grant execute on function public.create_helm_user(text,text,text) to authenticated; (NOT recommended)
