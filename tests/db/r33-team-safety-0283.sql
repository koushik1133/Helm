-- r33-team-safety-0283.sql -- r33 team safety (owner-approved, EDGE-CASES-PLAN B1 / B4 / B5): deactivate instead of delete
-- (no studio, no role, sign-in off, sessions revoked, records + name kept, seat freed, reactivate counts again, open work
-- listed, admin_delete_user never deletes), ONE protected studio owner (backfill + HQ flag, nobody demotes / deactivates /
-- moves the owner), 24-hour admin changes by non-owners (bell + queued e-mail at once, cancel, tick applies, re-check),
-- ownership hand-over (owner only, fresh two-step, active admin accepts, every admin told), Helm HQ owner recovery
-- (two-step, reason, audited), notices admins-only, grants, append-only records, org scoping. Rolled back.
-- Local disposable PG only. Fake data only. Nothing is ever sent (e-mails are only queued rows).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
-- the GoTrue columns / table the shim leaves out (rolled back with everything else)
alter table auth.users add column if not exists banned_until timestamptz;
create table if not exists auth.refresh_tokens (id bigserial primary key, token text, user_id varchar(255), revoked boolean,
  created_at timestamptz default now(), updated_at timestamptz default now(), session_id uuid);

-- studios for the backfill check, made BEFORE re-applying 0283 so its one-time backfill sees them (first-admin trigger off)
do $$ declare c uuid; x1 uuid; x2 uuid; y1 uuid; begin
  alter table public.profiles disable trigger zz_r283_owner_ensure;
  c := auth.seed_user('r33_gone@x.test');
  x1 := auth.seed_user('r33_x1@x.test'); x2 := auth.seed_user('r33_x2@x.test'); y1 := auth.seed_user('r33_y1@y.test');
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, created_by) values
    ('c3300000-0000-4000-8000-0000000000a1', 'R33 X (creator gone)', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now(), c),
    ('c3300000-0000-4000-8000-0000000000a2', 'R33 Y (creator admin)', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now(), y1),
    ('c3300000-0000-4000-8000-0000000000a3', 'R33 Z (no admin)', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now(), null);
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values
    (x2, 'r33_x2@x.test', 'admin', 'c3300000-0000-4000-8000-0000000000a1', false, now() - interval '2 days'),
    (x1, 'r33_x1@x.test', 'admin', 'c3300000-0000-4000-8000-0000000000a1', false, now() - interval '5 days'),
    (y1, 'r33_y1@y.test', 'admin', 'c3300000-0000-4000-8000-0000000000a2', false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, created_at = excluded.created_at;
  alter table public.profiles enable trigger zz_r283_owner_ensure;
end $$;
select count(*) as n into temp _users_before from auth.users;
select count(*) as n into temp _profiles_before from public.profiles;

-- re-apply 0282 (with its R32b amendment) and then 0283 twice, the real order: earlier suites re-apply older seat /
-- admin_create_user bodies; proves 0283 sits on top of R32b without undoing it, and that a re-run is safe
set client_min_messages = error;
\ir ../../supabase/migrations/0282_r32_security_review.sql
\ir ../../supabase/migrations/0283_r33_team_safety.sql
\ir ../../supabase/migrations/0283_r33_team_safety.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
-- sign in as p_email (aal + extra token claims such as amr)
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1', p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal) || coalesce(p_extra, '{}'::jsonb))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- the error hint of a refused call ('' when it worked)
create or replace function pg_temp.hint(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return ''; exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ':' || coalesce(h, ''); end $$;
grant execute on function pg_temp.hint(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid default 'a0000000-0000-4000-8000-000000000001', p_age interval default '0') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, p_email, initcap(split_part(p_email, '@', 1)), p_role, p_org, false, now() - p_age)
    on conflict (id) do update set org_id = p_org, role = p_role, must_change_password = false;
  return u;
end $$;
-- ids by e-mail, readable while signed in as an app user (copied from auth.users as the superuser by pg_temp.sync())
create temp table _uids(email text primary key, id uuid); grant select on _uids to anon, authenticated, service_role;
create or replace function pg_temp.sync() returns void language sql as $$
  insert into _uids select u.email, u.id from auth.users u where u.email is not null on conflict (email) do update set id = excluded.id $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from _uids where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
create or replace function pg_temp.amr_now() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))) $$;
create or replace function pg_temp.amr_old() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '2 hours')::bigint))) $$;

do $$ begin perform pg_temp.sync(); end $$;
-- ================================================================================= 1) the migration + backfill
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('01 0283 re-applied twice: one claim branch, the outbox kind, the keep list, current_org_id + user_role markers',
    (length(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure))
       - length(replace(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure), 'elsif r.kind = ''team_safety''', ''))) = length('elsif r.kind = ''team_safety''')
    and position('_r283_drop_off' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
    and position('''team_safety''' in pg_get_constraintdef((select oid from pg_constraint where conname = 'helm_notice_outbox_kind_check'))) > 0
    and position('_r283_deactivated' in pg_get_functiondef('public.current_org_id()'::regprocedure)) > 0
    and position('_r282_temp_pw_pending' in pg_get_functiondef('public.current_org_id()'::regprocedure)) > 0
    and position('team_member_status' in pg_get_functiondef('public.user_role()'::regprocedure)) > 0
    and (to_regprocedure('public._tr184_keep_tables()') is null or position('team_owner_log' in pg_get_functiondef('public._tr184_keep_tables()'::regprocedure)) > 0));
  perform pg_temp.res('02 studio A (fixture): its first admin a_admin is the owner',
    public._r283_owner(a) = pg_temp.uid('a_admin@a.test'), coalesce(public._r283_owner(a)::text, 'none'));
  perform pg_temp.res('03 backfill: creator gone -> the EARLIEST active admin, flagged for HQ',
    exists (select 1 from public.team_owner_log l where l.org_id = 'c3300000-0000-4000-8000-0000000000a1'
             and l.user_id = pg_temp.uid('r33_x1@x.test') and l.source = 'backfill_admin' and l.hq_flag)
    and (select count(*) from public.team_owner_log l where l.org_id = 'c3300000-0000-4000-8000-0000000000a1') = 1,
    (select string_agg(source || ':' || hq_flag, ',') from public.team_owner_log where org_id = 'c3300000-0000-4000-8000-0000000000a1'));
  perform pg_temp.res('04 backfill: creator still an admin -> the creator, not flagged; no admin at all -> a flagged "none" row',
    exists (select 1 from public.team_owner_log l where l.org_id = 'c3300000-0000-4000-8000-0000000000a2'
             and l.user_id = pg_temp.uid('r33_y1@y.test') and l.source = 'backfill_creator' and not l.hq_flag)
    and exists (select 1 from public.team_owner_log l where l.org_id = 'c3300000-0000-4000-8000-0000000000a3' and l.user_id is null
                 and l.source = 'backfill_none' and l.hq_flag)
    and public._r283_owner('c3300000-0000-4000-8000-0000000000a3') is null);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 2) set-up: studio A people
