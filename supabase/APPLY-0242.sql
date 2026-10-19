-- APPLY-0242.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0240 (Insights benchmarks). phase29 / phase57 / phase97 are already on production.
-- One studio-wide "Target margin %" for the Insights Benchmarks card (owner, r21). TWO NEW functions:
-- get_studio_target_margin() (anyone with Insights or Control Center view) and set_studio_target_margin(pct)
-- (Control Center edit / admins only; 0 to 90). Stored as ONE additive app_config row per studio (key 'insights').
-- The pricing settings blob and every other row are untouched. No table / column / policy changed, nothing deleted.
-- Safe to run twice. ASCII only.
-- Deploy the site (insights.html / insights-costs.js / control.html / target-margin-settings.js / store-api.js) after
-- this; before it, Insights uses the 30% default and the Control Center field says "needs database update 0242".
--
-- PREVIEW (read-only, optional - run alone first; shows the functions do not exist yet = 0):
--   select count(*) from pg_proc where oid in (to_regprocedure('public.get_studio_target_margin()'),
--     to_regprocedure('public.set_studio_target_margin(numeric)'));
begin;
-- 0242_studio_target_margin.sql - CANONICAL forward-only.
-- REQUIRES phase29 / phase57 (has_area, current_org_id, user_role, app_config keyed by (org_id, key)),
--          0240 (Insights "Benchmarks" card that uses the target margin).
--
-- In plain words (owner, r21: "the target margin must be the same for everyone in the studio, set in Control Center"):
--   1  ONE studio-wide "Target margin %" for the Insights Benchmarks card (green / amber / red per event). It was
--      saved per device in the browser (default 30%); now it is saved once per studio on the server.
--   2  Stored as ONE additive app_config row per studio: key 'insights', value {"targetMarginPct": N}. A studio that
--      never sets it has no row and every screen uses the 30% default. The pricing blob ('pricing') and every other
--      app_config key are NOT touched; set_pricing_config / get_pricing_config are unchanged.
--   3  get_studio_target_margin(): signed-in studio member (not a client portal user) with the 'insights' OR the
--      'controls' area (view) - admins always. Returns { target_margin_pct (null = not set), default_pct 30,
--      can_edit, updated_at }. Only the caller's own studio (current_org_id()).
--   4  set_studio_target_margin(p_pct): only roles that can EDIT Control Center ('controls' edit) - admins always.
--      p_pct must be a number from 0 to 90 (kept to 1 decimal); anything else is refused with a plain message.
--      Upsert merges into the row (value || {...}), so any other key a later release keeps there is preserved.
--      The existing app_config audit trigger records the change.
--   Changes: 2 new functions. No table / column / policy changed, nothing deleted. Additive + idempotent
--   (create or replace). Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop function public.set_studio_target_margin(numeric);
--   drop function public.get_studio_target_margin(); the Insights page then falls back to the 30% default and the
--   Control Center field says "needs database update 0242". The saved app_config 'insights' rows can stay (unused).

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP: phase29 / phase57 (has_area, current_org_id, user_role) is not applied'; end if;
  if to_regclass('public.app_config') is null then raise exception 'STOP: public.app_config is missing'; end if;
  if not exists (select 1 from pg_index i where i.indrelid = 'public.app_config'::regclass and i.indisunique
                    and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                          where a.attrelid = i.indrelid and a.attnum = any (i.indkey)) = array['key', 'org_id']) then
    raise exception 'STOP: public.app_config has no unique (org_id, key) - phase97 is not applied'; end if;
end $$;

