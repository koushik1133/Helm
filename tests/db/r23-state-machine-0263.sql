-- r23-state-machine-0263.sql - 0263: ONE canonical quote / event stage, every move logged (deferred triggers at
-- COMMIT on quotes / event_closure / client_link_opens), allowed-moves guard (WARN default, ENFORCE switch), domain
-- events + consumer cursors, self-heal + sweep for links that ran out, Control Center + HQ switches, studio isolation,
-- a logging failure never breaks the original write, the 0141 / 0220 empty-draft scans never see the new tables.
-- Every RPC step is its OWN top-level statement (= its own transaction, like a PostgREST call), because the stage is
-- recorded when the transaction COMMITS. Throwaway local PG only: the suite clears its own rows first.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
\i supabase/migrations/0263_quote_stage_machine.sql
\set cases `cat tests/db/r23-stage-cases.json`
drop table if exists _r263; create table _r263(n serial, name text, result text); grant all on _r263 to anon, authenticated, service_role;
grant usage on sequence _r263_n_seq to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform set_config('request.path', '', false); perform set_config('helm.stage_source', '', false); end $$;
create or replace function pg_temp.as(p_email text, p_path text default null) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || '{"aal":"aal2"}'::jsonb)::text, false);
  perform set_config('request.path', coalesce(p_path, ''), false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default '') returns void language sql as $$
  insert into _r263(name, result) values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return 'ok:' || coalesce(v, ''); exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
create or replace function pg_temp.stage(p uuid) returns text language sql as $$ select stage from public.quote_stage_current where quote_ref = p $$;
create or replace function pg_temp.last(p uuid) returns text language sql as $$
  select concat_ws('|', from_stage, to_stage, source, coalesce(via, ''), legal::text) from public.quote_stage_transitions
   where quote_ref = p order by id desc limit 1 $$;
create or replace function pg_temp.n(p uuid) returns int language sql as $$ select count(*)::int from public.quote_stage_transitions where quote_ref = p $$;
grant execute on function pg_temp.su(), pg_temp.as(text, text), pg_temp.t(text, boolean, text), pg_temp.try(text),
  pg_temp.stage(uuid), pg_temp.last(uuid), pg_temp.n(uuid) to anon, authenticated, service_role;

-- ---- setup: Studio A quotes ...263a1..a5, Studio B ...263b1; an HQ operator ----------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  ids uuid[] := array['a0000000-0000-4000-8000-0000000263a1', 'a0000000-0000-4000-8000-0000000263a2', 'a0000000-0000-4000-8000-0000000263a3',
                      'a0000000-0000-4000-8000-0000000263a4', 'a0000000-0000-4000-8000-0000000263a5', 'b0000000-0000-4000-8000-0000000263b1']::uuid[];
begin
  perform pg_temp.su();
  -- throwaway test database only: this suite's own rows
  delete from public.quote_stage_transitions where quote_ref = any(ids);
  delete from public.quote_stage_current where quote_ref = any(ids);
  delete from public.quote_stage_warnings where quote_ref = any(ids);
  delete from public.domain_events where entity_ref = any(ids);
  delete from public.domain_event_cursors where consumer like 'r23-%';
  delete from public.event_cancellations where quote_id = any(ids);
  delete from public.event_closure where quote_id = any(ids);
  delete from public.client_link_opens where quote_id = any(ids);
  delete from public.quote_consents where quote_id = any(ids);
  delete from public.quote_payments where quote_id = any(ids);
  delete from public.payment_milestones where quote_id = any(ids);
  delete from public.lifecycle_stage_overrides where quote_id = any(ids);
  delete from public.app_config where key = 'stage_machine' and org_id in (a, b);
  update public.helm_stage_settings set tracking_enabled = true, guard_mode = 'warn', emit_events = true where id;
  update public.profiles set full_name = 'Ada Admin' where email = 'a_admin@a.test';
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'admin@helm.events');
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'admin@helm.events';
end $$;
-- the quotes themselves: inserted (and deleted) in their own transactions so the insert trigger runs at commit
delete from public.quotes where id in ('a0000000-0000-4000-8000-0000000263a1', 'a0000000-0000-4000-8000-0000000263a2',
  'a0000000-0000-4000-8000-0000000263a3', 'a0000000-0000-4000-8000-0000000263a4', 'a0000000-0000-4000-8000-0000000263a5',
  'b0000000-0000-4000-8000-0000000263b1');