do $$ declare c uuid; s uuid; begin
  perform pg_temp.su();
  perform pg_temp.member('r33_crew@a.test', 'crew');
  perform pg_temp.sync();
  perform pg_temp.member('r33_adm2@a.test', 'admin');
  perform pg_temp.member('r33_adm3@a.test', 'admin');
  perform pg_temp.member('r33_mgr@a.test', 'manager');
  c := pg_temp.uid('r33_crew@a.test');
  -- their work: a lead they own, a task on the fixture event through their staff record, an event they manage
  insert into public.leads(name, status, org_id, owner) values ('R33 Lead', 'new', 'a0000000-0000-4000-8000-000000000001', c);
  insert into public.crew_members(name, phone, org_id, profile_id) values ('R33 Crew', '+919800000033', 'a0000000-0000-4000-8000-000000000001', c) returning id into s;
  insert into public.event_tasks(quote_id, category, title, seq, status, crew_id, org_id)
    values ('a0000000-0000-4000-8000-00000000da01', 'setup', 'R33 stage', 1, 'assigned', s, 'a0000000-0000-4000-8000-000000000001');
  update public.quotes set manager_id = c where id = 'a0000000-0000-4000-8000-00000000da01';
  insert into auth.sessions(id, user_id) values ('c3300000-0000-4000-8000-00000000f001', c);
  insert into auth.refresh_tokens(token, user_id, revoked, session_id) values ('r33tok', c::text, false, 'c3300000-0000-4000-8000-00000000f001');
  perform pg_temp.member('r33_adm4@a.test', 'admin');
  perform pg_temp.member('r33_adm5@a.test', 'admin');
  perform pg_temp.member('r33_old@a.test', 'sales');
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  perform pg_temp.sync();
exception when others then perform pg_temp.su(); insert into _rs values ('1x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 3) B1 deactivate a non-admin
do $$ declare v text; r jsonb; c uuid := pg_temp.uid('r33_crew@a.test'); n_before int; n_bell int; u0 int; begin
  perform pg_temp.su();
  select count(*) into n_bell from public.notifications where kind = 'team_safety';
  perform pg_temp.login('a_staff@a.test');
  v := pg_temp.try(format('select public.team_deactivate_member(%L)', c));
  perform pg_temp.res('05 a non-admin cannot deactivate anyone (42501)', v like '42501%', v);
  perform pg_temp.login('b_admin@b.test');
  v := pg_temp.try(format('select public.team_deactivate_member(%L)', c));
  perform pg_temp.res('06 another studio''s admin cannot touch a studio A member (no such user)', v like 'P0002%', v);
  perform pg_temp.su();
  u0 := public._r282_seats_used('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  r := public.team_deactivate_member(c, 'left the company');
  perform pg_temp.su();
  perform pg_temp.res('07 the owner deactivates a crew member at once; their open task, event and lead are listed for reassignment',
    (r ->> 'scheduled')::boolean = false
    and jsonb_array_length(r -> 'open_work' -> 'tasks') = 1 and jsonb_array_length(r -> 'open_work' -> 'events') = 1
    and jsonb_array_length(r -> 'open_work' -> 'leads') = 1
    and (select status from public.team_member_status where user_id = c and org_id = 'a0000000-0000-4000-8000-000000000001') = 'deactivated', r::text);
  perform pg_temp.res('08 sign-in off (banned_until ~100 years ahead, the old value kept) + refresh token marked revoked (not deleted)',
    (select banned_until > now() + interval '99 years' from auth.users where id = c)
    and (select ban_set_until is not null and ban_prior is null from public.team_member_status where user_id = c)
    and (select revoked from auth.refresh_tokens where token = 'r33tok') and exists (select 1 from auth.sessions where user_id = c));
  perform pg_temp.res('09 audited (team.deactivate); a non-admin leaving rings no bell',
    exists (select 1 from public.audit_log where action = 'team.deactivate' and entity_id = c::text and org_id = 'a0000000-0000-4000-8000-000000000001')
    and (select count(*) from public.notifications where kind = 'team_safety') = n_bell);
  perform pg_temp.res('10 the seat is freed (seats used -1)', public._r282_seats_used('a0000000-0000-4000-8000-000000000001') = u0 - 1,
    u0 || ' -> ' || public._r282_seats_used('a0000000-0000-4000-8000-000000000001'));
  -- the deactivated person, still holding a valid access token
  perform pg_temp.login('r33_crew@a.test');
  perform pg_temp.res('11 deactivated: no studio, no role, not admin; sees no quotes / leads; studio lookups refused',
    public.current_org_id() is null and public.user_role() is null and not coalesce(public.is_admin(), false)
    and (select count(*) from public.quotes) = 0 and (select count(*) from public.leads) = 0
    and pg_temp.try('select public.studio_avatars()') like '42501%' and pg_temp.try('select public.team_safety_overview()') like '42501%');
  perform pg_temp.su();
  perform pg_temp.res('12 every record they made stays (lead, staff record, task, managed event); profile + login rows still there',
    exists (select 1 from public.leads where name = 'R33 Lead' and owner = c)
    and exists (select 1 from public.event_tasks where title = 'R33 stage')
    and (select manager_id from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = c
    and exists (select 1 from public.profiles where id = c and org_id = 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from auth.users where id = c));
  perform pg_temp.login('a_admin@a.test');
  insert into _kv values ('d13', concat_ws(' | ', (select full_name from public.chat_directory() where id = c), (select full_name from public.studio_avatars() where user_id = c),
    (select full_name from public.audit_actor_names() where id = c), public.team_safety_overview()::text, public.my_seat_usage()::text));
  perform pg_temp.res('13 their name reads "Name (deactivated)" in chat, avatars and the activity log; Team page lists them',
    (select full_name from public.chat_directory() where id = c) like '% (deactivated)'
    and (select full_name from public.studio_avatars() where user_id = c) like '% (deactivated)'
    and (select full_name from public.audit_actor_names() where id = c) like '% (deactivated)'
    and coalesce((select full_name from public.chat_directory() where id = pg_temp.uid('a_staff@a.test')), '') not like '%(deactivated)%'
    and exists (select 1 from jsonb_array_elements(public.team_safety_overview() -> 'deactivated') e where e ->> 'user_id' = c::text)
    and (public.my_seat_usage() ->> 'deactivated')::int = 1, (select x.v from _kv x where x.k = 'd13'));
  r := public.team_deactivate_member(c);
  perform pg_temp.res('14 deactivating twice is a no-op', (r ->> 'already')::boolean, r::text);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('15 a teammate (not admin) also sees the "(deactivated)" tag but no admin details',
    (select full_name from public.chat_directory() where id = c) like '% (deactivated)'
    and not (public.team_safety_overview() ? 'pending') and jsonb_array_length(public.team_safety_overview() -> 'deactivated') = 1);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 4) reactivate (seat limit again) + ban lifting
do $$ declare v text; r jsonb; c uuid := pg_temp.uid('r33_crew@a.test'); a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.organizations set seat_limit = public._r282_seats_used(a) where id = a;   -- full without them
  perform pg_temp.login('a_staff@a.test');
  v := pg_temp.try(format('select public.team_reactivate_member(%L)', c));
  perform pg_temp.res('16 a non-admin cannot reactivate (42501)', v like '42501%', v);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try(format('select public.team_reactivate_member(%L)', c));
  perform pg_temp.su();
  perform pg_temp.res('17 reactivating counts against the seat limit again: a full studio is refused (seat message)',
    v like '42501%' and (v ilike '%plan allows%' or v ilike '%free trial includes%')
    and public._r283_is_off(c, a), v);
  update public.organizations set seat_limit = public._r282_seats_used(a) + 1 where id = a;
  perform pg_temp.login('a_admin@a.test');
  r := public.team_reactivate_member(c);
  perform pg_temp.su();
  perform pg_temp.res('18 with a free seat: reactivated, sign-in back on (banned_until back to what it was), audited',
    (r ->> 'reactivated')::boolean and not public._r283_is_off(c, a)
    and (select banned_until is null from auth.users where id = c)
    and exists (select 1 from public.audit_log where action = 'team.reactivate' and entity_id = c::text), r::text);
  perform pg_temp.login('r33_crew@a.test');
  perform pg_temp.res('19 the reactivated member has their studio + role back', public.current_org_id() = a and public.user_role() = 'crew');
  perform pg_temp.su();
  update public.organizations set seat_limit = null where id = a;
  -- a ban someone else set is never lifted by Reactivate
  perform pg_temp.login('a_admin@a.test');
  perform public.team_deactivate_member(c);
  perform pg_temp.su();
  update auth.users set banned_until = '2031-01-01' where id = c;
  perform pg_temp.login('a_admin@a.test');
  perform public.team_reactivate_member(c);
  perform pg_temp.su();
  perform pg_temp.res('20 Reactivate only lifts the exact ban it set (a different ban stays)',
    (select banned_until = '2031-01-01'::timestamptz from auth.users where id = c) and not public._r283_is_off(c, a));
  update auth.users set banned_until = null where id = c;
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 5) no hard delete anywhere
do $$ declare v text; m uuid := pg_temp.uid('r33_old@a.test'); begin
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.try(format('select public.admin_delete_user(%L)', m));
  perform pg_temp.su();
  perform pg_temp.res('21 admin_delete_user ("Remove") now deactivates: login + profile kept',
    v = '' and public._r283_is_off(m, 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from auth.users where id = m) and exists (select 1 from public.profiles where id = m), v);
  -- an app (API) path deleting a profile row is refused, whatever the definer
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.uid('a_admin@a.test'), 'role', 'authenticated')::text, false);
  v := pg_temp.hint(format('delete from public.profiles where id = %L', m));
  perform pg_temp.su();
  perform pg_temp.res('22 an app-side profile delete is refused (hint use_deactivate); the row stays',
    v = '42501:use_deactivate' and exists (select 1 from public.profiles where id = m), v);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 6) B4 the owner is protected
