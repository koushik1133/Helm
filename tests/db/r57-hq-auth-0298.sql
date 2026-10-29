-- r57-hq-auth-0298.sql -- R57 HQ + sign-in hardening (0298): HQ masking in the database + hq_reveal (G-HQ-1 / G-HQ-7),
-- partner codes need billing.write (G-HQ-2), hq_mfa_reset role first + HQ team Owner only (G-HQ-3), referral code
-- oracle (G-HQ-4), studio credit cap (G-HQ-6), trusted caller address + public form caps (G-HQ-5 / BS-02 / E-02),
-- signup_email_preauthorised (A-1), member_profile_list (A-3), invitations token / mail_key_hash (A-5 / I-04).
-- Legit roles keep working. Re-applies 0298 twice (re-run safe). Rolled back. Local disposable PG only, fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
set client_min_messages = error;
\ir ../../supabase/migrations/0298_r57_hq_auth_hardening.sql
\ir ../../supabase/migrations/0298_r57_hq_auth_hardening.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal) || coalesce(p_extra, '{}'::jsonb))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon(p_headers text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('request.headers', p_headers, false);
  execute 'set role anon'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.mkuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u; return u;
end $$;
create or replace function pg_temp.fresh() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))) $$;
create or replace function pg_temp.stale() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 hour')::bigint))) $$;
create or replace function pg_temp.dot() returns text language sql as $$ select chr(8226) $$;
grant execute on function pg_temp.dot() to anon, authenticated, service_role;
create or replace function pg_temp.org() returns uuid language sql as $$ select 'a0000000-0000-4000-8000-000000000001'::uuid $$;
grant execute on function pg_temp.org() to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