delete from public.quote_stage_transitions where quote_ref::text like '_0000000-0000-4000-8000-0000000263__';
delete from public.quote_stage_current where quote_ref::text like '_0000000-0000-4000-8000-0000000263__';
delete from public.domain_events where entity_ref::text like '_0000000-0000-4000-8000-0000000263__';
insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token,
                          approval_token_expires_at, lifecycle_stage, event_date, created_at, updated_at)
select x.id::uuid, x.code, x.title, x.st, '{"name":"C263"}'::jsonb, '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}'::jsonb,
       1, x.ap, x.org::uuid, x.tok::uuid, x.exp, 'quote', (now() at time zone 'Asia/Kolkata')::date - 1, now(), now()
  from (values
    ('a0000000-0000-4000-8000-0000000263a1', 'A-263-1', 'Stage263 Journey', 'quote', 'none', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000263f1', null::timestamptz),
    ('a0000000-0000-4000-8000-0000000263a2', 'A-263-2', 'Stage263 Expiry', 'confirmed', 'sent', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000263f2', now() + interval '2 seconds'),
    ('a0000000-0000-4000-8000-0000000263a3', 'A-263-3', 'Stage263 Shelf', 'quote', 'none', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000263f3', null),
    ('a0000000-0000-4000-8000-0000000263a4', 'A-263-4', 'Stage263 Guard', 'quote', 'none', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000263f4', null),
    ('a0000000-0000-4000-8000-0000000263a5', 'A-263-5', 'Stage263 Safety', 'quote', 'none', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000263f5', null),
    ('b0000000-0000-4000-8000-0000000263b1', 'B-263-1', 'Stage263 B', 'quote', 'none', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000263f6', null)
  ) x(id, code, title, st, ap, org, tok, exp);

-- ==== 1) the pure rule: every case in tests/db/r23-stage-cases.json (the JS copy is tested on the same file) =========
drop table if exists _r263_cases; create temp table _r263_cases as select :'cases'::jsonb as j;
do $$ declare c jsonb; v text; bad text := ''; n int := 0; begin
  for c in select * from jsonb_array_elements((select j from _r263_cases)) loop
    v := public.helm_quote_stage(c ->> 0, c ->> 1, c ->> 2, (c ->> 3)::boolean, (c ->> 4)::boolean, (c ->> 5)::boolean, c ->> 6, (c ->> 7)::boolean);
    n := n + 1;
    if v is distinct from c ->> 8 then bad := bad || ' [' || c::text || ' got ' || coalesce(v, 'null') || ']'; end if;
  end loop;
  perform pg_temp.t('01 stage rule: all ' || n || ' shared cases', bad = '' and n >= 30, bad);
  perform pg_temp.t('02 labels + order for every stage', (select bool_and(public.helm_quote_stage_label(s) <> s and public.helm_quote_stage_order(s) is not null)
    from unnest(array['lead','draft','sent','viewed','approved','advance_paid','confirmed','in_progress','event_day','completed','closed','cancelled','expired','lost']) s), null);
end $$;

-- ==== 2) backfill + insert ==========================================================================================
select pg_temp.t('03 backfill: every quote has exactly one current stage',
  not exists (select 1 from public.quotes q where q.org_id is not null and not exists (select 1 from public.quote_stage_current c where c.quote_ref = q.id)), null);
select pg_temp.t('04 backfill rows: source backfill, from null, no domain event',
  exists (select 1 from public.quote_stage_transitions where source = 'backfill')
  and not exists (select 1 from public.quote_stage_transitions where source = 'backfill' and from_stage is not null)
  and not exists (select 1 from public.domain_events e join public.quote_stage_transitions t on (e.payload ->> 'transition_id')::bigint = t.id where t.source = 'backfill'), null);
select pg_temp.t('05 new quote: one first row at COMMIT (from none -> draft, source system, legal)',
  pg_temp.n('a0000000-0000-4000-8000-0000000263a1') = 1 and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'draft|system||true'
  and pg_temp.stage('a0000000-0000-4000-8000-0000000263a2') = 'sent' and pg_temp.stage('b0000000-0000-4000-8000-0000000263b1') = 'draft',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1'));
\i supabase/migrations/0263_quote_stage_machine.sql
select pg_temp.t('06 re-run of 0263: backfill adds nothing, settings + moves kept',
  pg_temp.n('a0000000-0000-4000-8000-0000000263a1') = 1 and (select count(*) from public.helm_stage_settings) = 1
  and (select count(*) from public.quote_stage_moves) >= 100, null);

-- ==== 3) the full journey through the REAL RPCs (each call = its own transaction) ===================================
-- sent: a studio user's RPC (simulated send: claims + /rpc path, the update itself as the RPC owner)
do $$ begin perform pg_temp.as('a_admin@a.test', '/rpc/send_quote_link'); execute 'reset role';
  update public.quotes set status = 'confirmed', approval_status = 'sent' where id = 'a0000000-0000-4000-8000-0000000263a1'; end $$;
select pg_temp.su();
select pg_temp.t('07 sent: source rpc, via the RPC name, actor = the admin',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'draft|sent|rpc|send_quote_link|true'
  and (select actor_email from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' order by id desc limit 1) = 'a_admin@a.test',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1'));
-- viewed: the client opens the approval link (anon RPC public_link_opened)
-- (the row public_link_opened writes; written directly so studio link settings left by earlier suites can't hide it)
do $$ begin perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('request.path', '/rpc/public_link_opened', false);
  insert into public.client_link_opens(quote_id, kind, org_id) values ('a0000000-0000-4000-8000-0000000263a1', 'quote', 'a0000000-0000-4000-8000-000000000001')
  on conflict (quote_id, kind) do update set last_opened_at = now(), open_count = public.client_link_opens.open_count + 1; end $$;
select pg_temp.su();
select pg_temp.t('08 viewed: client link opened (source client)', pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'sent|viewed|client|public_link_opened|true',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1'));
-- approved: the client's OTP consent + approval in ONE transaction (the consent trigger also moves lifecycle to
-- confirmed): exactly ONE move is recorded, never the in-between "confirmed"
do $$ begin perform auth.login_anon(); perform set_config('request.path', '/rpc/public_approve_quote', false); execute 'reset role';
  insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, created_at)
    values ('a0000000-0000-4000-8000-0000000263a1', '9999999999', 'C263', true, true, now());
  update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000263a1'; end $$;
select pg_temp.su();
select pg_temp.t('09 approved: one move per commit (viewed -> approved, client), lifecycle auto-confirmed',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'viewed|approved|client|public_approve_quote|true'
  and (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-0000000263a1') = 'confirmed'
  and pg_temp.n('a0000000-0000-4000-8000-0000000263a1') = 4, pg_temp.last('a0000000-0000-4000-8000-0000000263a1'));
insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated)
  values ('a0000000-0000-4000-8000-0000000263a1', 'a0000000-0000-4000-8000-000000000001', 'razorpay', 3000, 'created', true);
select pg_temp.as('a_admin@a.test', '/rpc/mark_paid');
select pg_temp.try($q$select public.mark_paid('a0000000-0000-4000-8000-0000000263a1', 'UPI-263')::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('10 mark_paid (advance in at Confirmed) -> confirmed', :'r' like 'ok:%' and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'approved|confirmed|rpc|mark_paid|true',
  :'r' || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a1'), ''));
select pg_temp.as('a_admin@a.test', '/rpc/set_lifecycle_stage');
select pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000263a1', 'planning', 'menu agreed on the phone')::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('11 set_lifecycle_stage planning (admin override) -> in_progress, the override reason is on the move',
  :'r' like 'ok:%' and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'confirmed|in_progress|rpc|set_lifecycle_stage|true'
  and (select reason from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' order by id desc limit 1) = 'menu agreed on the phone',
  :'r' || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a1'), ''));
select pg_temp.as('a_admin@a.test', '/rpc/set_lifecycle_stage');
select pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000263a1', 'event_day', 'event is today')::text$q$) as r \gset
select pg_temp.as('a_admin@a.test', '/rpc/set_lifecycle_stage');
select pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000263a1', 'settlement', 'event is over')::text$q$) as r2 \gset
select pg_temp.su();
select pg_temp.t('12 event_day then settlement -> event_day, completed', :'r' like 'ok:%' and :'r2' like 'ok:%'
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'event_day|completed|rpc|set_lifecycle_stage|true', :'r' || ' / ' || :'r2');
-- closed: the closure row (a related table) is enough to move the stage
insert into public.event_closure(quote_id, org_id, closed_at) values ('a0000000-0000-4000-8000-0000000263a1', 'a0000000-0000-4000-8000-000000000001', now())
  on conflict (quote_id) do update set closed_at = now();
select pg_temp.t('13 event_closure.closed_at -> closed (related-table trigger)', pg_temp.stage('a0000000-0000-4000-8000-0000000263a1') = 'closed',
  pg_temp.last('a0000000-0000-4000-8000-0000000263a1'));
select pg_temp.as('a_admin@a.test', '/rpc/reopen_event');
select pg_temp.try($q$select public.reopen_event('a0000000-0000-4000-8000-0000000263a1', 'client asked for one more photo set')::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('14 reopen_event -> completed (legal); the reason saved AFTER the move is found by its transaction time', :'r' like 'ok:%'
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'closed|completed|rpc|reopen_event|true'
  and (select public._r23_reason(quote_ref, at) from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' order by id desc limit 1) = 'client asked for one more photo set',
  :'r' || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a1'), ''));
select pg_temp.as('a_admin@a.test', '/rpc/cancel_event');
select pg_temp.try($q$select public.cancel_event('a0000000-0000-4000-8000-0000000263a1', 'client called off the event')::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('15 cancel_event -> cancelled with the cancellation reason', :'r' like 'ok:%'
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a1') = 'completed|cancelled|rpc|cancel_event|true'
  and (select reason from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' order by id desc limit 1) = 'client called off the event',
  :'r' || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a1'), ''));
select pg_temp.t('16 journey: 11 moves, all legal, no warning, path in order',
  (select string_agg(to_stage, '>' order by id) from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1')
    = 'draft>sent>viewed>approved>confirmed>in_progress>event_day>completed>closed>completed>cancelled'
  and not exists (select 1 from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' and not legal)
  and not exists (select 1 from public.quote_stage_warnings where quote_ref = 'a0000000-0000-4000-8000-0000000263a1'),
  (select string_agg(to_stage, '>' order by id) from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1'));
select pg_temp.t('17 domain events: one per move, type quote.<stage>, in order, transition ids match',
  (select string_agg(type, ',' order by id) from public.domain_events where entity_ref = 'a0000000-0000-4000-8000-0000000263a1')
    = 'quote.draft,quote.sent,quote.viewed,quote.approved,quote.confirmed,quote.in_progress,quote.event_day,quote.completed,quote.closed,quote.completed,quote.cancelled'
  and not exists (select 1 from public.domain_events e where e.entity_ref = 'a0000000-0000-4000-8000-0000000263a1'
                   and not exists (select 1 from public.quote_stage_transitions t where t.id = (e.payload ->> 'transition_id')::bigint and t.to_stage = split_part(e.type, '.', 2))),
  (select string_agg(type, ',' order by id) from public.domain_events where entity_ref = 'a0000000-0000-4000-8000-0000000263a1'));
select pg_temp.t('18 tenancy: every row carries the quote''s own studio',
  not exists (select 1 from public.quote_stage_transitions t join public.quotes q on q.id = t.quote_ref where t.org_id <> q.org_id)
  and not exists (select 1 from public.domain_events e join public.quotes q on q.id = e.entity_ref where e.org_id <> q.org_id), null);
-- a non-state edit (title / pricing autosave) never runs the trigger
update public.quotes set title = 'Stage263 Shelf (renamed)' where id = 'a0000000-0000-4000-8000-0000000263a3';
select pg_temp.t('19 non-state edit: no new move', pg_temp.n('a0000000-0000-4000-8000-0000000263a3') = 1, pg_temp.n('a0000000-0000-4000-8000-0000000263a3')::text);

-- ==== 4) time: a link that runs out (sweep = cron) + self-heal on read ================================================
select pg_sleep(2.5);
select set_config('application_name', 'pg_cron', false);
select public.quote_stage_sweep(500) as swept \gset
select set_config('application_name', 'psql', false);
select pg_temp.t('20 sweep: the sent link that ran out -> expired (source cron)', :swept >= 1
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a2') = 'sent|expired|cron||true', :swept || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a2'), ''));
update public.quotes set approval_token_expires_at = now() + interval '30 days' where id = 'a0000000-0000-4000-8000-0000000263a2';
select pg_temp.t('21 link extended -> back to sent (legal)', pg_temp.last('a0000000-0000-4000-8000-0000000263a2') = 'expired|sent|system||true', pg_temp.last('a0000000-0000-4000-8000-0000000263a2'));
update public.quotes set approval_token_expires_at = now() + interval '1 second' where id = 'a0000000-0000-4000-8000-0000000263a2';
select pg_sleep(1.5);
select pg_temp.as('a_admin@a.test', '/rpc/quote_stage_history');
select pg_temp.try($q$select public.quote_stage_history('a0000000-0000-4000-8000-0000000263a2')::text$q$) as h \gset
select pg_temp.su();
select pg_temp.t('22 history self-heals on read: expired, mode heal, newest first, labels',
  :'h' like 'ok:%' and (substr(:'h', 4)::jsonb ->> 'stage') = 'expired' and (substr(:'h', 4)::jsonb #>> '{history,0,to_label}') = 'Expired'
  and (select detail ->> 'mode' from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a2' order by id desc limit 1) = 'heal',
  left(:'h', 300));

-- ==== 5) shelves + restore; several updates in one transaction = one move ==============================================
update public.quotes set archived_at = now(), archived_reason = 'manual' where id = 'a0000000-0000-4000-8000-0000000263a3';
select pg_temp.t('23 archived by hand -> lost', pg_temp.last('a0000000-0000-4000-8000-0000000263a3') = 'draft|lost|system||true', pg_temp.last('a0000000-0000-4000-8000-0000000263a3'));
select pg_temp.as('a_admin@a.test', '/rpc/restore_quote_from_shelf');
select pg_temp.try($q$select public.restore_quote_from_shelf('a0000000-0000-4000-8000-0000000263a3')::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('24 restore_quote_from_shelf -> draft (legal, rpc)', :'r' like 'ok:%' and pg_temp.last('a0000000-0000-4000-8000-0000000263a3') = 'lost|draft|rpc|restore_quote_from_shelf|true',
  :'r' || ' ' || coalesce(pg_temp.last('a0000000-0000-4000-8000-0000000263a3'), ''));
do $$ begin
  update public.quotes set status = 'confirmed', approval_status = 'sent' where id = 'a0000000-0000-4000-8000-0000000263a3';
  update public.quotes set lifecycle_stage = 'confirmed' where id = 'a0000000-0000-4000-8000-0000000263a3';
  update public.quotes set approval_status = 'paid' where id = 'a0000000-0000-4000-8000-0000000263a3';
end $$;
select pg_temp.t('25 three updates in one transaction -> ONE move (draft -> confirmed)', pg_temp.n('a0000000-0000-4000-8000-0000000263a3') = 4
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a3') = 'draft|confirmed|system||true', pg_temp.n('a0000000-0000-4000-8000-0000000263a3') || ' ' || pg_temp.last('a0000000-0000-4000-8000-0000000263a3'));

-- ==== 6) the guard: WARN (default) logs, ENFORCE refuses a studio user's illegal move, never a system one ================
update public.quotes set lifecycle_stage = 'closed' where id = 'a0000000-0000-4000-8000-0000000263a4';
update public.quotes set lifecycle_stage = 'quote' where id = 'a0000000-0000-4000-8000-0000000263a4';
select pg_temp.t('26 WARN: closed -> draft happens (as before), logged as illegal + warning',
  (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-0000000263a4') = 'quote'
  and pg_temp.last('a0000000-0000-4000-8000-0000000263a4') = 'closed|draft|system||false'
  and exists (select 1 from public.quote_stage_warnings where quote_ref = 'a0000000-0000-4000-8000-0000000263a4' and from_stage = 'closed' and to_stage = 'draft' and mode = 'warn'),
  pg_temp.last('a0000000-0000-4000-8000-0000000263a4'));
select pg_temp.as('a_staff@a.test', '/rpc/set_stage_machine_settings');
select pg_temp.try($q$select public.set_stage_machine_settings('enforce', null)::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('27 a sales user can not change the stage rules', :'r' like 'err:42501%', :'r');
select pg_temp.as('a_admin@a.test', '/rpc/set_stage_machine_settings');
select pg_temp.try($q$select public.set_stage_machine_settings('nonsense', null)::text$q$) as bad \gset
select pg_temp.try($q$select public.set_stage_machine_settings('enforce', false)::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('28 studio admin: ENFORCE + hide history saved (bad value refused), audited', :'bad' like 'err:22023%'
  and :'r' like 'ok:%' and (substr(:'r', 4)::jsonb ->> 'effective_mode') = 'enforce' and (substr(:'r', 4)::jsonb ->> 'show_history') = 'false'
  and exists (select 1 from public.audit_log where action = 'stage_machine.settings' and org_id = 'a0000000-0000-4000-8000-000000000001'), :'bad' || ' / ' || :'r');
update public.quotes set lifecycle_stage = 'closed' where id = 'a0000000-0000-4000-8000-0000000263a4';
-- a studio user's change that would move closed -> draft: refused at commit (HL423), nothing changes
do $$ declare e text := ''; begin
  perform pg_temp.as('a_admin@a.test', '/rpc/some_rpc'); execute 'reset role';
  begin
    set constraints all immediate;   -- run the commit-time trigger now so this block can see its answer
    update public.quotes set lifecycle_stage = 'quote' where id = 'a0000000-0000-4000-8000-0000000263a4';
  exception when others then e := sqlstate || ':' || sqlerrm; end;
  perform pg_temp.su();
  perform pg_temp.t('29 ENFORCE: a studio user''s illegal move is refused (HL423) and rolled back', e like 'HL423:%Closed -> Draft%'
    and (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-0000000263a4') = 'closed'
    and pg_temp.stage('a0000000-0000-4000-8000-0000000263a4') = 'closed', e);
end $$;
do $$ begin perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  update public.quotes set lifecycle_stage = 'quote' where id = 'a0000000-0000-4000-8000-0000000263a4'; end $$;
select pg_temp.su();
select pg_temp.t('30 ENFORCE never blocks a webhook / service role: moved + logged (mode enforce)',
  pg_temp.stage('a0000000-0000-4000-8000-0000000263a4') = 'draft'
  and exists (select 1 from public.quote_stage_warnings where quote_ref = 'a0000000-0000-4000-8000-0000000263a4' and mode = 'enforce' and source = 'system'),
  pg_temp.last('a0000000-0000-4000-8000-0000000263a4'));
select pg_temp.t('31 Studio B is not affected by Studio A''s ENFORCE', public._r23_guard_mode('b0000000-0000-4000-8000-000000000001') = 'warn', null);
select pg_temp.as('a_admin@a.test', '/rpc/set_stage_machine_settings');
select pg_temp.try($q$select public.set_stage_machine_settings('warn', true)::text$q$) as r \gset
select pg_temp.su();
select pg_temp.t('32 back to WARN', (substr(:'r', 4)::jsonb ->> 'effective_mode') = 'warn', :'r');

-- ==== 7) a logging failure NEVER breaks the original write; the next read heals it =====================================
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'simulated logging failure'; end $$;
create trigger zz_r263_boom before insert on public.quote_stage_transitions for each row execute function pg_temp.boom();
update public.quotes set status = 'confirmed', approval_status = 'sent' where id = 'a0000000-0000-4000-8000-0000000263a5';
drop trigger zz_r263_boom on public.quote_stage_transitions;
select pg_temp.t('33 logging failed -> the quote change still committed, nothing half-written',
  (select approval_status from public.quotes where id = 'a0000000-0000-4000-8000-0000000263a5') = 'sent'
  and pg_temp.stage('a0000000-0000-4000-8000-0000000263a5') = 'draft' and pg_temp.n('a0000000-0000-4000-8000-0000000263a5') = 1, pg_temp.last('a0000000-0000-4000-8000-0000000263a5'));
select pg_temp.as('a_admin@a.test', '/rpc/quote_stage_history');
select pg_temp.try($q$select public.quote_stage_history('a0000000-0000-4000-8000-0000000263a5')::text$q$) as h \gset
select pg_temp.su();
select pg_temp.t('34 the next read heals it (draft -> sent)', (substr(:'h', 4)::jsonb ->> 'stage') = 'sent' and pg_temp.last('a0000000-0000-4000-8000-0000000263a5') = 'draft|sent|system|quote_stage_history|true', left(:'h', 200));

-- ==== 8) HQ switches (counts only) ======================================================================================
select pg_temp.as('a_admin@a.test', '/rpc/hq_stage_machine');
select pg_temp.try($q$select public.hq_stage_machine()::text$q$) as r \gset
select pg_temp.try($q$select public.hq_set_stage_machine(false, null, null)::text$q$) as r2 \gset
select pg_temp.su();
select pg_temp.t('35 a studio admin can not read or change the HQ switches', :'r' like 'err:42501%' and :'r2' like 'err:42501%', :'r' || ' / ' || :'r2');
select pg_temp.as('admin@helm.events', '/rpc/hq_set_stage_machine');
select pg_temp.try($q$select public.hq_set_stage_machine(false, null, null)::text$q$) as r \gset
select pg_temp.su();
update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000263a5';
select pg_temp.t('36 HQ kill switch: tracking OFF -> nothing recorded, audited', :'r' like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000263a5') = 'sent'
  and exists (select 1 from public.audit_log where action = 'hq.stage_machine.set'), :'r');
select pg_temp.as('admin@helm.events', '/rpc/hq_set_stage_machine');
select pg_temp.try($q$select public.hq_set_stage_machine(true, 'warn', true)::text$q$) as r \gset
select pg_temp.try($q$select public.hq_set_stage_machine(null, 'sometimes', null)::text$q$) as bad \gset
select pg_temp.su();
select pg_temp.as('a_admin@a.test', '/rpc/quote_stage_history');
select pg_temp.try($q$select public.quote_stage_history('a0000000-0000-4000-8000-0000000263a5')::text$q$) as h \gset
select pg_temp.su();
select pg_temp.t('37 tracking back ON: the next read catches up (sent -> approved); bad mode refused; HQ view has counts only',
  (substr(:'h', 4)::jsonb ->> 'stage') = 'approved' and :'bad' like 'err:22023%'
  and (substr(:'r', 4)::jsonb ->> 'tracking') = 'true' and (substr(:'r', 4)::jsonb ? 'illegal_moves')
  and position('Stage263' in :'r') = 0 and position('a0000000-0000-4000-8000-0000000263' in :'r') = 0, left(:'r', 300));

-- ==== 9) isolation + access ===================================================================================================
select pg_temp.as('b_admin@b.test', '/rpc/quote_stage_history');
select pg_temp.try($q$select public.quote_stage_history('a0000000-0000-4000-8000-0000000263a1')::text$q$) as r \gset
select pg_temp.try($q$select count(*)::text from public.quote_stage_transitions where quote_ref = 'a0000000-0000-4000-8000-0000000263a1'$q$) as c1 \gset
select pg_temp.try($q$select count(*)::text from public.domain_events where entity_ref = 'a0000000-0000-4000-8000-0000000263a1'$q$) as c2 \gset
select pg_temp.try($q$select public.quote_stage_list(array['a0000000-0000-4000-8000-0000000263a1']::uuid[])::text$q$) as c3 \gset
select pg_temp.su();
select pg_temp.t('38 Studio B: no history, no rows, no events, no pills of Studio A', :'r' like 'err:42501%' and :'c1' = 'ok:0' and :'c2' = 'ok:0' and :'c3' = 'ok:[]',
  :'r' || ' ' || :'c1' || ' ' || :'c2' || ' ' || :'c3');
select pg_temp.as('a_staff@a.test', '/rpc/quote_stage_list');
select pg_temp.try($q$select public.quote_stage_list(array['a0000000-0000-4000-8000-0000000263a1', 'a0000000-0000-4000-8000-0000000263a3']::uuid[])::text$q$) as r \gset
select pg_temp.try($q$select count(*)::text from public.quote_stage_v where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' and stage = 'cancelled'$q$) as v \gset
select pg_temp.try($q$select public.stage_machine_settings()::text$q$) as s \gset
select pg_temp.try($q$update public.quote_stage_transitions set reason = 'x' where quote_ref = 'a0000000-0000-4000-8000-0000000263a1' returning 'changed'$q$) as w \gset
select pg_temp.try($q$insert into public.domain_events(org_id, type) values ('a0000000-0000-4000-8000-000000000001', 'quote.fake') returning 'inserted'$q$) as w2 \gset
select pg_temp.try($q$select count(*)::text from public.domain_events_pull('r23-hack', null, 10, true)$q$) as w3 \gset
select pg_temp.su();
select pg_temp.t('39 own studio: pills + view readable; settings readable (not editable for sales)',
  :'r' like 'ok:%' and jsonb_array_length(substr(:'r', 4)::jsonb) = 2 and :'v' = 'ok:1'
  and (substr(:'s', 4)::jsonb ->> 'can_edit') = 'false', :'r' || ' ' || :'v' || ' ' || :'s');
select pg_temp.t('40 the app can not write stage rows / events or pull the event stream', :'w' like 'err:42501%' and :'w2' like 'err:42501%' and :'w3' like 'err:42501%',
  :'w' || ' / ' || :'w2' || ' / ' || :'w3');
do $$ declare r text; r2 text; begin
  perform auth.login_anon();
  r := pg_temp.try($q$select count(*)::text from public.quote_stage_transitions$q$);
  r2 := pg_temp.try($q$select public.quote_stage_history('a0000000-0000-4000-8000-0000000263a1')::text$q$);
  perform pg_temp.su();
  perform pg_temp.t('41 anon: no table, no RPC', r like 'err:42501%' and r2 like 'err:42501%', r || ' / ' || r2);
end $$;
select pg_temp.t('42 rows are append-only even for the owner role', pg_temp.try($q$update public.quote_stage_transitions set reason = 'x' where id = (select max(id) from public.quote_stage_transitions) returning 'x'$q$) like 'err:42501%', null);

-- ==== 10) domain events: pull / ack per consumer ==========================================================================
select pg_temp.t('43 a new consumer starts at the end (no replay) unless from_start',
  (select count(*) from public.domain_events_pull('r23-new', array['quote.cancelled'], 100)) = 0
  and (select count(*) from public.domain_events_pull('r23-reminders', array['quote.cancelled'], 100, true)) >= 1, null);
select pg_temp.t('44 ack moves the cursor (never backwards); the same events are not served twice',
  public.domain_events_ack('r23-reminders', (select max(id) from public.domain_events)) = (select max(id) from public.domain_events)
  and public.domain_events_ack('r23-reminders', 1) = (select max(id) from public.domain_events)
  and (select count(*) from public.domain_events_pull('r23-reminders', array['quote.cancelled'], 100)) = 0, null);

-- ==== 11) other features never see the new tables ===========================================================================
select pg_temp.t('45 no quote_id column / FK to quotes on the new tables (0141 / 0220 empty-draft + 0004 / 0136 tenant scans)',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and column_name = 'quote_id'
               and table_name in ('quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'quote_stage_moves', 'domain_events', 'domain_event_cursors', 'helm_stage_settings'))
  and not exists (select 1 from pg_constraint con join pg_class cl on cl.oid = con.conrelid where con.contype = 'f' and con.confrelid = 'public.quotes'::regclass
               and cl.relname in ('quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'domain_events')), null);
select pg_temp.t('46 empty-draft check of a quote with stage rows does not name them',
  coalesce(public._empty_draft_reason('a0000000-0000-4000-8000-0000000263a4'), '') not like 'has:quote_stage%'
  and coalesce(public._empty_draft_reason('a0000000-0000-4000-8000-0000000263a4'), '') not like 'has:domain%', public._empty_draft_reason('a0000000-0000-4000-8000-0000000263a4'));
select pg_temp.t('47 trial retention: the 4 studio tables are classified (purge), nothing unclassified',
  public.trial_retention_dry_run() -> 'unclassified_tables' = '[]'::jsonb
  and public._tr184_purge_tables() @> array['quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'domain_events'], null);
select pg_temp.t('48 RLS is on for every new table', (select bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace
  and c.relname in ('quote_stage_transitions', 'quote_stage_current', 'quote_stage_warnings', 'quote_stage_moves', 'domain_events', 'domain_event_cursors', 'helm_stage_settings')), null);

select 'R23-STATE-MACHINE-0263: ' || case when count(*) filter (where result <> 'PASS') = 0
  then 'ALL PASS (' || count(*) || '/' || count(*) || ')' else 'FAILURES (' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ')' end
  from _r263;
select name, result from _r263 where result <> 'PASS' order by n;
drop table _r263;
