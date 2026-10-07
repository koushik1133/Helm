-- rescore3-fixes.sql — 0033 (security re-score #3). Every ATTACK case FAILS on the
-- 0001-0032 schema and passes after 0033; every LEGIT case is something the app
-- really does and must keep working. Attackers: a_staff (studio A 'sales' with
-- quotes/finance edit), a_admin, b_admin (another studio), anon (a link holder).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _r3; create temp table _r3(name text, result text); grant all on _r3 to anon, authenticated;
drop table if exists _r3_ids; create temp table _r3_ids(k text primary key, v uuid); grant all on _r3_ids to anon, authenticated;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform auth.login_anon(); end $$;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from _r3_ids where k = p $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _r3 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.total(p uuid) returns text language sql as $$ select pricing->>'total' from public.quotes where id = p $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        qB uuid := 'b0000000-0000-4000-8000-00000000da01'; k text; q uuid; v uuid;
begin
  perform pg_temp.su();
  -- leftovers of an interrupted earlier run (studio A in context for the archive trigger)
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test')); execute 'reset role';
  perform set_config('helm.allow_financial_delete', 'on', true);
  delete from public.event_tasks where title like 'r3-%';
  delete from public.quotes where org_id = orgA and code like 'R3-%';
  delete from public.coupons where code like 'R3%';
  perform set_config('helm.allow_financial_delete', '', true);
  perform pg_temp.su();
  insert into _r3_ids values ('orgA', orgA), ('orgB', orgB), ('qB', qB);
  insert into _r3_ids select 'staff', id from auth.users where email = 'a_staff@a.test';
  insert into _r3_ids select 'admin', id from auth.users where email = 'a_admin@a.test';
  insert into _r3_ids select 'badmin', id from auth.users where email = 'b_admin@b.test';
  insert into public.role_access(role,area,can_view,can_edit,org_id,updated_at)
    select 'sales', a, true, true, orgA, now() from unnest(array['staff']) a
    on conflict (role,area,org_id) do update set can_view=true, can_edit=true;
  foreach k in array array['otp','pay','mix','paid','zero','mark','mark2','mark3','coupon','mgr'] loop
    insert into public.quotes(code, title, status, client, pricing, current_version, approval_status, org_id,
                              approval_token, approval_token_expires_at, event_date, created_at, updated_at)
      values ('R3-'||upper(k), 'r3 '||k, 'quote', '{"name":"Rita","phone":"+91 98111 22222"}'::jsonb,
              case when k = 'zero' then '{}'::jsonb else '{"subtotal":100000,"discount":0,"gstPct":18}'::jsonb end, 1,
              case when k in ('pay','paid','zero','mark2','mark3') then 'approved' else 'sent' end, orgA,
              gen_random_uuid(), now() + interval '30 days', date '2026-12-01', now(), now())
      returning id into q;
    insert into _r3_ids values (k, q);
    insert into _r3_ids select 'tok_'||k, approval_token from public.quotes where id = q;
  end loop;
  -- an open payment request on mark2 (what the client's "Pay" click creates)
  insert into public.quote_payments(quote_id, provider, amount, status, simulated)
    values (pg_temp.id('mark2'), 'simulated', 118000, 'created', true);
  -- tasks: three in studio A, one in studio B
  foreach k in array array['tA1','tA2','tA3'] loop
    insert into public.event_tasks(quote_id, category, title, status, org_id)
      values (pg_temp.id('mgr'), 'decor', 'r3-'||k, 'assigned', orgA) returning id into v;
    insert into _r3_ids values (k, v);
  end loop;
  insert into public.event_tasks(quote_id, category, title, status, org_id)
    values (qB, 'decor', 'r3-tB', 'assigned', orgB) returning id into v;
  insert into _r3_ids values ('tB', v);
  -- coupons: studio A 10% (active), studio A 5% (inactive), studio B 50% (active)
  insert into public.coupons(code, kind, value, active, org_id) values
    ('R3SAVE10', 'percent', 10, true, orgA), ('R3OLD5', 'percent', 5, false, orgA), ('R3BONLY', 'percent', 50, true, orgB);
  -- channel flags: start clean (test DB only)
  delete from public.app_config where key = 'channels' and org_id in (orgA, orgB);
end $$;

-- ================= 1) channel flags are read from the LINK's studio ===============
-- studio B (newest row) turns on dev echo; studio A has no flags at all
do $$ begin
  perform pg_temp.su();
  insert into public.app_config(org_id, key, value, updated_at)
    values (pg_temp.id('orgB'), 'channels', '{"otp_dev_echo":true}'::jsonb, now());
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.anon();
  begin r := public.request_otp(pg_temp.id('tok_otp'), '+919811122222'); exception when others then r := jsonb_build_object('err', sqlerrm); end;
  perform pg_temp.res('flags: another studio''s dev-echo flag does not leak an OTP code on our link',
    r ? 'sent' and (r->>'dev_code') is null and coalesce(r->>'delivery','') <> 'dev_echo', coalesce(r::text,'null'));
end $$;
-- studio B now turns pay_live + sms_live on (newest row); studio A is still off
do $$ begin
  perform pg_temp.su();
  update public.app_config set value = '{"pay_live":true,"sms_live":true}'::jsonb, updated_at = now() + interval '1 second'
   where org_id = pg_temp.id('orgB') and key = 'channels';
end $$;
do $$ declare r jsonb; s text; begin
  perform pg_temp.anon();
  begin r := public.create_payment(pg_temp.id('tok_pay')); exception when others then r := jsonb_build_object('err', sqlerrm); end;
  perform pg_temp.su();
  select provider into s from public.quote_payments where quote_id = pg_temp.id('pay') order by created_at desc limit 1;
  perform pg_temp.res('flags: another studio''s pay_live flag does not switch our payment link to live',
    s = 'simulated', coalesce(s,'no row')||' / '||coalesce(r::text,'null'));
end $$;
do $$ declare s text; begin
  perform pg_temp.anon();
  begin perform public.request_otp(pg_temp.id('tok_otp'), '+919811122222'); exception when others then null; end;
  perform pg_temp.su();
  select status into s from public.notifications where quote_id = pg_temp.id('otp') and kind = 'otp' order by created_at desc, id desc limit 1;
  perform pg_temp.res('flags: another studio''s sms_live flag does not mark our SMS as sent', s = 'simulated', coalesce(s,'no row'));
end $$;
-- LEGIT: studio A's own (older) dev-echo row still works while B's row is newer
do $$ begin
  perform pg_temp.su();
  insert into public.app_config(org_id, key, value, updated_at)
    values (pg_temp.id('orgA'), 'channels', '{"otp_dev_echo":true}'::jsonb, now() - interval '1 day');
  update public.app_config set value = '{"otp_dev_echo":false}'::jsonb, updated_at = now() + interval '1 minute'
   where org_id = pg_temp.id('orgB') and key = 'channels';
  delete from public.quote_otps where quote_id = pg_temp.id('otp');
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.anon();
  begin r := public.request_otp(pg_temp.id('tok_otp'), '+919811122222'); exception when others then r := jsonb_build_object('err', sqlerrm); end;
  perform pg_temp.res('flags: our own studio''s dev-echo flag still works on our link (legit)',
    r->>'delivery' = 'dev_echo' and length(r->>'dev_code') = 6, coalesce(r::text,'null'));
end $$;
-- RLS (already enforced before 0033; kept as a regression check)
do $$ declare n int; v text; begin
  perform pg_temp.login('b_admin@b.test');
  begin insert into public.app_config(org_id, key, value) values (pg_temp.id('orgA'), 'r3probe', '{}'::jsonb); exception when others then null; end;
  begin update public.app_config set value = '{"otp_dev_echo":false}'::jsonb where org_id = pg_temp.id('orgA') and key = 'channels'; exception when others then null; end;
  perform pg_temp.su();
  select count(*) into n from public.app_config where org_id = pg_temp.id('orgA') and key = 'r3probe';
  select value::text into v from public.app_config where org_id = pg_temp.id('orgA') and key = 'channels';
  perform pg_temp.res('flags: another studio admin cannot write our config rows (RLS)', n = 0 and v like '%true%', n||' / '||coalesce(v,'null'));
end $$;

-- ================= 2) QC verification columns ======================================
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.event_tasks set verify_status = 'passed', verified_by = pg_temp.id('badmin'), verified_at = now()
         where id = pg_temp.id('tA1'); exception when others then null; end;
  perform pg_temp.su(); select verify_status into s from public.event_tasks where id = pg_temp.id('tA1');
  perform pg_temp.res('qc: a direct API update cannot mark a task QC-passed (or forge verified_by)', s = 'unverified', s);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.event_tasks(quote_id, category, title, status, verify_status, verified_by)
          values (pg_temp.id('mgr'), 'decor', 'r3-forged', 'completed', 'passed', pg_temp.id('badmin'));
  exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_tasks where title = 'r3-forged';
  perform pg_temp.res('qc: a direct API insert cannot create an already QC-passed task', n = 0, n||' stored');
