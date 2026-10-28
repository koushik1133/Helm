-- audit-p2-0156.sql - 0156: audit run 3 P2 low database fixes (behavioral).
-- Local disposable test DB only (two-tenant fixture). Prints AUDIT-P2-0156: ALL PASS (n/n).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _a156; create temp table _a156(name text, result text); grant all on _a156 to anon, authenticated;

-- run p_sql as a user ('anon' / e-mail / null = superuser); 'ok:<rows>' or 'err:<state>:<msg>'
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare n bigint;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql; get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || n;
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
-- same, but returns the text value of a one-value query
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return coalesce(v, '<null>');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _a156 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

-- everything below runs in ONE transaction that is rolled back at the end, so later suites see
-- the fixture exactly as before (the results are printed before the rollback)
begin;

-- setup (superuser): a client-role member in Studio A, the areas the tests use, a booklet + site
do $$ declare u uuid;
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  execute 'reset role';
  select id into u from auth.users where email = 'c_client156@a.test';
  if u is null then u := auth.seed_user('c_client156@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, 'c_client156@a.test', 'client', orgA, false, now())
    on conflict (id) do update set role = 'client', org_id = orgA;
  insert into public.role_access(role, area, can_view, can_edit, org_id)
    select 'sales', a, true, true, orgA from unnest(array['closure', 'settlement', 'crm', 'staff', 'users']) a
    on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
  update public.quotes set archived_at = null, deleted_at = null,
         approval_token_revoked_at = null, approval_token_expires_at = now() + interval '7 days'
   where id = 'a0000000-0000-4000-8000-00000000da01';
  update public.event_closure set closed_at = null where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.client_booklets(id, org_id, quote_id, token)
    values ('a0000000-0000-4000-8000-000000156b01', orgA, 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000156b0c')
    on conflict (id) do update set revoked_at = null, expires_at = now() + interval '30 days';
  delete from public.pkg_otps where booklet_id = 'a0000000-0000-4000-8000-000000156b01';   -- disposable test DB
end $$;
do $$ begin
  execute 'reset role';
  if not exists (select 1 from public.event_sites where slug = 'a156-site') then
    -- event_sites_guard needs the studio in context (claims only, still superuser), then publish
    perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
    insert into public.event_sites(org_id, quote_id, slug, status, data)
      values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a156-site', 'draft', '{}');
    update public.event_sites set status = 'published', published_at = now() where slug = 'a156-site';
    perform set_config('request.jwt.claims', '', false);
  end if;
end $$;

-- ---- 1) accept_invitation: a same-studio member keeps their role --------------------------
do $$ declare r text; begin
  insert into public.invitations(org_id, email, role, token)
    values ('a0000000-0000-4000-8000-000000000001', 'a_staff@a.test', 'manager', 'a156-tok-staff');
  r := pg_temp.as_val('a_staff@a.test', $q$select public.accept_invitation('a156-tok-staff')::text$q$);
  perform pg_temp.t('invite: same-studio member gets already=true', r like '%"already": true%', r);
  perform pg_temp.t('invite: the member keeps their role (sales, not manager)',
    (select role from public.profiles where email = 'a_staff@a.test') = 'sales', (select role from public.profiles where email = 'a_staff@a.test'));
  perform pg_temp.t('invite: the stale invitation is closed (no longer counts as open)',
    (select status from public.invitations where token = 'a156-tok-staff') = 'accepted', (select status from public.invitations where token = 'a156-tok-staff'));
end $$;

-- ---- 2) create_invitation: admin first, then 0155's caps----------------------------------------
do $$ declare r text; i int; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.create_invitation('new156@x.test', 'crew')$q$);
  perform pg_temp.t('invite: a non-admin is refused first (42501)', r like 'err:42501:not authorized%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.create_invitation('ok156@x.test', 'crew')$q$);
  perform pg_temp.t('invite: an admin can invite', r = 'ok:1', r);
  for i in 1..210 loop   -- over 0155's caps (trial 20 / paid 200 a day) - the one cap set
    insert into public.invitations(org_id, email, role) values ('a0000000-0000-4000-8000-000000000001', 'cap156-' || i || '@x.test', 'crew');
  end loop;
  r := pg_temp.as_try('a_admin@a.test', $q$select public.create_invitation('over156@x.test', 'crew')$q$);
  perform pg_temp.t('invite: over the daily cap is refused (54000)', r like 'err:54000%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.create_invitation('ok156@x.test', 'crew')$q$);
  perform pg_temp.t('invite: re-sending a live invitation still works over the cap', r = 'ok:1', r);
  update public.invitations set status = 'revoked' where email like 'cap156-%';
  update public.invitations set created_at = now() - interval '2 days' where email like 'cap156-%';
end $$;

-- ---- 3) client role: no staff chat, no config reads ------------------------------------------
do $$ declare r text; bc uuid; m uuid; begin
  execute 'reset role';
  select id into bc from public.chat_conversations where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'broadcast' limit 1;
  if bc is null then
    insert into public.chat_conversations(org_id, kind, title) values ('a0000000-0000-4000-8000-000000000001', 'broadcast', 'Everyone') returning id into bc;
  end if;
  insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body)
    values (bc, 'a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_admin@a.test'), 'text', 'a156 hello')
    returning id into m;
  insert into public.coupons(code, kind, value, org_id) values ('A156', 'flat', 10, 'a0000000-0000-4000-8000-000000000001');
  insert into public.app_config(key, value, org_id) values ('a156', '{}'::jsonb, 'a0000000-0000-4000-8000-000000000001') on conflict do nothing;

  r := pg_temp.as_try('c_client156@a.test', format('select 1 from public.chat_messages where conversation_id = %L', bc));
  perform pg_temp.t('client: reads no broadcast messages', r = 'ok:0', r);
  r := pg_temp.as_try('c_client156@a.test', format($q$select public.chat_send(%L, 'text', 'hi from client')$q$, bc));
  perform pg_temp.t('client: cannot post to the broadcast', r like 'err:42501%', r);
  r := pg_temp.as_try('c_client156@a.test', $q$select 1 from public.chat_directory()$q$);
  perform pg_temp.t('client: staff directory is empty', r = 'ok:0', r);
  r := pg_temp.as_try('c_client156@a.test', format('select public.chat_start_dm(%L)', (select id from auth.users where email = 'a_admin@a.test')));
  perform pg_temp.t('client: cannot start a DM', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', format('select 1 from public.chat_messages where conversation_id = %L', bc));
  perform pg_temp.t('staff: still reads the broadcast', r <> 'ok:0' and r like 'ok:%', r);
  r := pg_temp.as_try('c_client156@a.test', $q$select 1 from public.coupons$q$);
  perform pg_temp.t('client: reads no coupons', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select 1 from public.coupons where code = 'A156'$q$);
  perform pg_temp.t('staff: still reads coupons', r = 'ok:1', r);
  r := pg_temp.as_try('c_client156@a.test', $q$select 1 from public.app_config$q$);
  perform pg_temp.t('client: reads no pricing config', r = 'ok:0', r);
  r := pg_temp.as_try('c_client156@a.test', $q$select 1 from public.role_access where role <> 'client'$q$);
  perform pg_temp.t('client: reads no other role''s access rows', r = 'ok:0', r);

  -- 17) a reaction bumps its message (chat_reactions left the realtime publication)
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.chat_react(%L, 'ok', true)$q$, m));
  perform pg_temp.t('chat: a reaction bumps the message (reactions_changed_at)', r = 'ok:1'
    and (select reactions_changed_at from public.chat_messages where id = m) is not null, r);