create or replace function public.get_studio_target_margin()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- studio-target-margin-0242
declare
  v_org uuid := public.current_org_id();
  v jsonb; v_at timestamptz; n numeric;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.user_role(), '') = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (public.has_area('insights', 'view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select c.value, c.updated_at into v, v_at from public.app_config c where c.org_id = v_org and c.key = 'insights';
  if jsonb_typeof(v -> 'targetMarginPct') = 'number' then n := (v ->> 'targetMarginPct')::numeric; end if;
  if n is not null and not (n >= 0 and n <= 90) then n := null; end if;   -- a hand-edited row out of range reads as "not set"
  return jsonb_build_object('target_margin_pct', n, 'default_pct', 30,
    'can_edit', public.has_area('controls', 'edit'), 'updated_at', case when n is not null then v_at end);
end $$;

create or replace function public.set_studio_target_margin(p_pct numeric)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-target-margin-0242
declare
  v_org uuid := public.current_org_id();
  v numeric;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Control Center) can change the target margin.' using errcode = '42501'; end if;
  if p_pct is null or p_pct = 'NaN'::numeric or not (p_pct >= 0 and p_pct <= 90) then
    raise exception 'Target margin must be a number from 0 to 90.' using errcode = '22023'; end if;
  v := round(p_pct, 1);
  insert into public.app_config(org_id, key, value, updated_at)
    values (v_org, 'insights', jsonb_build_object('targetMarginPct', v), now())
  on conflict (org_id, key) do update
    set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end)
                || jsonb_build_object('targetMarginPct', v),
        updated_at = now();
  return public.get_studio_target_margin();
end $$;

revoke all on function public.get_studio_target_margin() from public;
revoke all on function public.set_studio_target_margin(numeric) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.get_studio_target_margin() from anon';
    execute 'revoke all on function public.set_studio_target_margin(numeric) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.get_studio_target_margin() to authenticated';
    execute 'grant execute on function public.set_studio_target_margin(numeric) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.get_studio_target_margin() to service_role';
    execute 'grant execute on function public.set_studio_target_margin(numeric) to service_role'; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 both functions exist, security definer, empty search_path',
     coalesce((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) and count(*) = 2 from pg_proc p
                where p.oid in (to_regprocedure('public.get_studio_target_margin()'), to_regprocedure('public.set_studio_target_margin(numeric)'))), false)),
  ('02 signed-in only: authenticated may call, anon may not',
     has_function_privilege('authenticated', 'public.get_studio_target_margin()', 'execute')
     and has_function_privilege('authenticated', 'public.set_studio_target_margin(numeric)', 'execute')
     and not has_function_privilege('anon', 'public.get_studio_target_margin()', 'execute')
     and not has_function_privilege('anon', 'public.set_studio_target_margin(numeric)', 'execute')),
  ('03 set needs Control Center edit and checks 0 to 90; scoped to the caller studio',
     position('has_area(''controls'', ''edit'')' in (select prosrc from pg_proc where oid = to_regprocedure('public.set_studio_target_margin(numeric)'))) > 0
     and position('p_pct <= 90' in (select prosrc from pg_proc where oid = to_regprocedure('public.set_studio_target_margin(numeric)'))) > 0
     and position('current_org_id()' in (select prosrc from pg_proc where oid = to_regprocedure('public.set_studio_target_margin(numeric)'))) > 0),
  ('04 get needs Insights or Control Center view, own studio only',
     position('has_area(''insights'', ''view'')' in (select prosrc from pg_proc where oid = to_regprocedure('public.get_studio_target_margin()'))) > 0
     and position('c.org_id = v_org' in (select prosrc from pg_proc where oid = to_regprocedure('public.get_studio_target_margin()'))) > 0),
  ('05 pricing settings functions unchanged and still callable',
     has_function_privilege('authenticated', 'public.get_pricing_config()', 'execute')
     and has_function_privilege('authenticated', 'public.set_pricing_config(jsonb)', 'execute')),
  ('06 no studio has an out-of-range saved target',
     not exists (select 1 from public.app_config c where c.key = 'insights' and jsonb_typeof(c.value -> 'targetMarginPct') = 'number'
                   and not ((c.value ->> 'targetMarginPct')::numeric between 0 and 90)))
) v(item, ok) order by item;