-- ---- setup -------------------------------------------------------------------------------------------------------------
do $$ declare v_crew uuid; v_off uuid; begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by, role) values
    ('r57sales@helm.events', 'test', 'sales'), ('r57sec@helm.events', 'test', 'security'), ('r57sup@helm.events', 'test', 'support'),
    ('r57view@helm.events', 'test', 'viewer'), ('r57adm@helm.events', 'test', 'admin')
  on conflict do nothing;
  perform pg_temp.mkuser(e) from unnest(array['admin@helm.events', 'r57sales@helm.events', 'r57sec@helm.events', 'r57sup@helm.events',
                                              'r57view@helm.events', 'r57adm@helm.events']) e;
  insert into public.studio_account(org_id, primary_contact_name, primary_contact_email, primary_contact_phone, billing_contact_email,
                                    gstin, pan, tax_id, payment_mandate_ref)
    values (pg_temp.org(), 'Riya Contact', 'riya.contact@studio-a.test', '+919876543210', 'billing@studio-a.test',
            '27ABCDE1234F1Z5', 'ABCDE1234F', 'TAXID-778899', 'MANDATE_123456')
  on conflict (org_id) do update set primary_contact_email = excluded.primary_contact_email, primary_contact_phone = excluded.primary_contact_phone,
    billing_contact_email = excluded.billing_contact_email, gstin = excluded.gstin, pan = excluded.pan, tax_id = excluded.tax_id,
    payment_mandate_ref = excluded.payment_mandate_ref;
  insert into public.sales_enquiries(id, name, email, phone, company) values ('e5700000-0000-4000-8000-000000000001', 'Enq Person', 'enquirer@corp.test', '+919988776655', 'Corp');
  insert into public.sales_requests(id, org_id, plan_code, studio_name, contact_name, contact_email, contact_phone)
    values ('e5700000-0000-4000-8000-000000000002', pg_temp.org(), 'studio', 'Studio A', 'Req Person', 'requester@studio-a.test', '+919811112222');
  insert into public.suggestions(id, message, email) values ('e5700000-0000-4000-8000-000000000003', 'More colours please', 'suggester@home.test');
  -- studio A members: a crew login, a deactivated member
  v_crew := pg_temp.mkuser('r57crew@a.test'); v_off := pg_temp.mkuser('r57gone@a.test');
  insert into public.profiles(id, email, role, org_id, full_name, must_change_password, created_at) values
    (v_crew, 'r57crew@a.test', 'crew', pg_temp.org(), 'Crew Kiran', false, now()),
    (v_off, 'r57gone@a.test', 'sales', pg_temp.org(), 'Gone Gita', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (v_off, pg_temp.org(), 'deactivated', now())
  on conflict (user_id, org_id) do update set status = 'deactivated';
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) masked in the database (G-HQ-1, G-HQ-7) -----------------------------------------------------------------------
do $$ declare r jsonb; a jsonb; v_row record; v_n int; begin
  perform pg_temp.as_user('r57sales@helm.events', 'aal2');
  select * into v_row from public.hq_studios('riya.contact@studio-a.test', null, 25, 0) x where x.org_id = pg_temp.org();
  perform pg_temp.res('01 hq_studios: the e-mail / phone come back masked (search by the real e-mail still finds the studio)',
    v_row.org_id is not null and v_row.primary_contact_email = 'ri' || repeat(pg_temp.dot(), 3) || '@studio-a.test'
    and v_row.primary_contact_phone = repeat(pg_temp.dot(), 10) || '10' and position('riya.contact' in coalesce(v_row.primary_contact_email, '')) = 0,
    coalesce(v_row.primary_contact_email, '(none)') || ' ' || coalesce(v_row.primary_contact_phone, ''));
  r := public.hq_studio_detail(pg_temp.org()); a := r -> 'account';
  perform pg_temp.res('02 hq_studio_detail: PAN, GSTIN, tax id, mandate, e-mails and phone masked; nothing in clear anywhere',
    a ->> 'pan' = 'AB' || repeat(pg_temp.dot(), 6) || '4F' and a ->> 'gstin' like '27%' || pg_temp.dot() || '%Z5'
    and position('ABCDE1234F' in r::text) = 0 and position('TAXID-778899' in r::text) = 0 and position('MANDATE_123456' in r::text) = 0
    and position('riya.contact@' in r::text) = 0 and position('9876543210' in r::text) = 0 and position('billing@studio-a' in r::text) = 0,
    left(coalesce(a::text, ''), 400));
  perform pg_temp.res('03 hq_studio_detail: member e-mails masked, each member carries its user_id',
    jsonb_array_length(r -> 'members') > 0
    and not exists (select 1 from jsonb_array_elements(r -> 'members') m where position('@a.test' in coalesce(m ->> 'email', '')) > 0
                      and position(pg_temp.dot() in m ->> 'email') = 0)
    and exists (select 1 from jsonb_array_elements(r -> 'members') m where m ->> 'user_id' = pg_temp.uid('a_admin@a.test')::text),
    left((r -> 'members')::text, 300));
  r := public.hq_sales_enquiries(null);
  perform pg_temp.res('04 enquiries inbox: e-mail + phone masked', position('enquirer@corp.test' in r::text) = 0 and position('99887' in r::text) = 0
    and exists (select 1 from jsonb_array_elements(r -> 'rows') x where x ->> 'id' = 'e5700000-0000-4000-8000-000000000001' and x ->> 'email' like 'en%@corp.test'), left(r::text, 300));
  r := public.hq_sales_requests(null);
  perform pg_temp.res('05 plan requests: contact e-mail + phone masked', position('requester@studio-a.test' in r::text) = 0 and position('9811112222' in r::text) = 0, left(r::text, 300));
  r := public.hq_suggestions(null);
  perform pg_temp.res('06 suggestions: e-mail masked', position('suggester@home.test' in r::text) = 0
    and exists (select 1 from jsonb_array_elements(r -> 'rows') x where x ->> 'email' like 'su%@home.test'), left(r::text, 300));
  perform pg_temp.as_user('r57sup@helm.events', 'aal2');
  select count(*) into v_n from public.hq_users('a_admin', 25, 0) x where x.email = 'a_admin@a.test';
  perform pg_temp.res('07 hq_users: e-mails masked (Support)', v_n = 0
    and exists (select 1 from public.hq_users('a_admin', 25, 0) x where x.email = 'a_' || repeat(pg_temp.dot(), 3) || '@a.test'));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) hq_reveal: role first, then one value + one log row (G-HQ-1, G-HQ-7) -------------------------------------------
