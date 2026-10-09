-- r4-sql-fixes.sql -- 0082: outbox claim re-checks recipient + switches (R4-01), price-list
-- save stays fast with a long bell history (R4-02), insights skip soft-deleted events (R4-03).
-- Fixture: a_admin/a_staff studio A, b_admin studio B. Rolled back. Local disposable PG only.
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
create or replace function pg_temp.claim_ids() returns uuid[] language plpgsql as $$
declare v jsonb; begin
  perform pg_temp.su(); execute 'set local role service_role';
  v := public.comms_outbox_claim(100);
  execute 'reset role';
  return coalesce((select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(v) e), '{}');
end $$;

-- fixture
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; st uuid;
begin
  perform pg_temp.su();
  select id into st from auth.users where email = 'a_staff@a.test';
  insert into public.member_profiles(user_id, phone, whatsapp, whatsapp_same) values (st, '+919876543210', null, true)
    on conflict (user_id) do update set phone = excluded.phone, whatsapp = null, whatsapp_same = true;
  insert into public.member_wa_optin(user_id, org_id, opted_in) values (st, a, true) on conflict (user_id) do update set opted_in = true, org_id = a;
  insert into public.comms_settings(org_id, pay_enabled, pay_channels, fu_enabled, fu_channels, wa_forward_enabled, wa_forward_roles, studio_whatsapp)
    values (a, true, array['email','whatsapp'], true, array['email'], true, '{"sales":["admin_message"]}', '919000000001')
    on conflict (org_id) do update set pay_enabled = true, pay_channels = array['email','whatsapp'], fu_enabled = true, fu_channels = array['email'],
      wa_forward_enabled = true, wa_forward_roles = '{"sales":["admin_message"]}', studio_whatsapp = '919000000001';
  insert into public.quotes(id, code, title, status, client, pricing, org_id, event_date, approval_status) values
    ('a0000000-0000-4000-8000-0000000082e1', 'R4-1', 'R4 One', 'confirmed', '{"name":"Riya","email":"riya@example.test","phone":"9811112222"}',
     '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', a, current_date + 10, 'approved'),
    ('a0000000-0000-4000-8000-0000000082e2', 'R4-2', 'R4 Two', 'quote', '{"name":"Kabir","email":"kabir@example.test"}',
     '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', a, current_date + 10, 'sent');
  insert into public.payment_milestones(id, quote_id, label, due_date, amount, status, org_id) values
    ('a0000000-0000-4000-8000-0000000082a1', 'a0000000-0000-4000-8000-0000000082e1', 'Advance', current_date + 2, 30000, 'due', a),
    ('a0000000-0000-4000-8000-0000000082a2', 'a0000000-0000-4000-8000-0000000082e1', 'Second', current_date + 2, 20000, 'due', a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- R4-01 recipient / switches re-checked at claim
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; st uuid; ids uuid[]; e1 uuid; w1 uuid; m1 uuid; f1 uuid; n integer;
begin
  perform pg_temp.su();
  update public.comms_outbox set sent_at = now(), status = 'skipped' where sent_at is null;   -- isolate this suite
  n := public._comms_queue_pay('a0000000-0000-4000-8000-0000000082a1', 'pre', 'due soon', false, null);
  perform pg_temp.res('01 auto reminder queued on email + whatsapp', n = 2, n::text);
  select id into e1 from public.comms_outbox where milestone_id = 'a0000000-0000-4000-8000-0000000082a1' and channel = 'email';
  select id into w1 from public.comms_outbox where milestone_id = 'a0000000-0000-4000-8000-0000000082a1' and channel = 'whatsapp';
  -- the planner corrects the client's e-mail after the reminder was queued
  update public.quotes set client = client || '{"email":"riya.correct@example.test"}' where id = 'a0000000-0000-4000-8000-0000000082e1';
  ids := pg_temp.claim_ids();
  perform pg_temp.res('02 stale e-mail recipient is NOT handed out (skipped)', not (e1 = any (ids))
    and (select status from public.comms_outbox where id = e1) = 'skipped', ids::text);
  perform pg_temp.res('03 unchanged WhatsApp recipient still handed out', w1 = any (ids), ids::text);

  -- automatic reminders switched off after queuing -> skipped; manual send-now unaffected
  n := public._comms_queue_pay('a0000000-0000-4000-8000-0000000082a2', 'pre', 'due soon', false, null);
  n := public._comms_queue_pay('a0000000-0000-4000-8000-0000000082a2', 'manual', 'due soon', true, null);
  update public.comms_settings set pay_enabled = false where org_id = a;
  ids := pg_temp.claim_ids();
  perform pg_temp.res('04 auto reminder skipped once reminders are switched off',
    not exists (select 1 from public.comms_outbox o where o.milestone_id = 'a0000000-0000-4000-8000-0000000082a2'
                and coalesce((o.payload ->> 'manual')::boolean, false) = false and o.id = any (ids))
    and not exists (select 1 from public.comms_outbox o where o.milestone_id = 'a0000000-0000-4000-8000-0000000082a2'
                and coalesce((o.payload ->> 'manual')::boolean, false) = false and o.status <> 'skipped'), ids::text);
  perform pg_temp.res('05 manual send-now still handed out',
    (select count(*) from public.comms_outbox o where o.milestone_id = 'a0000000-0000-4000-8000-0000000082a2'
       and (o.payload ->> 'manual')::boolean and o.id = any (ids)) = 2, ids::text);

  -- channel removed after queuing
  update public.comms_settings set pay_enabled = true where org_id = a;
  update public.payment_milestones set due_date = current_date + 1 where id = 'a0000000-0000-4000-8000-0000000082a2';
  n := public._comms_queue_pay('a0000000-0000-4000-8000-0000000082a2', 'due', 'due today', false, null);
  update public.comms_settings set pay_channels = array['email'] where org_id = a;
  ids := pg_temp.claim_ids();
  perform pg_temp.res('06 WhatsApp reminder skipped once WhatsApp is no longer a reminder channel',
    (select status from public.comms_outbox o where o.dedupe_key = 'pay:a0000000-0000-4000-8000-0000000082a2:due:whatsapp') = 'skipped'
    and exists (select 1 from public.comms_outbox o where o.dedupe_key = 'pay:a0000000-0000-4000-8000-0000000082a2:due:email' and o.id = any (ids)), ids::text);

  -- follow-up: client e-mail changed
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, 'a0000000-0000-4000-8000-0000000082e2', 'follow_up', 'email', 'kabir@example.test', '{"text":"hi"}', 'fu:r4:1:email') returning id into f1;
  update public.quotes set client = client || '{"email":"kabir.new@example.test"}' where id = 'a0000000-0000-4000-8000-0000000082e2';
  ids := pg_temp.claim_ids();
  perform pg_temp.res('07 follow-up to a replaced client e-mail is skipped', not (f1 = any (ids))
    and (select status from public.comms_outbox where id = f1) = 'skipped', ids::text);

  -- WhatsApp forward: member changed their number / role no longer forwards the type
  select id into st from auth.users where email = 'a_staff@a.test';
  insert into public.comms_outbox(org_id, user_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, st, 'wa_forward', 'whatsapp', '919876543210', '{"text":"x","type":"admin_message"}', 'fwd:r4:ok') returning id into m1;
  insert into public.comms_outbox(org_id, user_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, st, 'wa_forward', 'whatsapp', '919111111111', '{"text":"x","type":"admin_message"}', 'fwd:r4:old');
  insert into public.comms_outbox(org_id, user_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, st, 'wa_forward', 'whatsapp', '919876543210', '{"text":"x","type":"task_assigned"}', 'fwd:r4:type');
  ids := pg_temp.claim_ids();
  perform pg_temp.res('08 forward to the member''s current number is handed out', m1 = any (ids), ids::text);
  perform pg_temp.res('09 forward to an old member number is skipped',
    (select status from public.comms_outbox where dedupe_key = 'fwd:r4:old') = 'skipped');
  perform pg_temp.res('10 forward of a type the role no longer forwards is skipped',
    (select status from public.comms_outbox where dedupe_key = 'fwd:r4:type') = 'skipped');
  perform pg_temp.res('11 second claim hands out nothing already claimed (no double send)',
    not (m1 = any (pg_temp.claim_ids())));