do $$ declare v text; o uuid := pg_temp.uid('a_admin@a.test'); begin
  perform pg_temp.login('r33_adm2@a.test');
  v := pg_temp.hint(format('select public.team_deactivate_member(%L)', o));
  perform pg_temp.res('23 another admin cannot deactivate the owner (owner_protected)', v = '42501:owner_protected', v);
  v := pg_temp.hint(format('select public.admin_delete_user(%L)', o));
  perform pg_temp.res('24 ... nor "Remove" the owner through the old call', v = '42501:owner_protected', v);
  v := pg_temp.hint(format('select public.admin_set_role(%L, %L)', o, 'manager'));
  perform pg_temp.res('25 ... nor demote the owner (admin_set_role / any path: owner_protected)', v = '42501:owner_protected', v);
  v := pg_temp.hint(format('select public.team_set_role(%L, %L)', o, 'manager'));
  perform pg_temp.res('26 ... nor through team_set_role', v = '42501:owner_protected', v);
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.hint(format('select public.team_deactivate_member(%L)', o));
  perform pg_temp.res('27 the owner cannot deactivate themselves (self)', v = '42501:self', v);
  perform pg_temp.su();
  perform pg_temp.res('28 the owner is still an active admin of studio A',
    public._r283_active_admin('a0000000-0000-4000-8000-000000000001', o) and public._r283_owner('a0000000-0000-4000-8000-000000000001') = o);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 7) B5 24-hour admin changes
