-- r124-trial-followups-0333.sql -- R124: follow-up e-mails after a free trial ends without a plan.
-- Proves: no old studio is mailed on the first run (Day 7 included); starts_at is set once and a re-run never moves it;
-- Day 0 / 2 / 7 / 14 queue once per kind per studio, on their day or the catch-up day only, never between; a re-run and a
-- tick after sending add nothing; delete_enabled OFF still sends, with no date; ON passes the scheduled date; x0 / x2 / x14
-- come only from the new claim and x7 only from the 0184 claim, so an older dispatcher can't mark them skipped; the current
-- owner gets it, not created_by or a confirmed business e-mail; a plan, suspension, later trial end or unsubscribe closes a
-- queued row at send time; cancelled / active / sample master / Helm staff / test addresses are never queued; the send window
-- holds a row and hands it out when it opens; rows older than 2 days are skipped but Day 7 / 14 rows are not touched by the
-- rule; deletion warnings unchanged; kill switch; privileges; kept __pre0333 bodies.
-- Re-applies 0329, 0184 consumers untouched, then 0333 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
-- earlier suites in run-all re-apply 0184 / 0329 over the wrappers: put the latest bodies back
\ir ../../supabase/migrations/0329_r121_trial_edge_fixes.sql
\ir ../../supabase/migrations/0333_r124_trial_followup_emails.sql
\ir ../../supabase/migrations/0333_r124_trial_followup_emails.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.org(p_k text) returns uuid language sql as $$ select v::uuid from _kv where k = p_k $$;
create or replace function pg_temp.mail(p_k text) returns text language sql as $$ select 'r124_' || lower(p_k) || '@studio-r124.in' $$;
create or replace function pg_temp.trial(p_key text) returns uuid language plpgsql as $$
declare r jsonb; u uuid; v_mail text := pg_temp.mail(p_key); begin
  perform pg_temp.su(); select id into u from auth.users where email = v_mail;
  if u is null then u := auth.seed_user(v_mail); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, v_mail, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login(v_mail);
  r := public.start_self_serve_trial('T ' || p_key, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su();
  perform pg_temp.put(p_key, r ->> 'org_id');
  return (r ->> 'org_id')::uuid;
end $$;
-- the trial ended p_age ago; the daily billing job has moved the subscription to past_due
create or replace function pg_temp.expire(p_key text, p_age interval) returns void language plpgsql as $$
begin
  update public.organizations set trial_ends_at = now() - p_age where id = pg_temp.org(p_key);
  update public.studio_subscriptions set status = 'past_due', trial_ends_at = ((now() - p_age) at time zone 'UTC')::date
   where org_id = pg_temp.org(p_key);
end $$;
create or replace function pg_temp.nnot(p_key text, p_kind text default null) returns int language sql as $$
  select count(*)::int from public.trial_retention_notices where org_id = pg_temp.org(p_key) and (p_kind is null or kind = p_kind) $$;
create or replace function pg_temp.st(p_key text, p_kind text) returns text language sql as $$
  select email_status from public.trial_retention_notices where org_id = pg_temp.org(p_key) and kind = p_kind $$;
create or replace function pg_temp.starts(p_at timestamptz) returns void language plpgsql as $$
begin update public.helm_trial_followups set starts_at = p_at where id; end $$;
-- close everything still waiting so one test does not leak into the next claim
create or replace function pg_temp.drain() returns void language plpgsql as $$
begin update public.trial_retention_notices set email_status = 'sent', email_sent_at = now() where email_sent_at is null; end $$;
create or replace function pg_temp.has(j jsonb, p_key text, p_kind text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(j) e where e ->> 'to' = pg_temp.mail(p_key) and e ->> 'kind' = p_kind) $$;

-- ---- fixtures -----------------------------------------------------------------------------------------------------------
do $$ declare k text; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  update public.helm_trial_retention set delete_enabled = false where id;
  update public.helm_trial_followups set enabled = true where id;
  -- earlier fixtures leave ended trials: they must not disturb the counts here
  update public.studio_subscriptions set status = 'cancelled' where status in ('trial', 'past_due');
  delete from public.trial_retention_notices;
  foreach k in array array['D0', 'D1', 'D2', 'D3', 'D4', 'D7', 'D8', 'D14', 'D15', 'D16', 'ACTIVE', 'CANCEL', 'SUSP', 'PAID', 'UNSUB', 'LATER', 'OWNER', 'HOLD', 'STALE'] loop
    perform pg_temp.trial(k);
  end loop;
  perform pg_temp.expire('D0', interval '1 hour');   perform pg_temp.expire('D1', interval '1 day');
  perform pg_temp.expire('D2', interval '2 days');   perform pg_temp.expire('D3', interval '3 days');
  perform pg_temp.expire('D4', interval '4 days');   perform pg_temp.expire('D7', interval '7 days');
  perform pg_temp.expire('D8', interval '8 days');   perform pg_temp.expire('D14', interval '14 days');
  perform pg_temp.expire('D15', interval '15 days'); perform pg_temp.expire('D16', interval '16 days');
  perform pg_temp.expire('CANCEL', interval '1 hour');
  update public.studio_subscriptions set status = 'cancelled' where org_id = pg_temp.org('CANCEL');
end $$;

-- ---- 1) no flood of old studios -----------------------------------------------------------------------------------------
do $$ declare j jsonb; v timestamptz; begin
  perform pg_temp.su();
  select starts_at into v from public.helm_trial_followups where id;
  perform pg_temp.res('01 one settings row, on', (select count(*) = 1 and bool_and(enabled) from public.helm_trial_followups));
  perform pg_temp.starts(now());
  j := public.trial_retention_tick();
  perform pg_temp.res('02 first run: trials that ended before the start moment get NOTHING (Day 0, 2, 7, 14 all silent)',
    (j ->> 'followups_new')::int = 0 and (j ->> 'x7_new')::int = 0 and (select count(*) from public.trial_retention_notices) = 0, j::text);
  perform pg_temp.res('03 no bell row either', not exists (select 1 from public.notifications n where n.org_id = pg_temp.org('D7') and n.kind = 'trial_reminder' and n.detail ->> 'milestone' = 'x7'));
  perform pg_temp.starts(now() - interval '60 days');
