-- r56-client-links-0297.sql -- r56 (audit 2026-10-28 group C): client links show only what the client should see.
--   C-01 public_get_quote / public_get_proposal answer an allow-list (no staff notes, contacts, budget, costs).
--   C-05 public_get_portal: studio brand = accent only.
--   C-04 public_get_booklet_image / public_quote_validity: no rate-limit row for a random token; auth_rate_hits_purge.
--   C-02 / C-03 client_mailer_check: quotes EDIT, own studio, approval link still live.
-- Re-applies 0297 twice (earlier suites may re-apply 0042 / 0052 / 0090 / 0095 / 0260 / 0262 over these wrappers).
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

set client_min_messages = error;
\ir ../../supabase/migrations/0297_r56_client_link_payloads.sql
\ir ../../supabase/migrations/0297_r56_client_link_payloads.sql
set client_min_messages = warning;

create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;
-- run one value-returning statement as anon / a fixture user; 'err:<sqlstate>:<message>' on error
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
create or replace function pg_temp.has_secret(t text) returns boolean language sql as $$
  select t ~ '(VIP haggler|vip@client\.test|\+919800012345|Banjara Hills|Acme Pvt|29ABCDE1234F1Z5|budget|_ratesAt|otherAuto|_objectsCost|vendorCost|supplier|"notes"|"email"|"phone"|STAFF-ONLY|onboarding|billing)';
$$;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01';
  qB uuid := 'b0000000-0000-4000-8000-00000000da01';
  tokA uuid := 'a0000000-0000-4000-8000-0000000000aa';
  tokP uuid := 'a0000000-0000-4000-8000-0000005600fe';
  tokBk uuid := 'a0000000-0000-4000-8000-0000005600bb';
  u_des uuid;
  P jsonb := '{"chairs": 100, "chairPrice": 50, "guests": 120, "platePrice": 500, "other": 1000, "serviceChargePct": 5,
    "discount": 500, "discountPct": 0, "gstPct": 18, "placeOfSupply": "intra", "currency": "INR",
    "catering": {"mode": "inhouse", "amount": 2000, "vendorCost": 900},
    "coupon": {"kind": "fixed", "value": 100, "internal": "STAFF-ONLY"}, "couponCode": "WELCOME",
    "computed": {"rental": 6000, "total": 1, "_objectsCost": 777},
    "total": 1, "_ratesAt": {"chairPrice": 40}, "otherAuto": true, "supplier": {"name": "Studio A", "trn": "X"},
    "objectLines": [{"type": "stage", "cost": 9000}],
    "client": {"name": "Alice Rao", "names": "Alice & Ravi", "eventType": "Wedding", "eventDate": "2026-12-28",
               "notes": "VIP haggler - push the premium package", "email": "vip@client.test", "phone": "+919800012345",
               "address": "Banjara Hills", "company": "Acme Pvt", "trn": "29ABCDE1234F1Z5", "budget": 900000,
               "city": {"nested": "object"}}}'::jsonb;
  j jsonb; k jsonb; t text; n0 bigint; n1 bigint; r text;
