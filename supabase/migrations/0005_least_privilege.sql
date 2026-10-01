-- ============================================================================
-- 0005_least_privilege.sql — CANONICAL forward-only (SEC-05 F4/F5 + SEC-07 G5).
-- Reuses the SEC grant logic, wired into the canonical path.
--   F5: revoke EXECUTE from PUBLIC + anon on EVERY public function, grant it to
--       authenticated + service_role, then RE-grant anon only to the intentional
--       public token RPCs (allowlist below). Closes the Postgres default where a
--       SECURITY DEFINER function is PUBLIC-executable (anon inherits via PUBLIC).
--   F4: additionally strip helm_total_paid + _flag from authenticated — they are
--       internal-only (called by DEFINER RPCs as the owner), never by API roles.
--   G5: ALTER DEFAULT PRIVILEGES so NEW functions are not PUBLIC/anon by default
--       (prevents regressions when future functions are created).
-- Idempotent. Forward-only. Internal DEFINER callers are unaffected (they execute
-- as the function owner, not as anon/authenticated).
-- ============================================================================

-- ---- F5: baseline revoke + grant across all public functions ---------------
do $$ declare f record; begin
  for f in
    select 'public.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as sig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
  loop
    execute 'revoke all on function '||f.sig||' from public';
    execute 'revoke all on function '||f.sig||' from anon';
    execute 'grant execute on function '||f.sig||' to authenticated, service_role';
  end loop;
end $$;

-- ---- re-grant anon ONLY to the intentional public token RPCs ---------------
grant execute on function public.public_get_quote(uuid)      to anon;
grant execute on function public.public_get_portal(uuid)     to anon;
grant execute on function public.public_get_proposal(uuid)   to anon;
grant execute on function public.public_event_site(text)     to anon;
grant execute on function public.request_otp(uuid,text)      to anon;
grant execute on function public.create_payment(uuid)        to anon;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon;
grant execute on function public.worker_get_tasks(uuid)      to anon;
grant execute on function public.worker_get_equipment(uuid)  to anon;
grant execute on function public.worker_respond(uuid,uuid,text) to anon;
grant execute on function public.worker_checkin_equipment(uuid,uuid,numeric) to anon;

-- ---- F4: internal-only / privileged-seed helpers stay OWNER-only --------------
-- (not anon, not authenticated). Includes the SEC-01 lockdown targets so the
-- blanket grant above cannot silently re-open create_helm_user / _notify.
do $$ declare f record; begin
  for f in
    select 'public.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as sig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('helm_total_paid','_flag','create_helm_user','_notify')
  loop
    execute 'revoke all on function '||f.sig||' from anon';
    execute 'revoke all on function '||f.sig||' from authenticated';
    execute 'revoke all on function '||f.sig||' from public';
  end loop;
end $$;

-- ---- G5: default privileges for NEW functions (per owning role) -------------
do $$ declare r record; begin
  for r in select distinct pg_get_userbyid(p.proowner) as owner
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  loop
    begin
      execute format('alter default privileges for role %I in schema public revoke execute on functions from public', r.owner);
      execute format('alter default privileges for role %I in schema public revoke execute on functions from anon', r.owner);
      execute format('alter default privileges for role %I in schema public grant execute on functions to authenticated, service_role', r.owner);
    exception when insufficient_privilege then
      raise notice 'skipped default-privileges for role % (cannot act for it here)', r.owner;
    end;
  end loop;
end $$;

-- ---- VERIFY: anon cannot touch sensitive RPCs; allowlist still anon-exec ----
-- select has_function_privilege('anon','public.admin_create_user(text,text,text)','EXECUTE');      -- expect f
-- select has_function_privilege('anon','public.save_quotation_version(uuid,jsonb)','EXECUTE');     -- expect f
-- select has_function_privilege('anon','public.helm_total_paid(uuid,uuid,uuid)','EXECUTE');        -- expect f
-- select has_function_privilege('anon','public.public_get_portal(uuid)','EXECUTE');                -- expect t
-- ---- ROLLBACK: re-grant as needed (not recommended — reopens PUBLIC execute).