end $$;
-- a re-run with a row present keeps the moment (the file itself, inside this transaction)
set client_min_messages = error;
\ir ../../supabase/migrations/0333_r124_trial_followup_emails.sql
set client_min_messages = warning;
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('04 running the file again never moves starts_at',
    (select starts_at from public.helm_trial_followups where id) < now() - interval '59 days');
end $$;

-- ---- 2) the offsets -----------------------------------------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su();
  j := public.trial_retention_tick();
  perform pg_temp.res('05 Day 0 / 2 / 7 / 14 queue their kind', pg_temp.nnot('D0', 'x0') = 1 and pg_temp.nnot('D2', 'x2') = 1
    and pg_temp.nnot('D7', 'x7') = 1 and pg_temp.nnot('D14', 'x14') = 1, j::text);
  perform pg_temp.res('06 the catch-up day queues the same kind (a missed tick)', pg_temp.nnot('D1', 'x0') = 1 and pg_temp.nnot('D3', 'x2') = 1
    and pg_temp.nnot('D8', 'x7') = 1 and pg_temp.nnot('D15', 'x14') = 1);
  perform pg_temp.res('07 between the windows and after Day 15: nothing', pg_temp.nnot('D4') = 0 and pg_temp.nnot('D16') = 0);
  perform pg_temp.res('08 exactly one kind per studio on a run', not exists (select 1 from public.trial_retention_notices group by org_id having count(*) > 1));
  perform pg_temp.res('09 active trial and cancelled-never-paid: nothing', pg_temp.nnot('ACTIVE') = 0 and pg_temp.nnot('CANCEL') = 0);
  perform pg_temp.res('10 tick counters', (j ->> 'followups_new')::int = 6 and (j ->> 'x7_new')::int = 2, j::text);
  perform pg_temp.res('11 Day 7 keeps its bell row, the new kinds add none',
    exists (select 1 from public.notifications n where n.org_id = pg_temp.org('D7') and n.detail ->> 'milestone' = 'x7')
    and not exists (select 1 from public.notifications n where n.org_id = pg_temp.org('D0') and n.detail ->> 'milestone' = 'x0'));
  j := public.trial_retention_tick();
  perform pg_temp.res('12 a second tick adds nothing', (j ->> 'followups_new')::int = 0 and (j ->> 'x7_new')::int = 0
    and (select count(*) from public.trial_retention_notices) = 8, j::text);
