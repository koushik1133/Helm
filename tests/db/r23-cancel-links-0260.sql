-- r23-cancel-links-0260.sql - 0260: cancelling an event expires EVERY client / crew / vendor link (behavioral).
-- Local disposable PG only (two-tenant fixture). Everything runs in ONE transaction that is rolled back.
-- Proves: a cancelled event's approval / portal / booklet / proposal / invitation site (+ photos) / crew / delivery
-- links and the edge-function steps all refuse with the one "This event has been cancelled" message (no event
-- details); the same links of a live event in another studio answer exactly as before; cancel_event unpublishes the
-- invitation site (content kept, stamp set) and a cancelled event's site cannot be re-published; an event that was
-- cancelled BEFORE 0260 (site still 'published') is refused too (read-time check); re-run safe.
-- psql -v before=1 : print what each link answers WITHOUT re-applying 0260 (used on a pre-0260 DB for the report).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _r260(name text, result text); grant all on _r260 to anon, authenticated, service_role;
create temp table _p260(link text, ev text, answer text); grant all on _p260 to anon, authenticated, service_role;

create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default '') returns void language sql as $$
  insert into _r260 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
-- run one value query as anon / service_role / a user e-mail; classify the answer
create or replace function pg_temp.probe(p_who text, p_sql text) returns text language plpgsql as $$
declare v text; j jsonb;
begin
  perform set_config('request.headers', '', false);
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who like 'anon:%' then
    perform set_config('request.headers', jsonb_build_object('x-helm-site-slug', substr(p_who, 6))::text, false);
    perform auth.login_anon();
  elsif p_who = 'service' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', false); set local role service_role;
  else perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  if v is null then return 'NULL'; end if;
  if v in ('true', 'false') then return upper(v); end if;
  if v ~ '^[0-9]+$' then return 'ROWS:' || v; end if;
  begin j := v::jsonb; exception when others then return 'OPEN ' || left(v, 70); end;
  if jsonb_typeof(j) = 'object' and (j ->> 'ok') = 'false' then return 'OKFALSE:' || coalesce(j ->> 'reason', ''); end if;
  return 'OPEN ' || left(v, 70);
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'ERR:' || sqlerrm;
end $$;
grant execute on function pg_temp.probe(text, text) to anon, authenticated, service_role;
-- the one cancelled answer each kind gives
create or replace function pg_temp.refused(p text) returns boolean language sql as $$
  select p = 'ERR:This event has been cancelled. This link is no longer active.' or p = 'OKFALSE:cancelled' or p = 'FALSE' or p = 'ROWS:0' $$;
create or replace function pg_temp.cancel_answer(p text) returns boolean language sql as $$
  select position('has been cancelled' in p) > 0 or p = 'OKFALSE:cancelled' $$;

