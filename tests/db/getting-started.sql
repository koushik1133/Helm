-- getting-started.sql — 0059: dashboard "Getting started" checklist.
-- Fixture: a_admin/a_staff (studio C), b_admin/b_staff (studio D). One transaction,
-- rolled back at the end. All values are fake test data.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _gs(name text, result text); grant all on _gs to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _gs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run the checklist as a user; returns the jsonb (or {"err": sqlstate})
create or replace function pg_temp.gs(p_email text, p_aal text default 'aal1') returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email, p_aal);
  begin j := public.my_getting_started(); exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j;
end $$;
-- one step's done flag (null when the step is not in the list)
create or replace function pg_temp.done(j jsonb, k text) returns boolean language sql immutable as $$
  select (s ->> 'done')::boolean from jsonb_array_elements(coalesce(j -> 'steps', '[]'::jsonb)) s where s ->> 'key' = k $$;
create or replace function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(s ->> 'key', ',' order by o), '') from jsonb_array_elements(coalesce(j -> 'steps', '[]'::jsonb)) with ordinality t(s, o) $$;
create or replace function pg_temp.dismiss(p_email text, p_on boolean) returns text language plpgsql as $$
begin perform pg_temp.login(p_email, 'aal2');
  begin perform public.my_getting_started_dismiss(p_on); exception when others then perform pg_temp.su(); return sqlstate; end;
  perform pg_temp.su(); return ''; end $$;

