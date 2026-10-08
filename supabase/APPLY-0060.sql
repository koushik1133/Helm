-- ============================================================================
-- HELM - 0060 profile photos for the top-bar profile menu (one paste) (2026-10-08)
--   * studio_avatars(): signed-in studio member (not clients, not signed out).
--     Lists own-studio members with ONLY id, display name, role and photo path,
--     so the profile menu, team list, chat and task chips can show photos.
--   * Photo storage itself is unchanged (0041: member_profiles.avatar_path +
--     private 'member-avatars' bucket, readable only inside the same studio).
-- REQUIRES 0041 - the preflight stops if not. STAGING first, then PROD.
-- WHAT IT TOUCHES: 1 new RPC. NO table is created, NO row is deleted or changed.
-- SAFE TO RE-RUN. If anything fails, it rolls back.
-- ============================================================================
do $$ begin
  if to_regclass('public.member_profiles') is null then raise exception '0060: 0041 (member_profiles) is not installed'; end if;
end $$;

create or replace function public.studio_avatars()
returns table(user_id uuid, full_name text, role text, avatar_path text)
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and p.role is not null and p.role <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)), p.role, m.avatar_path
      from public.profiles p
      left join public.member_profiles m on m.user_id = p.id
     where p.org_id = v_org and p.role <> 'client'
     order by p.id;
end $$;
revoke all on function public.studio_avatars() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.studio_avatars() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.studio_avatars() to authenticated'; end if;
end $$;

-- ---- verify (every row should say ok = true) -------------------------------
select item, ok from (values
  ('studio_avatars exists', to_regprocedure('public.studio_avatars()') is not null),
  ('studio_avatars for members', has_function_privilege('authenticated', 'public.studio_avatars()', 'execute')),
  ('studio_avatars not for anon', not has_function_privilege('anon', 'public.studio_avatars()', 'execute')),
  ('studio_avatars is security definer', (select prosecdef from pg_proc where oid = 'public.studio_avatars()'::regprocedure)),
  ('member_profiles RLS still on', (select relrowsecurity from pg_class where oid = 'public.member_profiles'::regclass)),
  ('member_profiles not readable by clients', not has_table_privilege('authenticated', 'public.member_profiles', 'select')),
  ('avatar bucket private', (select not public from storage.buckets where id = 'member-avatars'))
) v(item, ok);
