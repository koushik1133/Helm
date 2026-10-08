-- welcome-email.sql — 0057: creating a studio queues ONE owner welcome; joining a studio
-- (accept_invitation) queues ONE member welcome; re-runs / re-joins never duplicate; rows
-- carry the right studio (org isolation); clients can't read the outbox or call the RPCs;
-- claim/mark (service role) send-once + retry semantics; a trigger failure never blocks.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _we; create temp table _we(name text, result text); grant all on _we to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default null) returns void language plpgsql as $$
declare r text := current_user;
begin execute 'reset role';
  insert into _we values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.n(p_user uuid, p_kind text default null) returns int language sql as $$
  select count(*)::int from public.welcome_email_outbox where user_id = p_user and (p_kind is null or kind = p_kind) $$;

do $$ begin perform pg_temp.su(); delete from public.welcome_email_outbox; end $$;

-- ---- 1) create_studio → one owner welcome -------------------------------------------------
do $$ declare u uuid; v_org uuid; r record;
begin perform pg_temp.su();
  select id into u from auth.users where email = 'we_owner@new.test';
  if u is null then u := auth.seed_user('we_owner@new.test'); end if;
  delete from public.profiles where id = u;
  perform auth.login_as(u);
  v_org := public.create_studio('Welcome Studio', null);
  perform pg_temp.su();
  perform pg_temp.t('create_studio succeeded', v_org is not null);
  perform pg_temp.t('one owner welcome queued', pg_temp.n(u, 'studio_owner') = 1, pg_temp.n(u, 'studio_owner')::text);
  perform pg_temp.t('owner not also queued as member', pg_temp.n(u, 'member') = 0);
  select * into r from public.welcome_email_outbox where user_id = u;
  perform pg_temp.t('owner row: org, email, channel, pending', r.org_id = v_org and r.email = 'we_owner@new.test'
    and r.channel = 'email' and r.status = 'pending' and r.sent_at is null and r.attempts = 0, row_to_json(r)::text);
  -- calling create_studio again (returns the existing studio) never duplicates
  perform auth.login_as(u); perform public.create_studio('Welcome Studio', null); perform pg_temp.su();
  perform pg_temp.t('create_studio re-call: still one', pg_temp.n(u) = 1, pg_temp.n(u)::text);
  -- profile org_id touched again (same value / null → back) never duplicates
  update public.profiles set org_id = null where id = u;
  update public.profiles set org_id = v_org where id = u;
  perform pg_temp.t('re-join own studio: still one', pg_temp.n(u) = 1, pg_temp.n(u)::text);
end $$;

-- ---- 2) accept_invitation → one member welcome (into the right studio) ---------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; m uuid; tok text; r record; v jsonb;
begin perform pg_temp.su();
  select id into m from auth.users where email = 'we_member@new.test';
  if m is null then m := auth.seed_user('we_member@new.test'); end if;
  delete from public.profiles where id = m;
  delete from public.invitations where lower(email) = 'we_member@new.test';
  insert into public.invitations(org_id, email, role, status) values (A, 'we_member@new.test', 'sales', 'pending') returning token into tok;
  perform auth.login_as(m);
  v := public.accept_invitation(tok);
  perform pg_temp.su();
  perform pg_temp.t('accept_invitation ok', (v ->> 'ok')::boolean, v::text);
  perform pg_temp.t('one member welcome queued', pg_temp.n(m, 'member') = 1, pg_temp.n(m, 'member')::text);
  perform pg_temp.t('member not queued as owner', pg_temp.n(m, 'studio_owner') = 0);
  select * into r from public.welcome_email_outbox where user_id = m;
  perform pg_temp.t('member row bound to Studio A only', r.org_id = A, r.org_id::text);
  perform auth.login_as(m); v := public.accept_invitation(tok); perform pg_temp.su();
  perform pg_temp.t('re-accept: still one', pg_temp.n(m) = 1, pg_temp.n(m)::text);
  perform pg_temp.t('no welcome rows for Studio B', not exists (select 1 from public.welcome_email_outbox
    where org_id = 'b0000000-0000-4000-8000-000000000001'::uuid and user_id in (m, (select id from auth.users where email = 'we_owner@new.test'))));
  -- unrelated profile updates (role / name) never enqueue
  update public.profiles set role = 'planner', full_name = 'Mia Member' where id = m;
  perform pg_temp.t('role/name change: still one', pg_temp.n(m) = 1);
end $$;

