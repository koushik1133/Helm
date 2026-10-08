-- client-360.sql - 0062: one page per client, RPC client_timeline(p_ref, p_limit).
-- Fixture: Studio A (a_admin admin, a_staff sales) and Studio B (b_admin, b_staff).
-- One transaction, rolled back at the end. All values are fake test data.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ct(name text, result text); grant all on _ct to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; execute 'set local session_replication_role = origin'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica; insert into _ct values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- fetch a timeline as a user; returns the jsonb (or {"err": sqlstate})
create or replace function pg_temp.t(p_email text, p_ref uuid, p_aal text default 'aal1') returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email, p_aal);
  begin j := public.client_timeline(p_ref); exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.su(); return j;
end $$;
create or replace function pg_temp.kinds(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(distinct e ->> 'kind', ',' order by e ->> 'kind'), '') from jsonb_array_elements(coalesce(j -> 'items', '[]'::jsonb)) e $$;
create or replace function pg_temp.nk(j jsonb, k text) returns int language sql immutable as $$
  select count(*)::int from jsonb_array_elements(coalesce(j -> 'items', '[]'::jsonb)) e where e ->> 'kind' = k $$;
-- set one studio's matrix row for a role (test data only)
create or replace function pg_temp.grant_area(p_org uuid, p_role text, p_area text, p_view boolean) returns void language plpgsql as $$
begin perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values (p_role, p_area, p_view, false, p_org, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = false;
end $$;

-- ---- test data: one client (Asha) with a lead, two events, payments, files, tasks, chat ------
-- plus a different Asha-free client and a studio-B twin with the same phone.
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q1 uuid := 'a0000000-0000-4000-8000-00000000c601'; q2 uuid := 'a0000000-0000-4000-8000-00000000c602';
  qo uuid := 'a0000000-0000-4000-8000-00000000c603'; qb uuid := 'b0000000-0000-4000-8000-00000000c601';
  cv uuid := 'a0000000-0000-4000-8000-00000000c6c1'; cv2 uuid := 'a0000000-0000-4000-8000-00000000c6c2';
  adm uuid; c uuid; m uuid;
begin perform pg_temp.su(); set local session_replication_role = replica;
  select id into adm from auth.users where email = 'a_admin@a.test';
  insert into public.quotes (id, code, title, status, client, pricing, org_id, created_at, updated_at, confirmed_at) values
    (q1, 'A-C601', 'Asha wedding', 'confirmed', '{"name":"Asha Rao","phone":"+91 97000 06201"}', '{"total":100000}', a, now() - interval '30 days', now() - interval '1 day', now() - interval '20 days'),
    (q2, 'A-C602', 'Asha reception', 'quote', '{"name":"ASHA RAO","email":"Asha@Example.test"}', '{"total":50000}', a, now() - interval '10 days', now() - interval '10 days', null),
    (qo, 'A-C603', 'Other party', 'quote', '{"name":"Other Person","phone":"+910000000001"}', '{"total":7000}', a, now(), now(), null);
  insert into public.quotes (id, code, title, status, client, pricing, org_id) values
    (qb, 'B-C601', 'Twin in B', 'quote', '{"name":"Asha Rao","phone":"+91 97000 06201"}', '{"total":999}', b);
  insert into public.leads (id, name, phone, email, status, event_type, org_id, quote_id, created_at, updated_at) values
    ('a0000000-0000-4000-8000-00000000c6a1', 'Asha Rao', '9700006201', 'asha@example.test', 'won', 'Wedding', a, q1, now() - interval '40 days', now() - interval '25 days'),
    ('a0000000-0000-4000-8000-00000000c6a2', 'Somebody Else', '+910000000009', null, 'new', null, a, null, now(), now());
  insert into public.leads (id, name, phone, status, org_id) values ('b0000000-0000-4000-8000-00000000c6a1', 'Asha Rao', '9700006201', 'new', b);
  insert into public.quote_payments (quote_id, amount, status, receipt_no, org_id, paid_at) values
    (q1, 30000, 'paid', 'RCPT-C601-1', a, now() - interval '15 days'), (q1, 5000, 'created', null, a, null),
    (qo, 7000, 'paid', 'RCPT-OTHER', a, now()), (qb, 999, 'paid', 'RCPT-B-TWIN', b, now());
  insert into public.payment_milestones (quote_id, label, amount, status, due_date, org_id) values (q1, 'Advance', 30000, 'paid', current_date, a);
  insert into public.event_files (quote_id, storage_path, filename, org_id, uploaded_by) values (q1, a::text || '/' || q1::text || '/contract.pdf', 'contract.pdf', a, adm), (qo, a::text || '/' || qo::text || '/other.pdf', 'other.pdf', a, adm);
  insert into public.event_tasks (quote_id, category, title, status, org_id) values (q2, 'decor', 'Stage flowers', 'assigned', a);
  insert into public.chat_conversations (id, org_id, kind, title, quote_id, created_by) values (cv, a, 'group', 'Asha wedding chat', q1, adm), (cv2, a, 'group', 'Secret planning', q2, adm);
  insert into public.chat_members (conversation_id, user_id, org_id) values (cv, adm, a);
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body) values
    (cv, a, adm, 'text', 'Mandap colours agreed'), (cv2, a, adm, 'text', 'Not for everyone');
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, deleted) values (cv, a, adm, 'text', 'deleted words', true);
  c := coalesce((select id from auth.users where email = 'ct_client@a.test'), auth.seed_user('ct_client@a.test'));
  m := coalesce((select id from auth.users where email = 'ct_mfa@a.test'), auth.seed_user('ct_mfa@a.test'));
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at) values
    (c, 'ct_client@a.test', 'client', a, 'Ct Client', false, now()), (m, 'ct_mfa@a.test', 'admin', a, 'Mfa Admin', false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  insert into auth.mfa_factors (id, user_id, status, factor_type, created_at, updated_at) values (gen_random_uuid(), m, 'verified', 'totp', now(), now());
end $$;

-- ---- privileges / refusals -------------------------------------------------------------------
do $$ declare j jsonb; q1 uuid := 'a0000000-0000-4000-8000-00000000c601'; begin
  perform pg_temp.res('01 anon cannot execute', not has_function_privilege('anon', 'public.client_timeline(uuid,integer)', 'execute'));
  perform pg_temp.res('02 members can execute', has_function_privilege('authenticated', 'public.client_timeline(uuid,integer)', 'execute'));
  perform pg_temp.res('03 security definer + empty search_path', (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.client_timeline(uuid,integer)'::regprocedure));
  perform pg_temp.res('04 read-only (stable)', (select provolatile = 's' from pg_proc where oid = 'public.client_timeline(uuid,integer)'::regprocedure));
  perform pg_temp.su(); perform auth.login_anon();
  begin j := public.client_timeline(q1); j := '{}'; exception when others then j := jsonb_build_object('err', sqlstate); end;
  perform pg_temp.res('05 signed-out caller refused', j ->> 'err' = '42501', coalesce(j::text, 'null'));
  j := pg_temp.t('ct_client@a.test', q1);
  perform pg_temp.res('06 client role refused', j ->> 'err' = '42501', j::text);
  j := pg_temp.t('ct_mfa@a.test', q1, 'aal1');
  perform pg_temp.res('07 two-step pending refused', j ->> 'err' = '42501', j::text);
  j := pg_temp.t('ct_mfa@a.test', q1, 'aal2');
  perform pg_temp.res('08 same member at aal2 allowed', j ? 'items', left(j::text, 200));
  j := pg_temp.t('a_admin@a.test', null);
  perform pg_temp.res('09 null ref: not found', j ->> 'err' = 'P0002', j::text);
  j := pg_temp.t('a_admin@a.test', gen_random_uuid());
  perform pg_temp.res('10 unknown ref: not found', j ->> 'err' = 'P0002', j::text);
  j := pg_temp.t('a_admin@a.test', 'b0000000-0000-4000-8000-00000000c601');
  perform pg_temp.res('11 other studio event: not found', j ->> 'err' = 'P0002', j::text);
  j := pg_temp.t('a_admin@a.test', 'b0000000-0000-4000-8000-00000000c6a1');
  perform pg_temp.res('12 other studio lead: not found', j ->> 'err' = 'P0002', j::text);
end $$;

-- ---- admin view: merge + isolation --------------------------------------------------------------
do $$ declare j jsonb; j2 jsonb; begin
  j := pg_temp.t('a_admin@a.test', 'a0000000-0000-4000-8000-00000000c601');
  perform pg_temp.res('13 header name from the event', j -> 'client' ->> 'name' = 'Asha Rao', j ->> 'client');
  perform pg_temp.res('14 lead + both events merged (phone digits, linked, email, name)', (j -> 'counts' ->> 'leads')::int = 1 and (j -> 'counts' ->> 'events')::int = 2, j ->> 'counts');
  perform pg_temp.res('15 every kind present', pg_temp.kinds(j) = 'events,files,leads,messages,payments,tasks', pg_temp.kinds(j));
  perform pg_temp.res('16 quoted = 150000', (j -> 'totals' ->> 'quoted')::numeric = 150000, j ->> 'totals');
  perform pg_temp.res('17 paid counts paid only = 30000', (j -> 'totals' ->> 'paid')::numeric = 30000, j ->> 'totals');
  perform pg_temp.res('18 due = 120000', (j -> 'totals' ->> 'due')::numeric = 120000, j ->> 'totals');
  perform pg_temp.res('19 no studio B rows', j::text !~ '(B-C601|RCPT-B-TWIN|b0000000|Twin in B)', j::text);
  perform pg_temp.res('20 other clients excluded', j::text !~ '(A-C603|RCPT-OTHER|other\.pdf|Somebody Else)', j::text);
  perform pg_temp.res('21 newest first', (select bool_and(a >= b) from (select (e ->> 'at')::timestamptz a, lead((e ->> 'at')::timestamptz) over (order by o) b
      from jsonb_array_elements(j -> 'items') with ordinality t(e, o)) s where b is not null));
  perform pg_temp.res('22 every item has kind/at/id/title/subtitle/link', not exists (select 1 from jsonb_array_elements(j -> 'items') e
      where not (e ? 'kind' and e ? 'at' and e ? 'id' and e ? 'title' and e ? 'subtitle' and e ? 'link')));
  perform pg_temp.res('23 links are own-app pages only', not exists (select 1 from jsonb_array_elements(j -> 'items') e
      where (e ->> 'link') !~ '^[a-z][a-z0-9-]*\.html(\?[A-Za-z0-9_=&.-]*)?$'));
  perform pg_temp.res('24 chat: only conversations the caller can see', pg_temp.nk(j, 'messages') = 1 and j::text ~ 'Mandap' and j::text !~ 'Not for everyone', j::text);
  perform pg_temp.res('25 deleted messages hidden', j::text !~ 'deleted words');
  perform pg_temp.res('26 confirmed + version + payment received present', j::text ~ 'Event confirmed' and j::text ~ 'Payment received \(RCPT-C601-1\)' and j::text ~ 'Milestone: Advance', j::text);
  j2 := pg_temp.t('a_admin@a.test', 'a0000000-0000-4000-8000-00000000c6a1');
  perform pg_temp.res('27 same client from the lead', (j2 -> 'counts') = (j -> 'counts') and jsonb_array_length(j2 -> 'items') = jsonb_array_length(j -> 'items'), j2 ->> 'counts');
  perform pg_temp.res('28 contact shown (lead phone)', j2 -> 'client' ->> 'phone' = '9700006201', j2 ->> 'client');
  j2 := pg_temp.t('a_admin@a.test', 'a0000000-0000-4000-8000-00000000c603');
  perform pg_temp.res('29 different client stays separate', (j2 -> 'counts' ->> 'events')::int = 1 and j2::text !~ 'Asha', j2::text);
  j2 := pg_temp.t('b_admin@b.test', 'b0000000-0000-4000-8000-00000000c601');
  perform pg_temp.res('30 studio B sees only its twin', (j2 -> 'counts' ->> 'events')::int = 1 and (j2 -> 'counts' ->> 'leads')::int = 1 and j2::text !~ '(A-C60|a0000000)', j2::text);
  j2 := pg_temp.t('b_admin@b.test', 'a0000000-0000-4000-8000-00000000c601');
  perform pg_temp.res('31 studio B cannot open studio A client', j2 ->> 'err' = 'P0002', j2::text);
end $$;

-- ---- role matrix is the authority, per section ----------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; j jsonb; ar text;
  q1 uuid := 'a0000000-0000-4000-8000-00000000c601'; l1 uuid := 'a0000000-0000-4000-8000-00000000c6a1'; begin
  foreach ar in array array['leads','quotes','staff','finance','media'] loop
    perform pg_temp.grant_area(a, 'sales', ar, false);
    perform pg_temp.grant_area(b, 'sales', ar, true);   -- studio B's matrix must not leak into A
  end loop;
  j := pg_temp.t('a_staff@a.test', q1);
  perform pg_temp.res('32 no leads/quotes view: not found', j ->> 'err' = 'P0002', j::text);
  perform pg_temp.grant_area(a, 'sales', 'leads', true);
  j := pg_temp.t('a_staff@a.test', q1);
  perform pg_temp.res('33 leads only: event ref still not found', j ->> 'err' = 'P0002', j::text);
  j := pg_temp.t('a_staff@a.test', l1);
  perform pg_temp.res('34 leads only: lead ref works, leads + chat only', pg_temp.kinds(j) in ('leads', 'leads,messages') and j -> 'totals' = 'null'::jsonb and not (j -> 'counts' ? 'events'), j::text);
  perform pg_temp.res('35 leads only: no event titles or money', j::text !~ '(A-C60|RCPT|contract\.pdf|Stage flowers|150000)', j::text);
  perform pg_temp.grant_area(a, 'sales', 'quotes', true);
  j := pg_temp.t('a_staff@a.test', q1);
  perform pg_temp.res('36 + quotes: events and files, quoted only', pg_temp.kinds(j) ~ 'events' and pg_temp.kinds(j) ~ 'files' and pg_temp.kinds(j) !~ '(payments|tasks)'
      and (j -> 'totals' ? 'quoted') and not (j -> 'totals' ? 'paid') and not (j -> 'totals' ? 'due'), j::text);
  perform pg_temp.grant_area(a, 'sales', 'finance', true);
  j := pg_temp.t('a_staff@a.test', q1);
  perform pg_temp.res('37 + finance: payments, paid and due', pg_temp.kinds(j) ~ 'payments' and (j -> 'totals' ->> 'due')::numeric = 120000, j ->> 'totals');
  perform pg_temp.grant_area(a, 'sales', 'staff', true);
  j := pg_temp.t('a_staff@a.test', q1);
  perform pg_temp.res('38 + staff: tasks', pg_temp.nk(j, 'tasks') = 1, pg_temp.kinds(j));
  perform pg_temp.res('39 non-member never sees private chats', pg_temp.nk(j, 'messages') = 0, j::text);
  perform pg_temp.grant_area(a, 'sales', 'quotes', false); perform pg_temp.grant_area(a, 'sales', 'media', true);
  j := pg_temp.t('a_staff@a.test', l1);
  perform pg_temp.res('40 media without quotes: files yes, events no, no due', pg_temp.kinds(j) ~ 'files' and pg_temp.kinds(j) !~ 'events' and not (j -> 'totals' ? 'due'), j::text);
  perform pg_temp.su(); set local session_replication_role = replica;
  delete from public.role_access where org_id = a and role = 'sales';
  j := pg_temp.t('a_staff@a.test', l1);
  perform pg_temp.res('41 no matrix rows: not found', j ->> 'err' = 'P0002', j::text);
end $$;

-- ---- limits + nothing written ----------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  j := public.client_timeline('a0000000-0000-4000-8000-00000000c601', 2);
  perform pg_temp.res('42 p_limit trims the timeline', jsonb_array_length(j -> 'items') = 2, j::text);
  perform pg_temp.login('a_admin@a.test');
  j := public.client_timeline('a0000000-0000-4000-8000-00000000c601', -5);
  perform pg_temp.res('43 p_limit floor 1', jsonb_array_length(j -> 'items') = 1, j::text);
  perform pg_temp.res('44 no table owned by 0062', not exists (select 1 from pg_class where relname like 'client_timeline%'));
end $$;

select name, result from _ct order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then format('CLIENT-360: ALL PASS (%s/%s)', count(*), count(*))
            else format('CLIENT-360: %s FAILED', count(*) filter (where result <> 'PASS')) end as summary
  from _ct;
rollback;
