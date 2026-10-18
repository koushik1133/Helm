-- trial-dates-0223.sql -- 0223 (live QA L9): my_trial_status() gives the trial's last day + days left in the
-- STUDIO's time zone (organizations.timezone, default Asia/Kolkata) from the one trial end (0183 effective end,
-- else the end of the subscription trial day UTC); 'ended' from the exact end moment; hq_trial_info + timezone.
-- A self-serve trial ending at 03:30 IST (22:00 UTC the day before), other zones, a bad zone, an ended trial,
-- a checkout-started trial (running + ended), an HQ extension, a paid studio. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _td(name text, result text); grant all on _td to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _td values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return 'ok:' || coalesce(v, ''); exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the caller's my_trial_status() (as that studio's admin)
create or replace function pg_temp.st(p_email text) returns jsonb language plpgsql as $$
declare v jsonb; begin perform pg_temp.login(p_email); v := public.my_trial_status(); perform pg_temp.su(); return v; end $$;
-- put a self-serve trial end at p_end (both dates, the subscription day = the UTC day, as sign-up stores it)
create or replace function pg_temp.set_end(p_org uuid, p_end timestamptz) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = p_end where id = p_org;
  update public.studio_subscriptions set status = 'trial', trial_ends_at = (p_end at time zone 'UTC')::date where org_id = p_org;
end $$;

-- run-all re-applies older migrations in earlier suites: re-run 0223 (also proves a re-run is safe)
\ir ../../supabase/migrations/0223_trial_dates_studio_zone.sql

