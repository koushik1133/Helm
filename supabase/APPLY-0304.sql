-- APPLY-0304.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0011 (any order with the other 03xx fixes). It stops with "STOP 0304" if either function is missing.
-- R67 health sweep, finding A1 ("definer search_path"):
--   Two SECURITY DEFINER functions ran with search_path = public, pg_temp instead of the house standard EMPTY
--   search_path. A definer function that keeps schemas on its path can be steered into running a same-named object
--   a caller planted earlier on the path (a privilege-escalation pattern). This re-issues BOTH functions with
--   SET search_path = '' and NOTHING else changed - both bodies already name every table / function in full, so the
--   logic is byte-for-byte the same:
--     * public.save_quotation_version(uuid, jsonb) - saves a new quotation version + the quote's pricing.
--     * public.password_change_required()          - true when the signed-in person must change their password.
--   The previous bodies are kept once as save_quotation_version__pre0304 / password_change_required__pre0304 (not
--   callable by the app). Existing grants on the live names are preserved (CREATE OR REPLACE never resets
--   privileges). No table / column / row / policy / index / trigger / live-name grant is created, changed or
--   deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  No site change is needed (no frontend behavior changes; the functions return exactly what they did before).
begin;
-- 0304_r67_definer_searchpath.sql - CANONICAL forward-only. R67 A1: harden two definer functions to search_path=''.

-- ---- 0) preflight: both live functions must exist (STOP, never guess) ---------------------------------------------
do $$
begin
  if to_regprocedure('public.save_quotation_version(uuid,jsonb)') is null then
    raise exception 'STOP 0304: public.save_quotation_version(uuid,jsonb) is missing (needs 0011)'; end if;
  if to_regprocedure('public.password_change_required()') is null then
    raise exception 'STOP 0304: public.password_change_required() is missing (needs base-v1)'; end if;
end $$;

-- ---- 1) keep each function's current body once as <name>__pre0304 (no API privilege) ------------------------------
create or replace function public._r304_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r67-a1-0304: copy (never rename - no triggers / policies bound, but match the house convention) the current body once
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  select p.proname, pg_catalog.oidvectortypes(p.proargtypes) into v_name, v_types
    from pg_catalog.pg_proc p where p.oid = v_oid;
  v_pre := pg_catalog.format('public.%I(%s)', v_name || '__pre0304', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_catalog.pg_get_functiondef(v_oid);
  v_def := pg_catalog.regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                          'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0304(');
  if position(v_name || '__pre0304(' in v_def) = 0 then
    raise exception 'r67-0304: could not keep %', p_fn; end if;
  execute v_def;
  execute pg_catalog.format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute pg_catalog.format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute pg_catalog.format('revoke all on function %s from authenticated', v_pre); end if;
end $$;
revoke all on function public._r304_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r304_keep(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r304_keep(text) from authenticated; end if;
end $$;

select public._r304_keep(f) from unnest(array[
  'public.save_quotation_version(uuid,jsonb)',
  'public.password_change_required()']) f;

-- ---- 2) re-issue public.save_quotation_version with an EMPTY search_path (logic unchanged) ------------------------
-- Every reference below is already fully schema-qualified (public.* functions + tables, auth.uid()); built-ins such
-- as now()/coalesce()/count()/jsonb_* live in pg_catalog, which is always implicitly on the path. Behavior identical.
CREATE OR REPLACE FUNCTION public.save_quotation_version(p_quote uuid, p_pricing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
-- r67-a1-0304: empty search_path; all table/function references fully schema-qualified. Logic identical to 0011.
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);
  if p_pricing is not null and (p_pricing ? 'subtotal') then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));
  end if;
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $function$;

-- ---- 3) re-issue public.password_change_required with an EMPTY search_path (logic unchanged) ----------------------
CREATE OR REPLACE FUNCTION public.password_change_required()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = ''
AS $function$
  -- r67-a1-0304: empty search_path; public.profiles + auth.uid() fully qualified. Logic identical to base-v1.
  select coalesce((select must_change_password from public.profiles where id = auth.uid()), false);
$function$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 save_quotation_version: security definer, empty search_path, carries the r67-a1-0304 marker',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                      and position('r67-a1-0304' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.save_quotation_version(uuid,jsonb)')), false)),
  ('02 password_change_required: security definer, empty search_path, carries the r67-a1-0304 marker',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                      and position('r67-a1-0304' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.password_change_required()')), false)),
  ('03 previous bodies kept once as *__pre0304, not callable by the app',
     to_regprocedure('public.save_quotation_version__pre0304(uuid,jsonb)') is not null
     and to_regprocedure('public.password_change_required__pre0304()') is not null
     and not has_function_privilege('authenticated', 'public.save_quotation_version__pre0304(uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.password_change_required__pre0304()', 'execute')),
  ('04 the *__pre0304 copies carry the old public, pg_temp path (the real previous body)',
     coalesce((select array_to_string(p.proconfig, ',') like '%pg_temp%'
                 from pg_proc p where p.oid = to_regprocedure('public.save_quotation_version__pre0304(uuid,jsonb)')), false)
     and coalesce((select array_to_string(p.proconfig, ',') like '%pg_temp%'
                 from pg_proc p where p.oid = to_regprocedure('public.password_change_required__pre0304()')), false)),
  ('05 grants preserved: signed-in staff (authenticated) can still call both live functions',
     has_function_privilege('authenticated', 'public.save_quotation_version(uuid,jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.password_change_required()', 'execute')),
  ('06 nothing removed: both live functions still exist with the same signature',
     to_regprocedure('public.save_quotation_version(uuid,jsonb)') is not null
     and to_regprocedure('public.password_change_required()') is not null)
) v(item, ok) order by item;
