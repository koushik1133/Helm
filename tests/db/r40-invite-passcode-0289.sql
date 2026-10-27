-- r40-invite-passcode-0289.sql -- 0289: the OPTIONAL invitation passcode. Off = every public door answers exactly as before;
-- on = public_event_site / info / rsvp / reveal / the photo read check refuse without a valid server-signed proof; wrong
-- tries are rate-limited per network (cf-connecting-ip, 'noip' bucket) and per site; only a bcrypt hash is stored; a new
-- passcode invalidates older proofs; "Make new link" keeps the setting; works with "hide the address until RSVP".
-- Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites may re-apply 0260 / 0284 bodies or reset grants: re-apply 0289 twice (re-run safe)
\ir ../../supabase/migrations/0289_invite_passcode.sql
\ir ../../supabase/migrations/0289_invite_passcode.sql
create temp table _r40(name text, result text); grant all on _r40 to anon, authenticated, service_role;
create temp table _r40kv(k text primary key, v text); grant all on _r40kv to anon, authenticated, service_role;

create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r40 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _r40kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _r40kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_as((select id from auth.users where email = p_email)); end $$;
-- a guest (anon) from one network, optionally holding a passcode proof (x-helm-invite-pass) and a site link (photos)
create or replace function pg_temp.guest(p_ip text, p_pass text default null, p_slug text default null) returns void language plpgsql as $$
declare h jsonb := '{}'::jsonb;
begin
  perform pg_temp.su();
  if p_ip is not null then h := h || jsonb_build_object('cf-connecting-ip', p_ip, 'x-forwarded-for', '198.51.100.250'); end if;
  if p_pass is not null then h := h || jsonb_build_object('x-helm-invite-pass', p_pass); end if;
  if p_slug is not null then h := h || jsonb_build_object('x-helm-site-slug', p_slug); end if;
  perform set_config('request.headers', h::text, false);
  perform auth.login_anon();
end $$;
create or replace function pg_temp.form(p_name text, p_att text, p_guests text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('name', p_name, 'attending', p_att, 'guests', p_guests) || p_extra;
$$;
grant execute on function pg_temp.form(text, text, text, jsonb) to anon, authenticated, service_role;
-- the site's data as a guest sees it ('' when refused)
create or replace function pg_temp.page(p_slug text) returns text language plpgsql as $$
declare d jsonb;
begin select x.data into d from public.public_event_site(p_slug) x; return coalesce(d::text, '');
exception when others then return 'ERR ' || sqlerrm; end $$;
grant execute on function pg_temp.page(text) to anon, authenticated, service_role;

-- ---- 0) set-up: studio A (wedding, address + map + phone + one photo), studio B (birthday) ------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  s public.event_sites; v_photo text; begin
  perform pg_temp.login('a_admin@a.test');
  s := public.create_event_site(qa, 'wedding', 'gala');
  v_photo := 'a0000000-0000-4000-8000-000000000001/' || qa::text || '/0123456789abcdef0123456789abcdef.jpg';
  perform pg_temp.put('PHOTO', v_photo);
  update public.event_sites set title = 'Ayla and Sam', data = jsonb_build_object('names', 'Ayla and Sam', 'date', '2099-06-01',
    'time', '7 PM', 'venue', 'The Grand Palm', 'address', '12 Lake Road, Hyderabad', 'mapUrl', 'https://maps.example/x',
    'host', 'Rao family', 'hostPhone', '+91 98765 43210', 'rsvpForm', true,
    'schedule', jsonb_build_array(jsonb_build_object('time', '7 PM', 'label', 'Sangeet')),
    'photos', jsonb_build_array('https://x.supabase.co/storage/v1/object/public/invite-media/' || v_photo)) where id = s.id;
  perform pg_temp.put('SA', s.id::text);
  s := public.publish_event_site(s.id, true); perform pg_temp.put('SLUG_A', s.slug);
  perform pg_temp.login('b_admin@b.test');
  s := public.create_event_site(qb, 'birthday', 'jubilee');
  update public.event_sites set title = 'Maya', data = jsonb_build_object('names', 'Maya', 'rsvpForm', true, 'venue', 'Party Hall') where id = s.id;
  s := public.publish_event_site(s.id, true); perform pg_temp.put('SB', s.id::text); perform pg_temp.put('SLUG_B', s.slug);
  perform pg_temp.su();
  perform pg_temp.put('LIVE', public.event_site_live_until(pg_temp.get('SA')::uuid)::text);
  perform pg_temp.put('TPL', (select template from public.event_sites where id = pg_temp.get('SA')::uuid));
