-- start-blank-0220.sql -- 0220: "New quote" never hands back (and so never renames) a draft that has
-- anything in it (title, event type, client value, pricing, layout objects, a 2nd version, booklet link,
-- quotation version, plan row, approval link ...); a really blank one is still reused; start_blank_quote never
-- changes an existing quote. Booklet: floor plan + 3D view turn on once the layout has objects (link made on an
-- empty layout, nobody switched sections on the live link); booklet_set_sections changes the live link in place.
-- Fixture: a_admin / a_staff studio A, b_admin studio B. Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _sb(name text, result text); grant all on _sb to anon, authenticated, service_role;
create temp table _skv(k text primary key, v text); grant all on _skv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _sb values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _skv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _skv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
-- a fresh blank quote for a_admin (the previous one is made non-blank by the caller first)
create or replace function pg_temp.blank(p_code text) returns uuid language plpgsql as $$
declare q public.quotes; begin perform pg_temp.login('a_admin@a.test'); q := public.start_blank_quote(p_code, null); perform pg_temp.su(); return q.id; end $$;

-- fixture: a no-quotes-edit member in studio A; earlier blank quotes parked (inside this rolled-back transaction)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'sb_viewer@a.test'), auth.seed_user('sb_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'sb_viewer@a.test', 'Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'quotes', true, false, a, now());
  update public.quotes set archived_at = now() where archived_at is null and deleted_at is null;
  delete from public.auth_rate_hits where bucket like 'booklet.%';
end $$;

-- ---- L1: shape + grants ---------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 start_blank_quote carries the 0220 marker, security definer, search_path empty',
    (select p.prosecdef and 'search_path=""' = any(p.proconfig) and p.prosrc like '%start-blank-0220%' and p.prosrc like '%_blank_quote_touched_reason%'
       and p.prosrc like '%pg_advisory_xact_lock%helm:blankq:%'
       from pg_proc p where p.oid = 'public.start_blank_quote(text,text)'::regprocedure));
  perform pg_temp.res('02 start_blank_quote: anon no, authenticated yes; the helper is private',
    not has_function_privilege('anon', 'public.start_blank_quote(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.start_blank_quote(text,text)', 'execute')
    and not has_function_privilege('anon', 'public._blank_quote_touched_reason(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._blank_quote_touched_reason(uuid,uuid)', 'execute'));
  perform pg_temp.res('03 one start_blank_quote only (same signature, no new overload)',
    (select count(*) = 1 from pg_proc where proname = 'start_blank_quote' and pronamespace = 'public'::regnamespace));
end $$;

