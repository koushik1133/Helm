-- r119-welcome-0327.sql -- R119: welcome e-mails live-safe + billing reminders never late.
-- Proves: the switch is OFF by default (claim hands out nothing, but still closes stale rows), rows older than 48 hours
-- are closed as skipped/expired (kept, never handed out), rows younger than 2 minutes wait, each row is re-checked
-- (deleted studio / ended trial / not a member / deactivated / second owner welcome -> skipped with the reason), the
-- answer carries trial + trial_ends_at + the safe marker, a claimed row is not handed out twice, privileges (service
-- role only; the kept __pre0327 body has none), billing_reminder_recheck (send / stale / paid_since / trial_over / gone),
-- re-run safe. Re-applies 0327 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0327_r119_welcome_live_safe.sql
\ir ../../supabase/migrations/0327_r119_welcome_live_safe.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _ids(k text primary key, id uuid); grant all on _ids to anon, authenticated, service_role;
create temp table _claim(n int, j jsonb); grant all on _claim to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.mkuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  return u;
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.wid(p_k text) returns uuid language sql as $$ select id from _ids where k = p_k $$;
-- queue one welcome row (superuser), remember it under p_k
create or replace function pg_temp.q(p_k text, p_org uuid, p_email text, p_kind text, p_age interval, p_status text default 'pending')
returns void language plpgsql as $$
declare v uuid; begin
  insert into public.welcome_email_outbox(org_id, user_id, kind, email, created_at, status, sent_at)
    values (p_org, pg_temp.uid(p_email), p_kind, p_email, now() - p_age, p_status, case when p_status = 'pending' then null else now() end)
    returning id into v;
  insert into _ids values (p_k, v);
end $$;
-- the claim as the service role (the senders)
create or replace function pg_temp.claim(p_n int) returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role';
  j := public.welcome_email_outbox_claim(100);
  perform pg_temp.su(); insert into _claim values (p_n, j); return j;
end $$;
create or replace function pg_temp.got(p_n int, p_k text) returns jsonb language sql as $$
  select x from _claim c, jsonb_array_elements(c.j) x where c.n = p_n and x ->> 'id' = (select id::text from _ids where k = p_k) $$;
create or replace function pg_temp.row(p_k text) returns public.welcome_email_outbox language sql as $$
  select w from public.welcome_email_outbox w where w.id = (select id from _ids where k = p_k) $$;

-- ---- setup -------------------------------------------------------------------------------------------------------
-- A (fixture, paid: no subscription) | B (fixture, paid) | T = trial (8 days left) | E = trial that ended
do $$ declare
  vA uuid := 'a0000000-0000-4000-8000-000000000001'; vB uuid := 'b0000000-0000-4000-8000-000000000001';
  vT uuid := 'c1190000-0000-4000-8000-000000000001'; vE uuid := 'c1190000-0000-4000-8000-000000000002';
