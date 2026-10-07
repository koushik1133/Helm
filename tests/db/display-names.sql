-- display-names.sql — 0034 display names (set_my_display_name / admin_set_display_name /
-- chat_directory). A studio admin may name members of their OWN studio only; a
-- non-admin, another studio's admin and a signed-out caller are refused; bad names
-- (empty, > 80 chars, < or >, control characters) are refused; chat_directory lists
-- only the caller's studio. Fixture: a_admin/a_staff (studio A), b_admin/b_staff (B).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _dn; create temp table _dn(name text, result text); grant all on _dn to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
-- read helpers run as the superuser so RLS never hides the row being checked
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.fname(p_email text) returns text language sql security definer as $$ select full_name from public.profiles where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _dn values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- run SQL as the current caller; returns the SQLSTATE it raised ('' = succeeded)
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated;
grant execute on function pg_temp.uid(text) to anon, authenticated;
grant execute on function pg_temp.fname(text) to anon, authenticated;

-- ---- setup (superuser) ---------------------------------------------------------------
do $$ begin perform pg_temp.su();
  update public.profiles set full_name = null where email in ('a_admin@a.test','a_staff@a.test','b_admin@b.test','b_staff@b.test');
  update public.profiles set full_name = 'Bea Original' where email = 'b_staff@b.test';
  delete from public.audit_log where action = 'profile.display_name';
end $$;

-- ---- admin: own studio OK ----------------------------------------------------------
do $$ declare s text; r text; begin
  perform pg_temp.login('a_admin@a.test');
  begin r := public.admin_set_display_name(pg_temp.uid('a_staff@a.test'), '  Ananya    Rao  '); s := ''; exception when others then s := sqlstate; end;
  perform pg_temp.res('01 admin names a member of their own studio', s = '' and r = 'Ananya Rao' and pg_temp.fname('a_staff@a.test') = 'Ananya Rao', s||' '||coalesce(r,'∅'));
  perform pg_temp.su();
  perform pg_temp.res('02 the change is audit-logged (actor, org, old/new)',
    exists (select 1 from public.audit_log where action = 'profile.display_name' and entity_id = pg_temp.uid('a_staff@a.test')::text
              and actor = pg_temp.uid('a_admin@a.test') and org_id = 'a0000000-0000-4000-8000-000000000001'
              and changed -> 'full_name' ->> 'new' = 'Ananya Rao'), 'no audit row');
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_admin@a.test'), 'Asha Admin')$q$);
  perform pg_temp.res('03 admin can name themselves through the admin RPC', s = '' and pg_temp.fname('a_admin@a.test') = 'Asha Admin', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_staff@a.test'), repeat('x', 80))$q$);
  perform pg_temp.res('04 exactly 80 characters is accepted', s = '' and char_length(pg_temp.fname('a_staff@a.test')) = 80, s);
end $$;

-- ---- refused: other studio / non-admin / anon -----------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('b_staff@b.test'), 'Hijacked')$q$);
  perform pg_temp.res('05 admin naming ANOTHER studio''s user is refused (42501)', s = '42501' and pg_temp.fname('b_staff@b.test') = 'Bea Original', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(gen_random_uuid(), 'Ghost')$q$);
  perform pg_temp.res('06 admin naming an unknown user id is refused (42501)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_admin@a.test'), 'Pwned')$q$);
  perform pg_temp.res('07 non-admin using the admin RPC is refused (42501)', s = '42501' and pg_temp.fname('a_admin@a.test') = 'Asha Admin', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_staff@a.test'), 'Cross')$q$);
  perform pg_temp.res('08 studio B admin naming a studio A user is refused (42501)', s = '42501' and char_length(pg_temp.fname('a_staff@a.test')) = 80, s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_staff@a.test'), 'Anon')$q$);
  perform pg_temp.res('09 signed-out caller is refused the admin RPC', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.set_my_display_name('Anon')$q$);
  perform pg_temp.res('10 signed-out caller is refused the self RPC', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select count(*) from public.chat_directory()$q$);
  perform pg_temp.res('11 signed-out caller is refused chat_directory', s = '42501', s);
end $$;

-- ---- bad names -------------------------------------------------------------------------
do $$ declare s text; bad text; i int := 0; begin
  foreach bad in array array['', '    ', repeat('y', 81), '<b>Boss</b>', 'a > b', 'Ana'||chr(7)||'Rao', 'x<script>'] loop
    i := i + 1;
    perform pg_temp.login('a_admin@a.test');
    s := pg_temp.try(format('select public.admin_set_display_name(pg_temp.uid(%L), %L)', 'a_staff@a.test', bad));
    perform pg_temp.res('12.'||i||' admin RPC refuses bad name #'||i, s = '22023' and char_length(pg_temp.fname('a_staff@a.test')) = 80, s);
    perform pg_temp.login('a_staff@a.test');
    s := pg_temp.try(format('select public.set_my_display_name(%L)', bad));
    perform pg_temp.res('13.'||i||' self RPC refuses bad name #'||i, s = '22023' and char_length(pg_temp.fname('a_staff@a.test')) = 80, s);
  end loop;
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_display_name(pg_temp.uid('a_staff@a.test'), null)$q$);
  perform pg_temp.res('14 a null name is refused (22023)', s = '22023', s);
end $$;

-- ---- self ------------------------------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.set_my_display_name('Ananya R.')$q$);
  perform pg_temp.res('15 a member names themselves', s = '' and pg_temp.fname('a_staff@a.test') = 'Ananya R.', s);
  perform pg_temp.su();
  perform pg_temp.res('16 self change is audit-logged', exists (select 1 from public.audit_log where action = 'profile.display_name'
     and actor = pg_temp.uid('a_staff@a.test') and entity_id = pg_temp.uid('a_staff@a.test')::text and changed ->> 'by' = 'self'), 'no audit row');
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$update public.profiles set full_name = 'Direct' where id = auth.uid()$q$);
  perform pg_temp.res('17 a direct UPDATE on profiles is still refused', s <> '' and pg_temp.fname('a_staff@a.test') = 'Ananya R.', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public._clean_display_name('x')$q$);
  perform pg_temp.res('18 the internal validator is not callable by API roles', s = '42501', s);
  perform pg_temp.res('19 role / studio untouched by the name RPCs',
    (select role from public.profiles where email = 'a_staff@a.test') = 'sales'
    and (select org_id from public.profiles where email = 'a_staff@a.test') = 'a0000000-0000-4000-8000-000000000001', 'changed');
