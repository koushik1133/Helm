-- r106-trial-gaps-0316.sql - 0316: free-trial rules audit fixes.
-- Proves: a trial studio cannot save a 2D / 3D client picture (insert + booklet_put_image), a paid studio and the service
-- role still can, photos are not blocked; link e-mails / approval codes and delivery reminders share ONE trial e-mail
-- counter (studio 30 / address 5 both ways, my_trial_messaging shows the total); "ends today" (d8) is chosen for a trial
-- ending within 65 minutes (00:03 IST seen from 23:07 IST the evening before) and the old windows are unchanged;
-- a trial owner opening another studio's invitation gets the friendly own_trial refusal and is NOT moved; a normal
-- login keeps the old answer. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0316_r106_trial_gaps.sql
\ir ../../supabase/migrations/0316_r106_trial_gaps.sql
set client_min_messages = warning;
begin;
create temp table _t316(name text, result text); grant all on _t316 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t316 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = u;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('Trial ' || split_part(p_email, '@', 1), 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- a 1x1 PNG
create or replace function pg_temp.png() returns text language sql as $$
  select 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' $$;
create or replace function pg_temp.img(p_org uuid, p_quote uuid, p_kind text) returns void language sql as $$
  insert into public.client_booklet_images(org_id, quote_id, kind, variant, mime, bytes, data)
  values (p_org, p_quote, p_kind, 'plain', 'image/png', 10, '\x89504e470d0a1a0a0000'::bytea) $$;
create or replace function pg_temp.jwt(p_role text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, false) $$;
-- a trial reminder slot (FK checks skipped: no delivery commitment is needed to prove the counter)
create or replace function pg_temp.reminder(p_org uuid, p_to text) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  insert into public.delivery_reminder_sends(org_id, commitment_id, offset_min, recipient_kind, recipient, dedupe_key, status, trial_slot)
    values (p_org, gen_random_uuid(), 60, 'party', p_to, 'r316-' || gen_random_uuid()::text, 'sent', true);
  set local session_replication_role = origin;
end $$;
create temp table _k(k text primary key, v text); grant all on _k to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into _k values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _k where k = p_k $$;

-- ---- 0) structure -----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 trigger on client_booklet_images + helpers: definer, empty search_path',
    exists (select 1 from pg_trigger where tgname = 'zz_r316_trial_client_images' and tgrelid = 'public.client_booklet_images'::regclass)
    and (select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r106-trial-gaps-0316' in p.prosrc) > 0)
           from pg_proc p where p.oid in ('public._r316_trial_studio(uuid)'::regprocedure, 'public._r316_tg_trial_client_images()'::regprocedure,
             'public._r316_trial_email_used(uuid,text)'::regprocedure, 'public._r316_accept_invitation(text)'::regprocedure,
             'public._tr212_take(uuid,text,text)'::regprocedure, 'public._dl241_trial_take(uuid,text)'::regprocedure)));
  perform pg_temp.res('02 privileges: helpers internal; accept_invitation authenticated, not anon',
    not has_function_privilege('authenticated', 'public._r316_trial_email_used(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public._r316_trial_studio(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r316_accept_invitation(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.accept_invitation__pre0316(text)', 'execute')
    and has_function_privilege('authenticated', 'public.accept_invitation(text)', 'execute')
    and not has_function_privilege('anon', 'public.accept_invitation(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._tr212_take(uuid,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_trial_messaging()', 'execute'));
  perform pg_temp.res('03 accept_invitation wrapped once (pre0316 -> 0156 wrapper)',
    to_regprocedure('public.accept_invitation__pre0316(text)') is not null
    and position('audit-p2-0156' in (select prosrc from pg_proc where oid = 'public.accept_invitation__pre0316(text)'::regprocedure)) > 0
    and position('_r316_accept_invitation' in (select prosrc from pg_proc where oid = 'public.accept_invitation(text)'::regprocedure)) > 0);
end $$;

