-- ui-fixes.sql -- 0075: start_blank_quote reuse (L8) + booklet studio e-mail only when an admin
-- saved it (#16). Fixture: a_admin/a_staff studio A, b_admin studio B, quoteA. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- fixture: a no-quotes-edit member in studio A
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'uf_viewer@a.test'), auth.seed_user('uf_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'uf_viewer@a.test', 'Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'quotes', true, false, a, now());
  delete from public.auth_rate_hits where bucket like 'booklet.%';
  -- blank quotes left by earlier suites on this database would be (correctly) reused; park them
  -- (inside this rolled-back transaction) so the counts below start clean
  update public.quotes set archived_at = now() where archived_at is null and id <> 'a0000000-0000-4000-8000-00000000da01';
end $$;

-- ---- L8: start_blank_quote ---------------------------------------------------------------
do $$ declare q1 public.quotes; q2 public.quotes; q3 public.quotes; q4 public.quotes; e text; n0 int; n1 int; begin
  perform pg_temp.su();
  perform pg_temp.res('01 start_blank_quote security definer + search_path empty',
    (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.start_blank_quote(text,text)'::regprocedure));
  perform pg_temp.res('02 anon cannot execute, authenticated can',
    not has_function_privilege('anon', 'public.start_blank_quote(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.start_blank_quote(text,text)', 'execute'));
  perform pg_temp.res('03 advisory lock in body', (select prosrc like '%pg_advisory_xact_lock%helm:blankq:%' from pg_proc where oid = 'public.start_blank_quote(text,text)'::regprocedure));

  perform pg_temp.login('a_admin@a.test');
  select count(*) into n0 from public.quotes;
  q1 := public.start_blank_quote('X-1', null);
  q2 := public.start_blank_quote('X-2', null);
  select count(*) into n1 from public.quotes;
  perform pg_temp.res('04 first click creates, second click reuses the same blank quote', q1.id is not null and q2.id = q1.id and n1 = n0 + 1, n0||'->'||n1);
  perform pg_temp.put('q1', q1.id::text);

  -- another user in the same studio gets their OWN blank quote, never mine
  perform pg_temp.login('a_staff@a.test');
  q3 := public.start_blank_quote('X-3', null);
  perform pg_temp.res('05 another user never receives my blank quote', q3.id is not null and q3.id <> q1.id, coalesce(q3.id::text, 'null'));
  perform pg_temp.put('q3', q3.id::text);

  -- touching the quote (client name) makes it ineligible -> a new one is created
  perform pg_temp.su();
  update public.quotes set client = jsonb_build_object('name', 'Alice') where id = pg_temp.get('q1')::uuid;
  perform pg_temp.login('a_admin@a.test');
  q4 := public.start_blank_quote('X-4', null);
  perform pg_temp.res('06 a quote with a client name is not reused', q4.id <> pg_temp.get('q1')::uuid, q4.id::text);
  perform pg_temp.put('q4', q4.id::text);

  -- event date / items / payments / archived / deleted / old each make it ineligible
  perform pg_temp.su();
  update public.quotes set event_date = current_date + 30 where id = pg_temp.get('q4')::uuid;
  perform pg_temp.login('a_admin@a.test');
  q1 := public.start_blank_quote('X-5', null);
  perform pg_temp.res('07 a quote with an event date is not reused', q1.id <> pg_temp.get('q4')::uuid);
  perform pg_temp.put('q5', q1.id::text);
  perform pg_temp.su();
  update public.quote_versions set data = '{"items":[{"id":"i1","type":"stage"}]}'::jsonb, object_count = 1 where quote_id = pg_temp.get('q5')::uuid;
  perform pg_temp.login('a_admin@a.test');
  q2 := public.start_blank_quote('X-6', null);
  perform pg_temp.res('08 a quote with layout items is not reused', q2.id <> pg_temp.get('q5')::uuid);
  perform pg_temp.put('q6', q2.id::text);
  perform pg_temp.su();
  insert into public.payment_milestones(quote_id, label, due_date, amount, status, seq, org_id)
    values (pg_temp.get('q6')::uuid, 'Advance', current_date + 5, 100, 'due', 1, 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  q3 := public.start_blank_quote('X-7', null);
  perform pg_temp.res('09 a quote with a payment milestone is not reused', q3.id <> pg_temp.get('q6')::uuid);
  perform pg_temp.put('q7', q3.id::text);
  perform pg_temp.su();
  update public.quotes set archived_at = now() where id = pg_temp.get('q7')::uuid;
  perform pg_temp.login('a_admin@a.test');
  q4 := public.start_blank_quote('X-8', null);
  perform pg_temp.res('10 an archived quote is not reused', q4.id <> pg_temp.get('q7')::uuid);
  perform pg_temp.put('q8', q4.id::text);
  perform pg_temp.su();
  update public.quotes set created_at = now() - interval '8 days' where id = pg_temp.get('q8')::uuid;
  perform pg_temp.login('a_admin@a.test');
  q1 := public.start_blank_quote('X-9', null);
  perform pg_temp.res('11 a blank quote older than 7 days is not reused', q1.id <> pg_temp.get('q8')::uuid);
  q2 := public.start_blank_quote('X-10', null);
  perform pg_temp.res('12 ...and the fresh one is reused next time', q2.id = q1.id);

  -- nothing was deleted along the way
  perform pg_temp.su();
  perform pg_temp.res('13 no quote was deleted', (select count(*) from public.quotes where id in (pg_temp.get('q1')::uuid, pg_temp.get('q3')::uuid,
      pg_temp.get('q4')::uuid, pg_temp.get('q5')::uuid, pg_temp.get('q6')::uuid, pg_temp.get('q7')::uuid, pg_temp.get('q8')::uuid) and deleted_at is null) = 7);

  -- gates: no quotes-edit -> refused (F10); signed out -> refused; other studio never sees A's quote
  perform pg_temp.login('uf_viewer@a.test');
  e := pg_temp.try($q$select public.start_blank_quote('X-11', null)$q$);
  perform pg_temp.res('14 member without quotes edit refused (42501)', e like '42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.start_blank_quote('X-12', null)$q$);
  perform pg_temp.res('15 signed out refused', e <> '', e);
  perform pg_temp.login('b_admin@b.test');
  q3 := public.start_blank_quote('X-13', null);
  perform pg_temp.su();
  perform pg_temp.res('16 other studio gets its own quote in its own org',
    q3.org_id = 'b0000000-0000-4000-8000-000000000001' and q3.id not in (pg_temp.get('q1')::uuid, pg_temp.get('q3')::uuid), coalesce(q3.org_id::text, 'null'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x start_blank_quote setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- #16: business e-mail confirmation + booklet -----------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  r jsonb; tok text; v boolean; e text; o uuid; begin
  perform pg_temp.su();
  perform pg_temp.res('20 column added, default false',
    (select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false' from information_schema.columns
      where table_schema = 'public' and table_name = 'organizations' and column_name = 'business_email_confirmed'));
  -- server-side seeding (like signup's create_studio) never counts as confirmed
  update public.organizations set business_email = 'owner-login@a.test', business_email_confirmed = true,
    brand = coalesce(brand, '{}'::jsonb) || '{"phone":"+91 40 5555"}'::jsonb where id = a;
  select business_email_confirmed into v from public.organizations where id = a;
  perform pg_temp.res('21 server-side e-mail change is not a confirmation', v = false, v::text);
  update public.quotes set deleted_at = null where id = qa;
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa, 10, array[]::uuid[], null, null);
  tok := r ->> 'token'; perform pg_temp.put('tok', tok);
  perform pg_temp.anon();
  r := public.public_get_booklet(pg_temp.get('tok')::uuid);
  perform pg_temp.res('22 booklet hides the unconfirmed (signup) e-mail, keeps the studio phone',
    not ((r -> 'studio') ? 'email') and r #>> '{studio,phone}' = '+91 40 5555' and r #>> '{studio,name}' is not null, (r -> 'studio')::text);
  perform pg_temp.res('23 rest of the 0070 payload unchanged (sections, snapshots, event)',
    r ? 'sections' and r ? 'snapshots' and r #>> '{event,code}' is not null, left(r::text, 200));

  -- the admin saves Studio details (the app sends business_email_confirmed = true)
  perform pg_temp.login('a_admin@a.test');
  update public.organizations set business_email = 'hello@studio-a.test', business_email_confirmed = true where id = a;
  perform pg_temp.su();
  select business_email_confirmed into v from public.organizations where id = a;
  perform pg_temp.res('24 admin save confirms the e-mail', v = true, coalesce(v::text, 'null'));
  delete from public.auth_rate_hits where bucket like 'booklet.%';
  perform pg_temp.anon();
  r := public.public_get_booklet(pg_temp.get('tok')::uuid);
  perform pg_temp.res('25 booklet shows the confirmed business e-mail', r #>> '{studio,email}' = 'hello@studio-a.test', (r -> 'studio')::text);

  -- clearing the e-mail clears the confirmation
  perform pg_temp.login('a_admin@a.test');
  update public.organizations set business_email = null, business_email_confirmed = true where id = a;
  perform pg_temp.su();
  select business_email_confirmed into v from public.organizations where id = a;
  perform pg_temp.res('26 no e-mail -> not confirmed', v = false);

  -- a brand-new studio is never confirmed, whatever the insert says
  insert into public.organizations(name, business_email, business_email_confirmed) values ('UF new studio', 'x@new.test', true) returning id into o;
  select business_email_confirmed into v from public.organizations where id = o;
  perform pg_temp.res('27 new studio starts unconfirmed', v = false);

  -- old body kept + private; wrapper still anon-callable
  perform pg_temp.res('28 __pre0075 kept and not callable by anon/authenticated',
    to_regprocedure('public.public_get_booklet__pre0075(uuid)') is not null
    and not has_function_privilege('anon', 'public.public_get_booklet__pre0075(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.public_get_booklet__pre0075(uuid)', 'execute')
    and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute'));
  perform pg_temp.res('29 booklet wrapper security definer + search_path empty',
    (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.public_get_booklet(uuid)'::regprocedure));
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.public_get_booklet('00000000-0000-4000-8000-000000000000'::uuid)$q$);
  perform pg_temp.res('30 unknown token still refused', e like 'P0001%', e);
exception when others then perform pg_temp.su(); insert into _uf values ('2x booklet setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'UI-FIXES: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'UI-FIXES: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
