-- label-variants.sql -- 0083: booklet pictures in 3 label styles (2d|3d[_none|_names]); kinds validated,
-- tenant-scoped uploads, set/path/flags, carried to a new link. Fixture studios A + B. Rolled back. Fake data only.
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
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; a text := 'a0000000-0000-4000-8000-000000000001';
  b text := 'b0000000-0000-4000-8000-000000000001'; r jsonb; e text; tok text; tok2 text;
begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid); tok := r ->> 'token'; perform pg_temp.put('tok', tok);

  perform pg_temp.res('01 kind list', public._bk_snap_kind_ok('3d_none') and public._bk_snap_kind_ok('2d_names') and public._bk_snap_kind_ok('2d')
    and not public._bk_snap_kind_ok('3d_evil') and not public._bk_snap_kind_ok('4d') and not public._bk_snap_kind_ok(null));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('02 variant upload name allowed', public.booklet_snapshot_upload_ok(a || '/' || qa || '/3d_none.jpg')
    and public.booklet_snapshot_upload_ok(a || '/' || qa || '/2d_names.png') and public.booklet_snapshot_upload_ok(a || '/' || qa || '/3d.jpg'));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('03 bad variant names refused', not public.booklet_snapshot_upload_ok(a || '/' || qa || '/3d_labels.jpg')
    and not public.booklet_snapshot_upload_ok(a || '/' || qa || '/3d_none.svg') and not public.booklet_snapshot_upload_ok(a || '/' || qa || '/x_3d_none.png'));
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('04 storage name guard learns variants', public.storage_object_name_ok('booklet-snapshots', a || '/' || qa || '/3d_names.webp')
    and not public.storage_object_name_ok('booklet-snapshots', a || '/' || qa || '/3d_names.gif'));
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (''booklet-snapshots'', %L)', a || '/' || qa || '/3d_none.jpg'));
  perform pg_temp.res('05 editor variant upload passes RLS', e = '', e);
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('06 other studio refused for variants', not public.booklet_snapshot_upload_ok(a || '/' || qa || '/3d_none.jpg')
    and not public.booklet_snapshot_upload_ok(b || '/' || qa || '/3d_none.jpg'));
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (''booklet-snapshots'', %L)', a || '/' || qa || '/2d_names.png'));
  perform pg_temp.res('07 cross-org variant upload refused by RLS', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_set_snapshot(%L, ''3d_none'', %L)', qa, a || '/' || qa || '/3d_none.jpg'));
  perform pg_temp.res('08 other studio cannot set variant', e <> '', e);

  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_set_snapshot(%L, ''3d_evil'', %L)', qa, a || '/' || qa || '/3d_evil.jpg'));
  perform pg_temp.res('09 unknown kind refused', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_set_snapshot(%L, ''3d_none'', %L)', qa, a || '/' || qa || '/3d.jpg'));
  perform pg_temp.res('10 path must match the kind', e like '22023%', e);
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_set_snapshot(qa::uuid, '3d', a || '/' || qa || '/3d.jpg');
  r := public.booklet_set_snapshot(qa::uuid, '3d_none', a || '/' || qa || '/3d_none.jpg');
  r := public.booklet_set_snapshot(qa::uuid, '3d_names', a || '/' || qa || '/3d_names.jpg');
  r := public.booklet_set_snapshot(qa::uuid, '2d_names', a || '/' || qa || '/2d_names.png');
  perform pg_temp.res('11 variant set ok', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('12 2d/3d columns untouched by variants', (select snap_3d_path = a || '/' || qa || '/3d.jpg' and snap_2d_path is null
    and snap_variants ? '3d_none' from public.client_booklets where token = tok::uuid));

  perform pg_temp.anon();
  r := public.public_get_booklet(tok::uuid) -> 'snapshots';
  perform pg_temp.res('13 booklet flags variants, no paths', (r ->> '3d')::boolean and (r ->> '3d_none')::boolean and (r ->> '3d_names')::boolean
    and (r ->> '2d_names')::boolean and not (r ->> '2d_none')::boolean and not (r ->> '2d')::boolean and r::text not like '%.jpg%', r::text);
  perform pg_temp.su();
  perform pg_temp.res('14 snapshot path for variants', public.booklet_snapshot_path(tok::uuid, '3d_none') = a || '/' || qa || '/3d_none.jpg'
    and public.booklet_snapshot_path(tok::uuid, '2d_none') is null and public.booklet_snapshot_path(tok::uuid, '3d_evil') is null
    and public.booklet_snapshot_path(tok::uuid, '3d') = a || '/' || qa || '/3d.jpg');
  perform pg_temp.res('15 path fn still service-role only', not has_function_privilege('anon', 'public.booklet_snapshot_path(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.booklet_snapshot_path(uuid,text)', 'execute'));

  -- unset one variant
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_set_snapshot(qa::uuid, '3d_names', null);
  perform pg_temp.anon();
  r := public.public_get_booklet(tok::uuid) -> 'snapshots';
  perform pg_temp.res('16 removed variant no longer flagged', not (r ->> '3d_names')::boolean and (r ->> '3d_none')::boolean, r::text);

  -- new link (hide 3D): variants carried, 3D variants hidden
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid, 30, null, null, null, '{"layout3d":false}'::jsonb); tok2 := r ->> 'token';
  perform pg_temp.su();
  perform pg_temp.res('17 variants carried to the new link', (select snap_variants ? '3d_none' and snap_variants ? '2d_names' from public.client_booklets where token = tok2::uuid));
  perform pg_temp.anon();
  r := public.public_get_booklet(tok2::uuid) -> 'snapshots';
  perform pg_temp.res('18 hidden 3D section hides its variants', not (r ->> '3d_none')::boolean and (r ->> '2d_names')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('19 hidden section -> no variant path', public.booklet_snapshot_path(tok2::uuid, '3d_none') is null
    and public.booklet_snapshot_path(tok2::uuid, '2d_names') = a || '/' || qa || '/2d_names.png');
  perform pg_temp.res('20 wrapper definer-safe; inner not anon-callable', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.public_get_booklet__pre0083(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.public_get_booklet__pre0083(uuid)', 'execute')
    and (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p where p.oid in
      ('public.public_get_booklet(uuid)'::regprocedure, 'public.booklet_set_snapshot(uuid,text,text)'::regprocedure,
       'public.booklet_snapshot_path(uuid,text)'::regprocedure, 'public.booklet_snapshot_upload_ok(text)'::regprocedure)));
end $$;

select name, result from _bt order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'LABEL-VARIANTS: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'LABEL-VARIANTS: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bt;
rollback;
