-- trial-email-0212.sql -- 0212: an ACTIVE free trial really e-mails its clients (approval / booklet / invitation link,
-- approval code by e-mail) under caps (30 a day per studio, 5 a day per address); WhatsApp / SMS / payment links stay
-- blocked; ended trials, the sample master, demo (sample) events and the owner switch off send nothing; paid studios
-- are unchanged. Rolled back. Local disposable PG only. Nothing is ever sent (no dispatcher / edge function runs here).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations (0166 / 0195 / 0200 / 0207); re-apply 0212 twice inside this rolled-back tx
\ir ../../supabase/migrations/0212_trial_client_email.sql
\ir ../../supabase/migrations/0212_trial_client_email.sql
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, false);
  perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.bk(p_quote uuid) returns jsonb language sql as $$
  select to_jsonb(public.booklet_share(p_quote, 30, null::uuid[], null::text, null::text, null::jsonb));
$$;
create or replace function pg_temp.ledger(p_org uuid) returns bigint language sql as $$
  select count(*) from public.trial_email_sends where org_id = p_org;
$$;
create temp table _k(k text primary key, v text); grant all on _k to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into _k values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _k where k = p_k $$;

-- ---- 0) structure ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 settings: one row, switch on, 30 a day per studio, 5 a day per address',
    (select count(*) = 1 and bool_and(enabled) and min(per_studio_day) = 30 and min(per_recipient_day) = 5 from public.trial_email_settings));
  perform pg_temp.res('02 new tables: RLS on, no app access (definer functions only)',
    (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.trial_email_settings'::regclass, 'public.trial_email_sends'::regclass, 'public.tr212_saved_defs'::regclass))
    and not has_table_privilege('authenticated', 'public.trial_email_sends', 'select')
    and not has_table_privilege('anon', 'public.trial_email_settings', 'select')
    and not has_table_privilege('authenticated', 'public.trial_email_settings', 'update'));
  perform pg_temp.res('03 both dispatcher claim bodies ask _tr212_claim_blocked; none keeps the old check; old bodies saved',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'comms\_outbox\_claim%'
       and position('_tr212_claim_blocked(r.org_id, r.recipient, r.purpose, r.channel, r.payload)' in pg_get_functiondef(p.oid)) > 0) >= 2   -- 0261 adds a third wrapper (nudges), same check
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'comms\_outbox\_claim%'
       and position('not public._sample_outbound_blocked(r.org_id, r.recipient)' in pg_get_functiondef(p.oid)) > 0)
    and (select count(*) from public.tr212_saved_defs where fn like 'comms_outbox_claim%') = 2
    and exists (select 1 from public.tr212_saved_defs where fn = 'public._ts166_tg_outbox_skip()' and position('trial-email-0212' in def) = 0));
  perform pg_temp.res('04 wrappers keep the originals (no app grant on them); app grants unchanged',
    to_regprocedure('public.booklet_send__pre0212(uuid,text,text,boolean,text)') is not null
    and to_regprocedure('public.event_site_send__pre0212(uuid,text,text,boolean,text)') is not null
    and not has_function_privilege('authenticated', 'public.booklet_send__pre0212(uuid,text,text,boolean,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_site_send__pre0212(uuid,text,text,boolean,text)', 'execute')
    and has_function_privilege('authenticated', 'public.booklet_send(uuid,text,text,boolean,text)', 'execute')
    and has_function_privilege('authenticated', 'public.event_site_send(uuid,text,text,boolean,text)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_send(uuid,text,text,boolean,text)', 'execute'));
  perform pg_temp.res('05 gate + OTP begin: service role only; my_trial_messaging: signed-in app; helpers internal',
    has_function_privilege('service_role', 'public.trial_email_gate(uuid,uuid,uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_email_gate(uuid,uuid,uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_email_gate(uuid,uuid,uuid,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.trial_email_otp_begin(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_email_otp_begin(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_email_otp_begin(uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_trial_messaging()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_messaging()', 'execute')
    and not has_function_privilege('authenticated', 'public._tr212_take(uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._tr212_email_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._ts166_tg_outbox_skip()', 'execute'));
  perform pg_temp.res('06 trial terms version = public/trial-facts.js VERSION; the ledger is kept by the trial retention',
    public._trial_terms_version() = 'trial-2026-10-19' and 'trial_email_sends' = any(public._tr184_keep_tables())
    and 'trial_terms_acceptances' = any(public._tr184_keep_tables()));
