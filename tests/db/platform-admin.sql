-- platform-admin.sql — 0029 Helm HQ (private platform-owner dashboard).
-- Studio admins, studio staff and signed-out visitors must get 42501 / nothing
-- from every hq_* RPC and must not read platform_admins. An allowlisted, confirmed
-- e-mail gets data, and the numbers match the two-tenant fixture. Unconfirmed
-- e-mail, a spoofed e-mail claim, and an aal1 session on an MFA-enrolled operator
-- are all refused.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _pa; create temp table _pa(name text, result text); grant all on _pa to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
-- login with extra claims merged in (e.g. aal, spoofed email)
create or replace function pg_temp.login_x(p_email text, p_extra jsonb) returns void language plpgsql as $$
declare c jsonb; begin
  perform pg_temp.login(p_email);
  c := auth.jwt() || p_extra; perform set_config('request.jwt.claims', c::text, false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _pa values (p_name, case when p_ok then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run each hq_* RPC as the current caller; returns the list of RPCs that did NOT raise 42501
create or replace function pg_temp.leaks() returns text language plpgsql as $$
declare out text := ''; sql text;
begin
  foreach sql in array array['select public.hq_overview()', 'select count(*) from public.hq_studios(null,25,0)',
      'select public.hq_studio_detail(''a0000000-0000-4000-8000-000000000001'')', 'select count(*) from public.hq_users(null,25,0)',
      'select public.hq_payments(null,null)'] loop
    begin execute sql; out := out || sql || ' ; ';
    exception when insufficient_privilege then null;
              when others then out := out || sql || ' [' || sqlstate || '] ; ';
    end;
  end loop;
  return out;
end $$;
grant execute on function pg_temp.leaks() to anon, authenticated;

-- ---- setup (superuser) ---------------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        qA uuid := 'a0000000-0000-4000-8000-00000000da01'; qB uuid := 'b0000000-0000-4000-8000-00000000da01'; u uuid;
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  if not exists (select 1 from auth.users where email = 'security@helm.events') then perform auth.seed_user('security@helm.events'); end if;
  update auth.users set email_confirmed_at = null where email = 'security@helm.events';      -- unconfirmed
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  update auth.users set last_sign_in_at = now() - interval '1 day' where email in ('a_admin@a.test','b_admin@b.test');
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
  update public.platform_admins set require_mfa = false;

  update public.quotes set status = 'confirmed' where id = qA;                    -- 236000 booked in A
  delete from public.quote_payments where quote_id in (qA, qB);
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, receipt_no, method, paid_at)
    values (qA, orgA, 'cash', 1000, 'paid', false, 'RCP-PA-1', 'cash', now()),
           (qB, orgB, 'razorpay', 500, 'paid', true, 'RCP-PA-SIM', 'upi', now());  -- simulated: not counted
  delete from public.payment_milestones where quote_id in (qA, qB);
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, seq) values
    (qA, orgA, 'pa-overdue', current_date - 3, 5000, 'due', 1),
    (qA, orgA, 'pa-soon',    current_date + 5, 7000, 'due', 2),
    (qB, orgB, 'pa-paid',    current_date - 1, 9000, 'paid', 1);
end $$;

