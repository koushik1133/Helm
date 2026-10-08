-- upload-hardening.sql — 0048: NV-04 slug-bound guest read (no anon listing) + restrictive
-- upload rules (key shape, extension allowlist, own-studio path) + bucket limits.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _uh; create temp table _uh(name text, result text); grant all on _uh to anon, authenticated;
create or replace function pg_temp.hdr(p_slug text, p_op text) returns void language sql as $$
  select set_config('request.headers', case when p_slug is null then '' else jsonb_build_object('x-helm-site-slug', p_slug)::text end, false),
         set_config('storage.operation', coalesce(p_op, ''), false);
$$;
grant execute on function pg_temp.hdr(text, text) to anon, authenticated;

-- setup (superuser): A publishes a site with one photo; a second A photo is NOT listed; B publishes
-- a site that pastes A's unlisted photo URL (claim attack)
do $$ declare base text := 'https://x.supabase.co/storage/v1/object/public/invite-media/';
               pa text := 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/'; begin
  execute 'reset role';
  -- disposable test DB: one site per event, so clear whatever an earlier suite left on these two events
  delete from public.event_sites where slug like 'uh48-%' or quote_id in ('a0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-00000000da01');
  delete from storage.objects where bucket_id = 'invite-media' and storage.filename(name) in ('uh-on.png', 'uh-off.png');
  insert into storage.objects(bucket_id, name) values ('invite-media', pa || 'uh-on.png'), ('invite-media', pa || 'uh-off.png');
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test')); execute 'reset role';
  insert into public.event_sites(quote_id, slug, status, data) values
    ('a0000000-0000-4000-8000-00000000da01', 'uh48-a', 'published', jsonb_build_object('photos', jsonb_build_array(base || pa || 'uh-on.png')));
  perform auth.login_as((select id from auth.users where email = 'b_admin@b.test')); execute 'reset role';
  insert into public.event_sites(quote_id, slug, status, data) values
    ('b0000000-0000-4000-8000-00000000da01', 'uh48-b', 'published', jsonb_build_object('photos', jsonb_build_array(base || pa || 'uh-off.png')));
  perform auth.logout(); execute 'reset role';
end $$;

-- ---- NV-04 reads ------------------------------------------------------------------------
do $$ declare n int; begin
  perform auth.login_anon(); perform pg_temp.hdr(null, null);
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 anon without a slug lists nothing (cross-studio enumeration closed)', case when n = 0 then 'PASS' else 'FAIL: anon sees ' || n end);
  perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_anon(); perform pg_temp.hdr('uh48-a', 'storage.object.list');
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 anon list operation refused even with a valid slug', case when n = 0 then 'PASS' else 'FAIL: list returned ' || n end);
  perform pg_temp.hdr('uh48-a', 'storage.object.search');
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 anon search operation refused even with a valid slug', case when n = 0 then 'PASS' else 'FAIL: search returned ' || n end);
  perform pg_temp.hdr(null, null); perform auth.logout();
