-- chat-rls.sql — behavioral RLS proof for the team chat (migration 0016).
-- Verifies: same-org DM members can send/read; cross-org members are blocked
-- (read AND the chat_send RPC); the broadcast channel is per-org; anon sees nothing.
-- Fixture: org A has a_admin+a_staff, org B has b_admin+b_staff.
-- NOTE: user ids are resolved BEFORE auth.login_as() (the authenticated role can't
-- read auth.users), mirroring the storage-policy suite.
\set ON_ERROR_STOP 0
create temp table _cr(name text, result text);
grant all on _cr to anon, authenticated;

-- A: a_staff opens a DM to a_admin (same org) and sends a message.
do $$ declare v uuid; a_staff uuid; a_admin uuid; begin
  execute 'reset role';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into a_admin from auth.users where email='a_admin@a.test';
  perform auth.login_as(a_staff);
  v := public.chat_start_dm(a_admin);
  perform public.chat_send(v,'text','secret for org A',null,null,null,null);
  insert into _cr values('A member can start DM + send','PASS');
exception when others then insert into _cr values('A member can start DM + send','FAIL: '||SQLERRM); end $$;

-- A: the other DM member (a_admin) can read it.
do $$ declare n int; a_admin uuid; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  perform auth.login_as(a_admin);
  select count(*) into n from public.chat_messages where body='secret for org A';
  insert into _cr values('A co-member reads the DM', case when n>=1 then 'PASS' else 'FAIL: n='||n end);
exception when others then insert into _cr values('A co-member reads the DM','FAIL: '||SQLERRM); end $$;

-- Cross-org: b_staff must NOT see org A's message.
do $$ declare n int; b_staff uuid; begin
  execute 'reset role';
  select id into b_staff from auth.users where email='b_staff@b.test';
  perform auth.login_as(b_staff);
  select count(*) into n from public.chat_messages where body='secret for org A';
  insert into _cr values('B cannot read A''s message', case when n=0 then 'PASS' else 'FAIL: sees '||n end);
exception when others then insert into _cr values('B cannot read A''s message','FAIL: '||SQLERRM); end $$;

-- Cross-org: b_staff cannot send into org A's conversation (RPC must raise 42501).
do $$ declare v uuid; b_staff uuid; begin
  execute 'reset role';
  select id into b_staff from auth.users where email='b_staff@b.test';
  select id into v from public.chat_conversations where kind='dm' order by created_at desc limit 1;  -- as session role
  perform auth.login_as(b_staff);
  perform public.chat_send(v,'text','intrusion',null,null,null,null);
  insert into _cr values('B cannot send into A''s DM','FAIL: send succeeded');
exception when others then insert into _cr values('B cannot send into A''s DM','PASS: blocked'); end $$;

-- Broadcast is per-org: b_staff ensures its own and sees exactly one (not A's).
do $$ declare va uuid; vb uuid; n int; a_staff uuid; b_staff uuid; begin
  execute 'reset role';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_staff from auth.users where email='b_staff@b.test';
  perform auth.login_as(a_staff);
  va := public.chat_ensure_broadcast();
  execute 'reset role';                               -- login_as reads auth.users; do it as the session role
  perform auth.login_as(b_staff);
  vb := public.chat_ensure_broadcast();
  select count(*) into n from public.chat_conversations where kind='broadcast';
  insert into _cr values('broadcast is per-org (B sees 1)', case when n=1 then 'PASS' else 'FAIL: sees '||n end);
exception when others then insert into _cr values('broadcast is per-org (B sees 1)','FAIL: '||SQLERRM); end $$;

-- anon sees no chat messages.
do $$ declare n int; begin
  perform auth.login_anon();
  select count(*) into n from public.chat_messages;
  insert into _cr values('anon sees no messages', case when n=0 then 'PASS' else 'FAIL: sees '||n end);
exception when others then insert into _cr values('anon sees no messages','PASS: blocked'); end $$;

select name, result from _cr order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'CHAT-RLS: ALL PASS' else 'CHAT-RLS: FAIL' end as verdict from _cr;
