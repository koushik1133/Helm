-- R21-RESERVED-DOMAIN-DISABLE.sql - OPTIONAL, owner only, AFTER reviewing R21-RESERVED-DOMAIN-REPORT.sql.
-- Turns OFF sign-in for the logins YOU list below (e.g. anil@helm.events). Nothing is deleted: the login,
-- its profile and its studio data all stay exactly as they are. It is fully reversible (UNDO at the bottom).
-- Run AFTER APPLY-0248. Staging first. ASCII only. Safe to run twice (an already-disabled login is skipped).
--
-- How it disables: auth.users.banned_until = 2999-12-31 - Supabase Auth then refuses password, magic-link,
-- Google sign-in AND refreshing an existing session for that login. (A far-future date is used instead of
-- 'infinity' because some Supabase Auth versions cannot read an infinite timestamp, which could break the
-- Dashboard user list.) A session that is already open keeps working until its access token expires
-- (1 hour by default); sign that user out in Dashboard -> Authentication -> Users if it must stop now.
--
-- Protected - the script REFUSES (stops, changes nothing) when a listed address is:
--   * an HQ operator (platform_admins), on the staff allowlist, admin@helm.events or security@helm.events
--   * not on a reserved domain, or has no login
--
-- 1) EDIT the list: exactly the addresses you decided to disable after reading the report.
do $$
declare
  v_targets text[] := array[
    'anil@helm.events'
  ];
  v_e text; v_id uuid; v_n int := 0; v_rows int;
begin
  if to_regprocedure('public.email_is_reserved(text)') is null then raise exception 'STOP: run APPLY-0248.sql first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'banned_until') then
    raise exception 'STOP: auth.users.banned_until not found (not a Supabase Auth database?)'; end if;
  -- check EVERY address first: one bad entry stops the whole script before anything changes
  foreach v_e in array v_targets loop
    v_e := lower(btrim(v_e));
    if v_e in ('admin@helm.events', 'security@helm.events') then raise exception 'STOP: % is protected', v_e; end if;
    if exists (select 1 from public.platform_admins pa where lower(pa.email) = v_e) then raise exception 'STOP: % is an HQ operator', v_e; end if;
    if public.reserved_email_domain(v_e) is null then raise exception 'STOP: % is not on a reserved domain', v_e; end if;
    if not public.email_is_reserved(v_e) then raise exception 'STOP: % is on the staff allowlist - remove it in HQ first if you really mean it', v_e; end if;
    if not exists (select 1 from auth.users u where lower(u.email) = v_e) then raise exception 'STOP: no login for %', v_e; end if;
  end loop;
  foreach v_e in array v_targets loop
    v_e := lower(btrim(v_e));
    select u.id into v_id from auth.users u where lower(u.email) = v_e;
    execute 'update auth.users set banned_until = timestamptz ''2999-12-31 00:00:00+00'' where id = $1 and banned_until is null' using v_id;
    get diagnostics v_rows = row_count;   -- (EXECUTE does not set FOUND)
    if v_rows > 0 then
      v_n := v_n + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (null, null, 'hq.reserved_domain.disable_login', 'auth.users', v_id::text,
                jsonb_build_object('email', v_e, 'banned_until', '2999-12-31', 'by', 'R21-RESERVED-DOMAIN-DISABLE.sql'), null, now());
    end if;
  end loop;
  raise notice 'reserved-domain logins disabled now: %', v_n;
end $$;

-- 2) CHECK (read-only): every listed address should say disabled = true
select lower(u.email) as email, (to_jsonb(u) ->> 'banned_until') is not null as disabled, to_jsonb(u) ->> 'banned_until' as banned_until
  from auth.users u where lower(u.email) in ('anil@helm.events')   -- same list as above
 order by 1;

-- UNDO (only if you change your mind; run on its own, with the address):
--   update auth.users set banned_until = null where lower(email) = 'anil@helm.events';
