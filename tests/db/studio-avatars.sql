-- studio-avatars.sql -- 0060 studio_avatars() + profile-photo isolation (0041).
-- Fixture: a_admin/a_staff (studio A), b_admin/b_staff (studio B).
-- One transaction, rolled back at the end. All values are fake test data.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _sa(name text, result text); grant all on _sa to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _sa values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.av(p_email text, p_aal text default 'aal1') returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email, p_aal);
  begin select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into j from public.studio_avatars() r;
  exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j;
end $$;
create or replace function pg_temp.has(j jsonb, u uuid) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_array_elements(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end) e where (e ->> 'user_id')::uuid = u) $$;

do $$ declare u uuid; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su(); set local session_replication_role = replica;
  u := coalesce((select id from auth.users where email = 'sa_client@a.test'), auth.seed_user('sa_client@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'sa_client@a.test', 'Client Person', 'client', a, false, now())
    on conflict (id) do update set role = 'client', org_id = a;
  -- sales has no 'users' area: studio_avatars must still work for it
  delete from public.role_access where org_id = a and role = 'sales' and area = 'users';
  insert into public.member_profiles(user_id, phone, city) values (pg_temp.uid('a_staff@a.test'), '+919811111111', 'Pune')
    on conflict (user_id) do update set phone = excluded.phone, city = excluded.city;
end $$;

-- ---- studio_avatars --------------------------------------------------------------------------
do $$ declare j jsonb; s text; begin
  perform pg_temp.res('01 anon cannot execute', not has_function_privilege('anon', 'public.studio_avatars()', 'execute'));
  perform pg_temp.res('02 members can execute', has_function_privilege('authenticated', 'public.studio_avatars()', 'execute'));
  perform pg_temp.res('03 security definer + pinned search_path',
    (select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.studio_avatars()'::regprocedure));
  perform pg_temp.su(); perform auth.login_anon();
  begin perform count(*) from public.studio_avatars(); s := 'ran'; exception when others then s := sqlstate; end;
  perform pg_temp.res('04 signed-out caller refused', s = '42501', s);
  j := pg_temp.av('sa_client@a.test');
  perform pg_temp.res('05 client role refused', j ->> 'err' = '42501', j::text);
  j := pg_temp.av('a_staff@a.test');
  perform pg_temp.res('06 member (no users area) sees own studio', pg_temp.has(j, pg_temp.uid('a_admin@a.test')) and pg_temp.has(j, pg_temp.uid('a_staff@a.test')), j::text);
  perform pg_temp.res('07 never another studio', not pg_temp.has(j, pg_temp.uid('b_admin@b.test')) and not pg_temp.has(j, pg_temp.uid('b_staff@b.test')), j::text);
  perform pg_temp.res('08 clients not listed', not pg_temp.has(j, pg_temp.uid('sa_client@a.test')), j::text);
  perform pg_temp.res('09 no phone / city / e-mail in rows', j::text not like '%+9198%' and j::text not like '%Pune%' and j::text not like '%@a.test%', j::text);
  j := pg_temp.av('b_admin@b.test');
  perform pg_temp.res('10 studio B sees only B', pg_temp.has(j, pg_temp.uid('b_staff@b.test')) and not pg_temp.has(j, pg_temp.uid('a_admin@a.test')), j::text);
end $$;

-- ---- profile photos (0041): own-row writes, studio-scoped reads ------------------------------
do $$ declare s text; n int; j jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  pa text; pb text; begin
  pa := a::text || '/' || pg_temp.uid('a_staff@a.test')::text || '/' || gen_random_uuid()::text || '.png';
  pb := b::text || '/' || pg_temp.uid('b_staff@b.test')::text || '/' || gen_random_uuid()::text || '.png';
  perform pg_temp.su(); set local session_replication_role = replica;
  insert into storage.objects(id, bucket_id, name, owner) values (gen_random_uuid(), 'member-avatars', pa, pg_temp.uid('a_staff@a.test')),
    (gen_random_uuid(), 'member-avatars', pb, pg_temp.uid('b_staff@b.test'));
  perform pg_temp.res('11 member_profiles not readable directly', not has_table_privilege('authenticated', 'public.member_profiles', 'select'));
  perform pg_temp.res('12 member_profiles RLS on', (select relrowsecurity from pg_class where oid = 'public.member_profiles'::regclass));
  perform pg_temp.login('a_staff@a.test');
  begin perform public.set_my_avatar(pa); s := 'ok'; exception when others then s := sqlstate; end;
  perform pg_temp.res('13 member sets own photo', s = 'ok', s);
  perform pg_temp.login('a_admin@a.test');
  begin perform public.set_my_avatar(pa); s := 'ok'; exception when others then s := sqlstate; end;
  perform pg_temp.res('14 cannot claim a teammate''s photo', s = '22023', s);
  perform pg_temp.login('b_staff@b.test');
  begin perform public.set_my_avatar(pa); s := 'ok'; exception when others then s := sqlstate; end;
  perform pg_temp.res('15 cannot claim another studio''s photo', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from storage.objects o where o.bucket_id = 'member-avatars' and o.name in (pa, pb);
  perform pg_temp.res('16 teammate can read own-studio photo only', n = 1, n::text);
  perform pg_temp.login('b_staff@b.test');
  select count(*) into n from storage.objects o where o.bucket_id = 'member-avatars' and o.name = pa;
  perform pg_temp.res('17 other studio cannot read the photo', n = 0, n::text);
  j := pg_temp.av('a_admin@a.test');
  perform pg_temp.res('18 teammate sees the new photo path', j::text like '%' || pa || '%', j::text);
  j := pg_temp.av('b_admin@b.test');
  perform pg_temp.res('19 other studio never sees the path', j::text not like '%' || pa || '%', j::text);
  perform pg_temp.login('a_staff@a.test');
  begin perform public.set_my_avatar(null); s := 'ok'; exception when others then s := sqlstate; end;
  perform pg_temp.su();
  select count(*) into n from public.member_profiles where user_id = pg_temp.uid('a_staff@a.test') and avatar_path is null and phone = '+919811111111';
  perform pg_temp.res('20 remove clears only the photo (row + phone kept)', s = 'ok' and n = 1, s || n);
end $$;

select name, result from _sa order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 20 then 'STUDIO-AVATARS: ALL PASS (20/20)'
            else 'STUDIO-AVATARS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/20 ran' end from _sa;
rollback;
