-- r23-crew-0265.sql -- 0265: crew availability, open shifts with one-tap claim, self check-in feeding actual wages.
-- Proves (applied twice first = re-run safe): link-scoped reads / writes (bad / expired link refused, a number that
-- is not on the Staff list sees nothing), availability own-days-only + range + switch, office availability + day
-- status (assign warnings), open shifts: WhatsApp notice queued (dormant outbox, kind open_shift, own crew link),
-- first-come claim creates an accepted task + closes the shift when full, never more than needed, rejecting the
-- task frees the place, approval mode (pending -> approve creates the task), department + unavailable gates, studio
-- isolation; check-in: server time, once a day, roster arrived / left, location check (distance only stored), office
-- correction keeps the crew's own times; ledger: day rate x days checked in, hours x hourly, shift wage, 'left' =
-- arrived, unchanged without check-ins; outbox claim branch; grants. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
\i supabase/migrations/0265_crew_availability_shifts_checkin.sql
\i supabase/migrations/0265_crew_availability_shifts_checkin.sql
create temp table _rc(name text, result text); grant all on _rc to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.res(text, boolean, text), pg_temp.try(text), pg_temp.j(text), pg_temp.put(text, text), pg_temp.get(text)
  to anon, authenticated, service_role;
create or replace function pg_temp.crew(p_q uuid, p_org uuid, p_name text) returns jsonb language sql as $$
  select l from jsonb_array_elements(coalesce(public._r21_cost_lines(p_q, p_org), '[]'::jsonb)) l
   where l ->> 'source' = 'crew' and l ->> 'label' = p_name limit 1 $$;

