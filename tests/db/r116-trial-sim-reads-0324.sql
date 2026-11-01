-- r116-trial-sim-reads-0324.sql - 0324 (R116): public_trial_sim_payments(kind, ref) lets the client portal / booklet SHOW a
-- free-trial studio's simulated (TEST) payments. Proves:
--   (1) trial: after the test approval (000000) + "Simulate payment", the approval-link and booklet answers list the TEST
--       row with its milestone id, amount, label and TEST- receipt, total = the simulated amount; before any simulation: [];
--   (2) read-only: calling it writes nothing (trial_sim_payments, payment_milestones, quote_payments unchanged);
--   (3) a PAID studio -> {simulation:false} only; unknown / malformed / revoked / expired links -> null;
--   (4) structure: anon can execute, stable, security definer, empty search_path.
-- Re-applies 0324 twice. Every case is rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0324_r116_trial_sim_reads.sql
\ir ../../supabase/migrations/0324_r116_trial_sim_reads.sql
set client_min_messages = warning;
begin;
drop table if exists _g324; create temp table _g324(name text, result text); grant all on _g324 to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g324 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;

-- one case (rolled back): p_status 'trial' / 'active'; p_ms milestones; p_sim = simulate N times after the test approval;
-- p_link 'ok' / 'revoked' / 'expired' (the booklet token); p_kind = what to read
create or replace function pg_temp.run_case(p_kind text, p_status text, p_ms int default 2, p_sim int default 1,
                                            p_link text default 'ok')
returns text language plpgsql as $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; tok text := 'b0000000-0000-4000-8000-0000000000bb';
  b_org uuid := 'b0000000-0000-4000-8000-000000000001'; btok text := 'b0000000-0000-4000-8000-0000000000bc';
  r text := ''; i int; v_s0 int; v_p0 int; v_m0 text;
begin
  begin
    update public.quotes set pricing = jsonb_build_object('total', 118000, 'subtotal', 118000), approval_status = 'sent',
           status = 'quote', consent_stale = false, approval_token = tok::uuid, approval_token_expires_at = null,
           client = coalesce(client, '{}'::jsonb) || '{"phone":"+919800000324","email":"client324@example.com","name":"Client"}'::jsonb
     where id = q;
    delete from public.payment_milestones where quote_id = q;
    for i in 1 .. p_ms loop
      insert into public.payment_milestones(quote_id, org_id, label, amount, status, seq, due_date)
        values (q, b_org, 'Part ' || i, 1000 * i, 'due', i, current_date + i);
    end loop;
    insert into public.client_booklets(org_id, quote_id, token, revoked_at, expires_at)
      values (b_org, q, btok::uuid, case when p_link = 'revoked' then now() end,
              case when p_link = 'expired' then now() - interval '1 day' else now() + interval '30 days' end);
    insert into public.studio_subscriptions(org_id, status, trial_ends_at)
      values (b_org, p_status, current_date + 10)
      on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
    if p_status = 'trial' and p_sim > 0 then
      perform pg_temp.as_val('anon', format($s$select public.trial_test_approve_code(%L, '000000', null, 'Client', 'v2', 'I agree', 'UA')::text$s$, tok));
      for i in 1 .. p_sim loop
        perform pg_temp.as_val('anon', format($s$select public.trial_simulate_payment(%L, 'Client', 'UA')::text$s$, tok));
      end loop;
    end if;
    select count(*) into v_s0 from public.trial_sim_payments where quote_id = q;
    select count(*) into v_p0 from public.quote_payments where quote_id = q;
    select coalesce(string_agg(status || ':' || amount::text, ',' order by seq), '-') into v_m0 from public.payment_milestones where quote_id = q;
    if p_kind = 'quote' then
      r := pg_temp.as_val('anon', format($s$select public.public_trial_sim_payments('quote', %L)::text$s$, tok));
    elsif p_kind = 'booklet' then
      r := pg_temp.as_val('anon', format($s$select public.public_trial_sim_payments('booklet', %L)::text$s$, btok));
    elsif p_kind = 'first_ms' then   -- the first simulated row names the first milestone
      r := pg_temp.as_val('anon', format($s$select (public.public_trial_sim_payments('quote', %L) -> 'rows' -> 0 ->> 'milestone_id')$s$, tok));
      r := (r = (select id::text from public.payment_milestones where quote_id = q and seq = 1))::text;
    elsif p_kind = 'unknown' then
      r := pg_temp.as_val('anon', $s$select coalesce(public.public_trial_sim_payments('quote', 'b0000000-0000-4000-8000-0000000000ff')::text, 'null')
                                       || '/' || coalesce(public.public_trial_sim_payments('quote', 'x')::text, 'null')
                                       || '/' || coalesce(public.public_trial_sim_payments('nope', 'b0000000-0000-4000-8000-0000000000bb')::text, 'null')
                                       || '/' || coalesce(public.public_trial_sim_payments(null, null)::text, 'null')$s$);
    end if;
    raise exception using errcode = 'HR116', message = 'R=' || r
      || ' |SIMD=' || ((select count(*) from public.trial_sim_payments where quote_id = q) - v_s0)::text
      || ' |PAY=' || ((select count(*) from public.quote_payments where quote_id = q) - v_p0)::text
      || ' |MS=' || case when (select coalesce(string_agg(status || ':' || amount::text, ',' order by seq), '-') from public.payment_milestones where quote_id = q) = v_m0
                         then 'same' else 'CHANGED' end;
  exception when sqlstate 'HR116' then
    return sqlerrm;
  end;
