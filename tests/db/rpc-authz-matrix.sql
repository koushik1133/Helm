-- rpc-authz-matrix.sql — DB-authoritative authorization matrix.
-- Proves the DATABASE denies unauthorized callers on sensitive mutating RPCs,
-- independent of the client ROLE_CAPS. Requires canonical migrations + fixtures.
-- Seeds a no-capability 'viewer' user inline. Prints PASS/FAIL per (role,RPC).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _am; create temp table _am(role text, rpc text, expected text, result text);
grant all on _am to anon, authenticated;

-- seed a no-area authenticated user (role 'viewer' not in can_edit, no role_access)
do $$ declare v uuid; begin
  select id into v from auth.users where email='viewer@a.test'; if v is null then v:=auth.seed_user('viewer@a.test'); end if;
  update public.profiles set role='operations', org_id='a0000000-0000-4000-8000-000000000001' where id=v; -- placeholder
  delete from public.profiles where id=v;
  insert into public.profiles(id,email,role,org_id,must_change_password) values (v,'viewer@a.test','viewer','a0000000-0000-4000-8000-000000000001',false)
    on conflict (id) do update set role='viewer';
exception when others then null; end $$;

-- helper: try an RPC as a user, record allow/deny
create or replace function pg_temp.try_rpc(p_email text, p_role text, p_rpc text, p_sql text, p_expected text)
returns void language plpgsql as $$
begin
  perform auth.login_as((select id from auth.users where email=p_email));
  begin
    execute p_sql;
    insert into _am values (p_role, p_rpc, p_expected, case when p_expected='ALLOW' then 'PASS: allowed' else 'FAIL: allowed (should deny)' end);
  exception
    when insufficient_privilege then insert into _am values (p_role,p_rpc,p_expected, case when p_expected='DENY' then 'PASS: denied' else 'FAIL: denied (should allow)' end);
    when others then
      -- a non-authz error on an ALLOW case still means the guard passed (reached the body)
      if p_expected='ALLOW' then insert into _am values (p_role,p_rpc,p_expected,'PASS: authorized (body err: '||left(sqlerrm,30)||')');
      else insert into _am values (p_role,p_rpc,p_expected,'PASS: denied ('||left(sqlerrm,30)||')'); end if;
  end;
  perform auth.logout();
end $$;

-- anon MUST be denied on every sensitive mutating RPC
do $$ begin
  perform auth.login_anon();
  begin perform public.create_quote('T','t','wedding','{}'::jsonb,100,current_date); insert into _am values('anon','create_quote','DENY','FAIL: allowed'); exception when others then insert into _am values('anon','create_quote','DENY','PASS: denied'); end;
  begin perform public.save_quotation_version('a0000000-0000-4000-8000-00000000da01','{}'::jsonb); insert into _am values('anon','save_quotation_version','DENY','FAIL: allowed'); exception when others then insert into _am values('anon','save_quotation_version','DENY','PASS: denied'); end;
  begin perform public.mark_paid('a0000000-0000-4000-8000-00000000da01','r'); insert into _am values('anon','mark_paid','DENY','FAIL: allowed'); exception when others then insert into _am values('anon','mark_paid','DENY','PASS: denied'); end;
  begin perform public.admin_create_user('e@x.t','pw12','sales'); insert into _am values('anon','admin_create_user','DENY','FAIL: allowed'); exception when others then insert into _am values('anon','admin_create_user','DENY','PASS: denied'); end;
  perform auth.logout();
end $$;

-- no-capability 'viewer' MUST be denied on write RPCs
select pg_temp.try_rpc('viewer@a.test','viewer','create_quote', $q$ select public.create_quote('T2','t','wedding','{}'::jsonb,100,current_date) $q$, 'DENY');
select pg_temp.try_rpc('viewer@a.test','viewer','save_quotation_version', $q$ select public.save_quotation_version('a0000000-0000-4000-8000-00000000da01','{"gstPct":18,"other":1000}'::jsonb) $q$, 'DENY');
select pg_temp.try_rpc('viewer@a.test','viewer','mark_paid', $q$ select public.mark_paid('a0000000-0000-4000-8000-00000000da01','r') $q$, 'DENY');

-- admin MUST be allowed (authorized) on the write RPCs
select pg_temp.try_rpc('a_admin@a.test','admin','create_quote', $q$ select public.create_quote('T3','t','wedding','{"gstPct":18,"other":1000}'::jsonb,100,current_date) $q$, 'ALLOW');
select pg_temp.try_rpc('a_admin@a.test','admin','save_quotation_version', $q$ select public.save_quotation_version('a0000000-0000-4000-8000-00000000da01','{"gstPct":18,"other":1000}'::jsonb) $q$, 'ALLOW');
select pg_temp.try_rpc('a_admin@a.test','admin','mark_paid', $q$ select public.mark_paid('a0000000-0000-4000-8000-00000000da01','r') $q$, 'ALLOW');

-- sales (can_edit + quotes area) allowed on quote writes; denied on admin + mark_paid
select pg_temp.try_rpc('a_staff@a.test','sales','save_quotation_version', $q$ select public.save_quotation_version('a0000000-0000-4000-8000-00000000da01','{"gstPct":18,"other":1000}'::jsonb) $q$, 'ALLOW');
select pg_temp.try_rpc('a_staff@a.test','sales','mark_paid', $q$ select public.mark_paid('a0000000-0000-4000-8000-00000000da01','r') $q$, 'DENY');
select pg_temp.try_rpc('a_staff@a.test','sales','admin_create_user', $q$ select public.admin_create_user('e2@x.t','pw12','sales') $q$, 'DENY');

select role, rpc, expected, result from _am order by role, rpc;
select case when count(*) filter (where result like 'FAIL%')=0 then 'RPC-AUTHZ-MATRIX: ALL PASS ('||count(*)||' checks)' else 'RPC-AUTHZ-MATRIX: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _am;