end $$;
do $$ declare n int; names text; begin
  perform auth.login_anon(); perform pg_temp.hdr('uh48-a', 'storage.object.sign');
  select count(*), string_agg(storage.filename(name), ',') into n, names from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 anon with the slug reads exactly that site''s published photo',
    case when n = 1 and names = 'uh-on.png' then 'PASS' else 'FAIL: n=' || n || ' ' || coalesce(names, '') end);
  perform pg_temp.hdr('uh48-a', null);
  select count(*) into n from storage.objects where bucket_id = 'invite-media' and storage.filename(name) = 'uh-on.png';
  insert into _uh values ('NV-04 direct read works when storage-api sets no operation', case when n = 1 then 'PASS' else 'FAIL: ' || n end);
  perform pg_temp.hdr(null, null); perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_anon(); perform pg_temp.hdr('uh48-b', 'storage.object.sign');
  select count(*) into n from storage.objects where bucket_id = 'invite-media' and name like 'a0000000-0000-4000-8000-000000000001/%';
  insert into _uh values ('NV-04 Org B slug cannot read Org A objects (pasted URL claim)', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform set_config('request.headers', '{not json', false);
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 malformed header grants nothing', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform pg_temp.hdr('nope-does-not-exist', null);
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 unknown slug grants nothing', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform pg_temp.hdr(null, null); perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test')); execute 'reset role';
  update public.event_sites set status = 'unpublished' where slug = 'uh48-a';
  perform auth.logout(); execute 'reset role';
  perform auth.login_anon(); perform pg_temp.hdr('uh48-a', 'storage.object.sign');
  select count(*) into n from storage.objects where bucket_id = 'invite-media';
  insert into _uh values ('NV-04 unpublished site: its slug reads nothing', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform pg_temp.hdr(null, null); perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  select count(*) into n from storage.objects where bucket_id = 'invite-media' and storage.filename(name) in ('uh-on.png', 'uh-off.png');
  insert into _uh values ('staff still read their own studio''s invite media', case when n = 2 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- ---- restrictive upload rules -----------------------------------------------------------
-- a deliberately over-broad permissive policy (simulates a dashboard mistake): the
-- restrictive guard must still refuse every bad key
do $$ begin execute 'reset role';
  drop policy if exists uh48_test_allow_all on storage.objects;
  create policy uh48_test_allow_all on storage.objects for insert to anon, authenticated with check (true);
end $$;
create or replace function pg_temp.try_put(p_bucket text, p_name text) returns boolean language plpgsql as $$
begin insert into storage.objects(bucket_id, name, owner) values (p_bucket, p_name, auth.uid()); return true;
exception when others then return false; end $$;
grant execute on function pg_temp.try_put(text, text) to anon, authenticated;
do $$ declare
  oa text := 'a0000000-0000-4000-8000-000000000001'; qa text := 'a0000000-0000-4000-8000-00000000da01';
  ob text := 'b0000000-0000-4000-8000-000000000001'; qb text := 'b0000000-0000-4000-8000-00000000da01';
  r text := '9c0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11'; me text; bad text := ''; begin
  perform auth.login_as((select id from auth.users where email = 'b_admin@b.test'));
  if pg_temp.try_put('invite-media', oa || '/' || qa || '/' || r || '.png') then bad := bad || 'invite-media '; end if;
  if pg_temp.try_put('event-docs',   oa || '/' || qa || '/' || r || '.pdf') then bad := bad || 'event-docs '; end if;
  if pg_temp.try_put('chat-media',   oa || '/' || qa || '/' || r || '.jpg') then bad := bad || 'chat-media '; end if;
  me := auth.uid()::text;
  if pg_temp.try_put('member-avatars', oa || '/' || me || '/' || r || '.jpg') then bad := bad || 'member-avatars '; end if;
  insert into _uh values ('Org B cannot write under Org A''s path (any bucket, even with an allow-all policy)', case when bad = '' then 'PASS' else 'FAIL: ' || bad end);
  bad := '';
  if not pg_temp.try_put('chat-media', ob || '/' || qb || '/' || r || '.jpg') then bad := bad || 'own chat '; end if;
  if not pg_temp.try_put('event-docs', ob || '/' || qb || '/' || r || '.pdf') then bad := bad || 'own docs '; end if;
  insert into _uh values ('own-studio, server-shaped keys still upload', case when bad = '' then 'PASS' else 'FAIL: refused ' || bad end);
  bad := '';
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/' || r || '.svg') then bad := bad || 'svg '; end if;
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/' || r || '.html') then bad := bad || 'html '; end if;
  if pg_temp.try_put('event-docs',   ob || '/' || qb || '/' || r || '.exe') then bad := bad || 'exe '; end if;
  if pg_temp.try_put('event-docs',   ob || '/' || qb || '/' || r || '.pdf.js') then bad := bad || 'pdf.js '; end if;
  if pg_temp.try_put('chat-media',   ob || '/' || qb || '/' || r || '.php') then bad := bad || 'php '; end if;
  if pg_temp.try_put('member-avatars', ob || '/' || me || '/' || r || '.gif') then bad := bad || 'avatar-gif '; end if;
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/my holiday photo.jpg') then bad := bad || 'client-name '; end if;
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/../' || r || '.jpg') then bad := bad || 'dotdot '; end if;
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/x/' || r || '.jpg') then bad := bad || 'extra-folder '; end if;
  if pg_temp.try_put('invite-media', ob || '/' || qb || '/' || upper(r) || '.JPG') then bad := bad || 'upper '; end if;
  if pg_temp.try_put('helm-manual', 'evil.html') then bad := bad || 'helm-manual '; end if;
  if pg_temp.try_put('some-new-bucket', ob || '/' || qb || '/' || r || '.jpg') then bad := bad || 'unknown-bucket '; end if;
  insert into _uh values ('bad extension / client file name / odd path / unknown bucket refused', case when bad = '' then 'PASS' else 'FAIL: stored ' || bad end);
  perform auth.logout();
end $$;
do $$ declare bad text := ''; u text := 'c0e3f7e8-8d0c-4f43-9f6a-0d1f6c6a8a11'; begin
  perform auth.login_anon();
  if pg_temp.try_put('task-proof', u || '/' || u || '/' || u || '/' || u || '.html') then bad := bad || 'task-proof-html '; end if;
  if pg_temp.try_put('task-proof', u || '/' || u || '/x.jpg') then bad := bad || 'task-proof-short '; end if;
  if pg_temp.try_put('invite-media', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || u || '.jpg') then bad := bad || 'anon-invite '; end if;
  insert into _uh values ('anon: only task-proof-shaped keys pass the guard', case when bad = '' then 'PASS' else 'FAIL: stored ' || bad end);
  perform auth.logout();
end $$;
do $$ begin execute 'reset role'; drop policy if exists uh48_test_allow_all on storage.objects; end $$;
do $$ declare n int; begin execute 'reset role';
  -- update (rename) is guarded too
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
  update storage.objects set name = replace(name, '.png', '.html') where bucket_id = 'invite-media' and storage.filename(name) = 'uh-on.png';
  get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  insert into _uh values ('rename to a bad extension refused', case when n = 0 then 'PASS' else 'FAIL: renamed ' || n end);
exception when others then execute 'reset role'; insert into _uh values ('rename to a bad extension refused', 'PASS: ' || left(sqlerrm, 40)); end $$;

-- ---- policy + bucket shape ---------------------------------------------------------------
do $$ declare ok boolean; begin
  select count(*) = 2 into ok from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('upload_guard_insert', 'upload_guard_update') and permissive = 'RESTRICTIVE';
  insert into _uh values ('guard policies are RESTRICTIVE (insert + update)', case when ok then 'PASS' else 'FAIL' end);
  select not exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'invite_media_public_read')
     and (select qual from pg_policies where schemaname = 'storage' and policyname = 'invite_media_published_read') like '%invite_media_guest_read_ok%' into ok;
  insert into _uh values ('guest read policy is the slug-bound one', case when ok then 'PASS' else 'FAIL' end);
  select count(*) = 5 into ok from storage.buckets where public = false and file_size_limit > 0 and array_length(allowed_mime_types, 1) >= 1
     and id in ('invite-media', 'event-docs', 'chat-media', 'task-proof', 'member-avatars');
  insert into _uh values ('5 app buckets private with MIME allowlist + size cap', case when ok then 'PASS' else 'FAIL' end);
  select (file_size_limit = 2097152 and not ('image/gif' = any(allowed_mime_types))) into ok from storage.buckets where id = 'member-avatars';
  insert into _uh values ('member-avatars: 2 MB, no gif', case when ok then 'PASS' else 'FAIL' end);
  select not exists (select 1 from storage.buckets where id = 'event-docs' and ('image/svg+xml' = any(allowed_mime_types) or 'text/html' = any(allowed_mime_types))) into ok;
  insert into _uh values ('no svg/html MIME on any doc bucket', case when ok then 'PASS' else 'FAIL' end);
end $$;

do $$ begin execute 'reset role'; drop policy if exists uh48_test_allow_all on storage.objects;
  delete from public.event_sites where slug like 'uh48-%';
  delete from storage.objects where bucket_id = 'invite-media' and storage.filename(name) in ('uh-on.png', 'uh-off.png'); end $$;
select name, result from _uh order by name;
select case when count(*) filter (where result not like 'PASS%') = 0 then 'UPLOAD-HARDENING: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'UPLOAD-HARDENING: ' || count(*) filter (where result not like 'PASS%') || ' FAILED' end from _uh;