end $$;

-- ---- 4) shelf kill-switch -------------------------------------------------------------------
do $$ declare r text; tok text := 'a0000000-0000-4000-8000-000000156b0c'; begin
  r := pg_temp.as_try('anon', format('select public.public_get_booklet(%L)', tok));
  perform pg_temp.t('shelf: booklet opens while the event is live', r = 'ok:1', r);
  update public.quotes set archived_at = now() where id = 'a0000000-0000-4000-8000-00000000da01';
  r := pg_temp.as_try('anon', format('select public.public_get_booklet(%L)', tok));
  perform pg_temp.t('shelf: archived -> booklet refused', r like 'err:P0001%invalid link%', r);
  r := pg_temp.as_try('anon', format('select public.public_booklet_packages(%L)', tok));
  perform pg_temp.t('shelf: archived -> packages refused', r like 'err:P0001%', r);
  r := pg_temp.as_try('anon', format('select public.public_booklet_pay_terms(%L)', tok));
  perform pg_temp.t('shelf: archived -> pay terms refused', r like 'err:P0001%', r);
  r := pg_temp.as_val('anon', format($q$select public.public_get_booklet_image(%L, '2d', 'plain')::text$q$, tok));
  perform pg_temp.t('shelf: archived -> no booklet image', r = '<null>', r);
  r := pg_temp.as_try('anon', $q$select * from public.public_event_site('a156-site')$q$);
  perform pg_temp.t('shelf: archived -> invitation site refused', r like 'err:P0001%', r);
  update public.quotes set archived_at = null where id = 'a0000000-0000-4000-8000-00000000da01';
  r := pg_temp.as_try('anon', format('select public.public_get_booklet(%L)', tok));
  perform pg_temp.t('shelf: restored -> booklet works again', r = 'ok:1', r);
  r := pg_temp.as_try('anon', $q$select * from public.public_event_site('a156-site')$q$);
  perform pg_temp.t('shelf: restored -> invitation site works again', r = 'ok:1', r);
