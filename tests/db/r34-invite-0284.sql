-- r34-invite-0284.sql -- 0284: invitation RSVP form (gating, validation, per-network / per-site limits), host phone +
-- address privacy (kept out of the public data, revealed only to a guest who replied), "Make new link" (old links kept
-- and answer "moved"), the widened theme list. Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps (0032 resets anon EXECUTE); re-apply 0284 twice (re-run safe)
\ir ../../supabase/migrations/0284_invite_rsvp_privacy.sql
\ir ../../supabase/migrations/0284_invite_rsvp_privacy.sql
create temp table _r34(name text, result text); grant all on _r34 to anon, authenticated, service_role;
create temp table _r34kv(k text primary key, v text); grant all on _r34kv to anon, authenticated, service_role;

create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r34 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _r34kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _r34kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_as((select id from auth.users where email = p_email)); end $$;
-- a guest (anon) from one network: cf-connecting-ip wins over x-forwarded-for
create or replace function pg_temp.guest(p_ip text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  perform set_config('request.headers', jsonb_build_object('cf-connecting-ip', p_ip, 'x-forwarded-for', '198.51.100.250, 10.0.0.1')::text, false);
  perform auth.login_anon();
end $$;
create or replace function pg_temp.form(p_name text, p_att text, p_guests text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'attending', p_att, 'guests', p_guests) || p_extra;
$$;
grant execute on function pg_temp.form(text, text, text, jsonb) to anon, authenticated, service_role;

-- ---- 0) set-up: one published site in studio A, one in studio B ----------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  s public.event_sites; begin
  perform pg_temp.login('a_admin@a.test');
  s := public.create_event_site(qa, 'wedding', 'eternal');
  update public.event_sites set title = 'Ayla and Sam', data = jsonb_build_object('names', 'Ayla and Sam', 'date', '2099-06-01',
    'venue', 'The Grand Palm', 'address', '12 Lake Road, Hyderabad', 'mapUrl', 'https://maps.example/x', 'host', 'Rao family',
    'hostPhone', '+91 98765 43210') where id = s.id;
  perform pg_temp.put('SA', s.id::text);
  s := public.publish_event_site(s.id, true); perform pg_temp.put('SLUG_A', s.slug);
  perform pg_temp.login('b_admin@b.test');
  s := public.create_event_site(qb, 'birthday', 'confetti');
  update public.event_sites set title = 'Maya', data = jsonb_build_object('names', 'Maya', 'rsvpForm', true) where id = s.id;
  s := public.publish_event_site(s.id, true); perform pg_temp.put('SB', s.id::text); perform pg_temp.put('SLUG_B', s.slug);
  perform pg_temp.su();
end $$;

-- ---- 1) structure + grants ----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 new tables: RLS on, no anon / signed-in privilege',
    (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_site_rsvps'::regclass, 'public.event_site_slug_history'::regclass))
    and not has_table_privilege('anon', 'public.event_site_rsvps', 'select') and not has_table_privilege('authenticated', 'public.event_site_rsvps', 'select')
    and not has_table_privilege('authenticated', 'public.event_site_rsvps', 'insert')
    and not has_table_privilege('anon', 'public.event_site_slug_history', 'select') and not has_table_privilege('authenticated', 'public.event_site_slug_history', 'select'));
  perform pg_temp.res('02 guests may call rsvp / reveal / info; the studio RPCs and helpers are not for guests',
    has_function_privilege('anon', 'public.public_invite_rsvp(text, jsonb)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_reveal(text, text)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_info(text)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_rsvp_list(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_new_link(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_old_links(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.event_site_rsvp_list(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.event_site_new_link(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r34_ip_hash()', 'execute')
    and not has_function_privilege('authenticated', 'public._r34_reveal(public.event_sites, text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r34_text(text, boolean)', 'execute'));
  perform pg_temp.res('03 trial clean-up (0184) also empties the new tables',
    to_regprocedure('public._tr184_purge_tables()') is null
    or (public._tr184_purge_tables() @> array['event_site_rsvps', 'event_site_slug_history']
        and (select count(*) from unnest(public._tr184_purge_tables()) x where x = 'event_sites') = 1));