-- ---- seed (superuser): studio A event (will be cancelled) + studio B event (live control), every link kind ----
create or replace function pg_temp.seed(x text, q uuid, o uuid, adm text) returns void language plpgsql as $$
declare c uuid; photo text := 'https://example.supabase.co/storage/v1/object/public/invite-media/' || o || '/' || q || '/r23.jpg';
begin
  execute 'reset role';
  update public.quotes set status = 'quote', archived_at = null, deleted_at = null, approval_token_revoked_at = null,
         approval_token_expires_at = now() + interval '7 days', event_date = current_date + 30 where id = q;
  insert into public.client_booklets(id, org_id, quote_id, token, expires_at)
    values ((x || '0000000-0000-4000-8000-000026000b01')::uuid, o, q, (x || '0000000-0000-4000-8000-000026000b0c')::uuid, now() + interval '30 days')
    on conflict (id) do update set revoked_at = null, expires_at = now() + interval '30 days';
  insert into public.event_proposal(quote_id, org_id, share_token, published)
    values (q, o, (x || '0000000-0000-4000-8000-0000260000e1')::uuid, true)
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true;
  insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at)
    values ((x || '0000000-0000-4000-8000-0000260000d1')::uuid, q, '+919000026001', 'Crew R23', o, now() + interval '7 days')
    on conflict (token) do nothing;
  -- rows whose triggers need the studio in context (claims only, still superuser)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = adm), 'role', 'authenticated')::text, false);
  insert into public.event_sites(org_id, quote_id, slug, status, data)
    values (o, q, 'r23-site-' || x, 'draft', jsonb_build_object('photos', jsonb_build_array(photo), 'title', 'Kapoor Family Sangeet'))
    on conflict (quote_id) do nothing;
  update public.event_sites set status = 'published', published_at = now() where quote_id = q;
  insert into public.delivery_commitments(org_id, quote_id, what, party_kind, party_name, contact_email, due_at)
    values (o, q, 'Flowers', 'vendor', 'Vendor R23', 'v@r23.test', now() + interval '2 days') returning id into c;
  insert into public.delivery_links(token_hash, commitment_id, org_id, issued_via, expires_at)
    values (encode(pg_catalog.sha256(convert_to(repeat(x || '1', 32), 'UTF8')), 'hex'), c, o, 'copy', now() + interval '3 days');
  -- 0256 vendor request + its one link (accept / decline / invoice)
  insert into public.vendor_requests(org_id, quote_id, vendor_name, what, when_at, agreed_amount, respond_by)
    values (o, q, 'Vendor R23', 'Flowers', now() + interval '20 days', 5000, now() + interval '3 days') returning id into c;
  insert into public.vendor_request_links(token_hash, request_id, org_id, issued_via, expires_at)
    values (encode(pg_catalog.sha256(convert_to(repeat(x || '2', 32), 'UTF8')), 'hex'), c, o, 'copy', now() + interval '3 days');
  perform set_config('request.jwt.claims', '', false);
