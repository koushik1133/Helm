-- r32-security-0282.sql -- r32 security review (owner-authorised): QC sign-off follows the access matrix (ACL-01), the
-- invitation e-mail's second secret (AUTH-1), seat answer before the e-mail lookup (AUTH-2), no studio on a temporary
-- password (AUTH-3), change-request approvals + closing with money owed (BIZ-01), the closed-event freeze (BIZ-02),
-- paid plan seat limits (BIZ-03), currency of a paid / approved quote (BIZ-04), sample adoption in a locked trial
-- (BIZ-05), Helm-owned studio settings (BIZ-06). Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
-- re-apply 0282 twice inside the test (earlier suites re-apply the 0049 / 0126 / 0155 / 0166 / 0264 bodies; re-run safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0282_r32_security_review.sql
\ir ../../supabase/migrations/0282_r32_security_review.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- a member of studio A with a role (superuser, fake account)
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid default 'a0000000-0000-4000-8000-000000000001') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, must_change_password = false;
  return u;
end $$;
create or replace function pg_temp.access(p_role text, p_area text, p_view boolean, p_edit boolean) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    values ('a0000000-0000-4000-8000-000000000001', p_role, p_area, p_view, p_edit, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
end $$;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the fixture event of studio A, ready to close: confirmed, priced 236000, event day over
create or replace function pg_temp.ready_event() returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', approval_status = 'approved', event_date = current_date - 3
   where id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.payment_milestones where quote_id = 'a0000000-0000-4000-8000-00000000da01';   -- test only: no auto schedule
end $$;

-- ================================================================================= ACL-01 verify_task
do $$ declare t uuid; v text; r public.event_tasks; begin
  perform pg_temp.su();
  insert into public.event_tasks(quote_id, category, title, seq, status, verify_status, assignee_name, assignee_phone, org_id)   -- r92: waiting for QC
    values ('a0000000-0000-4000-8000-00000000da01', 'setup', 'R32 stage', 1, 'completed', 'pending', 'Ravi', '+919800000099', 'a0000000-0000-4000-8000-000000000001')
    returning id into t;
  insert into _kv values ('task', t::text);
  perform pg_temp.member('r32_qa@a.test', 'quality');
  delete from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'quality';
  perform pg_temp.login('r32_qa@a.test');
  v := pg_temp.try(format('select public.verify_task(%L, true, %L)', t, 'ok'));
  perform pg_temp.res('01 ACL-01 quality with no Staff area in the matrix -> verify_task refused (42501)', v like '42501%', v);
  perform pg_temp.access('quality', 'staff', true, false);
  perform pg_temp.login('r32_qa@a.test');
  r := public.verify_task(t, true, 'qc ok');
  perform pg_temp.res('02 ACL-01 with Staff (view) -> passes; the answer is the id + QC result only (no assignee phone / name / title)',
    r.id = t and r.verify_status = 'passed' and r.verified_at is not null and r.assignee_phone is null and r.assignee_name is null and r.title is null,
    row_to_json(r)::text);
  perform pg_temp.su();
  perform pg_temp.res('03 ACL-01 the task row itself is updated in full',
    (select verify_status = 'passed' and verify_note = 'qc ok' and assignee_phone = '+919800000099' from public.event_tasks where id = t));
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= AUTH-1 mail key
do $$ declare v text; inv uuid; tok text; ok1 boolean; ok2 boolean; begin
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  perform public.create_invitation('r32_inv@a.test', 'sales');
  perform pg_temp.su();
  select id, token into inv, tok from public.invitations where email = 'r32_inv@a.test';
  perform pg_temp.res('04 AUTH-1 invitations.mail_key_hash exists (nullable) and a new invitation has none',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invitations' and column_name = 'mail_key_hash' and is_nullable = 'YES')
    and (select mail_key_hash from public.invitations where id = inv) is null);
  perform pg_temp.res('05 AUTH-1 invite_mail_key_set / invite_signup_record: service role only',
    has_function_privilege('service_role', 'public.invite_mail_key_set(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_mail_key_set(text, text)', 'execute')
    and not has_function_privilege('anon', 'public.invite_mail_key_set(text, text)', 'execute')
    and has_function_privilege('service_role', 'public.invite_signup_record(text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_signup_record(text, uuid)', 'execute'));
  ok1 := public.invite_mail_key_set(tok, repeat('ab', 32)); ok2 := public.invite_mail_key_set(tok, 'nothex');
  perform pg_temp.res('06 AUTH-1 the service stores a 64-hex hash for a pending invitation (bad input refused)',
    ok1 and not ok2 and (select mail_key_hash from public.invitations where id = inv) = repeat('ab', 32));
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try(format('update public.invitations set mail_key_hash = %L where id = %L', repeat('cd', 32), inv));
  perform pg_temp.su();
  perform pg_temp.res('07 AUTH-1 the studio admin cannot set the hash through the API (so cannot mint a key)',
    v like '42501%' and (select mail_key_hash from public.invitations where id = inv) = repeat('ab', 32), v);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try(format('update public.invitations set status = %L where id = %L', 'revoked', inv));
  perform pg_temp.su();
  perform pg_temp.res('08 AUTH-1 revoking still works for the admin', v = '' and (select status from public.invitations where id = inv) = 'revoked', v);
  update public.invitations set status = 'pending' where id = inv;
  perform auth.seed_user('r32_inv@a.test');
  ok1 := public.invite_signup_record(tok, (select id from auth.users where email = 'r32_inv@a.test'));
  perform pg_temp.res('09 AUTH-1 invite_signup_record records the login in a155_admin_created (studio + inviter)',
    ok1 and exists (select 1 from public.a155_admin_created a where a.user_id = (select id from auth.users where email = 'r32_inv@a.test')
                  and a.org_id = 'a0000000-0000-4000-8000-000000000001'));
  perform pg_temp.res('10 AUTH-1 invite_signup_record refuses a login whose e-mail is not the invitation''s',
    not public.invite_signup_record(tok, (select id from auth.users where email = 'b_staff@b.test')));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= AUTH-2 seat answer first
do $$ declare a text; b text; begin
  perform pg_temp.su();
  update public.organizations set seat_limit = 2 where id = 'a0000000-0000-4000-8000-000000000001';   -- A: admin + sales = full
  perform pg_temp.login('a_admin@a.test');
  a := pg_temp.try($q$select public.admin_create_user_temp('b_staff@b.test', 'sales')$q$);         -- has an account elsewhere
  b := pg_temp.try($q$select public.admin_create_user_temp('nobody-r32@example.org', 'sales')$q$); -- no account anywhere
  perform pg_temp.su();
  perform pg_temp.res('11 AUTH-2 full studio: the same answer for an existing and an unknown e-mail (no oracle)',
    a = b and a like '42501%' and a not like '%invitation instead%', a || ' | ' || b);
  perform pg_temp.res('12 AUTH-2 nothing was created for the unknown e-mail',
    not exists (select 1 from auth.users where email = 'nobody-r32@example.org'));
  update public.organizations set seat_limit = null where id = 'a0000000-0000-4000-8000-000000000001';
exception when others then perform pg_temp.su(); insert into _rs values ('1y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= AUTH-3 temporary password
do $$ declare u uuid; v text; begin
  perform pg_temp.su();
  u := pg_temp.member('r32_temp@a.test', 'sales');
  update public.profiles set must_change_password = true where id = u;
  update auth.users set encrypted_password = 'temp-hash-r32' where id = u;
  insert into public.auth_temp_passwords(user_id, pw_hash) values (u, 'temp-hash-r32')
    on conflict (user_id) do update set pw_hash = excluded.pw_hash;
  perform pg_temp.login('r32_temp@a.test');
  perform pg_temp.res('13 AUTH-3 on the admin-given temporary password: no studio (current_org_id empty, no studio rows visible)',
    public.current_org_id() is null and (select count(*) from public.quotes) = 0);
  perform pg_temp.res('14 AUTH-3 the password-change flow still works: password_change_required says true',
    public.password_change_required() is true);
  v := pg_temp.try('select public.clear_password_change_required()');
  perform pg_temp.res('15 AUTH-3 clearing is refused while the temporary password is unchanged', v like '42501%', v);
  perform pg_temp.su();
  update auth.users set encrypted_password = 'own-new-hash-r32' where id = u;   -- = supabase.auth.updateUser({ password })
  perform pg_temp.login('r32_temp@a.test');
  perform pg_temp.res('16a AUTH-3 after choosing their own password the studio is back', public.current_org_id() = 'a0000000-0000-4000-8000-000000000001');
  v := pg_temp.try('select public.clear_password_change_required()');
  perform pg_temp.res('16b AUTH-3 ... and clearing the flag works', v = '' and public.password_change_required() is false, v);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('17 AUTH-3 ordinary members are unaffected', public.current_org_id() = 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('1z', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-01 approvals + close with money owed
do $$ declare v text; cr uuid; begin
  perform pg_temp.su();
  perform pg_temp.ready_event();
  perform pg_temp.member('r32_mgr@a.test', 'manager');
  perform pg_temp.member('r32_mgr2@a.test', 'manager');
  perform pg_temp.access('manager', 'finance', true, true);
  perform pg_temp.access('manager', 'closure', true, true);
  perform pg_temp.access('manager', 'settlement', true, true);
  perform pg_temp.login('a_admin@a.test');
  perform public.record_payment('a0000000-0000-4000-8000-00000000da01', 100000, 'cash', null, null, null, 'r32-k1');
  perform pg_temp.login('r32_mgr@a.test');
  insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'r32 goodwill', -136000) returning id into cr;
  insert into _kv values ('cr', cr::text);
  v := pg_temp.try(format('update public.change_requests set status = %L, decided_at = now() where id = %L', 'approved', cr));
  perform pg_temp.res('18 BIZ-01 the creator cannot approve their own change request', v like '42501%Someone else%', v);
  perform pg_temp.login('r32_mgr2@a.test');
  v := pg_temp.try(format('update public.change_requests set status = %L, decided_at = now() where id = %L', 'approved', cr));
  perform pg_temp.res('19 BIZ-01 a price decrease needs "Approve discounts" (manager with finance edit only -> refused)', v like '42501%lowers the price%', v);
  perform pg_temp.access('manager', 'discount_approve', true, true);
  perform pg_temp.login('r32_mgr2@a.test');
  v := pg_temp.try(format('update public.change_requests set status = %L, decided_at = now() where id = %L', 'approved', cr));
  perform pg_temp.su();
  perform pg_temp.res('20 BIZ-01 with the switch on, another manager approves it - logged in the activity log',
    v = '' and (select status from public.change_requests where id = cr) = 'approved'
    and exists (select 1 from public.audit_log a where a.action = 'change_request_approved' and a.entity_id = cr::text
                  and (a.changed ->> 'price_delta')::numeric = -136000 and a.actor = (select id from auth.users where email = 'r32_mgr2@a.test')), v);
  delete from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'manager' and area = 'discount_approve';
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare v text; cr uuid; begin
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'r32 admin extra', 5000) returning id into cr;
  v := pg_temp.try(format('update public.change_requests set status = %L where id = %L', 'approved', cr));
  perform pg_temp.res('21 BIZ-01 the only admin may approve their own request', v = '', v);
  perform pg_temp.member('r32_admin2@a.test', 'admin');
  perform pg_temp.login('a_admin@a.test');
  insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'r32 admin extra 2', 5000) returning id into cr;
  v := pg_temp.try(format('update public.change_requests set status = %L where id = %L', 'approved', cr));
  perform pg_temp.res('22 BIZ-01 with a second admin, an admin cannot approve their own request', v like '42501%Someone else%', v);
  perform pg_temp.login('r32_admin2@a.test');
  v := pg_temp.try(format('update public.change_requests set status = %L where id = %L', 'approved', cr));
  perform pg_temp.res('23 BIZ-01 the other admin can (any amount, no switch needed)', v = '', v);
  perform pg_temp.su();
  update public.profiles set role = 'sales' where email = 'r32_admin2@a.test';
exception when others then perform pg_temp.su(); insert into _rs values ('2y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare v text; begin
  perform pg_temp.su();
  perform pg_temp.res('24 BIZ-01 the event still owes money (the approved discount aside, 5000 + 5000 extras)',
    (public._a49_close_blockers('a0000000-0000-4000-8000-00000000da01') ->> 'balance_owed')::numeric > 0,
    public._a49_close_blockers('a0000000-0000-4000-8000-00000000da01')::text);
  perform pg_temp.login('r32_mgr@a.test');
  v := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'client pays next week')$q$);
  perform pg_temp.res('25 BIZ-01 manager (closure edit) cannot close with money owed without "Close events with money owed"', v like '42501%Only an admin%', v);
  perform pg_temp.access('manager', 'close_owed', true, true);
  perform pg_temp.login('r32_mgr@a.test');
  v := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true)$q$);
  perform pg_temp.res('26 BIZ-01 even with the switch a written reason is still required', v like 'P0001%', v);
  v := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'client pays next week')$q$);
  perform pg_temp.su();
  perform pg_temp.res('27 BIZ-01 with the switch the manager closes with a reason - override + activity log kept',
    v = '' and (select closed_at is not null from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01')
    and exists (select 1 from public.event_close_overrides o where o.quote_id = 'a0000000-0000-4000-8000-00000000da01'
                  and o.actor = (select id from auth.users where email = 'r32_mgr@a.test'))
    and exists (select 1 from public.audit_log a where a.action = 'close_override' and a.quote_id = 'a0000000-0000-4000-8000-00000000da01'), v);
exception when others then perform pg_temp.su(); insert into _rs values ('2z', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-02 the closed event is frozen
do $$ declare v text; m uuid; begin
  perform pg_temp.su();
  insert into public.event_refunds(quote_id, amount, kind, status, reason, org_id)
    values ('a0000000-0000-4000-8000-00000000da01', 1000, 'refund', 'pending', 'r32', 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"subtotal":300000}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.res('28 BIZ-02 closed: the price cannot change (admin too)', v like '42501%event is closed%', v);
  v := pg_temp.try($q$insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'late', 100)$q$);
  perform pg_temp.res('29 BIZ-02 closed: no new change request', v like '42501%event is closed%', v);
  v := pg_temp.try($q$insert into public.expense_claims(quote_id, who, description, amount) values ('a0000000-0000-4000-8000-00000000da01', 'x', 'y', 500)$q$);
  perform pg_temp.res('30 BIZ-02 closed: no new expense claim', v like '42501%event is closed%', v);
  v := pg_temp.try($q$insert into public.payment_milestones(quote_id, label, amount, seq) values ('a0000000-0000-4000-8000-00000000da01', 'late', 100, 9)$q$);
  perform pg_temp.res('31 BIZ-02 closed: no new payment milestone', v like '42501%event is closed%', v);
  v := pg_temp.try($q$update public.event_refunds set status = 'approved' where quote_id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.res('32 BIZ-02 closed: a refund cannot be approved', v like '42501%event is closed%', v);
  v := pg_temp.try($q$select public.record_payment('a0000000-0000-4000-8000-00000000da01', 100, 'cash', null, null, null, 'r32-late')$q$);
  perform pg_temp.su();
  perform pg_temp.res('33 BIZ-02 a late payment is still recorded on the closed event - and logged',
    v = '' and exists (select 1 from public.quote_payments p where p.quote_id = 'a0000000-0000-4000-8000-00000000da01' and p.idempotency_key = 'r32-late')
    and exists (select 1 from public.audit_log a where a.action = 'payment_after_close' and a.quote_id = 'a0000000-0000-4000-8000-00000000da01'), v);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try($q$select public.reopen_event('a0000000-0000-4000-8000-00000000da01', 'client asked for a correction')$q$);
  perform pg_temp.res('34 BIZ-02 an admin re-opens the event', v = '', v);
  v := pg_temp.try($q$insert into public.expense_claims(quote_id, who, description, amount) values ('a0000000-0000-4000-8000-00000000da01', 'x', 'y', 500)$q$);
  perform pg_temp.res('35 BIZ-02 re-opened: changes work again', v = '', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-04 currency
do $$ declare v text; begin
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"currency":"USD"}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.su();
  perform pg_temp.res('36 BIZ-04 a paid quote''s currency cannot change', v like '42501%currency%' and coalesce((select pricing ->> 'currency' from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01'), 'INR') <> 'USD', v);
  insert into public.quotes(id, org_id, code, title, status, approval_status, pricing)
    select 'a0000000-0000-4000-8000-0000000082a1', org_id, 'R32-CUR', 'r32 currency', 'confirmed', 'approved', pricing - 'currency'
      from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01';
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"currency":"USD"}' where id = 'a0000000-0000-4000-8000-0000000082a1'$q$);
  perform pg_temp.su();
  perform pg_temp.res('37 BIZ-04 an approved (unpaid) quote''s currency change -> the client must approve again',
    v = '' and (select consent_stale and approval_status = 'sent' from public.quotes where id = 'a0000000-0000-4000-8000-0000000082a1')
    and exists (select 1 from public.audit_log a where a.action = 'consent_stale' and a.quote_id = 'a0000000-0000-4000-8000-0000000082a1' and a.changed ->> 'reason' = 'currency'),
    v || ' ' || coalesce((select approval_status || '/' || consent_stale from public.quotes where id = 'a0000000-0000-4000-8000-0000000082a1'), 'no row'));
exception when others then perform pg_temp.su(); insert into _rs values ('3y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-03 plan seat limits
do $$ declare v text; g int; outs text := ''; j jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('38 BIZ-03 helm_plans.seat_limit: starter 3 (owner + 2 invites), studio 15',
    (select seat_limit from public.helm_plans where code = 'starter') = 3 and (select seat_limit from public.helm_plans where code = 'studio') = 15);
  update public.organizations set seat_limit = null where id = 'b0000000-0000-4000-8000-000000000001';
  delete from public.invitations where org_id = 'b0000000-0000-4000-8000-000000000001';
  update public.profiles set role = 'client' where email = 'b_staff@b.test';    -- B: just the owner
  insert into public.studio_subscriptions(org_id, plan_id, status, current_period_end, updated_at)
    select 'b0000000-0000-4000-8000-000000000001', id, 'active', current_date + 30, now() from public.helm_plans where code = 'starter'
  on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active';
  perform pg_temp.login('b_admin@b.test');
  for g in 1..3 loop outs := outs || '|' || pg_temp.try(format('select public.create_invitation(%L, %L)', 'r32m' || g || '@b.test', 'sales')); end loop;
  perform pg_temp.su();
  perform pg_temp.res('39 BIZ-03 paid Starter: 2 invites go out, the 3rd is refused with the plan message',
    outs like '|||42501 Your plan allows 2 team invites. Contact sales to add more.%', outs);
  perform pg_temp.login('b_admin@b.test');
  select public.my_seat_usage() into j;
  perform pg_temp.su();
  perform pg_temp.res('40 BIZ-03 my_seat_usage shows the paid limit (not a trial) at the limit',
    (j ->> 'limit')::int = 3 and (j ->> 'at_limit')::boolean and not (j ->> 'trial')::boolean, j::text);
  -- existing members are never blocked: a studio already over its limit keeps everyone and can still edit them
  -- these three joined BEFORE the studio was on a limited plan (subscription paused while they join)
  update public.studio_subscriptions set status = 'cancelled' where org_id = 'b0000000-0000-4000-8000-000000000001';
  perform pg_temp.member('r32_old1@b.test', 'sales', 'b0000000-0000-4000-8000-000000000001');
  perform pg_temp.member('r32_old2@b.test', 'sales', 'b0000000-0000-4000-8000-000000000001');
  perform pg_temp.member('r32_old3@b.test', 'sales', 'b0000000-0000-4000-8000-000000000001');
  update public.studio_subscriptions set status = 'active' where org_id = 'b0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('b_admin@b.test');
  v := pg_temp.try($q$select public.admin_set_role((select id from public.profiles where email = 'r32_old1@b.test'), 'planner')$q$);
  perform pg_temp.su();
  perform pg_temp.res('41 BIZ-03 over the limit: every existing member stays and an existing member''s role can still change',
    (select count(*) from public.profiles where org_id = 'b0000000-0000-4000-8000-000000000001' and role <> 'client') = 4
    and v = '' and (select role from public.profiles where email = 'r32_old1@b.test') = 'planner', v);
  perform pg_temp.res('42 BIZ-03 a studio with no subscription / plan limit stays unlimited (null)',
    public._trial_seat_limit('a0000000-0000-4000-8000-000000000001') is not distinct from (select seat_limit from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'));
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-06 Helm-owned studio settings
do $$ declare a text; b text; c text; d text; e text; begin
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  a := pg_temp.try($q$update public.organizations set is_sample_master = true where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  b := pg_temp.try($q$update public.organizations set seat_limit = 500 where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  c := pg_temp.try($q$update public.organizations set sample_source_org = 'b0000000-0000-4000-8000-000000000001' where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  d := pg_temp.try($q$update public.organizations set sample_batch_id = gen_random_uuid() where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  e := pg_temp.try($q$update public.organizations set name = name where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.su();
  perform pg_temp.res('43 BIZ-06 is_sample_master / seat_limit / sample_source_org / sample_batch_id refused through the API',
    a like '42501%' and b like '42501%' and c like '42501%' and d like '42501%', a || '|' || b || '|' || c || '|' || d);
  perform pg_temp.res('44 BIZ-06 ordinary studio edits still work', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('4y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= BIZ-05 sample adoption in a locked trial
do $$ declare w uuid; v text; n int; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id and not active;
  w := pg_temp.trial('r32_trial@t.test');
  select count(*) into n from public.quotes where org_id = w and is_demo;
  perform pg_temp.login('r32_trial@t.test');
  v := pg_temp.try(format($q$update public.quotes set title = 'My real wedding ' || code where org_id = %L and is_demo$q$, w));
  perform pg_temp.su();
  perform pg_temp.res('45 BIZ-05 renaming every sample in a locked trial is refused (more than the 2-row limit)',
    n > 2 and v like '42501%Free trial limit%' and (select count(*) from public.quotes where org_id = w and not is_demo) = 0, n || ' ' || v);
  perform pg_temp.login('r32_trial@t.test');
  v := pg_temp.try(format($q$update public.quotes set title = 'Mine ' || code where id in (select id from public.quotes where org_id = %L and is_demo order by id limit 2)$q$, w));
  perform pg_temp.res('46 BIZ-05 adopting 2 samples is fine (they use the 2 slots)', v = '', v);
  v := pg_temp.try($q$select public.create_quote('X1','x1',null,'{"items":[]}'::jsonb,0)$q$);
  perform pg_temp.su();
  perform pg_temp.res('47 BIZ-05 ... and then a new quote is refused (limit reached)', v like '42501%' , v);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare v text; begin
  perform pg_temp.su();
  insert into public.quotes(id, org_id, code, title, status, is_demo)
    values ('a0000000-0000-4000-8000-0000000082b1', 'a0000000-0000-4000-8000-000000000001', 'R32-DEMO', E'Demo \u00b7 sample', 'quote', true);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try($q$update public.quotes set title = 'Our own wedding' where id = 'a0000000-0000-4000-8000-0000000082b1'$q$);
  perform pg_temp.su();
  perform pg_temp.res('48 BIZ-05 a paid studio adopts a sample as before',
    v = '' and (select not is_demo from public.quotes where id = 'a0000000-0000-4000-8000-0000000082b1'), v);
exception when others then perform pg_temp.su(); insert into _rs values ('5y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= privileges / shape
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('49 helpers + trigger functions are not callable through the API',
    not has_function_privilege('authenticated', 'public._r282_tg_cr_approval()', 'execute')
    and not has_function_privilege('authenticated', 'public._r282_tg_closed_freeze()', 'execute')
    and not has_function_privilege('anon', 'public._r282_event_closed(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r282_seats_used(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r282_seat_refuse(uuid, integer, boolean)', 'execute'));
  perform pg_temp.res('50 the re-issued functions keep their signatures and API grants',
    has_function_privilege('authenticated', 'public.verify_task(uuid, boolean, text)', 'execute')
    and has_function_privilege('authenticated', 'public.record_payment(uuid, numeric, text, text, uuid, text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.admin_create_user(text, text, text)', 'execute')
    and (select prorettype = 'public.event_tasks'::regtype from pg_proc where oid = 'public.verify_task(uuid, boolean, text)'::regprocedure));
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R32-SECURITY-0282: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R32-SECURITY-0282: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