end $$;

-- ---- 2) themes: the six new keys are accepted, junk is not --------------------------------------------------------------------
do $$ declare e text; k text; ok boolean := true; begin
  perform pg_temp.login('a_admin@a.test');
  foreach k in array array['shubh', 'mehndi', 'solitaire', 'jubilee', 'gala', 'linen', 'eternal', 'soiree'] loop
    e := pg_temp.try(format('update public.event_sites set template = %L where id = %L::uuid', k, pg_temp.get('SA')));
    if e <> '' then ok := false; end if;
  end loop;
  perform pg_temp.res('04 theme check: 6 new + the 5 old templates accepted', ok, e);
  e := pg_temp.try(format('update public.event_sites set template = %L where id = %L::uuid', 'nope', pg_temp.get('SA')));
  perform pg_temp.res('05 theme check: an unknown template is refused', e like '23514%', e);
  update public.event_sites set template = 'eternal' where id = pg_temp.get('SA')::uuid;
  perform pg_temp.su();
end $$;

-- ---- 3) existing behaviour: a site with no new settings is unchanged ----------------------------------------------------------
do $$ declare d jsonb; pd jsonb; r jsonb; begin
  perform pg_temp.guest('203.0.113.7');
  select data into d from public.public_event_site(pg_temp.get('SLUG_A'));
  perform pg_temp.res('06 legacy site: guests still get address, map link and host phone exactly as saved',
    d ->> 'address' = '12 Lake Road, Hyderabad' and d ->> 'mapUrl' = 'https://maps.example/x' and d ->> 'hostPhone' = '+91 98765 43210', d::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Guest', 'yes', '2'));
  perform pg_temp.res('07 legacy site: the RSVP form is off unless the studio switches it on', r ->> 'reason' = 'off', r::text);
  perform pg_temp.su();
  select private_data into pd from public.event_sites where id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('08 legacy site: nothing moved to private_data', pd = '{}'::jsonb, pd::text);
end $$;

-- ---- 4) privacy: phone + address kept out of the public data --------------------------------------------------------------------
do $$ declare d jsonb; s public.event_sites; begin
  perform pg_temp.login('a_admin@a.test');
  update public.event_sites set data = data || '{"rsvpForm": true, "rsvpContact": false, "addressMode": "after_rsvp", "city": "Hyderabad"}'::jsonb
   where id = pg_temp.get('SA')::uuid;
  select * into s from public.event_sites where id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('09 studio still has phone + address (private_data), not in the public data',
    s.private_data ->> 'hostPhone' = '+91 98765 43210' and s.private_data ->> 'address' = '12 Lake Road, Hyderabad'
    and s.private_data ->> 'mapUrl' = 'https://maps.example/x'
    and not (s.data ? 'hostPhone') and not (s.data ? 'address') and not (s.data ? 'mapUrl') and s.data ->> 'venue' = 'The Grand Palm',
    row_to_json(s)::text);
  perform pg_temp.guest('203.0.113.7');
  select data into d from public.public_event_site(pg_temp.get('SLUG_A'));
  perform pg_temp.res('10 guests: venue + city only - no address, map link or phone',
    d ->> 'venue' = 'The Grand Palm' and d ->> 'city' = 'Hyderabad' and not (d ? 'address') and not (d ? 'mapUrl') and not (d ? 'hostPhone')
    and position('98765' in d::text) = 0 and position('Lake Road' in d::text) = 0, d::text);
  perform pg_temp.res('11 the link-state answer never carries private data',
    position('Lake Road' in public.public_invite_info(pg_temp.get('SLUG_A'))::text) = 0
    and public.public_invite_info(pg_temp.get('SLUG_A')) = '{"state": "live", "studio": "Studio A"}'::jsonb,
    public.public_invite_info(pg_temp.get('SLUG_A'))::text);
  -- a studio page that sends the address again while the mode is after_rsvp: moved again, never public
  perform pg_temp.login('a_admin@a.test');
  update public.event_sites set data = data || '{"address": "14 Lake Road, Hyderabad"}'::jsonb where id = pg_temp.get('SA')::uuid;
  select * into s from public.event_sites where id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('12 a re-sent address is moved too (newest value kept privately)',
    not (s.data ? 'address') and s.private_data ->> 'address' = '14 Lake Road, Hyderabad', row_to_json(s)::text);
  perform pg_temp.su();
