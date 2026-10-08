-- upload-quarantine.sql — 0051: server-side scan state + restrictive read gate.
--   pending: readable by others while the flag is OFF (dormant); hidden from others (not the
--   uploader) once ON. clean: readable. rejected: hidden from everyone, flag on or off.
--   Org A / Org B isolation of the status RPC; scanner RPCs are service_role only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _us; create temp table _us(name text, result text); grant all on _us to anon, authenticated;

-- an over-broad permissive read for our test objects only, so the RESTRICTIVE gate is what decides
do $$ begin execute 'reset role';
  drop policy if exists us51_test_read on storage.objects;
  create policy us51_test_read on storage.objects for select to anon, authenticated using (storage.filename(name) like 'us51-%');
  delete from storage.objects where storage.filename(name) like 'us51-%';
  update public.upload_scan_config set enforce = false;
end $$;
create or replace function pg_temp.seen(p_file text) returns int language sql as $$
  select count(*)::int from storage.objects where storage.filename(name) = p_file;
$$;
grant execute on function pg_temp.seen(text) to anon, authenticated;

-- A's admin uploads three docs (as storage-api would: owner = uploader)
do $$ declare pa text := 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/';
               ua uuid := (select id from auth.users where email = 'a_admin@a.test'); n int; begin
  execute 'reset role';
  insert into storage.objects(bucket_id, name, owner) values
    ('event-docs', pa || 'us51-pend.pdf', ua), ('event-docs', pa || 'us51-clean.pdf', ua), ('event-docs', pa || 'us51-bad.pdf', ua),
    ('helm-manual', 'us51-manual.png', null);
  select count(*) into n from public.upload_scans where name like '%us51-%' and status = 'pending' and owner_id = ua
     and org_id = 'a0000000-0000-4000-8000-000000000001';
  insert into _us values ('INSERT trigger records pending (owner + studio derived)', case when n = 3 then 'PASS' else 'FAIL: ' || n end);
  select count(*) into n from public.upload_scans where name = 'us51-manual.png';
  insert into _us values ('unscanned bucket (helm-manual) not tracked', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
end $$;

-- dormant (flag OFF): pending still readable by another member → app unaffected before deploy
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  n := pg_temp.seen('us51-pend.pdf');
  insert into _us values ('flag OFF: pending readable by other member (dormant, nothing breaks)', case when n = 1 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- scanner decisions
do $$ declare r text; r2 text; begin execute 'reset role';
  select public.upload_scan_mark(object_id, 'clean', 'ok', 10) into r from public.upload_scans where name like '%us51-clean.pdf';
  select public.upload_scan_mark(object_id, 'rejected', 'magic mismatch', 10) into r2 from public.upload_scans where name like '%us51-bad.pdf';
  insert into _us values ('mark clean / rejected', case when r = 'clean' and r2 = 'rejected' then 'PASS' else 'FAIL: ' || r || '/' || r2 end);
  select public.upload_scan_mark(object_id, 'clean', 'flip', null) into r from public.upload_scans where name like '%us51-bad.pdf';
  insert into _us values ('mark is idempotent: rejected never flips to clean', case when r = 'rejected' then 'PASS' else 'FAIL: ' || r end);
  insert into _us values ('rejection writes an audit row',
    case when exists (select 1 from public.audit_log where action = 'upload.rejected' and changed->>'name' like '%us51-bad.pdf'
                        and org_id = 'a0000000-0000-4000-8000-000000000001') then 'PASS' else 'FAIL' end);
end $$;

do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  n := pg_temp.seen('us51-bad.pdf');
  insert into _us values ('flag OFF: rejected hidden from other member', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
  n := pg_temp.seen('us51-bad.pdf');
  insert into _us values ('rejected hidden from the uploader too', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
  perform auth.login_anon(); n := pg_temp.seen('us51-bad.pdf');
  insert into _us values ('rejected hidden from anon', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- enforce ON
do $$ begin execute 'reset role'; update public.upload_scan_config set enforce = true; end $$;
do $$ declare n int; c int; begin
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  n := pg_temp.seen('us51-pend.pdf'); c := pg_temp.seen('us51-clean.pdf');
  insert into _us values ('flag ON: pending NOT readable by another member', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  insert into _us values ('flag ON: clean readable by another member', case when c = 1 then 'PASS' else 'FAIL: ' || c end);
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
  n := pg_temp.seen('us51-pend.pdf');
  insert into _us values ('flag ON: uploader still sees own pending upload', case when n = 1 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email = 'b_admin@b.test'));
  n := pg_temp.seen('us51-pend.pdf');
  insert into _us values ('flag ON: Org B cannot read Org A pending', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
  perform auth.login_anon(); n := pg_temp.seen('us51-pend.pdf');
  insert into _us values ('flag ON: anon cannot read pending', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- missing scan row (trigger bypassed) fails closed while enforcing
do $$ declare n int; begin execute 'reset role';
  delete from public.upload_scans where name like '%us51-clean.pdf';
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  n := pg_temp.seen('us51-clean.pdf');
  insert into _us values ('flag ON: object with no scan row is hidden (fail closed)', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- rewrite in place → back to pending
do $$ declare s text; begin execute 'reset role';
  update public.upload_scans set status = 'clean' where name like '%us51-pend.pdf';
  update storage.objects set metadata = '{"size": 5}'::jsonb, updated_at = now() where storage.filename(name) = 'us51-pend.pdf';
  select status into s from public.upload_scans where name like '%us51-pend.pdf';
  insert into _us values ('overwrite (upsert) puts a clean object back to pending', case when s = 'pending' then 'PASS' else 'FAIL: ' || s end);
end $$;

-- status RPC: own studio only
do $$ declare n int; pa text := 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/'; begin
  perform auth.login_as((select id from auth.users where email = 'a_staff@a.test'));
  select count(*) into n from public.upload_scan_status('event-docs', array[pa || 'us51-pend.pdf', pa || 'us51-bad.pdf']);
  insert into _us values ('status RPC: Org A member sees Org A scan states', case when n = 2 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email = 'b_admin@b.test'));
  select count(*) into n from public.upload_scan_status('event-docs', array[pa || 'us51-pend.pdf', pa || 'us51-bad.pdf']);
  insert into _us values ('status RPC: Org B sees nothing of Org A', case when n = 0 then 'PASS' else 'FAIL: ' || n end);
  perform auth.logout();
end $$;

-- privileges: no direct table access, scanner RPCs not callable by clients
do $$ declare ok boolean := true; begin
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
  begin perform 1 from public.upload_scans limit 1; ok := false; exception when others then null; end;
  begin perform public.upload_scan_claim(5); ok := false; exception when others then null; end;
  begin perform public.upload_scan_mark(gen_random_uuid(), 'clean', 'x'); ok := false; exception when others then null; end;
  begin update public.upload_scan_config set enforce = false; ok := false; exception when others then null; end;
  perform auth.logout();
  perform auth.login_anon();
  begin perform public.upload_scan_claim(5); ok := false; exception when others then null; end;
  begin perform 1 from public.upload_scan_status('event-docs', array['x']); ok := false; exception when others then null; end;
  perform auth.logout();
  insert into _us values ('clients cannot read scans table, claim, mark or flip the flag', case when ok then 'PASS' else 'FAIL' end);
end $$;

-- claim: batch of pending, attempts counted, skip recently claimed
do $$ declare n int; m int; begin execute 'reset role';
  update public.upload_scans set claimed_at = null where status = 'pending';
  select count(*) into n from public.upload_scan_claim(100) c where c.name like '%us51-%';
  select count(*) into m from public.upload_scan_claim(100) c where c.name like '%us51-%';
  insert into _us values ('claim returns pending once, then skips while claimed', case when n = 1 and m = 0 then 'PASS' else 'FAIL: ' || n || '/' || m end);
  insert into _us values ('quarantine bucket exists and is private',
    case when exists (select 1 from storage.buckets where id = 'upload-quarantine' and public = false) then 'PASS' else 'FAIL' end);
end $$;

do $$ begin execute 'reset role'; drop policy if exists us51_test_read on storage.objects;
  update public.upload_scan_config set enforce = false;
  delete from storage.objects where storage.filename(name) like 'us51-%'; end $$;
select name, result from _us order by name;
select case when count(*) filter (where result not like 'PASS%') = 0 then 'UPLOAD-QUARANTINE: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'UPLOAD-QUARANTINE: ' || count(*) filter (where result not like 'PASS%') || ' FAILED' end from _us;