end $$;

-- ---- 1) structure + grants ---------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 new table: RLS on, no anon / signed-in privilege, read-only guard',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.event_site_passcodes'::regclass)
    and not has_table_privilege('anon', 'public.event_site_passcodes', 'select')
    and not has_table_privilege('authenticated', 'public.event_site_passcodes', 'select')
    and not has_table_privilege('authenticated', 'public.event_site_passcodes', 'insert')
    and not has_table_privilege('authenticated', 'public.event_site_passcodes', 'update')
    and (to_regprocedure('public.tg_studio_read_only()') is null
         or exists (select 1 from pg_trigger where tgrelid = 'public.event_site_passcodes'::regclass and tgname = 'zzz_studio_read_only')));
  perform pg_temp.res('02 guests: the same doors + unlock; the inner bodies, helpers and studio RPCs are not for guests',
    has_function_privilege('anon', 'public.public_event_site(text)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_info(text)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_rsvp(text, jsonb)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_reveal(text, text)', 'execute')
    and has_function_privilege('anon', 'public.public_invite_unlock(text, text)', 'execute')
    and not has_function_privilege('anon', 'public.public_event_site__pre0289(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.public_event_site__pre0289(text)', 'execute')
    and not has_function_privilege('anon', 'public.public_invite_info__pre0289(text)', 'execute')
    and not has_function_privilege('anon', 'public.public_invite_rsvp__pre0289(text, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.public_invite_reveal__pre0289(text, text)', 'execute')
    and not has_function_privilege('anon', 'public._r40_pass_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r40_full(text, text, integer, integer)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_set_passcode(uuid, boolean, text)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_passcode_state(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.event_site_set_passcode(uuid, boolean, text)', 'execute')
    and has_function_privilege('authenticated', 'public.event_site_passcode_state(uuid)', 'execute'));
  perform pg_temp.res('03 trial clean-up (0184) also empties the new table',
    to_regprocedure('public._tr184_purge_tables()') is null
    or (public._tr184_purge_tables() @> array['event_site_passcodes']
        and (select count(*) from unnest(public._tr184_purge_tables()) x where x = 'event_sites') = 1));
  perform pg_temp.res('04 the photo read checks carry the passcode condition',
    position('r40-passcode-0289' in pg_get_functiondef('public.invite_media_guest_read_ok(text)'::regprocedure)) > 0
    and position('r40-passcode-0289' in pg_get_functiondef('public.invite_media_on_published_site(text)'::regprocedure)) > 0);
end $$;

