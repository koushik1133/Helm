-- hq-subscriptions.sql — 0045 Helm HQ subscriptions + read-only suspend + no studio data in HQ.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _hs; create temp table _hs(name text, result text); grant all on _hs to anon, authenticated, service_role;
drop table if exists _hv; create temp table _hv(k text primary key, v text); grant all on _hv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); end $$;
create or replace function pg_temp.op(p_aal text default 'aal2') returns void language plpgsql as $$
begin perform pg_temp.login('admin@helm.events');
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin perform pg_temp.su(); insert into _hs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if coalesce(c, '') <> '' then perform set_config('request.jwt.claims', c, false); end if;
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
-- run SQL as the current caller → '' on success or the SQLSTATE
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.setv(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _hv values (p_k, p_v) on conflict on constraint _hv_pkey do update set v = excluded.v; end $$;
grant execute on function pg_temp.setv(text,text) to anon, authenticated, service_role;
create or replace function pg_temp.getv(p text) returns text language sql as $$ select v from _hv where k = p $$;
grant execute on function pg_temp.getv(text) to anon, authenticated, service_role;

-- every hq_* WRITE as the current caller → list of calls that did NOT raise 42501
create or replace function pg_temp.wleaks() returns text language plpgsql as $$
declare out text := ''; sql text; e text;
begin
  foreach sql in array array[
      'select public.hq_upsert_plan(''zz'', ''Z'', 1, ''INR'', true)',
      'select public.hq_set_subscription(''b0000000-0000-4000-8000-000000000001'', null, ''active'')',
      'select public.hq_suspend_studio(''b0000000-0000-4000-8000-000000000001'', ''test reason'')',
      'select public.hq_reactivate_studio(''b0000000-0000-4000-8000-000000000001'')',
      'select public.hq_record_payment(''b0000000-0000-4000-8000-000000000001'', 10, current_date, ''cash'')',
      'select public.hq_void_payment(gen_random_uuid(), ''xyz'')',
      'select public.hq_refresh_billing_status()',
      'select public.hq_set_billing_settings(''X'', null, null, 18, ''H-'')',
      'select public.hq_add_operator(''new-op@helm.events'')',
      'select public.hq_remove_operator(''security@helm.events'')'] loop
    e := pg_temp.try(sql); if e <> '42501' then out := out || sql || ' [' || e || '] ; '; end if;
  end loop;
  return out;
end $$;
create or replace function pg_temp.rleaks() returns text language plpgsql as $$
declare out text := ''; sql text; e text;
begin
  foreach sql in array array['select public.hq_overview()', 'select count(*) from public.hq_studios(null,null,25,0)',
      'select public.hq_studio_detail(''a0000000-0000-4000-8000-000000000001'')', 'select public.hq_payments(null,null)',
      'select public.hq_billing(null,null)', 'select public.hq_plans()', 'select public.hq_audit(null,null)',
      'select public.hq_operators()', 'select public.hq_invoice(gen_random_uuid())', 'select public.hq_billing_settings()'] loop
    e := pg_temp.try(sql); if e <> '42501' then out := out || sql || ' [' || e || '] ; '; end if;
  end loop;
  return out;
end $$;
grant execute on function pg_temp.wleaks() to anon, authenticated;
grant execute on function pg_temp.rleaks() to anon, authenticated;

-- ---- setup ---------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  if not exists (select 1 from auth.users where email = 'security@helm.events') then perform auth.seed_user('security@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email in ('admin@helm.events', 'security@helm.events');
  update public.platform_admins set require_mfa = false;
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'admin@helm.events';
  update public.helm_billing_settings set gst_rate = 18, invoice_prefix = 'HELM-' where id;
end $$;

-- ---- 1) who may call -------------------------------------------------------------------------
do $$ declare l text; begin
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  l := pg_temp.rleaks() || pg_temp.wleaks(); perform pg_temp.res('01 anon: every hq_* read + write refused', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('a_admin@a.test'); l := pg_temp.rleaks() || pg_temp.wleaks();
  perform pg_temp.res('02 studio admin: every hq_* read + write refused', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.op('aal1'); l := pg_temp.rleaks() || pg_temp.wleaks();
  perform pg_temp.res('03 operator (factor enrolled) at aal1: every hq_* read + write refused', l = '', l);
end $$;
do $$ declare l text; begin
  perform pg_temp.login('security@helm.events'); l := pg_temp.wleaks();   -- no factor, aal1: reads allowed (0029), writes not
  perform pg_temp.res('04 operator without two-step at aal1: every hq_* write refused', l = '', l);
end $$;
do $$ declare e text; begin
  perform pg_temp.op('aal2'); e := pg_temp.try('select public.hq_overview()') || pg_temp.try('select public.hq_plans()');
  perform pg_temp.res('05 operator at aal2: reads allowed', e = '', e);
end $$;

-- ---- 2) plans, subscription, payments, invoice -------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.op();
  perform public.hq_upsert_plan('starter', 'Starter', 999, 'INR', true);
  perform public.hq_upsert_plan('pro', 'Pro', 2999, 'INR', true);
  perform public.hq_upsert_plan('pro', 'Pro plan', 2999, 'INR', true);      -- upsert by code
  r := public.hq_plans();
  perform pg_temp.res('06 plans upsert by code + list', jsonb_array_length(r) = 2
    and exists (select 1 from jsonb_array_elements(r) x where x->>'code' = 'pro' and x->>'name' = 'Pro plan'), r::text);
  r := public.hq_set_subscription('a0000000-0000-4000-8000-000000000001', 'pro', 'active', null, current_date - 10, current_date + 20, 'note');
  perform pg_temp.res('07 set subscription (A: pro, active)', r->>'status' = 'active', r::text);
  e := pg_temp.try('select public.hq_set_subscription(''a0000000-0000-4000-8000-000000000001'', null, ''suspended'')');
  perform pg_temp.res('08 set_subscription cannot suspend (needs suspend + reason)', e = '22023', e);
  r := public.hq_record_payment('a0000000-0000-4000-8000-000000000001', 1180, current_date, 'upi', 'INR', current_date - 10, current_date + 20, 'UTR123');
  perform pg_temp.setv('payA', r->>'id');
  perform pg_temp.res('09 payment recorded: invoice no + GST split computed server-side (1180 = 1000 + 180)',
    r->>'invoice_no' ~ '^HELM-[0-9]{6}$' and (r->>'net_amount')::numeric = 1000 and (r->>'gst_amount')::numeric = 180
    and (r->>'gst_rate')::numeric = 18, r::text);
  e := pg_temp.try('select public.hq_record_payment(''a0000000-0000-4000-8000-000000000001'', 0, current_date, ''upi'')')
    || pg_temp.try('select public.hq_record_payment(''a0000000-0000-4000-8000-000000000001'', 10, current_date, ''bitcoin'')');
  perform pg_temp.res('10 payment validation (amount > 0, method list)', e = '2202322023', e);
  r := public.hq_invoice(pg_temp.getv('payA')::uuid);
  perform pg_temp.res('11 hq_invoice JSON shape', r->>'invoice_no' like 'HELM-%' and r->>'status' = 'paid' and r ? 'seller' and r ? 'buyer'
    and (r->>'total')::numeric = 1180 and (r->>'net_amount')::numeric = 1000 and jsonb_array_length(r->'lines') = 1
    and r#>>'{buyer,name}' = 'Studio A' and r#>>'{plan,code}' = 'pro', r::text);
end $$;

-- ---- 3) studio side reads ----------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test'); r := public.my_subscription();
  perform pg_temp.res('12 studio admin reads own subscription + payments', r->>'status' = 'active' and r#>>'{plan,code}' = 'pro'
    and jsonb_array_length(r->'payments') = 1 and not (r->>'read_only')::boolean, r::text);
  r := public.my_invoice(pg_temp.getv('payA')::uuid);
  perform pg_temp.res('13 studio admin opens own invoice', r->>'invoice_no' like 'HELM-%', coalesce(r::text, 'null'));
  perform pg_temp.login('a_staff@a.test'); r := public.my_subscription();
  perform pg_temp.res('14 studio staff sees status only (no plan / payments)', r ? 'status' and not r ? 'payments' and not r ? 'plan', r::text);
  e := pg_temp.try('select public.my_invoice(''' || pg_temp.getv('payA') || ''')');
  perform pg_temp.res('15 studio staff cannot open invoices', e = '42501', e);
  perform pg_temp.login('b_admin@b.test'); r := public.my_subscription();
  perform pg_temp.res('16 other studio admin does not see A''s subscription', r->>'status' is null and coalesce(jsonb_array_length(r->'payments'), 0) = 0, r::text);
  e := pg_temp.try('select public.my_invoice(''' || pg_temp.getv('payA') || ''')');
  perform pg_temp.res('17 other studio admin cannot open A''s invoice', e = '42501', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select count(*) from public.studio_subscriptions') || '|' || pg_temp.try('select count(*) from public.subscription_payments')
    || '|' || pg_temp.try('insert into public.studio_subscriptions(org_id, status) values (''a0000000-0000-4000-8000-000000000001'', ''active'')')
    || '|' || pg_temp.try('update public.subscription_payments set amount = 1') || '|' || pg_temp.try('select count(*) from public.helm_plans')
    || '|' || pg_temp.try('select count(*) from public.billing_reminders') || '|' || pg_temp.try('select count(*) from public.helm_billing_settings');
  perform pg_temp.res('18 studio admin cannot read or write subscription tables directly', e = '42501|42501|42501|42501|42501|42501|42501', e);
end $$;

-- ---- 4) suspend = read-only --------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('update public.quotes set title = title where id = ''a0000000-0000-4000-8000-00000000da01''');
  e := e || pg_temp.try('insert into public.vendors(name) values (''hs-pre'')');
  perform pg_temp.res('19 before suspend: studio admin can write', e = '', e);
  perform pg_temp.op(); perform public.hq_suspend_studio('a0000000-0000-4000-8000-000000000001', 'unpaid since Sept');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('update public.quotes set title = title || ''x'' where id = ''a0000000-0000-4000-8000-00000000da01''');
  perform pg_temp.res('20 suspended: UPDATE quotes refused (25006)', e = '25006', e);
  e := pg_temp.try('insert into public.vendors(name) values (''hs-suspended'')');
  perform pg_temp.res('21 suspended: INSERT vendors refused', e = '25006', e);
  e := pg_temp.try('update public.vendors set notes = ''x'' where name = ''hs-pre''') || '|' || pg_temp.try('delete from public.vendors where name = ''hs-pre''');
  perform pg_temp.res('22 suspended: UPDATE + DELETE vendors refused', e = '25006|25006', e);
  e := pg_temp.try('update public.organizations set name = name where id = ''a0000000-0000-4000-8000-000000000001''');
  perform pg_temp.res('23 suspended: studio settings (organizations) write refused', e = '25006', e);
  e := pg_temp.try('select count(*) from public.quotes') || pg_temp.try('select count(*) from public.role_access')
    || pg_temp.try('select public.my_subscription()');
  perform pg_temp.res('24 suspended: reads still work', e = '', e);
  perform pg_temp.res('25 suspended: my_subscription says read_only', (public.my_subscription()->>'read_only')::boolean, public.my_subscription()::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try('update public.quotes set title = title where id = ''b0000000-0000-4000-8000-00000000da01''');
  perform pg_temp.res('26 Org B unaffected by Org A suspend', e = '', e);
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  e := pg_temp.try('select public.request_otp(''a0000000-0000-4000-8000-0000000000aa'', ''+919999999999'')');
  perform pg_temp.res('27 suspended: anonymous approve-link write (OTP) refused', e = '25006', e);
  perform pg_temp.svc();
  e := pg_temp.try('update public.quotes set title = title where id = ''a0000000-0000-4000-8000-00000000da01''');
  perform pg_temp.res('28 suspended: service role unaffected', e = '', e);
  perform pg_temp.op(); perform public.hq_reactivate_studio('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('update public.quotes set title = title where id = ''a0000000-0000-4000-8000-00000000da01''');
  perform pg_temp.res('29 reactivated: writes work again + previous status restored', e = '' and public.my_subscription()->>'status' = 'active', e);
end $$;

-- ---- 5) void keeps the row; payments are never deleted ------------------------------------------
do $$ declare r jsonb; e text; n int; inv text; begin
  perform pg_temp.op();
  inv := public.hq_invoice(pg_temp.getv('payA')::uuid)->>'invoice_no';
  r := public.hq_void_payment(pg_temp.getv('payA')::uuid, 'entered twice');
  e := pg_temp.try('select public.hq_void_payment(''' || pg_temp.getv('payA') || ''', ''again'')');
  perform pg_temp.su(); select count(*) into n from public.subscription_payments where id = pg_temp.getv('payA')::uuid and voided_at is not null;
  perform pg_temp.res('30 void keeps the row (and invoice number), second void refused',
    (r->>'voided')::boolean and n = 1 and e = '22023' and r->>'invoice_no' = inv, r::text || e);
  e := pg_temp.try('delete from public.subscription_payments') || '|' || pg_temp.try('update public.subscription_payments set amount = 5');
  perform pg_temp.res('31 even the database owner cannot delete or change a payment', e = '42501|42501', e);
  perform pg_temp.op();
  perform pg_temp.res('32 voided invoice shows status void', public.hq_invoice(pg_temp.getv('payA')::uuid)->>'status' = 'void', '');
end $$;

-- ---- 6) auto past-due + reminder queue -------------------------------------------------------------
do $$ declare r jsonb; n int; s text; begin
  perform pg_temp.op();
  perform public.hq_set_subscription('b0000000-0000-4000-8000-000000000001', 'starter', 'active', null, current_date - 40, current_date - 3);
  r := public.hq_billing(null, null); r := public.hq_billing(null, null);
  perform pg_temp.su(); select status into s from public.studio_subscriptions where org_id = 'b0000000-0000-4000-8000-000000000001';
  select count(*) into n from public.billing_reminders where org_id = 'b0000000-0000-4000-8000-000000000001' and kind = 'past_due';
  perform pg_temp.res('33 auto past-due: active + period over + unpaid → past_due; one reminder per period', s = 'past_due' and n = 1, s || ' ' || n);
  perform pg_temp.res('34 hq_billing lists the past-due studio', exists (select 1 from jsonb_array_elements(r->'past_due') x
    where x->>'name' = 'Studio B' and (x->>'days_overdue')::int = 3), r::text);
  perform pg_temp.op();
  perform public.hq_set_subscription('a0000000-0000-4000-8000-000000000001', null, null, null, null, current_date - 1);
  perform public.hq_record_payment('a0000000-0000-4000-8000-000000000001', 2999, current_date, 'bank', 'INR', current_date, current_date + 30);
  perform public.hq_refresh_billing_status();
  perform pg_temp.su(); select status into s from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('35 a payment covering today keeps the studio active', s = 'active', s);
  perform pg_temp.su(); update public.studio_subscriptions set current_period_start = current_date - 430, current_period_end = current_date - 400 where org_id = 'b0000000-0000-4000-8000-000000000001';
  perform public._billing_refresh();
  select status into s from public.studio_subscriptions where org_id = 'b0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('36 never auto-suspends', s = 'past_due', s);
  perform pg_temp.op();
  perform public.hq_set_subscription('b0000000-0000-4000-8000-000000000001', null, 'active', null, current_date - 25, current_date + 5);
  perform public.hq_refresh_billing_status(); perform public.hq_refresh_billing_status();
  perform pg_temp.su(); select count(*) into n from public.billing_reminders where org_id = 'b0000000-0000-4000-8000-000000000001' and kind = 'due_soon';
  perform pg_temp.res('37 due-soon reminder queued once', n = 1, n::text);
  perform pg_temp.res('38 reminder queue: service role may read / mark sent, studios may not',
    has_table_privilege('service_role', 'public.billing_reminders', 'select') and has_column_privilege('service_role', 'public.billing_reminders', 'sent_at', 'update')
    and not has_table_privilege('authenticated', 'public.billing_reminders', 'select'), '');
end $$;

-- ---- 7) billing settings ------------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.op();
  perform public.hq_set_billing_settings('Helm Technologies Pvt Ltd', '36AAAAA0000A1Z5', 'Hyderabad', 12, 'HLM/');
  r := public.hq_record_payment('b0000000-0000-4000-8000-000000000001', 1120, current_date, 'cash', 'INR', current_date - 25, current_date + 5);
  perform pg_temp.res('39 billing settings: new GST rate + prefix used, seller snapshot on invoice',
    (r->>'gst_amount')::numeric = 120 and r->>'invoice_no' like 'HLM/%'
    and public.hq_invoice((r->>'id')::uuid)#>>'{seller,legal_name}' = 'Helm Technologies Pvt Ltd', r::text);
  perform public.hq_set_billing_settings('Helm', null, null, 18, 'HELM-');
end $$;

-- ---- 8) operators -------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.op();
  e := pg_temp.try('select public.hq_add_operator(''a_staff@a.test'')');
  perform pg_temp.res('40 operator: a studio member e-mail is refused', e = '22023', e);
  perform public.hq_add_operator('ops2@helm.events');
  r := public.hq_operators();
  perform pg_temp.res('41 operator: added + listed', exists (select 1 from jsonb_array_elements(r) x where x->>'email' = 'ops2@helm.events')
    and exists (select 1 from jsonb_array_elements(r) x where x->>'email' = 'admin@helm.events' and (x->>'is_me')::boolean), r::text);
  perform public.hq_remove_operator('ops2@helm.events');
  e := pg_temp.try('select public.hq_remove_operator(''admin@helm.events'')');
  perform pg_temp.res('42 operator: removed; cannot remove yourself', e = '22023'
    and not exists (select 1 from jsonb_array_elements(public.hq_operators()) x where x->>'email' = 'ops2@helm.events'), e);
  perform pg_temp.su(); delete from public.platform_admins where email = 'security@helm.events';
  perform pg_temp.op(); e := pg_temp.try('select public.hq_remove_operator(''admin@helm.events'')');
  perform pg_temp.su(); insert into public.platform_admins(email, added_by) values ('security@helm.events', 'test') on conflict do nothing;
  perform pg_temp.res('43 operator: the last operator cannot be removed', e = '22023', e);
end $$;

-- ---- 9) provider settlement (service role only, idempotent) ----------------------------------------------
do $$ declare r1 jsonb; r2 jsonb; n int; e text; begin
  perform pg_temp.svc();
  r1 := public.hq_settle_provider_payment('pay_TEST1', 'b0000000-0000-4000-8000-000000000001', 2360, current_date, current_date, current_date + 30);
  r2 := public.hq_settle_provider_payment('pay_TEST1', 'b0000000-0000-4000-8000-000000000001', 2360, current_date, current_date, current_date + 30);
  perform pg_temp.su(); select count(*) into n from public.subscription_payments where provider_payment_id = 'pay_TEST1';
  perform pg_temp.res('44 settlement idempotent on provider_payment_id', n = 1 and (r1->>'created')::boolean and not (r2->>'created')::boolean
    and r1->>'id' = r2->>'id' and r1->>'provider' = 'razorpay', r1::text || r2::text);
  perform pg_temp.op(); e := pg_temp.try('select public.hq_settle_provider_payment(''pay_X'', ''b0000000-0000-4000-8000-000000000001'', 1, current_date)');
  perform pg_temp.res('45 settlement: operators / signed-in users cannot call it', e = '42501', e);
end $$;

-- ---- 10) no studio business data in HQ ------------------------------------------------------------------
do $$ declare bad text; begin perform pg_temp.su();
  select string_agg(p.proname, ',') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (p.proname like 'hq\_%' or p.proname like '\_hq\_%')
     and p.prosrc ~* '\m(quotes|quote_payments|payment_milestones|leads|lead_archive|clients|crew|crew_members|event_[a-z_]+|quotation_versions|invitations|vendors|inventory_[a-z_]+|chat_[a-z_]+|storage\.objects|member_profiles)\M';
  perform pg_temp.res('46 no hq_* function body reads studio business tables (prosrc scan)', bad is null, bad);
end $$;
do $$ declare r jsonb; rec record; keys text; begin
  perform pg_temp.op();
  r := public.hq_overview() || public.hq_studio_detail('a0000000-0000-4000-8000-000000000001');
  select string_agg(distinct k, ',') into keys from (
     select jsonb_object_keys(r) k
     union all select jsonb_object_keys(m) from jsonb_array_elements(r->'members') m) t
   where k ~* 'event|revenue|confirmed|client|quote|milestone|phone|mobile|storage|chat|lead|outstanding|received';
  perform pg_temp.res('47 hq_overview + hq_studio_detail output keys carry no client / event / revenue / phone data', keys is null, keys);
  perform pg_temp.res('48 members view: name, e-mail, role, active, last sign-in, two-step',
    (select bool_and(m ?& array['display_name','email','role','active','last_sign_in_at','mfa_enabled']) and bool_and(not m ? 'phone')
       from jsonb_array_elements(r->'members') m) and jsonb_array_length(r->'members') >= 2, (r->'members')::text);
  perform pg_temp.op();
  select string_agg(a, ',') into keys from (select unnest(proargnames) a from pg_proc where proname = 'hq_studios') x
   where a ~* 'event|revenue|confirmed|^paid$';
  perform pg_temp.res('49 hq_studios columns carry no event / revenue data', keys is null, keys);
  perform pg_temp.op();
  select count(*)::text into keys from public.hq_studios(null, 'past_due', 25, 0);
  perform pg_temp.res('50 hq_studios status filter', keys = '0' or keys = '1', keys);
end $$;

-- ---- 11) audit ----------------------------------------------------------------------------------------------
do $$ declare r jsonb; n int; begin
  perform pg_temp.su();
  select count(*) into n from public.audit_log where action in ('hq.plan.upsert','hq.subscription.set','hq.payment.record','hq.payment.void',
     'hq.studio.suspend','hq.studio.reactivate','hq.operator.add','hq.operator.remove','hq.billing.settings') and org_id is null;
  perform pg_temp.res('51 every HQ write audited as hq.* with no studio', n >= 9, n::text);
  perform pg_temp.op(); r := public.hq_audit(current_date - 1, current_date);
  perform pg_temp.res('52 hq_audit returns only hq.* rows', jsonb_array_length(r->'rows') >= 9
    and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'action' not like 'hq.%'), '');
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.audit_log where action like 'hq.%';
  perform pg_temp.res('53 studios never see hq.* audit rows', n = 0, n::text);
end $$;

-- ---- 12) guard coverage ----------------------------------------------------------------------------------------
do $$ declare missing text; begin perform pg_temp.su();
  select string_agg(c.relname, ',') into missing from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
     and c.relname not in ('audit_log','notification_seen','studio_subscriptions','subscription_payments','billing_reminders','helm_audit_0044_reverted')
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zzz_studio_read_only');
  perform pg_temp.res('54 every studio table has the read-only guard', missing is null, missing);
end $$;

-- cleanup of mutable state that other suites read (payments are append-only by design)
do $$ begin perform pg_temp.su();
  update public.studio_subscriptions set status = 'active', prev_status = null, suspended_at = null, suspend_reason = null;
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
end $$;
select name, result from _hs order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 54 then 'HQ-SUBSCRIPTIONS: ALL PASS (54/54)'
            else 'HQ-SUBSCRIPTIONS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/54 ran' end from _hs;
