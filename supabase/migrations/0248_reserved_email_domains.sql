-- 0248_reserved_email_domains.sql - CANONICAL forward-only.
-- REQUIRES 0029 (platform_admins, is_platform_admin), 0045 + 0047 (_hq_gate / _hq_wgate: HQ read + audited
--          write gate), base audit_log, public.invitations.
--
-- In plain words (owner, r21: "Someone signed up as anil@helm.events. We don't want ANYONE signing up with
-- helm.events ... we might have a new internal team later"):
--   Addresses on Helm's own domains (helm.events, helm.com and every sub-domain such as team.helm.events)
--   are for the Helm team only. A customer can't make a login with one any more - by any route - unless
--   HQ deliberately put that exact address on the staff allowlist first.
--   1  NEW table reserved_email_domains (seeded: helm.events, helm.com - both "built in", can't be removed).
--      HQ can add look-alike domains later (e.g. a typo domain someone registers to phish customers).
--   2  NEW table staff_email_allowlist: the exact addresses that MAY have a login on a reserved domain.
--      Seeded with admin@helm.events, security@helm.events and every current HQ operator (platform_admins).
--      An HQ operator's address always counts as allowlisted. "Remove" only marks the row removed
--      (removed_at) - nothing is ever deleted, and a removed row can be added back.
--   3  email_is_reserved(email): true when the address is on a reserved domain (or a sub-domain) and NOT
--      allowlisted. Case, spaces and a trailing dot are ignored ("Anil@HELM.events. " is caught);
--      "+tags" never match an allowlisted address ("admin+x@helm.events" is NOT admin@helm.events).
--   4  hook_before_user_created(event): the Supabase Auth "Before User Created" hook. Supabase calls it
--      before EVERY new login it makes - e-mail + password sign-up, magic link / OTP sign-up, Google and
--      other OAuth, SSO, invite e-mails, anonymous - and a reserved address gets
--      {"error": {"http_code": 403, "message": "Addresses on helm.events are reserved for the Helm team. ..."}}.
--      DORMANT until the owner turns it on: Dashboard -> Authentication -> Hooks -> "Before User Created"
--      -> Postgres -> schema public -> function hook_before_user_created.
--   5  Backstop that needs no switch: a guard trigger on auth.users refuses (a) a NEW login on a reserved
--      address and (b) CHANGING a login's e-mail to one (also a pending change in email_change). This
--      catches the routes the hook does not see: the admin API (auth.admin.createUser - used by the
--      invite-signup edge function), Control Center "create user with a temporary password"
--      (admin_create_user_temp inserts into auth.users) and e-mail changes. Existing logins are never
--      touched: a row whose e-mail does not change passes untouched (sign-ins, bans, password changes...).
--   6  A guard trigger on invitations: a studio can't invite an address on a reserved domain (new rows and
--      e-mail changes only; existing invitation rows are not changed).
--   7  HQ "Staff access" (operators only, every change audit-logged through _hq_wgate):
--      hq_staff_access() lists reserved domains, the allowlist and every EXISTING login on a reserved
--      domain (read-only report); hq_staff_allow_add / hq_staff_allow_remove;
--      hq_reserved_domain_add / hq_reserved_domain_remove (built-in domains can't be removed).
--   EXISTING accounts (e.g. anil@helm.events) are NOT changed, banned or deleted here. The owner reviews
--   them (HQ -> Staff access, or supabase/R21-RESERVED-DOMAIN-REPORT.sql) and may disable sign-in with the
--   separate, reversible supabase/R21-RESERVED-DOMAIN-DISABLE.sql.
--   Changes: 2 new tables, 2 new triggers, new functions, grants, seed rows (on conflict do nothing).
--   No existing table / column / row / policy / function is changed or deleted. Additive + idempotent.
--   Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no customer data involved):
--   first switch the hook off in the Dashboard (Authentication -> Hooks), then
--   drop trigger if exists a248_reserved_email_guard on auth.users;
--   drop trigger if exists a248_reserved_email_guard on public.invitations;
--   (the two tables and functions can stay; they do nothing on their own.)

do $$ begin
  if to_regclass('public.platform_admins') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP: 0029 (platform_admins / is_platform_admin) is not applied'; end if;
  if to_regprocedure('public._hq_gate(text,text)') is null or to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then
    raise exception 'STOP: 0029 / 0045 / 0047 (_hq_gate / _hq_wgate) is not applied'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: base audit_log table missing'; end if;
  if to_regclass('public.invitations') is null then raise exception 'STOP: invitations table missing'; end if;
  if to_regclass('auth.users') is null then raise exception 'STOP: auth.users missing'; end if;
end $$;

-- ---- 1) tables (private: RLS on, no client grants; only the definer functions below read them) -------------
create table if not exists public.reserved_email_domains (
  domain             text primary key
                     check (domain = lower(domain) and length(domain) <= 253
                            and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  include_subdomains boolean not null default true,
  builtin            boolean not null default false,
  note               text check (note is null or length(note) <= 200),
  added_at           timestamptz not null default now(),
  added_by           text,
  removed_at         timestamptz,
  removed_by         text
);
alter table public.reserved_email_domains enable row level security;

create table if not exists public.staff_email_allowlist (
  email      text primary key check (email = lower(btrim(email)) and position('@' in email) > 1 and length(email) <= 254),
  note       text check (note is null or length(note) <= 200),
  added_at   timestamptz not null default now(),
  added_by   text,
  removed_at timestamptz,
  removed_by text
);
alter table public.staff_email_allowlist enable row level security;

do $$ declare t text; begin
  foreach t in array array['public.reserved_email_domains', 'public.staff_email_allowlist'] loop
    execute format('revoke all on table %s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table %s from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table %s from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table %s to service_role', t); end if;
  end loop;
end $$;
-- (no policies on purpose: with RLS on and no grants, only definer code reads them)

insert into public.reserved_email_domains(domain, include_subdomains, builtin, note, added_by) values
  ('helm.events', true, true, 'Helm''s own domain', 'migration 0248'),
  ('helm.com',    true, true, 'Helm''s own domain', 'migration 0248')
on conflict (domain) do nothing;

insert into public.staff_email_allowlist(email, note, added_by) values
  ('admin@helm.events',    'HQ operator (0029)', 'migration 0248'),
  ('security@helm.events', 'HQ operator (0029)', 'migration 0248')
on conflict (email) do nothing;

-- ---- 2) the check -----------------------------------------------------------------------------------------
-- "Anil@HELM.events. " -> "anil@helm.events" (lower case, trimmed, trailing dots of the domain dropped)
create or replace function public._r248_norm_email(p_email text)
returns text language sql immutable set search_path = '' as $$
  select case when position('@' in e) > 1
              then left(e, length(e) - position('@' in reverse(e))) || '@' || rtrim(right(e, position('@' in reverse(e)) - 1), '.')
              else e end
    from (select lower(btrim(coalesce(p_email, ''))) as e) x
