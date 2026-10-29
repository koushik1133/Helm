-- system-quiet-0164.sql - 0164: direct-DB (system) changes stay quiet; audit log keeps every row,
-- tags system rows, redacts link secrets, and stays studio-private. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
set helm.maintenance = '';   -- run-all pins it 'off'; clear it to test real detection
select set_config('request.jwt.claims', '', false);
drop table if exists _s164; create temp table _s164(name text, result text); grant all on _s164 to anon, authenticated;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _s164 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.claims(p_email text) returns void language plpgsql as $$
begin
  if p_email is null then perform set_config('request.jwt.claims', '', false);
  else perform set_config('request.jwt.claims', (select jsonb_build_object('sub', id::text, 'role', 'authenticated', 'email', email)::text from auth.users where email = p_email), false); end if;
end $$;

-- detection
select pg_temp.t('01 no user, no claims = system', public._is_system_change(), null);
select set_config('helm.maintenance', 'off', false);
select pg_temp.t('02 flag off overrides', not public._is_system_change(), null);
select set_config('helm.maintenance', 'on', false); select pg_temp.claims('a_admin@a.test');
select pg_temp.t('03 flag on overrides a user', public._is_system_change(), null);
select set_config('helm.maintenance', '', false);
select pg_temp.t('04 signed-in user is not system', not public._is_system_change(), null);
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select pg_temp.t('05 anon client link is not system', not public._is_system_change(), null);
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select pg_temp.t('06 service_role edge fn is not system', not public._is_system_change(), null);
select pg_temp.claims(null);
set application_name = 'pg_cron';
select pg_temp.t('07 pg_cron job is not system', not public._is_system_change(), null);
reset application_name;

-- bell
do $$ declare c0 int; c1 int; begin
  select count(*) into c0 from public.notifications;
  insert into public.notifications(channel, kind, status, detail, org_id) values ('in_app', 'price_change', 'simulated', '{}', 'a0000000-0000-4000-8000-000000000001');
  select count(*) into c1 from public.notifications;
  perform pg_temp.t('08 system change makes no bell row', c1 = c0, c1::text);
  perform pg_temp.claims('a_admin@a.test');
  insert into public.notifications(channel, kind, status, detail, org_id) values ('in_app', 'price_change', 'simulated', '{}', 'a0000000-0000-4000-8000-000000000001');
  select count(*) into c1 from public.notifications;
  perform pg_temp.t('09 user change still makes a bell row', c1 = c0 + 1, c1::text);
  perform pg_temp.claims(null);
end $$;

-- outboxes
select pg_temp.t('10 all 6 outboxes guarded', (select count(*) from pg_trigger where tgname = 'zzz_sq164_system_skip') = 6,
  (select count(*)::text from pg_trigger where tgname = 'zzz_sq164_system_skip'));
do $$ declare s text; u uuid := gen_random_uuid(); begin
  insert into public.welcome_email_outbox(org_id, user_id, kind, email) values ('a0000000-0000-4000-8000-000000000001', u, 'member', 'x@a.test') returning status into s;
  perform pg_temp.t('11 system outbox row kept as skipped', s = 'skipped', s);
  perform pg_temp.claims('a_admin@a.test');
  insert into public.welcome_email_outbox(org_id, user_id, kind, email) values ('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'member', 'y@a.test') returning status into s;
  perform pg_temp.t('12 user outbox row still pending', s = 'pending', s);
  perform pg_temp.claims(null);
end $$;

-- audit
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; c0 int; c1 int; r record; begin
  select count(*) into c0 from public.audit_log where quote_id = q;
  update public.quotes set title = title || ' (sys)', approval_token = gen_random_uuid() where id = q;
  select count(*) into c1 from public.audit_log where quote_id = q;
  perform pg_temp.t('13 system change still audited', c1 > c0, c1::text);
  select * into r from public.audit_log where quote_id = q and entity = 'quotes' and changed ? 'approval_token' and changed -> 'title' ->> 1 like '%(sys)' limit 1;
  perform pg_temp.t('14 system row tagged helm:maintenance', r.actor is null and r.actor_email = 'helm:maintenance', r.actor_email);
  perform pg_temp.t('15 token diff redacted', r.changed -> 'approval_token' = '["[redacted]","[redacted]"]'::jsonb, r.changed ->> 'approval_token');
  perform pg_temp.claims('a_admin@a.test');
  update public.quotes set title = title || ' (u)' where id = q;
  perform pg_temp.claims(null);
  select * into r from public.audit_log where quote_id = q and entity = 'quotes' and changed -> 'title' ->> 1 like '%(u)' limit 1;
  perform pg_temp.t('16 user row keeps the real actor', r.actor is not null and r.actor_email = 'a_admin@a.test', r.actor_email);
  perform pg_temp.t('17 no raw token in audit', not exists (select 1 from public.audit_log a, public.quotes x
     where x.id = q and a.changed::text like '%' || x.approval_token::text || '%'), null);
end $$;

-- privacy: org B admin and anon cannot read org A audit rows
do $$ declare n int; begin
  perform auth.login_as((select id from auth.users where email = 'b_admin@b.test'));
  select count(*) into n from public.audit_log where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform auth.logout();
  perform auth.login_anon();
  -- r60 (0301): anon holds no table privilege on audit_log any more - a refusal counts as "nothing read"
  begin select n + count(*) into n from public.audit_log; exception when insufficient_privilege then null; end;
  perform auth.logout();
  perform pg_temp.t('18 no cross-studio / anon audit read', n = 0, n::text);
end $$;

select name, result from _s164 where result <> 'PASS' order by name;
select case when count(*) filter (where result = 'PASS') = 18 and count(*) = 18
  then 'SYSTEM-QUIET-0164: ALL PASS (18/18)' else 'SYSTEM-QUIET-0164: FAIL (' || count(*) filter (where result = 'PASS') || '/' || count(*) || ')' end from _s164;
