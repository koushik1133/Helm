-- r97-layout-rules-0313.sql - 0313: layout_rules.rules limits are checked by the database.
-- Proves: valid R97 keys save; out-of-range / wrong-type values are refused with a friendly message; only changed keys
-- are checked (a legacy out-of-range value that is not touched never blocks a save); inserts re-check only R97 keys
-- (new-studio copies never fail); custom event types insert under RLS for an admin and are refused for another studio;
-- unknown keys are kept; the trigger function is not callable by the app. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0313_r97_layout_rules_check.sql
\ir ../../supabase/migrations/0313_r97_layout_rules_check.sql
set client_min_messages = warning;
begin;
create temp table _t313(name text, result text); grant all on _t313 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t313 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return '';
exception when others then return sqlstate || ' | ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  r1 uuid := 'f3130000-0000-4000-8000-000000000001';
  r2 uuid := 'f3130000-0000-4000-8000-000000000002';
  e text; n int;
begin
  perform pg_temp.su();
  insert into public.layout_rules (id, org_id, event_type, seq, rules) values
    (r1, orgA, 'r97 wedding', 90, '{"seatsPerGuest":1,"buffetPer":75,"bars":1,"stage":true,"dancefloor":true,"walkway":true,"dj":true}'),
    -- a legacy row with an out-of-range value (an insert does not re-check the older keys - new-studio copies)
    (r2, orgA, 'r97 legacy', 91, '{"seatsPerGuest":0,"buffetPer":5,"bars":1,"custom":"keep me"}');
  perform pg_temp.res('01 insert with older out-of-range keys is allowed (copies never fail)',
    exists (select 1 from public.layout_rules where id = r2), '');

  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"seatsPerTable":10,"aisleFt":6,"exits":4,"headTable":true,"canopy":false,"lounge":true}' where id = %L$q$, r1));
  perform pg_temp.res('02 valid R97 keys save', e = '', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"seatsPerTable":1}' where id = %L$q$, r1));
  perform pg_temp.res('03 seatsPerTable 1 refused', e like '23514%Guests per round table%2 to 20%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"seatsPerTable":8.5}' where id = %L$q$, r1));
  perform pg_temp.res('04 seatsPerTable 8.5 refused (whole numbers)', e like '23514%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"aisleFt":31}' where id = %L$q$, r1));
  perform pg_temp.res('05 aisleFt 31 refused', e like '23514%Aisle%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"exits":"3"}' where id = %L$q$, r1));
  perform pg_temp.res('06 exits as text refused', e like '23514%whole number%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"headTable":"yes"}' where id = %L$q$, r1));
  perform pg_temp.res('07 headTable not boolean refused', e like '23514%true or false%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"seatsPerGuest":10.5}' where id = %L$q$, r1));
  perform pg_temp.res('08 seatsPerGuest 10.5 refused', e like '23514%Seats per guest%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"seatsPerGuest":0.333}' where id = %L$q$, r1));
  perform pg_temp.res('09 seatsPerGuest 3 decimals refused', e like '23514%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"buffetPer":501}' where id = %L$q$, r1));
  perform pg_temp.res('10 buffetPer 501 refused', e like '23514%10 to 500%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"bars":21}' where id = %L$q$, r1));
  perform pg_temp.res('11 bars 21 refused', e like '23514%Bars%', e);
  e := pg_temp.try(format($q$update public.layout_rules set rules = '[]' where id = %L$q$, r1));
  perform pg_temp.res('12 rules must be an object', e like '23514%JSON object%', e);

  -- legacy bad value untouched: changing another key still saves; unknown keys kept
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"bars":2,"lounge":true}' where id = %L$q$, r2));
  perform pg_temp.res('13 untouched legacy values never block a save', e = '', e);
  perform pg_temp.res('14 unknown keys kept', (select rules ->> 'custom' from public.layout_rules where id = r2) = 'keep me', '');
  e := pg_temp.try(format($q$update public.layout_rules set rules = rules || '{"buffetPer":6}' where id = %L$q$, r2));
  perform pg_temp.res('15 changing the legacy value to another bad value is refused', e like '23514%', e);
  e := pg_temp.try(format($q$update public.layout_rules set active = active where id = %L$q$, r2));
  perform pg_temp.res('16 non-rules update on a legacy row is fine', e = '', e);

  -- insert re-checks R97 keys + event type
  e := pg_temp.try($q$insert into public.layout_rules (org_id, event_type, rules) values ('a0000000-0000-4000-8000-000000000001', 'r97 bad', '{"seatsPerTable":50}')$q$);
  perform pg_temp.res('17 insert with a bad R97 key refused', e like '23514%', e);
  e := pg_temp.try($q$insert into public.layout_rules (org_id, event_type, rules) values ('a0000000-0000-4000-8000-000000000001', '', '{}')$q$);
  perform pg_temp.res('18 empty event type refused', e like '23514%event type%', e);
  e := pg_temp.try($q$insert into public.layout_rules (org_id, event_type, rules) values ('a0000000-0000-4000-8000-000000000001', repeat('x', 41), '{}')$q$);
  perform pg_temp.res('19 41-character event type refused', e like '23514%', e);

  -- RLS: an admin of studio A adds a custom event type; studio B cannot write into A
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.layout_rules (event_type, seq, rules) values ('r97 mehendi', 92, '{"seatsPerGuest":1,"buffetPer":100,"bars":0,"stage":false,"dancefloor":true,"walkway":false,"dj":true,"seatsPerTable":10}')$q$);
  perform pg_temp.res('20 studio admin adds a custom event type', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('21 custom type landed in studio A',
    exists (select 1 from public.layout_rules where event_type = 'r97 mehendi' and org_id = orgA), '');
  perform pg_temp.login('b_admin@b.test');
  update public.layout_rules set rules = '{}' where id = r1; get diagnostics n = row_count;
  perform pg_temp.su();
  perform pg_temp.res('22 another studio cannot change the rule (0 rows)', n = 0, n::text);

  perform pg_temp.res('23 trigger present + function not callable by the app',
    exists (select 1 from pg_trigger where tgname = 'zz_r313_layout_rules_check' and tgrelid = 'public.layout_rules'::regclass)
    and not has_function_privilege('authenticated', 'public._r313_tg_layout_rules()', 'execute')
    and not has_function_privilege('anon', 'public._r313_tg_layout_rules()', 'execute'), '');
  perform pg_temp.res('24 marker + empty search_path',
    (select position('r97-layout-rules-0313' in p.prosrc) > 0 and array_to_string(p.proconfig, ',') like '%search_path=""%'
       from pg_proc p where p.oid = 'public._r313_tg_layout_rules()'::regprocedure), '');
end $$;

select name, result from _t313 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R97-LAYOUT-RULES-0313: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R97-LAYOUT-RULES-0313: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t313;
rollback;