end $$;

-- ---- 5) re-open only through reopen_event -----------------------------------------------------
do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  insert into public.event_closure(quote_id, closed_at, org_id) values (q, now(), 'a0000000-0000-4000-8000-000000000001')
    on conflict (quote_id) do update set closed_at = now();
  r := pg_temp.as_val('a_staff@a.test', $q$select public.has_area('closure', 'edit')::text$q$);
  perform pg_temp.t('reopen: the test caller does have closure edit', r = 'true', r);
  r := pg_temp.as_try('a_staff@a.test', format('select public.close_event(%L, false)', q));
  perform pg_temp.t('reopen: close_event(id,false) by closure editor refused', r like 'err:42501:Only an admin%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.close_event(%L, false, 'x')$q$, q));
  perform pg_temp.t('reopen: 3-arg close_event(id,false) refused', r like 'err:42501:Only an admin%', r);
  perform pg_temp.t('reopen: the event stayed closed', (select closed_at from public.event_closure where quote_id = q) is not null, null);
  r := pg_temp.as_try('a_admin@a.test', format($q$select public.reopen_event(%L, 'a156 test re-open')$q$, q));
  perform pg_temp.t('reopen: admin reopen_event still works', r = 'ok:1'
    and (select closed_at from public.event_closure where quote_id = q) is null, r);
end $$;

-- ---- 6) 0152 checks on UPDATE; vendor payout; vendor_bills update refs --------------------
do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; rf uuid; bill uuid; vb uuid; v_paid numeric; begin
  execute 'reset role';
  insert into public.quote_payments(quote_id, amount, status, provider_ref, provider, simulated, org_id)
    values (q, 1000, 'paid', 'a156-pay', 'cash', false, 'a0000000-0000-4000-8000-000000000001');
  v_paid := public.helm_total_paid(q, null, null);
  insert into public.event_refunds(quote_id, kind, amount, status, org_id, created_by)
    values (q, 'refund', 100, 'pending', 'a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_admin@a.test'))
    returning id into rf;
  r := pg_temp.as_try('a_staff@a.test', format('update public.event_refunds set amount = %s where id = %L', v_paid + 5000, rf));
  perform pg_temp.t('refund edit: raising over what was paid is refused', r like 'err:23514%', r);
  r := pg_temp.as_try('a_staff@a.test', format('update public.event_refunds set amount = 200 where id = %L', rf));
  perform pg_temp.t('refund edit: a normal edit still works', r = 'ok:1', r);
  insert into public.vendor_bills(org_id, quote_id, amount) values ('a0000000-0000-4000-8000-000000000001', q, 500) returning id into bill;
  update public.event_closure set closed_at = now() where quote_id = q;
  r := pg_temp.as_try('a_staff@a.test', format('update public.event_refunds set amount = 150 where id = %L', rf));
  perform pg_temp.t('refund edit: refused on a closed event', (r like 'err:23514%closed%' or r like 'err:42501%closed%'), r);   -- r32 0282: the closed-event freeze may answer first
  r := pg_temp.as_try('a_staff@a.test', format('update public.vendor_bills set amount = 600 where id = %L', bill));
  perform pg_temp.t('vendor bill edit: refused on a closed event', r like 'err:23514%closed%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.record_vendor_payout(%L, 100, null, 'cash', null, null)$q$, bill));
  perform pg_temp.t('vendor payout: refused on a closed event', r like 'err:23514%closed%', r);
  update public.event_closure set closed_at = null where quote_id = q;
  insert into public.vendors(name, org_id) values ('B vendor 156', 'b0000000-0000-4000-8000-000000000001') returning id into vb;
  r := pg_temp.as_try('a_staff@a.test', format('update public.vendor_bills set vendor_id = %L where id = %L', vb, bill));
  perform pg_temp.t('vendor bill edit: another studio''s vendor is refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', format('update public.vendor_bills set amount = 650 where id = %L', bill));
  perform pg_temp.t('vendor bill edit: normal edit on an open event works', r = 'ok:1', r);
end $$;

-- ---- 7) lead_archive is read-only from the app ------------------------------------------------
do $$ declare r text; begin
  insert into public.lead_archive(action, name, snapshot, org_id) values ('deleted', 'A156 lead', '{}'::jsonb, 'a0000000-0000-4000-8000-000000000001');
  r := pg_temp.as_try('a_staff@a.test', $q$delete from public.lead_archive where name = 'A156 lead'$q$);
  perform pg_temp.t('lead_archive: a crm editor cannot delete history', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$update public.lead_archive set name = 'x' where name = 'A156 lead'$q$);
  perform pg_temp.t('lead_archive: a crm editor cannot rewrite history', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select 1 from public.lead_archive where name = 'A156 lead'$q$);
  perform pg_temp.t('lead_archive: reading still works', r = 'ok:1', r);
