-- budget-single-source-0199.sql - 0199: the quote is the single source of an event's budget + guests.
-- Proves: a quote-sourced lead gets the quote's budget (Rs 2 crore) and guests (60,000); a budget /
-- guests change on the quote (also by a signed-in studio member) reaches the linked lead + CRM archive;
-- other quote edits and a cleared budget never blank / reset the lead; another studio's lead is never
-- touched; the one-time fill only fills blanks (quote <- Discovery / lead, Discovery <- quote,
-- lead <- quote), never overwrites, never re-syncs name / status while filling, re-enables the sync
-- trigger, leaves the sample master alone and is idempotent. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _t199; create temp table _t199(name text, result text); grant all on _t199 to anon, authenticated;
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform auth.login_as((select id from auth.users where email = p_who));
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _t199 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.q(p_id uuid, p_code text, p_client jsonb, p_org uuid) returns void language sql as $$
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
  values (p_id, p_code, 'T199', 'quote', p_client, '{"subtotal":0,"discount":0,"gstPct":18,"total":0}'::jsonb, 1, 'none', p_org, now(), now());
$$;

-- re-runnable: clear this suite's own rows from an earlier run (local disposable DB only)
set session_replication_role = replica;
delete from public.event_discovery where quote_id::text like '%0000000199%';
delete from public.lead_archive where lead_id in (select id from public.leads where name like 'T199 %' or quote_id::text like '%0000000199%');
delete from public.leads where name like 'T199 %' or quote_id::text like '%0000000199%';
delete from public.quotes where id::text like '%0000000199%';
set session_replication_role = origin;

-- 1) a quote made directly in the flow -> CRM lead carries its budget + guests
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; l public.leads; begin
  perform pg_temp.q('a0000000-0000-4000-8000-0000000199a1', 'T199-01',
    '{"name":"T199 Shilpa","email":"t199.shilpa@d.test","budget":20000000,"guests":60000}', A);
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('new quote: lead source quote', l.source = 'quote', l.source);
  perform pg_temp.t('new quote: lead budget 2 crore', l.budget = 20000000, l.budget::text);
  perform pg_temp.t('new quote: lead guests 60000', l.guest_count = 60000, l.guest_count::text);
  perform pg_temp.t('new quote: CRM archive row has budget + guests',
    exists (select 1 from public.lead_archive a where a.lead_id = l.id and a.budget = 20000000 and a.guest_count = 60000), null);
end $$;

-- 2) budget / guests change on the quote -> lead follows; CRM archive keeps a new snapshot
do $$ declare l public.leads; begin
  update public.quotes set client = client || '{"budget":"25000000","guests":650}'::jsonb where id = 'a0000000-0000-4000-8000-0000000199a1';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('quote edit: lead budget follows', l.budget = 25000000, l.budget::text);
  perform pg_temp.t('quote edit: lead guests follow', l.guest_count = 650, l.guest_count::text);
  perform pg_temp.t('quote edit: latest CRM snapshot shows it',
    (select a.budget from public.lead_archive a where a.lead_id = l.id order by a.archived_at desc, a.id desc limit 1) = 25000000, null);
end $$;

-- 3) other quote edits never reset a lead budget; a cleared / junk budget never blanks it
do $$ declare l public.leads; begin
  update public.leads set budget = 777, guest_count = 77 where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  update public.quotes set client = client || '{"city":"Hyderabad"}'::jsonb where id = 'a0000000-0000-4000-8000-0000000199a1';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('unrelated edit: lead budget kept', l.budget = 777 and l.guest_count = 77, l.budget::text);
  update public.quotes set client = client || '{"budget":null,"guests":""}'::jsonb where id = 'a0000000-0000-4000-8000-0000000199a1';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('cleared budget: lead keeps its value', l.budget = 777 and l.guest_count = 77, l.budget::text);
  update public.quotes set client = client || '{"budget":"abc","guests":"-5"}'::jsonb where id = 'a0000000-0000-4000-8000-0000000199a1';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('junk budget: lead keeps its value', l.budget = 777 and l.guest_count = 77, l.budget::text);
end $$;

-- 4) a signed-in studio member saving step 1 (PostgREST update) -> lead synced
do $$ declare r text; l public.leads; begin
  r := pg_temp.as_try('a_admin@a.test', $q$update public.quotes set client = client || '{"budget":30000000,"guests":1200}'::jsonb
    where id = 'a0000000-0000-4000-8000-0000000199a1' returning id::text$q$);
  perform pg_temp.t('member: update allowed', r like 'ok:%', r);
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199a1';
  perform pg_temp.t('member: lead budget synced', l.budget = 30000000 and l.guest_count = 1200, coalesce(l.budget::text, 'null'));
