-- r37-studio-tz-0287.sql -- 0287: studio_timezone / studio_today (the studio's calendar day, never the UTC or session day)
-- and the five server checks that now use it (payment reminder wording, vendor payables, package lock, inventory
-- overdue, paid-plan trial end + reminders). The session time zone is set to US zones (and two extreme zones, so the
-- UTC/session day and the Indian day really differ whatever time the suite runs). Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tc(name text, result text); grant all on _tc to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return 'ok:' || coalesce(v, ''); exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.q(text) to anon, authenticated, service_role;

-- the migration, twice (safe to re-run)
\ir ../../supabase/migrations/0287_studio_timezone_today.sql
\ir ../../supabase/migrations/0287_studio_timezone_today.sql

-- ---- 1) the zone: own setting, then country, then Asia/Kolkata -----------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('01 studio A (Asia/Kolkata) -> Asia/Kolkata', public.studio_timezone(a) = 'Asia/Kolkata');
  update public.organizations set timezone = 'Asia/Dubai' where id = b;
  perform pg_temp.res('02 own zone wins (Asia/Dubai)', public.studio_timezone(b) = 'Asia/Dubai');
  update public.organizations set timezone = '', country = 'AE' where id = b;
  perform pg_temp.res('03 blank zone + country AE -> Asia/Dubai', public.studio_timezone(b) = 'Asia/Dubai');
  update public.organizations set timezone = '', country = 'IN' where id = b;
  perform pg_temp.res('04 blank zone + country IN -> Asia/Kolkata', public.studio_timezone(b) = 'Asia/Kolkata');
  update public.organizations set timezone = 'Mars/Olympus', country = 'AE' where id = b;
  perform pg_temp.res('05 unknown zone name -> the country default', public.studio_timezone(b) = 'Asia/Dubai');
  update public.organizations set timezone = ' ', country = null, brand = jsonb_build_object('billing', jsonb_build_object('country', 'AE')) where id = b;
  perform pg_temp.res('06 no zone, billing country AE -> Asia/Dubai', public.studio_timezone(b) = 'Asia/Dubai');
  update public.organizations set timezone = '', country = null, brand = '{}'::jsonb where id = b;
  perform pg_temp.res('07 nothing known -> Asia/Kolkata', public.studio_timezone(b) = 'Asia/Kolkata');
  perform pg_temp.res('08 unknown studio -> Asia/Kolkata', public.studio_timezone('00000000-0000-4000-8000-0000000000ff') = 'Asia/Kolkata');
  update public.organizations set timezone = 'Asia/Kolkata', country = null where id = b;
end $$;

-- ---- 2) the day boundary: 18:30 UTC in India, 20:00 UTC in Dubai, whatever the session zone -------------------------
set timezone = 'America/New_York';
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('09 New York session: 18:29:59 UTC is still 27 Oct in India', public.studio_today(a, '2026-10-27 18:29:59+00') = date '2026-10-27');
  perform pg_temp.res('10 New York session: 18:30:00 UTC is 28 Oct in India (UTC and New York still say 27 Oct)',
    public.studio_today(a, '2026-10-27 18:30:00+00') = date '2026-10-28' and ('2026-10-27 18:30:00+00'::timestamptz)::date = date '2026-10-27');
  update public.organizations set timezone = 'Asia/Dubai' where id = b;
  perform pg_temp.res('11 Dubai: 19:59:59 UTC is 27 Oct, 20:00 UTC is 28 Oct',
    public.studio_today(b, '2026-10-27 19:59:59+00') = date '2026-10-27' and public.studio_today(b, '2026-10-27 20:00:00+00') = date '2026-10-28');
  update public.organizations set timezone = 'Asia/Kolkata' where id = b;
  -- US daylight saving: New York goes back an hour on 1 Nov 2026; India does not move
  perform pg_temp.res('12 across the US DST change the Indian day still flips at 18:30 UTC',
    public.studio_today(a, '2026-10-31 18:29:00+00') = date '2026-10-31' and public.studio_today(a, '2026-10-31 18:30:00+00') = date '2026-11-01'
    and public.studio_today(a, '2026-11-01 18:29:00+00') = date '2026-11-01' and public.studio_today(a, '2026-11-01 18:30:00+00') = date '2026-11-02'
    and public.studio_today(a, '2027-03-14 18:30:00+00') = date '2027-03-15');
  perform pg_temp.res('13 New York session: studio_today(now) = the Indian day of now', public.studio_today(a) = (now() at time zone 'Asia/Kolkata')::date);
