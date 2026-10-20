-- r24-contact-0271.sql -- 0271: the public Contact sales form (anon submit_sales_enquiry: validation, honeypot, rate limits,
-- duplicates, nothing read back), HQ Requests -> Sales enquiries (operators only, status + note, notify address setting),
-- the queued e-mails (alert to the HQ address, one thank-you per sender per day, unsubscribe respected), the HQ bell and the
-- suggestions box (signed in + visitors, rate limits, HQ list, e-mail).
-- Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text default '203.0.113.7') returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip, 'user-agent', 'TestUA/1')::text, false); end if;
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.form(p_email text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', 'Priya Sharma', 'email', p_email, 'phone', '+91 98765 43210', 'company', 'Sharma Events',
    'city', 'Hyderabad', 'team_size', '6-15', 'events_per_year', '21-50', 'plan', 'studio', 'message', 'We run 40 weddings a year.',
    'consent', true, 'source', 'contact_page') || p_extra $$;
grant execute on function pg_temp.form(text, jsonb) to anon, authenticated, service_role;

-- ---- the migration, twice (safe to re-run) -------------------------------------------------------------------------
\ir ../../supabase/migrations/0271_contact_sales.sql
\ir ../../supabase/migrations/0271_contact_sales.sql

do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  delete from public.auth_rate_hits where bucket like 'sales.%';
end $$;

-- ---- 1) schema ---------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 two new tables, RLS on, no anon / signed-in table privilege',
    (select count(*) from pg_class c where c.oid in (to_regclass('public.sales_enquiries'), to_regclass('public.helm_sales_settings')) and c.relrowsecurity) = 2
    and not has_table_privilege('anon', 'public.sales_enquiries', 'select') and not has_table_privilege('authenticated', 'public.sales_enquiries', 'select')
    and not has_table_privilege('anon', 'public.sales_enquiries', 'insert') and not has_table_privilege('authenticated', 'public.helm_sales_settings', 'update'));
  perform pg_temp.res('02 one settings row: notifications@helm.events, thank-you on, form open',
    (select count(*) from public.helm_sales_settings) = 1
    and exists (select 1 from public.helm_sales_settings where notify_email = 'notifications@helm.events' and auto_reply and form_open));
  perform pg_temp.res('03 grants: anon may only submit; HQ RPCs signed-in (checked inside); helpers nobody',
    has_function_privilege('anon', 'public.submit_sales_enquiry(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.hq_sales_enquiries(text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_sales_enquiries(text)', 'execute')
    and not has_function_privilege('anon', 'public._r24s_mail(text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r24s_mail(text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r24s_cfg()', 'execute'));
  perform pg_temp.res('04 outbox kind check is a superset (old kinds + the two new ones), claim has one new branch',
    (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'helm_notice_outbox_kind_check') ~ 'sales_request.*'
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'helm_notice_outbox_kind_check') like '%''upgrade_ask''%'
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'helm_notice_outbox_kind_check') like '%''sales_enquiry_ack''%'
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'helm_notice_outbox_kind_check') like '%''inbox_digest''%'
    and (length(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure))
         - length(replace(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure), 'r24-contact-0271', ''))) = length('r24-contact-0271'));
  perform pg_temp.res('05 HQ bell label', public._sa54_label('sales_enquiry') = 'New sales enquiry' and public._sa54_label('member_removed') = 'Member removed');
end $$;