begin
  perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, trial_ends_at)
    values (vT, 'Trial Studio', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now() - interval '1 hour', now() + interval '8 days'),
           (vE, 'Ended Studio', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now() - interval '20 days', now() + interval '1 day')
    on conflict (id) do nothing;
  perform pg_temp.mkuser(e) from unnest(array['r119t_owner@t.test', 'r119t_member@t.test', 'r119e_owner@e.test', 'r119gone@x.test',
                                                'r119stranger@a.test', 'r119second@b.test', 'r119fresh@a.test']) e;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values
    (pg_temp.uid('r119t_owner@t.test'), 'r119t_owner@t.test', 'admin', vT, false, now()),
    (pg_temp.uid('r119t_member@t.test'), 'r119t_member@t.test', 'sales', vT, false, now()),
    (pg_temp.uid('r119e_owner@e.test'), 'r119e_owner@e.test', 'admin', vE, false, now()),
    (pg_temp.uid('r119stranger@a.test'), 'r119stranger@a.test', 'sales', vA, false, now()),
    (pg_temp.uid('r119second@b.test'), 'r119second@b.test', 'admin', vB, false, now()),
    (pg_temp.uid('r119fresh@a.test'), 'r119fresh@a.test', 'sales', vA, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (vT, 'trial', current_date + 8), (vE, 'trial', current_date - 3)
    on conflict (org_id) do update set status = excluded.status, trial_ends_at = excluded.trial_ends_at;
  update public.organizations set trial_ends_at = now() - interval '2 days' where id = vE;   -- E's trial is over (read-only)
  insert into public.team_member_status(user_id, org_id, status) values (pg_temp.uid('b_staff@b.test'), vB, 'deactivated')
    on conflict do nothing;
  -- only our own rows from here on (the triggers above queued some)
  delete from public.welcome_email_outbox;
  perform pg_temp.q('paid_owner',  vA, 'a_admin@a.test',       'studio_owner', interval '1 hour');
  perform pg_temp.q('old_member',  vA, 'a_staff@a.test',       'member',       interval '3 days');
  perform pg_temp.q('trial_owner', vT, 'r119t_owner@t.test',   'studio_owner', interval '1 hour');
  perform pg_temp.q('trial_member', vT, 'r119t_member@t.test', 'member',       interval '30 minutes');
  perform pg_temp.q('ended_owner', vE, 'r119e_owner@e.test',   'studio_owner', interval '1 hour');
  perform pg_temp.q('no_studio',   null, 'r119gone@x.test',    'member',       interval '1 hour');
  perform pg_temp.q('stranger',    vB, 'r119stranger@a.test',  'member',       interval '1 hour');
  perform pg_temp.q('deactivated', vB, 'b_staff@b.test',       'member',       interval '1 hour');
  perform pg_temp.q('owner_sent',  vB, 'b_admin@b.test',       'studio_owner', interval '5 hours', 'sent');
  perform pg_temp.q('owner_dup',   vB, 'r119second@b.test',    'studio_owner', interval '1 hour');
  perform pg_temp.q('fresh',       vA, 'r119fresh@a.test',     'member',       interval '30 seconds');
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) switch off: nothing handed out, stale rows still closed ---------------------------------------------------
do $$ declare j jsonb; begin
  j := pg_temp.claim(1);
  perform pg_temp.res('01 switch OFF by default: welcome_email_switch() false, the claim hands out nothing',
    public.welcome_email_switch() = false and j = '[]'::jsonb, coalesce(j::text, ''));
  perform pg_temp.res('02 a row queued 3 days ago is closed as skipped / expired (kept, sent_at set) even while off',
    (pg_temp.row('old_member')).status = 'skipped' and (pg_temp.row('old_member')).skip_reason = 'expired'
    and (pg_temp.row('old_member')).sent_at is not null);
  perform pg_temp.res('03 recent rows untouched while off (pending, not claimed)',
    (pg_temp.row('paid_owner')).status = 'pending' and (pg_temp.row('paid_owner')).claimed_at is null
    and (pg_temp.row('trial_owner')).attempts = 0);
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) switch on: exactly the safe rows ---------------------------------------------------------------------------
do $$ declare j jsonb; v_ids text[]; begin
  update public.helm_welcome_mail_settings set enabled = true where id;
  j := pg_temp.claim(2);
  select array_agg(k order by k) into v_ids from _ids where id::text in (select x ->> 'id' from jsonb_array_elements(j) x);
  perform pg_temp.res('04 switch ON: exactly the paid owner, the trial owner and the trial member are handed out',
    v_ids = array['paid_owner', 'trial_member', 'trial_owner'], coalesce(v_ids::text, '<none>'));
  perform pg_temp.res('05 every handed-out row carries safe = r119-0327, to, kind, studio',
    (select bool_and(x ->> 'safe' = 'r119-0327' and x ->> 'to' like '%@%' and x ->> 'kind' in ('studio_owner', 'member') and x ? 'studio')
       from jsonb_array_elements(j) x), j::text);
  perform pg_temp.res('06 paid studio: trial false, no trial end',
    (pg_temp.got(2, 'paid_owner') ->> 'trial')::boolean = false and pg_temp.got(2, 'paid_owner') -> 'trial_ends_at' = 'null'::jsonb
    and pg_temp.got(2, 'paid_owner') ->> 'studio' = 'Studio A', coalesce(pg_temp.got(2, 'paid_owner')::text, ''));
  perform pg_temp.res('07 trial studio: trial true + trial_ends_at in the future (owner and member)',
    (pg_temp.got(2, 'trial_owner') ->> 'trial')::boolean and (pg_temp.got(2, 'trial_owner') ->> 'trial_ends_at')::timestamptz > now() + interval '7 days'
    and (pg_temp.got(2, 'trial_member') ->> 'trial')::boolean, coalesce(pg_temp.got(2, 'trial_owner')::text, ''));
  perform pg_temp.res('08 ended trial -> skipped trial_ended; deleted studio -> no_studio',
    (pg_temp.row('ended_owner')).status = 'skipped' and (pg_temp.row('ended_owner')).skip_reason = 'trial_ended'
    and (pg_temp.row('no_studio')).status = 'skipped' and (pg_temp.row('no_studio')).skip_reason = 'no_studio');
  perform pg_temp.res('09 not a member of that studio / deactivated -> skipped not_member',
    (pg_temp.row('stranger')).skip_reason = 'not_member' and (pg_temp.row('deactivated')).skip_reason = 'not_member'
    and (pg_temp.row('stranger')).sent_at is not null);
  perform pg_temp.res('10 a second owner welcome for a studio that already had one -> skipped duplicate',
    (pg_temp.row('owner_dup')).status = 'skipped' and (pg_temp.row('owner_dup')).skip_reason = 'duplicate');
  perform pg_temp.res('11 a row younger than 2 minutes waits (pending, not claimed)',
    (pg_temp.row('fresh')).status = 'pending' and (pg_temp.row('fresh')).claimed_at is null and (pg_temp.row('fresh')).sent_at is null);
  perform pg_temp.res('12 claimed rows: claimed_at set, attempts 1, still unsent until marked',
    (pg_temp.row('paid_owner')).attempts = 1 and (pg_temp.row('paid_owner')).claimed_at is not null and (pg_temp.row('paid_owner')).sent_at is null);
  j := pg_temp.claim(3);
  perform pg_temp.res('13 a second run right away hands out nothing (no double send)', j = '[]'::jsonb, j::text);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role';
  perform public.welcome_email_outbox_mark(pg_temp.wid('paid_owner'), 'sent');
  perform pg_temp.su();
  perform pg_temp.res('14 mark sent (0057) still works; no row was deleted',
    (pg_temp.row('paid_owner')).status = 'sent' and (select count(*) from public.welcome_email_outbox) = (select count(*) from _ids));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) privileges + re-run --------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('15 service role only: signed-in / anon cannot call the claim, the switch or the billing re-check',
    has_function_privilege('service_role', 'public.welcome_email_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.welcome_email_outbox_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.welcome_email_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.welcome_email_switch()', 'execute')
    and not has_function_privilege('authenticated', 'public.billing_reminder_recheck(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.billing_reminder_recheck(uuid)', 'execute'));
  perform pg_temp.res('16 the kept 0057 body (__pre0327) has no privilege at all (not even service role)',
    to_regprocedure('public.welcome_email_outbox_claim__pre0327(integer)') is not null
    and not has_function_privilege('service_role', 'public.welcome_email_outbox_claim__pre0327(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.welcome_email_outbox_claim__pre0327(integer)', 'execute'));
  perform pg_temp.res('17 the switch table is closed to the app (RLS on, no select for signed-in / anon)',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.helm_welcome_mail_settings'::regclass)
    and not has_table_privilege('authenticated', 'public.helm_welcome_mail_settings', 'select')
    and not has_table_privilege('anon', 'public.helm_welcome_mail_settings', 'select'));
  perform pg_temp.res('18 re-run safe: applied twice, ONE kept copy, ONE settings row, claim carries the 0327 marker',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'welcome_email_outbox_claim__pre0327') = 1
    and (select count(*) from public.helm_welcome_mail_settings) = 1
    and pg_get_functiondef('public.welcome_email_outbox_claim(integer)'::regprocedure) like '%r119-0327%'
    and pg_get_functiondef('public.welcome_email_outbox_claim__pre0327(integer)'::regprocedure) not like '%r119-0327%');
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) billing reminders ------------------------------------------------------------------------------------------
do $$ declare
  vA uuid := 'a0000000-0000-4000-8000-000000000001'; vB uuid := 'b0000000-0000-4000-8000-000000000001';
  vT uuid := 'c1190000-0000-4000-8000-000000000001';
  b_due uuid; b_stale uuid; b_paid uuid; b_trial uuid; r1 text; r2 text; r3 text; r4 text; r5 text; r6 text;
