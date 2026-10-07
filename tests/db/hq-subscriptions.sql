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
  perform public.hq_upsert_tax_rule('IN', null, 'IN_GST_INTER', 12, null, current_date, null, true);
  r := public.hq_record_payment('b0000000-0000-4000-8000-000000000001', 1120, current_date, 'cash', 'INR', current_date - 25, current_date + 5);
  perform pg_temp.res('39 billing settings + IN tax rule: new rate + prefix used, seller snapshot on invoice',
    (r->>'gst_amount')::numeric = 120 and r->>'invoice_no' like 'HLM/%'
    and public.hq_invoice((r->>'id')::uuid)#>>'{seller,legal_name}' = 'Helm Technologies Pvt Ltd', r::text);
  perform public.hq_set_billing_settings('Helm', null, null, 18, 'HELM-');
  perform public.hq_upsert_tax_rule('IN', null, 'IN_GST_INTER', 12, null, current_date, null, false);
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

-- ---- 13) studio account profile + GST split ---------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.my_studio_account_update('{"legal_business_name":"Studio A LLP","state":"Telangana","gstin":"36abcde1234f1z5","primary_contact_phone":"+91 98765 43210","country":"in"}');
  perform pg_temp.res('55 studio admin edits own account (normalised)', r->>'gstin' = '36ABCDE1234F1Z5' and r->>'primary_contact_phone' = '+919876543210'
    and r->>'country' = 'IN', r::text);
  e := pg_temp.try('select public.my_studio_account_update(''{"primary_contact_phone":"98765"}'')') || '|'
    || pg_temp.try('select public.my_studio_account_update(''{"gstin":"NOTAGSTIN"}'')') || '|'
    || pg_temp.try('select public.my_studio_account_update(''{"website":"javascript:alert(1)"}'')') || '|'
    || pg_temp.try('select public.my_studio_account_update(''{"org_id":"b0000000-0000-4000-8000-000000000001"}'')');
  perform pg_temp.res('56 bad phone / GSTIN / website / unknown field rejected', e = '22023|22023|22023|22023', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select public.my_studio_account_update(''{"city":"X"}'')');
  r := public.my_studio_account();
  perform pg_temp.res('57 non-admin member: edit denied, no phone numbers', e = '42501' and not r ? 'primary_contact_phone'
    and r->>'legal_business_name' = 'Studio A LLP', e || r::text);
  perform pg_temp.login('b_admin@b.test');
  perform public.my_studio_account_update('{"city":"Pune"}');
  perform pg_temp.su();
  perform pg_temp.res('58 Org B admin edit lands only on Org B (A untouched)',
    (select city from public.studio_account where org_id = 'b0000000-0000-4000-8000-000000000001') = 'Pune'
    and (select coalesce(city, '') from public.studio_account where org_id = 'a0000000-0000-4000-8000-000000000001') <> 'Pune', '');
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try('select public.hq_set_studio_account(''a0000000-0000-4000-8000-000000000001'', ''{"city":"Hack"}'')');
  perform pg_temp.res('59 Org B cannot edit Org A (HQ RPC refused)', e = '42501', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select count(*) from public.studio_account');
  perform pg_temp.res('60 no direct table access to studio_account', e = '42501', e);
  perform pg_temp.op();
  r := public.hq_studio_detail('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('61 HQ reads account in detail + list', r#>>'{account,legal_business_name}' = 'Studio A LLP'
    and (select s.state from public.hq_studios('Studio A', null, 5, 0) s limit 1) = 'Telangana', r::text);
  r := public.hq_set_studio_account('a0000000-0000-4000-8000-000000000001', '{"secondary_contact_email":"Ops@A.test"}');
  perform pg_temp.res('62 HQ edits account (audited)', r->>'secondary_contact_email' = 'ops@a.test'
    and exists (select 1 from jsonb_array_elements(public.hq_audit(current_date, current_date)->'rows') x where x->>'action' = 'hq.studio_account.set'), r::text);
end $$;
do $$ declare r jsonb; i1 jsonb; i2 jsonb; begin
  perform pg_temp.op();
  perform public.hq_set_billing_state('Telangana');
  r := public.hq_record_payment('a0000000-0000-4000-8000-000000000001', 1180, current_date, 'upi');
  i1 := public.hq_invoice((r->>'id')::uuid);
  perform pg_temp.res('63 same state → CGST + SGST half each; buyer from account profile',
    i1#>>'{gst_split,type}' = 'CGST_SGST' and (i1#>>'{gst_split,cgst}')::numeric = 90 and (i1#>>'{gst_split,sgst}')::numeric = 90
    and i1#>>'{buyer,legal_name}' = 'Studio A LLP' and i1#>>'{buyer,gstin}' = '36ABCDE1234F1Z5' and i1#>>'{buyer,state}' = 'Telangana'
    and i1#>>'{seller,state}' = 'Telangana', i1::text);
  perform public.hq_set_studio_account('a0000000-0000-4000-8000-000000000001', '{"state":"Karnataka"}');
  i2 := public.hq_invoice((public.hq_record_payment('a0000000-0000-4000-8000-000000000001', 1180, current_date, 'upi')->>'id')::uuid);
  perform pg_temp.res('64 different state → IGST full (new payment); old invoice unchanged after the account change',
    i2#>>'{gst_split,type}' = 'IGST' and (i2#>>'{gst_split,igst}')::numeric = 180 and (i2#>>'{gst_split,cgst}')::numeric = 0
    and public.hq_invoice((r->>'id')::uuid) = i1, i2::text);
  perform public.hq_set_billing_state(null);
  perform pg_temp.su(); update public.studio_account set state = 'Telangana' where org_id = 'a0000000-0000-4000-8000-000000000001';
end $$;
do $$ declare n int; begin perform pg_temp.su();
  select count(*) into n from public.studio_account where primary_contact_email is not null;
  perform pg_temp.res('65 prefill: primary contact filled from the creating admin', n >= 1, n::text);
end $$;

-- ---- 14) global tax engine, FX, realisation, consent -----------------------------------------------------
do $$ declare B uuid := 'b0000000-0000-4000-8000-000000000001'; r jsonb; i jsonb; e text; begin
  perform pg_temp.op();
  perform public.hq_set_seller_tax('IN', 'Telangana', 'AD360325000001X', current_date - 100, current_date + 200);
  perform public.hq_set_studio_account(B, '{"country":"US","state":"CA","is_business":"false","billing_currency":"USD"}');
  r := public.hq_record_payment(B, 100, current_date, 'card', 'USD', null, null, 'wire', 83.5);
  i := public.hq_invoice((r->>'id')::uuid);
  perform pg_temp.setv('payLUT', r->>'id');
  perform pg_temp.res('66 foreign buyer + valid LUT → EXPORT_LUT_ZERO 0% with LUT note; place of supply = country',
    i#>>'{tax,regime}' = 'EXPORT_LUT_ZERO' and (i->>'gst_amount')::numeric = 0 and i#>>'{tax,note}' like '%under LUT%AD360325000001X'
    and i#>>'{tax,lut_number}' = 'AD360325000001X' and i->>'place_of_supply' = 'US' and i->'gst_split' = 'null'::jsonb, i::text);
  perform pg_temp.res('67 FX: currency + rate + INR equivalent stored (100 USD × 83.5 = 8350)',
    i->>'currency' = 'USD' and (i->>'fx_rate_to_inr')::numeric = 83.5 and (i->>'inr_equivalent')::numeric = 8350, i::text);
  e := pg_temp.try('select public.hq_record_payment(''' || B || ''', 100, current_date, ''card'', ''USD'')');
  perform pg_temp.res('68 FX: a non-INR payment without a rate is refused', e = '22023', e);
  perform public.hq_set_seller_tax('IN', 'Telangana', null, null, null);
  i := public.hq_invoice((public.hq_record_payment(B, 118, current_date, 'card', 'USD', null, null, null, 83)->>'id')::uuid);
  perform pg_temp.res('69 foreign buyer, no LUT → EXPORT_IGST_PAID 18% IGST, refundable',
    i#>>'{tax,regime}' = 'EXPORT_IGST_PAID' and (i->>'gst_amount')::numeric = 18 and (i#>>'{tax,refundable}')::boolean
    and i#>'{tax,components}'->0->>'name' = 'IGST', i::text);
  perform public.hq_set_studio_account(B, '{"country":"DE","state":"","is_business":"true","tax_id_type":"EU_VAT","tax_id":"de 123456789"}');
  i := public.hq_invoice((public.hq_record_payment(B, 100, current_date, 'bank', 'EUR', null, null, null, 90)->>'id')::uuid);
  perform pg_temp.res('70 EU business with VAT ID → reverse-charge note, buyer tax id snapshotted',
    i#>>'{tax,note}' like '%Reverse charge — VAT to be accounted for by the recipient%' and (i#>>'{tax,reverse_charge}')::boolean
    and i#>>'{buyer,tax_id}' = 'DE123456789' and i#>>'{buyer,tax_id_type}' = 'EU_VAT' and i#>>'{buyer,country}' = 'DE', i::text);
  perform public.hq_set_seller_tax('IN', 'Telangana', 'AD360325000001X', current_date - 100, current_date + 200);
  i := public.hq_invoice((public.hq_record_payment(B, 100, current_date, 'bank', 'EUR', null, null, null, 90)->>'id')::uuid);
  perform pg_temp.res('71 EU business + LUT → REVERSE_CHARGE 0% with both notes', i#>>'{tax,regime}' = 'REVERSE_CHARGE'
    and (i->>'gst_amount')::numeric = 0 and i#>>'{tax,note}' like '%LUT%Reverse charge%', i::text);
  perform public.hq_set_studio_account(B, '{"country":"SG","tax_id_type":"","tax_id":""}');
  perform public.hq_upsert_tax_rule('SG', null, 'LOCAL_REGISTERED', 9, 'GST registered in Singapore', date '2024-01-01', null, true);
  r := public.hq_record_payment(B, 109, current_date, 'card', 'SGD', null, null, null, 62);
  i := public.hq_invoice((r->>'id')::uuid);
  perform pg_temp.res('72 LOCAL_REGISTERED rule applies its rate (9% on 109 = 9)', i#>>'{tax,regime}' = 'LOCAL_REGISTERED'
    and (i->>'gst_amount')::numeric = 9 and i#>>'{tax,note}' = 'GST registered in Singapore', i::text);
  perform public.hq_upsert_tax_rule('SG', null, 'LOCAL_REGISTERED', 5, 'changed', date '2024-01-01', null, true);
  perform public.hq_set_studio_account(B, '{"legal_business_name":"Renamed Pte Ltd","country":"AE"}');
  perform pg_temp.res('73 snapshot: old invoice unchanged after a rule change AND an account change',
    public.hq_invoice((r->>'id')::uuid) = i, public.hq_invoice((r->>'id')::uuid)::text);
  perform public.hq_upsert_tax_rule('SG', null, 'LOCAL_REGISTERED', 5, 'changed', date '2024-01-01', null, false);
  perform pg_temp.su(); e := pg_temp.try('update public.subscription_payments set tax_regime = ''NO_TAX'' where id = ''' || (r->>'id') || '''');
  perform pg_temp.res('74 tax snapshot columns cannot be edited even by the owner', e = '42501', e);
end $$;
do $$ declare B uuid := 'b0000000-0000-4000-8000-000000000001'; e text := ''; t text; begin
  perform pg_temp.op();
  foreach t in array array['IN_GSTIN:12345','IN_PAN:ABCDE12345','EU_VAT:US123456789','UK_VAT:GB12','AU_ABN:1234567890',
      'CA_GST:123456789XX0001','SG_GST:12345','AE_TRN:12345678901234','US_EIN:12-345','OTHER:!!'] loop
    e := e || pg_temp.try(format('select public.hq_set_studio_account(%L, %L)', B,
           jsonb_build_object('tax_id_type', split_part(t, ':', 1), 'tax_id', split_part(t, ':', 2))::text)) || ',';
  end loop;
  perform pg_temp.res('75 every tax-id type rejects a malformed id', e = repeat('22023,', 10), e);
  e := pg_temp.try(format('select public.hq_set_studio_account(%L, %L)', B, '{"tax_id_type":"UK_VAT","tax_id":"GB123456789"}'))
    || '|' || pg_temp.try(format('select public.hq_set_studio_account(%L, %L)', B, '{"country":"AE","pan":"ABCDE1234F"}'))
    || '|' || pg_temp.try(format('select public.hq_set_studio_account(%L, %L)', B, '{"payment_mandate_ref":"4111 1111 1111 1111"}'));
  perform pg_temp.res('76 valid UK VAT accepted; PAN outside India refused; card-number-like mandate ref refused', e = '|22023|22023', e);
end $$;
do $$ declare r jsonb; e text; n int; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.my_studio_account_update(''{"terms_accepted_at":"2001-01-01T00:00:00Z"}'')') || '|'
    || pg_temp.try('select public.my_studio_account_update(''{"data_processing_consent_at":"2001-01-01"}'')');
  r := public.my_studio_account_update('{"terms_version_accepted":"2026-10","consent_version":"dp-1","marketing_opt_in":"true","business_type":"wedding"}');
  perform pg_temp.su(); select count(*) into n from public.studio_consent_log where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('77 consent: timestamps set by the server (client values refused), consent log written',
    e = '22023|22023' and (r->>'terms_accepted_at')::timestamptz > now() - interval '1 minute'
    and (r->>'data_processing_consent_at')::timestamptz > now() - interval '1 minute' and (r->>'marketing_opt_in')::boolean and n = 3, e || r::text || n);
end $$;
do $$ declare r jsonb; e text; begin
  perform pg_temp.op(); r := public.hq_unrealised_exports();
  perform pg_temp.res('78 HQ lists export payments not yet realised', jsonb_array_length(r) >= 3
    and not exists (select 1 from jsonb_array_elements(r) x where x->>'tax_regime' not in ('EXPORT_LUT_ZERO','EXPORT_IGST_PAID','REVERSE_CHARGE')), r::text);
  perform public.hq_record_realisation(pg_temp.getv('payLUT')::uuid, 'FIRA-0001', current_date);
  e := pg_temp.try('select public.hq_record_realisation(''' || pg_temp.getv('payLUT') || ''', ''FIRA-0002'', current_date)');
  perform pg_temp.res('79 realisation recorded once (FIRA/FIRC), then locked; gone from the unrealised list', e = '22023'
    and not exists (select 1 from jsonb_array_elements(public.hq_unrealised_exports()) x where x->>'id' = pg_temp.getv('payLUT')), e);
  perform public.hq_upsert_plan_price('pro', 'USD', 49, 490);
  r := public.hq_overview();
  perform pg_temp.res('80 MRR in INR present', r#>'{billing}' ? 'mrr_inr' and (r#>>'{billing,mrr_inr}')::numeric >= 0, r->>'billing');
  perform public.hq_set_seller_tax('IN', null, null, null, null);
end $$;

-- cleanup of mutable state that other suites read (payments are append-only by design)
do $$ begin perform pg_temp.su();
  update public.studio_subscriptions set status = 'active', prev_status = null, suspended_at = null, suspend_reason = null;
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
end $$;
select name, result from _hs order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 80 then 'HQ-SUBSCRIPTIONS: ALL PASS (80/80)'
            else 'HQ-SUBSCRIPTIONS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/80 ran' end from _hs;