do $$ declare a uuid; c uuid; v jsonb; v_end timestamptz; v_today date; r text; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  a := pg_temp.trial('td223_a@t.test');
  perform pg_temp.res('00 self-serve trial made', a is not null);

  -- the QA case: the trial ends at 03:30 India time = 22:00 UTC the day before
  v_today := (now() at time zone 'Asia/Kolkata')::date;
  v_end := ((v_today + 8)::timestamp + interval '3 hours 30 minutes') at time zone 'Asia/Kolkata';
  perform pg_temp.set_end(a, v_end);
  perform pg_temp.res('01 setup: the subscription keeps the UTC day (one day before the India day)',
    (select trial_ends_at from public.studio_subscriptions where org_id = a) = v_today + 7);
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('02 ends_at = the India day of the end moment (not the UTC day)', v ->> 'ends_at' = (v_today + 8)::text, v::text);
  perform pg_temp.res('03 days_left = calendar days in India (8 on day 1)', (v ->> 'days_left')::int = 8, v::text);
  perform pg_temp.res('04 state trial, timezone + exact end returned',
    v ->> 'state' = 'trial' and v ->> 'timezone' = 'Asia/Kolkata' and (v ->> 'ends_at_exact')::timestamptz = v_end, v::text);
  perform pg_temp.res('05 is_admin + can_pay unchanged', (v ->> 'is_admin')::boolean and (v ->> 'can_pay')::boolean, v::text);

  -- the same end seen from a studio in another zone (the 0177 trigger pins a trial studio to India: lift its
  -- trial_region stamp for this test so another zone can be set)
  update public.organizations set trial_region = null, timezone = 'America/New_York' where id = a;
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('06 another zone: the day + days left are counted there',
    v ->> 'ends_at' = (((v_end - interval '1 microsecond') at time zone 'America/New_York')::date)::text
    and (v ->> 'days_left')::int = ((v_end - interval '1 microsecond') at time zone 'America/New_York')::date - (now() at time zone 'America/New_York')::date
    and v ->> 'timezone' = 'America/New_York', v::text);

  -- an empty / unknown zone never errors: India
  r := pg_temp.try(format('update public.organizations set timezone = %L where id = %L returning 1', '', a));
  if r like 'ok:%' then
    v := pg_temp.st('td223_a@t.test');
    perform pg_temp.res('07 an empty zone on the studio -> Asia/Kolkata', v ->> 'timezone' = 'Asia/Kolkata' and v ->> 'ends_at' = (v_today + 8)::text, v::text);
  else
    perform pg_temp.res('07 no zone known -> Asia/Kolkata (empty zone refused by the table; helper checked)',
      public._td223_zone(gen_random_uuid()) = 'Asia/Kolkata', r);
  end if;
  r := pg_temp.try(format('update public.organizations set timezone = %L where id = %L returning 1', 'Mars/Olympus_Mons', a));
  if r like 'ok:%' and (select timezone from public.organizations where id = a) is distinct from 'Mars/Olympus_Mons' then r := 'not stored'; end if;
  if r like 'ok:%' then
    v := pg_temp.st('td223_a@t.test');
    perform pg_temp.res('08 unknown zone name -> Asia/Kolkata, no error', v ->> 'timezone' = 'Asia/Kolkata' and v ->> 'ends_at' = (v_today + 8)::text, v::text);
  else
    perform pg_temp.res('08 unknown zone name -> Asia/Kolkata, no error (refused by the table; helper checked)', public._td223_zone(null) = 'Asia/Kolkata', r);
  end if;
  perform pg_temp.su(); update public.organizations set timezone = 'Asia/Kolkata' where id = a;

  -- an end at exactly midnight (studio zone) belongs to the day before
  perform pg_temp.set_end(a, (v_today + 5)::timestamp at time zone 'Asia/Kolkata');
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('09 end at midnight -> the last day is the day before', v ->> 'ends_at' = (v_today + 4)::text and (v ->> 'days_left')::int = 4, v::text);

  -- ended: from the exact end moment (the stored UTC day may still be today)
  perform pg_temp.set_end(a, now() - interval '1 hour');
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('10 past the end moment -> ended, 0 days left, still can pay',
    v ->> 'state' = 'ended' and (v ->> 'days_left')::int = 0 and (v ->> 'can_pay')::boolean, v::text);
  perform pg_temp.set_end(a, now() + interval '2 hours');
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('11 two hours before the end -> trial', v ->> 'state' = 'trial' and (v ->> 'days_left')::int >= 0, v::text);

  -- an HQ extension moved the subscription day later: the later end wins (0183)
  perform pg_temp.set_end(a, v_end);
  update public.studio_subscriptions set trial_ends_at = v_today + 12 where org_id = a;
  v := pg_temp.st('td223_a@t.test');
  perform pg_temp.res('12 extension: the end of the extended subscription day',
    (v ->> 'ends_at_exact')::timestamptz = ((v_today + 13)::timestamp at time zone 'UTC')
    and v ->> 'ends_at' = ((((v_today + 13)::timestamp at time zone 'UTC') - interval '1 microsecond') at time zone 'Asia/Kolkata')::date::text, v::text);

  -- a trial started from the plan / checkout page: no organizations.trial_ends_at
  c := pg_temp.trial('td223_c@t.test');
  update public.organizations set trial_ends_at = null where id = c;
  update public.studio_subscriptions set status = 'trial', trial_ends_at = current_date + 3 where org_id = c;
  v := pg_temp.st('td223_c@t.test');
  perform pg_temp.res('13 checkout trial: end = end of the subscription day (UTC), counted in the studio zone',
    v ->> 'state' = 'trial' and (v ->> 'ends_at_exact')::timestamptz = ((current_date + 4)::timestamp at time zone 'UTC')
    and v ->> 'ends_at' = ((((current_date + 4)::timestamp at time zone 'UTC') - interval '1 microsecond') at time zone 'Asia/Kolkata')::date::text, v::text);
  perform pg_temp.su(); update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = c;
  v := pg_temp.st('td223_c@t.test');
  perform pg_temp.res('14 checkout trial past its day -> ended (the same moment as before 0223)', v ->> 'state' = 'ended' and (v ->> 'days_left')::int = 0, v::text);
  perform pg_temp.su(); update public.studio_subscriptions set trial_ends_at = current_date where org_id = c;
  v := pg_temp.st('td223_c@t.test');
  perform pg_temp.res('15 checkout trial on its last UTC day -> still trial', v ->> 'state' = 'trial', v::text);

  -- paid: none (dates not shown)
  perform pg_temp.su();
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, reference)
    values (c, 100, 'INR', current_date, current_date, current_date + 30, 'upi', 'TD223-1');
  v := pg_temp.st('td223_c@t.test');
  perform pg_temp.res('16 a paid studio -> state none, no dates', v ->> 'state' = 'none' and v -> 'ends_at' = 'null'::jsonb and v -> 'timezone' = 'null'::jsonb, v::text);

  -- access unchanged: anon refused, a studio member only
  perform pg_temp.anon();
  r := pg_temp.try('select public.my_trial_status()::text');
  perform pg_temp.su();
  perform pg_temp.res('17 anon cannot call my_trial_status', r like 'err:42501:%', r);

  perform pg_temp.res('18 grants: RPCs signed-in only, helper internal',
    has_function_privilege('authenticated', 'public.my_trial_status()', 'execute')
    and not has_function_privilege('anon', 'public.my_trial_status()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_trial_info(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.hq_trial_info(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._td223_zone(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._td223_zone(uuid)', 'execute'));

  -- hq_trial_info: + timezone, still HQ-only (a studio admin is refused)
  perform pg_temp.login('td223_a@t.test');
  r := pg_temp.try(format('select public.hq_trial_info(%L)::text', a));
  perform pg_temp.su();
  perform pg_temp.res('19 a studio admin cannot read hq_trial_info (42501)', r like 'err:42501:%', r);
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test 0223') on conflict (email) do nothing;
  delete from public.profiles where id = (select id from auth.users where email = 'admin@helm.events') and org_id is null;
  perform pg_temp.login('admin@helm.events', 'aal2');
  r := pg_temp.try(format('select public.hq_trial_info(%L)::text', a));
  perform pg_temp.su();
  perform pg_temp.res('20 hq_trial_info returns the studio timezone + the exact end', r like 'ok:%"timezone": "Asia/Kolkata"%' and r like '%"trial_ends_at": %', r);

  perform pg_temp.res('21 nothing else changed: no row written by my_trial_status (stable)',
    (select provolatile from pg_proc where oid = to_regprocedure('public.my_trial_status()')) = 's');
  perform pg_temp.res('22 bodies tagged trial-dates-0223',
    position('trial-dates-0223' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_status()'))) > 0
    and position('trial-dates-0223' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_trial_info(uuid)'))) > 0);
end $$;

select name, result from _td order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DATES-0223: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DATES-0223: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _td;
rollback;