do $$ declare v text; r jsonb; a2 uuid := pg_temp.uid('r33_adm2@a.test'); a3 uuid := pg_temp.uid('r33_adm3@a.test'); ch uuid; mail jsonb; ev uuid; begin
  perform pg_temp.login('r33_adm2@a.test');
  r := public.team_deactivate_member(a3, 'not with us any more');
  ch := (r ->> 'change_id')::uuid; insert into _kv values ('ch1', ch::text);
  perform pg_temp.su();
  perform pg_temp.res('29 a non-owner admin deactivating another admin waits 24 hours (still active now)',
    (r ->> 'scheduled')::boolean and (r ->> 'effective_at')::timestamptz between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
    and not public._r283_is_off(a3, 'a0000000-0000-4000-8000-000000000001')
    and (select status from public.team_admin_changes where id = ch) = 'pending', r::text);
  select e.id into ev from public.team_safety_events e where e.event = 'admin_change_requested' and (e.detail ->> 'change_id')::uuid = ch;
  mail := public._r283_mail(ev);
  perform pg_temp.res('30 at once: a bell row for the admins + a queued e-mail to the owner, the affected admin and the asker',
    exists (select 1 from public.notifications n where n.kind = 'team_safety' and n.detail ->> 'event_id' = ev::text
             and n.detail ->> 'label' like '%will be deactivated in 24 hours%')
    and exists (select 1 from public.helm_notice_outbox o where o.kind = 'team_safety' and o.ref_id = ev and o.status = 'pending')
    and mail -> 'to' ? 'a_admin@a.test' and mail -> 'to' ? 'r33_adm3@a.test' and mail -> 'to' ? 'r33_adm2@a.test'
    and jsonb_array_length(mail -> 'to') = 3 and mail -> 'data' ->> 'event' = 'admin_change_requested' and mail -> 'data' ->> 'when' like '%(Asia/Kolkata)',
    coalesce(mail::text, 'no mail'));
  perform pg_temp.res('31 audited (team.admin_change.request)',
    exists (select 1 from public.audit_log where action = 'team.admin_change.request' and entity_id = a3::text));
  perform pg_temp.login('r33_adm2@a.test');
  v := pg_temp.hint(format('select public.team_deactivate_member(%L)', a3));
  perform pg_temp.res('32 one waiting change per admin (change_pending)', v = '23505:change_pending', v);
  v := pg_temp.hint(format('select public.admin_set_role(%L, %L)', a3, 'sales'));
  perform pg_temp.res('33 a non-owner admin cannot demote another admin straight away (admin_change_delay)', v = '42501:admin_change_delay', v);
  -- cancel: a third admin who neither asked nor owns cannot; the owner can
  perform pg_temp.login('r33_adm4@a.test');
  v := pg_temp.try(format('select public.team_change_cancel(%L)', ch));
  perform pg_temp.res('34 an admin who is neither the owner nor the asker cannot cancel', v like '42501%', v);
  perform pg_temp.login('a_admin@a.test');
  r := public.team_change_cancel(ch);
  perform pg_temp.su();
  perform pg_temp.res('35 the owner cancels during the wait: cancelled, the admin stays, everyone told (e-mail queued), audited',
    (r ->> 'cancelled')::boolean and (select status from public.team_admin_changes where id = ch) = 'cancelled'
    and not public._r283_is_off(a3, 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.team_safety_events e join public.helm_notice_outbox o on o.ref_id = e.id
                 where e.event = 'admin_change_cancelled' and (e.detail ->> 'change_id')::uuid = ch)
    and exists (select 1 from public.audit_log where action = 'team.admin_change.cancel' and entity_id = a3::text), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 8) the 24 hours pass