end $$;

-- 5) converting a lead keeps its budget (convert carries it onto the quote, the sync keeps them equal)
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; v_lead uuid; r text; l public.leads; begin
  insert into public.leads(org_id, name, phone, email, source, budget, guest_count, status)
    values (A, 'T199 Lead Convert', '+91 90000 19901', 't199.conv@d.test', 'Website', 900000, 300, 'qualified') returning id into v_lead;
  r := pg_temp.as_try('a_admin@a.test', format('select (public.convert_lead_to_quote(%L)).id::text', v_lead));
  perform pg_temp.t('convert: ok', r like 'ok:%', r);
  select * into l from public.leads where id = v_lead;
  perform pg_temp.t('convert: lead keeps budget + guests', l.budget = 900000 and l.guest_count = 300, coalesce(l.budget::text, 'null'));
  perform pg_temp.t('convert: quote client has the same budget',
    (select public._b199_amount(q.client ->> 'budget') from public.quotes q where q.id = l.quote_id) = 900000, null);
end $$;

-- 6) cross-tenant: an org B quote with the same e-mail never touches org A's lead
do $$ declare B uuid := 'b0000000-0000-4000-8000-000000000001'; v_a numeric; begin
  insert into public.leads(org_id, name, email, budget, status) values ('a0000000-0000-4000-8000-000000000001', 'T199 Tenant', 't199.tenant@d.test', 111, 'new');
  perform pg_temp.q('b0000000-0000-4000-8000-0000000199b1', 'T199-B1', '{"name":"T199 Tenant","email":"t199.tenant@d.test","budget":999999}', B);
  select budget into v_a from public.leads where org_id = 'a0000000-0000-4000-8000-000000000001' and email = 't199.tenant@d.test';
  perform pg_temp.t('tenant: org A lead untouched', v_a = 111, v_a::text);
  perform pg_temp.t('tenant: org B got its own lead',
    exists (select 1 from public.leads where org_id = B and quote_id = 'b0000000-0000-4000-8000-0000000199b1' and budget = 999999), null);
end $$;

-- 7) fill blanks: build pre-0199 shaped rows (sync paused), then re-run the migration
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  -- c1: quote empty, Discovery 2 crore, lead empty + renamed + won (fill must not re-sync name / status)
  perform pg_temp.q('a0000000-0000-4000-8000-0000000199c1', 'T199-C1', '{"name":"T199 Sai Prasanna","email":"t199.sai@d.test"}', A);
  insert into public.event_discovery(quote_id, org_id, budget_max) values ('a0000000-0000-4000-8000-0000000199c1', A, 20000000);
  update public.leads set name = 'T199 Sai (CRM name)', status = 'won', budget = null, guest_count = 60000 where quote_id = 'a0000000-0000-4000-8000-0000000199c1';
  -- c2: lead has budget, quote + Discovery empty
  perform pg_temp.q('a0000000-0000-4000-8000-0000000199c2', 'T199-C2', '{"name":"T199 Lead Only","email":"t199.lo@d.test"}', A);
  insert into public.event_discovery(quote_id, org_id, notes) values ('a0000000-0000-4000-8000-0000000199c2', A, 'met');
  update public.leads set budget = 500000 where quote_id = 'a0000000-0000-4000-8000-0000000199c2';
  -- c3: all three set and different: nothing may change
  perform pg_temp.q('a0000000-0000-4000-8000-0000000199c3', 'T199-C3', '{"name":"T199 All Set","email":"t199.all@d.test","budget":100,"guests":10}', A);
  insert into public.event_discovery(quote_id, org_id, budget_max) values ('a0000000-0000-4000-8000-0000000199c3', A, 200);
  update public.leads set budget = 300, guest_count = 30 where quote_id = 'a0000000-0000-4000-8000-0000000199c3';
  -- c4: only an old budget_min on Discovery
  perform pg_temp.q('a0000000-0000-4000-8000-0000000199c4', 'T199-C4', '{"name":"T199 Min Only","email":"t199.min@d.test","guests":"80"}', A);
  insert into public.event_discovery(quote_id, org_id, budget_min) values ('a0000000-0000-4000-8000-0000000199c4', A, 150000);
  update public.leads set budget = null, guest_count = null where quote_id = 'a0000000-0000-4000-8000-0000000199c4';
end $$;
create temp table _t199_sm as
  select md5(coalesce(string_agg(q.id::text || coalesce(q.client::text, ''), ',' order by q.id), '')) as h
    from public.quotes q join public.organizations o on o.id = q.org_id and o.is_sample_master;
