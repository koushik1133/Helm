-- =====================================================================
-- SEC-01 (CRITICAL) — lock down create_helm_user + _notify
-- =====================================================================
-- FINDING: public.create_helm_user(text,text,text) is SECURITY DEFINER with NO
-- auth/admin/org check, and EXECUTE is granted to anon+authenticated (blanket
-- grant, never revoked). An UNAUTHENTICATED caller can reset ANY existing user's
-- password by email (and set role=admin) → full account takeover → cross-tenant
-- breach. CONFIRMED exploitable at runtime on staging (2026-09-29).
-- Also: public._notify(...) is an internal helper exposed to anon/authenticated,
-- allowing cross-org notification-feed pollution.
--
-- FIX: revoke EXECUTE from anon/authenticated/public on both. The app's real
-- signup/user paths (create_studio, admin_create_user*) are unaffected — they are
-- separate functions with their own guards. Internal callers of _notify run as the
-- function owner (definer) and are NOT affected by revoking the API roles.
--
-- This is additive, forward-only, and reversible (see ROLLBACK). Safe to re-run.
-- Apply on STAGING first, verify anon is blocked, then PRODUCTION.
-- =====================================================================

-- ---- PRECHECK (read-only): who can currently execute these? ----
-- Run this SELECT alone first to see the current grants.
select p.proname,
       pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
       array_agg(distinct r.rolname order by r.rolname)
         filter (where has_function_privilege(r.oid, p.oid, 'EXECUTE')) as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
where n.nspname = 'public' and p.proname in ('create_helm_user','_notify')
group by p.proname, args;

-- ---- APPLY (idempotent) ----
do $$
declare fn record;
begin
  for fn in
    select p.oid,
           'public.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in ('create_helm_user','_notify')
  loop
    execute 'revoke all on function '||fn.sig||' from anon';
    execute 'revoke all on function '||fn.sig||' from authenticated';
    execute 'revoke all on function '||fn.sig||' from public';
    raise notice 'locked down %', fn.sig;
  end loop;
end $$;

-- Optional hard removal (create_helm_user is a dev-seed helper, not used by the
-- running app). Uncomment ONLY after confirming nothing server-side calls it:
--   drop function if exists public.create_helm_user(text,text,text);

-- ---- VERIFY (run last; every row must show can_execute WITHOUT anon/authenticated) ----
select p.proname,
       coalesce(array_agg(distinct r.rolname order by r.rolname)
         filter (where has_function_privilege(r.oid, p.oid, 'EXECUTE')), '{}') as still_executable_by,
       case when bool_or(r.rolname in ('anon','authenticated') and has_function_privilege(r.oid,p.oid,'EXECUTE'))
            then 'FAIL — still reachable' else 'PASS — locked' end as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
where n.nspname='public' and p.proname in ('create_helm_user','_notify')
group by p.proname;

-- ---- ROLLBACK (only if something legitimately depended on the grant) ----
-- grant execute on function public.create_helm_user(text,text,text) to authenticated;
-- (do NOT re-grant to anon under any circumstances)
