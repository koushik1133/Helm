-- storage-policy.sql — SEC-05 F6 invite-media storage isolation. Requires 0013 + fixtures.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _sp; create temp table _sp(name text, result text); grant all on _sp to anon, authenticated;
-- own-org upload allowed
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  insert into storage.objects(bucket_id,name,owner) values('invite-media','a0000000-0000-4000-8000-000000000001/q1/x.png',auth.uid());
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
select name,result from _sp order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'STORAGE-POLICY: ALL PASS' else 'STORAGE-POLICY: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _sp;