do $$ declare e text; r jsonb; n0 int; n1 int; begin
  perform pg_temp.as_anon();
  e := pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''email'')', pg_temp.org()));
  perform pg_temp.res('08 reveal: anon refused (no privilege)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''email'')', pg_temp.org()));
  perform pg_temp.res('09 reveal: a studio admin (not HQ) refused', e like '42501%', e);
  perform pg_temp.as_user('r57view@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''email'')', pg_temp.org())) || '|' || pg_temp.try('select public.hq_reveal(''studio'', ''not-a-uuid'', ''email'')');
  perform pg_temp.res('10 reveal: Viewer refused for a real id AND a bad id alike (the role is checked before anything else)', e like '42501%HQ_ROLE%|42501%HQ_ROLE%', e);
  perform pg_temp.su(); select count(*) into n0 from public.audit_log where action = 'hq.reveal';
  perform pg_temp.as_user('r57sales@helm.events', 'aal2');
  r := public.hq_reveal('studio', pg_temp.org()::text, 'email');
  perform pg_temp.su(); select count(*) into n1 from public.audit_log where action = 'hq.reveal';
  perform pg_temp.res('11 reveal: Sales gets the real studio e-mail and exactly ONE hq.reveal row (field only, never the value)',
    r ->> 'value' = 'riya.contact@studio-a.test' and n1 = n0 + 1
    and exists (select 1 from public.audit_log l where l.action = 'hq.reveal' and l.entity = 'studio' and l.entity_id = pg_temp.org()::text
                  and l.changed = '{"field": "email"}'::jsonb and l.actor = pg_temp.uid('r57sales@helm.events'))
    and not exists (select 1 from public.audit_log l where l.action = 'hq.reveal' and position('riya.contact' in coalesce(l.changed::text, '')) > 0),
    coalesce(r::text, '') || ' n0=' || n0 || ' n1=' || n1);
  perform pg_temp.as_user('r57sales@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''pan'')', pg_temp.org())) || '|'
    || pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''tax_id'')', pg_temp.org())) || '|'
    || pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''payment_mandate_ref'')', pg_temp.org())) || '|'
    || pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''business_details'')', pg_temp.org()));
  perform pg_temp.res('12 reveal: Sales refused PAN / tax id / mandate (no billing role) and the full business details', e like '42501%HQ_ROLE%|42501%HQ_ROLE%|42501%HQ_ROLE%|42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r57sec@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''pan'')', pg_temp.org()));
  perform pg_temp.res('13 reveal: Security refused PAN too (G-HQ-7)', e like '42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r57adm@helm.events', 'aal2');
  r := public.hq_reveal('studio', pg_temp.org()::text, 'pan');
  perform pg_temp.res('14 reveal: HQ Admin (billing.read) gets the real PAN', r ->> 'value' = 'ABCDE1234F', coalesce(r::text, ''));
  r := public.hq_reveal('studio', pg_temp.org()::text, 'business_details');
  perform pg_temp.res('15 reveal: HQ Admin opens the business details form with real values (edit form)',
    r -> 'account' ->> 'pan' = 'ABCDE1234F' and r -> 'account' ->> 'primary_contact_phone' = '+919876543210' and not (r -> 'account' ? 'org_id'), coalesce(r::text, ''));
  perform pg_temp.as_user('r57sup@helm.events', 'aal2');
  r := public.hq_reveal('person', pg_temp.uid('a_admin@a.test')::text, 'email');
  e := pg_temp.try('select public.hq_reveal(''enquiry'', ''e5700000-0000-4000-8000-000000000001'', ''phone'')');
  perform pg_temp.res('16 reveal: Support gets a person''s e-mail and an enquiry phone',
    r ->> 'value' = 'a_admin@a.test' and e = ''
    and (public.hq_reveal('enquiry', 'e5700000-0000-4000-8000-000000000001', 'phone') ->> 'value') = '+919988776655'
    and (public.hq_reveal('request', 'e5700000-0000-4000-8000-000000000002', 'reply_email') ->> 'value') = 'requester@studio-a.test'
    and (public.hq_reveal('suggestion', 'e5700000-0000-4000-8000-000000000003', 'email') ->> 'value') = 'suggester@home.test', coalesce(r::text, '') || e);
  perform pg_temp.as_user('r57sales@helm.events', 'aal2');
  r := public.hq_reveal('member', pg_temp.uid('a_staff@a.test')::text, 'email');
  e := pg_temp.try('select public.hq_reveal(''secrets'', ''x'', ''email'')') || '|' || pg_temp.try(format('select public.hq_reveal(''studio'', %L, ''password'')', pg_temp.org()));
  perform pg_temp.res('17 reveal: Sales gets one member e-mail; unknown kinds / fields refused (22023)', r ->> 'value' = 'a_staff@a.test' and e like '22023%|22023%', coalesce(r::text, '') || e);
  perform pg_temp.res('18 hq_log_reveal (CSV export record) still works', pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')') = '');
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) partner codes: billing.write + fresh code (G-HQ-2) -------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.as_user('r57sales@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try('select public.hq_partner_code_upsert(''{"name":"Sales Promo","offer_type":"months","offer_months":3,"max_uses":100000}''::jsonb)')
    || '|' || pg_temp.try('select public.hq_partner_code_set_active(''NOPE1'', true)')
    || '|' || pg_temp.try(format('select public.hq_referral_attach(%L, ''NOPE1'', null)', pg_temp.org()));
  perform pg_temp.res('19 partner codes: Sales can no longer create / switch / attach (HQ_ROLE)', e like '42501%HQ_ROLE%|42501%HQ_ROLE%|42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r57sup@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try('select public.hq_partner_code_set_active(''NOPE1'', true)') || '|' || pg_temp.try('select public.hq_partner_codes()');
  perform pg_temp.res('20 partner codes: Support refused to switch, still reads the list', e like '42501%HQ_ROLE%|', e);
  perform pg_temp.as_user('r57adm@helm.events', 'aal2', pg_temp.stale());
  e := pg_temp.try('select public.hq_partner_code_set_active(''NOPE1'', true)');
  perform pg_temp.res('21 partner codes: Admin with a two-step code from 1 h ago asked for a fresh one (HQ_REAUTH)', e like '42501%HQ_REAUTH%', e);
  perform pg_temp.as_user('r57adm@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try('select public.hq_partner_code_set_active(''NOPE1'', true)');
  perform pg_temp.res('22 partner codes: Admin with a fresh code passes the gate (then "unknown partner code")', e like '22023%unknown partner code%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) hq_mfa_reset (G-HQ-3) ----------------------------------------------------------------------------------------
do $$ declare e1 text; e2 text; r jsonb; begin
  perform pg_temp.as_user('r57view@helm.events', 'aal2', pg_temp.fresh());
  e1 := pg_temp.try('select public.hq_mfa_reset(''nobody-at-all@nowhere.test'', ''checked on a call today'')');
  e2 := pg_temp.try('select public.hq_mfa_reset(''a_admin@a.test'', ''checked on a call today'')');
  perform pg_temp.res('23 mfa reset: Viewer gets the SAME refusal for an unknown and a real e-mail (no account oracle)',
    e1 like '42501%HQ_ROLE%' and e2 like '42501%HQ_ROLE%' and e1 = e2, e1 || ' / ' || e2);
  perform pg_temp.as_user('r57sec@helm.events', 'aal2', pg_temp.stale());
  e1 := pg_temp.try('select public.hq_mfa_reset(''nobody-at-all@nowhere.test'', ''checked on a call today'')');
  perform pg_temp.res('24 mfa reset: Security with a stale code is asked for a fresh one before any lookup', e1 like '42501%HQ_REAUTH%', e1);
  perform pg_temp.as_user('r57sec@helm.events', 'aal2', pg_temp.fresh());
  e1 := pg_temp.try('select public.hq_mfa_reset(''admin@helm.events'', ''checked on a call today'')')
     || '|' || pg_temp.try('select public.hq_mfa_reset(''r57adm@helm.events'', ''checked on a call today'')');
  perform pg_temp.res('25 mfa reset: Security cannot reset the HQ Owner''s or another HQ member''s two-step', e1 like '42501%Only the Helm HQ Owner%|42501%Only the Helm HQ Owner%', e1);
  r := public.hq_mfa_reset('a_admin@a.test', 'checked on a call today');
  perform pg_temp.res('26 mfa reset: Security still handles a studio user (no factor here: "nothing to reset")', (r ->> 'ok')::boolean and (r ->> 'factors_reset')::int = 0, coalesce(r::text, ''));
  perform pg_temp.as_user('admin@helm.events', 'aal2', pg_temp.fresh());
  r := public.hq_mfa_reset('r57sec@helm.events', 'checked on a call today');
  perform pg_temp.res('27 mfa reset: the HQ Owner may handle an HQ member', (r ->> 'ok')::boolean, coalesce(r::text, ''));
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) studio credits (G-HQ-6) ---------------------------------------------------------------------------------------
do $$ declare e text; i int; begin
  perform pg_temp.as_user('r57adm@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''fourteen chars'')', pg_temp.org()));
  perform pg_temp.res('28 credits: a 14-character reason is refused (22023)', e like '22023%', e);
  for i in 1..5 loop
    e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, %L)', pg_temp.org(), 'Launch promo for studio #' || i));
    exit when e <> '';
  end loop;
  perform pg_temp.res('29 credits: 5 grants in a day with a proper reason work', e = '', e);
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''Launch promo for studio #6'')', pg_temp.org()));
  perform pg_temp.res('30 credits: the 6th grant by the same person in 24 hours is refused', e like 'P0001%5 credits%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''goodwill'', 1, ''Owner goodwill month for outage'')', pg_temp.org()));
  perform pg_temp.res('31 credits: another HQ person still can (the cap is per person)', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) referral codes (G-HQ-4) ---------------------------------------------------------------------------------------