-- ---- 3) clients can't read/write the outbox or call the RPCs -------------------------------
do $$ declare aadm uuid; begin perform pg_temp.su();
  select id into aadm from auth.users where email = 'a_admin@a.test';
  perform auth.login_as(aadm);
  perform pg_temp.t('admin cannot select outbox', pg_temp.try('select count(*) from public.welcome_email_outbox') = '42501', pg_temp.try('select count(*) from public.welcome_email_outbox'));
  perform pg_temp.t('admin cannot insert outbox', pg_temp.try($q$insert into public.welcome_email_outbox(user_id,kind,email) values (gen_random_uuid(),'member','x@y.co')$q$) = '42501');
  perform pg_temp.t('admin cannot claim', pg_temp.try('select public.welcome_email_outbox_claim(10)') = '42501');
  perform pg_temp.t('admin cannot mark', pg_temp.try($q$select public.welcome_email_outbox_mark(gen_random_uuid(),'sent')$q$) = '42501');
  perform pg_temp.t('admin cannot call enqueue', pg_temp.try($q$select public._we57_enqueue(gen_random_uuid(),gen_random_uuid(),'member')$q$) = '42501');
  perform pg_temp.su(); perform auth.login_anon();
  perform pg_temp.t('anon cannot select outbox', pg_temp.try('select count(*) from public.welcome_email_outbox') = '42501');
  perform pg_temp.t('anon cannot claim', pg_temp.try('select public.welcome_email_outbox_claim(10)') = '42501');
  perform pg_temp.su();
end $$;

-- ---- 4) service role: claim → mark sent (once), retry, attempts cap -----------------------
do $$ declare c jsonb; o uuid; m uuid; id1 uuid; id2 uuid; st text;
begin perform pg_temp.su();
  select id into o from auth.users where email = 'we_owner@new.test';
  select id into m from auth.users where email = 'we_member@new.test';
  select id into id1 from public.welcome_email_outbox where user_id = o;
  select id into id2 from public.welcome_email_outbox where user_id = m;
  set local role service_role;
  c := public.welcome_email_outbox_claim(100);
  perform pg_temp.t('claim returns both queued rows', (select count(*) from jsonb_array_elements(c) e where (e ->> 'id')::uuid in (id1, id2)) = 2, c::text);
  perform pg_temp.t('claim carries studio name + kind', exists (select 1 from jsonb_array_elements(c) e
    where (e ->> 'id')::uuid = id2 and e ->> 'studio' = 'Studio A' and e ->> 'kind' = 'member' and e ->> 'to' = 'we_member@new.test' and e ->> 'name' = 'Mia Member'));
  perform pg_temp.t('claimed rows not re-claimed immediately', jsonb_array_length(public.welcome_email_outbox_claim(100)) = 0);
  perform public.welcome_email_outbox_mark(id1, 'sent');
  perform public.welcome_email_outbox_mark(id2, 'retry');
  c := public.welcome_email_outbox_claim(100);
  perform pg_temp.t('retry row is claimable again, sent row is not', jsonb_array_length(c) = 1 and (c -> 0 ->> 'id')::uuid = id2, c::text);
  perform pg_temp.t('mark bad status rejected', pg_temp.try($q$select public.welcome_email_outbox_mark(gen_random_uuid(),'bogus')$q$) = '22023');
  reset role;
  select status into st from public.welcome_email_outbox where id = id1;
  perform pg_temp.t('owner row marked sent', st = 'sent', st);
  update public.welcome_email_outbox set sent_at = now() - interval '1 day' where id = id1;
  set local role service_role;
  perform public.welcome_email_outbox_mark(id1, 'failed');   -- already sent: no change
  reset role;
  perform pg_temp.t('mark never re-opens a sent row', (select status from public.welcome_email_outbox where id = id1) = 'sent');
  update public.welcome_email_outbox set attempts = 5, claimed_at = null where id = id2;
  set local role service_role; perform public.welcome_email_outbox_claim(100); reset role;
  perform pg_temp.t('5 failed attempts -> failed, stops retrying', (select status from public.welcome_email_outbox where id = id2) = 'failed');
end $$;

-- ---- 5) exception-safe: a broken enqueue never blocks joining a studio -----------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; x uuid; ok text;
begin perform pg_temp.su();
  select id into x from auth.users where email = 'we_safe@new.test';
  if x is null then x := auth.seed_user('we_safe@new.test'); end if;
  delete from public.profiles where id = x;
  alter table public.welcome_email_outbox rename to welcome_email_outbox_x;   -- simulate a broken outbox
  ok := pg_temp.try(format($q$insert into public.profiles(id, email, role, org_id) values (%L, 'we_safe@new.test', 'sales', %L)$q$, x, A));
  alter table public.welcome_email_outbox_x rename to welcome_email_outbox;
  perform pg_temp.t('outbox failure never blocks the join', ok = 'ok', ok);
  perform pg_temp.t('…and the person is in the studio', exists (select 1 from public.profiles where id = x and org_id = A));
  perform pg_temp.t('…and nothing half-queued', pg_temp.n(x) = 0);
end $$;

select name, result from _we where result <> 'PASS';
select case when (select count(*) from _we where result <> 'PASS') = 0
  then 'WELCOME-EMAIL: ALL PASS (' || (select count(*) from _we) || '/' || (select count(*) from _we) || ')'
  else 'WELCOME-EMAIL: FAILURES ' || (select count(*) from _we where result <> 'PASS') end as summary;