-- ---- L1: a really blank quote is still reused; anything in it makes a new one ----------------------
do $$ declare q0 uuid; q1 uuid; q2 uuid; n0 int; n1 int; t text; c text; u timestamptz; e text; r public.quotes; begin
  perform pg_temp.su(); select count(*) into n0 from public.quotes;
  q0 := pg_temp.blank('X-1'); q1 := pg_temp.blank('X-2');
  select count(*) into n1 from public.quotes;
  perform pg_temp.res('04 a blank quote is reused (one row for two clicks)', q0 = q1 and n1 = n0 + 1, n0||'->'||n1);
  -- the app re-titles a fresh quote with its real code: still blank
  update public.quotes set title = code where id = q0;
  q1 := pg_temp.blank('X-3');
  perform pg_temp.res('05 title = its own code is still blank -> reused', q1 = q0);
  -- just opening the flow (quote_flow_progress) is not "touched"
  insert into public.quote_flow_progress(quote_id, user_id, org_id, last_step, last_step_at)
    values (q0, (select id from auth.users where email = 'a_admin@a.test'), 'a0000000-0000-4000-8000-000000000001', 'client', now());
  q1 := pg_temp.blank('X-4');
  perform pg_temp.res('06 a flow-progress marker alone keeps it blank -> reused', q1 = q0);

  -- THE BUG: a titled draft ("Sharma") is never handed back, and it is not changed
  update public.quotes set title = 'Sharma' where id = q0;
  select title, code, updated_at into t, c, u from public.quotes where id = q0;
  q1 := pg_temp.blank('X-5');
  perform pg_temp.res('07 a draft with a title is NOT reused (new id, new code)', q1 <> q0 and (select code from public.quotes where id = q1) <> c, q1::text);
  perform pg_temp.res('08 ...and the titled draft is unchanged (title, code, updated_at, not shelved)',
    (select title = 'Sharma' and code = c and updated_at = u and deleted_at is null and archived_at is null from public.quotes where id = q0));
  perform pg_temp.put('sharma', q0::text);

  -- event type only
  update public.quotes set event_type = 'Wedding' where id = q1;
  q2 := pg_temp.blank('X-6');
  perform pg_temp.res('09 a draft with an event type is NOT reused', q2 <> q1);
  -- a client phone only (name still empty)
  update public.quotes set client = jsonb_build_object('phone', '+919800000001') where id = q2;
  q1 := pg_temp.blank('X-7');
  perform pg_temp.res('10 a draft with only a client phone is NOT reused', q1 <> q2);
  -- guests / venue in pricing
  update public.quotes set pricing = jsonb_build_object('guests', 400) where id = q1;
  q2 := pg_temp.blank('X-8');
  perform pg_temp.res('11 a draft with a guest count is NOT reused', q2 <> q1);
  -- a layout version 2 with objects (current_version moves to 2)
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by)
    values (q2, 2, '{"items":[{"id":"o1","type":"stage"}]}', 1, (select id from auth.users where email = 'a_admin@a.test'));
  update public.quotes set current_version = 2 where id = q2;
  q1 := pg_temp.blank('X-9');
  perform pg_temp.res('12 a draft with a saved layout (V2, objects) is NOT reused', q1 <> q2);
  -- a second, EMPTY version (current still 1)
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by)
    values (q1, 2, '{"items":[]}', 0, (select id from auth.users where email = 'a_admin@a.test'));
  q2 := pg_temp.blank('X-10');
  perform pg_temp.res('13 a draft with any 2nd layout version is NOT reused', q2 <> q1);
  -- V1 holding hall size / venue data (no items)
  update public.quote_versions set data = '{"items":[],"venue":{"room":{"w":115,"h":72}}}' where quote_id = q2 and version_no = 1;
  q1 := pg_temp.blank('X-11');
  perform pg_temp.res('14 a draft whose V1 holds layout data (hall size) is NOT reused', q1 <> q2);
  -- a booklet link
  insert into public.client_booklets(quote_id, org_id, created_by) values (q1, 'a0000000-0000-4000-8000-000000000001', null);
  q2 := pg_temp.blank('X-12');
  perform pg_temp.res('15 a draft with a booklet link is NOT reused', q2 <> q1);
  -- a quotation version
  insert into public.quotation_versions(quote_id, label, pricing, total, org_id) values (q2, 'Q1', '{"total":5000}', 5000, 'a0000000-0000-4000-8000-000000000001');
  q1 := pg_temp.blank('X-13');
  perform pg_temp.res('16 a draft with a quotation version is NOT reused', q1 <> q2);
  -- an event plan (menu / venue) row
  insert into public.event_plan(quote_id, venue_name, org_id) values (q1, 'Lotus Hall', 'a0000000-0000-4000-8000-000000000001');
  q2 := pg_temp.blank('X-14');
  perform pg_temp.res('17 a draft with a plan / menu row is NOT reused', q2 <> q1);
  -- an approval link
  update public.quotes set approval_token = gen_random_uuid() where id = q2;
  q1 := pg_temp.blank('X-15');
  perform pg_temp.res('18 a draft with an approval link is NOT reused', q1 <> q2);
  -- a title the person typed, then changed back to the creation title, still counts as touched
  update public.quotes set title = 'Mehta' where id = q1;
  update public.quotes set title = 'X-15' where id = q1;
  q2 := pg_temp.blank('X-16');
  perform pg_temp.res('19 a draft whose title was ever edited is NOT reused', q2 <> q1);
  -- the newest blank one is reused again
  q1 := pg_temp.blank('X-17');
  perform pg_temp.res('20 ...and the fresh blank one is reused next time', q1 = q2);

  -- another person never gets my blank quote; the other studio gets its own
  perform pg_temp.login('a_staff@a.test');
  r := public.start_blank_quote('X-18', null);
  perform pg_temp.res('21 another person never receives my blank quote', r.id <> q2);
  perform pg_temp.login('b_admin@b.test');
  r := public.start_blank_quote('X-19', null);
  perform pg_temp.res('22 the other studio gets a quote in its own studio', r.org_id = 'b0000000-0000-4000-8000-000000000001' and r.id <> q2);
  -- gates
  perform pg_temp.login('sb_viewer@a.test');
  e := pg_temp.try($q$select public.start_blank_quote('X-20', null)$q$);
  perform pg_temp.res('23 member without quotes edit refused (42501)', e like '42501%', e);
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.start_blank_quote('X-21', null)$q$);
  perform pg_temp.res('24 signed out refused', e <> '', e);
  perform pg_temp.su();
  perform pg_temp.res('25 no quote was deleted or shelved along the way',
    (select count(*) from public.quotes where deleted_at is not null and created_at > now() - interval '1 hour') = 0
    and (select title from public.quotes where id = pg_temp.get('sharma')::uuid) = 'Sharma');