-- ---- 2) the public form ----------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.anon();
  r := public.submit_sales_enquiry(pg_temp.form('Priya@SharmaEvents.in'));
  perform pg_temp.su();
  perform pg_temp.res('10 a good enquiry: ok, one row (status New, e-mail lower-cased, phone digits, hashed network, UA), nothing read back',
    r = '{"ok": true}'::jsonb
    and (select count(*) from public.sales_enquiries) = 1
    and exists (select 1 from public.sales_enquiries where email = 'priya@sharmaevents.in' and phone = '+919876543210' and status = 'new'
                and plan = 'studio' and team_size = '6-15' and events_per_year = '21-50' and source = 'contact_page'
                and ip_hash ~ '^[0-9a-f]{64}$' and user_agent = 'TestUA/1'), r::text);
  perform pg_temp.res('11 two e-mails queued: alert + thank-you; HQ bell notice count 1',
    (select count(*) from public.helm_notice_outbox where kind = 'sales_enquiry') = 1
    and (select count(*) from public.helm_notice_outbox where kind = 'sales_enquiry_ack') = 1
    and (select count from public.hq_security_notices where alert_type = 'sales_enquiry') = 1);
  perform pg_temp.anon();
  r := public.submit_sales_enquiry(pg_temp.form('priya@sharmaevents.in'));
  perform pg_temp.su();
  perform pg_temp.res('12 the same message again within an hour: ok, kept once, nothing queued again',
    r ->> 'ok' = 'true' and (select count(*) from public.sales_enquiries) = 1 and (select count(*) from public.helm_notice_outbox where kind like 'sales_enquiry%') = 2, r::text);
  perform pg_temp.anon('203.0.113.8');
  r := public.submit_sales_enquiry(pg_temp.form('priya@sharmaevents.in', '{"message": "Second question", "source": "home"}'));
  perform pg_temp.su();
  perform pg_temp.res('13 a new message the same day: saved + alert, but NO second thank-you; bell count 2; source home',
    r ->> 'ok' = 'true' and (select count(*) from public.sales_enquiries) = 2
    and (select count(*) from public.helm_notice_outbox where kind = 'sales_enquiry') = 2
    and (select count(*) from public.helm_notice_outbox where kind = 'sales_enquiry_ack') = 1
    and (select count from public.hq_security_notices where alert_type = 'sales_enquiry') = 2
    and exists (select 1 from public.sales_enquiries where source = 'home'), r::text);
  -- validation
  perform pg_temp.anon('203.0.113.9');
  perform pg_temp.res('14 missing name / bad e-mail / bad phone / missing company / no consent -> the field',
    public.submit_sales_enquiry(pg_temp.form('a@b.in', '{"name": " "}')) ->> 'field' = 'name'
    and public.submit_sales_enquiry(pg_temp.form('not-an-email')) ->> 'field' = 'email'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"phone": "12345"}')) ->> 'field' = 'phone'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"company": ""}')) ->> 'field' = 'company'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"consent": false}')) ->> 'field' = 'consent');
  perform pg_temp.anon('203.0.113.10');
  perform pg_temp.res('15 unknown plan / team size / events / extra key / nested object -> refused',
    public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"plan": "gold"}')) ->> 'field' = 'plan'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"team_size": "1000"}')) ->> 'field' = 'team_size'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"events_per_year": "9"}')) ->> 'field' = 'events_per_year'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"org_id": "x"}')) ->> 'reason' = 'invalid'
    and public.submit_sales_enquiry(pg_temp.form('x@y.in', '{"message": {"a": 1}}')) ->> 'reason' = 'invalid'
    and public.submit_sales_enquiry(null) ->> 'reason' = 'invalid');
  perform pg_temp.su();
  perform pg_temp.res('16 nothing saved by refused tries', (select count(*) from public.sales_enquiries) = 2);
  perform pg_temp.anon('203.0.113.11');
  r := public.submit_sales_enquiry(pg_temp.form('bot@spam.in', '{"website": "http://spam"}'));
  perform pg_temp.su();
  perform pg_temp.res('17 honeypot filled: answered ok, nothing kept, nothing queued',
    r = '{"ok": true}'::jsonb and not exists (select 1 from public.sales_enquiries where email = 'bot@spam.in')
    and (select count(*) from public.helm_notice_outbox where kind like 'sales_enquiry%') = 3, r::text);
  perform pg_temp.anon('203.0.113.12');
  r := public.submit_sales_enquiry(pg_temp.form('safe@x.in', '{"name": "<b>Ravi</b>\u0007", "message": "<script>x</script>", "captcha": "tok"}'));
  perform pg_temp.su();
  perform pg_temp.res('18 < > and control characters flattened; a captcha token is accepted',
    r ->> 'ok' = 'true' and exists (select 1 from public.sales_enquiries where email = 'safe@x.in' and name !~ '[<>[:cntrl:]]' and message !~ '[<>]'), r::text);
