-- r112-reprice-money-0321.sql - 0321: a price change of a sent / approved quote always keeps a quotation version, and
-- every money view reads ONE figure (schedule card outstanding = closure balance), the schedule follows the price.
-- Replays the staging trial: Rs 1,82,310 approved -> 30/50/20 schedule -> Rs 50,000 received -> re-priced to
-- Rs 1,41,010 (the builder layout save) -> client approves again. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0321_r112_reprice_money.sql
\ir ../../supabase/migrations/0321_r112_reprice_money.sql
set client_min_messages = warning;
begin;
drop table if exists _g321; create temp table _g321(name text, result text); grant all on _g321 to anon, authenticated, service_role;
create temp table _k321(k text primary key, v text); grant all on _k321 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default '') returns void language plpgsql as $$
begin insert into _g321 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end); end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.pr(p_total numeric) returns jsonb language sql as $$
  select jsonb_build_object('other', p_total, 'guests', 200, 'platePrice', 0, 'discount', 0, 'gstPct', 0, 'total', p_total) $$;
grant execute on function pg_temp.pr(numeric) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
create or replace function pg_temp.event(p_org uuid, p_code text, p_total numeric, p_status text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at)
    values (v, p_code, 'Event ' || p_code, 'quote', '{"name":"Riya","email":"riya@example.com","guests":150}'::jsonb,
            pg_temp.pr(p_total), 1, p_status, p_org, gen_random_uuid(), public._pst_today(p_org) + 60, now(), now());
  return v;
end $$;
create or replace function pg_temp.nv(p_q uuid) returns integer language sql as $$ select count(*)::integer from public.quotation_versions where quote_id = p_q $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; begin
  perform pg_temp.member('r112_crew@a.test', 'crew', a);
  perform pg_temp.su();
  delete from public.payment_schedule_settings where org_id = a;   -- default: apply automatically, 30 / 50 / 20
  q := pg_temp.event(a, 'R112-1', 182310, 'sent');
  insert into public.quotation_versions(org_id, quote_id, label, pricing, total) values (a, q, 'Q1', pg_temp.pr(182310), 182310);
  insert into _k321 values ('q', q::text);
  update public.quotes set approval_status = 'approved' where id = q;     -- the client approves Rs 1,82,310
end $$;

-- ---- 1) approved at Rs 1,82,310, Rs 50,000 received: one outstanding everywhere --------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := (select v::uuid from _k321 where k = 'q'); r jsonb; b jsonb; begin
  r := pg_temp.j(format($s$select public.record_payment(%L, 50000, 'cash', null, null, null, 'r112-k1')$s$, q));
  perform pg_temp.t('01 Rs 50,000 recorded against the approved quote', r ? 'receipt_no' or r ? 'id' or not (r ? 'err'), r::text);
  r := public.payment_schedule_for_quote(q);
  perform pg_temp.su(); b := public._a49_close_blockers(q); perform pg_temp.login('a_admin@a.test');
  perform pg_temp.t('02 schedule 54,693 / 91,155 / 36,462 = the approved total',
    (r -> 'rows' -> 0 ->> 'amount')::numeric = 54693 and (r -> 'rows' -> 1 ->> 'amount')::numeric = 91155
    and (r -> 'rows' -> 2 ->> 'amount')::numeric = 36462 and (r ->> 'scheduled')::numeric = 182310, r::text);
  perform pg_temp.t('03 outstanding 1,32,310 on the card = closure balance, no mismatch',
    (r ->> 'outstanding')::numeric = 132310 and (b ->> 'balance_owed')::numeric = 132310 and not (r ->> 'mismatch')::boolean, r::text || ' / ' || b::text);
end $$;

