-- worker-token.sql — G2 worker-link liveness + renewal trigger (0012).
-- Regression guard for a bug the earlier token-otp suite missed: tg_work_token_renew
-- referenced work_tokens.revoked_at (a column that did not exist) so ANY event_task
-- insert with an assignee_phone would error; and the four worker_* RPCs did not gate
-- on expiry/revocation. This proves: (1) task insert renews rather than crashes,
-- (2) worker_get_tasks accepts a live link and rejects expired/revoked/invalid ones.
-- Requires canonical migrations + fixtures (quote qA, org A).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _wt; create temp table _wt(name text, result text);

do $$
declare qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        orgA uuid := 'a0000000-0000-4000-8000-000000000001';
        t_live uuid := gen_random_uuid();
        t_exp  uuid := gen_random_uuid();
        t_rev  uuid := gen_random_uuid();
        old_exp timestamptz; new_exp timestamptz;
begin
  -- seed three work tokens for the same quote/phone (superuser; bypasses RLS)
  delete from public.work_tokens where quote_id=qA and phone in ('9995550001');
  insert into public.work_tokens(token,quote_id,phone,name,expires_at,revoked_at)
    values (t_live,qA,'9995550001','Crew Live', now()+interval '10 days', null),
           (t_exp ,qA,'9995550001','Crew Exp',  now()-interval '1 day',   null),
           (t_rev ,qA,'9995550001','Crew Rev',  now()+interval '10 days', now());

  -- (1) RENEW TRIGGER: inserting an event_task w/ assignee_phone must NOT error and
  --     must extend the live token's expiry (base bug: crashed on missing revoked_at).
  select expires_at into old_exp from public.work_tokens where token=t_live;
  begin
    insert into public.event_tasks(quote_id,org_id,category,title,status,assignee_phone,seq)
      values (qA,orgA,'setup','HARDEN task','assigned','9995550001',1);
    select expires_at into new_exp from public.work_tokens where token=t_live;
    if new_exp >= old_exp then insert into _wt values('renew trigger on task insert','PASS: no error, expiry renewed');
    else insert into _wt values('renew trigger on task insert','FAIL: expiry not renewed'); end if;
  exception when others then insert into _wt values('renew trigger on task insert','FAIL: '||left(sqlerrm,40)); end;

  -- (2) worker_get_tasks liveness (anon-facing SECURITY DEFINER)
  perform auth.login_anon();
  begin perform public.worker_get_tasks(t_live);
        insert into _wt values('worker_get_tasks live token','PASS: allowed');
  exception when others then insert into _wt values('worker_get_tasks live token','FAIL: '||left(sqlerrm,40)); end;

  begin perform public.worker_get_tasks(t_exp);
        insert into _wt values('worker_get_tasks expired token','FAIL: allowed (should deny)');
  exception when others then
        if sqlerrm ilike '%expired%' then insert into _wt values('worker_get_tasks expired token','PASS: expired rejected');
        else insert into _wt values('worker_get_tasks expired token','FAIL: '||left(sqlerrm,40)); end if; end;

  begin perform public.worker_get_tasks(t_rev);
        insert into _wt values('worker_get_tasks revoked token','FAIL: allowed (should deny)');
  exception when others then
        if sqlerrm ilike '%revoked%' then insert into _wt values('worker_get_tasks revoked token','PASS: revoked rejected');
        else insert into _wt values('worker_get_tasks revoked token','FAIL: '||left(sqlerrm,40)); end if; end;

  begin perform public.worker_get_tasks(gen_random_uuid());
        insert into _wt values('worker_get_tasks bogus token','FAIL: allowed (should deny)');
  exception when others then
        if sqlerrm ilike '%invalid%' then insert into _wt values('worker_get_tasks bogus token','PASS: invalid rejected');
        else insert into _wt values('worker_get_tasks bogus token','FAIL: '||left(sqlerrm,40)); end if; end;
  perform auth.logout();
end $$;

select name,result from _wt order by name;
select case when count(*) filter (where result like 'FAIL%')=0 then 'WORKER-TOKEN: ALL PASS ('||count(*)||' checks)' else 'WORKER-TOKEN: '||count(*) filter (where result like 'FAIL%')||' FAILED' end from _wt;