end $$;

-- ---- 3) the two claims, deletion OFF --------------------------------------------------------------------------------------
do $$ declare o jsonb; f jsonb; v_row jsonb; begin
  perform pg_temp.svc();
  o := public.trial_retention_email_claim(100);
  f := public.trial_followup_email_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('13 x0 / x2 / x14 only from the new claim, with deletion off',
    pg_temp.has(f, 'D0', 'x0') and pg_temp.has(f, 'D2', 'x2') and pg_temp.has(f, 'D14', 'x14') and jsonb_array_length(f) = 6, f::text);
  perform pg_temp.res('14 the 0184 claim (an older dispatcher) offers only x7, and leaves the new rows pending',
    pg_temp.has(o, 'D7', 'x7') and jsonb_array_length(o) = 2
    and not exists (select 1 from jsonb_array_elements(o) e where e ->> 'kind' <> 'x7') and pg_temp.st('D14', 'x14') = 'pending', o::text);
  select e0 into v_row from jsonb_array_elements(f) e0 where e0 ->> 'kind' = 'x14' limit 1;
  perform pg_temp.res('15 no deletion scheduled: no date in the row', v_row ? 'delete_on' and v_row ->> 'delete_on' is null and (v_row ->> 'studio') like 'T %', v_row::text);
  perform pg_temp.res('16 a claimed row is not handed out twice',
    jsonb_array_length(public.trial_followup_email_claim(100)) = 0);
  perform public.trial_retention_email_mark((v_row ->> 'id')::uuid, 'sent');
  perform pg_temp.res('17 marked with the existing mark', pg_temp.st('D14', 'x14') = 'sent' or pg_temp.st('D15', 'x14') = 'sent');
  perform pg_temp.drain();
  perform public.trial_retention_tick();
  perform pg_temp.res('18 sent rows never come back', (select count(*) from public.trial_retention_notices) = 8);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) once per kind per studio, even across a second trial end --------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.expire('D7', interval '7 days 2 hours');   -- a different end moment: 0184's own key would allow a second row
  perform public.trial_retention_tick();
  perform pg_temp.res('19 Day 7 once per studio, even when the trial end moved', pg_temp.nnot('D7', 'x7') = 1);
  perform pg_temp.expire('D0', interval '2 hours');
  perform public.trial_retention_tick();
  perform pg_temp.res('20 Day 0 once per studio', pg_temp.nnot('D0', 'x0') = 1);
  perform pg_temp.res('21 the key refuses a second row outright',
    pg_temp.try($q$insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key)
      values ('$q$ || pg_temp.org('D0')::text || $q$'::uuid, 'x0', now(), 'r124:x0:$q$ || pg_temp.org('D0')::text || $q$')$q$) like '23505%');
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) it stops at once -----------------------------------------------------------------------------------------------------
do $$ declare f jsonb; begin
  perform pg_temp.su();
  perform pg_temp.expire('PAID', interval '1 hour'); perform pg_temp.expire('SUSP', interval '1 hour');
  perform pg_temp.expire('UNSUB', interval '1 hour'); perform pg_temp.expire('LATER', interval '1 hour');
  perform public.trial_retention_tick();
  perform pg_temp.res('22 all four queued', pg_temp.st('PAID', 'x0') = 'pending' and pg_temp.st('SUSP', 'x0') = 'pending'
    and pg_temp.st('UNSUB', 'x0') = 'pending' and pg_temp.st('LATER', 'x0') = 'pending');
  perform public._sub_record_payment(pg_temp.org('PAID'), 1180::numeric, 'INR'::text, current_date, current_date, current_date + 30,
    'card'::text, 'pay_r124'::text, null::uuid, null::text, null::text, null::text, null::numeric);
  update public.studio_subscriptions set status = 'suspended' where org_id = pg_temp.org('SUSP');
  insert into public.email_optouts(org_key, email_lc, opted_out, source)
    values (public._eu165_key(null), pg_temp.mail('UNSUB'), true, 'one_click')
    on conflict (org_key, email_lc) do update set opted_out = true;
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = pg_temp.org('LATER');
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('23 paid, suspended, unsubscribed, extended since queueing: nothing handed out', jsonb_array_length(f) = 0, f::text);
  perform pg_temp.res('24 each row closed as skipped and kept', pg_temp.st('PAID', 'x0') = 'skipped' and pg_temp.st('SUSP', 'x0') = 'skipped'
    and pg_temp.st('UNSUB', 'x0') = 'skipped' and pg_temp.st('LATER', 'x0') = 'skipped');
  -- the next kinds never queue
  perform pg_temp.expire('PAID', interval '2 days'); perform pg_temp.expire('UNSUB', interval '2 days');
  update public.studio_subscriptions set status = 'suspended' where org_id = pg_temp.org('SUSP');
  update public.organizations set trial_ends_at = now() - interval '2 days' where id = pg_temp.org('SUSP');
  perform public.trial_retention_tick();
  perform pg_temp.res('25 paid / suspended / unsubscribed: the rest of the series never queues',
    pg_temp.nnot('PAID', 'x2') = 0 and pg_temp.nnot('SUSP', 'x2') = 0 and pg_temp.nnot('UNSUB', 'x2') = 0);
  -- x7 goes through the 0184 claim: the same stop
  perform pg_temp.drain();
  update public.email_optouts set opted_out = false where email_lc = pg_temp.mail('UNSUB');
  perform pg_temp.expire('UNSUB', interval '7 days');
  perform public.trial_retention_tick();
  update public.email_optouts set opted_out = true where email_lc = pg_temp.mail('UNSUB');
  f := public.trial_retention_email_claim(100);
  perform pg_temp.res('26 Day 7: an unsubscribe after queueing closes it too', jsonb_array_length(f) = 0 and pg_temp.st('UNSUB', 'x7') = 'skipped', f::text);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) who gets it, who never does ------------------------------------------------------------------------------------------