end $$;
select pg_temp.seed('a', 'a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'a_admin@a.test');
select pg_temp.seed('b', 'b0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-000000000001', 'b_admin@b.test');

\if :{?before}
\else
\ir ../../supabase/migrations/0260_cancel_expires_links.sql
\ir ../../supabase/migrations/0260_cancel_expires_links.sql
\endif

-- ---- cancel studio A's event the normal way (admin, reason) ------------------------------------------------------
do $$ declare r text; begin
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test'));
  begin r := public.cancel_event('a0000000-0000-4000-8000-00000000da01', 'Client called the sangeet off')::text;
  exception when others then r := 'ERR:' || sqlerrm; end;
  perform auth.logout(); execute 'reset role';
  insert into _p260 values ('(cancel_event answer)', 'A', r);
end $$;

-- ---- every link of both events -------------------------------------------------------------------------------------
create or replace function pg_temp.links() returns table(link text, who text, sql text) language sql as $$
  values
  ('invitation site',              'anon',       $q$select count(*)::text from public.public_event_site('r23-site-{x}')$q$),
  ('invitation photo (site page)', 'anon:r23-site-{x}', $q$select public.invite_media_guest_read_ok('{o}/{q}/r23.jpg')::text$q$),
  ('invitation photo (published)', 'anon',       $q$select public.invite_media_on_published_site('{o}/{q}/r23.jpg')::text$q$),
  ('approve page',                 'anon',       $q$select public.public_get_quote('{t}')::text$q$),
  ('approve: send code',           'anon',       $q$select public.request_otp('{t}', '+919800026001')::text$q$),
  ('approve: verify + consent',    'anon',       $q$select public.verify_and_consent('{t}', '+919800026001', '123456', true, 'v1', 'I agree', 'Alice', null)::text$q$),
  ('approve: WhatsApp code',       'anon',       $q$select public.wa_request_otp('{t}', 'whatsapp', null)::text$q$),
  ('approve: WhatsApp verify',     'anon',       $q$select public.wa_verify_and_consent('{t}', 'whatsapp', '123456', true, 'v1', 'I agree', 'Alice', null)::text$q$),
  ('approve: trial test approve',  'anon',       $q$select public.trial_test_approve('{t}', '+919800026001', 'Alice', 'v1', 'I agree', null)::text$q$),
  ('pay (create_payment)',         'anon',       $q$select public.create_payment('{t}')::text$q$),
  ('paid status',                  'anon',       $q$select public.public_quote_paid_status('{t}')::text$q$),
  ('client portal',                'anon',       $q$select public.public_get_portal('{t}')::text$q$),
  ('client portal extras',         'anon',       $q$select public.public_portal_extras('{t}')::text$q$),
  ('edge send-otp authorize',      'service',    $q$select public.otp_send_authorize('{t}', '+919800026001')::text$q$),
  ('edge WhatsApp OTP begin',      'service',    $q$select public.wa_otp_begin('{t}', 'whatsapp', null)::text$q$),
  ('edge trial e-mail OTP begin',  'service',    $q$select public.trial_email_otp_begin('{t}', null)::text$q$),
  ('edge Razorpay link begin',     'service',    $q$select public.payment_link_begin('{t}', 60)::text$q$),
  ('booklet',                      'anon',       $q$select public.public_get_booklet('{b}')::text$q$),
  ('booklet packages',             'anon',       $q$select public.public_booklet_packages('{b}')::text$q$),
  ('booklet pay terms',            'anon',       $q$select public.public_booklet_pay_terms('{b}')::text$q$),
  ('booklet OTP',                  'anon',       $q$select public.public_booklet_otp_request('{b}')::text$q$),
  ('booklet choose package',       'anon',       $q$select public.public_booklet_choose('{b}', gen_random_uuid(), 100, null, null)::text$q$),
  ('booklet picture',              'anon',       $q$select public.public_get_booklet_image('{b}', '2d', 'plain')::text$q$),
  ('edge booklet snapshot',        'service',    $q$select public.booklet_snapshot_path('{b}', '2d')::text$q$),
  ('proposal link',                'anon',       $q$select public.public_get_proposal('{p}')::text$q$),
  ('crew tasks',                   'anon',       $q$select public.worker_get_tasks('{w}')::text$q$),
  ('crew updates',                 'anon',       $q$select public.worker_assignment_updates('{w}')::text$q$),
  ('crew equipment',               'anon',       $q$select public.worker_get_equipment('{w}')::text$q$),
  ('crew one-tap reply',           'anon',       $q$select public.worker_respond('{w}', gen_random_uuid(), 'accept')::text$q$),
  ('vendor delivery status',       'anon',       $q$select public.delivery_link_get('{d}')::text$q$),
  ('vendor delivery reply',        'anon',       $q$select public.delivery_link_update('{d}', 'confirmed', null, null)::text$q$),
  ('vendor request link',          'anon',       $q$select public.vendor_link_get('{v}')::text$q$),
  ('vendor request reply',         'anon',       $q$select public.vendor_link_respond('{v}', 'accept', null)::text$q$),
  ('vendor invoice upload',        'anon',       $q$select public.vendor_invoice_upload('{v}', 'application/pdf')::text$q$),
  ('vendor invoice submit',        'anon',       $q$select public.vendor_invoice_submit('{v}', '{}'::jsonb)::text$q$),
  ('staff: WhatsApp proposal send','{adm}',      $q$select public.wa_proposal_prepare('{q}', 'proposal', '+919800026001', true, 'ok', true)::text$q$)
$$;
do $$ declare l record; x text; q text; o text; adm text; s text; who text; begin
  foreach x in array array['a', 'b'] loop
    q := x || '0000000-0000-4000-8000-00000000da01'; o := x || '0000000-0000-4000-8000-000000000001';
    adm := case x when 'a' then 'a_admin@a.test' else 'b_admin@b.test' end;
    for l in select * from pg_temp.links() loop
      s := replace(replace(replace(replace(replace(replace(replace(replace(replace(l.sql, '{x}', x), '{o}', o), '{q}', q),
             '{t}', x || '0000000-0000-4000-8000-0000000000' || x || x),
             '{b}', x || '0000000-0000-4000-8000-000026000b0c'), '{p}', x || '0000000-0000-4000-8000-0000260000e1'),
             '{w}', x || '0000000-0000-4000-8000-0000260000d1'), '{d}', repeat(x || '1', 32)), '{v}', repeat(x || '2', 32));
      who := replace(replace(l.who, '{x}', x), '{adm}', adm);
      insert into _p260 values (l.link, upper(x), pg_temp.probe(who, s));
    end loop;
  end loop;
end $$;

\if :{?before}
select link, ev, left(answer, 90) as answer from _p260 order by link, ev;
rollback;
\quit
\endif

-- ---- assertions --------------------------------------------------------------------------------------------------
do $$ declare l record; a text; b text; n int := 0; bad text := ''; nb int := 0; badb text := ''; begin
  for l in select distinct link from _p260 where link not like '(%' loop
    select answer into a from _p260 where link = l.link and ev = 'A';
    select answer into b from _p260 where link = l.link and ev = 'B';
    if pg_temp.refused(a) then n := n + 1; else bad := bad || l.link || '=' || a || '; '; end if;
    if not pg_temp.cancel_answer(b) and not (b = 'FALSE' or b = 'ROWS:0') then nb := nb + 1; else badb := badb || l.link || '=' || b || '; '; end if;
  end loop;
  perform pg_temp.t('01 every link of the cancelled event refuses (36 kinds)', n = 36 and bad = '', n || ' ' || bad);
  perform pg_temp.t('02 the live event''s links answer as before (none says cancelled)', nb = 36 and badb = '', nb || ' ' || badb);
end $$;
do $$ begin
  perform pg_temp.t('03 refusal shows no event details (no title / client / studio in the message)',
    not exists (select 1 from _p260 where ev = 'A' and (answer ilike '%Kapoor%' or answer ilike '%Alice%' or answer ilike '%Wedding%' or answer ilike '%Studio A%')),
    (select string_agg(answer, ' | ') from _p260 where ev = 'A' and (answer ilike '%Kapoor%' or answer ilike '%Alice%')));
  perform pg_temp.t('04 the live event''s site, photo and booklet really open (control is meaningful)',
    (select answer from _p260 where link = 'invitation site' and ev = 'B') = 'ROWS:1'
    and (select answer from _p260 where link = 'invitation photo (site page)' and ev = 'B') = 'TRUE'
    and (select answer from _p260 where link = 'invitation photo (published)' and ev = 'B') = 'TRUE'
    and (select answer from _p260 where link = 'booklet' and ev = 'B') like 'OPEN%'
    and (select answer from _p260 where link = 'proposal link' and ev = 'B') like 'OPEN%'
    and (select answer from _p260 where link = 'crew tasks' and ev = 'B') like 'OPEN%'
    and (select answer from _p260 where link = 'vendor delivery status' and ev = 'B') like 'OPEN%'
    and (select answer from _p260 where link = 'vendor request link' and ev = 'B') like 'OPEN%',
    (select string_agg(link || '=' || answer, '; ') from _p260 where ev = 'B'));
  perform pg_temp.t('05 cancel_event says links expired + invitation unpublished',
    coalesce((select (answer::jsonb ->> 'links_expired') = 'true' and (answer::jsonb ->> 'invitation_unpublished') = 'true'
              and answer::jsonb ->> 'status' = 'cancelled' from _p260 where link = '(cancel_event answer)' and answer like '{%'), false), (select answer from _p260 where link = '(cancel_event answer)'));
  perform pg_temp.t('06 site unpublished on cancel, stamp set, content kept',
    exists (select 1 from public.event_sites s where s.quote_id = 'a0000000-0000-4000-8000-00000000da01' and s.status = 'unpublished'
             and s.cancel_unpublished_at is not null and s.data ->> 'title' = 'Kapoor Family Sangeet' and jsonb_array_length(s.data -> 'photos') = 1));
  perform pg_temp.t('07 the other studio''s site is still published, no stamp',
    exists (select 1 from public.event_sites s where s.quote_id = 'b0000000-0000-4000-8000-00000000da01' and s.status = 'published' and s.cancel_unpublished_at is null));
  perform pg_temp.t('08 0198 kept: status cancelled, approval link revoked, cancellation recorded',
    exists (select 1 from public.quotes q where q.id = 'a0000000-0000-4000-8000-00000000da01' and q.status = 'cancelled' and q.approval_token_revoked_at is not null)
    and exists (select 1 from public.event_cancellations c where c.quote_id = 'a0000000-0000-4000-8000-00000000da01'));
end $$;

-- ---- a cancelled event's site cannot be published again; other edits / other studios unaffected ------------------
do $$ declare r text := ''; begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  begin update public.event_sites set status = 'published' where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  exception when others then r := sqlerrm; end;
  perform pg_temp.t('09 re-publishing a cancelled event''s site is refused', r like '%cancelled - its invitation site cannot be published%', r);
  r := '';
  begin update public.event_sites set title = 'kept as a draft' where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  exception when others then r := sqlerrm; end;
  perform pg_temp.t('10 editing the unpublished site content still works', r = '', r);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
  r := '';
  begin update public.event_sites set status = 'unpublished' where quote_id = 'b0000000-0000-4000-8000-00000000da01';
        update public.event_sites set status = 'published' where quote_id = 'b0000000-0000-4000-8000-00000000da01';
  exception when others then r := sqlerrm; end;
  perform pg_temp.t('11 a live event''s site can be unpublished + published again', r = '', r);
  perform set_config('request.jwt.claims', '', false);
end $$;

-- ---- an event cancelled BEFORE 0260 (its site still says published): refused at read time ------------------------
do $$ declare r text; begin
  execute 'reset role';
  update public.quotes set status = 'cancelled' where id = 'b0000000-0000-4000-8000-00000000da01';   -- old-style, no unpublish
  r := pg_temp.probe('anon', $q$select count(*)::text from public.public_event_site('r23-site-b')$q$);
  perform pg_temp.t('12 already-cancelled event: site still marked published but refused', r like '%has been cancelled%'
    and (select status from public.event_sites where quote_id = 'b0000000-0000-4000-8000-00000000da01') = 'published', r);
  r := pg_temp.probe('anon', $q$select public.public_get_booklet('b0000000-0000-4000-8000-000026000b0c')::text$q$);
  perform pg_temp.t('13 already-cancelled event: booklet refused', r like '%has been cancelled%', r);
  r := pg_temp.probe('anon:r23-site-b', $q$select public.invite_media_guest_read_ok('b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/r23.jpg')::text$q$);
  perform pg_temp.t('14 already-cancelled event: invitation photos no longer readable', r = 'FALSE', r);
  update public.quotes set status = 'quote' where id = 'b0000000-0000-4000-8000-00000000da01';
  r := pg_temp.probe('anon', $q$select count(*)::text from public.public_event_site('r23-site-b')$q$);
  perform pg_temp.t('15 status back to live: the same site opens again (read-time, nothing was destroyed)', r = 'ROWS:1', r);
end $$;

-- ---- cross-tenant + permissions ----------------------------------------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.probe('b_admin@b.test', $q$select public.cancel_event('a0000000-0000-4000-8000-00000000da01', 'not my studio event')::text$q$);
  perform pg_temp.t('16 another studio cannot cancel (or unpublish) this event', r like 'ERR:not authorized%', r);
  r := pg_temp.probe('anon', $q$select public.cancel_event('b0000000-0000-4000-8000-00000000da01', 'visitor tries')::text$q$);
  perform pg_temp.t('17 visitors cannot cancel', r like 'ERR:permission denied%', r);
  r := pg_temp.probe('anon', $q$select public._a260_link_quote('approval', 'a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.t('18 the link lookup helper is closed to visitors', r like 'ERR:permission denied%', r);
  r := pg_temp.probe('anon', $q$select public.public_get_quote__pre0260('b0000000-0000-4000-8000-0000000000bb')::text$q$);
  perform pg_temp.t('19 the previous bodies are closed to visitors', r like 'ERR:permission denied%', r);
  perform pg_temp.t('20 wrappers keep the original grants (32 wrapped incl. 4 vendor links, 32 kept)',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\_\_pre0260') = 32);
  perform pg_temp.t('21 server-only steps stay server-only; staff ones signed-in only (grants copied, not widened)',
    not has_function_privilege('anon', 'public.payment_link_begin(uuid,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_otp_begin(uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_email_otp_begin(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.booklet_snapshot_path(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._work_token_live(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.wa_proposal_prepare(uuid,text,text,boolean,text,boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.wa_proposal_prepare(uuid,text,text,boolean,text,boolean)', 'execute')
    and has_function_privilege('service_role', 'public.payment_link_begin(uuid,integer)', 'execute')
    and has_function_privilege('anon', 'public.invite_media_guest_read_ok(text)', 'execute')
    and has_function_privilege('service_role', 'public.task_proof_upload_ok(text)', 'execute'));
end $$;

-- ---- RESTORE (un-cancel): back to the previous status, links stay OFF until "Re-share links" -----------------
do $$ declare r text; qa text := 'a0000000-0000-4000-8000-00000000da01'; begin
  r := pg_temp.probe('a_staff@a.test', format($q$select public.restore_event(%L, 'client changed their mind')::text$q$, qa));
  perform pg_temp.t('22 a sales member cannot restore (admin / manager / coordinator only)', r like 'ERR:Only an admin, a manager or a coordinator%', r);
  r := pg_temp.probe('b_admin@b.test', format($q$select public.restore_event(%L, 'not my studio event')::text$q$, qa));
  perform pg_temp.t('23 another studio cannot restore it', r like 'ERR:not authorized%', r);
  r := pg_temp.probe('a_admin@a.test', format($q$select public.restore_event(%L, 'x')::text$q$, qa));
  perform pg_temp.t('24 a reason is required', r like 'ERR:Give a reason%', r);
  r := pg_temp.probe('a_admin@a.test', format($q$select public.restore_event(%L, 'Client changed their mind - sangeet is on')::text$q$, qa));
  perform pg_temp.t('25 admin restores: previous status back, stage kept, links paused, logged + team bell',
    r like 'OPEN%' and (select status = 'quote' and client_links_paused_at is not null from public.quotes where id = qa::uuid)
    and exists (select 1 from public.event_restorations x where x.quote_id = qa::uuid and x.reason like 'Client changed%' and x.restored_status = 'quote')
    and exists (select 1 from public.audit_log l where l.quote_id = qa::uuid and l.action = 'event_restored')
    and exists (select 1 from public.notifications n where n.quote_id = qa::uuid and n.kind = 'event_restored' and n.channel = 'in_app'), r);
  r := pg_temp.probe('a_admin@a.test', format($q$select public.event_link_state(%L)::text$q$, qa));
  perform pg_temp.t('26 event_link_state tells the page: paused, may restore / re-share', r like 'OPEN%', r);
  perform pg_temp.t('26b event_link_state hidden from visitors', pg_temp.probe('anon', format($q$select public.event_link_state(%L)::text$q$, qa)) like 'ERR:permission denied%');
end $$;
do $$ declare r text; begin
  r := pg_temp.probe('anon', $q$select public.public_get_booklet('a0000000-0000-4000-8000-000026000b0c')::text$q$);
  perform pg_temp.t('27 after restore the booklet link is still off (the pages show their "expired" card)', r like 'ERR:This link has expired%', r);
  r := pg_temp.probe('anon', $q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.t('28 after restore the approve link is still off', r like 'ERR:This link has expired%', r);
  r := pg_temp.probe('anon', $q$select public.worker_get_tasks('a0000000-0000-4000-8000-0000260000d1')::text$q$);
  perform pg_temp.t('29 after restore the crew link is still off', r like 'ERR:This link has expired%', r);
  r := pg_temp.probe('anon', format('select public.delivery_link_get(%L)::text', repeat('a1', 32)));
  perform pg_temp.t('30 after restore the vendor link answers ok:false paused', r = 'OKFALSE:paused', r);
  r := pg_temp.probe('anon', format('select public.vendor_link_get(%L)::text', repeat('a2', 32)));
  perform pg_temp.t('30b after restore the vendor request link answers ok:false paused', r = 'OKFALSE:paused', r);
  r := pg_temp.probe('anon', $q$select count(*)::text from public.public_event_site('r23-site-a')$q$);
  perform pg_temp.t('31 the invitation site stays unpublished after restore', r = 'ROWS:0'
    and (select status from public.event_sites where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 'unpublished', r);
  r := pg_temp.probe('a_admin@a.test', $q$select public.wa_proposal_prepare('a0000000-0000-4000-8000-00000000da01', 'proposal', '+919800026001', true, 'ok', true)::text$q$);
  perform pg_temp.t('32 staff WhatsApp send says: Re-share links first', r like '%Re-share links%', r);
end $$;
do $$ declare r text := ''; begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  begin update public.event_sites set status = 'published', published_at = now() where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  exception when others then r := sqlerrm; end;
  perform set_config('request.jwt.claims', '', false);
  perform pg_temp.t('33 the studio may publish the restored event''s site again; it then opens',
    r = '' and pg_temp.probe('anon', $q$select count(*)::text from public.public_event_site('r23-site-a')$q$) = 'ROWS:1', r);
  perform pg_temp.t('34 ...while the other links stay off until Re-share',
    pg_temp.probe('anon', $q$select public.public_get_booklet('a0000000-0000-4000-8000-000026000b0c')::text$q$) like 'ERR:This link has expired%');
end $$;
do $$ declare r text; qa text := 'a0000000-0000-4000-8000-00000000da01'; begin
  r := pg_temp.probe('a_staff@a.test', format('select public.resume_client_links(%L)::text', qa));
  perform pg_temp.t('35 a sales member cannot re-share', r like 'ERR:Only an admin%', r);
  r := pg_temp.probe('a_admin@a.test', format('select public.resume_client_links(%L)::text', qa));
  perform pg_temp.t('36 Re-share links: every link works again, the approval link the cancel revoked is back, logged',
    r like 'OPEN%' and (select client_links_paused_at is null and approval_token_revoked_at is null from public.quotes where id = qa::uuid)
    and pg_temp.probe('anon', $q$select public.public_get_booklet('a0000000-0000-4000-8000-000026000b0c')::text$q$) like 'OPEN%'
    and pg_temp.probe('anon', $q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')::text$q$) like 'OPEN%'
    and pg_temp.probe('anon', $q$select public.worker_get_tasks('a0000000-0000-4000-8000-0000260000d1')::text$q$) like 'OPEN%'
    and pg_temp.probe('anon', format('select public.delivery_link_get(%L)::text', repeat('a1', 32))) like 'OPEN%'
    and exists (select 1 from public.audit_log l where l.quote_id = qa::uuid and l.action = 'client_links_resumed'), r);
  r := pg_temp.probe('a_admin@a.test', format($q$select public.restore_event(%L, 'already live event')::text$q$, qa));
  perform pg_temp.t('37 restoring a live event changes nothing', r like '%"unchanged": true%', r);
  r := pg_temp.probe('a_admin@a.test', format($q$select public.cancel_event(%L, 'cancelled for good now')::text$q$, qa));
  r := pg_temp.probe('a_admin@a.test', format('select public.resume_client_links(%L)::text', qa));
  perform pg_temp.t('38 a cancelled event cannot be re-shared (restore first)', r like 'ERR:This event is cancelled - restore it first%', r);
end $$;

select name, result from _r260 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-CANCEL-LINKS-0260: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-CANCEL-LINKS-0260: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _r260;
rollback;
