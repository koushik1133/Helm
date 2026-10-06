-- uploads-payments.sql — 0027 (security audit Phase 8: file uploads, card payments,
-- outbound messaging). ATTACK cases are made by a signed-in member through the API
-- roles (PostgREST-style) and must be refused; LEGIT cases are what the app really
-- does and must keep working.
-- Users: a_crew (role 'crew', no area rights) · a_staff (role 'sales': quotes/finance
-- edit from the fixture) · a_admin · b_staff (other studio).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _up; create temp table _up(name text, result text); grant all on _up to anon, authenticated, service_role;
drop table if exists _up_ids; create temp table _up_ids(k text primary key, v text); grant all on _up_ids to anon, authenticated, service_role;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); execute 'set role service_role'; end $$;
create or replace function pg_temp.id(p text) returns text language sql as $$ select v from _up_ids where k = p $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _up values (p_name, case when p_ok then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
-- try an insert into storage.objects as the CURRENT user; true when it was stored
create or replace function pg_temp.up(p_bucket text, p_name text) returns boolean language plpgsql as $$
begin
  insert into storage.objects(bucket_id, name, owner) values (p_bucket, p_name, auth.uid());
  return true;
exception when others then return false; end $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
        a_admin uuid; a_crew uuid; bc uuid; mp uuid; md uuid;
begin
  perform pg_temp.su();
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_crew from auth.users where email='a_crew@a.test';
  if a_crew is null then a_crew := auth.seed_user('a_crew@a.test'); end if;
  insert into public.profiles(id,email,role,org_id,must_change_password,created_at)
    values (a_crew,'a_crew@a.test','crew',orgA,false,now()) on conflict (id) do update set role='crew', org_id=orgA;
  delete from public.role_access where role='crew' and org_id=orgA;

  delete from storage.objects where name like orgA::text || '/%';
  if to_regclass('public.messaging_rate') is not null then execute 'delete from public.messaging_rate'; end if;
  if to_regclass('public.payment_reconciliation') is not null then
    execute format('delete from public.payment_reconciliation where org_id = %L', orgA); end if;
  update public.quotes set approval_status='approved', status='confirmed', approval_token='a0000000-0000-4000-8000-0000000000aa',
         approval_token_revoked_at=null, approval_token_expires_at=now()+interval '30 days',
         client='{"name":"Alice","phone":"+91 98000 00001"}'::jsonb,
         pricing='{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb
   where id = qA;
  delete from public.quote_payments where quote_id = qA;
  delete from public.payment_milestones where quote_id = qA;
  delete from public.event_sites where quote_id = qA;
  delete from public.event_files where quote_id = qA;
  delete from public.work_tokens where quote_id = qA;
  insert into public.work_tokens(token, quote_id, phone, name, expires_at)
    values ('a0000000-0000-4000-8000-0000000000ef', qA, '9800000002', 'Crew lead', now() + interval '10 days');

  perform auth.login_as(a_admin); execute 'reset role';     -- org A in context for org-forcing triggers
  insert into storage.objects(bucket_id, name, owner)
    values ('invite-media', orgA::text||'/'||qA::text||'/1a0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.jpg', a_admin);
  insert into public.payment_milestones(quote_id, label, amount, status, seq) values (qA, 'up-advance', 50000, 'due', 1) returning id into md;
  insert into public.payment_milestones(quote_id, label, amount, status, seq, paid_at) values (qA, 'up-paid', 20000, 'paid', 0, now()) returning id into mp;
  bc := public.chat_ensure_broadcast();
  execute 'reset role';
  insert into public.event_sites(quote_id, slug, status, data) values (qA, 'up-a', 'draft', '{}'::jsonb);
  perform pg_temp.su();
  insert into _up_ids values ('org', orgA::text), ('q', qA::text), ('admin', a_admin::text), ('crew', a_crew::text),
    ('ms_due', md::text), ('ms_paid', mp::text), ('bc', bc::text),
    ('photo', orgA::text||'/'||qA::text||'/1a0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.jpg');
end $$;

-- =============================== UPLOADS ======================================
do $$ declare ok boolean; begin
  perform pg_temp.login('a_crew@a.test');
  ok := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/2b0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png');
  perform pg_temp.res('invite-media: crew cannot add photos to an invitation', not ok, 'crew upload stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_crew@a.test');
  begin update storage.objects set name = pg_temp.id('org')||'/'||pg_temp.id('q')||'/3c0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.jpg'
         where name = pg_temp.id('photo'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from storage.objects where name = pg_temp.id('photo');
  perform pg_temp.res('invite-media: crew cannot replace a published photo', n = 1, 'photo moved/replaced');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_crew@a.test');
  begin delete from storage.objects where name = pg_temp.id('photo'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from storage.objects where name = pg_temp.id('photo');
  perform pg_temp.res('invite-media: crew cannot delete a published photo', n = 1, 'crew deleted it');
end $$;
do $$ declare ok boolean; begin
  perform pg_temp.login('a_staff@a.test');
  ok := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/4d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.webp');
  perform pg_temp.res('invite-media: Invite Studio editors can still upload', ok, 'editor upload refused');
end $$;
do $$ declare ok boolean; begin
  perform pg_temp.login('a_staff@a.test');
  ok := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/5e0e3f7e8d0c4f439f6a0d1f6c6a8a11.gif');
  perform pg_temp.res('invite-media: hex-key fallback (no randomUUID) still uploads', ok, 'refused');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from storage.objects where name like '%/4d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.webp'; exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from storage.objects where name like '%/4d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.webp';
  perform pg_temp.res('invite-media: editors can still remove a photo', n = 0, 'not removed');
end $$;
do $$ declare a boolean; b boolean; c boolean; d boolean; begin
  perform pg_temp.login('a_staff@a.test');
  a := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/evil.html.png');
  b := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/6f0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.svg');
  c := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/x/6f0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png');
  d := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/'||repeat('a', 5000)||'.png');
  perform pg_temp.res('invite-media: only server-shaped keys (random name + image ext)', not (a or b or c or d),
    'html.png='||a||' svg='||b||' nested='||c||' long='||d);
end $$;
do $$ declare a boolean; b boolean; begin
  perform pg_temp.login('a_staff@a.test');
  a := pg_temp.up('invite-media', pg_temp.id('org')||'/'||gen_random_uuid()::text||'/7a0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png');
  b := pg_temp.up('invite-media', pg_temp.id('org')||'/'||upper(pg_temp.id('q'))||'/7b0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png');
  perform pg_temp.res('invite-media: folder must be one of the studio''s own events (canonical id)', not (a or b),
    'random folder='||a||' upper-case folder='||b);
end $$;
do $$ declare ok boolean; begin
  perform pg_temp.su();
  insert into storage.objects(bucket_id, name, owner, created_at)
    select 'invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/'||gen_random_uuid()::text||'.png', null, now() - interval '1 day'
      from generate_series(1, 120);
  perform pg_temp.login('a_staff@a.test');
  ok := pg_temp.up('invite-media', pg_temp.id('org')||'/'||pg_temp.id('q')||'/8c0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png');
  perform pg_temp.res('invite-media: per-event photo cap (120 objects) enforced', not ok, 'upload past the cap stored');
  perform pg_temp.su(); delete from storage.objects where bucket_id='invite-media' and owner is null and created_at < now() - interval '1 hour';
end $$;
do $$ declare ok boolean; ok2 boolean; begin
  perform pg_temp.su();
  insert into storage.objects(bucket_id, name, owner)
    select 'event-docs', pg_temp.id('org')||'/'||gen_random_uuid()::text||'/'||gen_random_uuid()::text||'.pdf', (select id from auth.users where email='a_staff@a.test')
      from generate_series(1, 100);
  perform pg_temp.login('a_staff@a.test');
  ok := pg_temp.up('event-docs', pg_temp.id('org')||'/'||pg_temp.id('q')||'/9d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.pdf');
  perform pg_temp.su(); update storage.objects set created_at = now() - interval '1 hour' where bucket_id='event-docs' and name not like '%/'||pg_temp.id('q')||'/%';
  perform pg_temp.login('a_staff@a.test');
  ok2 := pg_temp.up('event-docs', pg_temp.id('org')||'/'||pg_temp.id('q')||'/9d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.pdf');
  perform pg_temp.res('uploads: per-user rate limit (100 per 10 minutes) enforced, then lifts', not ok and ok2,
    'during burst='||ok||' after window='||ok2);
  perform pg_temp.su(); delete from storage.objects where bucket_id='event-docs' and name not like '%/'||pg_temp.id('q')||'/%' and name like pg_temp.id('org')||'/%';
end $$;
do $$ declare a boolean; b boolean; c boolean; begin
  perform pg_temp.login('a_staff@a.test');
  a := pg_temp.up('event-docs', pg_temp.id('org')||'/'||pg_temp.id('q')||'/ae0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.html');
  b := pg_temp.up('event-docs', pg_temp.id('org')||'/'||pg_temp.id('q')||'/invoice.pdf');
  perform pg_temp.login('a_crew@a.test');
  c := pg_temp.up('event-docs', pg_temp.id('org')||'/'||pg_temp.id('q')||'/af0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.pdf');
  perform pg_temp.res('event-docs: no .html / client filenames; crew cannot upload', not (a or b or c), 'html='||a||' name='||b||' crew='||c);
end $$;
do $$ declare a boolean; b boolean; begin
  perform pg_temp.login('a_staff@a.test');
  a := pg_temp.up('chat-media', pg_temp.id('org')||'/'||pg_temp.id('bc')||'/b00e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.html');
  b := pg_temp.up('chat-media', pg_temp.id('org')||'/'||pg_temp.id('bc')||'/b10e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.m4a');
  perform pg_temp.res('chat-media: only image/voice extensions; voice note still uploads', (not a) and b, 'html='||a||' m4a='||b);
end $$;
do $$ declare r record; bad int := 0; begin
  for r in select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('invite-media','event-docs','chat-media') loop
    if r.public or coalesce(r.file_size_limit,0) <= 0 or coalesce(array_length(r.allowed_mime_types,1),0) = 0
       or exists (select 1 from unnest(r.allowed_mime_types) m where m ilike '%svg%' or m ilike '%html%' or m ilike '%javascript%' or m like '%*%') then
      bad := bad + 1;
    end if;
  end loop;
  perform pg_temp.res('buckets: all 3 private with size cap + strict MIME allowlist',
    bad = 0 and (select count(*) from storage.buckets where id in ('invite-media','event-docs','chat-media')) = 3, bad||' bad bucket(s)');
end $$;
do $$ declare ok61 boolean := false; ok60 boolean := false; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_sites set data = jsonb_build_object('photos', (select jsonb_agg('https://x/'||g) from generate_series(1,61) g))
         where quote_id = pg_temp.id('q')::uuid; ok61 := found; exception when others then ok61 := false; end;
  begin update public.event_sites set data = jsonb_build_object('photos', (select jsonb_agg('https://x/'||g) from generate_series(1,60) g))
         where quote_id = pg_temp.id('q')::uuid; ok60 := found; exception when others then ok60 := false; end;
  perform pg_temp.res('invitation site: at most 60 photos (60 still saves)', (not ok61) and ok60, '61 saved='||ok61||' 60 saved='||ok60);
end $$;
-- (table grants for event_files differ between the local shim and Supabase, so the CHECKs
--  are exercised as the table owner with org A in context — they bind every writer)
do $$ declare a boolean := false; b boolean := false; c boolean := false; d boolean := false; begin
  perform pg_temp.su(); perform auth.login_as(pg_temp.id('admin')::uuid); execute 'reset role';
  begin insert into public.event_files(quote_id, storage_path, filename, mime, size_bytes)
          values (pg_temp.id('q')::uuid, pg_temp.id('org')||'/'||pg_temp.id('q')||'/c0.pdf', repeat('x', 300), 'application/pdf', 1); a := true;
  exception when others then null; end;
  begin insert into public.event_files(quote_id, storage_path, filename, mime, size_bytes)
          values (pg_temp.id('q')::uuid, pg_temp.id('org')||'/'||pg_temp.id('q')||'/c1.pdf', E'inv\noice.pdf', 'application/pdf', 1); b := true;
  exception when others then null; end;
  begin insert into public.event_files(quote_id, storage_path, filename, mime, size_bytes)
          values (pg_temp.id('q')::uuid, 'b0000000-0000-4000-8000-000000000001/x/c2.pdf', 'ok.pdf', 'application/pdf', 1); c := true;
  exception when others then null; end;
  begin insert into public.event_files(quote_id, storage_path, filename, mime, size_bytes)
          values (pg_temp.id('q')::uuid, pg_temp.id('org')||'/'||pg_temp.id('q')||'/c3.pdf', 'Venue contract (signed).pdf', 'application/pdf', 1); d := true;
  exception when others then null; end;
  perform pg_temp.res('event files: display name length/control chars + path inside the event', not (a or b or c) and d,
    'long='||a||' ctrl='||b||' foreign path='||c||' normal='||d);
end $$;

-- =============================== PAYMENTS =====================================
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.payment_milestones set status = 'paid', paid_at = now() where id = pg_temp.id('ms_due')::uuid; exception when others then null; end;
  perform pg_temp.su(); select status into s from public.payment_milestones where id = pg_temp.id('ms_due')::uuid;
  perform pg_temp.res('milestone: finance editor cannot mark paid by a direct write', s = 'due', 'status '||s);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.payment_milestones(quote_id, label, amount, status, paid_at) values (pg_temp.id('q')::uuid, 'up-fake', 99999, 'paid', now());
  exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.payment_milestones where label = 'up-fake';
  perform pg_temp.res('milestone: cannot create one already paid', n = 0, 'fake paid milestone stored');
end $$;
do $$ declare a numeric; s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.payment_milestones set amount = 1 where id = pg_temp.id('ms_paid')::uuid; exception when others then null; end;
  begin update public.payment_milestones set status = 'due', paid_at = null where id = pg_temp.id('ms_paid')::uuid; exception when others then null; end;
  perform pg_temp.su(); select amount, status into a, s from public.payment_milestones where id = pg_temp.id('ms_paid')::uuid;
  perform pg_temp.res('milestone: a paid milestone cannot be edited or un-paid', a = 20000 and s = 'paid', a||'/'||s);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.payment_milestones where id = pg_temp.id('ms_paid')::uuid; exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.payment_milestones where id = pg_temp.id('ms_paid')::uuid;
  perform pg_temp.res('milestone: a paid milestone cannot be deleted', n = 1, 'deleted');
end $$;
do $$ declare id1 uuid; s text; n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    insert into public.payment_milestones(quote_id, label, amount, status) values (pg_temp.id('q')::uuid, 'up-sched', 1000, 'due') returning id into id1;
    update public.payment_milestones set amount = 1500, due_date = current_date + 5, status = 'invoiced' where id = id1;
    update public.payment_milestones set status = 'waived' where id = id1;
    select status into s from public.payment_milestones where id = id1;
    delete from public.payment_milestones where id = id1;
  exception when others then perform pg_temp.res('milestone: schedule edits (add/edit/waive/delete unpaid) still work', false, sqlerrm); return; end;
  perform pg_temp.su(); select count(*) into n from public.payment_milestones where label = 'up-sched';
  perform pg_temp.res('milestone: schedule edits (add/edit/waive/delete unpaid) still work', s = 'waived' and n = 0, s||' / '||n);
end $$;
do $$ declare ok boolean := false; begin
  perform pg_temp.login('a_crew@a.test');
  begin perform public.settle_milestone(pg_temp.id('ms_due')::uuid, 'cash', 'up-crew'); ok := true; exception when others then null; end;
  perform pg_temp.login('b_staff@b.test');
  begin perform public.settle_milestone(pg_temp.id('ms_due')::uuid, 'cash', 'up-b'); ok := true; exception when others then null; end;
  perform pg_temp.res('settle_milestone: crew and other studios are refused', not ok, 'settled');
end $$;
do $$ declare r1 jsonb; r2 jsonb; s text; n int; amt numeric; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    r1 := public.settle_milestone(pg_temp.id('ms_due')::uuid, 'cash', 'up-idem-1');
    r2 := public.settle_milestone(pg_temp.id('ms_due')::uuid, 'cash', 'up-idem-1');
  exception when others then perform pg_temp.res('settle_milestone: marks paid + one ledger receipt (replay-safe)', false, sqlerrm); return; end;
  perform pg_temp.su();
  select status into s from public.payment_milestones where id = pg_temp.id('ms_due')::uuid;
  select count(*), sum(amount) into n, amt from public.quote_payments where quote_id = pg_temp.id('q')::uuid and status = 'paid';
  perform pg_temp.res('settle_milestone: marks paid + one ledger receipt (replay-safe)',
    s = 'paid' and n = 1 and amt = 50000 and (r2->>'idempotent_replay')::boolean, s||' receipts='||n||' amt='||amt||' '||r2::text);
end $$;
do $$ declare m uuid; s text; begin
  perform pg_temp.su(); perform auth.login_as(pg_temp.id('admin')::uuid); execute 'reset role';
  insert into public.payment_milestones(quote_id, label, amount, status, seq) values (pg_temp.id('q')::uuid, 'up-settle', 10000, 'due', 2) returning id into m;
  perform pg_temp.login('a_admin@a.test');
  begin perform public.record_settlement_payment(pg_temp.id('q')::uuid, 10000, 'cash', null, m, 'settle', 'up-rsp-1');
  exception when others then perform pg_temp.res('record_settlement_payment still marks its milestone paid', false, sqlerrm); return; end;
  perform pg_temp.su(); select status into s from public.payment_milestones where id = m;
  perform pg_temp.res('record_settlement_payment still marks its milestone paid', s = 'paid', s);
end $$;

-- ---- server-only helpers ---------------------------------------------------------
do $$ begin
  perform pg_temp.res('payment-link / rate / OTP helpers are server-only (not anon/authenticated)',
    not has_function_privilege('anon', 'public.payment_link_begin(uuid,int)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,int)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.payment_link_attach(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.payment_link_fail(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.messaging_rate_hit(uuid,text,int,int)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.whatsapp_authorize(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.razorpay_settle(uuid,text,text,bigint,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.payment_link_begin(uuid,int)', 'EXECUTE'), 'still executable');
end $$;

-- ---- payment links (create-payment-link Edge Function, service role) -----------
do $$ declare t uuid := 'a0000000-0000-4000-8000-0000000000aa'; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; ok boolean; bad boolean; c int; begin
  perform pg_temp.su(); delete from public.quote_payments where quote_id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  r1 := public.payment_link_begin(t, 4320);
  r2 := public.payment_link_begin(t, 4320);                                   -- concurrent second click
  bad := public.payment_link_attach((r1->>'payment_id')::uuid, 'plink_Evil1', 'https://evil.example/pay');
  ok  := public.payment_link_attach((r1->>'payment_id')::uuid, 'plink_Abc123', 'https://rzp.io/i/abc123');
  r3 := public.payment_link_begin(t, 4320);                                   -- reload: same link back
  perform pg_temp.su(); update public.quotes set pricing = '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  r4 := public.payment_link_begin(t, 4320);                                   -- total changed: supersede
  perform pg_temp.su();
  select count(*) into c from public.quote_payments where quote_id = pg_temp.id('q')::uuid and status = 'created';
  perform pg_temp.res('payment link: one open link per quote (busy / reuse / supersede), Razorpay URLs only',
    r1->>'action' = 'create' and r2->>'action' = 'busy' and not bad and ok
    and r3->>'action' = 'reuse' and r3->>'link_url' = 'https://rzp.io/i/abc123'
    and r4->>'action' = 'create' and r4->'supersede' = '["plink_Abc123"]'::jsonb and c = 1
    and (r1->>'expire_by')::bigint > extract(epoch from now())::bigint,
    concat_ws(' | ', r1->>'action', r2->>'action', bad::text, ok::text, r3->>'action', r4::text, c::text));
end $$;
do $$ declare r jsonb; r2 jsonb; begin
  perform pg_temp.su(); update public.quotes set approval_status = 'paid' where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc(); r := public.payment_link_begin('a0000000-0000-4000-8000-0000000000aa', 4320);
  perform pg_temp.su(); update public.quotes set approval_status = 'approved', approval_token_revoked_at = now() where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc(); r2 := public.payment_link_begin('a0000000-0000-4000-8000-0000000000aa', 4320);
  perform pg_temp.su(); update public.quotes set approval_token_revoked_at = null where id = pg_temp.id('q')::uuid;
  perform pg_temp.res('payment link: never for a paid quote or a revoked link', r->>'action' = 'paid' and r2->>'action' = 'invalid',
    (r->>'action')||'/'||(r2->>'action'));
end $$;

-- ---- razorpay-webhook settlement (service role) ------------------------------------
do $$ declare t uuid := 'a0000000-0000-4000-8000-0000000000aa'; b jsonb; r1 jsonb; r2 jsonb; r3 jsonb; s text; n int; rc int; begin
  perform pg_temp.su(); delete from public.quote_payments where quote_id = pg_temp.id('q')::uuid;
  update public.quotes set approval_status = 'approved', pricing = '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  b := public.payment_link_begin(t, 4320);
  perform public.payment_link_attach((b->>'payment_id')::uuid, 'plink_Settle1', 'https://rzp.io/i/settle1');
  r1 := public.razorpay_settle(null, 'plink_Settle1', 'pay_S1', 11800000, 'payment_link.paid');   -- notes.quote_id absent: mapped by link
  r2 := public.razorpay_settle(pg_temp.id('q')::uuid, 'plink_Settle1', 'pay_S1', 11800000, 'payment.captured');  -- same payment again
  r3 := public.razorpay_settle(pg_temp.id('q')::uuid, null, 'pay_S2', 11800000, 'payment.captured');  -- a SECOND payment after paid
  perform pg_temp.su();
  select approval_status into s from public.quotes where id = pg_temp.id('q')::uuid;
  select count(*) into n from public.quote_payments where quote_id = pg_temp.id('q')::uuid and status = 'paid';
  select count(*) into rc from public.payment_reconciliation where provider_payment_ref = 'pay_S2' and reason = 'already_paid';
  perform pg_temp.res('webhook: settles once, replays are no-ops, a payment after paid is kept for refund',
    r1->>'result' = 'settled' and r2->>'result' = 'replay' and r3->>'result' = 'reconcile' and s = 'paid' and n = 1 and rc = 1,
    concat_ws(' | ', r1::text, r2::text, r3::text, s, n::text, rc::text));
end $$;
do $$ declare t uuid := 'a0000000-0000-4000-8000-0000000000aa'; b jsonb; b2 jsonb; r1 jsonb; r2 jsonb; s text; n int; begin
  perform pg_temp.su(); delete from public.quote_payments where quote_id = pg_temp.id('q')::uuid;
  update public.quotes set approval_status = 'approved' where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  b := public.payment_link_begin(t, 4320);
  perform public.payment_link_attach((b->>'payment_id')::uuid, 'plink_Old1', 'https://rzp.io/i/old1');
  r1 := public.razorpay_settle(pg_temp.id('q')::uuid, 'plink_Old1', 'pay_M1', 100, 'payment_link.paid');      -- short of the total
  perform pg_temp.su(); update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  b2 := public.payment_link_begin(t, 4320);                                                               -- supersedes plink_Old1
  r2 := public.razorpay_settle(pg_temp.id('q')::uuid, 'plink_Old1', 'pay_M2', 11800000, 'payment_link.paid'); -- old link paid anyway
  perform pg_temp.su();
  select approval_status into s from public.quotes where id = pg_temp.id('q')::uuid;
  select count(*) into n from public.quote_payments where quote_id = pg_temp.id('q')::uuid and status = 'paid';
  perform pg_temp.res('webhook: short / superseded-link payments never settle the quote, both recorded',
    r1->>'reason' = 'amount_mismatch' and r2->>'reason' = 'superseded_link' and s = 'approved' and n = 0
    and (select count(*) from public.payment_reconciliation where provider_payment_ref in ('pay_M1','pay_M2')) = 2,
    concat_ws(' | ', r1::text, r2::text, s, n::text));
  perform pg_temp.su(); delete from public.quote_payments where quote_id = pg_temp.id('q')::uuid;
  delete from public.payment_reconciliation where provider_payment_ref in ('pay_S2','pay_M1','pay_M2');
end $$;

-- ---- reconciliation table ------------------------------------------------------
do $$ declare ok boolean := false; n int; nb int; begin
  perform pg_temp.su();
  insert into public.payment_reconciliation(org_id, quote_id, provider_payment_ref, amount_paise, expected_paise, reason)
    values (pg_temp.id('org')::uuid, pg_temp.id('q')::uuid, 'pay_UPTEST1', 11800000, 11800000, 'already_paid');
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.payment_reconciliation(org_id, quote_id, reason) values (pg_temp.id('org')::uuid, pg_temp.id('q')::uuid, 'unmatched'); ok := true;
  exception when others then null; end;
  select count(*) into n from public.payment_reconciliation;
  perform pg_temp.login('b_staff@b.test'); select count(*) into nb from public.payment_reconciliation;
  perform pg_temp.res('reconciliation: finance reads own studio only; no direct writes', not ok and n = 1 and nb = 0,
    'insert='||ok||' A sees '||n||' B sees '||nb);
end $$;

-- =============================== MESSAGING ====================================
do $$ declare ok boolean := false; begin
  perform pg_temp.su();
  begin insert into public.notifications(quote_id, channel, recipient, kind, status)
          values (pg_temp.id('q')::uuid, 'whatsapp', '919800000001', 'template', 'sent'); ok := true;
  exception when others then perform pg_temp.res('notifications: whatsapp sends can be logged', false, sqlerrm); return; end;
  perform pg_temp.res('notifications: whatsapp sends can be logged', ok, '');
end $$;
do $$ declare a boolean := false; b boolean := false; c boolean := false; begin
  perform pg_temp.login('a_staff@a.test');
  begin perform public.whatsapp_authorize(pg_temp.id('q')::uuid, '+44 7700 900123'); a := true; exception when others then null; end;
  perform pg_temp.login('a_crew@a.test');
  begin perform public.whatsapp_authorize(pg_temp.id('q')::uuid, '+91 98000 00001'); b := true; exception when others then null; end;
  perform pg_temp.login('b_staff@b.test');
  begin perform public.whatsapp_authorize(pg_temp.id('q')::uuid, '+91 98000 00001'); c := true; exception when others then null; end;
  perform pg_temp.res('whatsapp: no open relay (stranger number / crew / other studio refused)', not (a or b or c),
    'stranger='||a||' crew='||b||' other studio='||c);
end $$;
do $$ declare r1 jsonb; r2 jsonb; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    r1 := public.whatsapp_authorize(pg_temp.id('q')::uuid, '098000 00001');   -- client phone, other formatting
    r2 := public.whatsapp_authorize(pg_temp.id('q')::uuid, '9800000002');     -- crew link holder
  exception when others then perform pg_temp.res('whatsapp: client + crew numbers of the event allowed', false, sqlerrm); return; end;
  perform pg_temp.res('whatsapp: client + crew numbers of the event allowed', r1->>'to' = '919800000001' and r2->>'to' = '919800000002', r1::text);
end $$;
do $$ declare ok boolean := false; st text; begin
  perform pg_temp.su();
  insert into public.messaging_rate(org_id, channel, window_secs, window_start, hits)
    values (pg_temp.id('org')::uuid, 'whatsapp', 3600, to_timestamp(floor(extract(epoch from now())/3600)*3600), 100)
    on conflict (org_id, channel, window_secs, window_start) do update set hits = 100;
  perform pg_temp.login('a_staff@a.test');
  begin perform public.whatsapp_authorize(pg_temp.id('q')::uuid, '+91 98000 00001'); ok := true;
  exception when others then st := sqlstate; end;
  perform pg_temp.res('whatsapp: per-studio hourly limit', not ok and st = 'HL429', 'sent='||ok||' state='||coalesce(st,''));
end $$;
do $$ declare t uuid := 'a0000000-0000-4000-8000-0000000000aa'; s1 text; s2 text; s3 text; r jsonb; begin
  perform pg_temp.svc();
  begin perform public.otp_send_authorize(t, '+91 99999 11111'); exception when others then s1 := sqlstate; end;
  begin r := public.otp_send_authorize(t, '9800000001'); exception when others then s2 := sqlstate; end;
  perform pg_temp.su(); update public.quotes set client = '{"name":"Alice"}'::jsonb where id = pg_temp.id('q')::uuid;
  perform pg_temp.svc();
  begin perform public.otp_send_authorize(t, '+1 415 555 0100'); exception when others then s3 := sqlstate; end;
  perform pg_temp.res('otp: only the client phone on file (else an Indian mobile)',
    s1 = 'HL403' and s2 is null and r->>'mobile' = '919800000001' and s3 = 'HL400',
    concat_ws('/', s1, s2, s3, r::text));
end $$;
do $$ declare st text; begin
  perform pg_temp.su();
  insert into public.messaging_rate(org_id, channel, window_secs, window_start, hits)
    values (pg_temp.id('org')::uuid, 'sms', 86400, to_timestamp(floor(extract(epoch from now())/86400)*86400), 200)
    on conflict (org_id, channel, window_secs, window_start) do update set hits = 200;
  perform pg_temp.svc();
  begin perform public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '9800000001'); exception when others then st := sqlstate; end;
  perform pg_temp.res('otp: per-studio daily SMS cap', st = 'HL429', coalesce(st, 'sent'));
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  delete from storage.objects where name like pg_temp.id('org') || '/%';
  delete from public.quote_payments where quote_id = pg_temp.id('q')::uuid;
  delete from public.payment_milestones where quote_id = pg_temp.id('q')::uuid;
  delete from public.event_sites where quote_id = pg_temp.id('q')::uuid;
  delete from public.event_files where quote_id = pg_temp.id('q')::uuid;
  delete from public.work_tokens where token = 'a0000000-0000-4000-8000-0000000000ef';
  delete from public.notifications where quote_id = pg_temp.id('q')::uuid and channel = 'whatsapp';
  if to_regclass('public.payment_reconciliation') is not null then
    execute format('delete from public.payment_reconciliation where org_id = %L', pg_temp.id('org')); end if;
  if to_regclass('public.messaging_rate') is not null then execute 'delete from public.messaging_rate'; end if;
  update public.quotes set approval_status = 'sent', status = 'quote', client = '{"name":"Alice"}'::jsonb,
         pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = pg_temp.id('q')::uuid;
end $$;
select name, result from _up order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 35 then 'UPLOADS-PAYMENTS: ALL PASS'
            else 'UPLOADS-PAYMENTS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/35 ran' end from _up;
