-- r125-trial-lockdown-0334.sql - R125 (owner): in a free trial no link leaves Helm.
-- Proves, with the gate ON (helm.r125_gate = on for this file, the older suites run with it off):
--   (1) outsider refusal per page, for an ACTIVE trial, an ENDED trial and links already created: every approve / portal /
--       booklet / invitation / proposal / crew / vendor / delivery / enquiry read gives the SAME answer as a random
--       token (no oracle), writes are refused (RSVP, package choice, approval including 000000, simulated payment, vendor
--       reply, crew reply), nothing is written, the rows stay (nothing deleted);
--   (2) a signed-in member of the studio and a member of ANOTHER studio get the same refusal on the public path;
--   (3) a trial studio cannot create a link (approval, booklet, proposal, invitation, new invitation link, delivery, vendor
--       request link, direct table writes); assigning a task and saving a vendor request still work, with no link row;
--   (4) the members-only path: my_trial_links, trial_preview_bundle (real public data, no token / row / audit left behind,
--       outsiders and other studios refused, paid refused), test approval (000000 only, no token left, TEST consent, quote
--       confirmed), simulated payment (TEST receipt, never in quote_payments), ended trial refused;
--   (5) PAID studios unchanged: every public function answers exactly what the kept __pre0334 body answers, links can be
--       created, previews refused;
--   (6) upgrade: the same address opens again, the crew links left out are made; rows kept, referral code unknown in trial;
--   (7) structure: kept bodies have no app privilege, helpers neither, grants unchanged for anon, re-run safe.
-- Re-applies 0334 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0334_r125_trial_preview_lockdown.sql
\ir ../../supabase/migrations/0334_r125_trial_preview_lockdown.sql
set client_min_messages = warning;
set helm.r125_gate = 'on';
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default '') returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.as_val(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  begin
    execute p_sql into v;
  exception when others then
    v := 'err:' || sqlstate || ':' || sqlerrm;
  end;
  perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  return coalesce(v, '<null>');
end $$;

-- one studio (B) with one link of every kind, built with the gate off so it stands for "links already created"
create or replace function pg_temp.seed() returns void language plpgsql as $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; o uuid := 'b0000000-0000-4000-8000-000000000001'; c uuid; r uuid; v uuid;
begin
  perform set_config('helm.r125_gate', 'off', true);
  update public.organizations set public_slug = 'r125-b-studio', trial_ends_at = null where id = o;
  update public.quotes set pricing = jsonb_build_object('total', 118000, 'subtotal', 118000), approval_status = 'sent', status = 'quote',
         consent_stale = false, approval_token = 'b0000000-0000-4000-8000-0000000000aa', approval_token_expires_at = null,
         client = coalesce(client, '{}'::jsonb) || '{"phone":"+919800000125","email":"client125@example.com","name":"Client R"}'::jsonb
   where id = q;
  delete from public.studio_subscriptions where org_id = o;
  update public.subscription_payments set voided_at = now(), void_reason = 'r125 test' where org_id = o and voided_at is null;   -- earlier suites may have left one (rolled back)
  insert into public.client_booklets(org_id, quote_id, token) values (o, q, 'b0000000-0000-4000-8000-0000000000bb');
  insert into public.event_proposal(quote_id, concept, published, share_token) values (q, 'Garden', true, 'b0000000-0000-4000-8000-0000000000cc');
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('b0000000-0000-4000-8000-0000000000dd', q, '+919800000126', 'Ravi', o);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
  insert into public.event_sites(org_id, quote_id, slug, status, data) values (o, q, 'r125-site', 'draft', '{"names":"P and A","rsvpForm":true}');
  update public.event_sites set status = 'published', published_at = now() where quote_id = q;
  perform set_config('request.jwt.claims', '', false);
  insert into public.delivery_commitments(org_id, quote_id, what, party_kind, party_name, contact_email, due_at)
    values (o, q, 'Chairs', 'vendor', 'V', 'v@example.com', now() + interval '3 days') returning id into c;
  insert into public.delivery_links(token_hash, commitment_id, org_id, issued_via, expires_at)
    values (encode(pg_catalog.sha256(convert_to(repeat('d1', 32), 'UTF8')), 'hex'), c, o, 'copy', now() + interval '3 days');
  insert into public.vendor_requests(org_id, quote_id, vendor_name, what, when_at, agreed_amount, respond_by)
    values (o, q, 'V', 'Tent', now() + interval '10 days', 1000, now() + interval '2 days') returning id into r;
  insert into public.vendor_request_links(token_hash, request_id, org_id, issued_via, expires_at)
    values (encode(pg_catalog.sha256(convert_to(repeat('e1', 32), 'UTF8')), 'hex'), r, o, 'copy', now() + interval '3 days');
  perform set_config('helm.r125_gate', 'on', true);
end $$;

create or replace function pg_temp.plan(p text) returns void language plpgsql as $$
declare o uuid := 'b0000000-0000-4000-8000-000000000001';
begin
  if p = 'trial' then
    insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (o, 'trial', current_date + 10)
      on conflict (org_id) do update set status = 'trial', trial_ends_at = current_date + 10, current_period_end = null;
    update public.organizations set trial_ends_at = now() + interval '10 days' where id = o;
  elsif p = 'ended' then
    insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (o, 'trial', current_date - 2)
      on conflict (org_id) do update set status = 'trial', trial_ends_at = current_date - 2, current_period_end = null;
    update public.organizations set trial_ends_at = now() - interval '2 days' where id = o;
  else
    insert into public.studio_subscriptions(org_id, status, trial_ends_at, current_period_start, current_period_end)
      values (o, 'active', null, current_date - 1, current_date + 30)
      on conflict (org_id) do update set status = 'active', trial_ends_at = null, current_period_start = current_date - 1, current_period_end = current_date + 30;
    update public.organizations set trial_ends_at = null where id = o;
  end if;
end $$;

-- every outsider probe: link, sql with the real reference, sql with a reference that never existed
create temp table _pr(link text, real_sql text, fake_sql text);
grant all on _pr to anon, authenticated, service_role;
insert into _pr values
 ('quote read', $q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_get_quote('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote ready', $q$select public.public_quote_ready('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_quote_ready('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote validity', $q$select public.public_quote_validity('quote','b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_quote_validity('quote','10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote mode', $q$select public.public_trial_approval_mode('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_trial_approval_mode('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote sim banner', $q$select public.public_trial_simulation('quote','b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_trial_simulation('quote','10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote sim pay', $q$select public.public_trial_payment_sim('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_trial_payment_sim('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('quote sim rows', $q$select public.public_trial_sim_payments('quote','b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_trial_sim_payments('quote','10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('portal read', $q$select public.public_get_portal('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_get_portal('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('portal extras', $q$select public.public_portal_extras('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_portal_extras('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('portal schedule', $q$select public.public_payment_schedule('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_payment_schedule('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('portal paid', $q$select public.public_quote_paid_status('b0000000-0000-4000-8000-0000000000aa')::text$q$, $q$select public.public_quote_paid_status('10000000-0000-4000-8000-0000000000aa')::text$q$),
 ('studio name quote', $q$select public.public_link_studio('quote','b0000000-0000-4000-8000-0000000000aa','r125-b-studio')$q$, $q$select public.public_link_studio('quote','10000000-0000-4000-8000-0000000000aa','r125-b-studio')$q$),
 ('booklet read', $q$select public.public_get_booklet('b0000000-0000-4000-8000-0000000000bb')::text$q$, $q$select public.public_get_booklet('10000000-0000-4000-8000-0000000000bb')::text$q$),
 ('booklet packages', $q$select public.public_booklet_packages('b0000000-0000-4000-8000-0000000000bb')::text$q$, $q$select public.public_booklet_packages('10000000-0000-4000-8000-0000000000bb')::text$q$),
 ('booklet terms', $q$select public.public_booklet_pay_terms('b0000000-0000-4000-8000-0000000000bb')::text$q$, $q$select public.public_booklet_pay_terms('10000000-0000-4000-8000-0000000000bb')::text$q$),
 ('booklet image', $q$select public.public_get_booklet_image('b0000000-0000-4000-8000-0000000000bb','layout2d','hero')::text$q$, $q$select public.public_get_booklet_image('10000000-0000-4000-8000-0000000000bb','layout2d','hero')::text$q$),
 ('booklet studio', $q$select public.public_booklet_studio('b0000000-0000-4000-8000-0000000000bb','r125-b-studio')$q$, $q$select public.public_booklet_studio('10000000-0000-4000-8000-0000000000bb','r125-b-studio')$q$),
 ('booklet sim banner', $q$select public.public_trial_simulation('booklet','b0000000-0000-4000-8000-0000000000bb')::text$q$, $q$select public.public_trial_simulation('booklet','10000000-0000-4000-8000-0000000000bb')::text$q$),
 ('booklet package choice', $q$select public.public_booklet_choose('b0000000-0000-4000-8000-0000000000bb','10000000-0000-4000-8000-000000000001',10,'x','000000')::text$q$, $q$select public.public_booklet_choose('10000000-0000-4000-8000-0000000000bb','10000000-0000-4000-8000-000000000001',10,'x','000000')::text$q$),
 ('proposal read', $q$select public.public_get_proposal('b0000000-0000-4000-8000-0000000000cc')::text$q$, $q$select public.public_get_proposal('10000000-0000-4000-8000-0000000000cc')::text$q$),
 ('proposal banner', $q$select public.public_trial_simulation_for_proposal('b0000000-0000-4000-8000-0000000000cc')::text$q$, $q$select public.public_trial_simulation_for_proposal('10000000-0000-4000-8000-0000000000cc')::text$q$),
 ('studio name proposal', $q$select public.public_link_studio('proposal','b0000000-0000-4000-8000-0000000000cc','r125-b-studio')$q$, $q$select public.public_link_studio('proposal','10000000-0000-4000-8000-0000000000cc','r125-b-studio')$q$),
 ('invitation read', $q$select count(*)::text from public.public_event_site('r125-site')$q$, $q$select count(*)::text from public.public_event_site('r125-site-none')$q$),
 ('invitation info', $q$select public.public_invite_info('r125-site')::text$q$, $q$select public.public_invite_info('r125-site-none')::text$q$),
 ('invitation rsvp', $q$select public.public_invite_rsvp('r125-site','{"name":"G","attending":"yes","guests":1}')::text$q$, $q$select public.public_invite_rsvp('r125-site-none','{"name":"G","attending":"yes","guests":1}')::text$q$),
 ('studio name invite', $q$select public.public_link_studio('invite','r125-site','r125-b-studio')$q$, $q$select public.public_link_studio('invite','r125-site-none','r125-b-studio')$q$),
 ('crew tasks', $q$select public.worker_get_tasks('b0000000-0000-4000-8000-0000000000dd')::text$q$, $q$select public.worker_get_tasks('10000000-0000-4000-8000-0000000000dd')::text$q$),
 ('crew home', $q$select public.crew_link_home('b0000000-0000-4000-8000-0000000000dd')::text$q$, $q$select public.crew_link_home('10000000-0000-4000-8000-0000000000dd')::text$q$),
 ('crew reply', $q$select public.worker_respond('b0000000-0000-4000-8000-0000000000dd','10000000-0000-4000-8000-000000000001','accept')::text$q$, $q$select public.worker_respond('10000000-0000-4000-8000-0000000000dd','10000000-0000-4000-8000-000000000001','accept')::text$q$),
 ('crew availability', $q$select public.crew_set_availability('b0000000-0000-4000-8000-0000000000dd',current_date+1,'unavailable')::text$q$, $q$select public.crew_set_availability('10000000-0000-4000-8000-0000000000dd',current_date+1,'unavailable')::text$q$),
 ('studio name crew', $q$select public.public_link_studio('work','b0000000-0000-4000-8000-0000000000dd','r125-b-studio')$q$, $q$select public.public_link_studio('work','10000000-0000-4000-8000-0000000000dd','r125-b-studio')$q$),
 ('vendor read', $q$select public.vendor_link_get(repeat('e1',32))::text$q$, $q$select public.vendor_link_get(repeat('e2',32))::text$q$),
 ('vendor reply', $q$select public.vendor_link_respond(repeat('e1',32),'accept',null)::text$q$, $q$select public.vendor_link_respond(repeat('e2',32),'accept',null)::text$q$),
 ('vendor invoice', $q$select public.vendor_invoice_upload(repeat('e1',32),'application/pdf')::text$q$, $q$select public.vendor_invoice_upload(repeat('e2',32),'application/pdf')::text$q$),
 ('delivery read', $q$select public.delivery_link_get(repeat('d1',32))::text$q$, $q$select public.delivery_link_get(repeat('d2',32))::text$q$),
 ('delivery reply', $q$select public.delivery_link_update(repeat('d1',32),'confirmed',null,null)::text$q$, $q$select public.delivery_link_update(repeat('d2',32),'confirmed',null,null)::text$q$),
 ('enquiry', $q$select public.public_enquiry_info('r125-b-studio')::text$q$, $q$select public.public_enquiry_info('r125-no-studio')::text$q$);

select pg_temp.seed();
-- the enquiry form is switched on, so only the trial gate can close it
do $$ begin
  insert into public.app_config(org_id, key, value) values ('b0000000-0000-4000-8000-000000000001', 'automations', '{"enquiry_enabled":true}')
    on conflict do nothing;
exception when others then null; end $$;

-- ---- (1)(2) outsider refusal: active + ended, three kinds of visitor ---------------------------------------------------
do $$
declare p record; st text; who text; a text; b text; bad text; n int := 0; v_sites int; v_rsvp int;
begin
  foreach st in array array['trial', 'ended'] loop
    perform pg_temp.plan(st);
    foreach who in array array['anon', 'a_admin@a.test', 'b_admin@b.test'] loop
      bad := '';
      for p in select * from _pr loop
        a := pg_temp.as_val(who, p.real_sql); b := pg_temp.as_val(who, p.fake_sql); n := n + 1;
        -- rate-limit wording aside, the answer for the real link is the answer for a link that never existed
        if a is distinct from b then bad := bad || ' | ' || p.link || ': ' || left(a, 120) || ' <> ' || left(b, 120); end if;
      end loop;
      perform pg_temp.t(format('01 %s, %s: every link answers like a link that never existed (%s pages)', st, who, (select count(*) from _pr)), bad = '', bad);
    end loop;
  end loop;
  perform pg_temp.t('02 the probes really ran', n = 6 * (select count(*) from _pr), n::text);
end $$;

do $$
declare o uuid := 'b0000000-0000-4000-8000-000000000001'; q uuid := 'b0000000-0000-4000-8000-00000000da01'; r text; a text;
begin
  perform pg_temp.plan('trial');
  r := pg_temp.as_val('anon', $q$select public.trial_test_approve_code('b0000000-0000-4000-8000-0000000000aa','000000','+919800000125','X','v','c','ua')::text$q$);
  a := pg_temp.as_val('anon', $q$select public.trial_test_approve_code('10000000-0000-4000-8000-0000000000aa','000000','+919800000125','X','v','c','ua')::text$q$);
  perform pg_temp.t('03 approval with 000000 refused, same words as an unknown link', r = a and r like 'err:%', r);
  r := pg_temp.as_val('anon', $q$select public.trial_test_approve('b0000000-0000-4000-8000-0000000000aa','+919800000125','X','v','c','ua')::text$q$);
  perform pg_temp.t('04 the older skip path refused too', r like 'err:%', r);
  r := pg_temp.as_val('anon', $q$select public.verify_and_consent('b0000000-0000-4000-8000-0000000000aa','+919800000125','000000',true,'v','c','X','ua')::text$q$);
  a := pg_temp.as_val('anon', $q$select public.verify_and_consent('10000000-0000-4000-8000-0000000000aa','+919800000125','000000',true,'v','c','X','ua')::text$q$);
  perform pg_temp.t('05 the real approval refused the same way', r = a, r || ' / ' || a);
  r := pg_temp.as_val('anon', $q$select public.trial_simulate_payment('b0000000-0000-4000-8000-0000000000aa','X','ua')::text$q$);
  perform pg_temp.t('06 outsider simulated payment refused', r like 'err:%', r);
  r := pg_temp.as_val('anon', $q$select public.request_otp('b0000000-0000-4000-8000-0000000000aa','+919800000125')::text$q$);
  a := pg_temp.as_val('anon', $q$select public.request_otp('10000000-0000-4000-8000-0000000000aa','+919800000125')::text$q$);
  perform pg_temp.t('07 no code can be requested', r = a, r || ' / ' || a);
  r := pg_temp.as_val('anon', $q$select public.create_payment('b0000000-0000-4000-8000-0000000000aa')::text$q$);
  a := pg_temp.as_val('anon', $q$select public.create_payment('10000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.t('08 no payment can be started', r = a, r || ' / ' || a);
  perform pg_temp.t('09 nothing was written and nothing was deleted', not exists (select 1 from public.event_site_rsvps x join public.event_sites s on s.id = x.site_id where s.quote_id = q)
    and (select approval_status from public.quotes where id = q) = 'sent'
    and not exists (select 1 from public.trial_sim_payments s where s.quote_id = q)
    and exists (select 1 from public.client_booklets b where b.quote_id = q and b.revoked_at is null)
    and exists (select 1 from public.event_sites s where s.quote_id = q and s.status = 'published')
    and exists (select 1 from public.work_tokens w where w.quote_id = q)
    and (select approval_token from public.quotes where id = q) is not null, '');
  perform pg_temp.t('10 invitation pictures: guest read refused for a trial studio', not public.invite_media_on_published_site(o::text || '/' || q::text || '/a.jpg'), '');
  update public.referral_codes set active = true where false;
end $$;

-- suspended trial + a past_due trial that never paid are closed too; a paid-then-suspended studio is not
do $$
declare o uuid := 'b0000000-0000-4000-8000-000000000001';
begin
  update public.studio_subscriptions set status = 'suspended', trial_ends_at = current_date - 2, current_period_end = null, prev_status = 'trial' where org_id = o;
  perform pg_temp.t('11 a suspended trial is closed', public._r125_closed(o), '');
  update public.studio_subscriptions set status = 'past_due', prev_status = null where org_id = o;
  perform pg_temp.t('12 a past-due trial that never paid is closed', public._r125_closed(o), '');
  update public.studio_subscriptions set status = 'past_due', current_period_end = current_date + 5, current_period_start = current_date - 25 where org_id = o;
  perform pg_temp.t('13 a past-due plan is not a trial', not public._r125_closed(o), '');
  update public.studio_subscriptions set status = 'suspended', prev_status = 'active' where org_id = o;
  perform pg_temp.t('14 a suspended plan is not a trial', not public._r125_closed(o), '');
  perform pg_temp.t('15 a studio with no subscription row is not a trial', not public._r125_closed('a0000000-0000-4000-8000-000000000001'), '');
  perform pg_temp.t('16 the sample master is not gated', not exists (select 1 from public.organizations x where x.is_sample_master and public._r125_closed(x.id)), '');
end $$;

-- ---- (3) no link can be created in a trial ----------------------------------------------------------------------------------
do $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; r text; n int; v_book int;
begin
  perform set_config('helm.r125_gate', 'off', true);
  update public.quotes set approval_token = null, approval_token_expires_at = null where id = q;
  perform set_config('helm.r125_gate', 'on', true);
  perform pg_temp.plan('trial');
  select count(*) into v_book from public.client_booklets where quote_id = q;
  r := pg_temp.as_val('b_admin@b.test', format('select public.generate_approval_token(%L)::text', q));
  perform pg_temp.t('20 approval token refused, plain words', r like 'err:42501:Links are not available in a free trial%', r);
  perform pg_temp.t('21 the quote still has no token', (select approval_token from public.quotes where id = q) is null, '');
  r := pg_temp.as_val('b_admin@b.test', format('select public.booklet_share(%L, 30, null, null, null)::text', q));
  perform pg_temp.t('22 booklet link refused', r like 'err:42501:Links are not available%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.booklet_share(%L, 30, null, null, null, null::jsonb)::text', q));
  perform pg_temp.t('23 booklet link refused (six arguments)', r like 'err:42501:Links are not available%', r);
  perform pg_temp.t('24 no booklet row, the old one is not revoked', (select count(*) from public.client_booklets where quote_id = q) = v_book
    and exists (select 1 from public.client_booklets where quote_id = q and revoked_at is null), '');
  update public.event_proposal set published = false where quote_id = q;
  r := pg_temp.as_val('b_admin@b.test', format('select public.publish_proposal(%L, true)::text', q));
  perform pg_temp.t('25 proposal publish refused', r like 'err:42501:Links are not available%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.publish_proposal(%L, false)::text', q));
  perform pg_temp.t('26 taking a proposal down still works', r not like 'err:%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select (public.publish_event_site(%L, false)).status', (select id from public.event_sites where quote_id = q)));
  perform pg_temp.t('27 unpublishing still works', r = 'unpublished', r);
  r := pg_temp.as_val('b_admin@b.test', format('select (public.publish_event_site(%L, true)).status', (select id from public.event_sites where quote_id = q)));
  perform pg_temp.t('28 invitation publish refused', r like 'err:42501:Links are not available%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select (public.event_site_new_link(%L)).status', (select id from public.event_sites where quote_id = q)));
  perform pg_temp.t('29 invitation new link refused', r like 'err:42501:Links are not available%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.delivery_link_issue(%L)::text', (select id from public.delivery_commitments where quote_id = q limit 1)));
  perform pg_temp.t('30 delivery link refused', r like 'err:42501:Links are not available%', r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.vendor_request_link(%L)::text', (select id from public.vendor_requests where quote_id = q limit 1)));
  perform pg_temp.t('31 vendor link refused', r like 'err:42501:Links are not available%', r);
  -- direct table writes, even as the database owner: the triggers
  r := coalesce((select 'x' where false), '');
  begin update public.quotes set approval_token = gen_random_uuid() where id = q; r := 'written';
  exception when others then r := sqlstate; end;
  perform pg_temp.t('32 trigger: approval token', r = '42501', r);
  begin insert into public.client_booklets(org_id, quote_id) values ('b0000000-0000-4000-8000-000000000001', q); r := 'written';
  exception when others then r := sqlstate; end;
  perform pg_temp.t('33 trigger: booklet', r = '42501', r);
  begin update public.event_proposal set published = true where quote_id = q; r := 'written';
  exception when others then r := sqlstate; end;
  perform pg_temp.t('34 trigger: proposal', r = '42501', r);
  begin update public.event_sites set status = 'published' where quote_id = q; r := 'written';
  exception when others then r := sqlstate; end;
  perform pg_temp.t('35 trigger: invitation', r = '42501', r);
  select count(*) into n from public.work_tokens where quote_id = q;
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.assign_tasks(%L, 'setup', array['Hang lights'], null, 'Ravi New', '+919800000199')::text$s$, q));
  perform pg_temp.t('36 assigning a task works in a trial', r not like 'err:%', r);
  perform pg_temp.t('37 and leaves no crew link row', (select count(*) from public.work_tokens where quote_id = q) = n, '');
  perform pg_temp.t('38 the task itself is saved', exists (select 1 from public.event_tasks t where t.quote_id = q and t.assignee_phone = '+919800000199'), '');
  perform pg_temp.t('39 _vr256_issue leaves no vendor link row in a trial',
    (select (public._vr256_issue(x, 'copy') ->> 'token') is null from public.vendor_requests x where x.quote_id = q limit 1)
    and (select count(*) from public.vendor_request_links l where l.org_id = 'b0000000-0000-4000-8000-000000000001') = 1, '');
end $$;

-- ---- (4) members only -----------------------------------------------------------------------------------------------------
do $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; r text; b jsonb; v_a int; v_i int; v_c int; v_p int; v_status text;
begin
  perform set_config('helm.r125_gate', 'off', true);
  update public.quotes set approval_token = null, approval_token_expires_at = null, approval_token_revoked_at = null where id = q;
  update public.event_proposal set share_token = null, published = false where quote_id = q;
  delete from public.client_link_issued where quote_id = q;
  perform set_config('helm.r125_gate', 'on', true);
  perform pg_temp.plan('trial');
  r := pg_temp.as_val('b_admin@b.test', 'select public.my_trial_links()::text');
  perform pg_temp.t('40 my_trial_links: active trial', (r::jsonb ->> 'closed')::boolean and (r::jsonb ->> 'active')::boolean and not (r::jsonb ->> 'ended')::boolean, r);
  r := pg_temp.as_val('anon', 'select public.my_trial_links()::text');
  perform pg_temp.t('41 my_trial_links: not for outsiders', r like 'err:%', r);
  select count(*) into v_a from public.audit_log where quote_id = q or entity_id = q::text;
  select count(*) into v_i from public.client_link_issued where quote_id = q;
  select count(*) into v_c from public.client_booklets where quote_id = q;
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('42 approval preview: the real public answer', b #>> '{public_get_quote,code}' is not null and (b #>> '{public_get_quote,pricing,total}')::numeric > 0
    and b ? 'public_get_portal' and b ? 'public_payment_schedule' and not (b ->> 'public_get_quote') like '%__error%', r);
  perform pg_temp.t('43 no token left behind', (select approval_token from public.quotes where id = q) is null
    and (select approval_token_expires_at from public.quotes where id = q) is null, '');
  perform pg_temp.t('44 no link log, no audit rows', (select count(*) from public.client_link_issued where quote_id = q) = v_i
    and (select count(*) from public.audit_log where quote_id = q or entity_id = q::text) = v_a, '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('booklet', %L, '{"days":45,"note":"Dear P","sections":{"terms":false}}')::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('45 booklet preview: real booklet, settings applied', b ? 'public_get_booklet' and not b -> 'public_get_booklet' ? '__error' and b #>> '{public_get_booklet,note}' = 'Dear P', r);
  perform pg_temp.t('46 no booklet row left behind, live booklet not revoked', (select count(*) from public.client_booklets where quote_id = q) = v_c
    and exists (select 1 from public.client_booklets where quote_id = q and revoked_at is null), '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('proposal', %L)::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('47 proposal preview', b #>> '{public_get_proposal,concept}' = 'Garden', r);
  perform pg_temp.t('48 proposal stays unpublished, no token', (select published from public.event_proposal where quote_id = q) = false
    and (select share_token from public.event_proposal where quote_id = q) is null, '');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
  update public.event_sites set status = 'draft', published_at = null where quote_id = q;
  perform set_config('request.jwt.claims', '', false);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('invitation', %L, '{"template":"eternal"}')::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('49 invitation preview: full site, chosen template', b #>> '{public_event_site,0,template}' = 'eternal' and b #>> '{public_event_site,0,data,names}' = 'P and A', r);
  perform pg_temp.t('50 the site stays a draft', (select status from public.event_sites where quote_id = q) = 'draft'
    and (select template from public.event_sites where quote_id = q) is distinct from 'eternal', '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('crew', %L)::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('51 crew preview: real tasks', b #>> '{worker_get_tasks,worker,name}' is not null, r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('vendor', %L)::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('52 vendor preview: real request, no extra link row', b -> 'vendor_link_get' is not null and not (b ? '__error')
    and (select count(*) from public.vendor_request_links l where l.org_id = 'b0000000-0000-4000-8000-000000000001') = 1, r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('enquiry', null)::text$s$));
  perform pg_temp.t('53 enquiry preview', (r::jsonb #>> '{public_enquiry_info,ok}')::boolean, r);
  r := pg_temp.as_val('anon', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  perform pg_temp.t('54 preview: an outsider has no access at all', r like 'err:42501:%', r);
  r := pg_temp.as_val('a_admin@a.test', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  perform pg_temp.t('55 preview: a member of another studio refused', r like 'err:42501:%', r);
  r := pg_temp.as_val('anon', format($s$select public.trial_member_test_approve(%L, '000000', 'X')::text$s$, q));
  perform pg_temp.t('56 test approval: outsider has no access', r like 'err:42501:%', r);
  r := pg_temp.as_val('a_admin@a.test', format($s$select public.trial_member_test_approve(%L, '000000', 'X')::text$s$, q));
  perform pg_temp.t('57 test approval: another studio refused', r like 'err:42501:%', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_test_approve(%L, '123456', 'X')::text$s$, q));
  perform pg_temp.t('58 test approval: only 000000', (r::jsonb ->> 'error') = 'test_code', r);
  perform pg_temp.t('59 a wrong code leaves no token', (select approval_token from public.quotes where id = q) is null, '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_simulate_payment(%L, 'X')::text$s$, q));
  perform pg_temp.t('60 simulated payment needs the test approval first', (r::jsonb ->> 'error') = 'not_approved', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_test_approve(%L, '000000', 'Client R', null, 'v3-2026-10', 'consent [trial test mode - code 000000, nothing sent]', 'ua')::text$s$, q));
  perform pg_temp.t('61 test approval works for staff', (r::jsonb ->> 'approved')::boolean and (r::jsonb ->> 'test_mode')::boolean, r);
  select approval_status, status into v_status, r from public.quotes where id = q;
  perform pg_temp.t('62 the quote is approved + confirmed', v_status = 'approved' and r = 'confirmed', v_status || '/' || r);
  perform pg_temp.t('63 and still has no token', (select approval_token from public.quotes where id = q) is null
    and not exists (select 1 from public.client_link_issued c where c.quote_id = q), '');
  perform pg_temp.t('64 audit says test mode', exists (select 1 from public.audit_log a where a.entity_id = q::text and a.action = 'approval.test_mode' and (a.changed ->> 'test_mode')::boolean), '');
  select count(*) into v_p from public.quote_payments where quote_id = q;
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_simulate_payment(%L, 'Client R', 'ua')::text$s$, q));
  perform pg_temp.t('65 simulated payment: TEST receipt', (r::jsonb ->> 'simulated')::boolean and (r::jsonb ->> 'receipt') like 'TEST-%' and not (r::jsonb ->> 'real_payment')::boolean, r);
  perform pg_temp.t('66 a TEST row only, never income', (select count(*) from public.quote_payments where quote_id = q) = v_p
    and exists (select 1 from public.trial_sim_payments s where s.quote_id = q and s.test_mode), '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  b := r::jsonb;
  perform pg_temp.t('67 the preview shows it: approved + TEST receipt', b #>> '{public_get_quote,approval_status}' = 'approved'
    and b #>> '{public_trial_sim_payments,rows,0,receipt}' like 'TEST-%', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_sim_payments_for_quote(%L)::text$s$, q));
  perform pg_temp.t('68 the studio pages still see the TEST row', r like '%TEST-%', r);
  -- ended: previews still open for looking, the test path is closed
  update public.quotes set approval_status = 'sent', status = 'quote' where id = q;
  perform pg_temp.plan('ended');
  r := pg_temp.as_val('b_admin@b.test', 'select public.my_trial_links()::text');
  perform pg_temp.t('69 my_trial_links: ended trial', (r::jsonb ->> 'closed')::boolean and (r::jsonb ->> 'ended')::boolean, r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  perform pg_temp.t('70 an ended trial can still look at the preview, read-only is kept', (r::jsonb #>> '{public_get_quote,code}') is not null, r);
  perform pg_temp.t('71 still no token', (select approval_token from public.quotes where id = q) is null, '');
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_test_approve(%L, '000000', 'X')::text$s$, q));
  perform pg_temp.t('72 ended trial: test approval closed', (r::jsonb ->> 'error') = 'trial_ended', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_simulate_payment(%L, 'X')::text$s$, q));
  perform pg_temp.t('73 ended trial: simulated payment closed', (r::jsonb ->> 'error') = 'trial_ended', r);
exception when others then insert into _rs values ('4x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); perform auth.logout(); execute 'reset role';
end $$;

-- ---- (5) paid studios: the public answer IS the kept body's answer -----------------------------------------------------------
do $$
declare p record; a text; b text; bad text := ''; q uuid := 'b0000000-0000-4000-8000-00000000da01'; o uuid := 'b0000000-0000-4000-8000-000000000001'; r text; n int := 0;
begin
  perform pg_temp.plan('paid');
  perform set_config('helm.r125_gate', 'off', true);
  update public.quotes set approval_status = 'sent', status = 'quote', approval_token = 'b0000000-0000-4000-8000-0000000000aa', approval_token_expires_at = null where id = q;
  update public.event_proposal set published = true, share_token = 'b0000000-0000-4000-8000-0000000000cc' where quote_id = q;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'b_admin@b.test'), 'role', 'authenticated')::text, false);
  update public.event_sites set status = 'published', published_at = now() where quote_id = q;
  perform set_config('request.jwt.claims', '', false);
  perform set_config('helm.r125_gate', 'on', true);
  for p in select * from (values
      ('public_get_quote', 'quote', 'b0000000-0000-4000-8000-0000000000aa'), ('public_get_portal', 'portal', 'b0000000-0000-4000-8000-0000000000aa'),
      ('public_get_booklet', 'booklet', 'b0000000-0000-4000-8000-0000000000bb'), ('public_get_proposal', 'proposal', 'b0000000-0000-4000-8000-0000000000cc')) x(f, k, t) loop
    a := pg_temp.as_val('anon', format('select public.%I(%L)::text', p.f, p.t));
    execute format('select public.%I(%L)::text', p.f || '__pre0334', p.t) into b;
    n := n + 1;
    if a is distinct from b or a like 'err:%' or a = '<null>' then bad := bad || ' | ' || p.f || ': ' || left(a, 100) || ' <> ' || left(coalesce(b, ''), 100); end if;
  end loop;
  perform pg_temp.t('80 paid: quote, portal, booklet, proposal answer exactly what the kept body answers', bad = '' and n = 4, bad);
  bad := '';
  for p in select * from _pr where link in ('quote ready', 'quote validity', 'quote mode', 'portal extras', 'booklet packages', 'booklet terms',
      'invitation info', 'crew tasks', 'vendor read', 'delivery read', 'studio name quote', 'studio name invite', 'studio name crew', 'studio name proposal', 'booklet studio') loop
    a := pg_temp.as_val('anon', p.real_sql); b := pg_temp.as_val('anon', p.fake_sql);
    if a is not distinct from b then bad := bad || ' | ' || p.link || ' same as a random token: ' || left(a, 100); end if;
  end loop;
  perform pg_temp.t('81 paid: every other page opens (differs from a random token)', bad = '', bad);
  r := pg_temp.as_val('anon', $q$select count(*)::text from public.public_event_site('r125-site')$q$);
  perform pg_temp.t('82 paid: the invitation opens', r = '1', r);
  r := pg_temp.as_val('anon', $q$select public.public_invite_rsvp('r125-site','{"name":"Guest One","attending":"yes","guests":1}')::text$q$);
  perform pg_temp.t('83 paid: RSVP saves', (r::jsonb ->> 'ok')::boolean, r);
  perform pg_temp.t('84 paid: the sim banner says no simulation', (pg_temp.as_val('anon', $q$select public.public_trial_simulation('quote','b0000000-0000-4000-8000-0000000000aa')::text$q$))::jsonb ->> 'simulation' = 'false', '');
  perform set_config('helm.r125_gate', 'off', true);
  update public.quotes set approval_token = null, approval_token_expires_at = null where id = q;
  perform set_config('helm.r125_gate', 'on', true);
  r := pg_temp.as_val('b_admin@b.test', format('select public.generate_approval_token(%L)::text', q));
  perform pg_temp.t('85 paid: approval link is created', r ~ '^[0-9a-f-]{36}$', r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.booklet_share(%L, 30, null, null, null)::text', q));
  perform pg_temp.t('86 paid: booklet link is created', r not like 'err:%' and (r::jsonb ->> 'token') is not null, r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.vendor_request_link(%L)::text', (select id from public.vendor_requests where quote_id = q limit 1)));
  perform pg_temp.t('87 paid: vendor link is created', r not like 'err:%' and (r::jsonb ->> 'token') is not null, r);
  r := pg_temp.as_val('b_admin@b.test', format('select public.delivery_link_issue(%L)::text', (select id from public.delivery_commitments where quote_id = q limit 1)));
  perform pg_temp.t('88 paid: delivery link is created', r not like 'err:%' and (r::jsonb ->> 'token') is not null, r);
  n := (select count(*) from public.work_tokens where quote_id = q);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.assign_tasks(%L, 'setup', array['Rig'], null, 'Paid Crew', '+919800000177')::text$s$, q));
  perform pg_temp.t('89 paid: assigning makes a crew link', (select count(*) from public.work_tokens where quote_id = q) = n + 1, r);
  r := pg_temp.as_val('b_admin@b.test', 'select public.my_trial_links()::text');
  perform pg_temp.t('90 paid: my_trial_links closed false', r = '{"closed": false}', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_preview_bundle('approval', %L)::text$s$, q));
  perform pg_temp.t('91 paid: previews refused', r like 'err:42501:%', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_test_approve(%L, '000000', 'X')::text$s$, q));
  perform pg_temp.t('92 paid: test approval refused', (r::jsonb ->> 'error') = 'trial_only', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.trial_member_simulate_payment(%L, 'X')::text$s$, q));
  perform pg_temp.t('93 paid: simulated payment refused', r::jsonb ->> 'error' in ('trial_only'), r);
exception when others then insert into _rs values ('8x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); perform auth.logout(); execute 'reset role';
end $$;

-- ---- (6) upgrade -----------------------------------------------------------------------------------------------------------
do $$
declare q uuid := 'b0000000-0000-4000-8000-00000000da01'; o uuid := 'b0000000-0000-4000-8000-000000000001'; r text; n int; v_tok uuid;
begin
  perform pg_temp.plan('trial');
  perform set_config('helm.r125_gate', 'off', true);
  update public.quotes set approval_token = 'b0000000-0000-4000-8000-0000000000ab', approval_token_expires_at = now() + interval '10 days', approval_token_revoked_at = null where id = q;
  perform set_config('helm.r125_gate', 'on', true);
  r := pg_temp.as_val('anon', $q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000ab')::text$q$);
  perform pg_temp.t('95 before the upgrade the link is refused', r like 'err:%' or r = '<null>', r);
  r := pg_temp.as_val('b_admin@b.test', format($s$select public.assign_tasks(%L, 'setup', array['Sound'], null, 'Trial Crew', '+919800000155')::text$s$, q));
  perform pg_temp.t('96 a trial assignment made no crew link', not exists (select 1 from public.work_tokens w where w.quote_id = q and w.phone = '+919800000155'), r);
  perform pg_temp.plan('paid');
  r := pg_temp.as_val('anon', $q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000ab')::text$q$);
  perform pg_temp.t('97 after the upgrade the same address opens', r not like 'err:%' and r <> '<null>', r);
  perform pg_temp.t('98 the crew link left out is made on upgrade', exists (select 1 from public.work_tokens w where w.quote_id = q and w.phone = '+919800000155'), '');
  r := pg_temp.as_val('b_admin@b.test', format('select public.generate_approval_token(%L)::text', q));
  perform pg_temp.t('99 links can be created again', r not like 'err:%', r);
exception when others then insert into _rs values ('9x', 'FAIL: ' || sqlstate || ' ' || sqlerrm); perform auth.logout(); execute 'reset role';
end $$;

-- referrals: a trial studio's code is unknown, its page has no link
do $$
declare o uuid := 'b0000000-0000-4000-8000-000000000001'; c public.referral_codes; r text; v text;
begin
  perform pg_temp.plan('trial');
  select * into c from public.referral_codes limit 0;
  c.studio_id := o; c.kind := 'studio';
  perform pg_temp.t('A1 a trial studio referral code answers unknown', public._r29_code_problem(c) = 'unknown', '');
  r := pg_temp.as_val('b_admin@b.test', 'select public.my_referral()::text');
  perform pg_temp.t('A2 no referral link in a trial', (r::jsonb ->> 'program_on') = 'false', r);
exception when others then insert into _rs values ('Ax', 'FAIL: ' || sqlstate || ' ' || sqlerrm); perform auth.logout(); execute 'reset role';
end $$;

-- ---- (7) structure -----------------------------------------------------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '%\_\_pre0334' escape '\'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  perform pg_temp.t('B1 the kept bodies have no app privilege', bad is null, bad);
  select string_agg(p.oid::regprocedure::text, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (p.proname like '\_r125\_%' escape '\' or p.proname like 'tg\_r125\_%' escape '\')
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  perform pg_temp.t('B2 the helpers have no app privilege', bad is null, bad);
  perform pg_temp.t('B3 the members-only functions are not open to anon',
    not has_function_privilege('anon', 'public.trial_preview_bundle(text,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.trial_member_test_approve(uuid,text,text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_member_simulate_payment(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_links()', 'execute'), '');
  perform pg_temp.t('B4 the public pages stay open to anon',
    has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute') and has_function_privilege('anon', 'public.public_event_site(text)', 'execute')
    and has_function_privilege('anon', 'public.vendor_link_get(text)', 'execute') and has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'execute')
    and has_function_privilege('anon', 'public.delivery_link_get(text)', 'execute'), '');
  perform pg_temp.t('B5 every wrapper is definer with an empty search_path', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosrc like '%r125-0334%' and (not p.prosecdef and p.proname not in ('_r125_path_org', '_r125_refuse', '_trial_terms_version')
       or not coalesce(p.proconfig, '{}') @> array['search_path=""'])), (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%r125-0334%' and not coalesce(p.proconfig, '{}') @> array['search_path=""']));
  select string_agg(p.polname, ', ') into bad from pg_policy p where pg_get_expr(p.polqual, p.polrelid) like '%pre0334%' or pg_get_expr(p.polwithcheck, p.polrelid) like '%pre0334%';
  perform pg_temp.t('B7 no policy points at a kept body (a renamed function keeps its policies)', bad is null, bad);
  select string_agg(t.tgname, ', ') into bad from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname like '%pre0334';
  perform pg_temp.t('B8 no trigger points at a kept body', bad is null, bad);
  perform pg_temp.t('B6 the anon surface did not grow: the only new functions are authenticated-only', not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('my_trial_links', 'trial_preview_bundle', 'trial_member_test_approve', 'trial_member_simulate_payment')
       and has_function_privilege('anon', p.oid, 'execute')), '');
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R125-TRIAL-LOCKDOWN-0334: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R125-TRIAL-LOCKDOWN-0334: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