do $$ declare r1 jsonb; r2 jsonb; r3 jsonb; i int; begin
  perform pg_temp.su();
  update public.referral_settings set program_on = true where id;
  insert into public.referral_codes(code, kind, partner_name, active) values ('R57LIVE', 'partner', 'Live Partner', true), ('R57OFF', 'partner', 'Old Partner', false)
  on conflict (code) do update set active = excluded.active;
  delete from public.referral_rate_buckets;   -- test-only reset of counters (rolled back)
  perform pg_temp.as_anon('{"cf-connecting-ip":"198.51.100.20"}');
  r1 := public.referral_click('NOSUCHCODE1'); r2 := public.referral_click('R57LIVE');
  perform pg_temp.res('32 click: unknown and real codes get the same answer', r1 = r2 and r1 = '{"ok": true}'::jsonb, r1::text || r2::text);
  r1 := public.referral_lookup('NOSUCHCODE2'); r2 := public.referral_lookup('R57OFF'); r3 := public.referral_lookup('R57LIVE');
  perform pg_temp.res('33 lookup: unknown and switched-off codes answer the same "unknown"; a live code still works',
    r1 = r2 and r1 ->> 'reason' = 'unknown' and (r3 ->> 'ok')::boolean, r1::text || r2::text || r3::text);
  for i in 1..25 loop r1 := public.referral_lookup('GUESS' || i); end loop;
  r3 := public.referral_lookup('R57LIVE');
  perform pg_temp.res('34 lookup: after 20 misses in an hour this network gets "rate" for EVERY code (no hits learnt)', r1 ->> 'reason' = 'rate' and r3 ->> 'reason' = 'rate', r1::text || r3::text);
  perform pg_temp.as_anon('{"cf-connecting-ip":"198.51.100.21"}');
  r3 := public.referral_lookup('R57LIVE');
  perform pg_temp.res('35 lookup: another network is not affected', (r3 ->> 'ok')::boolean, r3::text);
  perform pg_temp.as_anon('{"x-forwarded-for":"1.2.3.4, 198.51.100.22"}');
  for i in 1..25 loop r1 := public.referral_lookup('FAKE' || i); end loop;
  perform pg_temp.as_anon('{"x-forwarded-for":"5.6.7.8, 198.51.100.22"}');
  r3 := public.referral_lookup('R57LIVE');
  perform pg_temp.res('36 lookup: a new fake first x-forwarded-for entry does not buy a fresh limit', r3 ->> 'reason' = 'rate', r3::text);
  perform pg_temp.su();
  update public.referral_settings set program_on = false where id;
  delete from public.referral_rate_buckets;
  perform pg_temp.as_anon('{"cf-connecting-ip":"198.51.100.23"}');
  r1 := public.referral_lookup('NOSUCHCODE3'); r2 := public.referral_lookup('R57LIVE');
  perform pg_temp.res('37 lookup: program off - the same "off" for known and unknown codes', r1 = r2 and r1 ->> 'reason' = 'off', r1::text || r2::text);
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) trusted caller address + public form caps (G-HQ-5, BS-02, E-02) -------------------------------------------------
do $$ declare a text; b text; r jsonb; begin
  perform pg_temp.su();
  perform set_config('request.headers', '{"x-forwarded-for":"1.1.1.1, 203.0.113.50"}', false); a := public._r24s_ip_hash();
  perform set_config('request.headers', '{"x-forwarded-for":"9.9.9.9, 203.0.113.50"}', false); b := public._r24s_ip_hash();
  perform pg_temp.res('38 address: a caller-typed first x-forwarded-for entry is ignored (same network hash)', a = b and a is not null);
  perform set_config('request.headers', '{"cf-connecting-ip":"198.51.100.9","x-forwarded-for":"1.1.1.1, 198.51.100.9"}', false);
  perform pg_temp.res('39 address: Cloudflare''s cf-connecting-ip first', public._r57_trusted_ip() = '198.51.100.9' and public._r31_client_ip() = '198.51.100.9');
  perform set_config('request.headers', '{"cf-connecting-ip":"not-an-ip","x-forwarded-for":"7.7.7.7, 203.0.113.60, 10.1.2.3"}', false);
  perform pg_temp.res('40 address: a non-IP value is ignored; internal hops are skipped from the right', public._r57_trusted_ip() = '203.0.113.60', coalesce(public._r57_trusted_ip(), 'null'));
  perform set_config('request.headers', '{"x-forwarded-for":"junk"}', false);
  perform pg_temp.res('41 address: junk only = no readable address', public._r57_trusted_ip() is null);
  perform set_config('request.headers', '{"cf-connecting-ip":"2001:db8:aa:bb:1:2:3:4"}', false); a := public._r29_net();
  perform set_config('request.headers', '{"cf-connecting-ip":"2001:db8:aa:bb:ffff:2:3:9"}', false);
  perform pg_temp.res('42 address: IPv6 counted per /64 network', a = public._r29_net() and a = '2001:db8:aa:bb::/64', a);
  perform set_config('request.headers', '', false);
  insert into public.auth_rate_hits(bucket, key, window_start, n)
    values ('sales.ipday', encode(pg_catalog.sha256(convert_to('helm-sales:203.0.113.70', 'UTF8')), 'hex'), now(), 20)
  on conflict (bucket, key) do update set n = 20, window_start = now();
  perform pg_temp.as_anon('{"x-forwarded-for":"4.4.4.4, 203.0.113.70"}');
  r := public.submit_sales_enquiry('{"name":"Bot"}'::jsonb);
  perform pg_temp.res('43 Contact sales: one network over its daily cap is refused (rotating the first hop does not help)', r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su();
  insert into public.auth_rate_hits(bucket, key, window_start, n) values ('sugg.noip', 'noip', now(), 10)
  on conflict (bucket, key) do update set n = 10, window_start = now();
  perform pg_temp.as_anon('');
  r := public.submit_suggestion('{"message":"hello there"}'::jsonb);
  perform pg_temp.res('44 Suggestions: callers without a readable address share one small bucket', r ->> 'reason' = 'rate', r::text);
  perform pg_temp.as_anon('{"cf-connecting-ip":"198.51.100.80"}');
  r := public.submit_suggestion('{"message":"A real suggestion from a visitor"}'::jsonb);
  perform pg_temp.res('45 Suggestions: a normal visitor still gets through', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  r := public.submit_suggestion('{"message":"Signed-in suggestion text"}'::jsonb);
  perform pg_temp.res('46 Suggestions: a signed-in member is not affected by the visitor caps', (r ->> 'ok')::boolean, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) sign-up staff check (A-1) -------------------------------------------------------------------------------------
do $$ declare a boolean; b boolean; c boolean; i int; begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by, role) values ('r57listed@helm.events', 'test', 'viewer') on conflict do nothing;
  perform pg_temp.as_anon('{"cf-connecting-ip":"198.51.100.90"}');
  a := public.signup_email_preauthorised('r57listed@helm.events'); b := public.signup_email_preauthorised('r57-not-listed-xyz@helm.events');
  c := public.signup_email_preauthorised('someone@gmail.com');
  perform pg_temp.res('47 sign-up check: a listed and an unlisted helm.events address get the SAME answer; other domains false', a = b and a and not c, a::text || b::text || c::text);
  for i in 1..30 loop a := public.signup_email_preauthorised('x' || i || '@helm.events'); end loop;
  perform pg_temp.res('48 sign-up check: over 30 asks in 10 minutes from one network the answer is false for everyone', not a);
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) member_profile_list (A-3) ---------------------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.as_user('r57crew@a.test', 'aal1');
  r := public.member_profile_list();
  perform pg_temp.res('49 team list as crew: names + roles only (no e-mail, e-mail name, phone, skills); deactivated hidden',
    not exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' <> pg_temp.uid('r57crew@a.test')::text
                  and exists (select 1 from jsonb_object_keys(x) k where k not in ('user_id', 'full_name', 'role')))
    and not exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' = pg_temp.uid('r57gone@a.test')::text)
    and exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' = pg_temp.uid('a_admin@a.test')::text and x ->> 'role' = 'admin'),
    left(r::text, 400));
  perform pg_temp.res('50 team list as crew: their own row is complete', exists (select 1 from jsonb_array_elements(r) x
    where x ->> 'user_id' = pg_temp.uid('r57crew@a.test')::text and x ->> 'email' = 'r57crew@a.test'));
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  r := public.member_profile_list();
  perform pg_temp.res('51 team list as sales: no e-mail names for colleagues, deactivated hidden, profiles still there',
    not exists (select 1 from jsonb_array_elements(r) x where x ? 'email_name' and x ->> 'user_id' <> pg_temp.uid('a_staff@a.test')::text)
    and not exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' = pg_temp.uid('r57gone@a.test')::text)
    and exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' = pg_temp.uid('r57crew@a.test')::text and x ? 'job_title'),
    left(r::text, 400));
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  r := public.member_profile_list();
  perform pg_temp.res('52 team list as admin: unchanged - the deactivated member is listed (to reactivate) with e-mails',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'user_id' = pg_temp.uid('r57gone@a.test')::text and x ->> 'email' = 'r57gone@a.test'), left(r::text, 300));
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 10) invitations: no token / mail_key_hash for the browser (A-5, I-04) ---------------------------------------------
do $$ declare e text; v_id uuid; n int; begin
  perform pg_temp.su();
  insert into public.invitations(org_id, email, role, token, status, invited_by, expires_at)
    values (pg_temp.org(), 'r57invitee@x.test', 'sales', md5('r57a') || left(md5('r57b'), 16), 'pending', pg_temp.uid('a_admin@a.test'), now() + interval '7 days')
  returning id into v_id;
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  select count(*) into n from public.invitations i where i.id = v_id and i.email = 'r57invitee@x.test' and i.status = 'pending';
  e := pg_temp.try('select token from public.invitations limit 1') || '|' || pg_temp.try('select mail_key_hash from public.invitations limit 1')
    || '|' || pg_temp.try('select * from public.invitations limit 1');
  perform pg_temp.res('53 invitations: the admin lists pending invites (explicit columns); token / mail_key_hash / select * refused',
    n = 1 and e like '42501%|42501%|42501%', n || ' ' || e);
  e := pg_temp.try(format('update public.invitations set status = ''revoked'' where id = %L', v_id));
  perform pg_temp.su();
  perform pg_temp.res('54 invitations: Revoke still works (update by id)', e = '' and exists (select 1 from public.invitations where id = v_id and status = 'revoked'), e);
exception when others then perform pg_temp.su(); insert into _rs values ('10x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 11) grants -------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('55 the kept *__pre0298 bodies and the _r57_* helpers are not callable by anon / signed-in',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and (p.proname like '%\_\_pre0298' or p.proname like '\_r57\_%')
                   and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')))
    and (select count(*) from pg_proc p where p.proname like '%\_\_pre0298') = 20);
  perform pg_temp.res('56 public entry points keep their callers (anon forms / look-ups; HQ + team signed-in only)',
    has_function_privilege('anon', 'public.submit_sales_enquiry(jsonb)', 'execute') and has_function_privilege('anon', 'public.referral_lookup(text)', 'execute')
    and has_function_privilege('anon', 'public.signup_email_preauthorised(text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studios(text,text,integer,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_studio_detail(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.member_profile_list()', 'execute')
    and not has_function_privilege('anon', 'public.member_profile_list()', 'execute'));
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R57-HQ-AUTH-0298: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R57-HQ-AUTH-0298: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