begin
  -- fixture: quote A with a realistic staff-written pricing (client copied in, internal keys), a published proposal,
  -- a live booklet, and a studio brand with more than the accent
  update public.quotes set pricing = P where id = qA;
  update public.organizations set brand = '{"accent": "#0f7a43", "logo": "l.png", "onboarding": {"step": 3}, "billing": {"gstin": "X"}}'::jsonb
   where id = orgA;
  insert into public.event_proposal(quote_id, org_id, share_token, published, concept, theme)
    values (qA, orgA, tokP, true, 'Garden', 'Ivory')
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true, concept = 'Garden', theme = 'Ivory';
  delete from public.client_booklets where quote_id = qA;
  insert into public.client_booklets(quote_id, org_id, token) values (qA, orgA, tokBk);
  delete from auth.mfa_factors where user_id in (select id from auth.users where email in ('a_admin@a.test', 'a_staff@a.test', 'b_staff@b.test'));
  u_des := (select id from auth.users where email = 'a_designer56@a.test');
  if u_des is null then u_des := auth.seed_user('a_designer56@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u_des, 'a_designer56@a.test', 'designer', orgA, false, now())
    on conflict (id) do update set role = 'designer', org_id = orgA;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('designer', 'quotes', true, false, orgA, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;

  -- 01 structure: markers, kept bodies, grants
  perform pg_temp.res('01 the five client-link functions carry the 0297 marker',
    (select count(*) = 5 from pg_proc p where p.pronamespace = 'public'::regnamespace and position('r56-client-link-0297' in p.prosrc) > 0
       and p.proname in ('public_get_quote', 'public_get_proposal', 'public_get_portal', 'public_get_booklet_image', 'public_quote_validity')));
  perform pg_temp.res('02 anon + signed-in can still open the links (same grants as before)',
    has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_proposal(uuid)', 'execute')
    and has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_booklet_image(uuid,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_quote_validity(text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.public_get_quote(uuid)', 'execute'));
  perform pg_temp.res('03 previous bodies kept once as __pre0297, not callable by anon / signed-in / service role',
    (select count(*) = 5 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0297'
       and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('service_role', p.oid, 'execute')));
  perform pg_temp.res('04 helpers + purge not callable by anon / signed-in; purge by the service role; mailer check by signed-in only',
    not has_function_privilege('anon', 'public._cl297_pricing(jsonb,text)', 'execute') and not has_function_privilege('authenticated', 'public._cl297_pricing(jsonb,text)', 'execute')
    and not has_function_privilege('anon', 'public.auth_rate_hits_purge(integer)', 'execute') and not has_function_privilege('authenticated', 'public.auth_rate_hits_purge(integer)', 'execute')
    and has_function_privilege('service_role', 'public.auth_rate_hits_purge(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.client_mailer_check(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.client_mailer_check(uuid,text)', 'execute'));

  -- 05 the bug, proven on the kept old body: the whole pricing (staff notes, contacts, budget) left the building
  t := (public.public_get_quote__pre0297(tokA))::text;
  perform pg_temp.res('05 OLD body leaked notes / e-mail / phone / budget (the C-01 bug, for the record)',
    t like '%VIP haggler%' and t like '%vip@client.test%' and t like '%budget%', left(t, 200));

  -- 06-10 C-01 approval link as anon
  r := pg_temp.as_val('anon', format('select public.public_get_quote(%L)::text', tokA)); j := case when r like '{%' then r::jsonb end;
  perform pg_temp.res('06 approval link (anon): no notes, e-mail, phone, address, company, tax no., budget, costs, rate snapshots',
    j is not null and not pg_temp.has_secret(r), r);
  perform pg_temp.res('07 approval link: pricing.client = name (+ couple names / event type / date) only',
    j #> '{pricing,client}' = '{"name": "Alice Rao", "names": "Alice & Ravi", "eventType": "Wedding", "eventDate": "2026-12-28"}'::jsonb, j #>> '{pricing,client}');
  perform pg_temp.res('08 approval link: every price input the page needs is there, unchanged',
    (select bool_and(j -> 'pricing' -> k2 = (select q.pricing -> k2 from public.quotes q where q.id = qA))
       from unnest(array['chairs', 'chairPrice', 'guests', 'platePrice', 'other', 'serviceChargePct', 'discount', 'discountPct',
                         'gstPct', 'placeOfSupply', 'currency', 'couponCode', 'total']) k2)
    and j #> '{pricing,catering}' = '{"mode": "inhouse", "amount": 2000}'::jsonb
    and j #> '{pricing,coupon}' = '{"kind": "fixed", "value": 100}'::jsonb
    and (j #>> '{pricing,total}')::numeric > 1, j #>> '{pricing}');
  perform pg_temp.res('09 approval link: top-level answer unchanged (code, title, status, approval, client_name, re-approval)',
    j ->> 'code' = 'A-0001' and j ->> 'client_name' = 'Alice' and j ->> 'approval_status' = 'sent' and j ? 'reapproval_required'
    and j ? 'title' and j ? 'status' and j ? 'event_type' and not (j ? 'client') and not (j #> '{pricing}' ? 'objectLines'), r);
  perform pg_temp.res('10 approval link: computed keeps client-facing lines only (no _objectsCost)',
    jsonb_typeof(j #> '{pricing,computed}') = 'object' and not (j #> '{pricing,computed}' ? '_objectsCost') and (j #> '{pricing,computed}' ? 'total'), j #>> '{pricing,computed}');

  -- 11-13 C-01 proposal link (forwardable): no client details inside pricing at all
  r := pg_temp.as_val('anon', format('select public.public_get_proposal(%L)::text', tokP)); k := case when r like '{%' then r::jsonb end;
  perform pg_temp.res('11 proposal link (anon): no notes / contacts / budget / costs anywhere', k is not null and not pg_temp.has_secret(r), r);
  perform pg_temp.res('12 proposal link: pricing has no client object; price inputs + total there',
    not (k -> 'pricing' ? 'client') and k #>> '{pricing,chairs}' = '100' and k #>> '{pricing,gstPct}' = '18'
    and (k ->> 'total')::numeric = (j #>> '{pricing,total}')::numeric, r);
  perform pg_temp.res('13 proposal link: page fields unchanged (concept, theme, event code / title / type, client_name)',
    k ->> 'concept' = 'Garden' and k ->> 'theme' = 'Ivory' and k ->> 'event_code' = 'A-0001' and k ? 'event_title'
    and k ? 'event_type' and k ->> 'client_name' = 'Alice' and k ? 'palette' and k ? 'images' and k ? 'scope', r);

  -- 14 legacy pricing shape (subtotal / discount / gstPct / total) keeps the approve page's legacy breakdown
  update public.quotes set pricing = '{"subtotal": 200000, "discount": 0, "gstPct": 18, "total": 236000, "client": {"name": "Bob", "notes": "VIP haggler"}}'::jsonb where id = qB;
  r := pg_temp.as_val('anon', $q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000bb')::text$q$);
  perform pg_temp.res('14 legacy pricing keeps subtotal / discount / gstPct / total, still no notes',
    r like '{%' and (r::jsonb -> 'pricing') @> '{"subtotal": 200000, "discount": 0, "gstPct": 18, "total": 236000}'::jsonb and r not like '%VIP%', r);

  -- 15-16 C-05 portal: brand reduced to the accent; every other field as before
  r := pg_temp.as_val('anon', format('select public.public_get_portal(%L)::text', tokA)); k := case when r like '{%' then r::jsonb end;
  perform pg_temp.res('15 portal: studio = name + brand {accent} only (no onboarding / billing / logo)',
    k -> 'studio' = '{"name": "Studio A", "brand": {"accent": "#0f7a43"}}'::jsonb, k ->> 'studio');
  perform pg_temp.res('16 portal: event / client_name / total / proposal / payment / gallery / currency / tax still there',
    k ? 'event' and k ->> 'client_name' = 'Alice' and k ? 'total' and k ? 'proposal' and k ? 'payment' and k ? 'gallery'
    and k ? 'currency' and k ? 'tax' and not pg_temp.has_secret(r), r);
  update public.organizations set brand = '{"accent": {"evil": 1}}'::jsonb where id = orgA;
  r := pg_temp.as_val('anon', format('select public.public_get_portal(%L)::text', tokA));
  perform pg_temp.res('17 portal: a non-text accent is dropped (brand {})', r like '{%' and r::jsonb #> '{studio,brand}' = '{}'::jsonb, r);

  -- 18-19 the earlier link checks still run (kept body): expired token + cancelled event refused, random token refused
  update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id = qA;
  r := pg_temp.as_val('anon', format('select public.public_get_quote(%L)::text', tokA));
  perform pg_temp.res('18 expired approval link still refused (quote + portal)',
    r like 'err:%' and pg_temp.as_val('anon', format('select public.public_get_portal(%L)::text', tokA)) like 'err:%', r);
  update public.quotes set approval_token_expires_at = null where id = qA;
  update public.quotes set status = 'cancelled' where id = qA;
  r := pg_temp.as_val('anon', format('select public.public_get_proposal(%L)::text', tokP));
  perform pg_temp.res('19 cancelled event: proposal + approval links still refused with the cancel message',
    r like '%has been cancelled%' and pg_temp.as_val('anon', format('select public.public_get_quote(%L)::text', tokA)) like '%has been cancelled%', r);
  update public.quotes set status = 'quote' where id = qA;
  -- the restore pauses / expires the old links (0260); put the fixture link back to live for the checks below
  update public.quotes set client_links_paused_at = null, approval_token_revoked_at = null, approval_token = tokA,
                           approval_token_expires_at = now() + interval '7 days' where id = qA;
  perform pg_temp.res('20 random token: quote / proposal / portal still refused',
    pg_temp.as_val('anon', format('select public.public_get_quote(%L)::text', gen_random_uuid())) like 'err:%'
    and pg_temp.as_val('anon', format('select public.public_get_proposal(%L)::text', gen_random_uuid())) like 'err:%'
    and pg_temp.as_val('anon', format('select public.public_get_portal(%L)::text', gen_random_uuid())) like 'err:%');

  -- 21-25 C-04 rate-limit rows only for real links
  delete from public.auth_rate_hits;
  n0 := (select count(*) from public.auth_rate_hits);
  for i in 1..25 loop
    r := pg_temp.as_val('anon', format('select public.public_get_booklet_image(%L, %L, %L)::text', gen_random_uuid(), '2d', 'plain'));
    r := pg_temp.as_val('anon', format('select public.public_quote_validity(%L, %L)::text', 'quote', gen_random_uuid()));
    r := pg_temp.as_val('anon', format('select public.public_quote_validity(%L, %L)::text', 'booklet', gen_random_uuid()));
  end loop;
  n1 := (select count(*) from public.auth_rate_hits);
  perform pg_temp.res('21 75 random-token calls (picture + valid-until) write NO rate-limit row, answer null', n1 = n0 and r = '<null>', n0 || '->' || n1);
  perform public.public_get_booklet_image__pre0297(gen_random_uuid(), '2d', 'plain');
  perform pg_temp.res('22 OLD picture body wrote a row for a random token (the C-04 bug, for the record)',
    (select count(*) from public.auth_rate_hits) = n1 + 1);
  delete from public.auth_rate_hits;
  r := pg_temp.as_val('anon', format('select public.public_get_booklet_image(%L, %L, %L)::text', tokBk, '2d', 'plain'));
  perform pg_temp.res('23 a real booklet link is still rate-limited (booklet.read row) and answers as before (no picture -> null)',
    r = '<null>' and exists (select 1 from public.auth_rate_hits where bucket = 'booklet.read' and key = md5('booklet:' || tokBk::text)), r);
  r := pg_temp.as_val('anon', format('select public.public_quote_validity(%L, %L)::text', 'quote', tokA));
  perform pg_temp.res('24 a real approval link: valid-until still answers and is still rate-limited (qv_read row)',
    r like '{%' and r::jsonb ? 'state' and exists (select 1 from public.auth_rate_hits where bucket = 'qv_read' and key = tokA::text), r);
  r := pg_temp.as_val('anon', format('select public.public_quote_validity(%L, %L)::text', 'nope', tokA));
  perform pg_temp.res('25 bad kind / null token answer null (no row)',
    r = '<null>' and pg_temp.as_val('anon', $q$select public.public_quote_validity('quote', null)::text$q$) = '<null>'
    and pg_temp.as_val('anon', $q$select public.public_get_booklet_image(null, '2d', 'plain')::text$q$) = '<null>');

  -- 26-28 purge: only expired counters (window started > 2 days ago) go; fresh limits stay
  delete from public.auth_rate_hits;
  insert into public.auth_rate_hits(bucket, key, window_start, n) values
    ('r56.old', 'k1', now() - interval '3 days', 9), ('r56.old', 'k2', now() - interval '10 days', 9),
    ('r56.day', 'k3', now() - interval '23 hours', 500), ('r56.new', 'k4', now(), 1);
  execute 'set local role service_role';
  n0 := public.auth_rate_hits_purge();
  execute 'reset role';
  perform pg_temp.res('26 purge (service role) deletes only counters older than 2 days',
    n0 = 2 and (select array_agg(key order by key) from public.auth_rate_hits) = array['k3', 'k4'], n0::text);
  perform pg_temp.res('27 a limit inside its 1-day window is untouched (still blocks)',
    (select n from public.auth_rate_hits where key = 'k3') = 500);
  perform pg_temp.res('28 purge refused for anon / signed-in',
    pg_temp.as_val('anon', 'select public.auth_rate_hits_purge()::text') like 'err:42501%'
    and pg_temp.as_val('a_admin@a.test', 'select public.auth_rate_hits_purge()::text') like 'err:42501%');

  -- 29-37 C-02 / C-03 client_mailer_check (asked as the caller)
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('29 admin (quotes edit), own studio: allowed, live approval link', r like '{%' and r::jsonb = '{"ok": true, "link_live": true}'::jsonb, r);
  r := pg_temp.as_val('a_staff@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'booklet'));
  perform pg_temp.res('30 sales with quotes edit: allowed (booklet)', r like '{%' and (r::jsonb ->> 'ok')::boolean, r);
  r := pg_temp.as_val('a_designer56@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('31 view-only role (designer: quotes view, no edit): refused 42501 (C-02)', r like 'err:42501%', r);
  perform pg_temp.res('31b the same designer CAN read the quote (view) - only sending is refused',
    pg_temp.as_val('a_designer56@a.test', format('select count(*)::text from public.quotes where id = %L', qA)) = '1');
  r := pg_temp.as_val('b_staff@b.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('32 another studio''s quote: refused 42501', r like 'err:42501%', r);
  r := pg_temp.as_val('anon', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('33 anon: refused', r like 'err:42501%', r);
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'spam'));
  perform pg_temp.res('34 unknown kind: 22023', r like 'err:22023%', r);
  update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id = qA;
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('35 expired approval link: link_live false (C-03, the mailer answers "create the approval link first")',
    r like '{%' and r::jsonb = '{"ok": true, "link_live": false}'::jsonb, r);
  update public.quotes set approval_token_expires_at = now() + interval '7 days', client_links_paused_at = now() where id = qA;
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('36 paused links (restored event): link_live false', r like '{%' and r::jsonb ->> 'link_live' = 'false', r);
  update public.quotes set client_links_paused_at = null, approval_token = null where id = qA;
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('37 no approval link yet: link_live false', r like '{%' and r::jsonb ->> 'link_live' = 'false', r);
  update public.quotes set approval_token = tokA, approval_token_expires_at = now() + interval '7 days', deleted_at = now() where id = qA;
  r := pg_temp.as_val('a_admin@a.test', format('select public.client_mailer_check(%L, %L)::text', qA, 'approval'));
  perform pg_temp.res('38 deleted quote: refused 42501', r like 'err:42501%', r);
  update public.quotes set deleted_at = null where id = qA;

  -- 39 the pure allow-list helper on odd input
  perform pg_temp.res('39 helper: null / non-object pricing passes through; nested values never leak as top-level keys',
    public._cl297_pricing(null, 'quote') is null and public._cl297_pricing('[1]'::jsonb, 'quote') = '[1]'::jsonb
    and public._cl297_pricing('{"total": {"x": "VIP"}, "chairs": [1], "gstPct": 18}'::jsonb, 'quote') = '{"gstPct": 18}'::jsonb);
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R56-CLIENT-LINKS-0297: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R56-CLIENT-LINKS-0297: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