exception when others then perform pg_temp.su(); insert into _sb values ('2x start_blank_quote setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- L11: booklet floor plan / 3D view on once the layout has objects --------------------------------
do $$
declare a uuid := 'a0000000-0000-4000-8000-000000000001'; adm uuid; q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid;
  r jsonb; s jsonb; e text; tok uuid; b1 uuid; t0 timestamptz := now() - interval '2 hours';
begin
  perform pg_temp.su();
  select id into adm from auth.users where email = 'a_admin@a.test';
  perform pg_temp.res('30 functions: security definer + search_path empty; RPCs authenticated only; helpers private',
    (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p
      where p.oid in ('public.booklet_layout_auto_on(uuid)'::regprocedure, 'public.booklet_set_sections(uuid,jsonb)'::regprocedure,
                      'public._bk220_layout_auto_on(uuid,integer)'::regprocedure, 'public._bk220_tg_layout_auto_on()'::regprocedure))
    and has_function_privilege('authenticated', 'public.booklet_layout_auto_on(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.booklet_set_sections(uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_layout_auto_on(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_set_sections(uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._bk220_layout_auto_on(uuid,integer)', 'execute')
    and not has_function_privilege('anon', 'public._bk220_layout_auto_on(uuid,integer)', 'execute'));
  perform pg_temp.res('31 trigger zzzz_bk220_layout_auto_on on quote_versions (after insert)',
    exists (select 1 from pg_trigger where tgname = 'zzzz_bk220_layout_auto_on' and tgrelid = 'public.quote_versions'::regclass));

  -- five quotes, each with an empty V1 made 2 hours ago
  foreach q1 in array array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()] loop
    insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at)
      values (q1, 'BK-' || left(q1::text, 6), 'Booklet ' || left(q1::text, 4), 'quote', '{}', '{}', 1, 'none', a, t0);
    insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, created_at) values (q1, 1, '{"items":[]}', 0, adm, t0);
    perform pg_temp.put('bq' || (select count(*) from _skv where k like 'bq%')::text, q1::text);
  end loop;
  q1 := pg_temp.get('bq0')::uuid; q2 := pg_temp.get('bq1')::uuid; q3 := pg_temp.get('bq2')::uuid; q4 := pg_temp.get('bq3')::uuid; q5 := pg_temp.get('bq4')::uuid;
  -- links made on the EMPTY layout with the pictures skipped (layout2d / layout3d off), 1 hour ago
  insert into public.client_booklets(quote_id, org_id, created_at, expires_at, sections)
    select x, a, now() - interval '1 hour', now() + interval '20 days',
           public._bk_sections_all() || '{"layout2d": false, "layout3d": false}'::jsonb
      from unnest(array[q1, q2, q4, q5]) x;
  -- q3: layout already had objects when its link was made, and the planner switched the plan off
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, created_at) values (q3, 2, '{"items":[{"id":"a"}]}', 1, adm, t0 + interval '1 minute');
  update public.quotes set current_version = 2 where id = q3;
  insert into public.client_booklets(quote_id, org_id, created_at, expires_at, sections)
    values (q3, a, now() - interval '1 hour', now() + interval '20 days', public._bk_sections_all() || '{"layout2d": false, "layout3d": false}'::jsonb);
  -- q2: someone switched sections on the live link
  update public.client_booklets set sections_set_at = now() - interval '30 minutes' where quote_id = q2;
  -- q4: only the 3D view is off
  update public.client_booklets set sections = public._bk_sections_all() || '{"layout3d": false}'::jsonb where quote_id = q4;

  -- a layout with objects is saved for q1..q4 (V2, current)
  perform pg_temp.login('a_admin@a.test');
  foreach q1 in array array[pg_temp.get('bq0')::uuid, q2, q4] loop
    perform public.add_quote_version(q1, null, '{"items":[{"id":"s1","type":"stage"},{"id":"c1","type":"chair"}]}'::jsonb, 2);
  end loop;
  perform public.add_quote_version(q3, null, '{"items":[{"id":"s1","type":"stage"},{"id":"c1","type":"chair"}]}'::jsonb, 2);
  perform pg_temp.su();
  q1 := pg_temp.get('bq0')::uuid;
  select sections into s from public.client_booklets where quote_id = q1 and revoked_at is null;
  perform pg_temp.res('32 link made on an empty layout: floor plan + 3D view turn ON when a layout with objects is saved',
    s ->> 'layout2d' = 'true' and s ->> 'layout3d' = 'true' and s ->> 'menu' = 'true' and s ->> 'quotation' = 'true', s::text);
  select sections into s from public.client_booklets where quote_id = q2 and revoked_at is null;
  perform pg_temp.res('33 sections switched on the live link by a person: left OFF', s ->> 'layout2d' = 'false' and s ->> 'layout3d' = 'false', s::text);
  select sections into s from public.client_booklets where quote_id = q3 and revoked_at is null;
  perform pg_temp.res('34 plan switched off while the layout already had objects: left OFF', s ->> 'layout2d' = 'false' and s ->> 'layout3d' = 'false', s::text);
  select sections into s from public.client_booklets where quote_id = q4 and revoked_at is null;
  perform pg_temp.res('35 only one of the two off (a choice, not the empty-layout skip): left as it is', s ->> 'layout2d' = 'true' and s ->> 'layout3d' = 'false', s::text);
  perform pg_temp.res('36 the layout saves themselves went through (V2 current on each)',
    (select count(*) from public.quotes where id in (q1, q2, q3, q4) and current_version >= 2) = 4);

  -- q5: a legacy link whose layout was saved BEFORE 0220 (trigger not there yet) -> the Share window fixes it
  set local session_replication_role = replica;
  insert into public.quote_versions(quote_id, version_no, data, object_count, created_by, org_id) values (q5, 2, '{"items":[{"id":"a"},{"id":"b"}]}', 2, adm, a);
  update public.quotes set current_version = 2 where id = q5;
  set local session_replication_role = origin;
  select sections into s from public.client_booklets where quote_id = q5 and revoked_at is null;
  perform pg_temp.res('37 (setup) legacy link still has the plan off', s ->> 'layout2d' = 'false', s::text);
  perform pg_temp.login('sb_viewer@a.test');
  e := pg_temp.try(format('select public.booklet_layout_auto_on(%L)', q5));
  perform pg_temp.res('38 booklet_layout_auto_on: quotes-view-only member refused (42501)', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_layout_auto_on(%L)', q5));
  perform pg_temp.res('39 booklet_layout_auto_on: other studio refused (P0002)', e like 'P0002%', e);
  perform pg_temp.login('a_staff@a.test');
  select token into tok from public.client_booklets where quote_id = q5 and revoked_at is null;
  r := public.booklet_layout_auto_on(q5);
  perform pg_temp.res('40 Share window open: legacy link gets floor plan + 3D view (changed = true)',
    (r ->> 'changed')::boolean and r #>> '{sections,layout2d}' = 'true' and r #>> '{sections,layout3d}' = 'true', r::text);
  r := public.booklet_layout_auto_on(q5);
  perform pg_temp.res('41 ...a 2nd open changes nothing', not (r ->> 'changed')::boolean, r::text);
  r := public.booklet_current(q5);
  perform pg_temp.res('42 booklet_current returns sections, image_variants, sections_set_at; same token',
    r #>> '{sections,layout2d}' = 'true' and r ? 'image_variants' and r ? 'sections_set_at' and (r ->> 'token')::uuid = tok, r::text);

  -- booklet_set_sections: in place, stamps sections_set_at, validates
  r := public.booklet_set_sections(q5, '{"layout3d": false}'::jsonb);
  perform pg_temp.su();
  perform pg_temp.res('43 booklet_set_sections changes the LIVE link in place (same token, 3D off, plan still on, stamped)',
    (select token = tok and sections ->> 'layout3d' = 'false' and sections ->> 'layout2d' = 'true' and sections_set_at is not null
       and (select count(*) from public.client_booklets where quote_id = q5) = 1
       from public.client_booklets where quote_id = q5 and revoked_at is null), r::text);
  -- after a person chose, a new layout never flips it back
  update public.client_booklets set sections = sections || '{"layout2d": false}'::jsonb where quote_id = q5;
  perform pg_temp.login('a_admin@a.test');
  perform public.add_quote_version(q5, null, '{"items":[{"id":"s1","type":"stage"}]}'::jsonb, 1);
  perform pg_temp.su();
  perform pg_temp.res('44 once a person switched sections, a later layout save leaves them as chosen',
    (select sections ->> 'layout2d' = 'false' and sections ->> 'layout3d' = 'false' from public.client_booklets where quote_id = q5 and revoked_at is null));
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q5, '{"secret": true}'));
  perform pg_temp.res('45 unknown section refused (22023)', e like '22023%', e);
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q5, '{"menu": "yes"}'));
  perform pg_temp.res('46 non-boolean refused (22023)', e like '22023%', e);
  perform pg_temp.login('sb_viewer@a.test');
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q5, '{"menu": false}'));
  perform pg_temp.res('47 quotes-view-only member refused (42501)', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q5, '{"menu": false}'));
  perform pg_temp.res('48 other studio refused (P0002)', e like 'P0002%', e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q5, '{"menu": false}'));
  perform pg_temp.res('49 signed out refused', e <> '', e);
  -- no live link -> P0002; a revoked link is never flipped
  perform pg_temp.su();
  update public.client_booklets set revoked_at = now() where quote_id = q4;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.booklet_set_sections(%L, %L::jsonb)', q4, '{"menu": false}'));
  perform pg_temp.res('50 no live link -> refused (P0002)', e like 'P0002%', e);
  r := public.booklet_layout_auto_on(q4);
  perform pg_temp.res('51 no live link -> auto-on is a no-op', not (r ->> 'ok')::boolean and not (r ->> 'changed')::boolean, r::text);
  -- the public booklet now carries the layout for q1
  perform pg_temp.su();
  select token into tok from public.client_booklets where quote_id = q1 and revoked_at is null;
  -- (read as the owner: some earlier suites in run-all re-apply the 0032 anon allowlist)
  r := public.public_get_booklet(tok);
  perform pg_temp.res('52 the client booklet of q1 now shows the floor plan + 3D view sections',
    r #>> '{sections,layout2d}' = 'true' and r #>> '{sections,layout3d}' = 'true', left(coalesce(r #>> '{sections}', 'null'), 300));
exception when others then perform pg_temp.su(); insert into _sb values ('5x booklet setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _sb order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'START-BLANK-0220: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'START-BLANK-0220: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _sb;
rollback;