-- ---- 2) re-priced through the app (the builder layout save): a new Q-version, never silent -------------------------
do $$ declare q uuid := (select v::uuid from _k321 where k = 'q'); n0 integer; r jsonb; b jsonb; e text := ''; begin
  n0 := pg_temp.nv(q);
  begin update public.quotes set pricing = pg_temp.pr(141010) where id = q;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.t('04 the app re-prices the approved quote (admin)', e = '', e);
  perform pg_temp.t('05 a new quotation version Q2 = Rs 1,41,010 is kept (the approved Q1 is untouched)',
    pg_temp.nv(q) = n0 + 1 and exists (select 1 from public.quotation_versions where quote_id = q and label = 'Q2' and total = 141010)
    and exists (select 1 from public.quotation_versions where quote_id = q and label = 'Q1' and total = 182310), pg_temp.nv(q)::text);
  perform pg_temp.su();
  perform pg_temp.t('06 audited (quote.reprice_version 182310 -> 141010)',
    exists (select 1 from public.audit_log l where l.quote_id = q and l.action = 'quote.reprice_version'
              and (l.changed ->> 'from')::numeric = 182310 and (l.changed ->> 'to')::numeric = 141010), null);
  b := public._a49_close_blockers(q);
  perform pg_temp.login('a_admin@a.test');
  r := public.payment_schedule_for_quote(q);
  perform pg_temp.t('07 card total 1,41,010 and outstanding 91,010 = closure balance 91,010 (was 1,32,310 vs 91,010)',
    (r ->> 'total')::numeric = 141010 and (r ->> 'outstanding')::numeric = 91010 and (b ->> 'balance_owed')::numeric = 91010, r::text);
  perform pg_temp.t('08 the old schedule is flagged (scheduled 1,82,310 <> total 1,41,010), Finance edit may re-split',
    (r ->> 'mismatch')::boolean and (r ->> 'scheduled')::numeric = 182310 and (r ->> 'can_resync')::boolean, r::text);
  -- the same total again: no second version
  update public.quotes set pricing = pg_temp.pr(141010) || '{"note":"x"}'::jsonb where id = q;
  perform pg_temp.t('09 same total re-saved: no extra version', pg_temp.nv(q) = n0 + 1, pg_temp.nv(q)::text);
end $$;

-- ---- 3) the client approves the new price: the open payments follow it, one figure everywhere ----------------------
do $$ declare q uuid := (select v::uuid from _k321 where k = 'q'); r jsonb; b jsonb; r1 numeric; begin
  perform pg_temp.su();
  update public.quotes set approval_status = 'sent' where id = q;
  update public.quotes set approval_status = 'approved', consent_stale = false where id = q;
  b := public._a49_close_blockers(q);
  perform pg_temp.login('a_admin@a.test');
  r := public.payment_schedule_for_quote(q);
  r1 := round(54693::numeric * 141010 / 182310);
  perform pg_temp.t('10 re-approval re-split the schedule to 1,41,010 (30% row = ' || r1 || ')',
    (r ->> 'scheduled')::numeric = 141010 and (r -> 'rows' -> 0 ->> 'amount')::numeric = r1
    and (select sum(amount) from public.payment_milestones where quote_id = q) = 141010 and not (r ->> 'mismatch')::boolean, r::text);
  perform pg_temp.t('11 the Rs 50,000 now covers the first payment (paid), the second is part paid',
    r -> 'rows' -> 0 ->> 'state' = 'paid' and r -> 'rows' -> 1 ->> 'state' = 'part_paid'
    and (r -> 'rows' -> 1 ->> 'paid')::numeric = 50000 - r1, r::text);
  perform pg_temp.t('12 outstanding = closure = remaining rows = 91,010',
    (r ->> 'outstanding')::numeric = 91010 and (b ->> 'balance_owed')::numeric = 91010
    and (select sum((x ->> 'remaining')::numeric) from jsonb_array_elements(r -> 'rows') x) = 91010, r::text);
  perform pg_temp.su();
  perform pg_temp.t('13 resync audited with the old and new amounts',
    exists (select 1 from public.audit_log l where l.quote_id = q and l.action = 'payment_schedule.resynced'
              and l.changed ->> 'source' = 'reapproval' and jsonb_array_length(l.changed -> 'old') = 3), null);
end $$;

-- ---- 4) save_quotation_version is not doubled; drafts and SQL by hand get no auto version -----------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := (select v::uuid from _k321 where k = 'q'); a uuid := 'a0000000-0000-4000-8000-000000000001'; n0 integer; d uuid; r jsonb; begin
  n0 := pg_temp.nv(q);
  r := pg_temp.j(format($s$select public.save_quotation_version(%L, %L::jsonb)$s$, q, pg_temp.pr(150000)));
  perform pg_temp.t('14 Save quotation (save_quotation_version) keeps exactly one new version', pg_temp.nv(q) = n0 + 1 and not (r ? 'err'), r::text);
  d := pg_temp.event(a, 'R112-D', 90000, 'none');
  perform pg_temp.login('a_admin@a.test');
  update public.quotes set pricing = pg_temp.pr(95000) where id = d;
  perform pg_temp.t('15 a draft (never sent) re-priced: no automatic version', pg_temp.nv(d) = 0, pg_temp.nv(d)::text);
  perform pg_temp.su();
  n0 := pg_temp.nv(q);
  update public.quotes set pricing = pg_temp.pr(160000) where id = q;
  perform pg_temp.t('16 SQL by hand (no API claims) is not versioned', pg_temp.nv(q) = n0, pg_temp.nv(q)::text);