do $$ declare r jsonb; a3 uuid := pg_temp.uid('r33_adm3@a.test'); a4 uuid := pg_temp.uid('r33_adm4@a.test'); ch uuid; ch2 uuid; n int; begin
  perform pg_temp.login('r33_adm2@a.test');
  r := public.team_set_role(a3, 'manager'); ch := (r ->> 'change_id')::uuid;
  perform pg_temp.res('36 team_set_role: demoting another admin (non-owner) waits 24 hours too',
    (r ->> 'scheduled')::boolean and (select role from public.profiles where id = a3) = 'admin', r::text);
  r := public.team_deactivate_member(a4); ch2 := (r ->> 'change_id')::uuid;
  perform pg_temp.su();
  update public.team_admin_changes set effective_at = now() - interval '1 minute' where id in (ch, ch2);
  n := public.team_safety_tick();   -- the pg_cron job (no app user)
  perform pg_temp.res('37 when due, the tick applies both: demoted to Manager + deactivated (not deleted); marked applied',
    n = 2 and (select role from public.profiles where id = a3) = 'manager' and public._r283_is_off(a4, 'a0000000-0000-4000-8000-000000000001')
    and (select count(*) from public.team_admin_changes where id in (ch, ch2) and status = 'applied') = 2
    and exists (select 1 from public.profiles where id = a4), n::text);
  perform pg_temp.res('38 applied changes ring the bell + queue the e-mail again (admin_change_applied), audited',
    (select count(*) from public.team_safety_events e join public.helm_notice_outbox o on o.ref_id = e.id
      where e.event = 'admin_change_applied' and (e.detail ->> 'change_id')::uuid in (ch, ch2)) = 2
    and (select count(*) from public.audit_log where action = 'team.admin_change.applied' and entity_id in (a3::text, a4::text)) = 2);
  perform pg_temp.login('r33_adm3@a.test');
  perform pg_temp.res('39 the app cannot run the tick', pg_temp.try('select public.team_safety_tick()') like '42501%');
  -- re-check at apply time: the asker was deactivated during the wait -> void, nothing changes
  perform pg_temp.su();
  update public.profiles set role = 'admin' where id = a3;
  perform pg_temp.login('r33_adm2@a.test');
  r := public.team_set_role(pg_temp.uid('r33_adm5@a.test'), 'sales'); ch := (r ->> 'change_id')::uuid;
  perform pg_temp.login('a_admin@a.test');
  perform public.team_deactivate_member(pg_temp.uid('r33_adm2@a.test'));   -- the owner: at once
  perform pg_temp.su();
  update public.team_admin_changes set effective_at = now() - interval '1 minute' where id = ch;
  perform pg_temp.login('a_admin@a.test');
  perform public.team_safety_overview();   -- the Team page applies due changes too
  perform pg_temp.su();
  perform pg_temp.res('40 re-checked when due: the asker is no longer an active admin -> void, the admin keeps their role',
    (select status from public.team_admin_changes where id = ch) = 'void' and (select role from public.profiles where id = pg_temp.uid('r33_adm5@a.test')) = 'admin',
    (select status || ' ' || coalesce(note, '') from public.team_admin_changes where id = ch));
  perform pg_temp.res('41 the owner deactivating an admin is immediate and tells the owner + that admin (admin_deactivated e-mail)',
    public._r283_is_off(pg_temp.uid('r33_adm2@a.test'), 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.team_safety_events e join public.helm_notice_outbox o on o.ref_id = e.id
                 where e.event = 'admin_deactivated' and e.target_user = pg_temp.uid('r33_adm2@a.test')));
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 9) notices: admins only, never app-written
do $$ declare v text; n_admin int; n_sales int; begin
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n_admin from public.notifications where kind = 'team_safety';
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n_sales from public.notifications where kind = 'team_safety';
  perform pg_temp.res('42 team notices: admins read them, a non-admin teammate never does (restrictive policy)', n_admin > 0 and n_sales = 0,
    n_admin || '/' || n_sales);
  v := pg_temp.try($q$insert into public.notifications(channel, kind, status, detail, org_id) values ('in_app', 'team_safety', 'simulated', '{}', 'a0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('43 the app cannot write a team notice itself', v like '42501%', v);
  perform pg_temp.su();
  perform pg_temp.res('44 bell type team_safety: in the catalog, hidden by default for a non-admin role, shown for admins',
    exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'team_safety')
    and public.notification_type_of('team_safety', 'in_app') = 'team_safety'
    and 'team_safety' = any (public._notify_hidden_types('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test')))
    and not ('team_safety' = any (public._notify_hidden_types('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test')))));
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 10) B4 ownership hand-over
do $$ declare v text; r jsonb; o uuid := pg_temp.uid('a_admin@a.test'); a3 uuid := pg_temp.uid('r33_adm3@a.test'); t uuid; ev uuid; mail jsonb; begin
  perform pg_temp.su();
  insert into auth.mfa_factors(user_id, factor_type, status) values (o, 'totp', 'verified');   -- the owner has two-step
  perform pg_temp.login('r33_adm3@a.test');
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', a3));
  perform pg_temp.res('45 only the owner can start a hand-over (not_owner)', v = '42501:not_owner', v);
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_old());
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', a3));
  perform pg_temp.res('46 owner with two-step but no fresh code -> asked for a fresh two-step code (reauth)', v = '42501:reauth', v);
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_now());
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.res('47 only to an active admin (a sales member: not_admin)', v = '22023:not_admin', v);
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', pg_temp.uid('r33_adm2@a.test')));
  perform pg_temp.res('48 ... not to a deactivated admin either', v = '22023:not_admin', v);
  r := public.team_owner_transfer_start(a3); t := (r ->> 'transfer_id')::uuid;
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', pg_temp.uid('r33_adm5@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('49 a fresh code: the hand-over waits for the new owner (7 days); one at a time',
    t is not null and (r ->> 'expires_at')::timestamptz > now() + interval '6 days' and v = '23505:transfer_pending'
    and public._r283_owner('a0000000-0000-4000-8000-000000000001') = o, r::text || v);
  perform pg_temp.su();
  select e.id into ev from public.team_safety_events e where e.event = 'owner_transfer_started' and (e.detail ->> 'transfer_id')::uuid = t;
  mail := public._r283_mail(ev);
  perform pg_temp.res('50 every ACTIVE admin gets the e-mail (not deactivated admins, not non-admins) + a bell row',
    mail -> 'to' ? 'a_admin@a.test' and mail -> 'to' ? 'r33_adm3@a.test' and mail -> 'to' ? 'r33_adm5@a.test'
    and not (mail -> 'to' ? 'r33_adm2@a.test') and not (mail -> 'to' ? 'a_staff@a.test') and not (mail -> 'to' ? 'r33_adm4@a.test')
    and exists (select 1 from public.notifications n where n.kind = 'team_safety' and n.detail ->> 'event_id' = ev::text), coalesce(mail::text, 'none'));
  perform pg_temp.login('r33_adm5@a.test');
  v := pg_temp.try(format('select public.team_owner_transfer_accept(%L)', t));
  perform pg_temp.res('51 only the person offered can accept', v like '42501%', v);
  perform pg_temp.login('r33_adm3@a.test');
  r := public.team_owner_transfer_accept(t);
  perform pg_temp.su();
  perform pg_temp.res('52 accepted: the new owner is recorded (append-only log), the old owner stays an admin, everyone told, audited',
    public._r283_owner('a0000000-0000-4000-8000-000000000001') = a3
    and exists (select 1 from public.team_owner_log where org_id = 'a0000000-0000-4000-8000-000000000001' and user_id = a3 and prev_user_id = o and source = 'transfer')
    and (select role from public.profiles where id = o) = 'admin'
    and exists (select 1 from public.team_safety_events e join public.helm_notice_outbox o2 on o2.ref_id = e.id where e.event = 'owner_transfer_accepted')
    and exists (select 1 from public.audit_log where action = 'team.owner.transfer_accept' and entity_id = a3::text), r::text);
  -- the old owner is now an ordinary admin: the new owner may change them at once
  perform pg_temp.login('r33_adm3@a.test');
  v := pg_temp.hint(format('select public.team_owner_transfer_start(%L)', o));   -- adm3 has no two-step: no code needed
  perform pg_temp.res('53 the new owner (no two-step set up) can hand it back without a code', v = '', v);
  perform pg_temp.su();
  select id into t from public.team_owner_transfers where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'pending';
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_now());
  r := public.team_owner_transfer_cancel(t);
  perform pg_temp.res('54 the person offered can decline (declined, e-mail queued)', r ->> 'status' = 'declined', r::text);
  perform pg_temp.login('r33_adm3@a.test');
  perform public.team_owner_transfer_start(o);
  perform pg_temp.su();
  update public.team_owner_transfers set expires_at = now() - interval '1 minute' where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'pending';
  perform public.team_safety_tick();
  perform pg_temp.res('55 an unanswered hand-over expires after 7 days (the tick); ownership unchanged',
    exists (select 1 from public.team_owner_transfers where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'expired')
    and public._r283_owner('a0000000-0000-4000-8000-000000000001') = a3);
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 11) Helm HQ: owner gone -> recovery
do $$ declare v text; r jsonb; o uuid := pg_temp.uid('r33_adm3@a.test'); n uuid := pg_temp.uid('r33_adm5@a.test'); begin
  perform pg_temp.su();
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  update public.platform_admins set status = 'active', role = 'owner' where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by, role) values ('admin@helm.events', 'test', 'owner') on conflict do nothing;
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_now());
  v := pg_temp.try(format('select public.hq_studio_owner_recover(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', 'r33_adm5@a.test', 'owner left, identity checked by a call back'));
  perform pg_temp.res('56 a studio admin cannot use the HQ recovery (42501)', v like '42501%', v);
  perform pg_temp.login('admin@helm.events', 'aal1');
  v := pg_temp.try(format('select public.hq_studio_owner_recover(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', 'r33_adm5@a.test', 'owner left, identity checked by a call back'));
  perform pg_temp.res('57 HQ without two-step (aal1) is refused', v like '42501%', v);
  perform pg_temp.login('admin@helm.events', 'aal2', pg_temp.amr_now());
  v := pg_temp.try(format('select public.hq_studio_owner_recover(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', 'r33_adm5@a.test', 'short'));
  perform pg_temp.res('58 a written reason (20+ characters) is required', v like '22023%', v);
  v := pg_temp.try(format('select public.hq_studio_owner_recover(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', 'a_staff@a.test', 'owner left, identity checked by a call back'));
  perform pg_temp.res('59 the new owner must be an active admin of that studio', v like '22023%', v);
  perform pg_temp.login('admin@helm.events', 'aal2', pg_temp.amr_old());
  v := pg_temp.try(format('select public.hq_studio_owner_recover(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', 'r33_adm5@a.test', 'owner left, identity checked by a call back'));
  perform pg_temp.res('60 HQ needs a fresh two-step code for it', v like '42501%HQ_REAUTH%', v);
  perform pg_temp.login('admin@helm.events', 'aal2', pg_temp.amr_now());
  r := public.hq_studio_owner_recover('a0000000-0000-4000-8000-000000000001', 'R33_adm5@a.test', 'owner left, identity checked by a call back on the registered number');
  perform pg_temp.su();
  perform pg_temp.res('61 recovered: new owner recorded with the reason + HQ e-mail, every admin told, audited (HQ + studio activity)',
    public._r283_owner('a0000000-0000-4000-8000-000000000001') = n
    and exists (select 1 from public.team_owner_log where user_id = n and prev_user_id = o and source = 'hq_recovery' and by_email = 'admin@helm.events'
                 and reason like 'owner left%')
    and exists (select 1 from public.team_safety_events e join public.helm_notice_outbox x on x.ref_id = e.id where e.event = 'owner_recovered')
    and exists (select 1 from public.audit_log where action = 'hq.studio.owner_recover' and entity_id = 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.audit_log where action = 'team.owner.hq_recovery' and org_id = 'a0000000-0000-4000-8000-000000000001'), r::text);
  perform pg_temp.login('admin@helm.events', 'aal2', pg_temp.amr_now());
  r := public.hq_studio_owner_info('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('62 HQ sees the owner, the admins and the owner history; the backfill flags list the flagged studios',
    r -> 'owner' ->> 'email' = 'r33_adm5@a.test' and jsonb_array_length(r -> 'history') >= 3 and not (r ->> 'owner_missing')::boolean
    and exists (select 1 from jsonb_array_elements(public.hq_studio_owner_flags()) f where f ->> 'org_id' = 'c3300000-0000-4000-8000-0000000000a1'),
    r::text);
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_now());
  perform pg_temp.res('63 a studio admin cannot read the HQ owner views', pg_temp.try('select public.hq_studio_owner_flags()') like '42501%');
