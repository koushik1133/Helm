-- booklet-images.sql -- 0083: client booklet pictures stored in the database (2d|3d x labels|plain).
-- Upload checks (tenant, edit right, mime, size, magic bytes), anon reader only with a live token,
-- hidden section / hidden style -> nothing, no direct table access. Fixture studios A + B. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bt(name text, result text); grant all on _bt to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _bt values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; e text; tok text; tok2 text; n int;
  jpg text := encode('\xffd8ffe000104a464946'::bytea, 'base64');
  png text := encode('\x89504e470d0a1a0a0000000d49484452'::bytea, 'base64');
  webp text := encode('\x524946462400000057454250565038'::bytea, 'base64');
  big text := encode('\xffd8ff'::bytea || decode(repeat('00', 1572864), 'hex'), 'base64');
begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid); tok := r ->> 'token';

  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_put_image(qa::uuid, '3d', 'labels', 'image/jpeg', jpg);
  perform pg_temp.res('01 editor uploads a JPEG', (r ->> 'ok')::boolean and (r ->> 'bytes')::int = 10, r::text);
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_put_image(qa::uuid, '3d', 'plain', 'image/png', png);
  r := public.booklet_put_image(qa::uuid, '2d', 'labels', 'image/webp', webp);
  perform pg_temp.res('02 PNG + WebP accepted', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/png'', %L)', qa, jpg));
  perform pg_temp.res('03 magic bytes must match the mime', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/gif'', %L)', qa, encode('GIF89a'::bytea, 'base64')));
  perform pg_temp.res('04 other mime refused', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/jpeg'', %L)', qa, big));
  perform pg_temp.res('05 over 1.5 MB refused', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/jpeg'', ''***notbase64'')', qa));
  perform pg_temp.res('06 bad base64 refused', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d_none'', ''labels'', ''image/jpeg'', %L)', qa, jpg))
    || pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''names'', ''image/jpeg'', %L)', qa, jpg));
  perform pg_temp.res('07 only kinds 2d|3d and variants labels|plain', e like '22023%22023%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/jpeg'', %L)', qa, jpg));
  perform pg_temp.res('08 other studio cannot insert', e like '42501%' or e like 'P0002%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_staff_image(%L, ''3d'', ''labels'')', qa))
    || pg_temp.try(format('select public.booklet_image_info(%L)', qa));
  perform pg_temp.res('09 other studio cannot read', e like '%42501%' or e like '%P0002%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select count(*) from public.client_booklet_images') || pg_temp.try('insert into public.client_booklet_images(org_id, quote_id, kind, variant, mime, bytes, data) values (gen_random_uuid(), gen_random_uuid(), ''2d'', ''plain'', ''image/png'', 1, ''\x00'')');
  perform pg_temp.res('10 no direct table access for signed-in users', e like '42501%42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try('select count(*) from public.client_booklet_images');
  perform pg_temp.res('11 no direct table access for anon', e like '42501%', e);

  -- quotes VIEW only (no edit) cannot upload
  perform pg_temp.su();
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''2d'', ''plain'', ''image/jpeg'', %L)', qa, jpg));
  perform pg_temp.res('12 view-only member cannot upload', e like '42501%', e);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'quotes';

  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_image_info(qa::uuid);
  perform pg_temp.res('13 staff info lists kinds/variants', r ? '3d' and (r -> '3d') ? 'labels' and (r -> '3d') ? 'plain' and (r -> '2d') ? 'labels' and not ((r -> '2d') ? 'plain'), r::text);

  perform pg_temp.anon();
  r := public.public_get_booklet(tok::uuid) -> 'images';
  perform pg_temp.res('14 booklet flags images, no bytes', (r #>> '{3d,labels}')::boolean and (r #>> '{3d,plain}')::boolean
    and (r #>> '{2d,labels}')::boolean and not (r #>> '{2d,plain}')::boolean and r::text not like '%/9j%', r::text);
  perform pg_temp.anon();
  r := public.public_get_booklet_image(tok::uuid, '3d', 'labels');
  perform pg_temp.res('15 anon fetches image with live token', r ->> 'mime' = 'image/jpeg' and decode(r ->> 'data', 'base64') = '\xffd8ffe000104a464946'::bytea, coalesce(r::text, 'null'));
  perform pg_temp.anon();
  perform pg_temp.res('16 missing variant / bad args -> null', public.public_get_booklet_image(tok::uuid, '2d', 'plain') is null
    and public.public_get_booklet_image(tok::uuid, '3d_none', 'labels') is null and public.public_get_booklet_image(gen_random_uuid(), '3d', 'labels') is null);

  -- newest upload supersedes, older row kept
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_put_image(qa::uuid, '3d', 'labels', 'image/png', png);
  perform pg_temp.anon();
  r := public.public_get_booklet_image(tok::uuid, '3d', 'labels');
  perform pg_temp.su();
  select count(*) into n from public.client_booklet_images where quote_id = qa::uuid and kind = '3d' and variant = 'labels';
  perform pg_temp.res('17 newest wins; nothing deleted', r ->> 'mime' = 'image/png' and n = 2, coalesce(r::text, 'null') || ' n=' || n);

  -- style switched off on the link
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_set_image_variants(qa::uuid, '{"3d_plain":false}'::jsonb);
  perform pg_temp.anon();
  perform pg_temp.res('18 hidden style -> no image', public.public_get_booklet_image(tok::uuid, '3d', 'plain') is null
    and not (public.public_get_booklet(tok::uuid) #>> '{images,3d,plain}')::boolean
    and public.public_get_booklet_image(tok::uuid, '3d', 'labels') is not null);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_set_image_variants(%L, ''{"3d_names":true}'')', qa))
    || pg_temp.try(format('select public.booklet_set_image_variants(%L, ''{"3d_plain":"yes"}'')', qa));
  perform pg_temp.res('19 unknown / non-boolean styles refused', e like '22023%22023%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_set_image_variants(%L, ''{"3d_plain":true}'')', qa));
  perform pg_temp.res('20 other studio cannot set styles', e <> '', e);

  -- hidden section -> no image
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid, 30, null, null, null, '{"layout3d":false}'::jsonb); tok2 := r ->> 'token';
  perform pg_temp.anon();
  perform pg_temp.res('21 hidden 3D section -> no image, no flag', public.public_get_booklet_image(tok2::uuid, '3d', 'labels') is null
    and not (public.public_get_booklet(tok2::uuid) #>> '{images,3d,labels}')::boolean
    and public.public_get_booklet_image(tok2::uuid, '2d', 'labels') is not null);
  perform pg_temp.anon();
  perform pg_temp.res('22 replaced (revoked) link -> nothing', public.public_get_booklet_image(tok::uuid, '2d', 'labels') is null);

  -- expired
  perform pg_temp.su();
  update public.client_booklets set expires_at = now() - interval '1 minute' where token = tok2::uuid;
  perform pg_temp.anon();
  perform pg_temp.res('23 expired link -> nothing', public.public_get_booklet_image(tok2::uuid, '2d', 'labels') is null);
  perform pg_temp.su();
  update public.client_booklets set expires_at = now() + interval '1 day' where token = tok2::uuid;
  perform pg_temp.login('a_admin@a.test');
  perform public.booklet_revoke(qa::uuid);
  perform pg_temp.anon();
  perform pg_temp.res('24 revoked link -> nothing', public.public_get_booklet_image(tok2::uuid, '2d', 'labels') is null);

  perform pg_temp.res('25 grants: anon only the two readers; definer-safe', has_function_privilege('anon', 'public.public_get_booklet_image(uuid,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.public_get_booklet__pre0083(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_put_image(uuid,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_staff_image(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_image_info(uuid)', 'execute')
    and (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p where p.oid in
      ('public.public_get_booklet(uuid)'::regprocedure, 'public.public_get_booklet_image(uuid,text,text)'::regprocedure,
       'public.booklet_put_image(uuid,text,text,text,text)'::regprocedure, 'public.booklet_image_info(uuid)'::regprocedure,
       'public.booklet_staff_image(uuid,text,text)'::regprocedure, 'public.booklet_set_image_variants(uuid,jsonb)'::regprocedure)));
end $$;

select name, result from _bt order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'BOOKLET-IMAGES: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'BOOKLET-IMAGES: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bt;
rollback;