-- ---- 2) passcode OFF (the default): every door answers exactly as before ---------------------------------------------------------
do $$ declare a text; b text; r jsonb; begin
  perform pg_temp.guest('203.0.113.7', null, pg_temp.get('SLUG_A'));
  a := pg_temp.page(pg_temp.get('SLUG_A'));
  perform pg_temp.su();
  select x.data::text into b from public.public_event_site__pre0289(pg_temp.get('SLUG_A')) x;
  perform pg_temp.res('05 off: the invitation is the same as the inner (pre-0289) answer, with address, phone, photo', a = b
    and position('Lake Road' in a) > 0 and position('98765' in a) > 0 and position('invite-media' in a) > 0, a);
  perform pg_temp.guest('203.0.113.7', null, pg_temp.get('SLUG_A'));
  r := public.public_invite_info(pg_temp.get('SLUG_A'));
  perform pg_temp.res('06 off: link state unchanged (live + studio name)', r = '{"state": "live", "studio": "Studio A"}'::jsonb, r::text);
  perform pg_temp.res('07 off: the photo can be read by a guest holding the link', public.invite_media_guest_read_ok(pg_temp.get('PHOTO')));
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Early guest', 'yes', '2'));
  perform pg_temp.res('08 off: replies work as before', (r ->> 'ok')::boolean and r ->> 'token' ~ '^[0-9a-f]{64}$', r::text);
  perform pg_temp.put('TOK0', r ->> 'token');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'anything');
  perform pg_temp.res('09 off: unlock says no passcode is needed (no token)', (r ->> 'ok')::boolean and (r ->> 'open')::boolean and not (r ? 'token'), r::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_passcode_state(pg_temp.get('SA')::uuid);
  perform pg_temp.res('10 off: studio state = off, nothing set', r = '{"on": false, "set": false}'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('11 off: no passcode row exists for any site', not exists (select 1 from public.event_site_passcodes));
end $$;

-- ---- 3) the studio switches it on: validation, permissions, hash only ------------------------------------------------------------
do $$ declare e text; r jsonb; k public.event_site_passcodes; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, %L)', pg_temp.get('SA'), 'abc'));
  perform pg_temp.res('12 too short (3) refused', e like '22023%', e);
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, %L)', pg_temp.get('SA'), repeat('x', 21)));
  perform pg_temp.res('13 too long (21) refused', e like '22023%', e);
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, null)', pg_temp.get('SA')));
  perform pg_temp.res('14 on without a passcode (none saved yet) refused', e like '22023%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, %L)', pg_temp.get('SA'), 'Rose 2026'));
  perform pg_temp.res('15 another studio cannot set it', e like 'P0002%', e);
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('coordinator', 'quotes', true, false, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  update public.profiles set role = 'coordinator' where email = 'a_staff@a.test';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, %L)', pg_temp.get('SA'), 'Rose 2026'));
  perform pg_temp.res('16 a view-only role cannot set it (but may see the state)', e like '42501%'
    and pg_temp.try(format('select public.event_site_passcode_state(%L::uuid)', pg_temp.get('SA'))) = '', e);
  perform pg_temp.guest('203.0.113.8');
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, true, %L)', pg_temp.get('SA'), 'Rose 2026'));
  perform pg_temp.res('17 a guest cannot set it', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_set_passcode(pg_temp.get('SA')::uuid, true, '  Rose 2026  ');
  perform pg_temp.res('18 set: state on (the answer never carries the passcode)', (r ->> 'on')::boolean and (r ->> 'set')::boolean
    and position('rose' in lower(r::text)) = 0, r::text);
  perform pg_temp.su();
  select * into k from public.event_site_passcodes where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.put('SECRET1', k.secret);
  perform pg_temp.res('19 stored: a bcrypt hash only - never the passcode in any form; random 64-hex secret',
    k.pass_hash like '$2%' and k.pass_hash = extensions.crypt('rose 2026', k.pass_hash) and k.secret ~ '^[0-9a-f]{64}$'
    and position('rose' in lower(row_to_json(k)::text)) = 0 and position('rose' in lower(k.pass_hash)) = 0
    and k.org_id = 'a0000000-0000-4000-8000-000000000001', row_to_json(k)::text);
  perform pg_temp.res('20 audit row written, without the passcode',
    exists (select 1 from public.audit_log a where a.action = 'event_site.passcode' and a.entity_id = pg_temp.get('SA')
              and position('rose' in lower(a.changed::text)) = 0 and (a.changed ->> 'new_passcode')::boolean));
end $$;

-- ---- 4) passcode ON, no proof: every public door refuses ----------------------------------------------------------------------------
do $$ declare a text; r jsonb; n bigint; begin
  perform pg_temp.put('NRSVP', (select count(*) from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid)::text);
  perform pg_temp.guest('203.0.113.20', null, pg_temp.get('SLUG_A'));
  a := pg_temp.page(pg_temp.get('SLUG_A'));
  perform pg_temp.res('21 on: public_event_site refuses ("needs a passcode") - no name, date, venue, address, schedule, photo, phone',
    a = 'ERR This invitation needs a passcode' and position('Ayla' in a) = 0, a);
  r := public.public_invite_info(pg_temp.get('SLUG_A'));
  perform pg_temp.res('22 on: link state = live + locked + the theme only (no studio name)',
    r = jsonb_build_object('state', 'live', 'locked', true, 'template', pg_temp.get('TPL')), r::text);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Gatecrasher', 'yes', '2'));
  perform pg_temp.res('23 on: RSVP refused with a generic answer', r = '{"ok": false, "reason": "passcode", "message": "Please enter the passcode first."}'::jsonb, r::text);
  r := public.public_invite_reveal(pg_temp.get('SLUG_A'), pg_temp.get('TOK0'));
  perform pg_temp.res('24 on: reveal refused even with a real guest token', r = '{"ok": false, "reason": "passcode"}'::jsonb, r::text);
  perform pg_temp.res('25 on: the photo cannot be read (both storage checks)',
    not public.invite_media_guest_read_ok(pg_temp.get('PHOTO')) and not public.invite_media_on_published_site(pg_temp.get('PHOTO')));
  perform pg_temp.guest('203.0.113.20', 'p1.4102444800.' || repeat('a', 64), pg_temp.get('SLUG_A'));
  perform pg_temp.res('26 on: a made-up proof is refused everywhere',
    pg_temp.page(pg_temp.get('SLUG_A')) like 'ERR%' and (public.public_invite_info(pg_temp.get('SLUG_A')) ->> 'locked')::boolean
    and not public.invite_media_guest_read_ok(pg_temp.get('PHOTO')));
  perform pg_temp.su();
  select count(*) into n from public.event_site_rsvps where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('27 on: nothing was stored by the refused RSVP', n::text = pg_temp.get('NRSVP'), n::text);
  -- the other studio's site (passcode off) is untouched
  perform pg_temp.guest('203.0.113.20');
  perform pg_temp.res('28 a site without a passcode still opens', position('Maya' in pg_temp.page(pg_temp.get('SLUG_B'))) > 0);
  perform pg_temp.su();
