-- link-windows.sql — 0022: public links stop working N days after the event.
-- invite / proposal / crew = event + 7 days; approval/portal stays event + 30 (existing).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _lw; create temp table _lw(name text, result text); grant all on _lw to anon, authenticated;

-- setup on quote A: published invitation + published proposal + crew link
do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  delete from public.event_sites where quote_id = 'a0000000-0000-4000-8000-00000000da01' or slug like 'lw-%';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  insert into public.event_sites(quote_id, slug, status, data)
    values ('a0000000-0000-4000-8000-00000000da01', 'lw-a', 'published', '{}'::jsonb);
  insert into public.event_proposal(quote_id, share_token, published)
    values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-0000000000cc', true)
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true;
  delete from public.work_tokens where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.work_tokens(token, quote_id, phone, name)
    values ('a0000000-0000-4000-8000-0000000000dd', 'a0000000-0000-4000-8000-00000000da01', '+919800000001', 'Crew A');
  perform auth.logout(); execute 'reset role';
end $$;

-- helper: set the event date as superuser
create or replace function pg_temp.set_event(d date, inv text) returns void language plpgsql as $$
begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.quotes set event_date = d where id = 'a0000000-0000-4000-8000-00000000da01';
  update public.event_sites set data = case when inv is null then '{}'::jsonb else jsonb_build_object('date', inv) end where slug = 'lw-a';
  perform auth.logout(); execute 'reset role';
end $$;
create or replace function pg_temp.anon_invite() returns text language plpgsql as $$
declare r text; begin
  execute 'reset role'; perform auth.login_anon();
  begin perform * from public.public_event_site('lw-a'); r := 'live'; exception when others then r := sqlerrm; end;
  execute 'reset role'; perform auth.logout(); execute 'reset role'; return r;
end $$;
create or replace function pg_temp.anon_proposal() returns text language plpgsql as $$
declare r text; begin
  execute 'reset role'; perform auth.login_anon();
  begin perform public.public_get_proposal('a0000000-0000-4000-8000-0000000000cc'); r := 'live'; exception when others then r := sqlerrm; end;
  execute 'reset role'; perform auth.logout(); execute 'reset role'; return r;
end $$;

do $$ declare r text; begin
  perform pg_temp.set_event(current_date + 30, null); r := pg_temp.anon_invite();
  insert into _lw values('invite: future event -> live', case when r='live' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(current_date - 6, null); r := pg_temp.anon_invite();
  insert into _lw values('invite: event 6 days ago -> still live', case when r='live' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(current_date - 9, null); r := pg_temp.anon_invite();
  insert into _lw values('invite: event 9 days ago -> ended', case when r ilike '%ended%' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(null, null); r := pg_temp.anon_invite();
  insert into _lw values('invite: no date anywhere -> live', case when r='live' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(null, (current_date - 9)::text); r := pg_temp.anon_invite();
  insert into _lw values('invite: falls back to invitation''s own date', case when r ilike '%ended%' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(current_date - 9, (current_date + 2)::text); r := pg_temp.anon_invite();
  insert into _lw values('invite: uses the LATER of quote/invitation dates', case when r='live' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(null, '2026-02-30'); r := pg_temp.anon_invite();
  insert into _lw values('invite: malformed invitation date never errors', case when r='live' then 'PASS' else 'FAIL: '||r end);
end $$;

-- photos follow the invitation window
do $$ declare n int; m int; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  delete from storage.objects where bucket_id='invite-media' and storage.filename(name)='lw.png';
  insert into storage.objects(bucket_id,name) values ('invite-media','a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/lw.png');
  perform pg_temp.set_event(current_date + 5, null);
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.event_sites set data = jsonb_build_object('photos', jsonb_build_array('https://x/storage/v1/object/public/invite-media/a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/lw.png')) where slug='lw-a';
  perform auth.login_anon(); select count(*) into n from storage.objects where bucket_id='invite-media' and storage.filename(name)='lw.png';
  perform pg_temp.set_event(current_date - 9, null);
  perform auth.login_as((select id from auth.users where email='a_admin@a.test')); execute 'reset role';
  update public.event_sites set data = jsonb_build_object('photos', jsonb_build_array('https://x/storage/v1/object/public/invite-media/a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/lw.png')) where slug='lw-a';
  perform auth.logout(); execute 'reset role';
  perform auth.login_anon(); select count(*) into m from storage.objects where bucket_id='invite-media' and storage.filename(name)='lw.png';
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  insert into _lw values('invite photos readable while live, hidden after', case when n=1 and m=0 then 'PASS' else 'FAIL: '||n||'/'||m end);
end $$;

do $$ declare r text; begin
  perform pg_temp.set_event(current_date + 3, null); r := pg_temp.anon_proposal();
  insert into _lw values('proposal: upcoming event -> live', case when r='live' then 'PASS' else 'FAIL: '||r end);
  perform pg_temp.set_event(current_date - 9, null); r := pg_temp.anon_proposal();
  insert into _lw values('proposal: event 9 days ago -> expired', case when r ilike '%expired%' then 'PASS' else 'FAIL: '||r end);
end $$;

-- crew link timing
do $$ declare e timestamptz; begin
  perform pg_temp.set_event(current_date + 20, null);
  select expires_at into e from public.work_tokens where token='a0000000-0000-4000-8000-0000000000dd';
  insert into _lw values('crew: event moved -> link re-timed to event + 7',
    case when e = public.client_link_deadline(current_date + 20, 'a0000000-0000-4000-8000-000000000001', 7) then 'PASS' else 'FAIL: '||e end);
  perform pg_temp.set_event(current_date - 30, null);
  select expires_at into e from public.work_tokens where token='a0000000-0000-4000-8000-0000000000dd';
  insert into _lw values('crew: past event -> still >= 2 days to open it',
    case when e > now() + interval '47 hours' and e < now() + interval '49 hours' then 'PASS' else 'FAIL: '||e end);
  execute 'reset role'; update public.work_tokens set revoked_at = now(), expires_at = now() - interval '1 minute' where token='a0000000-0000-4000-8000-0000000000dd';
  perform pg_temp.set_event(current_date + 40, null);
  select expires_at into e from public.work_tokens where token='a0000000-0000-4000-8000-0000000000dd';
  insert into _lw values('crew: revoked link is never revived', case when e < now() then 'PASS' else 'FAIL: '||e end);
end $$;

-- the original bodies are not callable directly
do $$ begin
  execute 'reset role'; perform auth.login_anon();
  perform * from public.public_event_site__base('lw-a');
  execute 'reset role'; insert into _lw values('anon cannot call the unguarded originals','FAIL: allowed');
exception when others then execute 'reset role'; insert into _lw values('anon cannot call the unguarded originals','PASS'); end $$;

do $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role';
  update public.quotes set event_date = null where id = 'a0000000-0000-4000-8000-00000000da01'; end $$;
select name,result from _lw order by name;
select case when count(*) filter (where result like 'FAIL%')=0 and count(*)=14 then 'LINK-WINDOWS: ALL PASS' else 'LINK-WINDOWS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/14 ran' end from _lw;
