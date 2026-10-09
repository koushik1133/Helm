-- chat-admin-fixes.sql - behavioral proof for migration 0074: invitation escalation refused,
-- revoke still works, last admin protected (every path), chat_prefs isolation, chat read
-- tracking, chat media scoped to its conversation. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ca; create temp table _ca(name text, result text);
grant all on _ca to anon, authenticated;
drop table if exists _cat; create temp table _cat as
  select substr(md5(random()::text), 1, 10) as tag, null::boolean as rv, null::boolean as re, false as had, null::uuid as dm_id;
grant all on _cat to anon, authenticated;
do $$ declare o uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  update _cat set had = exists (select 1 from public.role_access where role='manager' and area='users' and org_id=o),
    rv = (select can_view from public.role_access where role='manager' and area='users' and org_id=o),
    re = (select can_edit from public.role_access where role='manager' and area='users' and org_id=o);
end $$;

-- ---- invitations ------------------------------------------------------------------------
do $$ declare a_admin uuid; a_staff uuid; o uuid; t text; v_role text; v_email text; v_status text; n int; begin
  execute 'reset role';
  select tag into t from _cat;
  select id, org_id into a_admin, o from public.profiles where email='a_admin@a.test';
  select id into a_staff from public.profiles where email='a_staff@a.test';
  update public.profiles set role='manager' where id=a_staff;
  insert into public.role_access(role,area,can_view,can_edit,org_id) values('manager','users',true,true,o)
    on conflict do nothing;
  update public.role_access set can_view=true, can_edit=true where role='manager' and area='users' and org_id=o;
  perform auth.login_as(a_admin);
  perform public.create_invitation('ca_'||t||'@a.test','crew');
  perform public.create_invitation('cb_'||t||'@a.test','crew');
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_staff);
  insert into _ca values('00 manager has users edit', case when public.has_area('users','edit') then 'PASS' else 'FAIL' end);
  begin update public.invitations set role='admin' where email='ca_'||t||'@a.test';
    insert into _ca values('01 manager cannot raise invite role to admin','FAIL: allowed');
  exception when others then insert into _ca values('01 manager cannot raise invite role to admin', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin update public.invitations set email='evil_'||t||'@a.test' where email='ca_'||t||'@a.test';
    insert into _ca values('02 manager cannot change invite email','FAIL: allowed');
  exception when others then insert into _ca values('02 manager cannot change invite email', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin update public.invitations set token='x' where email='ca_'||t||'@a.test';
    insert into _ca values('03 manager cannot change invite token','FAIL: allowed');
  exception when others then insert into _ca values('03 manager cannot change invite token', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  begin update public.invitations set status='revoked' where email='cb_'||t||'@a.test'; get diagnostics n = row_count;
    insert into _ca values('04 manager can revoke a pending invite', case when n=1 then 'PASS' else 'FAIL: n='||n end);
  exception when others then insert into _ca values('04 manager can revoke a pending invite','FAIL: '||sqlerrm); end;
  begin update public.invitations set status='pending' where email='cb_'||t||'@a.test'; get diagnostics n = row_count;
    insert into _ca values('05 revoked invite cannot be re-opened', case when n=0 then 'PASS' else 'FAIL: n='||n end);
  exception when others then insert into _ca values('05 revoked invite cannot be re-opened', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout(); execute 'reset role';
  select role, email, status into v_role, v_email, v_status from public.invitations where email='ca_'||t||'@a.test';
  insert into _ca values('06 invite row unchanged', case when v_role='crew' and v_status='pending' then 'PASS' else 'FAIL: '||coalesce(v_role,'?')||' '||coalesce(v_status,'?') end);
  update public.profiles set role='sales' where id=a_staff;
exception when others then insert into _ca values('0x invitations setup','FAIL: '||sqlerrm); end $$;

-- accept_invitation gives exactly the invited role
do $$ declare a_admin uuid; u uuid; t text; tok text; v_role text; begin
  execute 'reset role';
  select tag into t from _cat;
  select id into a_admin from public.profiles where email='a_admin@a.test';
  perform auth.login_as(a_admin); perform public.create_invitation('cc_'||t||'@a.test','crew'); perform auth.logout(); execute 'reset role';
  select token into tok from public.invitations where email='cc_'||t||'@a.test';
  u := auth.seed_user('cc_'||t||'@a.test');
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = u;
  perform auth.login_as(u); perform public.accept_invitation(tok); perform auth.logout(); execute 'reset role';
  select role into v_role from public.profiles where id=u;
  insert into _ca values('07 accepted invite gets the invited role only', case when v_role='crew' then 'PASS' else 'FAIL: '||coalesce(v_role,'null') end);
exception when others then insert into _ca values('07 accepted invite gets the invited role only','FAIL: '||sqlerrm); end $$;

-- ---- last admin ---------------------------------------------------------------------------
do $$ declare a_admin uuid; a_staff uuid; o uuid; t text; v_role text; begin
  execute 'reset role';
  select tag into t from _cat;
  select id, org_id into a_admin, o from public.profiles where email='a_admin@a.test';
  select id into a_staff from public.profiles where email='a_staff@a.test';
  begin update public.profiles set role='sales' where id=a_admin;
    insert into _ca values('08 last admin cannot be demoted (direct, any caller)','FAIL: allowed');
  exception when others then insert into _ca values('08 last admin cannot be demoted (direct, any caller)', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  -- a stale pending invite to the admin's own address, at a lower role
  insert into public.invitations(org_id, email, role, token) values (o, 'a_admin@a.test', 'sales', 'ca-tok-'||t);
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = a_admin;
  perform auth.login_as(a_admin);
  begin perform public.accept_invitation('ca-tok-'||t);
    insert into _ca values('09 last admin cannot be demoted via accept_invitation','FAIL: allowed');
  exception when others then insert into _ca values('09 last admin cannot be demoted via accept_invitation', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate||' '||sqlerrm end); end;
  -- with a second admin, demoting the first via admin_set_role works; demoting the last does not
  perform public.admin_set_role(a_staff, 'admin');
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_staff);
  begin perform public.admin_set_role(a_admin, 'sales'); insert into _ca values('10 demote one of two admins works','PASS');
  exception when others then insert into _ca values('10 demote one of two admins works','FAIL: '||sqlerrm); end;
  perform auth.logout(); execute 'reset role';
  begin update public.profiles set role='sales' where id=a_staff;
    insert into _ca values('11 remaining admin is protected again','FAIL: allowed');
  exception when others then insert into _ca values('11 remaining admin is protected again', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  update public.profiles set role='admin' where id=a_admin;
  update public.profiles set role='sales' where id=a_staff;
  select role into v_role from public.profiles where id=a_admin;
  insert into _ca values('12 fixture roles restored', case when v_role='admin' then 'PASS' else 'FAIL' end);
exception when others then insert into _ca values('1x last admin setup','FAIL: '||sqlerrm); end $$;

-- ---- chat: prefs, read tracking, media scope ----------------------------------------------
do $$ declare a_admin uuid; a_staff uuid; b_admin uuid; dm uuid; g uuid; n int; r public.chat_messages; o text; lr timestamptz; begin
  execute 'reset role';
  select id into a_admin from public.profiles where email='a_admin@a.test';
  select id into a_staff from public.profiles where email='a_staff@a.test';
  select id into b_admin from public.profiles where email='b_admin@b.test';
  perform auth.login_as(a_staff);
  dm := public.chat_start_dm(a_admin);
  begin perform public.chat_set_pref(dm, true, true, null); perform public.chat_set_pref(dm, null, null, true);
    select count(*) into n from public.chat_prefs where conversation_id=dm and pinned and muted and favourite;
    insert into _ca values('13 chat_set_pref saves + merges own prefs', case when n=1 then 'PASS' else 'FAIL: n='||n end);
  exception when others then insert into _ca values('13 chat_set_pref saves + merges own prefs','FAIL: '||sqlerrm); end;
  begin insert into public.chat_prefs(user_id, conversation_id, muted) values (a_admin, dm, true);
    insert into _ca values('14 direct insert into chat_prefs refused','FAIL: allowed');
  exception when others then insert into _ca values('14 direct insert into chat_prefs refused', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_admin);
  select count(*) into n from public.chat_prefs;
  insert into _ca values('15 another user sees none of my prefs', case when n=0 then 'PASS' else 'FAIL: n='||n end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(b_admin);
  begin perform public.chat_set_pref(dm, true, null, null); insert into _ca values('16 other studio cannot set prefs on my chat','FAIL: allowed');
  exception when others then insert into _ca values('16 other studio cannot set prefs on my chat', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate end); end;
  perform auth.logout(); execute 'reset role';
  -- read tracking: after mark-read, a NEW message counts as unread again
  perform auth.login_as(a_staff); perform public.chat_mark_read(dm); perform auth.logout(); execute 'reset role';
  update _cat set dm_id = dm;
exception when others then insert into _ca values('2x chat setup','FAIL: '||sqlerrm); end $$;
-- separate transactions: now() differs between mark-read and the new message
do $$ declare a_admin uuid; dm uuid; r public.chat_messages; begin
  execute 'reset role';
  select id into a_admin from public.profiles where email='a_admin@a.test';
  select dm_id into dm from _cat;
  perform auth.login_as(a_admin); r := public.chat_send(dm,'text','after read',null,null,null,null); perform auth.logout(); execute 'reset role';
exception when others then insert into _ca values('2y chat send','FAIL: '||sqlerrm); end $$;
do $$ declare a_admin uuid; a_staff uuid; dm uuid; g uuid; n int; r public.chat_messages; o text; lr timestamptz; begin
  execute 'reset role';
  select id into a_admin from public.profiles where email='a_admin@a.test';
  select id into a_staff from public.profiles where email='a_staff@a.test';
  select dm_id into dm from _cat;
  perform auth.login_as(a_staff);
  select last_read_at into lr from public.chat_members where conversation_id=dm and user_id=a_staff;
  select count(*) into n from public.chat_messages m where m.conversation_id=dm and m.sender_id<>a_staff and m.created_at > coalesce(lr,'-infinity');
  insert into _ca values('17 message after last read counts as unread', case when n=1 then 'PASS' else 'FAIL: n='||n end);
  perform public.chat_mark_read(dm);
  select last_read_at into lr from public.chat_members where conversation_id=dm and user_id=a_staff;
  select count(*) into n from public.chat_messages m where m.conversation_id=dm and m.sender_id<>a_staff and m.created_at > coalesce(lr,'-infinity');
  insert into _ca values('18 mark read clears it', case when n=0 then 'PASS' else 'FAIL: n='||n end);
  -- media scope
  select org_id::text into o from public.profiles where id=a_staff;
  g := public.chat_create_group('ca group', array[a_admin]);
  begin r := public.chat_send(g,'image',null,o||'/'||dm||'/abc.jpg','image/jpeg',null,null);
    insert into _ca values('19 media from another conversation refused','FAIL: allowed');
  exception when others then insert into _ca values('19 media from another conversation refused', case when sqlstate='42501' then 'PASS' else 'FAIL: '||sqlstate||' '||sqlerrm end); end;
  begin r := public.chat_send(g,'image',null,o||'/'||g||'/abc.jpg','image/jpeg',null,null);
    insert into _ca values('20 media in its own conversation ok','PASS');
  exception when others then insert into _ca values('20 media in its own conversation ok','FAIL: '||sqlerrm); end;
  perform auth.logout(); execute 'reset role';
exception when others then insert into _ca values('2z chat checks','FAIL: '||sqlerrm); end $$;

-- restore the manager users row
do $$ declare o uuid := 'a0000000-0000-4000-8000-000000000001'; h boolean; v boolean; e boolean; begin
  execute 'reset role';
  select had, rv, re into h, v, e from _cat;
  if h then update public.role_access set can_view=v, can_edit=e where role='manager' and area='users' and org_id=o;
  else delete from public.role_access where role='manager' and area='users' and org_id=o; end if;
end $$;

select name, result from _ca order by name;
select case when count(*) filter (where result not like 'PASS%') = 0
  then 'CHAT-ADMIN-FIXES: ALL PASS ('||count(*)||'/'||count(*)||')'
  else 'CHAT-ADMIN-FIXES: '||count(*) filter (where result not like 'PASS%')||' FAILED' end from _ca;