exception when others then perform pg_temp.su(); insert into _rs values ('10x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 12) e-mail lane, grants, records, no data loss
do $$ declare v text; c jsonb; n_ts int; begin
  perform pg_temp.su();
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  c := public.helm_notice_outbox_claim(100);
  perform pg_temp.su();
  select count(*) into n_ts from jsonb_array_elements(c) e where e ->> 'kind' = 'team_safety' and jsonb_array_length(e -> 'to') > 0 and e -> 'data' ? 'event';
  perform pg_temp.res('64 comms-dispatch claim hands out team_safety e-mails with recipients resolved in the database (queued only)', n_ts >= 5, n_ts::text);
  perform pg_temp.res('65 the five tables: RLS on, no API privilege (anon / authenticated)',
    (select count(*) from pg_class where relname in ('team_member_status', 'team_owner_log', 'team_admin_changes', 'team_owner_transfers', 'team_safety_events')
       and relnamespace = 'public'::regnamespace and relrowsecurity) = 5
    and not has_table_privilege('authenticated', 'public.team_member_status', 'select')
    and not has_table_privilege('authenticated', 'public.team_owner_log', 'insert')
    and not has_table_privilege('anon', 'public.team_admin_changes', 'select')
    and not has_table_privilege('authenticated', 'public.team_owner_transfers', 'update'));
  perform pg_temp.res('66 RPCs: signed-in only; helpers / tick / mail not callable through the API',
    has_function_privilege('authenticated', 'public.team_deactivate_member(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.team_safety_overview()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_studio_owner_recover(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.team_deactivate_member(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.team_owner_transfer_start(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r283_do_deactivate(uuid, uuid, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r283_ensure_owner(uuid, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r283_end_sessions(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.team_safety_tick()', 'execute')
    and has_function_privilege('service_role', 'public.team_safety_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public._r283_mail(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.notification_catalog()', 'execute')
    and has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')
    and not has_function_privilege('authenticated', 'public.notify_default(uuid, text, text, text)', 'execute'));
  v := pg_temp.try($q$update public.team_owner_log set reason = 'x'$q$) || '|' || pg_temp.try($q$delete from public.team_safety_events$q$)
       || '|' || pg_temp.try($q$delete from public.team_member_status$q$) || '|' || pg_temp.try($q$delete from public.team_admin_changes$q$);
  perform pg_temp.res('67 the owner log + events are append-only; no team-safety row can be deleted (even by the database owner)',
    v like '42501%|42501%|42501%|42501%', v);
  perform pg_temp.res('68 re-issued functions keep their API grants (current_org_id, user_role, admin_delete_user, seats, names)',
    has_function_privilege('authenticated', 'public.current_org_id()', 'execute') and has_function_privilege('authenticated', 'public.admin_delete_user(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.my_seat_usage()', 'execute') and has_function_privilege('authenticated', 'public.studio_avatars()', 'execute')
    and has_function_privilege('authenticated', 'public.chat_directory()', 'execute') and has_function_privilege('authenticated', 'public.audit_actor_names()', 'execute'));
  perform pg_temp.res('69 ZERO DATA LOSS: not one login or profile row was deleted by anything in this suite',
    (select count(*) from auth.users) >= (select n from _users_before) and (select count(*) from public.profiles) >= (select n from _profiles_before));
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('70 studio B sees none of studio A''s team-safety state (owner, deactivated, waiting changes)',
    (public.team_safety_overview() ->> 'owner_id')::uuid = pg_temp.uid('b_admin@b.test')
    and jsonb_array_length(public.team_safety_overview() -> 'deactivated') = 0
    and jsonb_array_length(public.team_safety_overview() -> 'pending') = 0);
exception when others then perform pg_temp.su(); insert into _rs values ('11x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- results kept in a variable (the section undoes its own changes with an exception)
create or replace function pg_temp.keep(o text[], p_name text, p_ok boolean, p_detail text default '') returns text[] language sql as $$
  select o || array[p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end] $$;
grant execute on function pg_temp.keep(text[], text, boolean, text) to anon, authenticated, service_role;
-- ================================================================================= 14) final-check fixes: no studio messages to a
-- deactivated member (F1), the right person in the record for a delayed change (F2), crew / work links revoked
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; c uuid := pg_temp.uid('r33_crew@a.test'); a2 uuid := pg_temp.uid('r33_adm2@a.test');
  a3 uuid := pg_temp.uid('r33_adm3@a.test'); tok uuid; v text; r jsonb; n int; x jsonb; ch uuid; begin
  perform pg_temp.su();
  -- F1 a) inbox digests: an important unread notice, instant e-mails on - the active admin gets one, the deactivated admin none
  insert into public.inbox_settings(org_id, email_enabled, digest_default) values (a, true, 'instant_important')
    on conflict (org_id) do update set email_enabled = true, digest_default = 'instant_important';
  insert into public.inbox_person_prefs(user_id, org_id, digest) values (a2, a, 'instant_important'), (pg_temp.uid('r33_adm5@a.test'), a, 'instant_important')
    on conflict (user_id, org_id) do update set digest = excluded.digest;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id, created_at)
    values ('a0000000-0000-4000-8000-00000000da01', 'in_app', 'payment_received', 'simulated', '{"label":"r33 digest"}', a, now() - interval '10 minutes');
  perform public._r23_queue_digests();
  perform pg_temp.res('78 F1 digest: queued for an active admin, never for a deactivated one (and the mail builder returns null for them)',
    exists (select 1 from public.helm_notice_outbox o where o.kind = 'inbox_digest' and o.ref_id = pg_temp.uid('r33_adm5@a.test'))
    and not exists (select 1 from public.helm_notice_outbox o where o.kind = 'inbox_digest' and o.ref_id = a2)
    and public._r23_digest_mail(a, a2, jsonb_build_object('ids', (select jsonb_agg(id) from public.notifications where org_id = a))) is null);
  -- F1 b) every other Helm notice: the claim drops deactivated members (upgrade_ask = every admin of the studio)
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key) values ('upgrade_ask', a, null, '{"who":"Test"}', 'r33-upgrade-ask');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  x := (select e from jsonb_array_elements(public.helm_notice_outbox_claim(100)) e where e ->> 'kind' = 'upgrade_ask' limit 1);
  perform pg_temp.su();
  perform pg_temp.res('79 F1 Helm notices (claim): active admins only - deactivated admins are dropped from the recipients',
    x is not null and x -> 'to' ? 'r33_adm5@a.test' and not (x -> 'to' ? 'r33_adm2@a.test') and not (x -> 'to' ? 'r33_adm4@a.test'), coalesce(x::text, 'none'));
  -- F1 c) close requests, WhatsApp forwards, delivery reminders
  perform pg_temp.res('80 F1 close-request e-mail picks no deactivated member; delivery reminders block them',
    position('_r283_is_off' in (select prosrc from pg_proc where oid = 'public._r22_close_mail(uuid, uuid, text)'::regprocedure)) > 0
    and public._dl241_send_block(a, 'r33_adm2@a.test', false) = 'deactivated'
    and public._dl241_send_block(a, 'r33_adm5@a.test', false) is distinct from 'deactivated');
  insert into public.comms_outbox(org_id, user_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, a2, 'wa_forward', 'whatsapp', '919800000044', '{"type":"payment_received"}', 'r33-waf');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  perform public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('81 F1 a staff WhatsApp forward waiting for a deactivated member is skipped, never sent',
    (select status from public.comms_outbox where dedupe_key = 'r33-waf') = 'skipped');
  -- crew links: the crew member's work link works, deactivation revokes it (marked, not deleted), reactivation does not restore it
  insert into public.work_tokens(quote_id, phone, name, org_id, expires_at)
    values ('a0000000-0000-4000-8000-00000000da01', '+919800000033', 'R33 Crew', a, now() + interval '7 days') returning token into tok;
  perform auth.login_anon();
  v := pg_temp.try(format('select public.crew_link_home(%L)', tok));
  perform pg_temp.res('82 crew link: before, crew_link_home works for their link', v = '', v);
  perform pg_temp.login('r33_adm5@a.test');
  r := public.team_deactivate_member(c, 'left');
  perform pg_temp.su();
  insert into public.assign_notify_outbox(org_id, quote_id, item_kind, item_id, phone, name, body)
    values (a, 'a0000000-0000-4000-8000-00000000da01', 'task', gen_random_uuid(), '919800000033', 'R33 Crew', 'r33 task');
  perform auth.login_anon();
  v := pg_temp.try(format('select public.crew_link_home(%L)', tok));
  perform pg_temp.su();
  perform pg_temp.res('83 crew link: deactivating revokes their work links (revoked_at set, row kept) - crew_link_home refused',
    v <> '' and (select revoked_at is not null from public.work_tokens where token = tok)
    and exists (select 1 from public.audit_log where action = 'team.deactivate' and entity_id = c::text and (changed ->> 'links_revoked')::int >= 1), v);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  perform public.assign_notify_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('84 F1 an assignment WhatsApp waiting for the deactivated crew member''s phone is skipped',
    (select status from public.assign_notify_outbox where body = 'r33 task') = 'skipped');
  perform pg_temp.login('r33_adm5@a.test');
  perform public.team_reactivate_member(c);
  perform pg_temp.su();
  perform pg_temp.res('85 crew link: reactivating does NOT bring the old link back (new links are issued as usual)',
    (select revoked_at is not null from public.work_tokens where token = tok) and not public._r283_is_off(c, a));
  -- F2: a due change is applied by the tick or an admin only, and recorded as the admin who ASKED
  perform pg_temp.login('a_admin@a.test', 'aal2', pg_temp.amr_now());   -- a non-owner admin now (adm5 owns studio A)
  r := public.team_deactivate_member(a3, 'F2'); ch := (r ->> 'change_id')::uuid;
  perform pg_temp.su();
  update public.team_admin_changes set effective_at = now() - interval '1 minute' where id = ch;
  perform pg_temp.login('a_staff@a.test');
  perform public.team_safety_overview();
  perform pg_temp.su();
  perform pg_temp.res('86 F2 a non-admin opening the Team data never applies a due change', (select status from public.team_admin_changes where id = ch) = 'pending'
    and not public._r283_is_off(a3, a));
  perform pg_temp.login('r33_adm5@a.test');
  perform public.team_safety_overview();
  perform pg_temp.su();
  perform pg_temp.res('87 F2 applied by an admin: changed_by, the activity log and the event name the admin who asked (not the one who opened the page)',
    (select status from public.team_admin_changes where id = ch) = 'applied'
    and (select changed_by from public.team_member_status where user_id = a3 and org_id = a) = pg_temp.uid('a_admin@a.test')
    and (select actor from public.audit_log where action = 'team.deactivate' and entity_id = a3::text order by at desc limit 1) = pg_temp.uid('a_admin@a.test')
    and (select actor_user from public.team_safety_events where event = 'admin_change_applied' and (detail ->> 'change_id')::uuid = ch) = pg_temp.uid('a_admin@a.test'),
    concat_ws(' / ', pg_temp.uid('a_admin@a.test'), (select changed_by::text from public.team_member_status where user_id = a3 and org_id = a),
      (select actor::text from public.audit_log where action = 'team.deactivate' and entity_id = a3::text order by at desc limit 1),
      (select actor_user::text from public.team_safety_events where event = 'admin_change_applied' and target_user = a3 order by at desc limit 1)));