exception when others then perform pg_temp.su(); insert into _uf values ('1x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- R4-02 price-list save with a long bell history stays well under a statement timeout
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  perform pg_temp.res('20 partial index on price_change notifications exists',
    to_regclass('public.notifications_price_change_idx') is not null);
  alter table public.notifications disable trigger zzz_comms_forward;
  insert into public.notifications(channel, kind, status, detail, org_id)
    select 'in_app', 'task_assigned', 'sent', '{}', a from generate_series(1, 60000);
  alter table public.notifications enable trigger zzz_comms_forward;
  insert into public.quotes(code, title, status, pricing, org_id, event_date)
    select 'R4P-' || g, 'r4p', 'quote', '{"gstPct":18,"chairs":10,"chairPrice":100}'::jsonb, a, current_date + 30 from generate_series(1, 400) g;
  analyze public.notifications;
  insert into public.app_config(org_id, key, value) values (a, 'pricing', '{"gstPct":18,"chairPrice":200}')
    on conflict (org_id, key) do update set value = excluded.value;
exception when others then perform pg_temp.su(); insert into _uf values ('2x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- statement_timeout only applies to top-level statements, so the saves run at top level
create or replace function pg_temp.try_t(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when query_canceled then return '57014 timed out'; when others then return sqlstate || ' ' || sqlerrm; end $$;
set statement_timeout = '1500ms';
select pg_temp.put('t21', pg_temp.try_t($q$update public.app_config set value = '{"gstPct":12,"chairPrice":250}' where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing'$q$));
select pg_temp.put('t22', pg_temp.try_t($q$update public.app_config set value = '{"gstPct":5,"chairPrice":300}' where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing'$q$));
set statement_timeout = 0;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  perform pg_temp.res('21 price-list save succeeds under a 1.5 s statement timeout', pg_temp.get('t21') = '', pg_temp.get('t21'));
  perform pg_temp.res('22 second save (dedupe path) also fast', pg_temp.get('t22') = '', pg_temp.get('t22'));
  perform pg_temp.res('23 fan-out bounded to 200 per save', (select count(*) from public.notifications where kind = 'price_change' and org_id = a) between 1 and 400);
  update public.quotes set deleted_at = now(), deleted_by = null, deleted_reason = 'manual' where code like 'R4P-%';
  perform public._r3_price_change_notify(a, 'pricing', array['chairPrice','x'], null);
  perform pg_temp.res('24 no alert for a soft-deleted quote',
    not exists (select 1 from public.notifications n join public.quotes q on q.id = n.quote_id
                    where q.code like 'R4P-%' and n.kind = 'price_change' and n.detail -> 'fields' = '["chairPrice","x"]'::jsonb));
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- R4-03 insights skip soft-deleted events
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r0 jsonb; r1 jsonb; ev0 jsonb; ev1 jsonb;
begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, lifecycle_stage, event_date, pricing, org_id) values
    ('a0000000-0000-4000-8000-0000000082d1', 'R4-D', 'Deleted one', 'confirmed', 'planning', '2026-03-10', '{"subtotal":12345,"discount":0,"gstPct":0,"total":12345}', a),
    ('a0000000-0000-4000-8000-0000000082d2', 'R4-K', 'Kept one', 'confirmed', 'planning', '2026-03-11', '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}', a);
  update public.quotes set deleted_at = now(), deleted_reason = 'manual' where id = 'a0000000-0000-4000-8000-0000000082d1';
  perform pg_temp.login('a_admin@a.test');
  r1 := public.insights_range('2026-03-01', '2026-03-31');
  ev1 := public.insights_events('2026-03-01', '2026-03-31');
  perform pg_temp.res('30 insights_range: deleted event not counted', r1 #>> '{counts,total}' = '1', r1 ->> 'counts');
  perform pg_temp.res('31 insights_range: deleted event money not counted', (r1 #>> '{money,revenue}')::numeric = 1000, r1 ->> 'money');
  perform pg_temp.res('32 insights_events: deleted event not listed', jsonb_array_length(ev1 -> 'events') = 1
    and position('R4-D' in ev1::text) = 0, ev1::text);
  perform pg_temp.login('b_admin@b.test');
  r0 := public.insights_range('2026-03-01', '2026-03-31');
  perform pg_temp.res('33 tenant scope kept: studio B sees none of A', position('R4-' in r0::text) = 0);
  perform pg_temp.anon();
  perform pg_temp.res('34 anon cannot call insights / claim', pg_temp.try('select public.insights_range(null, null)') like '42501%'
    and pg_temp.try('select public.comms_outbox_claim(1)') like '42501%');
exception when others then perform pg_temp.su(); insert into _uf values ('3x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- billing details on organizations (location, gst_number, brand.phone, brand.billing) are admin / controls-edit only
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; n integer;
begin
  perform pg_temp.su();
  delete from public.role_access where org_id = a and role = 'sales' and area = 'controls';
  perform pg_temp.login('a_staff@a.test');
  update public.organizations set gst_number = '29ABCDE1234F1Z5', location = 'Hacked',
    brand = coalesce(brand, '{}'::jsonb) || '{"phone":"1","billing":{"legal_name":"X"}}' where id = a;
  get diagnostics n = row_count;
  perform pg_temp.res('40 non-admin member cannot change billing details', n = 0, n::text);
  perform pg_temp.anon();
  update public.organizations set gst_number = 'x' where id = a;
  get diagnostics n = row_count;
  perform pg_temp.res('41 anon cannot change billing details', n = 0, n::text);
  perform pg_temp.su();
  perform pg_temp.res('42 no anon-callable function reads brand / billing',
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') and p.proname not in ('studio_slug_reserved', 'public_get_portal')
                   and (p.prosrc ~* 'billing' or p.prosrc ~* '\mbrand\M\s*(->|,|\)|$)')));
  update public.organizations set brand = coalesce(brand, '{}'::jsonb) || '{"billing":{"legal_name":"Secret Legal LLP","line1":"1 Hidden Rd"},"accent":"#123456"}' where id = a;
  update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000082bb', approval_token_revoked_at = null, approval_token_expires_at = null
   where id = 'a0000000-0000-4000-8000-0000000082e2';
  perform pg_temp.anon();
  perform pg_temp.put('portal', public.public_get_portal('a0000000-0000-4000-8000-0000000082bb')::text);
  perform pg_temp.su();
  perform pg_temp.res('43 signed-out portal never returns brand.billing', pg_temp.get('portal') is not null
    and position('Secret Legal' in pg_temp.get('portal')) = 0 and position('Hidden Rd' in pg_temp.get('portal')) = 0, left(pg_temp.get('portal'), 300));
  perform pg_temp.res('44 portal keeps the other brand keys', position('#123456' in pg_temp.get('portal')) > 0, left(pg_temp.get('portal'), 300));
exception when others then perform pg_temp.su(); insert into _uf values ('4x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.su();
select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R4-SQL-FIXES: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R4-SQL-FIXES: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