-- two brand-new studios (C, D) so nothing from the shared fixture counts
do $$ declare c uuid := 'c0000000-0000-4000-8000-000000000001'; d uuid := 'd0000000-0000-4000-8000-000000000001';
  u1 uuid; u2 uuid; u3 uuid; begin perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (c, 'Studio C', 'INR', 'Asia/Kolkata', '{}', 'pro', now()), (d, 'Studio D', 'INR', 'Asia/Kolkata', '{}', 'pro', now())
    on conflict (id) do nothing;
  u1 := coalesce((select id from auth.users where email = 'gs_admin@c.test'), auth.seed_user('gs_admin@c.test'));
  u2 := coalesce((select id from auth.users where email = 'gs_staff@c.test'), auth.seed_user('gs_staff@c.test'));
  u3 := coalesce((select id from auth.users where email = 'gs_admin@d.test'), auth.seed_user('gs_admin@d.test'));
  -- studio C starts as a one-person studio: gs_staff sits in D until the team check
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values
    (u1, 'gs_admin@c.test', 'admin', c, false, now()), (u2, 'gs_staff@c.test', 'sales', d, false, now()),
    (u3, 'gs_admin@d.test', 'admin', d, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = null;
end $$;

-- ---- privileges ---------------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.res('01 state table RLS on', (select relrowsecurity from pg_class where oid = 'public.getting_started_state'::regclass));
  perform pg_temp.res('02 members cannot read state table', not has_table_privilege('authenticated', 'public.getting_started_state', 'select'));
  perform pg_temp.res('03 anon cannot call checklist', not has_function_privilege('anon', 'public.my_getting_started()', 'execute'));
  perform pg_temp.res('04 anon cannot call dismiss', not has_function_privilege('anon', 'public.my_getting_started_dismiss(boolean)', 'execute'));
  perform pg_temp.su(); perform auth.login_anon();
  begin j := public.my_getting_started(); j := '{}'; exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.res('05 signed-out caller refused', j ->> 'err' = '42501', j::text);
end $$;

-- ---- fresh studio: admin sees 8 steps, nothing done ---------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('06 admin gets all 8 steps in order', pg_temp.keys(j) = 'profile,studio,pricing,lead,floor_plan,quote,team,mfa', pg_temp.keys(j));
  perform pg_temp.res('07 fresh studio: nothing done', not exists (select 1 from jsonb_array_elements(j -> 'steps') s where (s ->> 'done')::boolean), j::text);
  perform pg_temp.res('08 admin flag + not dismissed', (j ->> 'admin')::boolean and not (j ->> 'dismissed')::boolean, j::text);
  perform pg_temp.res('09 mfa step marked optional', exists (select 1 from jsonb_array_elements(j -> 'steps') s where s ->> 'key' = 'mfa' and (s ->> 'optional')::boolean));
  perform pg_temp.res('10 no personal data in answer', j::text !~* '(@|\+91|gs_admin)', j::text);
end $$;

-- ---- each step flips -----------------------------------------------------------------------
do $$ declare j jsonb; a uuid := 'c0000000-0000-4000-8000-000000000001'; me uuid := pg_temp.uid('gs_admin@c.test'); begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.profiles set full_name = 'Test Admin' where id = me;
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('11 profile: name alone is not enough', pg_temp.done(j, 'profile') = false);
  perform pg_temp.su(); set local session_replication_role = replica; insert into public.member_profiles (user_id, phone) values (me, '+919876543210');
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('12 profile done with name + mobile', pg_temp.done(j, 'profile'));

  perform pg_temp.su(); set local session_replication_role = replica; insert into public.studio_account (org_id, legal_business_name, city) values (a, 'Studio C Pvt Ltd', 'Hyderabad');
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('13 studio: missing billing address = not done', pg_temp.done(j, 'studio') = false);
  perform pg_temp.su(); set local session_replication_role = replica; update public.studio_account set billing_address = '1 Test Road' where org_id = a;
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('14 studio done when card filled', pg_temp.done(j, 'studio'));

  perform pg_temp.su(); set local session_replication_role = replica; insert into public.app_config (org_id, key, value, updated_at) values (a, 'pricing', '{"chair":10}', now());
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('15 pricing done after saving prices', pg_temp.done(j, 'pricing'));

  perform pg_temp.su(); set local session_replication_role = replica; insert into public.leads (name, status, org_id) values ('Test lead', 'new', a);
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('16 lead done after first lead', pg_temp.done(j, 'lead'));

  perform pg_temp.su(); set local session_replication_role = replica; insert into public.layouts (name, data, org_id) values ('Hall', '{}', a);
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('17 floor plan done after first layout', pg_temp.done(j, 'floor_plan'));

  perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.quotes (id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values ('c0000000-0000-4000-8000-00000000ee01', 'C-GS1', 'Draft', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', a, now(), now());
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('18 quote: a draft is not sent', pg_temp.done(j, 'quote') = false);
  perform pg_temp.su(); set local session_replication_role = replica; update public.quotes set approval_status = 'sent' where id = 'c0000000-0000-4000-8000-00000000ee01';
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('19 quote done once sent', pg_temp.done(j, 'quote'));

  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('20 team: alone = not done', pg_temp.done(j, 'team') = false);
  perform pg_temp.su(); set local session_replication_role = replica; insert into public.invitations (org_id, email, role, token, status, invited_by, expires_at)
    values (a, 'new@c.test', 'sales', 'gs-test-token-1', 'pending', me, now() + interval '7 days');
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('21 team done after an invitation', pg_temp.done(j, 'team'));
  perform pg_temp.su(); set local session_replication_role = replica; delete from public.invitations where org_id = a;
  update public.profiles set org_id = a where email = 'gs_staff@c.test';
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('22 team done when a teammate joined', pg_temp.done(j, 'team'));

  perform pg_temp.su(); set local session_replication_role = replica; insert into auth.mfa_factors (id, user_id, factor_type, status) values (gen_random_uuid(), me, 'totp', 'unverified');
  j := pg_temp.gs('gs_admin@c.test');
  perform pg_temp.res('23 mfa: unverified factor = not done', pg_temp.done(j, 'mfa') = false);
  perform pg_temp.su(); set local session_replication_role = replica; update auth.mfa_factors set status = 'verified' where user_id = me;
  j := pg_temp.gs('gs_admin@c.test', 'aal2');
  perform pg_temp.res('24 mfa done once verified', pg_temp.done(j, 'mfa'));
  perform pg_temp.res('25 all 8 done', not exists (select 1 from jsonb_array_elements(j -> 'steps') s where not (s ->> 'done')::boolean), j::text);
end $$;

-- ---- Org A / Org B isolation -------------------------------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.gs('gs_admin@d.test');
  perform pg_temp.res('26 studio D sees none of C''s progress',
    pg_temp.done(j, 'studio') = false and pg_temp.done(j, 'pricing') = false and pg_temp.done(j, 'lead') = false
    and pg_temp.done(j, 'floor_plan') = false and pg_temp.done(j, 'quote') = false and pg_temp.done(j, 'profile') = false
    and pg_temp.done(j, 'mfa') = false, j::text);
  perform pg_temp.su(); set local session_replication_role = replica; insert into public.leads (name, status, org_id) values ('D lead', 'new', 'd0000000-0000-4000-8000-000000000001');
  j := pg_temp.gs('gs_admin@d.test');
  perform pg_temp.res('27 studio D lead flips only D', pg_temp.done(j, 'lead'));
  perform pg_temp.su(); set local session_replication_role = replica; delete from public.leads where org_id = 'c0000000-0000-4000-8000-000000000001';
  j := pg_temp.gs('gs_admin@c.test', 'aal2');
  perform pg_temp.res('28 B''s lead does not count for C', pg_temp.done(j, 'lead') = false, j::text);
end $$;

-- ---- role-appropriate list ---------------------------------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.gs('gs_staff@c.test');
  perform pg_temp.res('29 member without access: profile + mfa only', pg_temp.keys(j) = 'profile,mfa' and not (j ->> 'admin')::boolean, pg_temp.keys(j));
  perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.role_access (role, area, can_view, can_edit, org_id, updated_at)
    values ('sales', 'leads', true, true, 'c0000000-0000-4000-8000-000000000001', now()),
           ('sales', 'quotes', true, true, 'c0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  j := pg_temp.gs('gs_staff@c.test');
  perform pg_temp.res('30 sales with leads+quotes edit: 4 steps', pg_temp.keys(j) = 'profile,lead,quote,mfa', pg_temp.keys(j));
  perform pg_temp.res('31 member never sees studio/pricing/team', pg_temp.done(j, 'studio') is null and pg_temp.done(j, 'pricing') is null and pg_temp.done(j, 'team') is null);
  perform pg_temp.res('32 member sees studio-wide quote progress', pg_temp.done(j, 'quote'));
end $$;

-- ---- dismissal is per user ---------------------------------------------------------------
do $$ declare j jsonb; s text; n int; begin
  s := pg_temp.dismiss('gs_admin@c.test', true);
  j := pg_temp.gs('gs_admin@c.test', 'aal2');
  perform pg_temp.res('33 dismiss is stored', s = '' and (j ->> 'dismissed')::boolean, s || j::text);
  j := pg_temp.gs('gs_staff@c.test');
  perform pg_temp.res('34 teammate still sees the checklist', not (j ->> 'dismissed')::boolean);
  j := pg_temp.gs('gs_admin@d.test');
  perform pg_temp.res('35 other studio unaffected', not (j ->> 'dismissed')::boolean);
  s := pg_temp.dismiss('gs_admin@c.test', false);
  j := pg_temp.gs('gs_admin@c.test', 'aal2');
  perform pg_temp.res('36 bring back clears it', not (j ->> 'dismissed')::boolean);
  perform pg_temp.su(); select count(*) into n from public.getting_started_state where user_id = pg_temp.uid('gs_admin@c.test');
  perform pg_temp.res('37 one row per user (no duplicates, nothing deleted)', n = 1, n::text);
  perform pg_temp.login('gs_staff@c.test');
  begin perform count(*) from public.getting_started_state; s := 'read'; exception when others then s := sqlstate; end;
  perform pg_temp.res('38 member cannot read the state table directly', s = '42501', s);
  perform pg_temp.su(); perform auth.login_anon();
  begin perform public.my_getting_started_dismiss(true); s := 'ok'; exception when others then s := sqlstate; end;
  perform pg_temp.res('39 signed-out dismiss refused', s = '42501', s);
  -- enrolled member at aal1 has no studio (0043) → refused, nothing leaks
  j := pg_temp.gs('gs_admin@c.test', 'aal1');
  perform pg_temp.res('40 enrolled admin at aal1 refused', j ->> 'err' = '42501', j::text);
end $$;

select name, result from _gs order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 40 then 'GETTING-STARTED: ALL PASS (40/40)'
            else 'GETTING-STARTED: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/40 ran' end from _gs;
rollback;