end $$;

-- ---- 5) the RSVP form: gating + validation --------------------------------------------------------------------------------------
do $$ declare r jsonb; n bigint; begin
  perform pg_temp.guest('203.0.113.8');
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('<b>Bad</b>', 'yes', '2'));
  perform pg_temp.res('13 HTML refused', r ->> 'reason' = 'html', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form(repeat('x', 81), 'yes', '2'));
  perform pg_temp.res('14 name over 80 characters refused', r ->> 'reason' = 'invalid' and r ->> 'field' = 'name', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi', 'yes', '2', jsonb_build_object('message', repeat('m', 501))));
  perform pg_temp.res('15 message over 500 characters refused', r ->> 'field' = 'message', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi', 'perhaps', '2'));
  perform pg_temp.res('16 attending must be yes / no / maybe', r ->> 'field' = 'attending', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi', 'yes', '0'));
  perform pg_temp.res('17 "yes" needs 1-20 guests', r ->> 'field' = 'guests', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi', 'yes', '21'));
  perform pg_temp.res('18 more than 20 guests refused', r ->> 'field' = 'guests', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('', 'yes', '2'));
  perform pg_temp.res('19 empty name refused', r ->> 'field' = 'name', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Bot', 'yes', '2', '{"website": "http://spam"}'::jsonb));
  perform pg_temp.su(); select count(*) into n from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('20 honeypot: answered ok, nothing stored', (r ->> 'ok')::boolean and n = 0, r::text || ' rows=' || n);
  perform pg_temp.guest('203.0.113.8');
  r := public.public_invite_rsvp('no-such-slug-0000000000000000', pg_temp.form('Ravi', 'yes', '2'));
  perform pg_temp.res('21 unknown link refused', r ->> 'reason' = 'not_found', r::text);
  perform pg_temp.su();
end $$;

-- ---- 6) a good reply: token, reveal, change of reply ------------------------------------------------------------------------------
do $$ declare r jsonb; r2 jsonb; row public.event_site_rsvps; n bigint; begin
  perform pg_temp.guest('203.0.113.9');
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form(E'  Ravi \t Kumar \u0007 ', 'yes', '3', jsonb_build_object('message', E'See you\nthere!')));
  perform pg_temp.put('TOK', r ->> 'token');
  perform pg_temp.res('22 reply saved: random 64-hex guest token + the private address handed back',
    (r ->> 'ok')::boolean and r ->> 'token' ~ '^[0-9a-f]{64}$' and r #>> '{reveal,address}' = '14 Lake Road, Hyderabad'
    and r #>> '{reveal,mapUrl}' = 'https://maps.example/x' and not (r ? 'hostPhone') and position('98765' in r::text) = 0, r::text);
  perform pg_temp.su();
  select * into row from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('23 stored cleaned (control characters / spaces), only the sha256 of the token, network hashed from cf-connecting-ip',
    row.guest_name = 'Ravi Kumar' and row.party_size = 3 and row.attending = 'yes' and row.message = E'See you\nthere!'
    and row.token_hash = encode(sha256(convert_to(pg_temp.get('TOK'), 'UTF8')), 'hex') and row.token_hash <> pg_temp.get('TOK')
    and row.ip_hash = encode(sha256(convert_to('helm-invite:203.0.113.9', 'UTF8')), 'hex')
    and row.org_id = 'a0000000-0000-4000-8000-000000000001', row_to_json(row)::text);
  perform pg_temp.guest('203.0.113.10');
  r := public.public_invite_reveal(pg_temp.get('SLUG_A'), pg_temp.get('TOK'));
  perform pg_temp.res('24 reveal on the same device: address + the guest''s own reply',
    (r ->> 'ok')::boolean and r #>> '{reveal,address}' = '14 Lake Road, Hyderabad' and r #>> '{reply,name}' = 'Ravi Kumar'
    and (r #>> '{reply,guests}')::int = 3, r::text);
  r := public.public_invite_reveal(pg_temp.get('SLUG_A'), repeat('a', 64));
  r2 := public.public_invite_reveal(pg_temp.get('SLUG_B'), pg_temp.get('TOK'));
  perform pg_temp.res('25 reveal refused: unknown token / a token from another invitation / not a token',
    not (r ->> 'ok')::boolean and not (r2 ->> 'ok')::boolean and r2::text not like '%Lake%'
    and not (public.public_invite_reveal(pg_temp.get('SLUG_A'), 'x') ->> 'ok')::boolean, r::text || r2::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi K', 'no', '5', jsonb_build_object('token', pg_temp.get('TOK'))));
  perform pg_temp.su();
  select count(*) into n from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid;
  select * into row from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('26 change of reply with the token: same row, "no" = 0 guests, edits counted',
    (r ->> 'updated')::boolean and r ->> 'token' = pg_temp.get('TOK') and n = 1 and row.attending = 'no' and row.party_size = 0
    and row.guest_name = 'Ravi K' and row.edits = 1, r::text || ' ' || row_to_json(row)::text);
  perform pg_temp.res('26b a "No" reply gets no address back (R34-02)', not (r ? 'reveal') and position('Lake Road' in r::text) = 0, r::text);
  perform pg_temp.guest('203.0.113.11');
  r := public.public_invite_reveal(pg_temp.get('SLUG_A'), pg_temp.get('TOK'));
  perform pg_temp.res('26c reveal for a device whose reply is "No": the reply, never the address',
    (r ->> 'ok')::boolean and r #>> '{reply,attending}' = 'no' and not (r ? 'reveal') and position('Lake Road' in r::text) = 0, r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('No-first guest', 'no', '0'));
  perform pg_temp.res('26d a first reply of "No" gets no address', (r ->> 'ok')::boolean and not (r ? 'reveal'), r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('No-first guest', 'maybe', '2', jsonb_build_object('token', r ->> 'token')));
  perform pg_temp.res('26e changing that reply to "Maybe" reveals the address', r #>> '{reveal,address}' = '14 Lake Road, Hyderabad', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Ravi K', 'yes', '2', jsonb_build_object('token', pg_temp.get('TOK'))));
  perform pg_temp.res('26f back to "Yes": the address again', r #>> '{reveal,address}' = '14 Lake Road, Hyderabad', r::text);
  perform pg_temp.su();
end $$;

-- ---- 7) rate limits: per network (cf-connecting-ip) and per site per day ------------------------------------------------------------
do $$ declare r jsonb; i int; v_ok int := 0; begin
  perform pg_temp.guest('203.0.113.50');
  for i in 1..5 loop   -- typos are refused BEFORE the network limit: they use up nothing (R34-03)
    r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('', 'maybe', '1'));
  end loop;
  for i in 1..30 loop
    r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Guest ' || i, 'maybe', '1'));
    if (r ->> 'ok')::boolean then v_ok := v_ok + 1; end if;
  end loop;
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Guest 31', 'maybe', '1'));
  perform pg_temp.res('27 per network: 30 replies an hour (invalid tries not counted), the 31st refused', v_ok = 30 and r ->> 'reason' = 'rate', v_ok || ' ' || r::text);
  -- no readable network: one shared low bucket (never skipped) (R34-01)
  perform pg_temp.su(); perform auth.login_anon(); v_ok := 0;
  for i in 1..20 loop
    r := public.public_invite_rsvp(pg_temp.get('SLUG_B'), pg_temp.form('No-IP guest ' || i, 'yes', '1'));
    if (r ->> 'ok')::boolean then v_ok := v_ok + 1; end if;
  end loop;
  r := public.public_invite_rsvp(pg_temp.get('SLUG_B'), pg_temp.form('No-IP guest 21', 'yes', '1'));
  perform pg_temp.res('27b no IP header: a shared noip bucket, 20 an hour, then refused', v_ok = 20 and r ->> 'reason' = 'rate', v_ok || ' ' || r::text);
  perform pg_temp.su();
  perform pg_temp.res('27c no IP: rows stored without a network hash', exists (select 1 from public.event_site_rsvps where guest_name = 'No-IP guest 1' and ip_hash is null));
  -- same x-forwarded-for, different cf-connecting-ip = a different network (Cloudflare's header wins)
  perform pg_temp.guest('203.0.113.51');
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Other network', 'yes', '1'));
  perform pg_temp.res('28 another network is not blocked (cf-connecting-ip, not x-forwarded-for)', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  update public.auth_rate_hits set n = 400 where bucket = 'inv_rsvp.site' and key = pg_temp.get('SA');
  perform pg_temp.guest('203.0.113.52');
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Late guest', 'yes', '1'));
  perform pg_temp.res('29 per site: 400 replies a day, then refused', r ->> 'reason' = 'full', r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_B'), pg_temp.form('Maya friend', 'yes', '1'));
  perform pg_temp.res('30 another site is not affected by that cap', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
end $$;

-- ---- 8) the studio dashboard ---------------------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_rsvp_list(pg_temp.get('SA')::uuid);
  perform pg_temp.res('31 studio list: counts + rows (no token / network)',
    (r ->> 'replies')::int = 33 and (r ->> 'yes')::int = 2 and (r ->> 'maybe')::int = 31 and (r ->> 'no')::int = 0
    and (r ->> 'guests_yes')::int = 3 and jsonb_array_length(r -> 'rows') = 33
    and position('token' in r::text) = 0 and position('ip_hash' in r::text) = 0, left(r::text, 300));
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.event_site_rsvp_list(%L::uuid)', pg_temp.get('SA')));
  perform pg_temp.res('32 another studio cannot read the replies', e like 'P0002%', e);
  e := pg_temp.try(format('select public.event_site_new_link(%L::uuid)', pg_temp.get('SA')));
  perform pg_temp.res('33 another studio cannot change the link', e like 'P0002%', e);
  perform pg_temp.su();
  -- a role with Quotes VIEW only (no edit): may read the replies, may not make a new link
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('coordinator', 'quotes', true, false, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  update public.profiles set role = 'coordinator' where email = 'a_staff@a.test';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.event_site_rsvp_list(%L::uuid)', pg_temp.get('SA')));
  perform pg_temp.res('34 view-only role reads the replies', e = '', e);
  e := pg_temp.try(format('select public.event_site_new_link(%L::uuid)', pg_temp.get('SA')));
  perform pg_temp.res('35 view-only role cannot make a new link', e like '42501%', e);
  perform pg_temp.guest('203.0.113.60');
  e := pg_temp.try(format('select public.event_site_rsvp_list(%L::uuid)', pg_temp.get('SA')));
  perform pg_temp.res('36 a guest cannot read the replies', e like '42501%', e);
  e := pg_temp.try('select count(*) from public.event_site_rsvps');
  perform pg_temp.res('37 a guest cannot read the table', e like '42501%', e);
  perform pg_temp.su();
end $$;

-- ---- 9) Make new link: the old one says "moved", never deleted -------------------------------------------------------------------------
do $$ declare s public.event_sites; r jsonb; e text; n bigint; d jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  s := public.create_event_site('a0000000-0000-4000-8000-00000000da01', 'wedding', 'eternal');   -- idempotent: the same site
  s := public.event_site_new_link(pg_temp.get('SA')::uuid);
  perform pg_temp.put('SLUG_A2', s.slug);
  perform pg_temp.res('38 new link: a different random <name>-<16 hex> link, still published',
    s.slug <> pg_temp.get('SLUG_A') and s.slug ~ '^ayla-and-sam-[0-9a-f]{16}$' and s.status = 'published', s.slug);
  perform pg_temp.su();
  perform pg_temp.res('39 old link kept in the history (reason new_link), audit row written',
    exists (select 1 from public.event_site_slug_history h where h.slug = pg_temp.get('SLUG_A') and h.site_id = pg_temp.get('SA')::uuid and h.reason = 'new_link')
    and exists (select 1 from public.audit_log a where a.action = 'event_site.new_link' and a.entity_id = pg_temp.get('SA')));
  perform pg_temp.guest('203.0.113.61');
  perform pg_temp.res('40 guests: old link = "moved" and no invitation; new link works',
    public.public_invite_info(pg_temp.get('SLUG_A')) = '{"state": "moved"}'::jsonb
    and not exists (select 1 from public.public_event_site(pg_temp.get('SLUG_A')))
    and exists (select 1 from public.public_event_site(pg_temp.get('SLUG_A2')))
    and public.public_invite_info(pg_temp.get('SLUG_A2')) ->> 'state' = 'live',
    public.public_invite_info(pg_temp.get('SLUG_A'))::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Old link guest', 'yes', '1'));
  perform pg_temp.res('41 RSVP on the old link refused', r ->> 'reason' = 'not_found', r::text);
  r := public.public_invite_reveal(pg_temp.get('SLUG_A2'), pg_temp.get('TOK'));
  perform pg_temp.res('42 a guest who replied before keeps the reveal on the new link', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.login('a_admin@a.test');
  s := public.publish_event_site(pg_temp.get('SA')::uuid, true);
  perform pg_temp.res('43 publishing again keeps the new link', s.slug = pg_temp.get('SLUG_A2'), s.slug);
  update public.event_sites set title = 'Ayla and Samir' where id = pg_temp.get('SA')::uuid;
  s := public.publish_event_site(pg_temp.get('SA')::uuid, true);
  perform pg_temp.su();
  perform pg_temp.res('44 a name change + publish: the replaced link is kept too (reason renamed)',
    s.slug like 'ayla-and-samir-%' and exists (select 1 from public.event_site_slug_history h where h.slug = pg_temp.get('SLUG_A2') and h.reason = 'renamed'),
    s.slug);
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_old_links(pg_temp.get('SA')::uuid);
  perform pg_temp.res('45 studio sees both old links', jsonb_array_length(r) = 2, r::text);
  perform public.publish_event_site(pg_temp.get('SA')::uuid, false);
  perform pg_temp.guest('203.0.113.62');
  perform pg_temp.res('46 turned off: guests see "off", the earlier links still "moved"',
    public.public_invite_info(s.slug) = '{"state": "off"}'::jsonb and public.public_invite_info(pg_temp.get('SLUG_A')) ->> 'state' = 'moved'
    and public.public_invite_info('draft-0000000000000000') ->> 'state' = 'none');
  perform pg_temp.su();
  select count(*) into n from public.event_site_slug_history where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('47 history only grows (2 rows), the site row is still there',
    n = 2 and exists (select 1 from public.event_sites where id = pg_temp.get('SA')::uuid));
  -- a draft that was never published has no link to replace
  perform pg_temp.login('b_admin@b.test');
  perform public.publish_event_site(pg_temp.get('SB')::uuid, false);
  perform pg_temp.su();
end $$;

-- ---- 10) switching privacy off moves everything back; ended invitations refuse replies -----------------------------------------------------
do $$ declare s public.event_sites; r jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  perform public.publish_event_site(pg_temp.get('SA')::uuid, true);
  update public.event_sites set data = data || '{"rsvpContact": true, "addressMode": "full"}'::jsonb where id = pg_temp.get('SA')::uuid;
  select * into s from public.event_sites where id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('48 privacy switched off: phone + address back in the data, nothing lost',
    s.data ->> 'hostPhone' = '+91 98765 43210' and s.data ->> 'address' = '14 Lake Road, Hyderabad'
    and s.data ->> 'mapUrl' = 'https://maps.example/x' and s.private_data = '{}'::jsonb, row_to_json(s)::text);
  perform pg_temp.su();
  update public.quotes set archived_at = now() where id = 'a0000000-0000-4000-8000-00000000da01';
  perform pg_temp.guest('203.0.113.63');
  r := public.public_invite_rsvp(s.slug, pg_temp.form('After the end', 'yes', '1'));
  perform pg_temp.res('49 an ended (shelved) invitation refuses replies', r ->> 'reason' = 'closed', r::text);
  r := public.public_invite_reveal(s.slug, pg_temp.get('TOK'));
  perform pg_temp.res('50 ... and reveals nothing', not (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
end $$;

-- ---- 10b) a suspended studio is read-only: a guest gets a calm "closed" answer, nothing stored ---------------------------
do $$ declare r jsonb; n bigint; begin
  perform pg_temp.su();
  update public.quotes set archived_at = null where id = 'b0000000-0000-4000-8000-00000000da01';
  perform pg_temp.login('b_admin@b.test'); perform public.publish_event_site(pg_temp.get('SB')::uuid, true); perform pg_temp.su();
  perform pg_temp.put('NB', (select count(*) from public.event_site_rsvps where site_id = pg_temp.get('SB')::uuid)::text);
  -- the test makes its own subscription row (does not rely on another suite) (R34-04)
  insert into public.studio_subscriptions(org_id, status) values ('b0000000-0000-4000-8000-000000000001', 'suspended')
    on conflict (org_id) do update set status = 'suspended';
  perform pg_temp.guest('203.0.113.70');
  r := public.public_invite_rsvp(pg_temp.get('SLUG_B'), pg_temp.form('Guest of a paused studio', 'yes', '1'));
  perform pg_temp.su();
  select count(*) into n from public.event_site_rsvps where site_id = pg_temp.get('SB')::uuid;
  perform pg_temp.res('52 suspended studio: reply refused calmly (read-only guard), nothing stored',
    r ->> 'reason' = 'closed' and n::text = pg_temp.get('NB')
    and exists (select 1 from pg_trigger where tgrelid = 'public.event_site_rsvps'::regclass and tgname = 'zzz_studio_read_only')
    and exists (select 1 from pg_trigger where tgrelid = 'public.event_site_slug_history'::regclass and tgname = 'zzz_studio_read_only'), r::text);
  update public.studio_subscriptions set status = 'active' where org_id = 'b0000000-0000-4000-8000-000000000001';
end $$;

-- ---- 11) re-run safe -----------------------------------------------------------------------------------------------------------------
do $$ begin perform pg_temp.put('N_RSVP', (select count(*) from public.event_site_rsvps)::text);
  perform pg_temp.put('N_HIST', (select count(*) from public.event_site_slug_history)::text); end $$;
\ir ../../supabase/migrations/0284_invite_rsvp_privacy.sql
do $$ begin
  perform pg_temp.res('51 re-run: no reply / history row added or removed, template check unchanged',
    (select count(*) from public.event_site_rsvps)::text = pg_temp.get('N_RSVP')
    and (select count(*) from public.event_site_slug_history)::text = pg_temp.get('N_HIST')
    and (select count(*) from pg_constraint where conname = 'event_sites_template_chk') = 1
    and (select count(*) from unnest(public._tr184_purge_tables()) x where x = 'event_site_rsvps') = 1);
end $$;

select name, result from _r34 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R34-INVITE-0284: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R34-INVITE-0284: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary
  from _r34;
rollback;
