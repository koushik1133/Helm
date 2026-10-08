-- studio-search.sql - 0061: universal studio search RPC studio_search(p_q, p_limit).
-- Fixture: Studio A (a_admin admin, a_staff sales) and Studio B (b_admin, b_staff).
-- One transaction, rolled back at the end. All values are fake test data.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ss(name text, result text); grant all on _ss to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _ss values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run a search as a user; returns the jsonb (or {"err": sqlstate})
create or replace function pg_temp.s(p_email text, p_q text, p_lim int default null, p_aal text default 'aal1') returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email, p_aal);
  begin
    if p_lim is null then j := public.studio_search(p_q); else j := public.studio_search(p_q, p_lim); end if;
  exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j;
end $$;
create or replace function pg_temp.keys(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(coalesce(j, '{}'::jsonb)) k $$;
create or replace function pg_temp.n(j jsonb, k text) returns int language sql immutable as $$
  select coalesce(jsonb_array_length(j -> k), -1) $$;
create or replace function pg_temp.titles(j jsonb, k text) returns text language sql immutable as $$
  select coalesce(string_agg(e ->> 'title', '|' order by o), '') from jsonb_array_elements(coalesce(j -> k, '[]'::jsonb)) with ordinality t(e, o) $$;
-- set one studio's matrix row for a role (test data only)
create or replace function pg_temp.grant_area(p_org uuid, p_role text, p_area text, p_view boolean) returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values (p_role, p_area, p_view, false, p_org, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = false;
end $$;

-- ---- test data: the same names in both studios ----------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01'; c uuid; m uuid; i int;
begin perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.leads (name, status, event_type, phone, email, org_id) values
    ('Ravi Kumar', 'new', 'Wedding', '+919999900001', 'ravi@a.test', a), ('Ravi Kumar B', 'new', 'Wedding', null, null, b),
    ('50% off_promo', 'new', null, null, null, a), ('ofXpromo 5X', 'new', null, null, null, a), ('back\slash lead', 'new', null, null, null, a);
  for i in 1..12 loop insert into public.leads (name, status, org_id) values ('Bulk lead ' || i, 'new', a); end loop;
  insert into public.crew_members (name, phone, role, department, org_id) values ('Ravi Crew', '+919999900002', 'Decorator', 'Decor', a), ('Ravi Crew B', '+919999900003', 'Decorator', 'Decor', b);
  insert into public.crew_members (name, phone, active, org_id) values ('Ravi Gone', '+919999900004', false, a);
  insert into public.vendors (name, category, phone, org_id) values ('Ravi Tents', 'Tents', '+919999900005', a), ('Ravi Tents B', 'Tents', null, b);
  insert into public.vendors (name, category, active, org_id) values ('Ravi Closed Vendor', 'Tents', false, a);
  insert into public.inventory_items (name, category, total_qty, unit, org_id) values ('Ravi chairs', 'Seating', 120, 'pcs', a), ('Ravi chairs B', 'Seating', 5, 'pcs', b);
  insert into public.quote_payments (quote_id, amount, status, receipt_no, org_id) values (qa, 5000, 'paid', 'RCPT-RAVI-A1', a), (qb, 7000, 'paid', 'RCPT-RAVI-B1', b);
  update public.profiles set full_name = 'Ravi Admin' where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Ravi Admin B' where email = 'b_admin@b.test';
  c := coalesce((select id from auth.users where email = 'ss_client@a.test'), auth.seed_user('ss_client@a.test'));
  m := coalesce((select id from auth.users where email = 'ss_mfa@a.test'), auth.seed_user('ss_mfa@a.test'));
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at) values
    (c, 'ss_client@a.test', 'client', a, 'Ravi Client', false, now()), (m, 'ss_mfa@a.test', 'admin', a, 'Mfa Admin', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into auth.mfa_factors (id, user_id, status, factor_type, created_at, updated_at)
    values (gen_random_uuid(), m, 'verified', 'totp', now(), now());
end $$;

-- ---- privileges / refusals -------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.res('01 anon cannot execute', not has_function_privilege('anon', 'public.studio_search(text,integer)', 'execute'));
  perform pg_temp.res('02 members can execute', has_function_privilege('authenticated', 'public.studio_search(text,integer)', 'execute'));
  perform pg_temp.res('03 security definer + empty search_path', (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.studio_search(text,integer)'::regprocedure));
  perform pg_temp.res('04 function is read-only (stable)', (select provolatile = 's' from pg_proc where oid = 'public.studio_search(text,integer)'::regprocedure));
  perform pg_temp.su(); perform auth.login_anon();
  begin j := public.studio_search('ravi'); j := '{}'; exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.res('05 signed-out caller refused', j ->> 'err' = '42501', coalesce(j::text, 'null'));
  perform pg_temp.su();
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false); perform set_config('role', 'authenticated', false);
  begin j := public.studio_search('ravi'); j := '{}'; exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.res('06 token without a user refused', j ->> 'err' = '42501', coalesce(j::text, 'null'));
  j := pg_temp.s('ss_client@a.test', 'ravi');
  perform pg_temp.res('07 client role refused', j ->> 'err' = '42501', j::text);
  j := pg_temp.s('ss_mfa@a.test', 'ravi', null, 'aal1');
  perform pg_temp.res('08 two-step pending (aal1 with factor) refused', j ->> 'err' = '42501', j::text);
  j := pg_temp.s('ss_mfa@a.test', 'ravi', null, 'aal2');
  perform pg_temp.res('09 same member at aal2 can search', j ? 'leads' and not (j ? 'err'), j::text);
end $$;

-- ---- studio isolation -------------------------------------------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.s('a_admin@a.test', 'ravi');
  perform pg_temp.res('10 admin sees every kind', pg_temp.keys(j) = 'events,inventory,leads,payments,staff,team,vendors', pg_temp.keys(j));
  perform pg_temp.res('11 no studio B rows in studio A answer', j::text !~ '( B"|RCPT-RAVI-B1|b0000000)', j::text);
  perform pg_temp.res('12 studio A lead found', pg_temp.titles(j, 'leads') = 'Ravi Kumar', pg_temp.titles(j, 'leads'));
  perform pg_temp.res('13 staff: active crew only', pg_temp.titles(j, 'staff') = 'Ravi Crew', pg_temp.titles(j, 'staff'));
  perform pg_temp.res('14 vendors: active only', pg_temp.titles(j, 'vendors') = 'Ravi Tents', pg_temp.titles(j, 'vendors'));
  perform pg_temp.res('15 inventory found', pg_temp.titles(j, 'inventory') = 'Ravi chairs', pg_temp.titles(j, 'inventory'));
  perform pg_temp.res('16 payment by receipt, own studio', pg_temp.titles(j, 'payments') = 'RCPT-RAVI-A1', pg_temp.titles(j, 'payments'));
  perform pg_temp.res('17 team: members only, never clients', pg_temp.titles(j, 'team') = 'Ravi Admin', pg_temp.titles(j, 'team'));
  perform pg_temp.res('18 no phone / e-mail in answer', j::text !~ '(@|\+91)', j::text);
  perform pg_temp.res('19 every item has id/title/subtitle/link', not exists (
    select 1 from jsonb_each(j) g, jsonb_array_elements(g.value) e
     where not (e ? 'id' and e ? 'title' and e ? 'subtitle' and e ? 'link')));
  j := pg_temp.s('a_admin@a.test', 'wedding');
  perform pg_temp.res('20 event link points at the event hub', (j -> 'events' -> 0 ->> 'link') = 'event.html?id=a0000000-0000-4000-8000-00000000da01', j -> 'events' ->> 0);
  j := pg_temp.s('a_admin@a.test', 'B-0001');
  perform pg_temp.res('21 other studio event code not found', pg_temp.n(j, 'events') = 0, j::text);
  j := pg_temp.s('a_admin@a.test', 'RCPT-RAVI-B');
  perform pg_temp.res('22 other studio receipt not found', pg_temp.n(j, 'payments') = 0, j::text);
  j := pg_temp.s('b_admin@b.test', 'ravi');
  perform pg_temp.res('23 studio B sees only its own lead', pg_temp.titles(j, 'leads') = 'Ravi Kumar B', pg_temp.titles(j, 'leads'));
  perform pg_temp.res('24 studio B: no studio A rows', j::text !~ '(RCPT-RAVI-A1|a0000000|"Ravi Crew"|"Ravi chairs")', j::text);
  j := pg_temp.s('a_admin@a.test', '+91999990');
  perform pg_temp.res('25 phone numbers are not searchable', pg_temp.n(j, 'leads') = 0 and pg_temp.n(j, 'staff') = 0 and pg_temp.n(j, 'vendors') = 0, j::text);
  j := pg_temp.s('a_admin@a.test', 'ravi@a');
  perform pg_temp.res('26 e-mail addresses are not searchable', pg_temp.n(j, 'leads') = 0, j::text);
end $$;

-- ---- role matrix is the authority -------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; j jsonb; ar text; begin
  foreach ar in array array['leads','quotes','staff','users','vendors','inventory','finance'] loop
    perform pg_temp.grant_area(a, 'sales', ar, false);
    perform pg_temp.grant_area(b, 'sales', ar, true);   -- studio B's matrix must not leak into A
  end loop;
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('27 no viewable area: empty answer, no error', j = '{}'::jsonb, j::text);
  perform pg_temp.grant_area(a, 'sales', 'inventory', true);
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('28 inventory only', pg_temp.keys(j) = 'inventory', pg_temp.keys(j));
  perform pg_temp.grant_area(a, 'sales', 'vendors', true); perform pg_temp.grant_area(a, 'sales', 'staff', true);
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('29 inventory + vendors + staff', pg_temp.keys(j) = 'inventory,staff,vendors', pg_temp.keys(j));
  perform pg_temp.grant_area(a, 'sales', 'leads', true); perform pg_temp.grant_area(a, 'sales', 'quotes', true);
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('30 leads + events added, no payments/team', pg_temp.keys(j) = 'events,inventory,leads,staff,vendors', pg_temp.keys(j));
  perform pg_temp.grant_area(a, 'sales', 'finance', true);
  j := pg_temp.s('a_staff@a.test', 'rcpt');
  perform pg_temp.res('31 finance view adds payments', pg_temp.titles(j, 'payments') = 'RCPT-RAVI-A1', j::text);
  perform pg_temp.grant_area(a, 'sales', 'users', true);
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('32 users view adds team', pg_temp.titles(j, 'team') = 'Ravi Admin', j::text);
  perform pg_temp.grant_area(a, 'sales', 'leads', false);
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('33 revoking leads removes it at once', not (j ? 'leads'), pg_temp.keys(j));
  perform pg_temp.su(); set local session_replication_role = replica;
  delete from public.role_access where org_id = a and role = 'sales';
  j := pg_temp.s('a_staff@a.test', 'ravi');
  perform pg_temp.res('34 no matrix rows at all: nothing', j = '{}'::jsonb, j::text);
end $$;

-- ---- input rules: length, wildcards, limits -------------------------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.s('a_admin@a.test', 'r');
  perform pg_temp.res('35 one character: empty answer', j = '{}'::jsonb, j::text);
  j := pg_temp.s('a_admin@a.test', '   r   ');
  perform pg_temp.res('36 spaces do not count', j = '{}'::jsonb, j::text);
  j := pg_temp.s('a_admin@a.test', null);
  perform pg_temp.res('37 null query: empty answer', j = '{}'::jsonb, coalesce(j::text, 'null'));
  j := pg_temp.s('a_admin@a.test', repeat('x', 5000));
  perform pg_temp.res('38 very long query is cut, not an error', not (j ? 'err') and pg_temp.n(j, 'leads') = 0, left(j::text, 200));
  j := pg_temp.s('a_admin@a.test', 'Ravi Kumar' || repeat(' ', 100) || 'zzz');
  perform pg_temp.res('39 cut happens at 80 chars after trimming', not (j ? 'err'), left(j::text, 200));
  j := pg_temp.s('a_admin@a.test', '%%');
  perform pg_temp.res('40 %% is literal (no match-all)', pg_temp.n(j, 'leads') = 0 and pg_temp.n(j, 'events') = 0, j::text);
  j := pg_temp.s('a_admin@a.test', '0%');
  perform pg_temp.res('41 literal % finds "50% off_promo"', pg_temp.titles(j, 'leads') = '50% off_promo', j::text);
  j := pg_temp.s('a_admin@a.test', 'f_p');
  perform pg_temp.res('42 literal _ (no single-char wildcard)', pg_temp.titles(j, 'leads') = '50% off_promo', j::text);
  j := pg_temp.s('a_admin@a.test', '__');
  perform pg_temp.res('43 __ matches nothing', pg_temp.n(j, 'leads') = 0 and pg_temp.n(j, 'staff') = 0, j::text);
  j := pg_temp.s('a_admin@a.test', 'k\s');
  perform pg_temp.res('44 backslash matched literally', pg_temp.titles(j, 'leads') = 'back\slash lead', j::text);
  j := pg_temp.s('a_admin@a.test', 'bulk');
  perform pg_temp.res('45 default limit 5 per kind', pg_temp.n(j, 'leads') = 5, j::text);
  j := pg_temp.s('a_admin@a.test', 'bulk', 3);
  perform pg_temp.res('46 p_limit 3', pg_temp.n(j, 'leads') = 3, j::text);
  j := pg_temp.s('a_admin@a.test', 'bulk', 500);
  perform pg_temp.res('47 p_limit capped at 10', pg_temp.n(j, 'leads') = 10, j::text);
  j := pg_temp.s('a_admin@a.test', 'bulk', -4);
  perform pg_temp.res('48 p_limit floor 1', pg_temp.n(j, 'leads') = 1, j::text);
  j := pg_temp.s('a_admin@a.test', 'RAVI');
  perform pg_temp.res('49 case-insensitive', pg_temp.titles(j, 'leads') = 'Ravi Kumar', j::text);
  j := pg_temp.s('a_admin@a.test', 'decor');
  perform pg_temp.res('50 staff found by role/department', pg_temp.titles(j, 'staff') = 'Ravi Crew', j::text);
  j := pg_temp.s('a_admin@a.test', 'alice');
  perform pg_temp.res('51 event found by client name', pg_temp.n(j, 'events') = 1, j::text);
end $$;

-- ---- nothing was written ------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('52 no table owned by 0061', not exists (select 1 from pg_class where relname like 'studio_search%'));
end $$;

select name, result from _ss order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then format('STUDIO-SEARCH: ALL PASS (%s/%s)', count(*), count(*))
            else format('STUDIO-SEARCH: %s FAILED', count(*) filter (where result <> 'PASS')) end as summary
  from _ss;
rollback;