end $$;
do $$ declare s text; b uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.verify_task(pg_temp.id('tA2'), true, 'ok');
  exception when others then perform pg_temp.res('qc: verify_task() still records the pass as the signed-in checker (legit)', false, sqlerrm); return; end;
  perform pg_temp.su(); select verify_status, verified_by into s, b from public.event_tasks where id = pg_temp.id('tA2');
  perform pg_temp.res('qc: verify_task() still records the pass as the signed-in checker (legit)', s = 'passed' and b = pg_temp.id('admin'), s||' / '||coalesce(b::text,'null'));
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.event_tasks set status = 'completed' where id = pg_temp.id('tA3');
  exception when others then perform pg_temp.res('qc: completing a task still queues it for QC (legit)', false, sqlerrm); return; end;
  perform pg_temp.su(); select verify_status into s from public.event_tasks where id = pg_temp.id('tA3');
  perform pg_temp.res('qc: completing a task still queues it for QC (legit)', s = 'pending', s);
end $$;

-- ================= 3a) a top-level subtotal cannot override line items ============
do $$ declare t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"subtotal":1,"discount":0,"guests":1000,"platePrice":5000}'::jsonb where id = pg_temp.id('mix');
  exception when others then null; end;
  perform pg_temp.su(); t := pg_temp.total(pg_temp.id('mix'));
  perform pg_temp.res('pricing: items + a tiny top-level subtotal cannot set a 1-rupee total', t is distinct from '1', 'total '||coalesce(t,'null'));