exception when others then perform pg_temp.su(); insert into _rs values ('13x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ================================================================================= 13) R32b seat rules still hold after 0283
-- (0283 re-issues the 0282 seat helpers: joining counts only active members, open invitations count only when an
-- invitation is created, the plan limit applies in ANY subscription status, admin_create_user answers refusals)
do $$ declare o text[] := '{}'; t1 text; t2 text; t3 text; outs text := ''; i int; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  begin
    perform pg_temp.su();
    update public.organizations set seat_limit = null where id = b;
    update public.invitations set status = 'revoked' where org_id = b and status = 'pending';
    insert into public.studio_subscriptions(org_id, plan_id, status, current_period_end, updated_at)
      select b, id, 'active', current_date + 30, now() from public.helm_plans where code = 'starter'
    on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active';
    -- B = b_admin + b_staff (2 people) + 3 OLD open invitations (made as the service, before the plan limit)
    insert into public.invitations(org_id, email, role, token, status, invited_by, expires_at)
      select b, 'r33_j' || g || '@b.test', 'sales', md5('r33j' || g), 'pending', pg_temp.uid('b_admin@b.test'), now() + interval '7 days'
        from generate_series(1, 3) g;
    perform auth.seed_user('r33_j1@b.test'); perform auth.seed_user('r33_j2@b.test'); perform auth.seed_user('r33_j3@b.test');
    perform pg_temp.sync();
    perform pg_temp.login('r33_j1@b.test');
    t1 := pg_temp.try(format('select public.accept_invitation(%L)', md5('r33j1')));
    perform pg_temp.login('r33_j2@b.test');
    t2 := pg_temp.try(format('select public.accept_invitation(%L)', md5('r33j2')));
    perform pg_temp.su();
    o := pg_temp.keep(o, '71 R32b after 0283: joining counts only the people in the studio (old open invitations never block a free seat)',
      t1 = '' and (select org_id from public.profiles where email = 'r33_j1@b.test') = b, t1);
    o := pg_temp.keep(o, '72 R32b after 0283: with the plan''s 3 people in, the next join is refused with the plan wording',
      t2 like '42501%Your plan allows 2 team invites%', t2);
    -- 0283: a deactivated member frees the seat for the next person to join
    perform pg_temp.login('b_admin@b.test');
    perform public.team_deactivate_member(pg_temp.uid('b_staff@b.test'));
    perform pg_temp.login('r33_j2@b.test');
    t3 := pg_temp.try(format('select public.accept_invitation(%L)', md5('r33j2')));
    perform pg_temp.su();
    o := pg_temp.keep(o, '73 0283 on top of R32b: once a member is deactivated, the waiting invitee can join (deactivated do not count)',
      t3 = '' and (select org_id from public.profiles where email = 'r33_j2@b.test') = b, t3);
    perform pg_temp.login('b_admin@b.test');
    t3 := pg_temp.try(format('select public.team_reactivate_member(%L)', pg_temp.uid('b_staff@b.test')));
    o := pg_temp.keep(o, '74 ... and reactivating them now needs a free seat again (studio full: refused, plan wording)',
      t3 like '42501%Your plan allows 2 team invites%', t3);
    perform pg_temp.su();
    update public.studio_subscriptions set status = 'cancelled' where org_id = b;
    o := pg_temp.keep(o, '75 R32b after 0283: a cancelled / suspended Starter studio keeps the plan limit (3)',
      public._trial_seat_limit(b) = 3, coalesce(public._trial_seat_limit(b)::text, 'null'));
    update public.invitations set status = 'revoked' where org_id = b and status = 'pending';
    update public.profiles set org_id = null where email in ('r33_j1@b.test', 'r33_j2@b.test');
    perform pg_temp.login('b_admin@b.test');
    for i in 1..3 loop outs := outs || '|' || pg_temp.try(format('select public.create_invitation(%L, %L)', 'r33_c' || i || '@b.test', 'sales')); end loop;
    perform pg_temp.su();
    o := pg_temp.keep(o, '76 R32b after 0283: invitations count when CREATED - cancelled studio: b_admin + 1 invite fits, the next refused (b_staff deactivated)',
      outs like '|||42501 Your plan allows 2 team invites%' or outs like '||42501 Your plan allows 2 team invites%', outs);
    o := pg_temp.keep(o, '77 R32b admin_create_user (refusals answered + counted) is untouched by 0283',
      (select position('r282_acu_refusals' in prosrc) > 0 from pg_proc where oid = 'public.admin_create_user(text, text, text)'::regprocedure)
      and (select position('refused' in prosrc) > 0 from pg_proc where oid = 'public.admin_create_user_temp(text, text)'::regprocedure)
      and (select position('seat_limit in any status' in lower(prosrc)) > 0 from pg_proc where oid = 'public._trial_seat_limit(uuid)'::regprocedure));
    raise exception 'r33-undo';
  exception when others then if sqlerrm <> 'r33-undo' then o := pg_temp.keep(o, '12x', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.su();
  insert into _rs select o[k], o[k + 1] from generate_subscripts(o, 1) k where k % 2 = 1;
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R33-TEAM-SAFETY-0283: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R33-TEAM-SAFETY-0283: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