do $$ declare f jsonb; u uuid; v_mail text := 'r124_new_owner@studio-r124.in'; begin
  perform pg_temp.su();
  u := auth.seed_user(v_mail);
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, v_mail, 'admin', pg_temp.org('OWNER'), false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = 'admin';
  insert into public.team_owner_log(org_id, user_id, source, reason) values (pg_temp.org('OWNER'), u, 'transfer', 'r124 test');
  update public.organizations set business_email = 'office@studio-r124.in', business_email_confirmed = true where id = pg_temp.org('OWNER');
  perform pg_temp.expire('OWNER', interval '1 hour');
  perform public.trial_retention_tick();
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('27 the CURRENT owner, not created_by and not the confirmed business e-mail',
    jsonb_array_length(f) = 1 and f -> 0 ->> 'to' = v_mail, f::text);
  perform pg_temp.res('28 Helm addresses and HQ staff never', public._r124_stop('anyone@helm.events') = 'helm_staff'
    and public._r124_stop('x@team.helm.com') = 'helm_staff');
  insert into public.platform_admins(email) values ('r124_hq@studio-r124.in') on conflict do nothing;
  perform pg_temp.res('29 an HQ staff address on any domain never', public._r124_stop('R124_hq@studio-r124.in') = 'helm_staff');
  perform pg_temp.res('30 test addresses never', public._r124_stop('a@example.com') = 'test_address' and public._r124_stop('a@x.example.org') = 'test_address'
    and public._r124_stop('a@studio.test') = 'test_address' and public._r124_stop('a@studio.invalid') = 'test_address');
  perform pg_temp.res('31 a normal address goes, a broken one does not', public._r124_stop('owner@sita-events.in') is null
    and public._r124_stop('nonsense') = 'no_address' and public._r124_stop(null) = 'no_address');
  perform pg_temp.res('32 the sample master is out (0184 rule)',
    public._trial_retention_block((select org_id from public.helm_sample_template where id)) = 'sample_master');
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) deletion switched ON: the date travels, the warnings are unchanged -----------------------------------------------------
do $$ declare f jsonb; o jsonb; v_del date; begin
  perform pg_temp.su();
  perform pg_temp.drain();
  update public.helm_trial_retention set delete_enabled = true where id;
  delete from public.trial_retention_notices where org_id = pg_temp.org('D14');
  perform pg_temp.expire('D14', interval '14 days');
  perform public.trial_retention_tick();
  select delete_on into v_del from public.trial_retention_schedule where org_id = pg_temp.org('D14');
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('33 Day 14 carries the scheduled deletion date',
    v_del is not null and exists (select 1 from jsonb_array_elements(f) e where e ->> 'kind' = 'x14' and e ->> 'to' = pg_temp.mail('D14') and (e ->> 'delete_on')::date = v_del), f::text);
  -- a shorter retention brings the date inside the 30-day warning band
  update public.helm_trial_retention set retention_days = 30 where id;
  update public.trial_retention_schedule set delete_on = v_del - 30 where org_id = pg_temp.org('D14');
  perform public.trial_retention_tick();
  insert into public.email_optouts(org_key, email_lc, opted_out, source)
    values (public._eu165_key(null), pg_temp.mail('D14'), true, 'one_click')
    on conflict (org_key, email_lc) do update set opted_out = true;
  o := public.trial_retention_email_claim(100);
  perform pg_temp.res('34 the deletion warning still comes from the 0184 claim, to the billing address',
    exists (select 1 from jsonb_array_elements(o) e where e ->> 'kind' = 'del30' and e ->> 'to' = public.studio_billing_email(pg_temp.org('D14'))), o::text);
  perform pg_temp.res('35 a warning does not stop on a Helm unsubscribe (service notice, 0184 rule)',
    pg_temp.st('D14', 'del30') = 'pending' and exists (select 1 from jsonb_array_elements(o) e where e ->> 'kind' = 'del30'), o::text);
  update public.helm_trial_retention set retention_days = 60 where id;
  update public.helm_trial_retention set delete_enabled = false where id;
  update public.trial_retention_schedule set status = 'cancelled' where status = 'scheduled';
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) the send window and the 2-day rule --------------------------------------------------------------------------------------
do $$ declare f jsonb; v_nb timestamptz; v_h int; begin
  perform pg_temp.su();
  perform pg_temp.drain();
  perform set_config('helm.send_window', 'on', true);
  -- a staff window that is shut right now, in the studio's own zone
  v_h := extract(hour from now() at time zone 'Asia/Kolkata')::int;
  insert into public.studio_send_windows(org_id, staff_start, staff_end)
    values (pg_temp.org('HOLD'), make_time((v_h + 2) % 22, 0, 0), make_time((v_h + 2) % 22 + 1, 0, 0));
  perform pg_temp.expire('HOLD', interval '1 hour');
  perform public.trial_retention_tick();
  select not_before into v_nb from public.trial_retention_notices where org_id = pg_temp.org('HOLD') and kind = 'x0';
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('36 outside the window: held, still pending, not handed out',
    v_nb > now() and jsonb_array_length(f) = 0 and pg_temp.st('HOLD', 'x0') = 'pending', coalesce(v_nb::text, 'no hold') || f::text);
  perform pg_temp.res('37 the hold is the staff window', (v_nb at time zone 'Asia/Kolkata')::time = make_time((v_h + 2) % 22, 0, 0));
  update public.trial_retention_notices set email_claimed_at = now() - interval '11 minutes'
   where org_id = pg_temp.org('HOLD') and kind = 'x0';   -- the moment the window opens
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('38 when the window opens it goes out', jsonb_array_length(f) = 1, f::text);
  perform set_config('helm.send_window', 'off', true);
  perform pg_temp.expire('STALE', interval '1 hour');
  perform public.trial_retention_tick();
  update public.trial_retention_notices set created_at = now() - interval '47 hours' where org_id = pg_temp.org('STALE');
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('39 a row 47 hours old still goes', jsonb_array_length(f) = 1, f::text);
  update public.trial_retention_notices set email_claimed_at = null, created_at = now() - interval '49 hours' where org_id = pg_temp.org('STALE');
  f := public.trial_followup_email_claim(100);
  perform pg_temp.res('40 a row older than 2 days is skipped, not sent late', jsonb_array_length(f) = 0 and pg_temp.st('STALE', 'x0') = 'skipped', f::text);
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) switch, guards, privileges -----------------------------------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('41 an unknown kind is still refused',
    pg_temp.try($q$insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key)
      values ('$q$ || pg_temp.org('D0')::text || $q$'::uuid, 'x99', now(), 'r124:bad')$q$) like '23514%');
  perform pg_temp.res('42 a deletion warning still needs its date',
    pg_temp.try($q$insert into public.trial_retention_notices(org_id, kind, expired_at, dedupe_key)
      values ('$q$ || pg_temp.org('D0')::text || $q$'::uuid, 'del7', now(), 'r124:bad2')$q$) like '23514%');
  delete from public.trial_retention_notices where org_id = pg_temp.org('D2');
  update public.helm_trial_followups set enabled = false where id;
  j := public.trial_retention_tick();
  perform pg_temp.res('43 kill switch: nothing queued', (j ->> 'followups_new')::int = 0 and pg_temp.nnot('D2') = 0, j::text);
  update public.helm_trial_followups set enabled = true where id;
  j := public.trial_retention_tick();
  perform pg_temp.res('44 switched back on: it queues', pg_temp.nnot('D2', 'x2') = 1, j::text);
  perform pg_temp.res('45 no app role can run the tick, the claims or the helpers',
    not has_function_privilege('authenticated', 'public.trial_followup_email_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.trial_followup_email_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_email_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._r124_queue()', 'execute')
    and not has_function_privilege('authenticated', 'public._r124_to(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r124_stop(text)', 'execute'));
  perform pg_temp.res('46 the service role runs the tick and both claims, not the helpers',
    has_function_privilege('service_role', 'public.trial_retention_tick()', 'execute')
    and has_function_privilege('service_role', 'public.trial_followup_email_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.trial_retention_email_claim(integer)', 'execute')
    and not has_function_privilege('service_role', 'public._r124_queue()', 'execute'));
  perform pg_temp.res('47 kept bodies: present, no app privilege',
    to_regprocedure('public.trial_retention_tick__pre0333()') is not null
    and to_regprocedure('public._tr184_notice__pre0333(uuid,text,timestamptz,date)') is not null
    and to_regprocedure('public.trial_retention_email_claim__pre0333(integer)') is not null
    and not has_function_privilege('authenticated', 'public.trial_retention_tick__pre0333()', 'execute')
    and not has_function_privilege('service_role', 'public.trial_retention_email_claim__pre0333(integer)', 'execute')
    and not has_function_privilege('anon', 'public._tr184_notice__pre0333(uuid,text,timestamptz,date)', 'execute'));
  perform pg_temp.res('48 the settings table is closed to the app',
    not has_table_privilege('authenticated', 'public.helm_trial_followups', 'select')
    and not has_table_privilege('anon', 'public.helm_trial_followups', 'select')
    and (select relrowsecurity from pg_class where oid = 'public.helm_trial_followups'::regclass));
  perform pg_temp.res('49 every definer function has the empty search path',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prosecdef
                   and p.proname in ('_r124_to', '_r124_stop', '_r124_queue', 'trial_followup_email_claim', 'trial_retention_tick', '_tr184_notice')
                   and not ('search_path=""' = any (coalesce(p.proconfig, '{}')))));
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R124-TRIAL-FOLLOWUPS-0333: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R124-TRIAL-FOLLOWUPS-0333: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