end $$;
do $$ declare t1 text; t2 text; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18}'::jsonb where id = pg_temp.id('mix');
    t1 := pg_temp.total(pg_temp.id('mix'));
    update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"subtotal":1,"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
     where id = pg_temp.id('mix');
    t2 := pg_temp.total(pg_temp.id('mix'));
  exception when others then perform pg_temp.res('pricing: legacy subtotal quotes and UI payloads still save (legit)', false, sqlerrm); return; end;
  perform pg_temp.res('pricing: legacy subtotal quotes and UI payloads still save (legit)', t1 = '236000' and t2 = '82600', t1||' / '||t2);
end $$;

-- ================= 3b) the total cannot drop below what was already paid ==========
do $$ begin
  perform pg_temp.login('a_admin@a.test');
  perform public.record_payment(pg_temp.id('paid'), 50000, 'cash', null, null, 'r3 advance', 'r3-adv-1');
exception when others then perform pg_temp.res('setup: advance recorded', false, sqlerrm);
end $$;
do $$ declare t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"subtotal":1000,"discount":0,"gstPct":18}'::jsonb where id = pg_temp.id('paid');
  exception when others then null; end;
  perform pg_temp.su(); t := pg_temp.total(pg_temp.id('paid'));
  perform pg_temp.res('money: the quote total cannot be lowered below the 50,000 already paid', t = '118000', 'total '||coalesce(t,'null'));