end $$;

-- ---- 8) Razorpay link ids ---------------------------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.record_payment('a0000000-0000-4000-8000-00000000da01', 10, 'cash', 'plink_A156')$q$);
  perform pg_temp.t('razorpay: record_payment refuses a plink_ receipt', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000000da01', 10, 'cash', 'plink_A156')$q$);
  perform pg_temp.t('razorpay: record_settlement_payment refuses a plink_ receipt', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.mark_paid('a0000000-0000-4000-8000-00000000da01', 'plink_A156')$q$);
  perform pg_temp.t('razorpay: mark_paid refuses a plink_ reference', r like 'err:22023%', r);
  insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, simulated, org_id)
    values ('b0000000-0000-4000-8000-00000000da01', 'razorpay', 1, 'paid', 'plink_FORGE156', false, 'b0000000-0000-4000-8000-000000000001');
  r := pg_temp.as_val(null, $q$select public.razorpay_settle(null, 'plink_FORGE156', 'pay_F156', 100, 'payment_link.paid') ->> 'result'$q$);
  perform pg_temp.t('razorpay: a link id typed by staff (no link attached) is not matched', r = 'unmatched', r);
  insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, link_url, simulated, org_id)
    values ('a0000000-0000-4000-8000-00000000da01', 'razorpay', 1, 'created', 'plink_LEGIT156', 'https://rzp.io/l/a156', false, 'a0000000-0000-4000-8000-000000000001');
  r := pg_temp.as_val(null, $q$select public.razorpay_settle(null, 'plink_LEGIT156', 'pay_L156', 100, 'payment_link.paid') ->> 'quote_id'$q$);
  perform pg_temp.t('razorpay: a Helm-attached link still matches its quote', r = 'a0000000-0000-4000-8000-00000000da01', r);
  r := pg_temp.as_try(null, $q$insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, simulated, org_id)
    values ('b0000000-0000-4000-8000-00000000da01', 'razorpay', 1, 'created', 'plink_LEGIT156', false, 'b0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.t('razorpay: a link id can exist only once', r like 'err:23505%', r);
end $$;

-- ---- 9) notify_default closed -------------------------------------------------------------------
do $$ begin
  perform pg_temp.t('notify_default: not callable by anon', not has_function_privilege('anon', 'public.notify_default(uuid,text,text,text)', 'execute'), null);
  perform pg_temp.t('notify_default: not callable by signed-in users', not has_function_privilege('authenticated', 'public.notify_default(uuid,text,text,text)', 'execute'), null);
  perform pg_temp.t('notification_catalog: not callable by anon', not has_function_privilege('anon', 'public.notification_catalog()', 'execute'), null);
  perform pg_temp.t('notification_catalog: still callable signed in', has_function_privilege('authenticated', 'public.notification_catalog()', 'execute'), null);