end $$;

-- ---- 5) unlocking: wrong / right passcode, the proof opens every door -----------------------------------------------------------------
do $$ declare r jsonb; a text; v_tok text; begin
  perform pg_temp.guest('203.0.113.21');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'tulip 2026');
  perform pg_temp.res('29 wrong passcode: generic answer, no token',
    r = jsonb_build_object('ok', false, 'reason', 'wrong', 'message', 'That passcode didn''t work. Please check it and try again.'), r::text);
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), '');
  perform pg_temp.res('30 empty passcode: the same generic answer', r ->> 'reason' = 'wrong', r::text);
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), ' ROSE 2026 ');
  v_tok := r ->> 'token';
  perform pg_temp.res('31 right passcode (capitals + spaces at the ends do not matter): a signed proof until the live window ends (max 400 days)',
    (r ->> 'ok')::boolean and v_tok ~ '^p1\.[0-9]{9,11}\.[0-9a-f]{64}$'
    and abs(extract(epoch from (r ->> 'expires_at')::timestamptz) - extract(epoch from least(coalesce(pg_temp.get('LIVE')::timestamptz, now() + interval '30 days'), now() + interval '400 days'))) <= 1, r::text);
  perform pg_temp.put('PASS1', v_tok);
  perform pg_temp.guest('203.0.113.22', v_tok, pg_temp.get('SLUG_A'));
  a := pg_temp.page(pg_temp.get('SLUG_A'));
  perform pg_temp.res('32 with the proof: the full invitation (names, venue, address, schedule, photo, phone)',
    position('Ayla and Sam' in a) > 0 and position('Lake Road' in a) > 0 and position('Sangeet' in a) > 0
    and position('invite-media' in a) > 0 and position('98765' in a) > 0, a);
  r := public.public_invite_info(pg_temp.get('SLUG_A'));
  perform pg_temp.res('33 with the proof: the link state as before', r = '{"state": "live", "studio": "Studio A"}'::jsonb, r::text);
  perform pg_temp.res('34 with the proof: the photo can be read', public.invite_media_guest_read_ok(pg_temp.get('PHOTO')));
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Invited guest', 'yes', '2'));
  perform pg_temp.res('35 with the proof: RSVP accepted', (r ->> 'ok')::boolean, r::text);
  r := public.public_invite_reveal(pg_temp.get('SLUG_A'), pg_temp.get('TOK0'));
  perform pg_temp.res('36 with the proof: reveal works', (r ->> 'ok')::boolean and r #>> '{reply,name}' = 'Early guest', r::text);
  -- a proof is bound to its site: A's proof does not open B once B has its own passcode
  perform pg_temp.login('b_admin@b.test');
  perform public.event_site_set_passcode(pg_temp.get('SB')::uuid, true, 'party time');
  perform pg_temp.guest('203.0.113.22', v_tok);
  perform pg_temp.res('37 a proof for one invitation does not open another', pg_temp.page(pg_temp.get('SLUG_B')) like 'ERR%needs a passcode%');
  -- a tampered proof (expiry moved) and an expired proof (correctly signed with the site's secret) are refused
  perform pg_temp.guest('203.0.113.22', 'p1.' || (split_part(v_tok, '.', 2)::bigint + 86400)::text || '.' || split_part(v_tok, '.', 3));
  perform pg_temp.res('38 a tampered proof (longer expiry) is refused', pg_temp.page(pg_temp.get('SLUG_A')) like 'ERR%');
  perform pg_temp.guest('203.0.113.22', 'p1.' || (extract(epoch from now())::bigint - 60)::text || '.'
    || encode(extensions.hmac(pg_temp.get('SA') || '.' || (extract(epoch from now())::bigint - 60)::text, pg_temp.get('SECRET1'), 'sha256'), 'hex'));
  perform pg_temp.res('39 an expired proof is refused (even when correctly signed)', pg_temp.page(pg_temp.get('SLUG_A')) like 'ERR%');
  perform pg_temp.su();
end $$;

-- ---- 6) wrong tries are rate-limited: per network, no-IP bucket, per site ------------------------------------------------------------
do $$ declare r jsonb; i int; v_wrong int := 0; begin
  perform pg_temp.guest('203.0.113.30');
  for i in 1..10 loop
    r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'guess ' || i);
    if r ->> 'reason' = 'wrong' then v_wrong := v_wrong + 1; end if;
  end loop;
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026');
  perform pg_temp.res('40 per network: 10 wrong tries, then even the right passcode is refused (generic "too many tries")',
    v_wrong = 10 and r = jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many tries. Please wait a few minutes and try again.'),
    v_wrong || ' ' || r::text);
  -- same x-forwarded-for, another cf-connecting-ip = another network
  perform pg_temp.guest('203.0.113.31');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026');
  perform pg_temp.res('41 another network is not blocked (cf-connecting-ip wins)', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('42 the counter is keyed by the hashed network, never the address in clear',
    exists (select 1 from public.auth_rate_hits h where h.bucket = 'inv_pass.ip'
             and h.key = encode(sha256(convert_to('helm-invite:203.0.113.30', 'UTF8')), 'hex') and h.n = 10)
    and not exists (select 1 from public.auth_rate_hits h where h.key like '%203.0.113%'));
  -- right tries do not count against the network
  perform pg_temp.guest('203.0.113.32'); v_wrong := 0;
  for i in 1..12 loop r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026'); if (r ->> 'ok')::boolean then v_wrong := v_wrong + 1; end if; end loop;
  perform pg_temp.res('43 right passcodes are not counted as wrong tries', v_wrong = 12, v_wrong::text);
  -- no readable network: one shared 'noip' bucket (never unlimited)
  perform pg_temp.guest(null); v_wrong := 0;
  for i in 1..10 loop r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'noip ' || i); if r ->> 'reason' = 'wrong' then v_wrong := v_wrong + 1; end if; end loop;
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026');
  perform pg_temp.res('44 no IP header: a shared noip bucket, 10 wrong tries, then refused', v_wrong = 10 and r ->> 'reason' = 'rate', v_wrong || ' ' || r::text);
  -- per site: wrong tries from many networks add up (100 an hour), then the site refuses everyone for a while
  perform pg_temp.su();
  perform pg_temp.res('45 the site counter holds the wrong tries so far (10 + 10 + 2)',
    (select h.n from public.auth_rate_hits h where h.bucket = 'inv_pass.site' and h.key = pg_temp.get('SA')) = 22);
  for i in 40..47 loop
    perform pg_temp.guest('203.0.113.' || i);
    for v_wrong in 1..10 loop perform public.public_invite_unlock(pg_temp.get('SLUG_A'), 'spread ' || v_wrong); end loop;
  end loop;
  perform pg_temp.guest('203.0.113.99');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026');
  perform pg_temp.res('46 per site: 100 wrong tries an hour from any networks, then refused', r ->> 'reason' = 'rate', r::text);
  r := public.public_invite_unlock(pg_temp.get('SLUG_B'), 'party time');
  perform pg_temp.res('47 another invitation is not affected by that cap', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  delete from public.auth_rate_hits where bucket like 'inv_pass.%';   -- test-only reset (rolled back)
end $$;

-- ---- 7) changing the passcode invalidates every older proof; off keeps the row --------------------------------------------------------
do $$ declare r jsonb; v_tok2 text; k public.event_site_passcodes; begin
  perform pg_temp.login('a_admin@a.test');
  perform public.event_site_set_passcode(pg_temp.get('SA')::uuid, true, 'Lily 2026');
  perform pg_temp.su();
  select * into k from public.event_site_passcodes where site_id = pg_temp.get('SA')::uuid;
  perform pg_temp.res('48 a new passcode: a new hash, a NEW secret, version 2',
    k.secret <> pg_temp.get('SECRET1') and k.version = 2 and k.pass_hash = extensions.crypt('lily 2026', k.pass_hash), row_to_json(k)::text);
  perform pg_temp.guest('203.0.113.60', pg_temp.get('PASS1'), pg_temp.get('SLUG_A'));
  perform pg_temp.res('49 the old device proof stops working everywhere',
    pg_temp.page(pg_temp.get('SLUG_A')) like 'ERR%' and not public.invite_media_guest_read_ok(pg_temp.get('PHOTO'))
    and public.public_invite_rsvp(pg_temp.get('SLUG_A'), pg_temp.form('Old device', 'yes', '1')) ->> 'reason' = 'passcode');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'rose 2026');
  perform pg_temp.res('50 the old passcode no longer works', r ->> 'reason' = 'wrong', r::text);
  r := public.public_invite_unlock(pg_temp.get('SLUG_A'), 'lily 2026');
  v_tok2 := r ->> 'token'; perform pg_temp.put('PASS2', v_tok2);
  perform pg_temp.guest('203.0.113.60', v_tok2);
  perform pg_temp.res('51 the new passcode opens it', position('Ayla' in pg_temp.page(pg_temp.get('SLUG_A'))) > 0);
  -- off: open to everyone again; the row is kept (never deleted)
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_set_passcode(pg_temp.get('SA')::uuid, false);
  perform pg_temp.guest('203.0.113.61');
  perform pg_temp.res('52 switched off: open without a proof, as before', position('Ayla' in pg_temp.page(pg_temp.get('SLUG_A'))) > 0
    and public.public_invite_info(pg_temp.get('SLUG_A')) = '{"state": "live", "studio": "Studio A"}'::jsonb and r = jsonb_build_object('on', false, 'set', true, 'changed_at', r -> 'changed_at'), r::text);
  perform pg_temp.su();
  perform pg_temp.res('53 off keeps the row (hash + secret), nothing deleted',
    (select count(*) from public.event_site_passcodes where site_id = pg_temp.get('SA')::uuid and not enabled and secret = k.secret) = 1);
  -- back on without typing: the saved passcode (and the proofs made with it) work again
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_set_passcode(pg_temp.get('SA')::uuid, true, null);
  perform pg_temp.guest('203.0.113.62');
  perform pg_temp.res('54 back on with the saved passcode: locked again', (r ->> 'on')::boolean and pg_temp.page(pg_temp.get('SLUG_A')) like 'ERR%');
  perform pg_temp.guest('203.0.113.62', v_tok2);
  perform pg_temp.res('55 ... and the device that unlocked with it stays in', position('Ayla' in pg_temp.page(pg_temp.get('SLUG_A'))) > 0);
  perform pg_temp.su();
