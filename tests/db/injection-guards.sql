-- injection-guards.sql — 0024: stored values that reach HTML/URL sinks are shape-checked.
-- Chat reaction emoji (no markup), chat media path (own storage key only, never an
-- outside URL), menu package dishes (always a list). Existing rows are untouched (NOT VALID).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ig; create temp table _ig(name text, result text); grant all on _ig to anon, authenticated;
drop table if exists _ig_ids; create temp table _ig_ids(k text primary key, v uuid); grant all on _ig_ids to anon, authenticated;

-- setup: a_staff posts in org A's broadcast channel
do $$ declare a_staff uuid; c uuid; m uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into a_staff from auth.users where email='a_staff@a.test';
  perform auth.login_as(a_staff);
  c := public.chat_ensure_broadcast();
  select (public.chat_send(c,'text','injection-guards probe',null,null,null,null)).id into m;
  execute 'reset role';
  insert into _ig_ids values ('conv', c), ('msg', m), ('staff', a_staff);
  perform auth.logout(); execute 'reset role';
end $$;

create or replace function pg_temp.as_staff() returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select v into u from _ig_ids where k='staff'; perform auth.login_as(u);
end $$;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from _ig_ids where k=p $$;

-- 1) every emoji the picker offers still works
do $$ declare e text; ok int := 0; begin
  foreach e in array array['👍','❤️','😂','😮','😢','🙏'] loop
    perform pg_temp.as_staff();
    begin perform public.chat_react(pg_temp.id('msg'), e, true); ok := ok + 1; exception when others then null; end;
  end loop;
  execute 'reset role';
  insert into _ig values('react: all 6 picker emojis accepted', case when ok=6 then 'PASS' else 'FAIL: '||ok||'/6' end);
end $$;

-- 2) markup as an "emoji" is refused (RPC and direct insert)
do $$ begin
  perform pg_temp.as_staff();
  perform public.chat_react(pg_temp.id('msg'), '<meta http-equiv="refresh" content="0;url=https://evil.example">', true);
  execute 'reset role'; insert into _ig values('react: HTML emoji via chat_react blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('react: HTML emoji via chat_react blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('react: HTML emoji via chat_react blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; begin
  execute 'reset role'; select org_id into o from public.chat_messages where id = pg_temp.id('msg');
  perform pg_temp.as_staff();
  insert into public.chat_reactions(message_id, user_id, org_id, emoji) values (pg_temp.id('msg'), auth.uid(), o, '<b>x</b>');
  execute 'reset role'; insert into _ig values('react: HTML emoji via direct insert blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('react: HTML emoji via direct insert blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('react: HTML emoji via direct insert blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.as_staff();
  perform public.chat_react(pg_temp.id('msg'), repeat('👍', 40), true);
  execute 'reset role'; insert into _ig values('react: over-long emoji blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('react: over-long emoji blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('react: over-long emoji blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

-- 3) chat media must be our own storage key
do $$ begin
  perform pg_temp.as_staff();
  perform public.chat_send(pg_temp.id('conv'),'image','map','https://attacker.supabase.co/storage/v1/object/public/p/pixel.png',null,null,null);
  execute 'reset role'; insert into _ig values('media: outside URL via chat_send blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('media: outside URL via chat_send blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('media: outside URL via chat_send blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; k text; begin
  execute 'reset role'; select org_id into o from public.chat_messages where id = pg_temp.id('msg');
  k := o::text || '/' || pg_temp.id('conv')::text || '/' || gen_random_uuid()::text || '.png';
  perform pg_temp.as_staff();
  perform public.chat_send(pg_temp.id('conv'),'image','photo',k,'image/png',null,null);
  execute 'reset role'; insert into _ig values('media: real storage key accepted','PASS');
exception when others then execute 'reset role'; insert into _ig values('media: real storage key accepted','FAIL: '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.as_staff();
  update public.chat_messages set kind='image', media_path='https://evil.example/x.png' where id = pg_temp.id('msg');
  execute 'reset role'; insert into _ig values('media: editing own message to an outside URL blocked','FAIL: stored');
exception when check_violation or insufficient_privilege then execute 'reset role'; insert into _ig values('media: editing own message to an outside URL blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('media: editing own message to an outside URL blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ declare o uuid; begin
  execute 'reset role'; select org_id into o from public.chat_messages where id = pg_temp.id('msg');
  perform pg_temp.as_staff();
  insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, media_path)
    values (pg_temp.id('conv'), o, auth.uid(), 'image', 'pixel', 'https://evil.example/pixel.png');
  execute 'reset role'; insert into _ig values('media: outside URL via direct insert blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('media: outside URL via direct insert blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('media: outside URL via direct insert blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.as_staff();
  update public.chat_messages set body='edited text' where id = pg_temp.id('msg');
  execute 'reset role'; insert into _ig values('media: normal edit of a text message still works','PASS');
exception when others then execute 'reset role'; insert into _ig values('media: normal edit of a text message still works','FAIL: '||sqlerrm); end $$;

-- 4) menu package dishes must be a list
do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  insert into public.menu_templates(tier, diet, name, dishes) values ('gold','veg','ig-bad','{"length":"<meta http-equiv=refresh>"}'::jsonb);
  execute 'reset role'; insert into _ig values('menu: non-list dishes blocked','FAIL: stored');
exception when check_violation then execute 'reset role'; insert into _ig values('menu: non-list dishes blocked','PASS');
  when others then execute 'reset role'; insert into _ig values('menu: non-list dishes blocked','FAIL: wrong error '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  insert into public.menu_templates(tier, diet, name, dishes) values ('premium','nonveg','ig-good','[{"name":"Paneer"}]'::jsonb);
  execute 'reset role'; insert into _ig values('menu: list of dishes accepted','PASS');
exception when others then execute 'reset role'; insert into _ig values('menu: list of dishes accepted','FAIL: '||sqlerrm); end $$;

-- 5) existing rows are never re-checked (NOT VALID) — nothing old can start failing
do $$ declare n int; begin
  execute 'reset role';
  select count(*) into n from pg_constraint
   where conname in ('chat_reactions_emoji_chk','chat_messages_media_path_chk','menu_templates_dishes_array_chk')
     and not convalidated;
  insert into _ig values('all three checks are NOT VALID (old rows untouched)', case when n=3 then 'PASS' else 'FAIL: '||n end);
end $$;

do $$ begin execute 'reset role'; perform auth.logout(); execute 'reset role';
  delete from public.menu_templates where name in ('ig-bad','ig-good'); end $$;
select name,result from _ig order by name;
select case when count(*) filter (where result like 'FAIL%')=0 and count(*)=12 then 'INJECTION-GUARDS: ALL PASS' else 'INJECTION-GUARDS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/12 ran' end from _ig;