end $$;

-- ---- 5) manual re-split: Finance edit only, own studio; never below what is paid ----------------------------------
do $$ declare q uuid := (select v::uuid from _k321 where k = 'q'); r jsonb; s0 text; begin
  perform pg_temp.su();
  update public.quotes set pricing = pg_temp.pr(170000) where id = q;
  perform pg_temp.login('r112_crew@a.test');
  r := pg_temp.j(format($s$select public.payment_schedule_resync(%L)$s$, q));
  perform pg_temp.t('17 crew (no Finance edit) cannot re-split', r ->> 'err' like '42501%', r::text);
  perform pg_temp.login('b_admin@b.test');
  r := pg_temp.j(format($s$select public.payment_schedule_resync(%L)$s$, q));
  perform pg_temp.t('18 another studio cannot re-split (not found)', r ->> 'err' like '42501%', r::text);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format($s$select public.payment_schedule_resync(%L)$s$, q));
  perform pg_temp.t('19 admin re-splits the open payments to the new total 1,70,000',
    (r ->> 'changed')::boolean and (select sum(amount) from public.payment_milestones where quote_id = q) = 170000, r::text);
  r := pg_temp.j(format($s$select public.payment_schedule_resync(%L)$s$, q));
  perform pg_temp.t('20 in step: a second re-split changes nothing', not (r ->> 'changed')::boolean and r ->> 'reason' = 'in_step', r::text);
  perform pg_temp.su();
  select string_agg(amount::text || status, ',' order by seq) into s0 from public.payment_milestones where quote_id = q;
  update public.quotes set pricing = pg_temp.pr(40000) where id = q;     -- below what is already scheduled as paid
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format($s$select public.payment_schedule_resync(%L)$s$, q));
  perform pg_temp.su();
  perform pg_temp.t('21 a total below the paid payments: nothing changed (flag only), paid rows untouched',
    not coalesce((r ->> 'changed')::boolean, true) and r ->> 'reason' = 'below_paid'
    and (select string_agg(amount::text || status, ',' order by seq) from public.payment_milestones where quote_id = q) = s0, r::text);
end $$;

-- ---- 5b) a hand-made schedule is never changed automatically (0264 rule) and is not flagged -------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; h uuid; r jsonb; begin
  h := pg_temp.event(a, 'R112-H', 50000, 'sent');
  insert into public.payment_milestones(quote_id, org_id, label, amount, status) values (h, a, 'Token', 5000, 'due');
  update public.quotes set approval_status = 'approved' where id = h;
  perform pg_temp.login('a_admin@a.test');
  r := public.payment_schedule_for_quote(h);
  perform pg_temp.su();
  perform pg_temp.t('25 hand-made schedule: approval leaves it as it is, no mismatch flag, outstanding = closure balance',
    (select string_agg(label || '=' || amount::numeric(14,2)::text, ',') from public.payment_milestones where quote_id = h) = 'Token=5000.00'
    and not (r ->> 'mismatch')::boolean and (r ->> 'outstanding')::numeric = 50000, r::text);
end $$;

-- ---- 6) grants / triggers ------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.t('22 grants: resync + for_quote authenticated only; internals not callable by the app',
    has_function_privilege('authenticated', 'public.payment_schedule_resync(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.payment_schedule_resync(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.payment_schedule_for_quote(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.payment_schedule_for_quote(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r321_resync(uuid, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r321_tg_reprice_version()', 'execute')
    and not has_function_privilege('authenticated', 'public._r321_tg_resync_on_approval()', 'execute'), null);
  perform pg_temp.t('23 one trigger each after two runs',
    (select count(*) from pg_trigger t where t.tgrelid = 'public.quotes'::regclass and t.tgname in ('zzzz_r321_reprice_version', 'zzzz_r321_resync_on_approval')) = 2, null);
  perform pg_temp.t('24 definer + empty search_path',
    (select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%') from pg_proc p
      where p.oid in ('public.payment_schedule_resync(uuid)'::regprocedure, 'public.payment_schedule_for_quote(uuid)'::regprocedure,
                      'public._r321_resync(uuid, text, uuid)'::regprocedure)), null);
end $$;

select pg_temp.su();
select name, result from _g321 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R112-REPRICE-MONEY-0321: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R112-REPRICE-MONEY-0321: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g321;
rollback;