end $$;
set timezone = 'America/Los_Angeles';
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('14 Los Angeles session: studio_today(now) = the Indian day of now',
    public.studio_today('a0000000-0000-4000-8000-000000000001') = (now() at time zone 'Asia/Kolkata')::date);
  perform pg_temp.res('15 Los Angeles session: 18:30 UTC boundary', public.studio_today('a0000000-0000-4000-8000-000000000001', '2026-03-08 18:30:00+00') = date '2026-03-09'
    and public.studio_today('a0000000-0000-4000-8000-000000000001', '2026-03-08 18:29:59+00') = date '2026-03-08');
end $$;

-- ---- 3) no API access to the helpers ---------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('16 signed-in user cannot call studio_today directly',
    pg_temp.q('select public.studio_today(''a0000000-0000-4000-8000-000000000001'')::text') like 'err:42501%');
  perform pg_temp.su();
  perform pg_temp.res('17 anon / authenticated have no execute on the helpers',
    not has_function_privilege('anon', 'public.studio_today(uuid, timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public.studio_timezone(uuid)', 'execute'));
end $$;

-- ---- 4) the five re-issued functions no longer read the UTC/session day ---------------------------------------------
do $$ declare f text; n int := 0; begin
  perform pg_temp.su();
  foreach f in array array['payment_reminder_send_now__pre0181', 'vendor_payables_summary__pre0239', '_pkg_lock_reason', 'checkout_availability', '_trial_refresh'] loop
    if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f
                 and p.prosrc !~* 'current_date' and p.prosrc ~ 'studio_today') then n := n + 1; end if;
  end loop;
  perform pg_temp.res('18 all five functions use studio_today and no current_date', n = 5, n::text || '/5');
  perform pg_temp.res('19 grants kept: checkout_availability still callable by signed-in users',
    has_function_privilege('authenticated', 'public.checkout_availability(uuid, uuid)', 'execute'));
end $$;

-- ---- 5) behaviour under extreme session zones (UTC-12 / UTC+14: one of them always disagrees with India) ---------------
create temp table _days(zone text, sess date, studio date); grant all on _days to anon, authenticated, service_role;
do $$ declare z text; begin
  foreach z in array array['Etc/GMT+12', 'Etc/GMT-14', 'America/New_York', 'America/Los_Angeles'] loop
    execute format('set local timezone = %L', z);
    insert into _days values (z, current_date, (now() at time zone 'Asia/Kolkata')::date);
  end loop;
  perform pg_temp.res('20 at least one session zone disagrees with the Indian day right now (the checks below are real)',
    exists (select 1 from _days where sess <> studio));
end $$;

