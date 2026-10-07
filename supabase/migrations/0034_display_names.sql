-- ============================================================================
-- 0034_display_names.sql — CANONICAL forward-only. Display names in chat.
--
-- Problem: chat showed teammates as "Member" (or just their role). Two causes:
--   a) nobody could set a name: 0021 revoked UPDATE on profiles from every API
--      role (correctly — that closed the self-promote-to-admin hole), and no RPC
--      wrote profiles.full_name;
--   b) the chat roster read profiles straight through RLS, and 0006 only lets a
--      member see colleagues' rows with the users-view capability — so most staff
--      saw only their own row, i.e. everyone else was "Member".
--
-- What this adds, in plain words:
--   1  set_my_display_name(name) — any signed-in person names themselves.
--   2  admin_set_display_name(user, name) — a studio admin names a member of
--      THEIR OWN studio (another studio's user → "not authorized").
--   3  chat_directory() — every signed-in member can list the people in their own
--      studio for chat: id, display name, the part of the e-mail before "@", and
--      role. Nothing else (no full e-mail, no other studio).
--   Names are trimmed (inner runs of spaces/newlines become one space), must be
--   1-80 characters and may not contain < or > or control characters. Every
--   change writes an audit_log row (action 'profile.display_name').
--
-- Only full_name is ever written; role / studio / e-mail stay admin-RPC-only and
-- the 0021 guard trigger is untouched. No existing row is changed by this file.
-- Idempotent (create or replace + re-runnable grants). Additive. Forward-only.
-- ============================================================================

-- 1) shared validator (internal) ---------------------------------------------
create or replace function public._clean_display_name(p_name text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v = '' or char_length(v) > 80 then
    raise exception 'A display name must be 1 to 80 characters.' using errcode = '22023';
  end if;
  if v ~ '[<>]' then
    raise exception 'A display name can''t contain < or >.' using errcode = '22023';
  end if;
  if v ~ '[[:cntrl:]]' then
    raise exception 'A display name can''t contain control characters.' using errcode = '22023';
  end if;
  return v;
end $$;
revoke all on function public._clean_display_name(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._clean_display_name(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._clean_display_name(text) from authenticated'; end if;
end $$;

-- 2) self: name yourself -------------------------------------------------------
create or replace function public.set_my_display_name(p_name text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_old text; v_org uuid; v_email text; v_name text;
begin
  if v_me is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.full_name, p.org_id, p.email into v_old, v_org, v_email
    from public.profiles p where p.id = v_me for update;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;
  v_name := public._clean_display_name(p_name);
  if v_old is distinct from v_name then
    update public.profiles set full_name = v_name where id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'profile.display_name', 'profiles', v_me::text, v_org,
              jsonb_build_object('full_name', jsonb_build_object('old', v_old, 'new', v_name), 'by', 'self'));
  end if;
  return v_name;
end $$;

-- 3) admin: name a member of your own studio ------------------------------------
create or replace function public.admin_set_display_name(p_user uuid, p_name text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_old text; v_name text; v_email text;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select p.full_name into v_old from public.profiles p
   where p.id = p_user and p.org_id = v_org for update;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;   -- unknown or another studio's user
  v_name := public._clean_display_name(p_name);
  if v_old is distinct from v_name then
    update public.profiles set full_name = v_name where id = p_user and org_id = v_org;
    select p.email into v_email from public.profiles p where p.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'profile.display_name', 'profiles', p_user::text, v_org,
              jsonb_build_object('full_name', jsonb_build_object('old', v_old, 'new', v_name), 'by', 'admin'));
  end if;
  return v_name;
end $$;

-- 4) chat directory: the people in my own studio (names only) -------------------
create or replace function public.chat_directory()
returns table(id uuid, full_name text, email_name text, role text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name, nullif(split_part(coalesce(p.email, ''), '@', 1), ''), p.role
    from public.profiles p
   where auth.uid() is not null
     and p.org_id = public.current_org_id()
   order by lower(coalesce(p.full_name, p.email, '')), p.id;
$$;

-- grants: signed-in users only (never anon / public) ----------------------------
revoke all on function public.set_my_display_name(text) from public;
revoke all on function public.admin_set_display_name(uuid, text) from public;
revoke all on function public.chat_directory() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.set_my_display_name(text) from anon';
    execute 'revoke all on function public.admin_set_display_name(uuid, text) from anon';
    execute 'revoke all on function public.chat_directory() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.set_my_display_name(text) to authenticated';
    execute 'grant execute on function public.admin_set_display_name(uuid, text) to authenticated';
    execute 'grant execute on function public.chat_directory() to authenticated';
  end if;
end $$;

-- ============================================================================
-- HQ operators never join or create a studio (server backstop; the login page
-- already routes them to /hq). service_role / owner scripts have no auth.uid(),
-- so is_platform_admin() is false for them and they are unaffected.
-- ============================================================================
create or replace function public.tg_no_studio_for_operator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and public.is_platform_admin() then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_no_studio_for_operator() from public, anon, authenticated;
drop trigger if exists ab_no_studio_for_operator on public.organizations;
create trigger ab_no_studio_for_operator before insert on public.organizations
  for each row execute function public.tg_no_studio_for_operator();

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select has_function_privilege('anon','public.admin_set_display_name(uuid,text)','EXECUTE');          -- false
-- select has_function_privilege('authenticated','public.admin_set_display_name(uuid,text)','EXECUTE'); -- true
-- select has_function_privilege('authenticated','public._clean_display_name(text)','EXECUTE');         -- false