end $$;

-- ---- 10) booklet package code: cumulative wrong-code cap ------------------------------------------
do $$ declare r text; tok text := 'a0000000-0000-4000-8000-000000156b0c'; i int; begin
  for i in 1..3 loop
    insert into public.pkg_otps(org_id, quote_id, booklet_id, code_hash, channel, attempts, expires_at)
      values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000156b01',
              'x', 'email', 5, now() - interval '1 minute');
  end loop;
  r := pg_temp.as_try('anon', format('select public.public_booklet_otp_request(%L)', tok));
  perform pg_temp.t('pkg code: 15 wrong codes today -> no new code', r like 'err:P0001%too many wrong codes%', r);
  r := pg_temp.as_val('anon', format($q$select public.public_booklet_choose(%L, gen_random_uuid(), 10, null, '123456') ->> 'status'$q$, tok));
  perform pg_temp.t('pkg code: 15 wrong codes today -> guesses refused', r = 'rate_limited', r);
  update public.pkg_otps set created_at = now() - interval '2 days' where booklet_id = 'a0000000-0000-4000-8000-000000156b01';
  r := pg_temp.as_val('anon', format($q$select public.public_booklet_choose(%L, gen_random_uuid(), 10, null, '123456') ->> 'status'$q$, tok));
  perform pg_temp.t('pkg code: the cap resets after 24 hours', r is distinct from 'rate_limited', r);
end $$;

-- ---- 11) client contact change during a live approval link ---------------------------------------
do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; o uuid; begin
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (q, '+919800000156', 'x', now() + interval '10 minutes', 'a0000000-0000-4000-8000-000000000001') returning id into o;
  r := pg_temp.as_try('a_staff@a.test', format($q$update public.quotes set client = client || '{"email":"new156@x.test"}'::jsonb where id = %L$q$, q));
  perform pg_temp.t('contact change: the edit itself works', r = 'ok:1', r);
  perform pg_temp.t('contact change: open approval codes are cancelled', (select expires_at <= now() from public.quote_otps where id = o), null);
  perform pg_temp.t('contact change: written to the audit log',
    exists (select 1 from public.audit_log where action = 'client_contact_change' and quote_id = q), null);
  perform pg_temp.t('contact change: the quote records when', (select client_contact_changed_at from public.quotes where id = q) is not null, null);
end $$;