-- ---- 1) every non-operator is refused --------------------------------------------------
do $$ declare l text; begin
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  l := pg_temp.leaks(); perform pg_temp.res('anon: every hq_* RPC refused (42501)', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('a_admin@a.test'); l := pg_temp.leaks();
  perform pg_temp.res('studio admin A: every hq_* RPC refused (42501)', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('b_admin@b.test'); l := pg_temp.leaks();
  perform pg_temp.res('studio admin B: every hq_* RPC refused (42501)', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('a_staff@a.test'); l := pg_temp.leaks();
  perform pg_temp.res('studio staff: every hq_* RPC refused (42501)', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('security@helm.events'); l := pg_temp.leaks();
  perform pg_temp.res('allowlisted but UNCONFIRMED e-mail: refused', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login_x('a_admin@a.test', '{"email":"admin@helm.events","email_verified":true,"aal":"aal2"}');
  l := pg_temp.leaks(); perform pg_temp.res('studio admin with a SPOOFED admin@helm.events e-mail claim: refused', l = '', l);
end $$;
do $$ declare ok boolean; begin
  perform pg_temp.login('a_admin@a.test'); ok := public.is_platform_admin();
  perform pg_temp.res('is_platform_admin() is false for a studio admin', not ok, 'true');
end $$;

-- ---- 2) nobody but definer code reads the allowlist -----------------------------------
do $$ declare n int := -1; e text := ''; begin
  perform pg_temp.login('a_admin@a.test');
  begin select count(*) into n from public.platform_admins; exception when others then e := sqlstate; end;
  perform pg_temp.res('studio admin cannot read platform_admins', e = '42501', 'n='||n||' e='||e);
end $$;
do $$ declare n int := -1; e text := ''; begin
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  begin select count(*) into n from public.platform_admins; exception when others then e := sqlstate; end;
  perform pg_temp.res('anon cannot read platform_admins', e = '42501', 'n='||n||' e='||e);
end $$;
do $$ declare n int := -1; e text := ''; begin
  perform pg_temp.login('admin@helm.events');
  begin select count(*) into n from public.platform_admins; exception when others then e := sqlstate; end;
  perform pg_temp.res('even an operator cannot read platform_admins directly (definer-only)', e = '42501', 'n='||n||' e='||e);
end $$;
do $$ begin perform pg_temp.su();
  perform pg_temp.res('grants: anon cannot execute any hq_* RPC or is_platform_admin',
    not has_function_privilege('anon','public.hq_overview()','EXECUTE')
    and not has_function_privilege('anon','public.hq_studios(text,int,int)','EXECUTE')
    and not has_function_privilege('anon','public.hq_studio_detail(uuid)','EXECUTE')
    and not has_function_privilege('anon','public.hq_users(text,int,int)','EXECUTE')
    and not has_function_privilege('anon','public.hq_payments(date,date)','EXECUTE')
    and not has_function_privilege('anon','public.is_platform_admin()','EXECUTE'), 'anon has execute');
  perform pg_temp.res('grants: internal helpers not callable by signed-in users',
    not has_function_privilege('authenticated','public._hq_gate(text,text)','EXECUTE')
    and not has_function_privilege('authenticated','public._hq_studio_rows()','EXECUTE'), 'helper executable');
  perform pg_temp.res('grants: platform_admins has RLS on and no table grants to anon/authenticated',
    (select relrowsecurity from pg_class where oid = 'public.platform_admins'::regclass)
    and not has_table_privilege('authenticated','public.platform_admins','SELECT')
    and not has_table_privilege('anon','public.platform_admins','SELECT'), 'exposed');
  perform pg_temp.res('allowlist seeded with exactly the two operator e-mails',
    (select array_agg(email order by email) from public.platform_admins) = array['admin@helm.events','security@helm.events'], 'seed differs');
end $$;

-- ---- 3) the operator gets correct numbers ---------------------------------------------------
do $$ declare r jsonb; e_orgs bigint; e_users bigint; e_rev numeric; e_paid numeric; e_out numeric; e_q bigint; begin
  perform pg_temp.su();
  select count(*) into e_orgs from public.organizations; select count(*) into e_users from auth.users;
  select count(*) into e_q from public.quotes;
  select coalesce(sum(public._hq_num(pricing->>'total')),0) into e_rev from public.quotes where status='confirmed';
  select coalesce(sum(amount),0) into e_paid from public.quote_payments where status='paid' and not simulated;
  perform pg_temp.login('admin@helm.events');
  begin r := public.hq_overview(); exception when others then perform pg_temp.res('operator: hq_overview returns data', false, sqlerrm); return; end;
  perform pg_temp.res('operator: hq_overview returns data', r ? 'studios' and r ? 'money' and r ? 'signups_30d', r::text);
  perform pg_temp.res('overview: studio + user + event totals match the database',
    (r#>>'{studios,total}')::bigint = e_orgs and (r#>>'{users,total}')::bigint = e_users and (r#>>'{events,total}')::bigint = e_q,
    (r->>'studios') || (r->>'users') || (r->>'events'));
  perform pg_temp.res('overview: revenue booked = confirmed totals (incl. Studio A 236000)',
    (r#>>'{money,revenue_booked}')::numeric = e_rev and e_rev >= 236000, (r#>>'{money,revenue_booked}')||' vs '||e_rev);
  perform pg_temp.res('overview: received excludes simulated payments',
    (r#>>'{money,received_all}')::numeric = e_paid and (r#>>'{money,received_30d}')::numeric = e_paid, (r->>'money'));
  select coalesce(sum(greatest(public._hq_num(q.pricing->>'total') - coalesce((select sum(amount) from public.quote_payments p
           where p.quote_id=q.id and p.status='paid' and not p.simulated),0),0)),0) into e_out from public.quotes q where q.status='confirmed';
  perform pg_temp.res('overview: outstanding balance (A = 236000 - 1000)',
    (r#>>'{money,outstanding}')::numeric = e_out, (r#>>'{money,outstanding}')||' vs '||e_out);
  perform pg_temp.res('overview: milestones overdue 5000 / due-in-14d 7000 (paid one ignored)',
    (r#>>'{money,overdue_amount}')::numeric = 5000 and (r#>>'{money,overdue_count}')::int = 1
    and (r#>>'{money,due_14d_amount}')::numeric = 7000 and (r#>>'{money,due_14d_count}')::int = 1, r->>'money');
  perform pg_temp.res('overview: signups series has 30 days, active users counted',
    jsonb_array_length(r->'signups_30d') = 30 and (r#>>'{users,active_7d}')::int >= 2, (r->'users')::text);
  perform pg_temp.res('overview: MFA adoption + storage sections present', r ? 'mfa' and r ? 'storage', r::text);
end $$;
do $$ declare rec record; n int; begin
  perform pg_temp.login('admin@helm.events');
  select * into rec from public.hq_studios('Studio A', 25, 0) limit 1;
  select count(*) into n from public.hq_studios('Studio A', 25, 0);
  perform pg_temp.res('hq_studios: search finds Studio A with revenue 236000 / paid 1000 / owner admin',
    n = 1 and rec.name = 'Studio A' and rec.revenue = 236000 and rec.paid = 1000 and rec.users_count >= 2
    and rec.events_count >= 1 and rec.confirmed_count = 1 and rec.owner_email = 'a_admin@a.test' and rec.total_count = 1,
    coalesce(row_to_json(rec)::text, 'none'));
  perform pg_temp.login('admin@helm.events');
  select count(*) into n from public.hq_studios(null, 1, 0);
  perform pg_temp.res('hq_studios: paging limit honoured', n = 1, n::text);
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.login('admin@helm.events');
  r := public.hq_studio_detail('b0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('hq_studio_detail: Studio B members + no revenue (simulated only)',
    r->>'name' = 'Studio B' and jsonb_array_length(r->'members') >= 2 and (r->>'paid')::numeric = 0 and (r->>'revenue')::numeric = 0, r::text);
end $$;
do $$ declare rec record; cols text; begin
  perform pg_temp.login('admin@helm.events');
  select * into rec from public.hq_users('a_admin@a.test', 25, 0);
  perform pg_temp.res('hq_users: finds a_admin with studio + role', rec.studio = 'Studio A' and rec.role = 'admin'
    and rec.email_confirmed and not rec.mfa_enabled, coalesce(row_to_json(rec)::text,'none'));
  perform pg_temp.su();
  select string_agg(a, ',') into cols from (select unnest(proargnames) a from pg_proc where proname = 'hq_users') x
   where a ~* 'pass|token|secret|hash';
  perform pg_temp.res('hq_users: exposes no password / token columns', cols is null, cols);
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.login('admin@helm.events');
  r := public.hq_payments(current_date - 7, current_date);
  perform pg_temp.res('hq_payments: recent payments incl. simulated flag + open milestones with overdue flag',
    jsonb_array_length(r->'payments') >= 2
    and exists (select 1 from jsonb_array_elements(r->'milestones') m where m->>'label' = 'pa-overdue' and (m->>'overdue')::boolean)
    and exists (select 1 from jsonb_array_elements(r->'milestones') m where m->>'label' = 'pa-soon' and not (m->>'overdue')::boolean)
    and not exists (select 1 from jsonb_array_elements(r->'milestones') m where m->>'label' = 'pa-paid'), r::text);
end $$;
do $$ declare n int; begin perform pg_temp.su();
  select count(*) into n from public.audit_log a join auth.users u on u.id = a.actor
   where u.email = 'admin@helm.events' and a.action = 'hq.view' and a.org_id is null;
  perform pg_temp.res('every operator call is logged as hq.view (org-less, invisible to studios)', n >= 6, n::text);
end $$;

-- ---- 4) MFA ------------------------------------------------------------------------------------
do $$ declare l text; begin perform pg_temp.su();
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'admin@helm.events';
  perform pg_temp.login('admin@helm.events'); l := pg_temp.leaks();
  perform pg_temp.res('operator WITH a verified factor on an aal1 session: refused', l = '', l);
  perform pg_temp.login_x('admin@helm.events', '{"aal":"aal2"}');
  perform pg_temp.res('operator WITH a verified factor on an aal2 session: allowed', public.is_platform_admin(), 'refused');
end $$;
do $$ declare ok boolean; begin perform pg_temp.su();
  delete from auth.mfa_factors where user_id in (select id from auth.users where email = 'admin@helm.events');
  update public.platform_admins set require_mfa = true where email = 'admin@helm.events';
  perform pg_temp.login('admin@helm.events'); ok := public.is_platform_admin();
  perform pg_temp.res('require_mfa = true: un-enrolled operator on aal1 refused', not ok, 'allowed');
  perform pg_temp.su(); update public.platform_admins set require_mfa = false;
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  delete from public.payment_milestones where label in ('pa-overdue','pa-soon','pa-paid');
  delete from public.quote_payments where receipt_no in ('RCP-PA-1','RCP-PA-SIM');
  update public.quotes set status = 'quote' where id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.audit_log where action = 'hq.view';
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
end $$;
select name, result from _pa order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 32 then 'PLATFORM-ADMIN: ALL PASS (32/32)'
            else 'PLATFORM-ADMIN: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/32 ran' end from _pa;