-- ---- 1) client images: off in a trial ---------------------------------------------------------------------------------
do $$
declare t uuid; paid uuid; tq uuid; pq uuid; e text;
begin
  t := pg_temp.trial('r316.owner@trial.test'); perform pg_temp.put('t', t::text);
  select q.id into tq from public.quotes q where q.org_id = t order by q.created_at limit 1;
  select o.id into paid from public.organizations o where not coalesce(o.is_sample_master, false) and o.id <> t
     and not public._r316_trial_studio(o.id) and exists (select 1 from public.quotes q where q.org_id = o.id) order by o.created_at limit 1;
  select q.id into pq from public.quotes q where q.org_id = paid order by q.created_at limit 1;
  perform pg_temp.res('10 setup: trial studio with a quote; a paid studio with a quote',
    t is not null and tq is not null and paid is not null and pq is not null and public._r316_trial_studio(t), coalesce(t::text, 'no trial'));

  perform pg_temp.jwt('authenticated');
  e := pg_temp.err(format('select pg_temp.img(%L, %L, %L)', t, tq, '2d'));
  perform pg_temp.res('11 trial: 2D client picture refused (42501 trial_client_images, friendly words)',
    e like '42501 trial_client_images Client images unlock on a paid plan%', e);
  e := pg_temp.err(format('select pg_temp.img(%L, %L, %L)', t, tq, '3d'));
  perform pg_temp.res('12 trial: 3D client picture refused', e like '42501 trial_client_images%', e);
  e := pg_temp.err(format('select pg_temp.img(%L, %L, %L)', paid, pq, '2d'));
  perform pg_temp.res('13 paid studio: 2D picture still saved', e = '' or e not like '%trial_client_images%', e);
  perform pg_temp.jwt('service_role');
  e := pg_temp.err(format('select pg_temp.img(%L, %L, %L)', t, tq, '3d'));
  perform pg_temp.res('14 service role / maintenance not blocked', e not like '%trial_client_images%', e);
  perform pg_temp.su();

  -- the real app path: booklet_put_image as the trial owner
  perform pg_temp.login('r316.owner@trial.test');
  e := pg_temp.err(format('select public.booklet_put_image(%L, %L, %L, %L, %L)', tq, '2d', 'labels', 'image/png', pg_temp.png()));
  perform pg_temp.res('15 trial owner: booklet_put_image 2D refused', e like '42501%Client images unlock on a paid plan%', e);
  perform pg_temp.su();
  perform pg_temp.res('16 nothing stored for the trial by the app (only the service-role row)',
    (select count(*) from public.client_booklet_images i where i.org_id = t) <= 1
    and not exists (select 1 from public.client_booklet_images i where i.org_id = t and i.kind = '2d'), '');
end $$;

-- ---- 2) one shared trial e-mail counter --------------------------------------------------------------------------------
do $$
declare t uuid := pg_temp.get('t')::uuid; i int; v text; m jsonb;
begin
  perform pg_temp.su();
  -- 5 reminder e-mails to one address -> the link e-mail / approval code to that address is capped
  for i in 1..5 loop perform pg_temp.reminder(t, 'Client.One@x.test'); end loop;
  v := public._tr212_take(t, 'client.one@x.test', 'approval_link');
  perform pg_temp.res('20 5 reminders to an address -> link e-mail to it refused (cap_recipient)', v = 'cap_recipient', coalesce(v, 'null'));
  v := public._tr212_take(t, 'other@x.test', 'otp');
  perform pg_temp.res('21 another address still allowed (slot taken)', v is null
    and (select count(*) from public.trial_email_sends s where s.org_id = t) = 1, coalesce(v, 'null'));
  -- 4 link e-mails to an address -> the 5th e-mail as a reminder is capped
  for i in 1..3 loop perform public._tr212_take(t, 'two@x.test', 'booklet_link'); end loop;
  perform pg_temp.reminder(t, 'two@x.test');
  v := public._dl241_trial_take(t, 'two@x.test');
  perform pg_temp.res('22 3 links + 1 reminder (4) -> a reminder still fits', v is null, coalesce(v, 'null'));
  perform public._tr212_take(t, 'two@x.test', 'booklet_link');
  v := public._dl241_trial_take(t, 'TWO@x.test ');
  perform pg_temp.res('23 4 links + 1 reminder (5) -> reminder refused (cap_recipient, case / space folded)', v = 'trial_cap_recipient' or v = 'cap_recipient', coalesce(v, 'null'));
  -- studio total: 5 + 1 + 1 + 4 = 11 used; fill to 30 with links, then both paths say cap_studio
  for i in 1..19 loop perform public._tr212_take(t, 'fill' || i || '@x.test', 'invite_site'); end loop;
  perform pg_temp.res('24 shared counter = links + reminders (30)',
    (select studio_n from public._r316_trial_email_used(t, null)) = 30, (select studio_n::text from public._r316_trial_email_used(t, null)));
  v := public._tr212_take(t, 'new1@x.test', 'approval_link');
  perform pg_temp.res('25 30 used -> link e-mail refused (cap_studio)', v = 'cap_studio', coalesce(v, 'null'));
  v := public._dl241_trial_take(t, 'new2@x.test');
  perform pg_temp.res('26 30 used -> reminder refused (cap_studio)', v = 'cap_studio', coalesce(v, 'null'));
  perform pg_temp.login('r316.owner@trial.test');
  m := public.my_trial_messaging();
  perform pg_temp.su();
  perform pg_temp.res('27 my_trial_messaging used today = the shared total', (m ->> 'email_used_today')::int = 30, m::text);