end $$;
do $$ declare t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"subtotal":50000,"discount":0,"gstPct":18}'::jsonb where id = pg_temp.id('paid');
  exception when others then perform pg_temp.res('money: lowering the total but staying above what was paid still works (legit)', false, sqlerrm); return; end;
  perform pg_temp.su(); t := pg_temp.total(pg_temp.id('paid'));
  perform pg_temp.res('money: lowering the total but staying above what was paid still works (legit)', t = '59000', 'total '||coalesce(t,'null'));
end $$;

-- ================= 3c) no money recorded against a 0 / missing total =============
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.record_payment(pg_temp.id('zero'), 5000, 'cash', null, null, 'r3 zero', 'r3-zero-1'); exception when others then null; end;
  perform pg_temp.su();
  update public.quotes set pricing = '{"subtotal":0,"discount":0,"gstPct":18}'::jsonb where id = pg_temp.id('zero');
  perform pg_temp.login('a_admin@a.test');
  begin perform public.record_payment(pg_temp.id('zero'), 5000, 'cash', null, null, 'r3 zero', 'r3-zero-2'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where quote_id = pg_temp.id('zero') and status = 'paid';
  perform pg_temp.res('money: a payment cannot be recorded on an event with no / zero total', n = 0, n||' paid row(s)');
end $$;

-- ================= 3d) mark_paid needs approval + an open payment request ========
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.mark_paid(pg_temp.id('mark'), 'r3'); exception when others then null; end;
  perform pg_temp.su(); select approval_status into s from public.quotes where id = pg_temp.id('mark');
  perform pg_temp.res('money: mark paid refused on a quote the client has not approved', s = 'sent', s);
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.mark_paid(pg_temp.id('mark3'), 'r3'); exception when others then null; end;
  perform pg_temp.su(); select approval_status into s from public.quotes where id = pg_temp.id('mark3');
  perform pg_temp.res('money: mark paid refused when no payment request exists (no receipt)', s = 'approved', s);
end $$;
do $$ declare s text; n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.mark_paid(pg_temp.id('mark2'), 'r3');
  exception when others then perform pg_temp.res('money: mark paid on an approved quote with an open request still works (legit)', false, sqlerrm); return; end;
  perform pg_temp.su(); select approval_status into s from public.quotes where id = pg_temp.id('mark2');
  select count(*) into n from public.quote_payments where quote_id = pg_temp.id('mark2') and status = 'paid';
  perform pg_temp.res('money: mark paid on an approved quote with an open request still works (legit)', s = 'paid' and n = 1, s||' / '||n);
end $$;

-- ================= 3e) coupons must be real, active, this studio's, not inflated ==
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"couponCode":"FAKE90","coupon":{"kind":"percent","value":90},"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
         where id = pg_temp.id('coupon'); exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('coupon');
  perform pg_temp.res('coupon: a made-up coupon code is refused', p not like '%FAKE90%', p);
end $$;
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"couponCode":"R3SAVE10","coupon":{"kind":"percent","value":90},"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
         where id = pg_temp.id('coupon'); exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('coupon');
  perform pg_temp.res('coupon: a real code with an inflated value (90% for a 10% coupon) is refused', p not like '%R3SAVE10%', p);
end $$;
do $$ declare p text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"couponCode":"R3BONLY","coupon":{"kind":"percent","value":50},"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
         where id = pg_temp.id('coupon'); exception when others then null; end;
  perform pg_temp.su(); select pricing::text into p from public.quotes where id = pg_temp.id('coupon');
  perform pg_temp.res('coupon: another studio''s coupon code is refused', p not like '%R3BONLY%', p);
end $$;
do $$ declare t1 text; t2 text; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"couponCode":"r3save10","coupon":{"kind":"percent","value":10},"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
     where id = pg_temp.id('coupon');
    t1 := pg_temp.total(pg_temp.id('coupon'));
    -- the coupon is retired later; editing the quote keeps the coupon it already had
    perform pg_temp.su(); update public.coupons set active = false where code = 'R3SAVE10';
    perform pg_temp.login('a_staff@a.test');
    update public.quotes set pricing = '{"chairs":120,"chairPrice":200,"guests":100,"platePrice":500,"other":0,"gstPct":18,"discount":0,"couponCode":"r3save10","coupon":{"kind":"percent","value":10},"catering":{"mode":"inhouse","amount":0,"gstPct":18}}'::jsonb
     where id = pg_temp.id('coupon');
    t2 := pg_temp.total(pg_temp.id('coupon'));
  exception when others then perform pg_temp.res('coupon: a valid coupon applies, and a quote keeps a coupon retired later (legit)', false, sqlerrm); return; end;
  perform pg_temp.res('coupon: a valid coupon applies, and a quote keeps a coupon retired later (legit)', t1 = '74340' and t2 = '78588', t1||' / '||t2);