exception when others then perform pg_temp.su(); insert into _tp values ('1x form', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) rate limits -------------------------------------------------------------------------------------------------
do $$ declare r jsonb; i int; n int := 0; begin
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%';
  for i in 1..4 loop
    perform pg_temp.anon('198.51.100.' || i);
    r := public.submit_sales_enquiry(pg_temp.form('repeat@x.in', jsonb_build_object('message', 'm' || i, 'phone', null)));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('20 per e-mail: 3 a day, the 4th is refused (rate)', n = 3 and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%'; n := 0;
  for i in 1..4 loop
    perform pg_temp.anon('198.51.101.' || i);
    r := public.submit_sales_enquiry(pg_temp.form('p' || i || '@x.in', jsonb_build_object('phone', '9811122233')));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('21 per phone: 3 a day', n = 3 and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%'; n := 0;
  for i in 1..9 loop
    perform pg_temp.anon('192.0.2.50');
    r := public.submit_sales_enquiry(pg_temp.form('ip' || i || '@x.in', '{"phone": null}'));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('22 per network: 8 an hour', n = 8 and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%';
  insert into public.auth_rate_hits(bucket, key, window_start, n) values ('sales.all', 'all', now(), 60);
  perform pg_temp.anon('192.0.2.77');
  r := public.submit_sales_enquiry(pg_temp.form('global@x.in'));
  perform pg_temp.res('23 everyone together: 60 an hour', r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sales.%';
exception when others then perform pg_temp.su(); insert into _tp values ('2x rate', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) HQ --------------------------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v uuid; begin
  perform pg_temp.su(); select id into v from public.sales_enquiries where email = 'priya@sharmaevents.in' order by created_at limit 1;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.hq_sales_enquiries(null)');
  perform pg_temp.res('30 a studio admin cannot read the list', e like '42501%', e);
  e := pg_temp.try(format('select public.hq_set_sales_enquiry(%L, ''won'', null)', v));
  perform pg_temp.res('31 a studio admin cannot change one', e like '42501%', e);
  e := pg_temp.try('select public.hq_set_sales_enquiry_settings(''me@evil.in'', null, null)');
  perform pg_temp.res('32 a studio admin cannot change the address', e like '42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try('select public.hq_sales_enquiries(null)');
  perform pg_temp.res('33 anon cannot read the list', e like '42501%', e);
  perform pg_temp.op();
  r := public.hq_sales_enquiries(null);
  perform pg_temp.res('34 HQ: rows newest first, counts, settings',
    jsonb_array_length(r -> 'rows') >= 3 and (r -> 'counts' ->> 'new')::int >= 3
    and r -> 'settings' ->> 'notify_email' = 'notifications@helm.events' and (r -> 'settings' ->> 'auto_reply')::boolean, left(r::text, 300));
  r := public.hq_set_sales_enquiry(v, 'contacted', 'Called, demo on Friday');
  perform pg_temp.res('35 HQ marks contacted + note (audit-logged)',
    r ->> 'status' = 'contacted' and r ->> 'hq_note' = 'Called, demo on Friday', r::text);
  perform pg_temp.su();
  perform pg_temp.res('35b the change is in the audit log',
    exists (select 1 from public.audit_log where action = 'hq.sales_enquiry.update' and entity_id = v::text));
  perform pg_temp.op();
  r := public.hq_set_sales_enquiry(v, null, 'Updated note');
  perform pg_temp.res('36 note only keeps the status', r ->> 'status' = 'contacted' and r ->> 'hq_note' = 'Updated note', r::text);
  r := public.hq_set_sales_enquiry(v, 'won', '');
  perform pg_temp.res('37 status won, empty note clears it', r ->> 'status' = 'won' and r ->> 'hq_note' is null, r::text);
  e := pg_temp.try(format('select public.hq_set_sales_enquiry(%L, ''maybe'', null)', v));
  perform pg_temp.res('38 a bad status is refused', e like '22023%', e);
  r := public.hq_sales_enquiries('won');
  perform pg_temp.res('39 filter by status', jsonb_array_length(r -> 'rows') = 1, left(r::text, 200));
  e := pg_temp.try('select public.hq_set_sales_enquiry_settings(''not an email'', null, null)');
  perform pg_temp.res('40 a bad address is refused', e like '22023%', e);
  r := public.hq_set_sales_enquiry_settings('Sales@Helm.Events', null, null);
  perform pg_temp.res('41 HQ changes the address (lower-cased), others kept',
    r ->> 'notify_email' = 'sales@helm.events' and (r ->> 'auto_reply')::boolean and (r ->> 'form_open')::boolean, r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _tp values ('3x HQ', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) the e-mail lane ---------------------------------------------------------------------------------------------
do $$ declare r jsonb; x jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.helm_notice_outbox_claim(10)');
  perform pg_temp.res('50 the claim is service role only', e like '42501%', e);
  -- one unsubscribed sender: the thank-you to them is skipped
  perform pg_temp.su();
  insert into public.email_optouts(org_key, email_lc) values (public._eu165_key(null), public._eu165_norm('safe@x.in')) on conflict do nothing;
  perform pg_temp.svc(); r := public.helm_notice_outbox_claim(100); perform pg_temp.su();
  select z into x from jsonb_array_elements(r) z where z ->> 'kind' = 'sales_enquiry' and z -> 'data' ->> 'email' = 'priya@sharmaevents.in' limit 1;
  perform pg_temp.res('51 alert goes to the HQ address (from settings, read at claim) with every detail',
    x -> 'to' = '["sales@helm.events"]'::jsonb and x -> 'data' ->> 'company' = 'Sharma Events' and x -> 'data' ->> 'plan' = 'studio'
    and x -> 'data' ->> 'phone' = '+919876543210', coalesce(x::text, left(r::text, 300)));
  select z into x from jsonb_array_elements(r) z where z ->> 'kind' = 'sales_enquiry_ack' and z -> 'to' ->> 0 = 'priya@sharmaevents.in' limit 1;
  perform pg_temp.res('52 the thank-you goes to the sender only (name + plan, nothing else)',
    x is not null and jsonb_array_length(x -> 'to') = 1 and x -> 'data' = '{"name": "Priya Sharma", "plan": "studio"}'::jsonb, coalesce(x::text, ''));
  perform pg_temp.res('53 no thank-you to an unsubscribed address (row skipped)',
    not exists (select 1 from jsonb_array_elements(r) z where z ->> 'kind' = 'sales_enquiry_ack' and z -> 'to' ->> 0 = 'safe@x.in')
    and exists (select 1 from public.helm_notice_outbox o join public.sales_enquiries s on s.id = o.ref_id
                 where o.kind = 'sales_enquiry_ack' and s.email = 'safe@x.in' and o.status = 'skipped'));
  perform pg_temp.res('54 the older kinds still pass the check (a sales_request row can be queued)',
    pg_temp.try('insert into public.helm_notice_outbox(kind, dedupe_key) values (''sales_request'', ''t271'')') = '');
  -- thank-you switched off: nothing new is queued, a waiting one is skipped at claim
  perform pg_temp.op(); perform public.hq_set_sales_enquiry_settings(null, false, null);
  perform pg_temp.anon('203.0.113.99'); r := public.submit_sales_enquiry(pg_temp.form('later@x.in', '{"phone": null}')); perform pg_temp.su();
  perform pg_temp.res('55 thank-you off: no thank-you queued for a new sender; the alert still is',
    r ->> 'ok' = 'true' and not exists (select 1 from public.helm_notice_outbox o join public.sales_enquiries s on s.id = o.ref_id
      where o.kind = 'sales_enquiry_ack' and s.email = 'later@x.in')
    and exists (select 1 from public.helm_notice_outbox o join public.sales_enquiries s on s.id = o.ref_id
      where o.kind = 'sales_enquiry' and s.email = 'later@x.in'), r::text);
  -- form closed
  perform pg_temp.op(); perform public.hq_set_sales_enquiry_settings(null, null, false);
  perform pg_temp.anon('203.0.113.98'); r := public.submit_sales_enquiry(pg_temp.form('closed@x.in')); perform pg_temp.su();
  perform pg_temp.res('56 form closed: refused, nothing saved', r ->> 'reason' = 'closed' and not exists (select 1 from public.sales_enquiries where email = 'closed@x.in'), r::text);
exception when others then perform pg_temp.su(); insert into _tp values ('5x lane', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) the suggestions box -----------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v uuid; i int; n int := 0; begin
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sugg.%';
  perform pg_temp.res('60 suggestions table: RLS on, no table privilege; anon + signed-in may submit; HQ list signed-in only (checked inside)',
    (select relrowsecurity from pg_class where oid = 'public.suggestions'::regclass)
    and not has_table_privilege('anon', 'public.suggestions', 'select') and not has_table_privilege('authenticated', 'public.suggestions', 'insert')
    and has_function_privilege('anon', 'public.submit_suggestion(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.hq_suggestions(text)', 'execute')
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'helm_notice_outbox_kind_check') like '%''suggestion''%'
    and public._sa54_label('suggestion') = 'New suggestion');
  perform pg_temp.login('a_admin@a.test');
  r := public.submit_suggestion('{"message": "Please add a Gantt view", "category": "idea", "page": "/dashboard", "studio_id": "x"}');
  perform pg_temp.res('61 an unknown key (e.g. a studio id) is refused', r ->> 'reason' = 'invalid', r::text);
  r := public.submit_suggestion('{"message": "Please add a Gantt view", "category": "idea", "page": "/dashboard"}');
  perform pg_temp.su();
  perform pg_temp.res('62 signed in: saved with the person, THEIR studio, their e-mail, source app; e-mail queued; HQ bell',
    r = '{"ok": true}'::jsonb
    and exists (select 1 from public.suggestions g join auth.users u on u.id = g.user_id
                 where u.email = 'a_admin@a.test' and g.studio_id = 'a0000000-0000-4000-8000-000000000001' and g.source = 'app'
                   and g.category = 'idea' and g.email = 'a_admin@a.test' and g.page = '/dashboard' and g.status = 'new')
    and exists (select 1 from public.helm_notice_outbox o join public.suggestions g on g.id = o.ref_id where o.kind = 'suggestion')
    and (select count from public.hq_security_notices where alert_type = 'suggestion') = 1, r::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.submit_suggestion('{"message": "Please add a Gantt view", "category": "idea"}');
  perform pg_temp.su();
  perform pg_temp.res('63 the same text again within an hour: kept once', r ->> 'ok' = 'true' and (select count(*) from public.suggestions) = 1, r::text);
  perform pg_temp.anon('203.0.113.200');
  perform pg_temp.res('64 visitor: empty message / bad kind / bad e-mail refused',
    public.submit_suggestion('{"message": " "}') ->> 'field' = 'message'
    and public.submit_suggestion('{"message": "Nice site", "category": "praise"}') ->> 'field' = 'category'
    and public.submit_suggestion('{"message": "Nice site", "email": "nope"}') ->> 'field' = 'email');
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sugg.%';
  perform pg_temp.anon('203.0.113.201');
  r := public.submit_suggestion('{"message": "Your pricing page <b>is</b> unclear", "category": "problem", "email": "Visitor@Mail.in"}');
  perform pg_temp.su();
  perform pg_temp.res('65 visitor: saved (source site, no person / studio, e-mail lower-cased, < > flattened)',
    r ->> 'ok' = 'true' and exists (select 1 from public.suggestions where source = 'site' and user_id is null and studio_id is null
      and email = 'visitor@mail.in' and message !~ '[<>]' and ip_hash ~ '^[0-9a-f]{64}$'), r::text);
  perform pg_temp.anon('203.0.113.202');
  r := public.submit_suggestion('{"message": "spam spam", "website": "x"}');
  perform pg_temp.su();
  perform pg_temp.res('66 honeypot: ok, nothing kept', r = '{"ok": true}'::jsonb and not exists (select 1 from public.suggestions where message = 'spam spam'));
  delete from public.auth_rate_hits where bucket like 'sugg.%';
  for i in 1..6 loop
    perform pg_temp.anon('192.0.2.150'); r := public.submit_suggestion(jsonb_build_object('message', 'idea number ' || i));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('67 visitors: 5 an hour per network', n = 5 and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sugg.%'; n := 0;
  for i in 1..11 loop
    perform pg_temp.login('a_admin@a.test'); r := public.submit_suggestion(jsonb_build_object('message', 'app idea ' || i));
    if r ->> 'ok' = 'true' then n := n + 1; end if;
  end loop;
  perform pg_temp.res('68 signed in: 10 an hour per person', n = 10 and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'sugg.%';
  select id into v from public.suggestions where message = 'Please add a Gantt view';
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.hq_suggestions(null)');
  perform pg_temp.res('69 a studio admin cannot read the suggestions list', e like '42501%', e);
  e := pg_temp.try(format('select public.hq_set_suggestion(%L, ''done'', null)', v));
  perform pg_temp.res('70 a studio admin cannot change one', e like '42501%', e);
  perform pg_temp.op();
  r := public.hq_suggestions(null);
  perform pg_temp.res('71 HQ: list with who + studio + counts',
    (r -> 'counts' ->> 'new')::int >= 3 and exists (select 1 from jsonb_array_elements(r -> 'rows') x
       where x ->> 'id' = v::text and x ->> 'studio' is not null and x ->> 'who' is not null), left(r::text, 300));
  r := public.hq_set_suggestion(v, 'reviewed', 'Good idea, planned');
  perform pg_temp.res('72 HQ marks reviewed + note', r ->> 'status' = 'reviewed' and r ->> 'hq_note' = 'Good idea, planned', r::text);
  e := pg_temp.try(format('select public.hq_set_suggestion(%L, ''won'', null)', v));
  perform pg_temp.res('73 a bad status is refused', e like '22023%', e);
  perform pg_temp.res('74 filter done is empty', jsonb_array_length(public.hq_suggestions('done') -> 'rows') = 0);
  perform pg_temp.svc(); r := public.helm_notice_outbox_claim(100); perform pg_temp.su();
  perform pg_temp.res('75 the suggestion e-mail goes to the HQ address with the message, studio and who',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'kind' = 'suggestion' and x -> 'data' ->> 'message' = 'Please add a Gantt view'
      and x -> 'to' ->> 0 = (select notify_email from public.helm_sales_settings) and x -> 'data' ->> 'studio' is not null), left(r::text, 400));
exception when others then perform pg_temp.su(); insert into _tp values ('6x suggestions', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R24-CONTACT-0271: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R24-CONTACT-0271: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