-- ---- 12) Smart Import obeys linked-staff + demo guards -----------------------------------------
do $$ declare r text; c1 uuid; c2 uuid; begin
  insert into public.crew_members(name, phone, org_id, profile_id)
    values ('A156 Linked', '+919811110156', 'a0000000-0000-4000-8000-000000000001', (select id from auth.users where email = 'a_admin@a.test'))
    returning id into c1;
  insert into public.crew_members(name, phone, org_id, is_demo)
    values ('Demo ' || chr(183) || ' A156 helper', '+919822220156', 'a0000000-0000-4000-8000-000000000001', true)
    returning id into c2;
  r := pg_temp.as_val('a_staff@a.test', format($q$select public.smart_import_batch('staff', jsonb_build_array(jsonb_build_object(
         'i', 0, 'action', 'update', 'id', %L, 'fields', jsonb_build_object('phone', '+919833330156'))))::text$q$, c1));
  perform pg_temp.t('smart import: a linked staff record is not rewritten', r like '%"status": "error"%'
    and (select phone from public.crew_members where id = c1) = '+919811110156', r);
  r := pg_temp.as_val('a_staff@a.test', format($q$select public.smart_import_batch('staff', jsonb_build_array(jsonb_build_object(
         'i', 0, 'action', 'update', 'id', %L, 'fields', jsonb_build_object('name', 'A156 real helper'))))::text$q$, c2));
  perform pg_temp.t('smart import: a renamed demo row becomes real data', r like '%"status": "updated"%'
    and (select is_demo from public.crew_members where id = c2) = false, r);
  r := pg_temp.as_val('a_staff@a.test', $q$select public.smart_import_batch('staff', jsonb_build_array(jsonb_build_object(
         'i', 0, 'action', 'create', 'fields', jsonb_build_object('name', 'A156 dup', 'phone', '+919811110156'))))::text$q$);
  perform pg_temp.t('smart import: a linked member''s number cannot be copied', r like '%"status": "error"%', r);
end $$;

-- ---- 13) approval bound to the total the page showed --------------------------------------------
do $$ declare r text; q uuid := 'a0000000-0000-4000-8000-00000000da01'; tok text := 'a0000000-0000-4000-8000-0000000000aa'; o uuid; begin
  update public.quotes set approval_status = 'sent', client = client || '{"phone":"+919800000156"}'::jsonb where id = q;
  r := pg_temp.as_try('anon', format('select public.public_get_quote(%L)', tok));
  perform pg_temp.t('approval: the page load is remembered', r = 'ok:1' and exists (select 1 from public.a156_quote_served where quote_id = q), r);
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (q, '+919800000156', extensions.crypt('111111', extensions.gen_salt('bf', 4)), now() + interval '10 minutes', 'a0000000-0000-4000-8000-000000000001')
    returning id into o;
  update public.quotes set pricing = jsonb_set(pricing, '{discount}', '5000'::jsonb) where id = q;
  perform pg_temp.t('approval: a price change cancels open codes', (select expires_at <= now() from public.quote_otps where id = o), null);
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (q, '+919800000156', extensions.crypt('111111', extensions.gen_salt('bf', 4)), now() + interval '10 minutes', 'a0000000-0000-4000-8000-000000000001')
    returning id into o;
  r := pg_temp.as_val('anon', format($q$select public.verify_and_consent(%L, '+919800000156', '111111', true, 'v1', 'I agree', 'Alice', 'ua') ->> 'error'$q$, tok));
  perform pg_temp.t('approval: refused when the total changed after the page was opened', r = 'price_changed', r);
  perform pg_temp.t('approval: the code was not used up', (select attempts = 0 and verified_at is null from public.quote_otps where id = o), null);
  r := pg_temp.as_try('anon', format('select public.public_get_quote(%L)', tok));
  r := pg_temp.as_val('anon', format($q$select coalesce(public.verify_and_consent(%L, '+919800000156', '000000', true, 'v1', 'I agree', 'Alice', 'ua') ->> 'error', 'none')$q$, tok));
  perform pg_temp.t('approval: after a reload the normal code check runs again', r is distinct from 'price_changed', r);
end $$;