-- vendor payables: due yesterday (studio day) is overdue, due today is not
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; z text; r jsonb; v_ok int := 0; v_t date; begin
  perform pg_temp.su();
  v_t := public.studio_today(a);
  insert into public.vendor_bills(org_id, quote_id, amount, bill_date, due_date, description)
    values (a, qa, 100, v_t - 3, v_t - 1, 'r37 overdue'), (a, qa, 50, v_t - 3, v_t, 'r37 due today');
  foreach z in array array['Etc/GMT+12', 'Etc/GMT-14', 'America/New_York', 'America/Los_Angeles'] loop
    execute format('set timezone = %L', z);
    perform pg_temp.login('a_admin@a.test');
    begin r := public.vendor_payables_summary(); exception when others then r := jsonb_build_object('err', sqlerrm); end;
    perform pg_temp.su();
    if (r ->> 'overdue')::numeric = 100 and (r ->> 'overdue_bills')::int = 1 and (r ->> 'due_7d')::numeric = 50 then v_ok := v_ok + 1;
    else perform pg_temp.res('21 vendor payables in ' || z, false, coalesce(r::text, 'null')); end if;
  end loop;
  perform pg_temp.res('21 vendor payables: overdue / due in 7 days on the studio day in every session zone', v_ok = 4, v_ok::text || '/4');
end $$;
set timezone = 'America/New_York';

-- package lock: N days before the event, on the studio's day
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; v_t date; z text; v_ok int := 0; begin
  perform pg_temp.su();
  v_t := public.studio_today(a);
  -- the fixture quote may have been moved on by earlier suites: back to an open quote (rolled back)
  update public.quotes set status = 'quote', lifecycle_stage = 'quote', confirmed_at = null where id = qa;
  if to_regclass('public.event_plan') is not null then update public.event_plan set menu_locked = false where quote_id = qa; end if;
  insert into public.pkg_settings(org_id, pkg_lock_days) values (a, 1) on conflict (org_id) do update set pkg_lock_days = 1;
  foreach z in array array['Etc/GMT+12', 'Etc/GMT-14'] loop
    execute format('set timezone = %L', z);
    update public.quotes set event_date = v_t + 1 where id = qa;
    if public._pkg_lock_reason(qa) is distinct from 'too_close' then
      update public.quotes set event_date = v_t where id = qa;
      if public._pkg_lock_reason(qa) = 'too_close' then v_ok := v_ok + 1; end if;
    end if;
  end loop;
  perform pg_temp.res('22 package lock (1 day): open the day before, locked on the event day - studio day, any session zone', v_ok = 2, v_ok::text || '/2');
end $$;
set timezone = 'America/New_York';

-- paid-plan trial: ends after its last studio day; reminders count studio days (two throwaway studios with no plan payments)
do $$ declare a uuid := 'c0000000-0000-4000-8000-0000000003a7'; b uuid := 'd0000000-0000-4000-8000-0000000003a7'; v_ta date; v_tb date; z text; v_ok int := 0; begin
  perform pg_temp.su();
  insert into public.organizations(id, name, slug) values (a, 'R37 trial C', 'r37-trial-c'), (b, 'R37 trial D', 'r37-trial-d') on conflict (id) do nothing;
  foreach z in array array['Etc/GMT+12', 'Etc/GMT-14'] loop
    execute format('set timezone = %L', z);
    v_ta := public.studio_today(a); v_tb := public.studio_today(b);
    delete from public.billing_reminders where org_id in (a, b);
    insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (a, 'trial', v_ta - 1), (b, 'trial', v_tb)
      on conflict (org_id) do update set status = 'trial', trial_ends_at = excluded.trial_ends_at, current_period_end = null;
    perform public._trial_refresh();
    if (select status from public.studio_subscriptions where org_id = a) = 'past_due'
       and (select status from public.studio_subscriptions where org_id = b) = 'trial'
       and exists (select 1 from public.billing_reminders r where r.org_id = b and r.kind = 'trial_1d' and r.period_end = v_tb)
    then v_ok := v_ok + 1; end if;
  end loop;
  perform pg_temp.res('23 trial: ended yesterday (studio day) -> past due; ends today -> still trial + the 1-day reminder', v_ok = 2, v_ok::text || '/2');
end $$;
set timezone = 'America/New_York';

select name, result from _tc where result <> 'PASS';
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R37-STUDIO-TZ-0287: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R37-STUDIO-TZ-0287: FAIL' end as summary from _tc;
rollback;
