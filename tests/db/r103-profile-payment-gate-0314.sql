-- r103-profile-payment-gate-0314.sql - 0314: "Complete your profile" works for the owner of a studio that is still
-- waiting for its first payment (create_direct_studio, "Pay now" / "Contact sales"), while every BUSINESS record in
-- that studio stays blocked with payment_pending and another person's profile row is never writable.
-- Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0314_r103_profile_payment_gate.sql
\ir ../../supabase/migrations/0314_r103_profile_payment_gate.sql
set client_min_messages = warning;
begin;
create temp table _t314(name text, result text); grant all on _t314 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t314 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;

do $$
declare o uuid; u uuid; u2 uuid; e text; n0 int; r jsonb; v text := public._account_terms_version();
begin
  -- a new owner signs up for a paid plan: Terms, then the studio waiting for payment
  u := pg_temp.newuser('r314-owner@synthetic.helm'); perform pg_temp.login('r314-owner@synthetic.helm');
  perform public.accept_account_terms(v, 'UA', 'signup');
  r := public.create_direct_studio('R314 Paid Studio', 'studio', 'yearly', v, 'UA');
  perform pg_temp.su();
  select org_id into o from public.profiles where id = u;
  -- a later request (not the sign-up transaction itself)
  update public.organizations set created_at = now() - interval '5 minutes' where id = o;
  perform pg_temp.res('00 paid studio created, payment pending', o is not null and public._studio_payment_pending(o), coalesce(r::text, ''));

  -- (1) the profile step saves (was payment_pending)
  select count(*) into n0 from public.crew_members where org_id = o;
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Rao Paid","phone":"+919876544441","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('01 pending: complete_my_profile succeeds', e = '', e);
  perform pg_temp.res('02 pending: name + phone saved',
    (select full_name from public.profiles where id = u) = 'Rao Paid'
    and (select phone from public.member_profiles where user_id = u) = '+919876544441', '');
  perform pg_temp.res('03 pending: no Staff (crew_members) write', (select count(*) from public.crew_members where org_id = o) = n0, '');
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try($q$select public.update_my_profile('{"full_name":"Rao Paid Two","phone":"+919876544442","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('04 pending: update_my_profile succeeds', e = '', e);
  -- the gate as the trigger sees it (the app has no direct table grant; the RPCs above are the app path)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  e := pg_temp.try(format($q$update public.member_profiles set city = 'Pune' where user_id = %L$q$, u));
  perform pg_temp.su();
  perform pg_temp.res('05 pending: own member_profiles row passes the gate', e = '', e);

  -- (2) business data stays blocked
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try(format($q$insert into public.leads(org_id, name, status) values (%L, 'R314 lead', 'new')$q$, o));
  perform pg_temp.su();
  perform pg_temp.res('06 pending: lead insert still payment_pending', e like '25006 payment_pending%', e);
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try(format($q$insert into public.crew_members(name, org_id, active) values ('X', %L, true)$q$, o));
  perform pg_temp.su();
  perform pg_temp.res('07 pending: crew_members insert still payment_pending', e like '25006 payment_pending%', e);

  -- (3) another member's profile row in the same pending studio is not exempt
  u2 := pg_temp.newuser('r314-other@synthetic.helm');
  update public.profiles set org_id = o, role = 'coordinator' where id = u2;
  insert into public.member_profiles(user_id, city) values (u2, 'Delhi') on conflict (user_id) do update set city = 'Delhi';
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try(format($q$update public.member_profiles set city = 'Goa' where user_id = %L$q$, u2));
  perform pg_temp.su();
  perform pg_temp.res('08 pending: another person''s member_profiles row not writable',
    (select city from public.member_profiles where user_id = u2) = 'Delhi', e);
  -- the gate itself refuses it (even past RLS), proven as the trigger sees it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  e := pg_temp.try(format($q$update public.member_profiles set city = 'Goa' where user_id = %L$q$, u2));
  perform pg_temp.su();
  perform pg_temp.res('09 pending: gate refuses another person''s row (payment_pending)', e like '25006 payment_pending%', e);

  -- (4) after payment the Staff sync runs again
  update public.studio_subscriptions set status = 'active' where org_id = o;
  if not found then insert into public.studio_subscriptions(org_id, status) values (o, 'active'); end if;
  perform pg_temp.login('r314-owner@synthetic.helm');
  e := pg_temp.try($q$select public.update_my_profile('{"full_name":"Rao Paid Three","phone":"+919876544443","whatsapp_same":true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('10 paid: profile save syncs the Staff row again',
    e = '' and exists (select 1 from public.crew_members c where c.profile_id = u and c.org_id = o), e);

  -- (5) shape
  perform pg_temp.res('11 live _mp_sync_staff: 0314 marker, both older layers kept, app cannot call any layer',
    coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r103-profile-payment-0314' in p.prosrc) > 0
       from pg_proc p where p.oid = 'public._mp_sync_staff(uuid,jsonb)'::regprocedure), false)
    and to_regprocedure('public._mp_sync_staff__pre0314(uuid,jsonb)') is not null
    and to_regprocedure('public._mp_sync_staff__pre0308(uuid,jsonb)') is not null
    and not has_function_privilege('authenticated', 'public._mp_sync_staff(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._mp_sync_staff__pre0314(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r314_sync_staff(uuid,jsonb)', 'execute'), '');
  perform pg_temp.res('12 tg_studio_read_only carries the 0314 marker',
    position('r103-profile-payment-0314' in (select prosrc from pg_proc where oid = 'public.tg_studio_read_only()'::regprocedure)) > 0, '');
end $$;

select name, result from _t314 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R103-PROFILE-PAYMENT-0314: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R103-PROFILE-PAYMENT-0314: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t314;
rollback;
