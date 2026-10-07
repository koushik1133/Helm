-- d6-money-freeze.sql — 0046 owner decision D6: approved expense claims, decided change
-- requests and the cost lines of a closed event are frozen for API callers.
-- Fixture: a_admin / a_staff (sales, finance edit) in studio A, b_admin in studio B; a_crew
-- (no finance access) is seeded here. ONE transaction, rolled back at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _dm(n serial, name text, result text); grant all on _dm to anon, authenticated;
grant usage on sequence _dm_n_seq to anon, authenticated;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
-- records a result, then restores whoever was signed in (so a step can't silently run as owner)
declare v_sub text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
begin perform pg_temp.su(); insert into _dm(name, result) values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if v_sub is not null then perform auth.login_as(v_sub::uuid); end if; end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate||' '||sqlerrm; end $$;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR:'||sqlstate||' '||sqlerrm; end $$;
grant execute on function pg_temp.try(text), pg_temp.val(text), pg_temp.uid(text) to anon, authenticated;

-- ---- setup (owner) -------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at)
  values ('a0000000-0000-4000-8000-00000046a002', 'A-0462', 'Party A46', 'quote', '{"name":"Ann"}', '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}', 1, 'sent',
          'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000004600a2', current_date + 30, now(), now());
  perform auth.seed_user('a_crew46@a.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (pg_temp.uid('a_crew46@a.test'), 'a_crew46@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = 'crew', org_id = excluded.org_id;
end $$;

-- =====================================================================================
-- expense_claims
-- =====================================================================================
do $$ declare s text; c1 uuid; c2 uuid; c3 uuid; n text;
  q text := 'a0000000-0000-4000-8000-00000000da01';
begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('insert into public.expense_claims(quote_id, who, amount, status) values (%L, ''x'', 10, ''approved'')', q));
  perform pg_temp.res('EC-01 denied: a claim can''t be inserted already approved', s like '42501%', s);
  insert into public.expense_claims(quote_id, who, amount) values (q::uuid, 'Ravi', 1000) returning id into c1;
  perform pg_temp.res('EC-02 created_by stamped to the maker',
    (select created_by from public.expense_claims where id = c1) = pg_temp.uid('a_staff@a.test'), '');
  s := pg_temp.try(format('update public.expense_claims set amount = 1200, description = ''taxi'' where id = %L', c1));
  perform pg_temp.res('EC-03 allowed: the maker edits a PENDING claim', s = '', s);
  s := pg_temp.try(format('update public.expense_claims set created_by = %L where id = %L', pg_temp.uid('a_admin@a.test'), c1));
  perform pg_temp.res('EC-04 denied: created_by can''t be rewritten', s like '42501%', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''approved'' where id = %L', c1));
  perform pg_temp.res('EC-05 denied (maker-checker): the maker can''t approve own claim', s like '42501%', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''paid'' where id = %L', c1));
  perform pg_temp.res('EC-06 denied (maker-checker): the maker can''t mark own claim paid', s like '42501%', s);
  perform pg_temp.login('a_crew46@a.test');
  n := pg_temp.val(format('with u as (update public.expense_claims set status = ''approved'' where id = %L returning 1) select count(*) from u', c1));
  perform pg_temp.res('EC-07 denied: lower role (crew, no finance) approves 0 claims', n = '0', n);
  perform pg_temp.login('b_admin@b.test');
  n := pg_temp.val(format('with u as (update public.expense_claims set status = ''approved'' where id = %L returning 1) select count(*) from u', c1));
  perform pg_temp.res('EC-08 denied: Org B admin approves 0 Org A claims', n = '0', n);
  n := pg_temp.val(format('with u as (delete from public.expense_claims where id = %L returning 1) select count(*) from u', c1));
  perform pg_temp.res('EC-09 denied: Org B admin deletes 0 Org A claims', n = '0', n);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.expense_claims set status = ''approved'' where id = %L', c1));
  perform pg_temp.res('EC-10 allowed: the checker (admin) approves', s = '', s);
  s := pg_temp.try(format('update public.expense_claims set amount = 99999 where id = %L', c1));
  perform pg_temp.res('EC-11 denied: approved claim amount can''t change (even admin)', s like '42501%', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('update public.expense_claims set who = ''Someone'' where id = %L', c1));
  perform pg_temp.res('EC-12 denied: approved claim payee can''t change', s like '42501%', s);
  s := pg_temp.try(format('delete from public.expense_claims where id = %L', c1));
  perform pg_temp.res('EC-13 denied: approved claim can''t be deleted', s like '42501%', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''pending'' where id = %L', c1));
  perform pg_temp.res('EC-14 denied: approved → pending (reversal) refused', s like '42501%', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''paid'' where id = %L', c1));
  perform pg_temp.res('EC-15 denied (maker-checker): maker can''t mark own approved claim paid', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.expense_claims set status = ''paid'' where id = %L', c1));
  perform pg_temp.res('EC-16 allowed: approved → paid by the checker', s = '', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''rejected'' where id = %L', c1));
  perform pg_temp.res('EC-17 denied: a paid claim is final', s like '42501%', s);
  s := pg_temp.try(format('delete from public.expense_claims where id = %L', c1));
  perform pg_temp.res('EC-18 denied: a paid claim can''t be deleted (admin)', s like '42501%', s);
  -- another person's claim: staff (finance edit) approves; rejected is final
  insert into public.expense_claims(quote_id, who, amount) values (q::uuid, 'Admin cab', 300) returning id into c2;
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('update public.expense_claims set status = ''approved'' where id = %L', c2));
  perform pg_temp.res('EC-19 allowed: sales (finance edit) approves someone else''s claim', s = '', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''rejected'' where id = %L', c2));
  perform pg_temp.res('EC-20 allowed: approved → rejected', s = '', s);
  s := pg_temp.try(format('update public.expense_claims set status = ''paid'' where id = %L', c2));
  perform pg_temp.res('EC-21 denied: a rejected claim is final', s like '42501%', s);
  -- pending claim: delete allowed
  insert into public.expense_claims(quote_id, who, amount) values (q::uuid, 'Temp', 5) returning id into c3;
  s := pg_temp.try(format('delete from public.expense_claims where id = %L', c3));
  perform pg_temp.res('EC-22 allowed: a pending claim can be deleted', s = '', s);
  perform pg_temp.su();
  perform pg_temp.res('EC-23 frozen data intact (amount 1200, paid)',
    (select amount = 1200 and status = 'paid' from public.expense_claims where id = c1), '');
  s := pg_temp.try(format('update public.expense_claims set description = ''maint'' where id = %L', c1));
  perform pg_temp.res('EC-24 service role / owner maintenance unaffected', s = '', s);
end $$;

-- =====================================================================================
-- change_requests
-- =====================================================================================
do $$ declare s text; r1 uuid; r2 uuid; n text;
  q text := 'a0000000-0000-4000-8000-00000000da01';
begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('insert into public.change_requests(quote_id, title, status) values (%L, ''x'', ''approved'')', q));
  perform pg_temp.res('CR-01 denied: a change request can''t be inserted already approved', s like '42501%', s);
  insert into public.change_requests(quote_id, title, price_delta, cost_delta) values (q::uuid, 'Extra lights', 5000, 3000) returning id into r1;
  s := pg_temp.try(format('update public.change_requests set price_delta = 6000 where id = %L', r1));
  perform pg_temp.res('CR-02 allowed: edit a REQUESTED change', s = '', s);
  perform pg_temp.login('a_crew46@a.test');
  n := pg_temp.val(format('with u as (update public.change_requests set status = ''approved'' where id = %L returning 1) select count(*) from u', r1));
  perform pg_temp.res('CR-03 denied: lower role approves 0 change requests', n = '0', n);
  perform pg_temp.login('b_admin@b.test');
  n := pg_temp.val(format('with u as (update public.change_requests set status = ''approved'' where id = %L returning 1) select count(*) from u', r1));
  perform pg_temp.res('CR-04 denied: Org B admin approves 0 Org A change requests', n = '0', n);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.change_requests set status = ''approved'', decided_at = now() where id = %L', r1));
  perform pg_temp.res('CR-05 allowed: requested → approved (finance edit)', s = '', s);
  s := pg_temp.try(format('update public.change_requests set price_delta = 1 where id = %L', r1));
  perform pg_temp.res('CR-06 denied: approved change price can''t change', s like '42501%', s);
  s := pg_temp.try(format('update public.change_requests set cost_delta = 1 where id = %L', r1));
  perform pg_temp.res('CR-07 denied: approved change cost can''t change', s like '42501%', s);
  s := pg_temp.try(format('update public.change_requests set status = ''rejected'' where id = %L', r1));
  perform pg_temp.res('CR-08 denied: an approved change is final', s like '42501%', s);
  s := pg_temp.try(format('update public.change_requests set status = ''requested'', decided_at = null where id = %L', r1));
  perform pg_temp.res('CR-09 denied: approved → requested (reversal) refused', s like '42501%', s);
  s := pg_temp.try(format('delete from public.change_requests where id = %L', r1));
  perform pg_temp.res('CR-10 denied: an approved change can''t be deleted', s like '42501%', s);
  insert into public.change_requests(quote_id, title) values (q::uuid, 'Drop cake') returning id into r2;
  s := pg_temp.try(format('update public.change_requests set status = ''rejected'', decided_at = now() where id = %L', r2));
  perform pg_temp.res('CR-11 allowed: requested → rejected', s = '', s);
  s := pg_temp.try(format('delete from public.change_requests where id = %L', r2));
  perform pg_temp.res('CR-12 denied: a rejected change can''t be deleted', s like '42501%', s);
  perform pg_temp.su();
  perform pg_temp.res('CR-13 frozen data intact', (select price_delta = 6000 and status = 'approved' from public.change_requests where id = r1), '');
end $$;

-- =====================================================================================
-- event_costs (locked when the event is closed)
-- =====================================================================================
do $$ declare s text; k1 uuid; n text;
  q text := 'a0000000-0000-4000-8000-00000046a002';
begin
  perform pg_temp.login('a_staff@a.test');
  insert into public.event_costs(quote_id, description, estimated) values (q::uuid, 'Stage', 10000) returning id into k1;
  s := pg_temp.try(format('update public.event_costs set actual = 9500 where id = %L', k1));
  perform pg_temp.res('COST-01 allowed: edit a cost line of an open event', s = '', s);
  perform pg_temp.login('b_admin@b.test');
  n := pg_temp.val(format('with u as (update public.event_costs set actual = 1 where id = %L returning 1) select count(*) from u', k1));
  perform pg_temp.res('COST-02 denied: Org B admin updates 0 Org A cost lines', n = '0', n);
  perform pg_temp.su();
  insert into public.event_closure(quote_id, closed_at, org_id) values (q::uuid, now(), 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_costs set actual = 1 where id = %L', k1));
  perform pg_temp.res('COST-03 denied: closed event cost amount can''t change (admin)', s like '42501%', s);
  s := pg_temp.try(format('delete from public.event_costs where id = %L', k1));
  perform pg_temp.res('COST-04 denied: closed event cost line can''t be deleted', s like '42501%', s);
  s := pg_temp.try(format('insert into public.event_costs(quote_id, description, estimated) values (%L, ''late'', 5)', q));
  perform pg_temp.res('COST-05 denied: no new cost line on a closed event', s like '42501%', s);
  s := pg_temp.try(format('update public.event_costs set quote_id = ''a0000000-0000-4000-8000-00000000da01'' where id = %L', k1));
  perform pg_temp.res('COST-06 denied: a locked cost line can''t be moved to another event', s like '42501%', s);
  perform pg_temp.su();
  update public.event_closure set closed_at = null where quote_id = q::uuid;     -- re-open (close_event false)
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_costs set actual = 9600 where id = %L', k1));
  perform pg_temp.res('COST-07 allowed: after re-opening the event the line is editable', s = '', s);
end $$;

-- =====================================================================================
-- suspended studio stays read-only (0045), even for a legitimate next step
-- =====================================================================================
do $$ declare s text; c1 uuid; n text;
  q text := 'a0000000-0000-4000-8000-00000000da01';
begin
  perform pg_temp.login('a_staff@a.test');
  insert into public.expense_claims(quote_id, who, amount) values (q::uuid, 'Susp', 50) returning id into c1;
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values ('a0000000-0000-4000-8000-000000000001', 'suspended')
    on conflict (org_id) do update set status = 'suspended';
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.expense_claims set status = ''approved'' where id = %L', c1));
  perform pg_temp.res('SUSP-01 denied: suspended studio can''t approve a claim (25006)', s like '25006%', s);
  s := pg_temp.try(format('insert into public.change_requests(quote_id, title) values (%L, ''s'')', q));
  perform pg_temp.res('SUSP-02 denied: suspended studio can''t add a change request', s like '25006%', s);
  n := pg_temp.val(format('select count(*) from public.expense_claims where id = %L', c1));
  perform pg_temp.res('SUSP-03 allowed: suspended studio still reads its claims', n = '1', n);
end $$;

-- ---- shape: re-applying 0046 is a no-op ------------------------------------------------
select pg_temp.su() \gset _x
\i ../../supabase/migrations/0046_d6_money_freeze.sql
do $$ begin perform pg_temp.su();
  perform pg_temp.res('SHAPE-01 one freeze trigger per table after re-apply',
    (select count(*) from pg_trigger where tgname = 'ac_a46_money_freeze') = 3, '');
  perform pg_temp.res('SHAPE-02 freeze function not executable by API roles',
    not has_function_privilege('authenticated', 'public._a46_tg_money_freeze()', 'execute'), '');
end $$;

-- ---- summary ---------------------------------------------------------------------------
select n, name, result from _dm order by n;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'D6-MONEY-FREEZE: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'D6-MONEY-FREEZE: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary
  from _dm;
rollback;