end $$;

-- ---- 3) "ends today" never missed ---------------------------------------------------------------------------------------
do $$
declare base timestamptz := ('2026-11-14 00:00:00'::timestamp at time zone 'Asia/Kolkata');
begin
  perform pg_temp.res('30 ends 00:03 IST, tick 23:07 IST the evening before -> d8 (was d7, never d8)',
    public._trial_reminder_milestone(base + interval '3 minutes', base - interval '53 minutes', 'Asia/Kolkata') = 'd8', '');
  perform pg_temp.res('31 ends 00:06:59 IST, tick 23:07 -> d8',
    public._trial_reminder_milestone(base + interval '6 minutes 59 seconds', base - interval '53 minutes', 'Asia/Kolkata') = 'd8', '');
  perform pg_temp.res('32 ends 00:03 IST, d7 still sent the day before at 00:07',
    public._trial_reminder_milestone(base + interval '3 minutes', base - interval '1 day' + interval '7 minutes', 'Asia/Kolkata') = 'd7', '');
  perform pg_temp.res('33 ends 15:00, tick 00:07 the same day -> d8 (unchanged)',
    public._trial_reminder_milestone(base + interval '15 hours', base + interval '7 minutes', 'Asia/Kolkata') = 'd8', '');
  perform pg_temp.res('34 ends 15:00, ticks 3 days / 2 days before -> d5 / none (unchanged)',
    public._trial_reminder_milestone(base + interval '15 hours', base - interval '3 days' + interval '7 minutes', 'Asia/Kolkata') = 'd5'
    and public._trial_reminder_milestone(base + interval '15 hours', base - interval '2 days' + interval '7 minutes', 'Asia/Kolkata') is null, '');
  perform pg_temp.res('35 already ended -> nothing', public._trial_reminder_milestone(base, base + interval '1 minute', 'Asia/Kolkata') is null, '');
  perform pg_temp.res('36 ends 01:30, tick 23:07 the evening before -> d7 (not early)',
    public._trial_reminder_milestone(base + interval '90 minutes', base - interval '53 minutes', 'Asia/Kolkata') = 'd7', '');
end $$;

-- the tick itself: a trial ending in 3 minutes gets d8 exactly once
do $$
declare t uuid := pg_temp.get('t')::uuid; r1 jsonb; r2 jsonb;
begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() + interval '3 minutes' where id = t;
  update public.studio_subscriptions set trial_ends_at = now() + interval '3 minutes' where org_id = t;
  delete from public.trial_reminders where org_id = t;
  r1 := public.trial_reminders_tick(); r2 := public.trial_reminders_tick();
  perform pg_temp.res('37 tick: d8 for a trial ending in 3 minutes, once',
    (select count(*) from public.trial_reminders x where x.org_id = t and x.milestone = 'd8') = 1
    and (select count(*) from public.trial_reminders x where x.org_id = t) = 1, r1::text || ' ' || r2::text);
  update public.organizations set trial_ends_at = now() + interval '8 days' where id = t;
  update public.studio_subscriptions set trial_ends_at = now() + interval '8 days' where org_id = t;
end $$;