end $$;

-- ---- 1) paid studio: nothing changes ---------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; m jsonb; c record; begin
  perform pg_temp.su();
  update public.quotes set client = client || '{"name":"Alice","email":"alice@client.test","phone":"98765 43210"}'::jsonb, status = 'confirmed' where id = qa;
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.bk(qa);
  r := public.booklet_send(qa, 'email', 'alice@client.test');
  m := public.my_trial_messaging();
  perform pg_temp.su();
  select * into c from public.comms_outbox where id = (r ->> 'id')::uuid;
  perform pg_temp.res('10 paid: booklet e-mail queued as before (no trial mark, no reason)',
    r ->> 'status' = 'queued' and not (r ? 'trial_email') and r ->> 'reason' is null and c.status = 'pending' and not (c.payload ? 'trial_email'), r::text);
  perform pg_temp.res('11 paid: nothing written to the trial ledger', pg_temp.ledger(a) = 0);
  perform pg_temp.res('12 paid: my_trial_messaging = everything on', m ->> 'trial' = 'false' and m ->> 'email' = 'true'
    and m ->> 'whatsapp' = 'true' and m ->> 'sms' = 'true' and m ->> 'payment_links' = 'true', m::text);
  perform pg_temp.svc();
  r := public.trial_email_gate(a, qa, null, 'alice@client.test', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('13 paid: client-mailer gate allowed, not a trial, no slot taken',
    r ->> 'allowed' = 'true' and r ->> 'trial' = 'false' and pg_temp.ledger(a) = 0, r::text);
  -- a caller cannot bring the trial mark along
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (a, qa, 'booklet_link', 'email', 'x@client.test', '{"trial_email":true,"booklet_id":"x"}', 'tr212-forged', 'pending');
  perform pg_temp.res('14 a forged payload.trial_email is removed by the outbox guard',
    (select not (payload ? 'trial_email') and status = 'pending' from public.comms_outbox where dedupe_key = 'tr212-forged'));
  perform pg_temp.svc();
  r := public.trial_email_gate(null, null, null, 'x@y.test', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('15 gate with nothing to check against: not allowed (fails closed)', r ->> 'allowed' = 'false', r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('1x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) ACTIVE free trial: e-mail goes out (capped), WhatsApp / SMS / payment links do not ----------------------
do $$ declare t uuid; q uuid; qd uuid; r jsonb; r2 jsonb; c record; e text; m jsonb; v_tok uuid := gen_random_uuid(); begin
  perform pg_temp.su(); update public.helm_sample_template set active = true, block_trial_outbound = true where id;
  t := pg_temp.trial('tr212_t@t.test'); perform pg_temp.put('T', t::text);
  select id into q from public.quotes where org_id = t and public._comms_quote_live(id) order by created_at, id limit 1;
  select id into qd from public.quotes where org_id = t and id <> q and public._comms_quote_live(id) order by created_at, id limit 1;
  perform pg_temp.res('20 active trial studio with two live events to try it on', q is not null and qd is not null
    and public._tr212_email_ok(t) and public.trial_send_blocked(t, null, null));
  -- q = the studio's own event (a real client), qd stays a sample (demo) event
  update public.quotes set is_demo = false, status = 'confirmed', approval_token = v_tok, approval_token_revoked_at = null, approval_token_expires_at = null,
    client = coalesce(client, '{}'::jsonb) || '{"name":"Riya","email":"riya@client.test","phone":"+91 93141 59265"}'::jsonb where id = q;
  update public.quotes set is_demo = true, status = 'confirmed',
    client = coalesce(client, '{}'::jsonb) || '{"name":"Sample","email":"sample@example.com","phone":"+91 90000 00000"}'::jsonb where id = qd;
  -- the quote -> CRM sync copies the client onto the event's (sample) lead: that lead is the studio's own client now
  update public.leads set is_demo = false where org_id = t and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = '9314159265';
  perform pg_temp.put('Q', q::text); perform pg_temp.put('TOK', v_tok::text);
  perform pg_temp.login('tr212_t@t.test');
  perform pg_temp.bk(q); perform pg_temp.bk(qd);
  r := public.booklet_send(q, 'email', 'riya@client.test');
  r2 := public.booklet_send(q, 'whatsapp', '+91 93141 59265', true, 'Client agreed (test)');
  m := public.my_trial_messaging();
  perform pg_temp.su();
  select * into c from public.comms_outbox where id = (r ->> 'id')::uuid;
  perform pg_temp.res('21 trial booklet e-mail: queued, answer says trial_email (no free_trial reason)',
    r ->> 'status' = 'queued' and r ->> 'trial_email' = 'true' and r ->> 'reason' is null, r::text);
  perform pg_temp.res('22 the row is pending with the trial mark; one ledger slot (fingerprint only, never the address)',
    c.status = 'pending' and c.payload ->> 'trial_email' = 'true' and pg_temp.ledger(t) = 1
    and (select recipient_hash = encode(sha256(convert_to('riya@client.test', 'UTF8')), 'hex') and kind = 'booklet_link'
           from public.trial_email_sends where org_id = t)
    and not exists (select 1 from public.trial_email_sends s where s.org_id = t and position('riya' in s.recipient_hash) > 0), row_to_json(c)::text);
  perform pg_temp.res('23 trial WhatsApp: still skipped (free_trial), no slot', r2 ->> 'status' = 'skipped' and r2 ->> 'reason' = 'free_trial'
    and pg_temp.ledger(t) = 1, r2::text);
  perform pg_temp.res('24 my_trial_messaging: trial, active, e-mail on, WhatsApp / SMS / payment links off, 1 used',
    m ->> 'trial' = 'true' and m ->> 'active' = 'true' and m ->> 'email' = 'true' and m ->> 'whatsapp' = 'false'
    and m ->> 'sms' = 'false' and m ->> 'payment_links' = 'false' and (m ->> 'email_used_today')::int = 1
    and (m ->> 'email_per_day')::int = 30, m::text);
  perform pg_temp.svc();
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('25 the dispatcher claims the trial e-mail row (with its link path), never the WhatsApp row',
    exists (select 1 from jsonb_array_elements(r) x where (x ->> 'id')::uuid = c.id and x -> 'payload' ->> 'link_path' is not null)
    and not exists (select 1 from jsonb_array_elements(r) x join public.comms_outbox o on o.id = (x ->> 'id')::uuid
                     where o.org_id = t and o.channel = 'whatsapp'), r::text);
  -- the sample (demo) event: never e-mailed
  perform pg_temp.login('tr212_t@t.test');
  r := public.booklet_send(qd, 'email', 'sample@example.com');
  perform pg_temp.su();
  perform pg_temp.res('26 trial demo (sample) event: skipped, reason demo, no slot', r ->> 'status' = 'skipped' and r ->> 'reason' = 'demo'
    and pg_temp.ledger(t) = 1, r::text);
  -- other queued client messages from the trial stay skipped
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (t, q, 'pay_reminder', 'email', 'riya@client.test', '{"text":"x"}', 'tr212-pay', 'pending'),
           (t, q, 'invite_site', 'email', 'riya@client.test', '{"site_id":"x"}', 'tr212-inv', 'pending'),
           (t, q, 'invite_site', 'whatsapp', '919314159265', '{"site_id":"x"}', 'tr212-inv-wa', 'pending');
  perform pg_temp.res('27 trial payment reminder by e-mail: skipped (not a link e-mail)',
    (select status = 'skipped' from public.comms_outbox where dedupe_key = 'tr212-pay'));
  perform pg_temp.res('28 trial invitation link e-mail: pending + marked; WhatsApp: skipped',
    (select status = 'pending' and payload ->> 'trial_email' = 'true' from public.comms_outbox where dedupe_key = 'tr212-inv')
    and (select status = 'skipped' from public.comms_outbox where dedupe_key = 'tr212-inv-wa') and pg_temp.ledger(t) = 2);
  update public.comms_outbox set status = 'skipped' where dedupe_key = 'tr212-pay';
  update public.comms_outbox set status = 'pending' where dedupe_key = 'tr212-pay';
  perform pg_temp.res('29 a retry back to pending is skipped again (0179 update guard)',
    (select status = 'skipped' from public.comms_outbox where dedupe_key = 'tr212-pay'));
  -- client-mailer gate
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'riya@client.test', 'approval_link');
  r2 := public.trial_email_gate(t, qd, null, 'sample@example.com', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('30 gate: trial approval e-mail allowed (one slot); demo event refused',
    r ->> 'allowed' = 'true' and r ->> 'trial' = 'true' and pg_temp.ledger(t) = 3
    and r2 ->> 'allowed' = 'false' and r2 ->> 'reason' = 'demo', r::text || r2::text);
  -- approval code: e-mail yes (one slot), WhatsApp / SMS no
  perform pg_temp.svc();
  e := pg_temp.err(format('select public.trial_email_otp_begin(%L::uuid, %L)', v_tok, 'ua'));
  perform pg_temp.res('31 trial approval code by e-mail: begins (on-file address), one slot', e = '' and pg_temp.ledger(t) = 4
    and exists (select 1 from public.trial_email_sends where org_id = t and kind = 'otp'), e);
  e := pg_temp.err(format('select public.wa_otp_begin(%L::uuid, %L, null)', v_tok, 'whatsapp'));
  perform pg_temp.res('32 trial approval code on WhatsApp: still refused (trial_no_send)', e like '42501 trial_no_send%', e);
  e := pg_temp.err(format('select public.otp_send_authorize(%L::uuid, %L)', v_tok, '+91 93141 59265'));
  perform pg_temp.res('33 trial approval code by SMS: still refused (trial_no_send)', e like '42501 trial_no_send%', e);
  e := pg_temp.err(format('select public.payment_link_begin(%L::uuid, 60)', v_tok));
  perform pg_temp.res('34 trial payment link: still refused (trial_no_send)', e like '42501 trial_no_send%', e);
  e := pg_temp.err(format('select public.trial_email_otp_begin(%L::uuid, %L)', v_tok, 'ua'));
  perform pg_temp.res('35 a second e-mail code right away: the 0151 30-second wait still applies', e like 'HL429%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) caps ---------------------------------------------------------------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; q uuid := pg_temp.get('Q')::uuid; r jsonb; i int; n_ok int := 0; begin
  perform pg_temp.su();
  delete from public.trial_email_sends where org_id = t;   -- (rolled back) start the day empty
  perform pg_temp.svc();
  for i in 1..6 loop
    r := public.trial_email_gate(t, q, null, 'same@client.test', 'approval_link');
    if r ->> 'allowed' = 'true' then n_ok := n_ok + 1; end if;
  end loop;
  perform pg_temp.su();
  perform pg_temp.res('40 5 e-mails a day to one address, the 6th refused (cap_recipient)', n_ok = 5 and r ->> 'reason' = 'cap_recipient', n_ok || ' ' || r::text);
  perform pg_temp.res('41 the refused one took no slot', pg_temp.ledger(t) = 5);
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'SAME@client.test ', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('42 the address cap ignores case and spaces', r ->> 'reason' = 'cap_recipient', r::text);
  update public.trial_email_settings set per_studio_day = 6 where id;
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'one@client.test', 'approval_link');
  r := public.trial_email_gate(t, q, null, 'two@client.test', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('43 studio cap: once the day is full every address is refused (cap_studio)',
    r ->> 'allowed' = 'false' and r ->> 'reason' = 'cap_studio' and pg_temp.ledger(t) = 6, r::text);
  perform pg_temp.login('tr212_t@t.test');
  r := public.booklet_send(q, 'email', 'three@client.test');
  perform pg_temp.su();
  perform pg_temp.res('44 booklet e-mail over the cap: skipped, reason trial_email_cap',
    r ->> 'status' = 'skipped' and r ->> 'reason' = 'trial_email_cap' and r ->> 'cap' = 'cap_studio'
    and (select status = 'skipped' and payload ->> 'trial_cap' = 'cap_studio' from public.comms_outbox where id = (r ->> 'id')::uuid), r::text);
  update public.trial_email_sends set created_at = now() - interval '25 hours' where org_id = t;
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'same@client.test', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('45 rolling 24 hours: older sends free their slots', r ->> 'allowed' = 'true', r::text);
  update public.trial_email_settings set per_studio_day = 30 where id;
exception when others then perform pg_temp.su(); insert into _uf values ('3x caps', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) owner switch off ---------------------------------------------------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; q uuid := pg_temp.get('Q')::uuid; r jsonb; id1 uuid; e text; begin
  perform pg_temp.su();
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (t, q, 'invite_site', 'email', 'late@client.test', '{"site_id":"x"}', 'tr212-late', 'pending') returning id into id1;
  update public.trial_email_settings set enabled = false where id;
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'riya@client.test', 'approval_link');
  e := pg_temp.err(format('select public.trial_email_otp_begin(%L::uuid, %L)', pg_temp.get('TOK'), 'ua'));
  perform public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('50 switch off: gate refuses (trial_no_send)', r ->> 'allowed' = 'false' and r ->> 'reason' = 'trial_no_send', r::text);
  perform pg_temp.res('51 switch off: e-mail code refused (trial_no_send)', e like '42501 trial_no_send%', e);
  perform pg_temp.res('52 switch off: a trial row queued before is skipped by the claim (re-checked)',
    (select status = 'skipped' from public.comms_outbox where id = id1));
  perform pg_temp.login('tr212_t@t.test');
  r := public.booklet_send(q, 'email', 'off@client.test');
  perform pg_temp.su();
  perform pg_temp.res('53 switch off: booklet e-mail skipped as before 0212 (free_trial)', r ->> 'status' = 'skipped' and r ->> 'reason' = 'free_trial', r::text);
  update public.trial_email_settings set enabled = true where id;
exception when others then perform pg_temp.su(); insert into _uf values ('4x switch', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) ENDED (read-only) trial and the sample master: nothing ---------------------------------------------------
do $$ declare t uuid := pg_temp.get('T')::uuid; q uuid := pg_temp.get('Q')::uuid; m uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  r jsonb; r2 jsonb; e text; begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = t;
  update public.studio_subscriptions set trial_ends_at = (now() - interval '2 days')::date where org_id = t;
  perform pg_temp.res('60 the trial has ended (read-only): no trial e-mail', public._trial_locked(t) and not public._tr212_email_ok(t));
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (t, q, 'booklet_link', 'email', 'riya@client.test', '{"booklet_id":"x"}', 'tr212-ended', 'pending');
  perform pg_temp.res('61 ended trial: a link e-mail is stored skipped', (select status = 'skipped' from public.comms_outbox where dedupe_key = 'tr212-ended'));
  perform pg_temp.svc();
  r := public.trial_email_gate(t, q, null, 'riya@client.test', 'approval_link');
  e := pg_temp.err(format('select public.trial_email_otp_begin(%L::uuid, %L)', pg_temp.get('TOK'), 'ua'));
  r2 := public.trial_email_gate(m, null, null, 'x@client.test', 'approval_link');
  perform pg_temp.su();
  perform pg_temp.res('62 ended trial: gate refuses (trial_no_send)', r ->> 'allowed' = 'false' and r ->> 'reason' = 'trial_no_send', r::text);
  perform pg_temp.res('63 ended trial: e-mail code refused', e like '42501 trial_no_send%', e);
  perform pg_temp.res('64 sample master: never (gate refuses, helper false)', r2 ->> 'allowed' = 'false' and not public._tr212_email_ok(m), r2::text);
exception when others then perform pg_temp.su(); insert into _uf values ('5x ended', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) who may call ---------------------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.err($q$select public.trial_email_gate(null, null, null, 'x@y.test', 'approval_link')$q$);
  perform pg_temp.res('70 a studio user cannot call the gate', e like '42501%', e);
  e := pg_temp.err(format('select public.trial_email_otp_begin(%L::uuid, null)', gen_random_uuid()));
  perform pg_temp.res('71 a studio user cannot start a trial e-mail code', e like '42501%', e);
  perform pg_temp.su(); perform set_config('role', 'anon', false);
  e := pg_temp.err($q$select public.my_trial_messaging()$q$);
  perform pg_temp.res('72 anon cannot read my_trial_messaging', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('6x grants', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-EMAIL-0212: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-EMAIL-0212: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
