-- r54-export-lockdown-0295.sql -- r54 security hotfix for Settings -> "Download studio data archive".
-- 0295: only the studio owner / an admin may export (manager / coordinator / crew / sales refused even WITH Users view),
-- free trial still refused, no secret-like key anywhere in the file (recursive deny-list check), one audit_log row per
-- download with row counts, never another studio's rows, and the unused export_org_data() no longer callable by the app.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

-- re-apply twice (earlier suites may re-apply 0033 / 0173 over the export; proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0295_r54_export_lockdown.sql
\ir ../../supabase/migrations/0295_r54_export_lockdown.sql
set client_min_messages = warning;

-- call the export as the API would (role authenticated + JWT claims); returns the file or {"error": SQLSTATE, ...}
create or replace function pg_temp.ex(p_who text, p_fn text default 'export_tenant_organization_package') returns jsonb language plpgsql as $$
declare r jsonb; st text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  else perform auth.login_as((select id from auth.users where email = p_who)); end if;
  begin
    execute format('select public.%I()', p_fn) into r;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    r := jsonb_build_object('error', st, 'message', sqlerrm);
  end;
  perform auth.logout(); execute 'reset role';
  return r;
end $$;
-- every key name at any depth of a jsonb value
create or replace function pg_temp.keys(j jsonb) returns setof text language sql as $$
  with recursive w(v) as (select j
    union all
    select c.v from w, lateral (
      select e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
      union all
      select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a) c)
  select e.key from w, lateral jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e;
$$;
-- the test's OWN deny-list (independent of the migration's helper)
create or replace function pg_temp.bad_keys(j jsonb) returns text language sql as $$
  select string_agg(distinct k, ',') from pg_temp.keys(j) k
   where lower(k) ~ '(token|passw|secret|otp|factor|mfa|hash|api_?key|private_?key|recovery|salt|nonce)'
      or lower(k) in ('code_hash', 'mail_key_hash', 'must_change_password', 'approval_token', 'share_token', 'pin_hash');
$$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;
create or replace function pg_temp.nexp(p_org uuid) returns bigint language sql as $$
  select count(*) from public.audit_log l where l.org_id = p_org and l.action = 'studio.data_export';
$$;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid := (select id from auth.users where email = 'a_admin@a.test');
  a_staff uuid := (select id from auth.users where email = 'a_staff@a.test');
  b_admin uuid := (select id from auth.users where email = 'b_admin@b.test');
  j jsonb; k jsonb; r text; n0 bigint; n1 bigint; lg record; ok boolean := true; det text := '';