end $$;

-- ---- 8) "Make new link" keeps the passcode setting (and the device proofs - the site is the same) ----------------------------------------
do $$ declare s public.event_sites; begin
  perform pg_temp.login('a_admin@a.test');
  s := public.event_site_new_link(pg_temp.get('SA')::uuid);
  perform pg_temp.put('SLUG_A2', s.slug);
  perform pg_temp.guest('203.0.113.63');
  perform pg_temp.res('56 new link: still locked', s.slug <> pg_temp.get('SLUG_A') and pg_temp.page(s.slug) like 'ERR%needs a passcode%'
    and (public.public_invite_info(s.slug) ->> 'locked')::boolean);
  perform pg_temp.res('57 the old link says "moved" (no passcode asked, nothing shown)', public.public_invite_info(pg_temp.get('SLUG_A')) = '{"state": "moved"}'::jsonb);
  perform pg_temp.guest('203.0.113.63', pg_temp.get('PASS2'));
  perform pg_temp.res('58 a device that unlocked before opens the new link', position('Ayla' in pg_temp.page(s.slug)) > 0);
  perform pg_temp.su();
end $$;

-- ---- 9) passcode + "hide the address until the guest replies" work together ------------------------------------------------------------
do $$ declare r jsonb; a text; begin
  perform pg_temp.login('a_admin@a.test');
  update public.event_sites set data = data || '{"addressMode": "after_rsvp", "city": "Hyderabad", "address": "12 Lake Road, Hyderabad", "mapUrl": "https://maps.example/x"}'::jsonb
   where id = pg_temp.get('SA')::uuid;
  perform pg_temp.guest('203.0.113.64', pg_temp.get('PASS2'));
  a := pg_temp.page(pg_temp.get('SLUG_A2'));
  perform pg_temp.res('59 unlocked + address hidden: venue + city only, no street address yet',
    position('Grand Palm' in a) > 0 and position('Hyderabad' in a) > 0 and position('Lake Road' in a) = 0, a);
  r := public.public_invite_rsvp(pg_temp.get('SLUG_A2'), pg_temp.form('Both features', 'yes', '2'));
  perform pg_temp.put('TOK2', r ->> 'token');
  perform pg_temp.res('60 unlocked + replied Yes: the address is handed over', r #>> '{reveal,address}' = '12 Lake Road, Hyderabad', r::text);
  perform pg_temp.guest('203.0.113.64');
  r := public.public_invite_reveal(pg_temp.get('SLUG_A2'), pg_temp.get('TOK2'));
  perform pg_temp.res('61 a guest token alone (no passcode proof) reveals nothing', r = '{"ok": false, "reason": "passcode"}'::jsonb, r::text);
  perform pg_temp.guest('203.0.113.64', pg_temp.get('PASS2'));
  r := public.public_invite_reveal(pg_temp.get('SLUG_A2'), pg_temp.get('TOK2'));
  perform pg_temp.res('62 proof + guest token: the address', r #>> '{reveal,address}' = '12 Lake Road, Hyderabad', r::text);
  perform pg_temp.su();
end $$;

-- ---- 10) an ended invitation says so (no passcode box); a suspended studio cannot change the passcode -------------------------------------
do $$ declare r jsonb; e text; begin
  update public.quotes set archived_at = now() where id = 'a0000000-0000-4000-8000-00000000da01';
  perform pg_temp.guest('203.0.113.65');
  r := public.public_invite_unlock(pg_temp.get('SLUG_A2'), 'lily 2026');
  perform pg_temp.res('63 ended (shelved) invitation: unlock answers "not available", no token', r ->> 'reason' = 'closed' and not (r ? 'token'), r::text);
  perform pg_temp.res('64 ended: the page says ended, not "needs a passcode"', pg_temp.page(pg_temp.get('SLUG_A2')) like 'ERR%ended%', pg_temp.page(pg_temp.get('SLUG_A2')));
  perform pg_temp.su();
  update public.quotes set archived_at = null where id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.studio_subscriptions(org_id, status) values ('b0000000-0000-4000-8000-000000000001', 'suspended')
    on conflict (org_id) do update set status = 'suspended';
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.event_site_set_passcode(%L::uuid, false)', pg_temp.get('SB')));
  perform pg_temp.su();
  perform pg_temp.res('65 suspended studio: the passcode cannot be changed (read-only guard), it stays on',
    e <> '' and (select enabled from public.event_site_passcodes where site_id = pg_temp.get('SB')::uuid), e);
  update public.studio_subscriptions set status = 'active' where org_id = 'b0000000-0000-4000-8000-000000000001';
end $$;

-- ---- 11) re-run safe: a re-run of 0284 / 0260 puts plain bodies back; 0289 re-wraps them ---------------------------------------------------
do $$ begin perform pg_temp.put('N_PASS', (select count(*) from public.event_site_passcodes)::text); end $$;
\ir ../../supabase/migrations/0284_invite_rsvp_privacy.sql
\ir ../../supabase/migrations/0289_invite_passcode.sql
do $$ begin
  perform pg_temp.guest('203.0.113.66');
  perform pg_temp.res('66 re-run (0284 then 0289): still locked, rows unchanged, one inner copy each',
    pg_temp.page(pg_temp.get('SLUG_A2')) like 'ERR%needs a passcode%'
    and public.public_invite_rsvp(pg_temp.get('SLUG_A2'), pg_temp.form('After re-run', 'yes', '1')) ->> 'reason' = 'passcode'
    and (public.public_invite_info(pg_temp.get('SLUG_A2')) ->> 'locked')::boolean);
  perform pg_temp.su();
  perform pg_temp.res('67 re-run: passcode rows unchanged, four wrappers + four inner bodies',
    (select count(*) from public.event_site_passcodes)::text = pg_temp.get('N_PASS')
    and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\_\_pre0289') = 4
    and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
           and p.proname in ('public_event_site', 'public_invite_info', 'public_invite_rsvp', 'public_invite_reveal')
           and position('r40-passcode-0289' in p.prosrc) > 0) = 4
    and (select count(*) from unnest(public._tr184_purge_tables()) x where x = 'event_site_passcodes') = 1);
end $$;

select name, result from _r40 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R40-INVITE-PASSCODE-0289: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R40-INVITE-PASSCODE-0289: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary
  from _r40;
rollback;