end $$;

do $$ declare r text;
begin
  r := pg_temp.run_case('quote', 'trial', 2, 1);
  perform pg_temp.t('01 trial, one simulated payment: approval link lists 1 TEST row (Part 1, 1000, TEST- receipt), total 1000',
    r like 'R={%"simulation": true%' and r like '%"label": "Part 1"%' and r like '%"receipt": "TEST-%' and r like '%"total": 1000%'
    and r like '%"real_payment": false%' and r not like '%"Part 2"%', r);
  perform pg_temp.t('02 reading writes nothing (trial_sim_payments, quote_payments, milestones unchanged)',
    r like '%|SIMD=0 |PAY=0 |MS=same', r);
  r := pg_temp.run_case('first_ms', 'trial', 2, 1);
  perform pg_temp.t('03 the TEST row carries the milestone id of the first open milestone', r like 'R=true %', r);
  r := pg_temp.run_case('booklet', 'trial', 2, 2);
  perform pg_temp.t('04 trial, two simulated payments: the booklet token lists both, total 3000',
    r like '%"Part 1"%' and r like '%"Part 2"%' and r like '%"total": 3000%', r);
  r := pg_temp.run_case('quote', 'trial', 2, 0);
  perform pg_temp.t('05 trial, nothing simulated yet: simulation true, rows [] and total 0',
    r like '%"simulation": true%' and r like '%"rows": []%' and r like '%"total": 0%', r);
  r := pg_temp.run_case('quote', 'active', 2, 0);
  perform pg_temp.t('06 PAID studio: {simulation:false} only', r like 'R={"simulation": false} %', r);
  r := pg_temp.run_case('booklet', 'active', 2, 0);
  perform pg_temp.t('07 PAID studio booklet: {simulation:false} only', r like 'R={"simulation": false} %', r);
  r := pg_temp.run_case('booklet', 'trial', 2, 1, 'revoked');
  perform pg_temp.t('08 revoked booklet token -> null', r like 'R=<null> %', r);
  r := pg_temp.run_case('booklet', 'trial', 2, 1, 'expired');
  perform pg_temp.t('09 expired booklet token -> null', r like 'R=<null> %', r);
  r := pg_temp.run_case('unknown', 'trial', 2, 1);
  perform pg_temp.t('10 unknown / malformed token, unknown kind, nulls -> null', r like 'R=null/null/null/null %', r);
  perform pg_temp.t('11 structure: anon can execute; stable; security definer; empty search_path',
    has_function_privilege('anon', 'public.public_trial_sim_payments(text,text)', 'execute')
    and (select p.provolatile = 's' and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%'
           from pg_proc p where p.oid = 'public.public_trial_sim_payments(text,text)'::regprocedure), null);
  perform pg_temp.t('12 trial_sim_payments still closed to anon', not has_table_privilege('anon', 'public.trial_sim_payments', 'select'), null);
end $$;

select name, result from _g324 where result <> 'PASS' order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R116-TRIAL-SIM-READS-0324: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R116-TRIAL-SIM-READS-0324: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g324;
rollback;