\i supabase/migrations/0199_budget_single_source.sql
do $$ declare l public.leads; c jsonb; d public.event_discovery; begin
  select client into c from public.quotes where id = 'a0000000-0000-4000-8000-0000000199c1';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199c1';
  perform pg_temp.t('fill c1: quote budget <- Discovery', public._b199_amount(c ->> 'budget') = 20000000, c::text);
  perform pg_temp.t('fill c1: quote guests <- lead', public._b199_guests(c ->> 'guests') = 60000, c::text);
  perform pg_temp.t('fill c1: lead budget <- quote', l.budget = 20000000, coalesce(l.budget::text, 'null'));
  perform pg_temp.t('fill c1: lead name + status not re-synced', l.name = 'T199 Sai (CRM name)' and l.status = 'won', l.name || ' ' || l.status);
  select client into c from public.quotes where id = 'a0000000-0000-4000-8000-0000000199c2';
  select * into d from public.event_discovery where quote_id = 'a0000000-0000-4000-8000-0000000199c2';
  perform pg_temp.t('fill c2: quote budget <- lead', public._b199_amount(c ->> 'budget') = 500000, c::text);
  perform pg_temp.t('fill c2: Discovery budget <- quote, notes kept', d.budget_max = 500000 and d.budget_min is null and d.notes = 'met', coalesce(d.budget_max::text, 'null'));
  select client into c from public.quotes where id = 'a0000000-0000-4000-8000-0000000199c3';
  select * into d from public.event_discovery where quote_id = 'a0000000-0000-4000-8000-0000000199c3';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199c3';
  perform pg_temp.t('fill c3: nothing overwritten',
    (c ->> 'budget') = '100' and (c ->> 'guests') = '10' and d.budget_max = 200 and l.budget = 300 and l.guest_count = 30, c::text);
  select client into c from public.quotes where id = 'a0000000-0000-4000-8000-0000000199c4';
  select * into d from public.event_discovery where quote_id = 'a0000000-0000-4000-8000-0000000199c4';
  select * into l from public.leads where quote_id = 'a0000000-0000-4000-8000-0000000199c4';
  perform pg_temp.t('fill c4: quote budget <- old Discovery min', public._b199_amount(c ->> 'budget') = 150000, c::text);
  perform pg_temp.t('fill c4: Discovery min left as is', d.budget_min = 150000 and d.budget_max is null, null);
  perform pg_temp.t('fill c4: lead budget + guests <- quote', l.budget = 150000 and l.guest_count = 80, coalesce(l.budget::text, 'null'));
  perform pg_temp.t('fill: sync trigger switched back on',
    (select tgenabled from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'quotes_sync_lead_upd') = 'O', null);
  perform pg_temp.t('fill: sample master quotes untouched',
    (select md5(coalesce(string_agg(q.id::text || coalesce(q.client::text, ''), ',' order by q.id), ''))
       from public.quotes q join public.organizations o on o.id = q.org_id and o.is_sample_master) = (select h from _t199_sm), null);
end $$;

-- 8) idempotent: a second run changes nothing
create temp table _t199_h as
  select (select md5(string_agg(id::text || coalesce(client::text, ''), ',' order by id)) from public.quotes) as hq,
         (select md5(string_agg(id::text || coalesce(budget::text, '') || coalesce(guest_count::text, ''), ',' order by id)) from public.leads) as hl,
         (select md5(string_agg(quote_id::text || coalesce(budget_min::text, '') || coalesce(budget_max::text, ''), ',' order by quote_id)) from public.event_discovery) as hd;
\i supabase/migrations/0199_budget_single_source.sql
do $$ begin
  perform pg_temp.t('rerun: nothing changed',
    (select md5(string_agg(id::text || coalesce(client::text, ''), ',' order by id)) from public.quotes) = (select hq from _t199_h)
    and (select md5(string_agg(id::text || coalesce(budget::text, '') || coalesce(guest_count::text, ''), ',' order by id)) from public.leads) = (select hl from _t199_h)
    and (select md5(string_agg(quote_id::text || coalesce(budget_min::text, '') || coalesce(budget_max::text, ''), ',' order by quote_id)) from public.event_discovery) = (select hd from _t199_h), null);
  perform pg_temp.t('helpers: no execute for authenticated / anon',
    not has_function_privilege('authenticated', 'public._b199_amount(text)', 'execute')
    and not has_function_privilege('anon', 'public._b199_guests(text)', 'execute'), null);
  perform pg_temp.t('sync fn still SECURITY DEFINER',
    coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.sync_quote_to_lead()')), false), null);
end $$;

select case when count(*) filter (where result <> 'PASS') = 0
            then 'BUDGET-SINGLE-SOURCE-0199: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'BUDGET-SINGLE-SOURCE-0199: FAIL' end as summary from _t199;
select name, result from _t199 where result <> 'PASS';
