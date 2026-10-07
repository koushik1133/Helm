-- storage-policy.sql — SEC-05 F6 invite-media storage isolation. Requires 0013 + fixtures.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _sp; create temp table _sp(name text, result text); grant all on _sp to anon, authenticated;
-- own-org upload allowed
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  -- 0027: key must be <org>/<own event>/<random uuid>.<ext> (a_staff = sales, quotes edit)
  insert into storage.objects(bucket_id,name,owner) values('invite-media','a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/5d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png',auth.uid());
  insert into _sp values('own-org invite-media upload','PASS: allowed');
exception when others then insert into _sp values('own-org invite-media upload','FAIL: '||left(sqlerrm,30)); end $$;
-- cross-org upload denied (foldername = other org)
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  insert into storage.objects(bucket_id,name,owner) values('invite-media','b0000000-0000-4000-8000-000000000001/q1/x.png',auth.uid());
  insert into _sp values('cross-org invite-media upload','FAIL: allowed (should deny)');
exception when others then insert into _sp values('cross-org invite-media upload','PASS: denied'); end $$;
-- anon cannot read invite-media (no public policy)
do $$ declare n int; begin
  perform auth.login_anon();
  select count(*) into n from storage.objects where bucket_id='invite-media';
  insert into _sp values('anon invite-media listing', case when n=0 then 'PASS: anon sees 0 (no public read)' else 'FAIL: anon sees '||n end);
  perform auth.logout();
end $$;
-- bucket is private with a MIME allowlist + size cap
do $$ declare r record; begin
  select public, file_size_limit, allowed_mime_types into r from storage.buckets where id='invite-media';
  insert into _sp values('invite-media bucket config',
    case when r.public=false and r.file_size_limit>0 and array_length(r.allowed_mime_types,1)>=1
         then 'PASS: private, '||r.file_size_limit||'B cap, '||array_length(r.allowed_mime_types,1)||' mime types'
         else 'FAIL: public='||r.public end);
end $$;
-- ---- P2-01 (0019): guests read ONLY photos on a PUBLISHED site of the same org+quote ----
-- setup as superuser with A-admin claims (event_sites guard stamps org from the JWT)
do $$ declare base text := 'https://x.supabase.co/storage/v1/object/public/invite-media/'; begin
  execute 'reset role';   -- disposable test DB: make the setup re-runnable
  delete from public.event_sites where slug like 'p201-%';
  delete from storage.objects where bucket_id='invite-media' and storage.filename(name) in ('on-site.png','draft-only.png');
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  insert into storage.objects(bucket_id,name) values
    ('invite-media','a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/on-site.png'),
    ('invite-media','a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/draft-only.png');
  insert into public.event_sites(quote_id,slug,status,data) values
    ('a0000000-0000-4000-8000-00000000da01','p201-a','draft',
     jsonb_build_object('photos', jsonb_build_array(base||'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/on-site.png')));
  -- org B publishes a site that pastes A's NOT-published photo URL (claim attack)
  perform auth.login_as((select id from auth.users where email='b_admin@b.test')); execute 'reset role';
  insert into public.event_sites(quote_id,slug,status,data) values
    ('b0000000-0000-4000-8000-00000000da01','p201-b','published',
     jsonb_build_object('photos', jsonb_build_array(base||'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/draft-only.png')));
  perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_anon();
  select count(*) into n from storage.objects where bucket_id='invite-media';
  insert into _sp values('P2-01 anon: draft site photo unreadable', case when n=0 then 'PASS: 0 visible' else 'FAIL: anon sees '||n end);
  perform auth.logout();
end $$;
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.event_sites set status='published' where slug='p201-a';
  perform auth.logout();
end $$;
do $$ declare n int; names text; begin
  perform auth.login_anon();
  select count(*), string_agg(storage.filename(name),',') into n, names from storage.objects where bucket_id='invite-media';
  insert into _sp values('P2-01 anon: published site photo readable', case when n=1 and names='on-site.png' then 'PASS: exactly the on-site photo' else 'FAIL: n='||n||' '||coalesce(names,'') end);
  perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email='b_staff@b.test'));
  select count(*) into n from storage.objects where bucket_id='invite-media' and storage.filename(name)='draft-only.png';
  insert into _sp values('P2-01 cross-org claim attack blocked', case when n=0 then 'PASS: pasted URL grants nothing' else 'FAIL: B reads A draft photo' end);
  perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.event_sites set status='unpublished' where slug='p201-a';
  perform auth.logout(); perform auth.login_anon();
  select count(*) into n from storage.objects where bucket_id='invite-media';
  insert into _sp values('P2-01 anon: unpublish revokes read', case when n=0 then 'PASS: 0 visible after unpublish' else 'FAIL: anon still sees '||n end);
  perform auth.logout();
end $$;
do $$ begin
  begin perform auth.login_anon(); insert into storage.objects(bucket_id,name) values('invite-media','x/y/z.png');
    insert into _sp values('P2-01 anon cannot upload','FAIL: allowed');
  exception when others then insert into _sp values('P2-01 anon cannot upload','PASS: denied'); end;
  perform auth.logout();
end $$;
-- ---- 0031: helm-manual bucket — private; signed-in studio staff read; nobody writes via the API ----
do $$ begin
  execute 'reset role';
  delete from storage.objects where bucket_id='helm-manual' and name in ('USER-MANUAL.html','screenshots/index.webp','evil.html');
  insert into storage.objects(bucket_id,name) values ('helm-manual','USER-MANUAL.html'),('helm-manual','screenshots/index.webp');
end $$;
do $$ declare r record; begin
  select public into r from storage.buckets where id='helm-manual';
  insert into _sp values('0031 helm-manual bucket private', case when r.public = false then 'PASS: private' else 'FAIL: public='||coalesce(r.public::text,'missing') end);
end $$;
do $$ declare n int; begin
  perform auth.login_anon();
  select count(*) into n from storage.objects where bucket_id='helm-manual';
  insert into _sp values('0031 anon cannot read the manual', case when n=0 then 'PASS: anon sees 0' else 'FAIL: anon sees '||n end);
  perform auth.logout();
end $$;
do $$ declare na int; nb int; begin
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  select count(*) into na from storage.objects where bucket_id='helm-manual';
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email='b_staff@b.test'));
  select count(*) into nb from storage.objects where bucket_id='helm-manual';
  perform auth.logout();
  insert into _sp values('0031 signed-in staff (both studios) read the manual', case when na=2 and nb=2 then 'PASS: 2 + 2' else 'FAIL: a='||na||' b='||nb end);
end $$;
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin insert into storage.objects(bucket_id,name) values('helm-manual','evil.html');
        insert into _sp values('0031 staff/admin cannot upload to helm-manual','FAIL: allowed');
  exception when others then insert into _sp values('0031 staff/admin cannot upload to helm-manual','PASS: denied'); end;
  perform auth.logout();
end $$;
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  update storage.objects set name='hijack.html' where bucket_id='helm-manual' and name='USER-MANUAL.html';
  get diagnostics n = row_count;
  delete from storage.objects where bucket_id='helm-manual';
  perform auth.logout();
  execute 'reset role';
  select count(*) into n from storage.objects where bucket_id='helm-manual' and name in ('USER-MANUAL.html','screenshots/index.webp');
  insert into _sp values('0031 staff/admin cannot modify or delete manual files', case when n=2 then 'PASS: untouched' else 'FAIL: '||n||' left' end);
end $$;
select name,result from _sp order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'STORAGE-POLICY: ALL PASS' else 'STORAGE-POLICY: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _sp;
