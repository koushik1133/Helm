-- trial-outbound-0187.sql -- 0187: an ENDED, unpaid free trial (past_due, read-only) queues no client
-- message (comms_outbox / pkg_outbox rows stored 'skipped', also a retry back to pending, and rows that
-- were already waiting are skipped by the migration), and no free-trial / ended-trial studio gets a real
-- Razorpay payment link (payment_link_begin 42501 trial_no_send). Paid studios (also a converted
-- ex-trial that paid once and is past_due now): unchanged. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ob(name text, result text); grant all on _ob to anon, authenticated, service_role;
create temp table _obkv(k text primary key, v text); grant all on _obkv to anon, authenticated, service_role;

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
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ob values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text;
begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _obkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _obkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin', p_org uuid default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'own');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;

-- earlier suites in run-all re-apply older migrations over the wrappers: re-run 0187 (also proves a re-run is safe)
\ir ../../supabase/migrations/0187_trial_outbound_gaps.sql

-- ---- setup: T = trial on its free trial, E = ended unpaid trial (past_due), P = converted ex-trial that
-- paid once and is past_due now; each with an approved own event + link. A = the paid fixture studio.
do $$ declare t uuid; e uuid; p uuid; x uuid; k text; q uuid; tok uuid; begin
  t := pg_temp.trial('ob_t@t.test'); e := pg_temp.trial('ob_e@t.test'); p := pg_temp.trial('ob_p@t.test');
  perform pg_temp.put('T', t::text); perform pg_temp.put('E', e::text); perform pg_temp.put('P', p::text);
  perform set_config('helm.maintenance', 'on', true);
  foreach k in array array['T', 'E', 'P'] loop
    x := pg_temp.get(k)::uuid; q := gen_random_uuid(); tok := gen_random_uuid();
    perform pg_temp.put('tok' || k, tok::text);
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token,
                              event_date, created_at, updated_at)
      values (q, 'OB-' || k, 'Own event ' || k, 'quote', '{"name":"Rhea","phone":"98765 43210","email":"rhea@example.org"}'::jsonb,
              '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'approved', x, tok, current_date + 30, now(), now());
  end loop;
  update public.organizations set trial_ends_at = now() - interval '3 days' where id in (e, p);
  update public.studio_subscriptions set trial_ends_at = current_date - 3, status = 'past_due' where org_id in (e, p);
  insert into public.subscription_payments(org_id, amount, paid_on, method) values (p, 999, current_date - 2, 'upi');
  perform set_config('helm.maintenance', 'off', true);
  perform pg_temp.res('00 setup: T on trial, E ended + read-only (not status trial), P and A not locked',
    public._is_trial_org(t) and public._trial_locked(e) and not public._is_trial_org(e)
    and not public._trial_locked(p) and not public._trial_locked('a0000000-0000-4000-8000-000000000001'::uuid));
exception when others then perform pg_temp.su(); insert into _ob values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) outbox: new rows (as a scheduled job queues them) -----------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; e uuid := pg_temp.get('E')::uuid; p uuid := pg_temp.get('P')::uuid;
  a uuid := 'a0000000-0000-4000-8000-000000000001'; s text; begin
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values
    (e, 'pay_reminder', 'email', 'rhea@example.org', 'ob187:e'), (t, 'pay_reminder', 'email', 'rhea@example.org', 'ob187:t'),
    (p, 'pay_reminder', 'email', 'rhea@example.org', 'ob187:p'), (a, 'pay_reminder', 'email', 'rhea@example.org', 'ob187:a');
  select status into s from public.comms_outbox where dedupe_key = 'ob187:e';
  perform pg_temp.res('01 ended unpaid trial: a queued payment reminder is stored skipped', s = 'skipped', s);
  select status into s from public.comms_outbox where dedupe_key = 'ob187:t';
  perform pg_temp.res('02 trial on its free trial: skipped (0166, unchanged)', s = 'skipped', s);
  select status into s from public.comms_outbox where dedupe_key = 'ob187:p';
  perform pg_temp.res('03 converted ex-trial that paid once (past_due now): pending as before', s = 'pending', s);
  select status into s from public.comms_outbox where dedupe_key = 'ob187:a';
  perform pg_temp.res('04 paid studio: pending as before', s = 'pending', s);
  update public.comms_outbox set status = 'failed' where dedupe_key = 'ob187:e';
  update public.comms_outbox set status = 'pending' where dedupe_key = 'ob187:e';
  select status into s from public.comms_outbox where dedupe_key = 'ob187:e';
  perform pg_temp.res('05 ended unpaid trial: a retry back to pending is skipped again', s = 'skipped', s);
  perform pg_temp.res('06 guard answers: E blocked, P / A not',
    public._sample_outbound_blocked(e, null) and not public._sample_outbound_blocked(p, null) and not public._sample_outbound_blocked(a, null));
