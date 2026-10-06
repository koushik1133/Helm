-- privilege-escalation.sql — P5-01 (0021): no signed-in member can change their own
-- role / studio, and a crew member can update NOTHING in any table. Requires 0021 + fixtures.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _pe; create temp table _pe(name text, result text); grant all on _pe to anon, authenticated;

-- a lowest-privilege crew member in studio A
do $$ declare c uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into c from auth.users where email='a_crew@a.test';
  if c is null then c := auth.seed_user('a_crew@a.test'); end if;
  insert into public.profiles(id,email,role,org_id) values (c,'a_crew@a.test','crew','a0000000-0000-4000-8000-000000000001')
    on conflict (id) do update set role='crew', org_id='a0000000-0000-4000-8000-000000000001', must_change_password=false;
end $$;

do $$ declare r text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_crew@a.test'));
  begin update public.profiles set role='admin' where id=auth.uid(); exception when others then null; end;
  execute 'reset role'; select role into r from public.profiles where email='a_crew@a.test';
  insert into _pe values('crew cannot make themselves admin', case when r='crew' then 'PASS' else 'FAIL: role='||r end);
end $$;

do $$ declare o text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_crew@a.test'));
  begin update public.profiles set org_id='b0000000-0000-4000-8000-000000000001' where id=auth.uid(); exception when others then null; end;
  execute 'reset role'; select org_id::text into o from public.profiles where email='a_crew@a.test';
  insert into _pe values('crew cannot hop into another studio', case when o like 'a0000000%' then 'PASS' else 'FAIL: org='||o end);
end $$;

do $$ declare m boolean; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  update public.profiles set must_change_password=true where email='a_crew@a.test';
  perform auth.login_as((select id from auth.users where email='a_crew@a.test'));
  begin update public.profiles set must_change_password=false where id=auth.uid(); exception when others then null; end;
  execute 'reset role'; select must_change_password into m from public.profiles where email='a_crew@a.test';
  insert into _pe values('crew cannot skip the forced password change directly', case when m then 'PASS' else 'FAIL' end);
  update public.profiles set must_change_password=false where email='a_crew@a.test';
end $$;

do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_crew@a.test'));
  insert into public.profiles(id,email,role,org_id) values (gen_random_uuid(),'x@x.test','admin','a0000000-0000-4000-8000-000000000001');
  insert into _pe values('crew cannot insert profiles','FAIL: allowed');
exception when others then execute 'reset role'; insert into _pe values('crew cannot insert profiles','PASS'); end $$;

-- legitimate admin path still works (definer RPC)
do $$ declare r text; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  perform public.admin_set_role((select id from public.profiles where email='a_crew@a.test'), 'planner');
  execute 'reset role'; select role into r from public.profiles where email='a_crew@a.test';
  insert into _pe values('admin_set_role RPC still works', case when r='planner' then 'PASS' else 'FAIL: '||r end);
  update public.profiles set role='crew' where email='a_crew@a.test';
exception when others then execute 'reset role'; insert into _pe values('admin_set_role RPC still works','FAIL: '||left(sqlerrm,60)); end $$;

-- sweep: crew updates 0 rows in EVERY public table
do $$ declare t record; col text; n int; bad text := ''; total int := 0; begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
            where ns.nspname='public' and c.relkind='r' order by 1 loop
    select a.attname into col from pg_attribute a where a.attrelid=('public.'||t.relname)::regclass and a.attnum>0
      and not a.attisdropped and a.attname <> 'id' order by a.attnum limit 1;
    total := total + 1;
    begin
      execute 'reset role'; perform auth.logout(); execute 'reset role';
      perform auth.login_as((select id from auth.users where email='a_crew@a.test'));
      execute format('with u as (update public.%I set %I = %I returning 1) select count(*) from u', t.relname, col, col) into n;
      execute 'reset role';
      if n > 0 then bad := bad || t.relname || '(' || n || ') '; end if;
    exception when others then execute 'reset role'; end;
  end loop;
  insert into _pe values('crew can update 0 rows in all '||total||' tables', case when bad='' then 'PASS' else 'FAIL: '||bad end);
end $$;

do $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
select name,result from _pe order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'PRIVILEGE-ESCALATION: ALL PASS' else 'PRIVILEGE-ESCALATION: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _pe;