end $$;

-- ---- chat_directory ----------------------------------------------------------------------
do $$ declare n int; nb int; nm text; en text; begin
  perform pg_temp.login('a_staff@a.test');   -- a 'sales' member: profiles RLS hides colleagues, the directory does not
  select count(*), count(*) filter (where id in (pg_temp.uid('b_admin@b.test'), pg_temp.uid('b_staff@b.test')))
    into n, nb from public.chat_directory();
  select full_name, email_name into nm, en from public.chat_directory() where id = pg_temp.uid('a_admin@a.test');
  perform pg_temp.res('20 chat_directory lists my studio (names + e-mail local part), never another studio',
    n >= 2 and nb = 0 and nm = 'Asha Admin' and en = 'a_admin', n||'/'||nb||'/'||coalesce(nm,'∅')||'/'||coalesce(en,'∅'));
  perform pg_temp.login('b_admin@b.test');
  select count(*) filter (where id in (pg_temp.uid('a_admin@a.test'), pg_temp.uid('a_staff@a.test'))) into nb from public.chat_directory();
  perform pg_temp.res('21 studio B sees no studio A people', nb = 0, nb::text);
end $$;

-- ---- grants ------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.res('22 grants: anon has no EXECUTE, authenticated has EXECUTE on the 3 RPCs',
    not has_function_privilege('anon', 'public.admin_set_display_name(uuid,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.set_my_display_name(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.chat_directory()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.admin_set_display_name(uuid,text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.set_my_display_name(text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.chat_directory()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._clean_display_name(text)', 'EXECUTE'), 'grant drift');
end $$;

-- ---- HQ operators can't create a studio (server backstop) ------------------------------
do $$ declare m text := ''; v_org uuid; begin perform pg_temp.su();
  select org_id into v_org from public.profiles where email = 'b_staff@b.test';
  update public.profiles set org_id = null where email = 'b_staff@b.test';   -- operators have no studio
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where email = 'b_staff@b.test';
  insert into public.platform_admins(email, added_by) values ('b_staff@b.test', 'test') on conflict do nothing;
  perform pg_temp.login('b_staff@b.test');
  begin perform public.create_studio('Operator Studio', null, 'INR', 'Asia/Kolkata'); exception when others then m := sqlerrm; end;
  perform pg_temp.res('35 HQ operator cannot create a studio', m like '%HQ accounts%', coalesce(nullif(m,''),'(created!)'));
  perform pg_temp.su(); delete from public.platform_admins where email = 'b_staff@b.test';
  update public.profiles set org_id = v_org where email = 'b_staff@b.test';
  begin
    insert into public.organizations(name, slug) values ('Owner seeded', 'owner-seeded-x1');
    m := 'ok';
  exception when others then m := sqlerrm; end;
  perform pg_temp.res('36 owner/service scripts (no signed-in user) can still create a studio', m = 'ok', m);
  delete from public.organizations where slug = 'owner-seeded-x1';
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  update public.profiles set full_name = null where email in ('a_admin@a.test','a_staff@a.test','b_admin@b.test','b_staff@b.test');
  delete from public.audit_log where action = 'profile.display_name';
end $$;
select name, result from _dn order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 36 then 'DISPLAY-NAMES: ALL PASS (36/36)'
            else 'DISPLAY-NAMES: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/36 ran' end from _dn;
