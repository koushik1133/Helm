-- studio-links.sql — 0020 branded client links (/<studio>/<kind>/<ref>). Requires 0020 + fixtures.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _sl; create temp table _sl(name text, result text); grant all on _sl to anon, authenticated;

-- reset (disposable DB): known names, no history, no test sites
do $$ begin
  perform auth.logout(); execute 'reset role';
  delete from public.org_slug_history;
  delete from public.event_sites where slug like 'sl-%' or quote_id = 'a0000000-0000-4000-8000-00000000da01';
  update public.role_access set can_edit = false where role = 'sales' and area = 'controls' and org_id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set public_slug = 'studio-a' where id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set public_slug = 'studio-b' where id = 'b0000000-0000-4000-8000-000000000001';
  delete from public.org_slug_history;
end $$;

do $$ declare n int; begin
  select count(*) into n from public.organizations where public_slug is null or not public.studio_slug_valid(public_slug);
  insert into _sl values('every studio has a valid link name (backfill/insert trigger)', case when n=0 then 'PASS' else 'FAIL: '||n||' bad' end);
  insert into _sl values('slugify "Aurora Events!" -> aurora-events', case when public.studio_slug_pick('Aurora Events!', gen_random_uuid())='aurora-events' then 'PASS' else 'FAIL: '||public.studio_slug_pick('Aurora Events!', gen_random_uuid()) end);
  insert into _sl values('slugify reserved "Dashboard" is not reserved output', case when public.studio_slug_valid(public.studio_slug_pick('Dashboard', gen_random_uuid())) then 'PASS' else 'FAIL' end);
end $$;

-- non-admin cannot rename (RPC + direct UPDATE)
do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  perform public.set_studio_link_name('staff-took-it');
  insert into _sl values('non-admin RPC rename denied','FAIL: allowed');
exception when others then insert into _sl values('non-admin RPC rename denied','PASS: '||left(sqlerrm,40)); end $$;
do $$ declare s text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  begin update public.organizations set public_slug='staff-direct', business_email='evil@x.test' where id='a0000000-0000-4000-8000-000000000001'; exception when others then null; end;
  perform auth.logout(); execute 'reset role';
  select public_slug into s from public.organizations where id='a0000000-0000-4000-8000-000000000001';
  insert into _sl values('non-admin direct UPDATE blocked (F8 + guard)', case when s='studio-a' and (select business_email is distinct from 'evil@x.test' from public.organizations where id='a0000000-0000-4000-8000-000000000001') then 'PASS' else 'FAIL: '||s end);
end $$;

-- admin renames; bad names rejected
do $$ declare r text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  r := public.set_studio_link_name('  Aurora-Events ');
  insert into _sl values('admin rename -> normalised', case when r='aurora-events' then 'PASS' else 'FAIL: '||r end);
exception when others then insert into _sl values('admin rename -> normalised','FAIL: '||sqlerrm); end $$;
do $$ declare bad text; ok int := 0; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  foreach bad in array array['dashboard','ab','bad name!','-lead','trail-','dou--ble','i','api', repeat('x',41)] loop
    begin perform public.set_studio_link_name(bad); exception when others then ok := ok + 1; end;
  end loop;
  insert into _sl values('reserved / malformed names rejected', case when ok=9 then 'PASS: 9/9' else 'FAIL: '||ok||'/9' end);
end $$;
do $$ declare n int; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role'; select count(*) into n from public.org_slug_history where slug='studio-a' and org_id='a0000000-0000-4000-8000-000000000001';
  insert into _sl values('old name kept in history', case when n=1 then 'PASS' else 'FAIL' end);
end $$;

-- another studio can't take A's current or retired name
do $$ declare fails int := 0; t text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='b_admin@b.test'));
  foreach t in array array['aurora-events','studio-a'] loop
    begin perform public.set_studio_link_name(t); exception when others then fails := fails + 1; end;
  end loop;
  insert into _sl values('B cannot take A''s current or retired name', case when fails=2 then 'PASS' else 'FAIL: '||fails||'/2 blocked' end);
end $$;

-- anon resolver (anti-phishing)
do $$ declare a text; b text; c text; d text; e text; f text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_anon();
  a := public.public_link_studio('quote','a0000000-0000-4000-8000-0000000000aa','aurora-events');
  b := public.public_link_studio('quote','a0000000-0000-4000-8000-0000000000aa','studio-a');
  c := public.public_link_studio('quote','a0000000-0000-4000-8000-0000000000aa','studio-b');
  d := public.public_link_studio('quote','b0000000-0000-4000-8000-0000000000bb','aurora-events');
  e := public.public_link_studio('quote','not-a-uuid','aurora-events');
  f := public.public_link_studio('evil','a0000000-0000-4000-8000-0000000000aa','aurora-events');
  insert into _sl values('anon: own link + current name -> ok', case when a='aurora-events' then 'PASS' else 'FAIL: '||coalesce(a,'null') end);
  insert into _sl values('anon: retired name still resolves to current', case when b='aurora-events' then 'PASS' else 'FAIL: '||coalesce(b,'null') end);
  insert into _sl values('anon: wrong studio for a real token -> null', case when c is null then 'PASS' else 'FAIL: '||c end);
  insert into _sl values('anon: phishing (B token under A name) -> null', case when d is null then 'PASS' else 'FAIL: '||d end);
  insert into _sl values('anon: malformed token / unknown kind -> null', case when e is null and f is null then 'PASS' else 'FAIL' end);
  perform auth.logout();
end $$;

-- invite: only PUBLISHED sites resolve
do $$ declare x text; y text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  insert into public.event_sites(quote_id,slug,status,data) values ('a0000000-0000-4000-8000-00000000da01','sl-a','draft','{}'::jsonb);
  perform auth.logout(); perform auth.login_anon();
  x := public.public_link_studio('invite','sl-a','aurora-events');
  perform auth.logout();
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.event_sites set status='published' where slug='sl-a';
  perform auth.logout(); perform auth.login_anon();
  y := public.public_link_studio('invite','sl-a','aurora-events');
  insert into _sl values('anon: draft invite -> null, published -> ok', case when x is null and y='aurora-events' then 'PASS' else 'FAIL: '||coalesce(x,'null')||'/'||coalesce(y,'null') end);
  perform auth.logout();
end $$;

-- anon can't rename
do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_anon(); perform public.set_studio_link_name('anon-name');
  insert into _sl values('anon cannot rename','FAIL: allowed');
exception when others then insert into _sl values('anon cannot rename','PASS: denied'); end $$;

do $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role';
  update public.role_access set can_edit = true where role = 'sales' and area = 'controls' and org_id = 'a0000000-0000-4000-8000-000000000001'; end $$;
select name,result from _sl order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'STUDIO-LINKS: ALL PASS' else 'STUDIO-LINKS: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _sl;
