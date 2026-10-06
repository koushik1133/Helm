-- ============================================================================
-- auth-matrix.sql — create_helm_user / admin_create_user authorization matrix.
-- Requires: canonical migrations applied (0002) + 10-fixtures.sql loaded.
-- Prints one row per case; 'PASS' = behaved as security requires.
-- ============================================================================
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _m;
create temp table _m(n int, name text, result text);
grant all on _m to anon, authenticated;   -- so success-path inserts work while role-switched
-- idempotent: remove users this test creates so re-runs don't hit 'already exists'
delete from public.profiles where email in ('newuser@a.test','onboard@a.test','xorg@a.test');
delete from auth.identities where user_id in (select id from auth.users where email in ('newuser@a.test','onboard@a.test','xorg@a.test'));
delete from auth.users where email in ('newuser@a.test','onboard@a.test','xorg@a.test');

-- 1) anon -> create_helm_user : DENIED
do $$ begin
  begin
    perform set_config('request.jwt.claims','{"role":"anon"}',true); set local role anon;
    perform public.create_helm_user('x1@evil.test','pw12','admin');
    insert into _m values (1,'anon -> create_helm_user','FAIL: allowed');
  exception when insufficient_privilege then insert into _m values (1,'anon -> create_helm_user','PASS: denied (permission)');
            when others then insert into _m values (1,'anon -> create_helm_user','PASS: denied ('||sqlerrm||')');
  end; reset role;
end $$;

-- 2) authenticated STAFF -> create_helm_user : DENIED
do $$ begin
  begin
    perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
    perform public.create_helm_user('x2@evil.test','pw12','admin');
    insert into _m values (2,'staff -> create_helm_user','FAIL: allowed');
  exception when insufficient_privilege then insert into _m values (2,'staff -> create_helm_user','PASS: denied (permission)');
            when others then insert into _m values (2,'staff -> create_helm_user','PASS: denied ('||sqlerrm||')');
  end; perform auth.logout();
end $$;

-- 3) authenticated STAFF -> admin_create_user : DENIED (not admin)
do $$ begin
  begin
    perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
    perform public.admin_create_user('x3@evil.test','pw12','sales');
    insert into _m values (3,'staff -> admin_create_user','FAIL: allowed');
  exception when insufficient_privilege then insert into _m values (3,'staff -> admin_create_user','PASS: denied (not authorized)');
            when others then insert into _m values (3,'staff -> admin_create_user','PASS: denied ('||sqlerrm||')');
  end; perform auth.logout();
end $$;

-- 4) same-org ADMIN -> admin_create_user : PASS + new user in ADMIN's org
do $$ declare uid uuid; neworg uuid; myorg uuid; begin
  begin
    perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
    myorg := public.current_org_id();
    uid := public.admin_create_user('newuser@a.test','Helm-test-pass-2026','sales');
    select org_id into neworg from public.profiles where id=uid;
    if neworg = myorg then insert into _m values (4,'same-org admin -> admin_create_user','PASS: created in own org');
    else insert into _m values (4,'same-org admin -> admin_create_user','FAIL: landed in org '||neworg); end if;
  exception when others then insert into _m values (4,'same-org admin -> admin_create_user','FAIL: '||sqlerrm);
  end; perform auth.logout();
end $$;

-- 5) same-org ADMIN -> admin_create_user_temp : PASS + onboarding preserved
do $$ declare r jsonb; mcp boolean; begin
  begin
    perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
    r := public.admin_create_user_temp('onboard@a.test','sales');
    select must_change_password into mcp from public.profiles where id=(r->>'user_id')::uuid;
    if (r ? 'temp_password') and mcp then insert into _m values (5,'admin -> admin_create_user_temp (onboarding)','PASS: temp pw + must_change_password');
    else insert into _m values (5,'admin -> admin_create_user_temp (onboarding)','FAIL: r='||r::text||' mcp='||coalesce(mcp::text,'null')); end if;
  exception when others then insert into _m values (5,'admin -> admin_create_user_temp (onboarding)','FAIL: '||sqlerrm);
  end; perform auth.logout();
end $$;

-- 6) CROSS-ORG: org-A admin cannot place a user into org B (org-scoped to caller)
do $$ declare uid uuid; neworg uuid; orgB uuid; begin
  begin
    select org_id into orgB from public.profiles where email='b_admin@b.test';
    perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
    uid := public.admin_create_user('xorg@a.test','Helm-test-pass-2026','sales');
    select org_id into neworg from public.profiles where id=uid;
    if neworg <> orgB then insert into _m values (6,'cross-org: A-admin cannot create into org B','PASS: confined to caller org (not B)');
    else insert into _m values (6,'cross-org: A-admin cannot create into org B','FAIL: created in org B'); end if;
  exception when others then insert into _m values (6,'cross-org: A-admin cannot create into org B','FAIL: '||sqlerrm);
  end; perform auth.logout();
end $$;

select n, name, result from _m order by n;
select case when count(*) filter (where result like 'FAIL%')=0 then 'AUTH-MATRIX: ALL PASS' else 'AUTH-MATRIX: '||count(*) filter (where result like 'FAIL%')||' FAILED' end as summary from _m;