$$;

-- the reserved domain an address falls under (ignores the allowlist), or null
create or replace function public.reserved_email_domain(p_email text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_e text := public._r248_norm_email(p_email);
  v_host text;
begin
  if position('@' in v_e) < 2 then return null; end if;
  v_host := right(v_e, position('@' in reverse(v_e)) - 1);
  if v_host = '' then return null; end if;
  return (select d.domain from public.reserved_email_domains d
           where d.removed_at is null
             and (v_host = d.domain or (d.include_subdomains and right(v_host, length(d.domain) + 1) = '.' || d.domain))
           order by d.builtin desc, length(d.domain) desc limit 1);
end $$;

-- true = this address may NOT have a login (reserved domain, not allowlisted, not an HQ operator)
create or replace function public.email_is_reserved(p_email text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_e text := public._r248_norm_email(p_email);
begin
  if v_e = '' or public.reserved_email_domain(v_e) is null then return false; end if;
  if exists (select 1 from public.staff_email_allowlist a where a.email = v_e and a.removed_at is null) then return false; end if;
  if exists (select 1 from public.platform_admins pa where lower(pa.email) = v_e) then return false; end if;
  return true;
end $$;

create or replace function public._r248_message(p_email text)
returns text language sql stable security definer set search_path = '' as $$
  select 'Addresses on ' || coalesce(public.reserved_email_domain(p_email), 'helm.events')
         || ' are reserved for the Helm team. Please use your own e-mail address.'
$$;

-- every current HQ operator on a reserved domain is allowlisted too (they also always count as allowlisted)
insert into public.staff_email_allowlist(email, note, added_by)
  select pa.email, 'HQ operator', 'migration 0248' from public.platform_admins pa
   where pa.email = lower(btrim(pa.email)) and position('@' in pa.email) > 1 and length(pa.email) <= 254
     and public.reserved_email_domain(pa.email) is not null
on conflict (email) do nothing;

-- ---- 3) Supabase Auth "Before User Created" hook ------------------------------------------------------------
-- event = {"metadata": {...}, "user": {"email": ..., "app_metadata": {"provider": ...}, ...}}
-- allow -> {} ; block -> {"error": {"http_code": 403, "message": "..."}} (Supabase passes the message on).
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_email text;
  v_blocked boolean := false;
begin
  begin
    v_email := nullif(btrim(coalesce(event -> 'user' ->> 'email', '')), '');
    if v_email is not null then v_blocked := public.email_is_reserved(v_email); end if;
  exception when others then
    return '{}'::jsonb;        -- malformed event / our bug: never block every sign-up (the auth.users guard still runs)
  end;
  if v_blocked then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', public._r248_message(v_email)));
  end if;
  return '{}'::jsonb;
end $$;

revoke all on function public.hook_before_user_created(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hook_before_user_created(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.hook_before_user_created(jsonb) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then revoke all on function public.hook_before_user_created(jsonb) from service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---- 4) backstop guards (no switch needed) ------------------------------------------------------------------
create or replace function public.tg_r248_auth_users_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_bad text := null;
begin
  begin
    if tg_op = 'INSERT' then
      if new.email is not null and public.email_is_reserved(new.email) then v_bad := new.email; end if;
    else
      if new.email is not null
         and public._r248_norm_email(new.email) is distinct from public._r248_norm_email(old.email)
         and public.email_is_reserved(new.email) then v_bad := new.email; end if;
      if v_bad is null and coalesce(new.email_change, '') <> ''
         and new.email_change is distinct from old.email_change
         and public.email_is_reserved(new.email_change) then v_bad := new.email_change; end if;
    end if;
  exception when others then
    v_bad := null;             -- our bug must never stop Supabase Auth working
  end;
  if v_bad is not null then
    raise exception '%', public._r248_message(v_bad) using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.tg_r248_invitations_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_bad boolean := false;
begin
  begin
    v_bad := new.email is not null and coalesce(btrim(new.email), '') <> ''
             and (tg_op = 'INSERT' or public._r248_norm_email(new.email) is distinct from public._r248_norm_email(old.email))
             and public.email_is_reserved(new.email);
  exception when others then
    v_bad := false;
  end;
  if v_bad then
    raise exception '%', public._r248_message(new.email) using errcode = '22023';
  end if;
  return new;
end $$;

do $$ declare f text; begin
  foreach f in array array['public._r248_norm_email(text)', 'public.reserved_email_domain(text)', 'public.email_is_reserved(text)',
                           'public._r248_message(text)', 'public.tg_r248_auth_users_guard()', 'public.tg_r248_invitations_guard()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- edge functions (service role) ask the database first: email_is_reserved knows HQ's extra domains + the allowlist
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.email_is_reserved(text) to service_role';
    execute 'grant execute on function public.reserved_email_domain(text) to service_role';
  end if;
end $$;

drop trigger if exists a248_reserved_email_guard on auth.users;
create trigger a248_reserved_email_guard before insert or update of email, email_change on auth.users
  for each row execute function public.tg_r248_auth_users_guard();

drop trigger if exists a248_reserved_email_guard on public.invitations;
create trigger a248_reserved_email_guard before insert or update of email on public.invitations
  for each row execute function public.tg_r248_invitations_guard();

-- ---- 5) HQ "Staff access" (operators only; writes audited by _hq_wgate) ------------------------------------
create or replace function public.hq_staff_access()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_accounts jsonb;
begin
  perform public._hq_gate('hq_staff_access');
  -- every EXISTING login on a reserved domain (read-only). banned_until read via to_jsonb (drift-safe).
  select coalesce(jsonb_agg(x order by x ->> 'created_at'), '[]'::jsonb) into v_accounts from (
    select jsonb_build_object(
             'user_id', u.id, 'email', lower(u.email), 'domain', public.reserved_email_domain(u.email),
             'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
             'confirmed', u.email_confirmed_at is not null,
             'banned_until', to_jsonb(u) ->> 'banned_until',
             'studio', (select o.name from public.profiles p join public.organizations o on o.id = p.org_id where p.id = u.id),
             'role', (select p.role from public.profiles p where p.id = u.id),
             'is_platform_admin', exists (select 1 from public.platform_admins pa where lower(pa.email) = lower(u.email)),
             'allowlisted', not public.email_is_reserved(u.email)) as x
      from auth.users u
     where u.email is not null and public.reserved_email_domain(u.email) is not null
     limit 1000) z;
  return jsonb_build_object(
    'domains', coalesce((select jsonb_agg(jsonb_build_object('domain', d.domain, 'include_subdomains', d.include_subdomains,
                 'builtin', d.builtin, 'note', d.note, 'added_at', d.added_at, 'added_by', d.added_by) order by d.builtin desc, d.domain)
               from public.reserved_email_domains d where d.removed_at is null), '[]'::jsonb),
    'allowlist', coalesce((select jsonb_agg(jsonb_build_object('email', a.email, 'note', a.note, 'added_at', a.added_at,
                 'added_by', a.added_by, 'is_platform_admin', exists (select 1 from public.platform_admins pa where lower(pa.email) = a.email),
                 'has_login', exists (select 1 from auth.users u where lower(u.email) = a.email)) order by a.email)
               from public.staff_email_allowlist a where a.removed_at is null), '[]'::jsonb),
    'accounts', v_accounts);
end $$;

create or replace function public.hq_staff_allow_add(p_email text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_email text := public._r248_norm_email(p_email);
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_by text;
begin
  perform public._hq_wgate('hq.staff_allowlist.add', 'staff_email_allowlist', v_email, jsonb_build_object('note', v_note));
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'enter a valid e-mail' using errcode = '22023'; end if;
  if public.reserved_email_domain(v_email) is null then
    raise exception 'only addresses on a reserved domain need the staff allowlist' using errcode = '22023'; end if;
  select u.email into v_by from auth.users u where u.id = auth.uid();
  insert into public.staff_email_allowlist(email, note, added_by) values (v_email, v_note, coalesce(v_by, 'hq'))
  on conflict (email) do update set removed_at = null, removed_by = null, note = coalesce(excluded.note, public.staff_email_allowlist.note),
                                    added_at = now(), added_by = excluded.added_by
   where public.staff_email_allowlist.removed_at is not null;
  return jsonb_build_object('email', v_email, 'allowlisted', true);
end $$;

-- marks the row removed (kept for the record). An HQ operator's address can't be removed here.
create or replace function public.hq_staff_allow_remove(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_email text := public._r248_norm_email(p_email);
  v_by text;
begin
  perform public._hq_wgate('hq.staff_allowlist.remove', 'staff_email_allowlist', v_email);
  if exists (select 1 from public.platform_admins pa where lower(pa.email) = v_email) then
    raise exception 'this is an HQ operator - remove the operator first' using errcode = '22023'; end if;
  select u.email into v_by from auth.users u where u.id = auth.uid();
  update public.staff_email_allowlist set removed_at = now(), removed_by = coalesce(v_by, 'hq')
   where email = v_email and removed_at is null;
  if not found then raise exception 'not on the staff allowlist' using errcode = '22023'; end if;
  return jsonb_build_object('email', v_email, 'removed', true);
end $$;

create or replace function public.hq_reserved_domain_add(p_domain text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_dom text := rtrim(lower(btrim(coalesce(p_domain, ''))), '.');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
  v_by text;
begin
  v_dom := regexp_replace(v_dom, '^@', '');
  perform public._hq_wgate('hq.reserved_domain.add', 'reserved_email_domains', v_dom, jsonb_build_object('note', v_note));
  if length(v_dom) > 253 or v_dom !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'enter a domain like helm-events.com' using errcode = '22023'; end if;
  select u.email into v_by from auth.users u where u.id = auth.uid();
  insert into public.reserved_email_domains(domain, include_subdomains, builtin, note, added_by)
    values (v_dom, true, false, v_note, coalesce(v_by, 'hq'))
  on conflict (domain) do update set removed_at = null, removed_by = null, note = coalesce(excluded.note, public.reserved_email_domains.note),
                                     added_at = now(), added_by = excluded.added_by
   where public.reserved_email_domains.removed_at is not null;
  return jsonb_build_object('domain', v_dom, 'reserved', true);
end $$;

create or replace function public.hq_reserved_domain_remove(p_domain text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r21-reserved-domain-0248
  v_dom text := rtrim(lower(btrim(coalesce(p_domain, ''))), '.');
  v_by text;
begin
  perform public._hq_wgate('hq.reserved_domain.remove', 'reserved_email_domains', v_dom);
  if exists (select 1 from public.reserved_email_domains d where d.domain = v_dom and d.builtin) then
    raise exception 'Helm''s own domains can''t be removed' using errcode = '22023'; end if;
  select u.email into v_by from auth.users u where u.id = auth.uid();
  update public.reserved_email_domains set removed_at = now(), removed_by = coalesce(v_by, 'hq')
   where domain = v_dom and removed_at is null;
  if not found then raise exception 'not a reserved domain' using errcode = '22023'; end if;
  return jsonb_build_object('domain', v_dom, 'removed', true);
end $$;

do $$ declare f text; begin
  foreach f in array array['public.hq_staff_access()', 'public.hq_staff_allow_add(text,text)', 'public.hq_staff_allow_remove(text)',
                           'public.hq_reserved_domain_add(text,text)', 'public.hq_reserved_domain_remove(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 tables exist, RLS on, closed to clients',
     coalesce((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.reserved_email_domains'::regclass, 'public.staff_email_allowlist'::regclass)), false)
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or (not has_table_privilege('authenticated', 'public.reserved_email_domains', 'select')
              and not has_table_privilege('authenticated', 'public.staff_email_allowlist', 'select')))),
  ('02 helm.events + helm.com reserved (built in)',
     (select count(*) from public.reserved_email_domains where domain in ('helm.events', 'helm.com') and builtin and removed_at is null) = 2),
  ('03 admin@ / security@ / every HQ operator allowlisted',
     not public.email_is_reserved('admin@helm.events') and not public.email_is_reserved('security@helm.events')
     and not exists (select 1 from public.platform_admins pa where public.email_is_reserved(pa.email))),
  ('04 the check: reserved, sub-domain, case/space tricks blocked; normal e-mail passes',
     public.email_is_reserved('anil@helm.events') and public.email_is_reserved(' Anil@HELM.Events. ')
     and public.email_is_reserved('x@team.helm.events') and public.email_is_reserved('admin+x@helm.events')
     and not public.email_is_reserved('anil@gmail.com') and not public.email_is_reserved('anil@nothelm.events')),
  ('05 hook returns the Supabase error shape for a reserved address and {} otherwise',
     (public.hook_before_user_created('{"user":{"email":"anil@helm.events"}}'::jsonb) -> 'error' ->> 'http_code') = '403'
     and public.hook_before_user_created('{"user":{"email":"anil@gmail.com"}}'::jsonb) = '{}'::jsonb),
  ('06 hook callable only by supabase_auth_admin',
     (not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
      or has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'authenticated')
          or not has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or not has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute'))),
  ('07 guard triggers on auth.users and invitations',
     exists (select 1 from pg_trigger where tgname = 'a248_reserved_email_guard' and tgrelid = 'auth.users'::regclass and not tgisinternal)
     and exists (select 1 from pg_trigger where tgname = 'a248_reserved_email_guard' and tgrelid = 'public.invitations'::regclass and not tgisinternal)),
  ('08 HQ staff access functions: signed-in may call (operator check inside), anon may not',
     (not exists (select 1 from pg_roles where rolname = 'authenticated')
      or has_function_privilege('authenticated', 'public.hq_staff_access()', 'execute'))
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or not has_function_privilege('anon', 'public.hq_staff_allow_add(text,text)', 'execute')))
) v(item, ok) order by item;