exception when others then insert into _ob values ('1x outbox', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) rows that were already waiting before 0187: skipped by a re-run (paid rows untouched) -----------
alter table public.comms_outbox disable trigger zzzz_ts166_outbox_skip;
do $$ declare e uuid := pg_temp.get('E')::uuid; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values
    (e, 'follow_up', 'email', 'rhea@example.org', 'ob187:old-e'), (a, 'follow_up', 'email', 'rhea@example.org', 'ob187:old-a');
end $$;
alter table public.comms_outbox enable trigger zzzz_ts166_outbox_skip;
select pg_temp.res('10 setup: an old pending row for E exists', (select status from public.comms_outbox where dedupe_key = 'ob187:old-e') = 'pending');
\ir ../../supabase/migrations/0187_trial_outbound_gaps.sql
select pg_temp.res('11 re-run: the waiting row of the ended trial is now skipped (kept)',
  (select status from public.comms_outbox where dedupe_key = 'ob187:old-e') = 'skipped');
select pg_temp.res('12 re-run: paid rows untouched (old + new paid / converted rows still pending)',
  (select count(*) from public.comms_outbox where dedupe_key in ('ob187:old-a', 'ob187:a', 'ob187:p') and status = 'pending') = 3);

-- ---- 3) Razorpay payment link (service role, as create-payment-link calls it) ----------------------------
do $$ declare e text; begin
  perform pg_temp.svc();
  e := pg_temp.try(format('select public.payment_link_begin(%L::uuid, 60)', pg_temp.get('tokT')));
  perform pg_temp.res('20 free trial: payment link refused (trial_no_send)', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.payment_link_begin(%L::uuid, 60)', pg_temp.get('tokE')));
  perform pg_temp.res('21 ended unpaid trial: payment link refused (trial_no_send)', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.payment_link_begin(%L::uuid, 60)', pg_temp.get('tokP')));
  perform pg_temp.res('22 converted ex-trial that paid: not refused by the trial check', e not like '%trial_no_send%', e);
  e := pg_temp.try($q$select public.payment_link_begin('a0000000-0000-4000-8000-0000000000aa'::uuid, 60)$q$);
  perform pg_temp.res('23 paid studio: not refused by the trial check', e not like '%trial_no_send%', e);
  e := pg_temp.try($q$select public.payment_link_begin('00000000-0000-4000-8000-000000000000'::uuid, 60)$q$);
  perform pg_temp.res('24 unknown link: the old answer (no error)', e = '', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ob values ('2x payment link', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
select pg_temp.res('25 payment_link_begin + kept body: service role only',
  has_function_privilege('service_role', 'public.payment_link_begin(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.payment_link_begin(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.payment_link_begin__pre0187(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.payment_link_begin__pre0187(uuid,integer)', 'execute'));
select pg_temp.res('26 the trial check sits on top of the 0097 demo gate (chain kept)',
  position('trial-outbound-0187' in (select prosrc from pg_proc where oid = to_regprocedure('public.payment_link_begin(uuid,integer)'))) > 0
  and to_regprocedure('public.payment_link_begin__pre0187(uuid,integer)') is not null);

select pg_temp.su();
select name, result from _ob order by name;
select case when (select count(*) from _ob where result <> 'PASS') = 0
            then 'TRIAL-OUTBOUND-0187: ALL PASS (' || (select count(*) from _ob) || '/' || (select count(*) from _ob) || ')'
            else 'TRIAL-OUTBOUND-0187: FAILURES ' || (select count(*) from _ob where result <> 'PASS') end as verdict;
rollback;
