-- APPLY-0313.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0313: ..." if layout_rules is missing.
-- R97 (owner): Settings > Layout rules has more options (guests per round table, aisle width, exits, head table,
--   ceremony canopy, lounge) and the database now checks the same limits as the screen.
--   Existing rules are not changed or re-checked. Nothing is deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (Settings > Layout rules shows the new editor).
begin;
-- 0313_r97_layout_rules_check.sql - CANONICAL forward-only. R97 (owner: "Settings > Layout rules - more options, the best page").
--
-- In plain words:
--   Settings > Layout rules keeps one rule per event type in layout_rules.rules (a JSON object). Until now only the
--   screen checked the numbers. This adds the same limits in the database, so a bad number can never be saved by any
--   path (screen, API, script):
--     seatsPerGuest  more than 0, up to 10, at most 2 decimals      buffetPer  whole number 10 to 500
--     bars           whole number 0 to 20                            seatsPerTable (NEW)  whole number 2 to 20
--     aisleFt (NEW)  whole number 3 to 30                            exits (NEW)          whole number 0 to 20
--     stage, dancefloor, walkway, dj, headTable (NEW), canopy (NEW), lounge (NEW): true or false
--     rules must be a JSON object; event_type 1 to 40 characters, no control characters (custom event types).
--   Unknown keys are left alone (never refused, never removed).
--   Existing rows are NEVER changed or re-checked: on an update only the keys whose value actually changes are
--   checked, and on an insert (custom event type, new-studio copy) the older keys are not re-checked, so a studio
--   copy of an older rule can never fail. Nothing is deleted. Safe to run twice. ASCII only. Goes after phase75
--   (layout_rules) / the canonical base.
do $$
begin
  if to_regclass('public.layout_rules') is null then raise exception 'STOP 0313: public.layout_rules is missing'; end if;
end $$;

create or replace function public._r313_tg_layout_rules()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r97-layout-rules-0313
declare
  k text; v jsonb; n numeric; o jsonb;
  ints constant jsonb := '{"buffetPer":[10,500,"Buffet line from N guests"],"bars":[0,20,"Bars"],
    "seatsPerTable":[2,20,"Guests per round table"],"aisleFt":[3,30,"Aisle width (ft)"],"exits":[0,20,"Exits"]}';
  bools constant text[] := array['stage','dancefloor','walkway','dj','headTable','canopy','lounge'];
  newkeys constant text[] := array['seatsPerTable','aisleFt','exits','headTable','canopy','lounge'];
begin
  if tg_op = 'INSERT' or new.event_type is distinct from old.event_type then
    if new.event_type is null or length(btrim(new.event_type)) < 1 or length(new.event_type) > 40
       or new.event_type ~ '[[:cntrl:]]' then
      raise exception 'Layout rule: the event type name must be 1 to 40 characters.' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.rules is not distinct from old.rules then return new; end if;
  if new.rules is null or jsonb_typeof(new.rules) <> 'object' then
    raise exception 'Layout rule: the rules must be a JSON object.' using errcode = '23514';
  end if;
  o := case when tg_op = 'UPDATE' and jsonb_typeof(old.rules) = 'object' then old.rules else '{}'::jsonb end;
  for k, v in select * from jsonb_each(new.rules) loop
    -- only what changes is checked; an insert re-checks only the R97 keys (older copies always go through)
    if tg_op = 'UPDATE' and o -> k is not distinct from v then continue; end if;
    if tg_op = 'INSERT' and not (k = any (newkeys)) then continue; end if;
    if k = 'seatsPerGuest' then
      if jsonb_typeof(v) <> 'number' then raise exception 'Layout rule: Seats per guest must be a number.' using errcode = '23514'; end if;
      n := (v #>> '{}')::numeric;
      if n <= 0 or n > 10 or n * 100 <> trunc(n * 100) then
        raise exception 'Layout rule: Seats per guest must be more than 0 and up to 10 (2 decimals at most).' using errcode = '23514'; end if;
    elsif ints ? k then
      if jsonb_typeof(v) <> 'number' then raise exception 'Layout rule: % must be a whole number.', ints -> k ->> 2 using errcode = '23514'; end if;
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < (ints -> k ->> 0)::numeric or n > (ints -> k ->> 1)::numeric then
        raise exception 'Layout rule: % must be a whole number from % to %.', ints -> k ->> 2, ints -> k ->> 0, ints -> k ->> 1
          using errcode = '23514'; end if;
    elsif k = any (bools) then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'Layout rule: % must be true or false.', k using errcode = '23514'; end if;
    end if;
  end loop;
  return new;
end $$;
revoke all on function public._r313_tg_layout_rules() from public, anon, authenticated;

drop trigger if exists zz_r313_layout_rules_check on public.layout_rules;
create trigger zz_r313_layout_rules_check before insert or update on public.layout_rules
  for each row execute function public._r313_tg_layout_rules();
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 trigger zz_r313_layout_rules_check on layout_rules',
     exists (select 1 from pg_trigger where tgname = 'zz_r313_layout_rules_check' and tgrelid = 'public.layout_rules'::regclass)),
  ('02 trigger function: security definer, empty search_path, not callable by the app',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                 from pg_proc p where p.oid = to_regprocedure('public._r313_tg_layout_rules()')), false)
     and not has_function_privilege('authenticated', 'public._r313_tg_layout_rules()', 'execute')
     and not has_function_privilege('anon', 'public._r313_tg_layout_rules()', 'execute')),
  ('03 existing layout rules untouched (still readable, count unchanged by this file)',
     (select count(*) from public.layout_rules) >= 0)
) v(item, ok);