-- ---- 14) fewer permanent rows from anonymous calls ------------------------------------------------
do $$ declare r text; v_tok uuid := gen_random_uuid(); begin
  r := pg_temp.as_try('anon', format($q$select public.public_link_opened('quote', %L)$q$, v_tok));
  perform pg_temp.t('link opened: a random token writes no rate-limit row', r = 'ok:1'
    and not exists (select 1 from public.auth_rate_hits where bucket = 'link_open' and key = v_tok::text), r);
  perform pg_temp.t('wa approval: failed-code audit row is throttled',
    -- r23-0260 wraps it once (the a156 body is kept as *__pre0260)
    position('a156 end' in pg_get_functiondef(coalesce(to_regprocedure('public.wa_verify_and_consent__pre0260(uuid,text,text,boolean,text,text,text,text)'),
                                                       'public.wa_verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure))) > 0, null);
end $$;

-- ---- 15) crew-link limiter always counts --------------------------------------------------------
do $$ begin
  perform pg_temp.t('crew link: worker_assignment_updates is VOLATILE',
    (select provolatile from pg_proc where oid = 'public.worker_assignment_updates(uuid)'::regprocedure) = 'v', null);
end $$;

-- ---- 16) storage_quota_ok figures only for the studio ---------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('anon', $q$select public.storage_quota_ok('invite-media', 'b0000000-0000-4000-8000-000000000001/x/y.jpg', '{"size":"999999999999"}'::jsonb)$q$);
  perform pg_temp.t('storage: anon gets a generic refusal (no figures)', r like 'err:53400%' and r not like '%MB%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.storage_quota_ok('invite-media', 'b0000000-0000-4000-8000-000000000001/x/y.jpg', '{"size":"999999999999"}'::jsonb)$q$);
  perform pg_temp.t('storage: another studio gets a generic refusal', r like 'err:53400%' and r not like '%MB%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.storage_quota_ok('invite-media', 'b0000000-0000-4000-8000-000000000001/x/y.jpg', '{"size":"999999999999"}'::jsonb)$q$);
  perform pg_temp.t('storage: the studio itself still sees its figures', r like 'err:53400%MB of%', r);
end $$;

-- ---- 18) export per area -------------------------------------------------------------------------
do $$ declare r text; begin
  update public.role_access set can_view = false, can_edit = false
   where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'sales' and area = 'quotes';
  r := pg_temp.as_val('a_staff@a.test', $q$select (public.export_tenant_organization_package() ? 'quotes')::text$q$);
  -- r54 (0295): the export is for the studio owner / admins only, so a users-view member is now refused outright
  perform pg_temp.t('export: users-view without quotes access gets no quotes', r = 'false' or r like 'err:42501:Only the studio owner or an admin%', r);
  r := pg_temp.as_val('a_admin@a.test', $q$select (public.export_tenant_organization_package() ? 'quotes')::text$q$);
  perform pg_temp.t('export: an admin still gets quotes', r = 'true', r);
  update public.role_access set can_view = true, can_edit = true
   where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'sales' and area = 'quotes';
end $$;

-- ---- 19) base OTP compare + idempotent re-apply --------------------------------------------------
do $$ begin
  perform pg_temp.t('base OTP compare: a missing code is wrong',
    position('p_code is null or' in pg_get_functiondef('public.verify_and_consent__base(uuid,text,text,boolean,text,text,text,text)'::regprocedure)) > 0, null);
  perform pg_temp.t('patch helper: second run is a no-op',
    public._a156_patch('public.chat_can_see(uuid)'::regprocedure,
      $o$and c.org_id = public.current_org_id()$o$,
      $n$and c.org_id = public.current_org_id() and coalesce(public.user_role(), '') <> 'client' /* a156 */$n$) = 'already', null);
end $$;

-- read-only last: the transaction can switch to read-only but never back
set transaction read only;
do $$ declare st text := 'none'; begin
  begin perform public._a154_hit('a156-ro', 5); exception when others then st := sqlstate; end;
  perform pg_temp.t('crew link: a read-only call is refused, not let through', st = '25006', st);
end $$;

select name, result from _a156 order by name;
select case when count(*) filter (where result not like 'PASS%') = 0 then 'AUDIT-P2-0156: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'AUDIT-P2-0156: ' || count(*) filter (where result not like 'PASS%') || ' FAILED' end from _a156;
rollback;