end $$;

-- ================= 4) the org export carries no live client-link tokens ==========
do $$ declare r jsonb; n_tok int; n_q int; begin
  perform pg_temp.login('a_admin@a.test');
  begin r := public.export_tenant_organization_package();
  exception when others then perform pg_temp.res('export: no approval_token in the exported quotes', false, sqlerrm); return; end;
  select count(*) filter (where e ? 'approval_token'), count(*) into n_tok, n_q from jsonb_array_elements(r->'quotes') e;
  perform pg_temp.res('export: no approval_token in the exported quotes', n_tok = 0, n_tok||' of '||n_q||' quotes carry a token');
  perform pg_temp.res('export: the package still lists the studio''s quotes and organization (legit)',
    n_q > 0 and (r->'organizations'->>'id')::uuid = pg_temp.id('orgA') and (r->'quotes'->0) ? 'pricing', n_q||' quotes');
end $$;

-- ================= 5) cross-studio references ======================================
do $$ declare d uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.set_task_schedule(pg_temp.id('tA1'), null, null, pg_temp.id('tB')); exception when others then null; end;
  perform pg_temp.su(); select depends_on into d from public.event_tasks where id = pg_temp.id('tA1');
  perform pg_temp.res('tenant: a task cannot depend on another studio''s task', d is null, coalesce(d::text,'null'));
end $$;
do $$ declare m uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.quotes set manager_id = pg_temp.id('badmin') where id = pg_temp.id('mgr'); exception when others then null; end;
  perform pg_temp.su(); select manager_id into m from public.quotes where id = pg_temp.id('mgr');
  perform pg_temp.res('tenant: another studio''s user cannot be made our event manager', m is null, coalesce(m::text,'null'));
end $$;
do $$ declare d uuid; m uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin
    perform public.set_task_schedule(pg_temp.id('tA1'), null, null, pg_temp.id('tA2'));
    update public.quotes set manager_id = pg_temp.id('staff') where id = pg_temp.id('mgr');
  exception when others then perform pg_temp.res('tenant: own-studio task dependency and event manager still work (legit)', false, sqlerrm); return; end;
  perform pg_temp.su();
  select depends_on into d from public.event_tasks where id = pg_temp.id('tA1');
  select manager_id into m from public.quotes where id = pg_temp.id('mgr');
  perform pg_temp.res('tenant: own-studio task dependency and event manager still work (legit)',
    d = pg_temp.id('tA2') and m = pg_temp.id('staff'), coalesce(d::text,'null')||' / '||coalesce(m::text,'null'));
end $$;

-- ---- cleanup (superuser; owner maintenance switch for the guarded test events) ----
do $$ declare k text; begin
  perform pg_temp.su();
  perform auth.login_as(pg_temp.id('admin')); execute 'reset role';
  perform set_config('helm.allow_financial_delete', 'on', true);
  delete from public.event_tasks where title like 'r3-%';
  foreach k in array array['otp','pay','mix','paid','zero','mark','mark2','mark3','coupon','mgr'] loop
    begin delete from public.quotes where id = pg_temp.id(k); exception when others then null; end;
  end loop;
  delete from public.coupons where code like 'R3%';
  delete from public.app_config where key = 'channels' and org_id in (pg_temp.id('orgA'), pg_temp.id('orgB'));
  delete from public.role_access where role = 'sales' and area = 'staff' and org_id = pg_temp.id('orgA');
end $$;
select name, result from _r3 order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 26 then 'RESCORE3-FIXES: ALL PASS (26/26)'
            else 'RESCORE3-FIXES: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/26 ran' end from _r3;
