-- ============================================================================
-- 10-fixtures.sql — deterministic TWO-TENANT fixture for behavioral tests.
-- Idempotent. Test harness only (local disposable PG). Seeds Studio A + Studio B,
-- admin + staff users in each, role_access, and one quote per org.
-- ============================================================================
set client_min_messages = warning;

-- Stable UUIDs so tests can reference them.
--   Org A  = aaaaaaaa-... ; Org B = bbbbbbbb-...
--   users  : a_admin/a_staff/b_admin/b_staff
--   quotes : quoteA (org A), quoteB (org B)
do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid; a_staff uuid; b_admin uuid; b_staff uuid;
  qA uuid := 'a0000000-0000-4000-8000-00000000da01';
  qB uuid := 'b0000000-0000-4000-8000-00000000da01';
begin
  -- organizations
  insert into public.organizations(id,name,currency,timezone,brand,plan,created_at)
    values (orgA,'Studio A','INR','Asia/Kolkata','{}'::jsonb,'pro',now())
    on conflict (id) do nothing;
  insert into public.organizations(id,name,currency,timezone,brand,plan,created_at)
    values (orgB,'Studio B','INR','Asia/Kolkata','{}'::jsonb,'pro',now())
    on conflict (id) do nothing;

  -- users (auth.users via shim) + profiles
  select id into a_admin from auth.users where email='a_admin@a.test';
  if a_admin is null then a_admin := auth.seed_user('a_admin@a.test'); end if;
  select id into a_staff from auth.users where email='a_staff@a.test';
  if a_staff is null then a_staff := auth.seed_user('a_staff@a.test'); end if;
  select id into b_admin from auth.users where email='b_admin@b.test';
  if b_admin is null then b_admin := auth.seed_user('b_admin@b.test'); end if;
  select id into b_staff from auth.users where email='b_staff@b.test';
  if b_staff is null then b_staff := auth.seed_user('b_staff@b.test'); end if;

  insert into public.profiles(id,email,role,org_id,must_change_password,created_at) values
    (a_admin,'a_admin@a.test','admin',orgA,false,now()),
    (a_staff,'a_staff@a.test','sales',orgA,false,now()),
    (b_admin,'b_admin@b.test','admin',orgB,false,now()),
    (b_staff,'b_staff@b.test','sales',orgB,false,now())
  on conflict (id) do update set role=excluded.role, org_id=excluded.org_id;

  -- role_access: give 'sales' edit on quotes/finance in BOTH orgs (so can_edit paths exercise)
  insert into public.role_access(role,area,can_view,can_edit,org_id,updated_at)
  select r,a,true,true,o,now()
  from (values ('sales'),('manager'),('operations')) rr(r),
       (values ('quotes'),('finance'),('proposal'),('controls')) aa(a),
       (values (orgA),(orgB)) oo(o)
  on conflict (role,area,org_id) do update set can_view=true,can_edit=true;

  -- one quote per org (pricing = legitimate ₹236000 shape)
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at)
    values (qA,'A-0001','Wedding A','quote','{"name":"Alice"}'::jsonb,
            '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb,1,'sent',orgA,
            'a0000000-0000-4000-8000-0000000000aa', now(), now())
    on conflict (id) do update set pricing=excluded.pricing;
  insert into public.quotes(id,code,title,status,client,pricing,current_version,approval_status,org_id,approval_token,created_at,updated_at)
    values (qB,'B-0001','Wedding B','quote','{"name":"Bob"}'::jsonb,
            '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb,1,'sent',orgB,
            'b0000000-0000-4000-8000-0000000000bb', now(), now())
    on conflict (id) do update set pricing=excluded.pricing;

  -- 0042: this disposable test cluster is a "staging-like" environment where the OTP
  -- dev echo may be used (the audit-run2 suite removes it inside its own transaction)
  if to_regclass('public.helm_env_settings') is not null then
    insert into public.helm_env_settings(key, value) values ('allow_otp_dev_echo', 'true'::jsonb)
      on conflict (key) do update set value = excluded.value;
  end if;

  raise notice 'fixture ready: orgA=% orgB=% a_staff=% b_staff=% qA=% qB=%', orgA,orgB,a_staff,b_staff,qA,qB;
end $$;

-- 0047: the pre-existing suites assert the "two-step required" HQ rules; the
-- hq-mfa-optional suite flips the switch itself.
do $$ begin
  if to_regclass('public.helm_hq_settings') is not null then
    update public.helm_hq_settings set hq_require_mfa = true where id and not hq_require_mfa;
  end if;
end $$;
