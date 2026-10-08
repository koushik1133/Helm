-- ============================================================================
-- 0060_studio_avatars.sql -- CANONICAL forward-only. Profile photos for the new
-- top-bar profile menu and for team chips. REQUIRES 0041 (member_profiles).
--
-- In plain words:
--   * Photos are already stored by 0041: member_profiles.avatar_path (RLS on, no
--     direct client access, own-row writes only through set_my_avatar) and the
--     private 'member-avatars' bucket (readable only inside the uploader's studio).
--     NOTHING about storage changes here.
--   * studio_avatars() -- signed-in studio member (never a client, never signed out).
--     Lists the members of the caller's OWN studio with only: user id, display name,
--     role and photo path. No phone, e-mail, city or emergency contact. Lets the
--     profile menu, Control Center team list, chat and task chips show photos
--     without each page needing the 'users' area.
--
-- Additive + idempotent: 1 new function, 0 tables. NO existing row is changed.
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