begin
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status, current_period_end) values (vA, 'past_due', current_date - 1), (vB, 'past_due', current_date - 2)
    on conflict (org_id) do update set status = excluded.status, current_period_end = excluded.current_period_end;
  insert into public.billing_reminders(org_id, kind, period_end, created_at) values (vA, 'past_due', current_date - 1, now() - interval '1 hour') returning id into b_due;
  insert into public.billing_reminders(org_id, kind, period_end, created_at) values (vA, 'due_soon', current_date + 3, now() - interval '5 days') returning id into b_stale;
  insert into public.billing_reminders(org_id, kind, period_end, created_at) values (vB, 'past_due', current_date - 2, now() - interval '2 hours') returning id into b_paid;
  insert into public.subscription_payments(org_id, amount, paid_on, method, recorded_at) values (vB, 999, current_date, 'upi', now());
  insert into public.billing_reminders(org_id, kind, period_end, created_at) values (vT, 'trial_3d', current_date + 8, now() - interval '1 hour') returning id into b_trial;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role';
  r1 := public.billing_reminder_recheck(b_due);
  r2 := public.billing_reminder_recheck(b_stale);
  r3 := public.billing_reminder_recheck(b_paid);
  r4 := public.billing_reminder_recheck(b_trial);
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'active' where org_id = vT;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role';
  r5 := public.billing_reminder_recheck(b_trial);
  r6 := public.billing_reminder_recheck(b_stale);
  perform pg_temp.su();
  perform pg_temp.res('19 billing: a past-due reminder still due -> send (row left unsent for the sender)',
    r1 = 'send' and (select sent_at is null from public.billing_reminders where id = b_due), r1);
  perform pg_temp.res('20 billing: queued 5 days ago -> stale, closed as channel skipped + skip_reason (kept)',
    r2 = 'stale' and (select sent_at is not null and channel = 'skipped' and skip_reason = 'stale' from public.billing_reminders where id = b_stale), r2);
  perform pg_temp.res('21 billing: the studio paid after the past-due reminder was queued -> paid_since, never sent',
    r3 = 'paid_since' and (select channel = 'skipped' and skip_reason = 'paid_since' from public.billing_reminders where id = b_paid), r3);
  perform pg_temp.res('22 billing: trial reminder while on trial -> send; after the studio converted -> trial_over',
    r4 = 'send' and r5 = 'trial_over' and (select skip_reason = 'trial_over' from public.billing_reminders where id = b_trial), r4 || '/' || r5);
  perform pg_temp.res('23 billing: an already closed row -> gone (nothing changes)', r6 = 'gone', r6);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R119-WELCOME-0327: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R119-WELCOME-0327: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