begin
  delete from public.team_member_status where user_id in (a_admin, a_staff, b_admin);
  delete from auth.mfa_factors where user_id in (a_admin, a_staff, b_admin);
  delete from public.studio_subscriptions where org_id in (orgA, orgB) and status = 'trial';
  -- secrets the old export leaked: an invitation with a mail key hash + token, a member with a temporary password,
  -- a quote with a live approval token
  insert into public.invitations(org_id, email, role, token, status, invited_by, expires_at, mail_key_hash)
    values (orgA, 'r54-invitee@a.test', 'sales', 'r54-secret-invite-token', 'pending', a_admin, now() + interval '7 days', 'r54-secret-mail-key-hash');
  update public.profiles set must_change_password = true where id = a_staff;
  update public.quotes set approval_token = gen_random_uuid() where org_id = orgA;

  -- 01-03 shape + grants
  perform pg_temp.res('01 export carries the 0295 marker, plpgsql, volatile, security definer, empty search path',
    (select position('r54-export-0295' in p.prosrc) > 0 and p.prosecdef and l.lanname = 'plpgsql' and p.provolatile = 'v'
            and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
       from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('public.export_tenant_organization_package()')));
  perform pg_temp.res('02 signed-in users may call it (the check is inside), anon may not',
    has_function_privilege('authenticated', 'public.export_tenant_organization_package()', 'execute')
    and not has_function_privilege('anon', 'public.export_tenant_organization_package()', 'execute'));
  perform pg_temp.res('03 previous body kept once as __pre0295, not callable by the app; helpers private',
    to_regprocedure('public.export_tenant_organization_package__pre0295()') is not null
    and position('trial-lockdown-0173' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package__pre0295()'))) > 0
    and not has_function_privilege('authenticated', 'public.export_tenant_organization_package__pre0295()', 'execute')
    and not has_function_privilege('anon', 'public.export_tenant_organization_package__pre0295()', 'execute')
    and not has_function_privilege('authenticated', 'public._r295_scrub(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r295_secret_key(text)', 'execute'));

  -- 04 admin: ok, own studio, the expected parts
  n0 := pg_temp.nexp(orgA);
  j := pg_temp.ex('a_admin@a.test');
  n1 := pg_temp.nexp(orgA);
  perform pg_temp.res('04 admin gets the studio file (organizations, profiles, quotes, event_attendees, invitations)',
    not (j ? 'error') and j ->> 'org_id' = orgA::text and j -> 'organizations' ->> 'id' = orgA::text
    and jsonb_array_length(j -> 'quotes') > 0 and jsonb_array_length(j -> 'profiles') >= 2
    and jsonb_typeof(j -> 'event_attendees') = 'array' and jsonb_typeof(j -> 'invitations') = 'array', left(j::text, 300));
  -- 05-08 no secrets anywhere
  perform pg_temp.res('05 recursive deny-list: no token / password / secret / otp / factor / hash-like key at any depth',
    pg_temp.bad_keys(j) is null, pg_temp.bad_keys(j));
  perform pg_temp.res('06 invitations: no mail_key_hash, no token; the secret values are nowhere in the file',
    exists (select 1 from jsonb_array_elements(j -> 'invitations') i where i ->> 'email' = 'r54-invitee@a.test')
    and not exists (select 1 from jsonb_array_elements(j -> 'invitations') i where i ? 'mail_key_hash' or i ? 'token')
    and position('r54-secret-mail-key-hash' in j::text) = 0 and position('r54-secret-invite-token' in j::text) = 0);
  perform pg_temp.res('07 profiles: no must_change_password (another member''s security state)',
    not exists (select 1 from jsonb_array_elements(j -> 'profiles') p where p ? 'must_change_password'));
  perform pg_temp.res('08 quotes: no approval_token, and no live token value anywhere in the file',
    not exists (select 1 from jsonb_array_elements(j -> 'quotes') q where q ? 'approval_token')
    and not exists (select 1 from public.quotes q where q.org_id = orgA and q.approval_token is not null
                       and position(q.approval_token::text in j::text) > 0));
  -- 09-10 other studio never present
  perform pg_temp.res('09 another studio''s rows are never in the file',
    position(orgB::text in j::text) = 0 and position('b_admin@b.test' in j::text) = 0
    and not exists (select 1 from public.quotes q where q.org_id = orgB and position(q.id::text in j::text) > 0));
  k := pg_temp.ex('b_admin@b.test');
  perform pg_temp.res('10 studio B''s admin gets only studio B (no studio A rows)',
    not (k ? 'error') and k ->> 'org_id' = orgB::text and position(orgA::text in k::text) = 0
    and position('a_admin@a.test' in k::text) = 0, left(k::text, 200));
  -- 11-12 audit row
  select l.* into lg from public.audit_log l where l.org_id = orgA and l.action = 'studio.data_export' order by l.at desc, l.id desc limit 1;
  perform pg_temp.res('11 one audit_log row per download (who, studio, when)',
    n1 = n0 + 1 and lg.actor = a_admin and lg.actor_email = 'a_admin@a.test' and lg.entity = 'organizations'
    and lg.entity_id = orgA::text and lg.at is not null, format('n0=%s n1=%s actor=%s', n0, n1, lg.actor));
  perform pg_temp.res('12 the audit row holds the row counts (and no data)',
    (lg.changed -> 'rows' ->> 'quotes')::int = jsonb_array_length(j -> 'quotes')
    and (lg.changed -> 'rows' ->> 'profiles')::int = jsonb_array_length(j -> 'profiles')
    and (lg.changed -> 'rows' ->> 'invitations')::int = jsonb_array_length(j -> 'invitations')
    and length(lg.changed::text) < 400 and pg_temp.bad_keys(lg.changed) is null, lg.changed::text);

  -- 13-16 every other role refused, even WITH Users view + quotes view (before: Users view was enough)
  foreach r in array array['manager', 'coordinator', 'crew', 'sales'] loop
    update public.profiles set role = r where id = a_staff;
    insert into public.role_access(org_id, role, area, can_view, can_edit) values (orgA, r, 'users', true, true), (orgA, r, 'quotes', true, true)
      on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
    n0 := pg_temp.nexp(orgA);
    k := pg_temp.ex('a_staff@a.test');
    perform pg_temp.res('1' || (array_position(array['manager', 'coordinator', 'crew', 'sales'], r) + 2) || ' ' || r || ' refused (42501, owner / admin message), nothing logged',
      k ->> 'error' = '42501' and k ->> 'message' like 'Only the studio owner or an admin%' and pg_temp.nexp(orgA) = n0, k::text);
  end loop;
  update public.profiles set role = 'sales' where id = a_staff;

  -- 17 anon / signed-out refused
  k := pg_temp.ex('anon');
  perform pg_temp.res('17 anon cannot export', k ->> 'error' = '42501', k::text);
  -- 18 a deactivated admin (no studio context) refused
  begin
    insert into public.team_member_status(org_id, user_id, status) values (orgA, a_admin, 'deactivated');
    k := pg_temp.ex('a_admin@a.test');
    raise exception 'r54-undo';
  exception when others then
    if sqlerrm <> 'r54-undo' then k := jsonb_build_object('error', 'setup ' || sqlstate, 'message', sqlerrm); end if;
  end;
  perform pg_temp.res('18 a deactivated admin cannot export', k ->> 'error' = '42501', k::text);

  -- 19 free trial still refused (before any data is built, nothing logged)
  update public.studio_subscriptions set status = 'trial' where org_id = orgB;
  if not found then insert into public.studio_subscriptions(org_id, status) values (orgB, 'trial'); end if;
  n0 := pg_temp.nexp(orgB);
  k := pg_temp.ex('b_admin@b.test');
  perform pg_temp.res('19 free-trial studio admin still refused ("Not available in the free trial"), nothing logged',
    k ->> 'error' = '42501' and k ->> 'message' like '%free trial%' and pg_temp.nexp(orgB) = n0, k::text);
  delete from public.studio_subscriptions where org_id = orgB and status = 'trial';

  -- 20 the scrub itself: nested objects / arrays, legit keys kept
  k := public._r295_scrub('{"a": {"client_otp": "1", "nested_token": "x", "keep": 1, "deeper": [{"api_key": "k", "Password": "p", "name": "ok", "pin_code": "500001"}]},
                            "mfa_factor_id": "f", "code_hash": "h", "list": [1, "token", {"secret_note": "s", "x": 2}], "title": "Wedding"}'::jsonb);
  perform pg_temp.res('20 scrub removes secret-like keys at every depth, keeps the rest (incl. pin_code)',
    k = '{"a": {"keep": 1, "deeper": [{"name": "ok", "pin_code": "500001"}]}, "list": [1, "token", {"x": 2}], "title": "Wedding"}'::jsonb, k::text);

  -- 21-22 the old unused export_org_data(): kept, the app can no longer call it
  perform pg_temp.res('21 export_org_data() kept, but not callable by anon / authenticated',
    to_regprocedure('public.export_org_data()') is not null
    and not has_function_privilege('authenticated', 'public.export_org_data()', 'execute')
    and not has_function_privilege('anon', 'public.export_org_data()', 'execute')
    and not has_function_privilege('authenticated', 'public.export_org_data__pre0173()', 'execute'));
  k := pg_temp.ex('a_admin@a.test', 'export_org_data');
  perform pg_temp.res('22 an admin calling export_org_data() through the API is refused (42501)', k ->> 'error' = '42501', k::text);

  -- 23 the studio owner who is not an admin (0283 owner row) may export
  begin
    update public.profiles set role = 'manager' where id = a_staff;
    insert into public.role_access(org_id, role, area, can_view, can_edit) values (orgA, 'manager', 'users', true, false)
      on conflict (org_id, role, area) do update set can_view = true;
    insert into public.team_owner_log(org_id, user_id, source, reason) values (orgA, a_staff, 'transfer', 'r54 test');
    k := pg_temp.ex('a_staff@a.test');
    raise exception 'r54-undo';
  exception when others then
    if sqlerrm <> 'r54-undo' then k := jsonb_build_object('error', sqlstate, 'message', sqlerrm); end if;
  end;
  perform pg_temp.res('23 the studio owner (0283) may export even when not an admin', not (k ? 'error') and k ->> 'org_id' = orgA::text, left(k::text, 200));

  -- 24 nothing removed
  perform pg_temp.res('24 nothing removed: rows still in the database (tokens, mail key hash, flags kept in place)',
    (select count(*) from public.invitations i where i.mail_key_hash = 'r54-secret-mail-key-hash') = 1
    and (select must_change_password from public.profiles where id = a_staff)
    and not exists (select 1 from public.quotes q where q.org_id = orgA and q.approval_token is null));
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R54-EXPORT-LOCKDOWN-0295: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R54-EXPORT-LOCKDOWN-0295: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