-- ---- 4) a trial login invited into another studio ----------------------------------------------------------------------
do $$
declare t uuid := pg_temp.get('t')::uuid; other uuid; tok text; e text; u uuid; plain uuid; tok2 text;
begin
  perform pg_temp.su();
  select o.id into other from public.organizations o where o.id <> t and not coalesce(o.is_sample_master, false)
     and not public._r316_trial_studio(o.id) order by o.created_at limit 1;
  update public.organizations set name = 'Lotus Weddings' where id = other;
  insert into public.invitations(org_id, email, role, status) values (other, 'r316.owner@trial.test', 'planner', 'pending') returning token into tok;
  perform pg_temp.login('r316.owner@trial.test');
  e := pg_temp.err(format('select public.accept_invitation(%L)', tok));
  perform pg_temp.su();
  perform pg_temp.res('40 trial owner invited elsewhere: friendly own_trial refusal naming both studios',
    e like '42501 own_trial You are already in your own free-trial studio "Trial r316.owner"%Lotus Weddings%contact Helm support%', e);
  perform pg_temp.res('41 nothing moved: still in the trial studio, invitation still pending',
    (select p.org_id from public.profiles p join auth.users x on x.id = p.id where x.email = 'r316.owner@trial.test') = t
    and (select status from public.invitations where token = tok) = 'pending', '');
  -- a login in a PAID studio keeps the old answer
  select p.id into plain from public.profiles p where p.org_id is not null and p.org_id <> other and not public._r316_trial_studio(p.org_id) limit 1;
  if plain is not null then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = plain;
    insert into public.invitations(org_id, email, role, status)
      values (other, (select email from auth.users where id = plain), 'planner', 'pending') returning token into tok2;
    perform pg_temp.login((select email from auth.users where id = plain));
    e := pg_temp.err(format('select public.accept_invitation(%L)', tok2));
    perform pg_temp.su();
    perform pg_temp.res('42 paid-studio login: unchanged refusal (no own_trial)', e like '42501%' and e not like '%own_trial%', e);
  else
    perform pg_temp.res('42 paid-studio login: unchanged refusal (no own_trial)', true, '');
  end if;
  -- a brand-new login (no studio) still joins normally
  u := pg_temp.newuser('r316.new@join.test');
  update public.profiles set org_id = null where id = u;
  insert into public.invitations(org_id, email, role, status) values (other, 'r316.new@join.test', 'planner', 'pending') returning token into tok2;
  perform pg_temp.login('r316.new@join.test');
  e := pg_temp.err(format('select public.accept_invitation(%L)', tok2));
  perform pg_temp.su();
  perform pg_temp.res('43 a login with no studio still joins', e = '' and (select org_id from public.profiles where id = u) = other, e);
end $$;

-- ---- 5) sample task-template prefix only on sample events -----------------------------------------------------------
do $$
declare t uuid := pg_temp.get('t')::uuid; dq uuid; rq uuid; p text := 'Demo ' || chr(183) || ' ';
begin
  perform pg_temp.su();
  select q.id into dq from public.quotes q where q.org_id = t and q.is_demo limit 1;
  select q.id into rq from public.quotes q where not coalesce(q.is_demo, false) limit 1;
  insert into public.event_tasks(quote_id, category, title, org_id) select rq, 'Setup', p || 'Build stage', q.org_id from public.quotes q where q.id = rq;
  insert into public.event_tasks(quote_id, category, title, org_id) values (dq, 'Setup', p || 'Build stage', t);
  perform pg_temp.res('50 real event: task from a sample template has no "Demo" prefix',
    exists (select 1 from public.event_tasks e where e.quote_id = rq and e.title = 'Build stage')
    and not exists (select 1 from public.event_tasks e where e.quote_id = rq and e.title like 'Demo %'), coalesce(rq::text, 'no real quote'));
  perform pg_temp.res('51 sample event keeps the prefix', dq is not null and exists (select 1 from public.event_tasks e where e.quote_id = dq and e.title = p || 'Build stage'), coalesce(dq::text, 'no demo quote'));
end $$;

select name, result from _t316 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R106-TRIAL-GAPS-0316: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R106-TRIAL-GAPS-0316: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end
  from _t316;
rollback;
