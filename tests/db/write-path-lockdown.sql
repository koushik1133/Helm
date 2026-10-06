-- write-path-lockdown.sql — 0025 (security audit Phase 6, mass assignment).
-- Each ATTACK is made by a signed-in member who HAS the area rights the table's RLS
-- asks for, writing straight to the table (PostgREST-style) instead of going through
-- the server function that owns that change. Each must leave the data untouched.
-- Each LEGIT case is something the app really does and must keep working.
-- Attacker: a_staff (role 'sales'; fixture gives quotes/finance/proposal/controls
-- edit; this suite adds users/vendors/staff/inventory edit — but NOT settlement).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _wl; create temp table _wl(name text, result text); grant all on _wl to anon, authenticated;
drop table if exists _wl_ids; create temp table _wl_ids(k text primary key, v uuid); grant all on _wl_ids to anon, authenticated;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from _wl_ids where k = p $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _wl values (p_name, case when p_ok then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        a_admin uuid; a_staff uuid; a_mgr uuid; g uuid; bc uuid; m uuid;
begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into a_mgr from auth.users where email='a_mgr@a.test';
  if a_mgr is null then a_mgr := auth.seed_user('a_mgr@a.test'); end if;
  insert into public.profiles(id,email,role,org_id,must_change_password,created_at)
    values (a_mgr,'a_mgr@a.test','manager',orgA,false,now()) on conflict (id) do update set role='manager', org_id=orgA;
  insert into public.role_access(role,area,can_view,can_edit,org_id,updated_at)
    select 'sales', a, true, true, orgA, now() from unnest(array['users','vendors','staff','inventory']) a
    on conflict (role,area,org_id) do update set can_view=true, can_edit=true;
  delete from public.role_access where role='sales' and area='settlement' and org_id=orgA;
  perform auth.login_as(a_admin); execute 'reset role';     -- superuser, but with org A in context (org-forcing triggers)

  update public.quotes set approval_status='sent', status='quote', approval_token='a0000000-0000-4000-8000-0000000000aa',
         approval_token_revoked_at=null, approval_token_expires_at=now()+interval '30 days', event_date=current_date+40
   where id = qA;
  delete from public.quote_payments where quote_id = qA;
  insert into public.quote_payments(quote_id, provider, amount, status, simulated, receipt_no, method, paid_at)
    values (qA, 'cash', 1000, 'paid', false, 'RCP-REAL-1', 'cash', now());
  delete from public.quote_consents where quote_id = qA;
  delete from public.invitations where org_id = orgA;
  insert into public.invitations(org_id, email, role, invited_by) values (orgA, 'crew.wl@a.test', 'crew', a_admin);
  insert into _wl_ids select 'inv', id from public.invitations where email = 'crew.wl@a.test';
  delete from public.event_proposal where quote_id = qA;
  insert into public.event_proposal(quote_id, share_token, published) values (qA, gen_random_uuid(), false);
  delete from public.work_tokens where quote_id = qA;
  insert into public.work_tokens(token, quote_id, phone, name, expires_at, revoked_at)
    values ('a0000000-0000-4000-8000-0000000000ee', qA, '+919800000002', 'Crew B', now() - interval '1 minute', now() - interval '1 day');
  delete from public.event_resources where quote_id = qA and label like 'wl-%';
  insert into public.event_resources(quote_id, label, settled) values (qA, 'wl-tent', false);
  delete from public.event_sites where quote_id = qA or slug like 'wl-%';
  insert into public.event_sites(quote_id, slug, status, title, data) values (qA, 'wl-a', 'draft', 'Wedding', '{}'::jsonb);
  delete from public.inventory_checkouts where issued_to = 'wl-attacker';
  delete from public.inventory_items where name = 'wl-chairs' and org_id = orgA;
  insert into public.inventory_items(name, org_id) values ('wl-chairs', orgA);

  -- chat: a private group of admin + manager (a_staff is NOT in it), and org A's broadcast
  perform auth.login_as(a_admin);
  g  := public.chat_create_group('Board', array[a_mgr]);
  bc := public.chat_ensure_broadcast();
  perform public.chat_send(g, 'text', 'board-only secret', null, null, null, null);
  perform pg_temp.su();
  perform auth.login_as(a_staff);
  select (public.chat_send(bc, 'text', 'staff broadcast msg', null, null, null, null)).id into m;
  perform pg_temp.su();
  insert into storage.objects(bucket_id, name, owner)
    values ('chat-media', orgA::text || '/' || g::text  || '/0b0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png', a_admin),
           ('chat-media', orgA::text || '/' || bc::text || '/1b0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png', a_admin);
  insert into _wl_ids values ('admin', a_admin), ('staff', a_staff), ('mgr', a_mgr), ('group', g), ('bc', bc), ('msg', m), ('q', qA), ('org', orgA);
end $$;

-- ---- money ledger --------------------------------------------------------------
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.quote_payments(quote_id, provider, amount, status, simulated, receipt_no, method, paid_at)
          values (pg_temp.id('q'), 'cash', 50000, 'paid', false, 'RCP-FAKE-01', 'cash', now()); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where receipt_no = 'RCP-FAKE-01';
  perform pg_temp.res('ledger: staff cannot record a fake paid receipt', n = 0, 'fake receipt stored');
end $$;
do $$ declare a numeric; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quote_payments set amount = 1 where receipt_no = 'RCP-REAL-1'; exception when others then null; end;
  perform pg_temp.su(); select amount into a from public.quote_payments where receipt_no = 'RCP-REAL-1';
  perform pg_temp.res('ledger: staff cannot change a real receipt''s amount', a = 1000, 'amount now '||a);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.quote_payments where receipt_no = 'RCP-REAL-1'; exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where receipt_no = 'RCP-REAL-1';
  perform pg_temp.res('ledger: staff cannot delete a real receipt', n = 1, 'receipt deleted');
end $$;

-- ---- client consent (legal record) -------------------------------------------
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.quote_consents(quote_id, client_name, phone, agreed, verified_via_otp, terms_version, consent_text)
          values (pg_temp.id('q'), 'Alice', '+919800000009', true, true, 'v3', 'I accept'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_consents where quote_id = pg_temp.id('q');
  perform pg_temp.res('consent: staff cannot forge an OTP-verified client consent', n = 0, 'forged consent stored');
end $$;

-- ---- quote approval / payment state --------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set approval_status = 'approved' where id = pg_temp.id('q'); exception when others then null; end;
  perform pg_temp.su(); select approval_status into s from public.quotes where id = pg_temp.id('q');
  perform pg_temp.res('quote: staff cannot mark the client''s approval themselves', s = 'sent', 'approval_status '||s);
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set approval_status = 'paid', status = 'confirmed', lifecycle_stage = 'planning' where id = pg_temp.id('q'); exception when others then null; end;
  perform pg_temp.su(); select approval_status||'/'||status into s from public.quotes where id = pg_temp.id('q');
  perform pg_temp.res('quote: staff cannot mark an event paid/confirmed directly', s = 'sent/quote', s);
end $$;
do $$ declare r timestamptz; begin
  perform pg_temp.su(); update public.quotes set approval_token_revoked_at = now() where id = pg_temp.id('q');
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set approval_token_revoked_at = null, approval_token_expires_at = '2099-01-01' where id = pg_temp.id('q'); exception when others then null; end;
  perform pg_temp.su(); select approval_token_revoked_at into r from public.quotes where id = pg_temp.id('q');
  update public.quotes set approval_token_revoked_at = null where id = pg_temp.id('q');
  perform pg_temp.res('quote: staff cannot revive a revoked client link', r is not null, 'link revived');
end $$;
do $$ declare d date; t numeric; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    update public.quotes set event_date = current_date + 50,
           pricing = '{"subtotal":100000,"discount":0,"gstPct":18,"total":1}'::jsonb where id = pg_temp.id('q');
  exception when others then perform pg_temp.res('quote: staff can still edit the date and pricing', false, sqlerrm); return; end;
  perform pg_temp.su(); select event_date, (pricing->>'total')::numeric into d, t from public.quotes where id = pg_temp.id('q');
  perform pg_temp.res('quote: staff can still edit the date and pricing', d = current_date + 50 and t = 118000, d||' / '||t);
end $$;

-- ---- invitations ------------------------------------------------------------------
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.invitations(org_id, email, role, token, expires_at)
          values (pg_temp.id('org'), 'alt@attacker.test', 'admin', repeat('ab', 24), '2099-01-01'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.invitations where email = 'alt@attacker.test';
  perform pg_temp.res('invite: non-admin cannot mint an admin invitation', n = 0, 'admin invite stored');
end $$;
do $$ declare r text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.invitations set role = 'admin', email = 'alt@attacker.test' where id = pg_temp.id('inv'); exception when others then null; end;
  perform pg_temp.su(); select role into r from public.invitations where id = pg_temp.id('inv');
  perform pg_temp.res('invite: non-admin cannot turn a pending invite into admin', r = 'crew', 'role '||coalesce(r,'(email changed)'));
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.invitations set status = 'revoked' where id = pg_temp.id('inv');
  exception when others then perform pg_temp.res('invite: users editors can still revoke an invitation', false, sqlerrm); return; end;
  perform pg_temp.su(); select status into s from public.invitations where id = pg_temp.id('inv');
  perform pg_temp.res('invite: users editors can still revoke an invitation', s = 'revoked', s);
end $$;

-- ---- team chat ----------------------------------------------------------------------
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.chat_members(conversation_id, user_id, org_id) values (pg_temp.id('group'), auth.uid(), pg_temp.id('org')); exception when others then null; end;
  begin select count(*) into n from public.chat_messages where body = 'board-only secret'; exception when others then n := -1; end;
  perform pg_temp.res('chat: member cannot add themselves to a private group', n = 0, 'read '||n||' private message(s)');
end $$;
do $$ declare n int; k text; begin
  perform pg_temp.su();
  k := least(pg_temp.id('admin')::text, pg_temp.id('mgr')::text) || ':' || greatest(pg_temp.id('admin')::text, pg_temp.id('mgr')::text);
  delete from public.chat_conversations where dm_key = k;
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.chat_conversations(org_id, kind, dm_key, created_by) values (pg_temp.id('org'), 'dm', k, pg_temp.id('mgr')); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.chat_conversations where dm_key = k;
  perform pg_temp.res('chat: member cannot plant a fake DM between two colleagues', n = 0, 'spoof DM stored');
end $$;
do $$ declare c uuid; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.chat_messages set conversation_id = pg_temp.id('group') where id = pg_temp.id('msg'); exception when others then null; end;
  perform pg_temp.su(); select conversation_id into c from public.chat_messages where id = pg_temp.id('msg');
  perform pg_temp.res('chat: member cannot move a message into another conversation', c = pg_temp.id('bc'), 'moved');
end $$;
do $$ declare b text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.chat_messages set body = 'edited by me', edited_at = now() where id = pg_temp.id('msg');
  exception when others then perform pg_temp.res('chat: member can still edit their own message', false, sqlerrm); return; end;
  perform pg_temp.su(); select body into b from public.chat_messages where id = pg_temp.id('msg');
  perform pg_temp.res('chat: member can still edit their own message', b = 'edited by me', b);
end $$;
do $$ declare c uuid; n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin c := public.chat_start_dm(pg_temp.id('mgr'));
  exception when others then perform pg_temp.res('chat: starting a real DM still works (exactly 2 members)', false, sqlerrm); return; end;
  perform pg_temp.su(); select count(*) into n from public.chat_members where conversation_id = c;
  perform pg_temp.res('chat: starting a real DM still works (exactly 2 members)', n = 2, n||' members');
end $$;
do $$ declare s int; a int; bs int; begin
  perform pg_temp.login('a_staff@a.test');
  select count(*) into s from storage.objects where bucket_id = 'chat-media' and name like '%/' || pg_temp.id('group')::text || '/%';
  select count(*) into bs from storage.objects where bucket_id = 'chat-media' and name like '%/' || pg_temp.id('bc')::text || '/%';
  perform pg_temp.login('a_admin@a.test');
  select count(*) into a from storage.objects where bucket_id = 'chat-media' and name like '%/' || pg_temp.id('group')::text || '/%';
  perform pg_temp.res('chat media: only members can open a private chat''s photos', s = 0 and a = 1 and bs = 1,
    'outsider sees '||s||', member sees '||a||', broadcast '||bs);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from storage.objects where bucket_id = 'chat-media' and name like '%/' || pg_temp.id('bc')::text || '/%'; exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from storage.objects where bucket_id = 'chat-media' and name like '%/' || pg_temp.id('bc')::text || '/%';
  perform pg_temp.res('chat media: a member cannot delete someone else''s photo', n = 1, 'deleted');
end $$;

-- ---- crew links, proposal, settlement, invitation site, stock ----------------------
do $$ declare r timestamptz; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.work_tokens set revoked_at = null, expires_at = '2099-01-01' where token = 'a0000000-0000-4000-8000-0000000000ee'; exception when others then null; end;
  perform pg_temp.su(); select revoked_at into r from public.work_tokens where token = 'a0000000-0000-4000-8000-0000000000ee';
  perform pg_temp.res('crew link: staff cannot revive a revoked crew link', r is not null, 'revived');
end $$;
do $$ declare p boolean; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_proposal set published = true, share_token = '11111111-2222-4333-8444-555555555555' where quote_id = pg_temp.id('q'); exception when others then null; end;
  perform pg_temp.su(); select published into p from public.event_proposal where quote_id = pg_temp.id('q');
  perform pg_temp.res('proposal: publishing only through the publish action', p = false, 'published directly');
end $$;
do $$ declare s boolean; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_resources set settled = true, settled_at = now() where label = 'wl-tent'; exception when others then null; end;
  perform pg_temp.su(); select settled into s from public.event_resources where label = 'wl-tent';
  perform pg_temp.res('settlement: vendors editor without settlement rights cannot settle', s = false, 'settled');
end $$;
do $$ declare s boolean; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.event_resources set settled = true, settled_at = now() where label = 'wl-tent';
  exception when others then perform pg_temp.res('settlement: settlement editors can still settle', false, sqlerrm); return; end;
  perform pg_temp.su(); select settled into s from public.event_resources where label = 'wl-tent';
  perform pg_temp.res('settlement: settlement editors can still settle', s = true, 'not settled');
end $$;
do $$ declare sl text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_sites set slug = 'helm-official-payments', status = 'published', published_at = '2020-01-01' where slug = 'wl-a'; exception when others then null; end;
  perform pg_temp.su(); select slug into sl from public.event_sites where quote_id = pg_temp.id('q');
  perform pg_temp.res('invitation site: link name/publish only through the publish action', sl = 'wl-a', 'slug now '||sl);
end $$;
do $$ declare t text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_sites set title = 'Our Wedding', data = '{"date":"2026-12-01"}'::jsonb where quote_id = pg_temp.id('q');
  exception when others then perform pg_temp.res('invitation site: editing the content still works', false, sqlerrm); return; end;
  perform pg_temp.su(); select title into t from public.event_sites where quote_id = pg_temp.id('q');
  perform pg_temp.res('invitation site: editing the content still works', t = 'Our Wedding', t);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, issued_by)
          values ((select id from public.inventory_items where name = 'wl-chairs'), pg_temp.id('q'), 500, 'wl-attacker', pg_temp.id('mgr')); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.inventory_checkouts where issued_to = 'wl-attacker';
  perform pg_temp.res('stock: issuing equipment only through check-out (stock + who-issued checks)', n = 0, 'direct checkout stored');
end $$;

-- ---- OTP helper is server-only ---------------------------------------------------------
do $$ begin
  perform pg_temp.res('otp: signed-in users and visitors cannot store their own OTP code',
    not has_function_privilege('authenticated', 'public.admin_store_otp(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.admin_store_otp(uuid,text,text)', 'EXECUTE'), 'still executable');
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  delete from public.quote_payments where quote_id = pg_temp.id('q');
  delete from public.quote_consents where quote_id = pg_temp.id('q');
  delete from public.event_resources where label like 'wl-%';
  delete from public.event_sites where slug in ('wl-a','helm-official-payments');
  delete from public.inventory_checkouts where issued_to = 'wl-attacker';
  delete from public.inventory_items where name = 'wl-chairs';
  delete from public.work_tokens where token = 'a0000000-0000-4000-8000-0000000000ee';
  delete from public.invitations where email in ('crew.wl@a.test','alt@attacker.test') or id = pg_temp.id('inv');
  delete from storage.objects where bucket_id = 'chat-media' and name like pg_temp.id('org')::text || '/%';
  delete from public.role_access where role = 'sales' and area in ('users','vendors','staff','inventory') and org_id = pg_temp.id('org');
  update public.quotes set event_date = null, approval_status = 'sent', status = 'quote', approval_token_revoked_at = null where id = pg_temp.id('q');
end $$;
select name, result from _wl order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 26 then 'WRITE-PATH-LOCKDOWN: ALL PASS'
            else 'WRITE-PATH-LOCKDOWN: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/26 ran' end from _wl;
