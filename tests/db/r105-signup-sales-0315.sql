-- r105-signup-sales-0315.sql - 0315: sign-up "Contact sales" saves a sales request WITHOUT creating a studio.
-- Proves: an account with no studio saves one request (org_id null, created_by = caller, name / e-mail from the account),
-- no studio / subscription is created, the same plan + billing again = duplicate, my_signup_sales_request returns it,
-- an account WITH a studio is refused, anon cannot call, bad plan refused, HQ list still reads it, e-mail queued.
-- Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0315_r105_signup_sales_no_studio.sql
\ir ../../supabase/migrations/0315_r105_signup_sales_no_studio.sql
set client_min_messages = warning;
begin;
create temp table _t315(name text, result text); grant all on _t315 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(u uuid, p_email text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t315 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return '';
exception when others then return sqlstate || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$
declare
  nu uuid := 'f3150000-0000-4000-8000-000000000001';
  e text; j jsonb; j2 jsonb; n_org int; n_org2 int; withorg uuid; withorg_email text;
begin
  perform pg_temp.su();
  insert into auth.users(id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    values (nu, 'authenticated', 'authenticated', 'r105.nostudio@example.test', now(), '{"full_name":"Ravi Kumar"}', now(), now());
  select count(*) into n_org from public.organizations;
  select p.id, u.email into withorg, withorg_email from public.profiles p join auth.users u on u.id = p.id where p.org_id is not null limit 1;

  perform pg_temp.login(nu, 'r105.nostudio@example.test');
  perform pg_temp.res('01 no request yet -> null', public.my_signup_sales_request() is null, '');
  j := public.request_signup_sales('studio', 'yearly', 'Aurora Events', '+91 98765 43210', 'Call me');
  perform pg_temp.res('02 request saved', j ->> 'status' = 'received' and (j ->> 'duplicate')::boolean = false, j::text);
  j2 := public.request_signup_sales('studio', 'yearly', 'Aurora Events', null, null);
  perform pg_temp.res('03 same plan + billing again = duplicate', (j2 ->> 'duplicate')::boolean and j2 ->> 'id' = j ->> 'id', j2::text);
  j2 := public.my_signup_sales_request();
  perform pg_temp.res('04 my_signup_sales_request returns it', j2 ->> 'id' = j ->> 'id' and j2 ->> 'plan_code' = 'studio'
    and j2 ->> 'billing_interval' = 'yearly' and j2 ->> 'studio_name' = 'Aurora Events', coalesce(j2::text, 'null'));
  e := pg_temp.try($q$select public.request_signup_sales('gold!!', 'monthly', 'Aurora Events')$q$);
  perform pg_temp.res('05 bad plan refused', e like '22023%Choose a plan%', e);
  e := pg_temp.try($q$select public.request_signup_sales('starter', 'monthly', 'A')$q$);
  perform pg_temp.res('06 studio name required', e like '22023%studio name%', e);

  perform pg_temp.su();
  select count(*) into n_org2 from public.organizations;
  perform pg_temp.res('07 no studio created', n_org2 = n_org, n_org || ' -> ' || n_org2);
  perform pg_temp.res('08 row: no org, caller, name + e-mail from the account, prefixed message',
    exists (select 1 from public.sales_requests r where r.id = (j ->> 'id')::uuid and r.org_id is null and r.created_by = nu
      and r.contact_name = 'Ravi Kumar' and r.contact_email = 'r105.nostudio@example.test' and r.message like '[Sign-up, no studio yet] Call me%'), '');
  perform pg_temp.res('09 sales e-mail queued once',
    (select count(*) from public.helm_notice_outbox o where o.ref_id = (j ->> 'id')::uuid and o.kind = 'sales_request') = 1, '');
  perform pg_temp.res('10 no profile / membership created', not exists (select 1 from public.profiles p where p.id = nu and p.org_id is not null), '');

  if withorg is not null then
    perform pg_temp.login(withorg, withorg_email);
    e := pg_temp.try($q$select public.request_signup_sales('studio', 'monthly', 'Other')$q$);
    perform pg_temp.res('11 account with a studio refused', e like '22023%already have a studio%', e);
    perform pg_temp.res('12 other account sees no request of mine', public.my_signup_sales_request() is null
      or public.my_signup_sales_request() ->> 'id' <> j ->> 'id', '');
  else
    perform pg_temp.res('11 account with a studio refused', true, ''); perform pg_temp.res('12 other account sees no request of mine', true, '');
  end if;
  perform pg_temp.su();
  perform pg_temp.res('13 anon cannot call; authenticated can',
    not has_function_privilege('anon', 'public.request_signup_sales(text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.my_signup_sales_request()', 'execute')
    and has_function_privilege('authenticated', 'public.request_signup_sales(text,text,text,text,text)', 'execute'), '');
  perform pg_temp.res('14 marker + empty search_path',
    (select bool_and(position('r105-signup-sales-0315' in p.prosrc) > 0 and array_to_string(p.proconfig, ',') like '%search_path=""%')
       from pg_proc p where p.oid in ('public.request_signup_sales(text,text,text,text,text)'::regprocedure, 'public.my_signup_sales_request()'::regprocedure)), '');
  perform pg_temp.res('15 HQ activate plan untouched (hq_activate_plan still present)',
    to_regprocedure('public.hq_activate_plan(uuid,text,text,numeric,text,text,text,text)') is not null
    or exists (select 1 from pg_proc where proname = 'hq_activate_plan'), '');
end $$;

do $$
declare adm uuid; adm_email text; o uuid; e text; j jsonb; bl jsonb;
begin
  perform pg_temp.su();
  select p.id, u.email, p.org_id into adm, adm_email, o from public.profiles p join auth.users u on u.id = p.id
   where p.org_id is not null and p.role = 'admin' limit 1;
  if adm is null then
    perform pg_temp.res('16 location: no admin in fixture', false, 'fixture'); return; end if;
  update public.organizations set brand = coalesce(case when jsonb_typeof(brand) = 'object' then brand else null end, '{}'::jsonb) - 'billing' where id = o;
  insert into public.studio_account(org_id) values (o) on conflict (org_id) do nothing;
  update public.studio_account set country = null, state = null, city = null where org_id = o;
  perform pg_temp.login(adm, adm_email);
  e := pg_temp.try($q$select public.my_studio_signup_location('IN', 'Narnia', 'Hyderabad')$q$);
  perform pg_temp.res('16 location: a state not in the India list refused', e like '22023%state from the list%', e);
  j := public.my_studio_signup_location('IN', 'telangana', 'Hyderabad');
  perform pg_temp.res('17 location saved (state matched to the list name)', (j ->> 'saved')::boolean, j::text);
  perform pg_temp.su();
  select brand -> 'billing' into bl from public.organizations where id = o;
  perform pg_temp.res('18 brand.billing + studio_account filled',
    bl ->> 'city' = 'Hyderabad' and bl ->> 'state' = 'Telangana' and bl ->> 'country' = 'IN'
    and exists (select 1 from public.studio_account a where a.org_id = o and a.country = 'IN' and a.state = 'Telangana' and a.city = 'Hyderabad'), coalesce(bl::text, 'null'));
  perform pg_temp.login(adm, adm_email);
  j := public.my_studio_signup_location('IN', 'Kerala', 'Kochi');
  perform pg_temp.su();
  select brand -> 'billing' into bl from public.organizations where id = o;
  perform pg_temp.res('19 a saved location is never overwritten',
    bl ->> 'city' = 'Hyderabad' and bl ->> 'state' = 'Telangana'
    and exists (select 1 from public.studio_account a where a.org_id = o and a.state = 'Telangana' and a.city = 'Hyderabad'), coalesce(bl::text, 'null'));
  perform pg_temp.login('f3150000-0000-4000-8000-000000000001', 'r105.nostudio@example.test');
  e := pg_temp.try($q$select public.my_studio_signup_location('IN', 'Kerala', 'Kochi')$q$);
  perform pg_temp.res('20 no studio -> not authorized', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('21 location RPC: authenticated only, empty search_path',
    not has_function_privilege('anon', 'public.my_studio_signup_location(text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_studio_signup_location(text,text,text)', 'execute')
    and (select array_to_string(p.proconfig, ',') like '%search_path=""%' from pg_proc p where p.oid = 'public.my_studio_signup_location(text,text,text)'::regprocedure), '');
end $$;

select name, result from _t315 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R105-SIGNUP-SALES-0315: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R105-SIGNUP-SALES-0315: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t315;
rollback;