-- ---- setup: studio A event today; Ravi + Sita on it; Kiran, Dev, Raj, Suresh (Kitchen) free; studio B crew ------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  v_today date := (now() at time zone 'Asia/Kolkata')::date; c uuid; t uuid;
begin
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = v_today, event_time = null where id in (q, qb);
  delete from public.app_config where key = 'crew';   -- test transaction only (rolled back): start from the defaults
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Ravi', '+919800000201', 1200, a) returning id into c; perform pg_temp.put('ravi', c::text);
  insert into public.event_tasks(id, quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (gen_random_uuid(), q, 'Setup', 'Load in', c, 'Ravi', '+919800000201', 'accepted', a) returning id into t;
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f2650000-0000-4000-8000-000000000001', q, '+919800000201', 'Ravi', a);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Sita', '+919800000202', 1500, a) returning id into c; perform pg_temp.put('sita', c::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (q, 'Setup', 'Welcome desk', c, 'Sita', '+919800000202', 'assigned', a);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f2650000-0000-4000-8000-000000000002', q, '+919800000202', 'Sita', a);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Kiran', '+919800000203', 900, a) returning id into c; perform pg_temp.put('kiran', c::text);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Dev', '+919800000204', 600, a) returning id into c; perform pg_temp.put('dev', c::text);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Raj', '+919800000205', 700, a) returning id into c; perform pg_temp.put('raj', c::text);
  insert into public.crew_members(name, phone, day_rate, department, org_id) values ('Suresh', '+919800000206', 800, 'Kitchen', a) returning id into c; perform pg_temp.put('suresh', c::text);
  -- a link whose number is NOT on the Staff list (a vendor) + an expired crew link
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f2650000-0000-4000-8000-000000000009', q, '+919811111111', 'Vendor', a);
  insert into public.crew_members(name, phone, day_rate, org_id) values ('Old crew', '+919800000207', 500, a);
  insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at) values ('f2650000-0000-4000-8000-000000000008', q, '+919800000207', 'Old crew', a, now() - interval '1 day');
  -- studio B
  insert into public.crew_members(name, phone, day_rate, org_id) values ('B crew', '+919800000299', 999, b) returning id into c; perform pg_temp.put('bcrew', c::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (qb, 'Setup', 'B task', c, 'B crew', '+919800000299', 'accepted', b);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('f2650000-0000-4000-8000-0000000000b1', qb, '+919800000299', 'B crew', b);
  perform pg_temp.put('today', v_today::text);
end $$;

-- ---- 01-04 schema + the crew link read --------------------------------------------------------------------------------
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
     and c.relname in ('crew_availability', 'open_shifts', 'open_shift_claims', 'crew_checkins', 'event_checkin_sites');
  perform pg_temp.res('01 five new tables, RLS on, no coordinate columns stored for check-ins', n = 5
    and not exists (select 1 from information_schema.columns where table_name = 'crew_checkins' and column_name ~ '^(in_|out_)?(lat|lng)$'), n::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare e text; begin
  e := pg_temp.try($q$insert into public.crew_availability (crew_id, day, status) values ('$q$ || pg_temp.get('ravi') || $q$', current_date, 'unavailable')$q$);
  perform pg_temp.res('02 even an admin cannot write the new tables directly (functions only)', e <> '', e);
end $$;
select pg_temp.anon();
do $$ declare h jsonb; e text; begin
  h := public.crew_link_home('f2650000-0000-4000-8000-000000000001');
  perform pg_temp.res('03 crew link home: own name, settings on, check-in today allowed, no shifts yet',
    h #>> '{crew,name}' = 'Ravi' and (h #>> '{settings,availability}')::boolean and (h #>> '{checkin,today_ok}')::boolean
    and jsonb_array_length(h -> 'shifts') = 0 and h ->> 'currency' = 'INR', h::text);
  e := pg_temp.try($q$select public.crew_link_home('f2650000-0000-4000-8000-00000000dead')$q$);
  perform pg_temp.res('04a unknown link refused', e ~* 'invalid link', e);
  e := pg_temp.try($q$select public.crew_link_home('f2650000-0000-4000-8000-000000000008')$q$);
  perform pg_temp.res('04b expired link refused', e ~* 'expired', e);
  h := public.crew_link_home('f2650000-0000-4000-8000-000000000009');
  perform pg_temp.res('04c a number not on the Staff list sees no crew data', h -> 'crew' = 'null'::jsonb and not (h ? 'shifts'), h::text);
  e := pg_temp.try($q$select public.crew_set_availability('f2650000-0000-4000-8000-000000000009', current_date + 3, 'unavailable')$q$);
  perform pg_temp.res('04d ... and cannot mark availability', e ~* 'not linked to a staff member', e);
end $$;

-- ---- 05-08 availability ---------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ declare r jsonb; e1 text; e2 text; d date := pg_temp.get('today')::date; h jsonb; begin
  r := public.crew_set_availability('f2650000-0000-4000-8000-000000000001', d + 5, 'unavailable', 'family function <b>');
  r := public.crew_set_availability('f2650000-0000-4000-8000-000000000001', d + 6, 'unavailable', null);
  r := public.crew_set_availability('f2650000-0000-4000-8000-000000000001', d + 6, 'available', null);
  h := public.crew_link_home('f2650000-0000-4000-8000-000000000001');
  perform pg_temp.res('05 crew marks a day off and another back on: only the day off is listed, note cleaned',
    jsonb_array_length(h -> 'availability') = 1 and h #>> '{availability,0,day}' = (d + 5)::text
    and position('<' in h #>> '{availability,0,note}') = 0, h -> 'availability' #>> '{}');
  e1 := pg_temp.try(format('select public.crew_set_availability(%L, %L, %L)', 'f2650000-0000-4000-8000-000000000001', d - 1, 'unavailable'));
  e2 := pg_temp.try(format('select public.crew_set_availability(%L, %L, %L)', 'f2650000-0000-4000-8000-000000000001', d + 121, 'unavailable'));
  perform pg_temp.res('06 only today .. 120 days ahead', e1 ~* 'from today' and e2 ~* 'from today', e1 || ' / ' || e2);
end $$;
select pg_temp.su();
do $$ declare n int; begin
  select count(*) into n from public.crew_availability where crew_id = pg_temp.get('ravi')::uuid;
  perform pg_temp.res('07 one row per person per day (available again updates the row, nothing deleted)', n = 2, n::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; d date := pg_temp.get('today')::date; s jsonb; e text; begin
  r := public.crew_availability_set(pg_temp.get('sita')::uuid, d + 2, 'unavailable', 'exam');
  r := public.crew_availability_range(d, d + 30, null);
  s := public.crew_day_status(d, null);
  perform pg_temp.res('08a office marks Sita off; the range lists Ravi + Sita days off',
    jsonb_array_length(r) = 2 and position('exam' in r::text) > 0, r::text);
  perform pg_temp.res('08b day status for the event day: Ravi + Sita booked on A-0001',
    (select count(*) from jsonb_array_elements(s) x where x #>> '{booked,0,code}' = 'A-0001') = 2, s::text);
  s := public.crew_day_status(d, 'a0000000-0000-4000-8000-00000000da01');
  perform pg_temp.res('08c ... excluding this event: nobody booked elsewhere', s = '[]'::jsonb, s::text);
  s := public.crew_day_status(d + 2, null);
  perform pg_temp.res('08d day status on Sita''s day off: unavailable', (select bool_and((x ->> 'unavailable')::boolean) from jsonb_array_elements(s) x) and jsonb_array_length(s) = 1, s::text);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare r jsonb; e text; d date := pg_temp.get('today')::date; begin
  r := public.crew_availability_range(d, d + 30, null);
  e := pg_temp.try(format('select public.crew_availability_set(%L, %L, %L)', pg_temp.get('ravi'), d + 9, 'unavailable'));
  perform pg_temp.res('08e studio B sees none of studio A''s days and cannot mark A''s crew', r = '[]'::jsonb and e ~* 'not found', r::text || e);
end $$;

-- ---- 09-14 open shift, first come -------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; n int; d date := pg_temp.get('today')::date; begin
  r := public.open_shift_post('a0000000-0000-4000-8000-00000000da01', 'Waiter', d, '18:00', '23:00', 1000, 'day', 2, 'first_come', null, null, 'Black shirt');
  perform pg_temp.put('shift1', r ->> 'id'); perform pg_temp.put('shift1_notified', r ->> 'notified');
end $$;
select pg_temp.su();
do $$ declare tk uuid; n int; begin
  -- eligible: Kiran, Dev, Raj, Suresh, Old crew (Ravi + Sita are on the event already); Old crew's link for this
  -- event has expired, so his notice has no link (the office decided that - never re-opened)
  select count(*) into n from public.assign_notify_outbox o where o.item_id = pg_temp.get('shift1')::uuid and o.item_kind = 'open_shift'
     and o.link_path ~ '^work\.html\?token=[0-9a-f-]{36}$' and o.body like '%Waiter%Rs 1,000/day%';
  perform pg_temp.res('09 posting queues ONE WhatsApp notice per eligible person with their own crew link (dormant outbox)',
    pg_temp.get('shift1_notified')::int = (select count(*) from public.crew_members cm where cm.org_id = 'a0000000-0000-4000-8000-000000000001' and cm.active
                                               and not public._r23_on_event('a0000000-0000-4000-8000-00000000da01', cm.id) and cm.name <> 'Kiran' and cm.name <> 'Dev')
                                           + 2
    and n = pg_temp.get('shift1_notified')::int - 1
    and exists (select 1 from public.assign_notify_outbox o where o.item_id = pg_temp.get('shift1')::uuid and o.phone = '919800000207'
                  and o.link_path is null and o.body like '%Ask the office%'), pg_temp.get('shift1_notified') || ' rows=' || n);
  select w.token into tk from public.work_tokens w where w.quote_id = 'a0000000-0000-4000-8000-00000000da01' and w.phone = '+919800000203';
  perform pg_temp.put('kiran_tok', tk::text);
  select w.token into tk from public.work_tokens w where w.quote_id = 'a0000000-0000-4000-8000-00000000da01' and w.phone = '+919800000204';
  perform pg_temp.put('dev_tok', tk::text);
  select w.token into tk from public.work_tokens w where w.quote_id = 'a0000000-0000-4000-8000-00000000da01' and w.phone = '+919800000205' and w.expires_at > now();
  perform pg_temp.put('raj_tok', coalesce(tk::text, ''));
  select w.token into tk from public.work_tokens w where w.quote_id = 'a0000000-0000-4000-8000-00000000da01' and w.phone = '+919800000206';
  perform pg_temp.put('suresh_tok', tk::text);
end $$;
select pg_temp.anon();
do $$ declare h jsonb; r jsonb; e text; begin
  h := public.crew_link_home(pg_temp.get('kiran_tok')::uuid);
  perform pg_temp.res('10a Kiran''s link lists the shift with wage, 0 of 2 filled', jsonb_array_length(h -> 'shifts') = 1
    and h #>> '{shifts,0,title}' = 'Waiter' and (h #>> '{shifts,0,wage}')::numeric = 1000 and (h #>> '{shifts,0,filled}')::int = 0, h -> 'shifts' #>> '{}');
  r := public.crew_claim_shift(pg_temp.get('kiran_tok')::uuid, pg_temp.get('shift1')::uuid);
  perform pg_temp.res('10b first come: Kiran''s claim is approved at once', r ->> 'status' = 'approved' and r ->> 'event_token' = pg_temp.get('kiran_tok'), r::text);
  r := public.crew_claim_shift(pg_temp.get('kiran_tok')::uuid, pg_temp.get('shift1')::uuid);
  perform pg_temp.res('11 claiming again is harmless (already)', (r ->> 'already')::boolean and r ->> 'status' = 'approved', r::text);
  r := public.crew_claim_shift(pg_temp.get('dev_tok')::uuid, pg_temp.get('shift1')::uuid);
  e := pg_temp.try(format('select public.crew_claim_shift(%L, %L)', pg_temp.get('suresh_tok'), pg_temp.get('shift1')));
  perform pg_temp.res('12 Dev takes the 2nd place; the 3rd person is told it is full', r ->> 'status' = 'approved' and e ~* 'already full', r::text || ' / ' || e);
end $$;
select pg_temp.su();
do $$ declare s text; n int; t record; begin
  select status into s from public.open_shifts where id = pg_temp.get('shift1')::uuid;
  select count(*) into n from public.open_shift_claims where shift_id = pg_temp.get('shift1')::uuid and status = 'approved';
  select * into t from public.event_tasks where crew_id = pg_temp.get('kiran')::uuid;
  perform pg_temp.put('kiran_task', t.id::text);
  perform pg_temp.res('13a the shift closed itself as filled with exactly 2 people', s = 'filled' and n = 2, s || n);
  perform pg_temp.res('13b Kiran got an accepted task on the event (category Crew, 18:00 start)', t.status = 'accepted' and t.category = 'Crew'
    and t.title like 'Shift: Waiter 18:00-23:00%' and to_char(t.planned_start at time zone 'Asia/Kolkata', 'HH24:MI') = '18:00', to_jsonb(t)::text);
  perform pg_temp.res('13c the office was told (bell rows)', exists (select 1 from public.notifications x where x.kind = 'shift_claimed')
    and exists (select 1 from public.notifications x where x.kind = 'shift_filled'));
end $$;
select pg_temp.anon();
do $$ declare r jsonb; begin
  r := public.worker_respond(pg_temp.get('kiran_tok')::uuid, pg_temp.get('kiran_task')::uuid, 'reject');
  r := public.crew_claim_shift(pg_temp.get('suresh_tok')::uuid, pg_temp.get('shift1')::uuid);
  perform pg_temp.res('14 Kiran rejects the task: his place frees up and Suresh can take it', r ->> 'status' = 'approved', r::text);
end $$;
select pg_temp.su();
do $$ declare s text; begin
  select c.status into s from public.open_shift_claims c where c.shift_id = pg_temp.get('shift1')::uuid and c.crew_id = pg_temp.get('kiran')::uuid;
  perform pg_temp.res('14b Kiran''s claim reads withdrawn (kept, not deleted); the shift is filled again', s = 'withdrawn'
    and (select status from public.open_shifts where id = pg_temp.get('shift1')::uuid) = 'filled', s);
end $$;

-- ---- 15-18 approval mode, department, unavailable, other studio ------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; d date := pg_temp.get('today')::date; begin
  r := public.open_shift_post('a0000000-0000-4000-8000-00000000da01', 'Bartender', d + 2, '17:00', null, 150, 'hour', 1, 'approval', null, null, null);
  perform pg_temp.put('shift2', r ->> 'id');
  r := public.open_shift_post('a0000000-0000-4000-8000-00000000da01', 'Cook', d + 2, null, null, null, 'day', 1, null, 'Kitchen', 'Kitchen', null);
  perform pg_temp.put('shift3', r ->> 'id');
end $$;
select pg_temp.anon();
do $$ declare r jsonb; e text; h jsonb; begin
  r := public.crew_claim_shift(pg_temp.get('kiran_tok')::uuid, pg_temp.get('shift2')::uuid);
  perform pg_temp.res('15a needs approval: Kiran''s claim waits', r ->> 'status' = 'pending', r::text);
  r := public.crew_withdraw_claim(pg_temp.get('kiran_tok')::uuid, pg_temp.get('shift2')::uuid);
  r := public.crew_claim_shift(pg_temp.get('kiran_tok')::uuid, pg_temp.get('shift2')::uuid);
  perform pg_temp.res('15b withdraw + claim again: waiting again', r ->> 'status' = 'pending', r::text);
  h := public.crew_link_home(pg_temp.get('dev_tok')::uuid);
  perform pg_temp.res('16a Dev (no department) does not see the Kitchen-only shift', position('Cook' in (h -> 'shifts')::text) = 0, (h -> 'shifts')::text);
  e := pg_temp.try(format('select public.crew_claim_shift(%L, %L)', pg_temp.get('dev_tok'), pg_temp.get('shift3')));
  perform pg_temp.res('16b ... and cannot claim it', e ~* 'Kitchen team', e);
  r := public.crew_set_availability(pg_temp.get('suresh_tok')::uuid, (pg_temp.get('today')::date + 2), 'unavailable', null);
  e := pg_temp.try(format('select public.crew_claim_shift(%L, %L)', pg_temp.get('suresh_tok'), pg_temp.get('shift3')));
  perform pg_temp.res('17 Suresh marked that day off: his claim is refused', e ~* 'unavailable', e);
  e := pg_temp.try(format('select public.crew_claim_shift(%L, %L)', 'f2650000-0000-4000-8000-0000000000b1', pg_temp.get('shift2')));
  perform pg_temp.res('18 a studio B link cannot claim a studio A shift', e ~* 'not found', e);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; cl uuid; o jsonb; begin
  select id into cl from public.open_shift_claims where shift_id = pg_temp.get('shift2')::uuid;
  perform pg_temp.res('15b2 ... on the same claim row (never a second one)', (select count(*) from public.open_shift_claims where shift_id = pg_temp.get('shift2')::uuid) = 1);
  r := public.open_shift_decide(cl, true, null);
  o := public.open_shifts_for_event('a0000000-0000-4000-8000-00000000da01');
  perform pg_temp.res('15c the office approves: task created, shift filled, list shows the claim + wage to Staff editors',
    r ->> 'status' = 'approved' and exists (select 1 from jsonb_array_elements(o -> 'shifts') s where s ->> 'id' = pg_temp.get('shift2')
       and s ->> 'status' = 'filled' and (s ->> 'wage')::numeric = 150 and s #>> '{claims,0,status}' = 'approved' and s #>> '{claims,0,task_id}' is not null), o::text);
  r := pg_temp.j(format('select public.open_shift_decide(%L, false, null)', cl));
  perform pg_temp.res('15d a decided claim cannot be decided again', r ? 'err', r::text);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare o jsonb; e text; begin
  o := pg_temp.j($q$select public.open_shifts_for_event('a0000000-0000-4000-8000-00000000da01')$q$);
  e := pg_temp.try(format('select public.open_shift_set_status(%L, %L)', pg_temp.get('shift2'), 'cancel'));
  perform pg_temp.res('18b studio B cannot list or change studio A''s shifts', o ? 'err' and e ~* 'not found', o::text || e);
end $$;

-- ---- 19-24 check-in / out ----------------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ declare r jsonb; r2 jsonb; e text; begin
  r := public.crew_check('f2650000-0000-4000-8000-000000000001', 'in');
  r2 := public.crew_check('f2650000-0000-4000-8000-000000000001', 'in');
  perform pg_temp.res('19 Ravi checks in (server time); a second tap keeps the first time', r ->> 'check_in' is not null
    and (r2 ->> 'already')::boolean and r2 ->> 'check_in' = r ->> 'check_in', r::text || r2::text);
  e := pg_temp.try($q$select public.crew_check('f2650000-0000-4000-8000-000000000009', 'in')$q$);
  perform pg_temp.res('20a a link that is not a staff member cannot check in', e ~* 'not linked', e);
  e := pg_temp.try(format('select public.crew_check(%L, %L)', pg_temp.get('raj_tok'), 'in'));
  perform pg_temp.res('20b someone not on this event cannot check in', e ~* 'not on this event', e);
  e := pg_temp.try(format('select public.crew_check(%L, %L)', pg_temp.get('dev_tok'), 'out'));
  perform pg_temp.res('20c check out before checking in is refused', e ~* 'not on this event|check in first', e);
end $$;
select pg_temp.su();
do $$ declare k record; d text; v_exp timestamptz; begin
  select * into k from public.crew_checkins where crew_id = pg_temp.get('ravi')::uuid;
  select status into d from public.event_day where ref_id = pg_temp.get('ravi')::uuid and kind = 'arrival';
  v_exp := public._r23_expected_start('a0000000-0000-4000-8000-00000000da01', pg_temp.get('ravi')::uuid, pg_temp.get('today')::date);
  perform pg_temp.res('21a one check-in row, source crew, roster says arrived', k.source = 'crew' and d = 'arrived'
    and k.check_in_at between now() - interval '1 minute' and now() + interval '1 minute', coalesce(d, 'no roster'));
  perform pg_temp.res('21b late minutes follow the expected start', coalesce(k.late_min, 0) =
    case when v_exp is not null and k.check_in_at > v_exp then floor(extract(epoch from (k.check_in_at - v_exp)) / 60)::int else 0 end, k.late_min::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; begin
  r := public.event_checkin_site_set('a0000000-0000-4000-8000-00000000da01', 12.971599, 77.594566, 300);
  r := public.set_crew_settings('{"geofence": true}'::jsonb);
end $$;
select pg_temp.anon();
do $$ declare e1 text; e2 text; r jsonb; begin
  e1 := pg_temp.try($q$select public.crew_check('f2650000-0000-4000-8000-000000000002', 'in')$q$);
  e2 := pg_temp.try($q$select public.crew_check('f2650000-0000-4000-8000-000000000002', 'in', 12.99, 77.70, 20)$q$);
  perform pg_temp.res('22a location check on: no location refused, 11+ km away refused with the distance',
    e1 ~* 'Allow location' and e2 ~* 'm from the venue', e1 || ' / ' || e2);
  r := public.crew_check('f2650000-0000-4000-8000-000000000002', 'in', 12.972, 77.5949, 15);
  perform pg_temp.res('22b near the venue: checked in, within', (r ->> 'within')::boolean and (r ->> 'distance_m')::int < 100, r::text);
  r := public.crew_check('f2650000-0000-4000-8000-000000000002', 'out', 12.972, 77.5949, 15);
  perform pg_temp.res('23 check out: time + hours, roster says left', r ->> 'check_out' is not null and r ? 'hours', r::text);
end $$;
select pg_temp.su();
do $$ declare d text; k record; begin
  select status into d from public.event_day where ref_id = pg_temp.get('sita')::uuid and kind = 'arrival';
  select * into k from public.crew_checkins where crew_id = pg_temp.get('sita')::uuid;
  perform pg_temp.res('23b roster left; only the distance is stored', d = 'left' and k.in_distance_m < 100 and k.in_within, d);
end $$;
-- office correction (the crew's own times kept)
select pg_temp.login('a_admin@a.test');
do $$ declare e text; r jsonb; v_in timestamptz := date_trunc('minute', now()) - interval '5 hours'; v_out timestamptz := date_trunc('minute', now()) - interval '1 hour'; k record; begin
  e := pg_temp.try(format('select public.crew_checkin_office_set(%L, %L, %L, %L, %L, null)', 'a0000000-0000-4000-8000-00000000da01',
                          pg_temp.get('ravi'), pg_temp.get('today'), v_in, v_out));
  perform pg_temp.res('24a changing the crew''s own times needs a reason', e ~* 'Say why', e);
  r := public.crew_checkin_office_set('a0000000-0000-4000-8000-00000000da01', pg_temp.get('ravi')::uuid, pg_temp.get('today')::date, v_in, v_out, 'forgot to check out');
  select * into k from public.crew_checkins where crew_id = pg_temp.get('ravi')::uuid;
  perform pg_temp.res('24b office times saved, the crew''s first time kept in orig_check_in_at',
    k.check_in_at = v_in and k.check_out_at = v_out and k.orig_check_in_at is not null and k.orig_check_in_at <> v_in and k.edit_note = 'forgot to check out', to_jsonb(k)::text);
  e := pg_temp.try(format('select public.crew_checkin_office_set(%L, %L, %L, %L, %L, %L)', 'a0000000-0000-4000-8000-00000000da01',
                          pg_temp.get('ravi'), pg_temp.get('today'), v_out, v_in, 'x'));
  perform pg_temp.res('24c out before in is refused', e ~* 'after the in time', e);
end $$;

-- ---- 25-29 timesheet + ledger ---------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare t jsonb; r jsonb; begin
  t := public.event_timesheet('a0000000-0000-4000-8000-00000000da01');
  r := (select x from jsonb_array_elements(t -> 'rows') x where x ->> 'name' = 'Ravi');
  perform pg_temp.res('25 timesheet: Ravi 4.0 h, edited, no pay amounts anywhere', (r ->> 'hours')::numeric = 4 and (r #>> '{entries,0,edited}')::boolean
    and position('day_rate' in t::text) = 0 and position('"wage"' in t::text) = 0 and t ? 'site', r::text);
end $$;
select pg_temp.su();
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; l jsonb; begin
  l := pg_temp.crew(q, a, 'Ravi');
  perform pg_temp.res('26a day basis: Ravi checked in = actual day rate 1,200, attendance arrived', (l ->> 'actual')::numeric = 1200
    and l ->> 'attendance' = 'arrived' and (l ->> 'checked_in')::boolean and l ->> 'note' like 'checked in on the crew link%', l::text);
  l := pg_temp.crew(q, a, 'Dev');
  perform pg_temp.res('26b Dev (Waiter shift 1,000/day, not checked in yet): estimate 1,000 (the shift wage, not his 600)',
    (l ->> 'estimated')::numeric = 1000 and l ->> 'actual' is null and (l ->> 'shift_wage')::numeric = 1000, l::text);
  l := pg_temp.crew(q, a, 'Kiran');
  perform pg_temp.res('26c Kiran (Bartender shift 150/hour, no end time): estimate 150 x 8 day hours = 1,200, paid by the hour',
    (l ->> 'estimated')::numeric = 1200 and l ->> 'pay_basis' = 'hours', l::text);
  update public.app_config set value = value || '{"payBasis": "hours", "dayHours": 8}'::jsonb where org_id = a and key = 'crew';
  l := pg_temp.crew(q, a, 'Ravi');
  perform pg_temp.res('27 hours basis: Ravi 4 h x (1,200 / 8) = 600', (l ->> 'actual')::numeric = 600 and l ->> 'pay_basis' = 'hours', l::text);
  update public.app_config set value = value || '{"payBasis": "day"}'::jsonb where org_id = a and key = 'crew';
  -- 'left' on the roster (no check-in) counts as arrived
  delete from public.crew_checkins where crew_id = pg_temp.get('sita')::uuid;   -- test transaction only (rolled back)
  l := pg_temp.crew(q, a, 'Sita');
  perform pg_temp.res('28 roster "left" without a check-in counts as arrived (1 day = 1,500)', (l ->> 'actual')::numeric = 1500 and l ->> 'attendance' = 'arrived', l::text);
  l := pg_temp.crew('b0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-000000000001', 'B crew');
  perform pg_temp.res('29 an event without check-ins / shifts is unchanged (B: estimate 999, no actual)', (l ->> 'estimated')::numeric = 999
    and l ->> 'actual' is null and (l ->> 'c_fc')::numeric = 999 and l ->> 'attendance' = 'not_marked', l::text);
end $$;

-- ---- 30-33 settings, outbox branch, grants -------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare e1 text; e2 text; s jsonb; begin
  e1 := pg_temp.try($q$select public.set_crew_settings('{"lateGraceMin": 999}'::jsonb)$q$);
  e2 := pg_temp.try($q$select public.set_crew_settings('{"claimMode": "auction"}'::jsonb)$q$);
  s := public.set_crew_settings('{"claimMode": "approval", "lateGraceMin": 10}'::jsonb);
  perform pg_temp.res('30 settings: out-of-range refused, valid merged (other keys kept)', e1 <> '' and e2 <> ''
    and s ->> 'claimMode' = 'approval' and (s ->> 'lateGraceMin')::int = 10 and (s ->> 'geofence')::boolean and (s ->> 'can_edit')::boolean, s::text);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare s jsonb; begin
  s := public.get_crew_settings();
  perform pg_temp.res('30b studio B still has its own defaults', s ->> 'claimMode' = 'first_come' and not (s ->> 'geofence')::boolean, s::text);
end $$;
select pg_temp.su();
do $$ declare r jsonb; n int; begin
  r := public.assign_notify_claim(100);
  select count(*) into n from public.assign_notify_outbox where item_kind = 'open_shift' and status = 'pending';
  perform pg_temp.res('31 the dispatcher knows open_shift (studio WhatsApp off -> skipped, never sent)',
    -- the 0265 claim body is the top function, or sits right under the r33 0283 wrapper (skips rows for deactivated members)
    (position('when ''open_shift'' then' in (select prosrc from pg_proc where oid = 'public.assign_notify_claim(integer)'::regprocedure)) > 0
     or (position('assign_notify_claim__pre0283' in (select prosrc from pg_proc where oid = 'public.assign_notify_claim(integer)'::regprocedure)) > 0
         and position('when ''open_shift'' then' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.assign_notify_claim__pre0283(integer)')), '')) > 0))
    and position('open_shift' in coalesce(r::text, '')) = 0, coalesce(r::text, '') || ' pending=' || n);
end $$;
do $$ begin
  perform pg_temp.res('32 grants: link RPCs for anon; office RPCs not for anon; helpers + ledger for nobody',
    has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
    and has_function_privilege('anon', 'public.crew_check(uuid,text,numeric,numeric,numeric)', 'execute')
    and has_function_privilege('anon', 'public.crew_claim_shift(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.open_shift_post(uuid,text,date,time,time,numeric,text,integer,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.event_timesheet(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.crew_availability_set(uuid,date,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.event_timesheet(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_claim_task(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r23_ensure_token(uuid,public.crew_members)', 'execute')
    and not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.assign_notify_claim(integer)', 'execute'));
  perform pg_temp.res('33 ledger body keeps the 0246 + 0252 markers (0252 verify still holds) + the r23 marker',
    position('r22-money-0252' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('r21-money-0246' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('r23-crew-0265' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) > 0
    and position('''unassigned''' in (select prosrc from pg_proc where oid = 'public._r21_cost_lines(uuid,uuid)'::regprocedure)) = 0);
end $$;

select pg_temp.su();
select name, result from _rc order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-CREW-0265: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-CREW-0265: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _rc;
rollback;
