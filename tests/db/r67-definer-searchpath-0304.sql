-- r67-definer-searchpath-0304.sql - 0304: harden two SECURITY DEFINER functions to an EMPTY search_path.
-- Proves: (1) both live functions now run with search_path='' and still have the house grants;
-- (2) the previous bodies are kept once as *__pre0304 (not callable by the app);
-- (3) BEHAVIOR IDENTICAL - save_quotation_version and password_change_required return byte-identical
--     results through the live (empty search_path) function and through the __pre0304 copy (old path),
--     under identical state, and save_quotation_version still writes a quotation version + the quote's pricing;
-- (4) grants unchanged: authenticated can call both, anon cannot call save_quotation_version.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
-- re-apply twice (proves a re-run is safe / idempotent)
set client_min_messages = error;
\ir ../../supabase/migrations/0304_r67_definer_searchpath.sql
\ir ../../supabase/migrations/0304_r67_definer_searchpath.sql
set client_min_messages = warning;
begin;
drop table if exists _g304; create temp table _g304(name text, result text); grant all on _g304 to anon, authenticated;

create or replace function pg_temp.as_j(p_who text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; st text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  else perform auth.login_as((select id from auth.users where email = p_who)); end if;
  begin
    execute p_sql into v;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    v := jsonb_build_object('error', st, 'message', sqlerrm);
  end;
  perform auth.logout(); execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g304 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

-- qA = Studio A's fixture quote; a_admin is an admin in Studio A (can_edit + quotes.edit).
do $$
declare
  qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  a_admin uuid := (select id from auth.users where email = 'a_admin@a.test');
  pricing jsonb := '{"subtotal":200000,"discount":0,"gstPct":18}'::jsonb;
  r_live jsonb; r_pre jsonb; got_versions int; got_pricing jsonb;
begin
  execute 'reset role';

  -- 01 live save_quotation_version has an empty search_path and the 0304 marker
  perform pg_temp.t('01 save_quotation_version: empty search_path + 0304 marker',
    coalesce((select p.prosecdef
                     and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                     and position('r67-a1-0304' in p.prosrc) > 0
               from pg_proc p where p.oid = to_regprocedure('public.save_quotation_version(uuid,jsonb)')), false),
    (select coalesce(array_to_string(p.proconfig, ','), '<none>') from pg_proc p where p.oid = to_regprocedure('public.save_quotation_version(uuid,jsonb)')));

  -- 02 live password_change_required has an empty search_path and the 0304 marker
  perform pg_temp.t('02 password_change_required: empty search_path + 0304 marker',
    coalesce((select p.prosecdef
                     and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                     and position('r67-a1-0304' in p.prosrc) > 0
               from pg_proc p where p.oid = to_regprocedure('public.password_change_required()')), false),
    (select coalesce(array_to_string(p.proconfig, ','), '<none>') from pg_proc p where p.oid = to_regprocedure('public.password_change_required()')));

  -- 03 previous bodies kept once as *__pre0304, not callable by the app
  perform pg_temp.t('03 *__pre0304 copies kept, not callable by the app',
    to_regprocedure('public.save_quotation_version__pre0304(uuid,jsonb)') is not null
    and to_regprocedure('public.password_change_required__pre0304()') is not null
    and not has_function_privilege('authenticated', 'public.save_quotation_version__pre0304(uuid,jsonb)', 'execute')
    and (not exists (select 1 from pg_roles where rolname = 'anon')
         or not has_function_privilege('anon', 'public.save_quotation_version__pre0304(uuid,jsonb)', 'execute'))
    and not has_function_privilege('authenticated', 'public.password_change_required__pre0304()', 'execute'), null);

  -- 04 the __pre0304 copies carry the OLD path (public, pg_temp) - the backup is the real previous body
  perform pg_temp.t('04 *__pre0304 keep the old public, pg_temp path',
    coalesce((select array_to_string(p.proconfig, ',') like '%pg_temp%'
               from pg_proc p where p.oid = to_regprocedure('public.save_quotation_version__pre0304(uuid,jsonb)')), false)
    and coalesce((select array_to_string(p.proconfig, ',') like '%pg_temp%'
               from pg_proc p where p.oid = to_regprocedure('public.password_change_required__pre0304()')), false), null);

  -- 05 grants unchanged: authenticated can call both live functions
  perform pg_temp.t('05 authenticated can execute both live functions',
    has_function_privilege('authenticated', 'public.save_quotation_version(uuid,jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.password_change_required()', 'execute'), null);

  -- 06 anon cannot write a quotation version (refused 42501 by can_edit, not a visible privilege)
  perform pg_temp.t('06 anon cannot save_quotation_version',
    (pg_temp.as_j('anon', format('select public.save_quotation_version(%L, %L::jsonb)', qa, pricing)) ->> 'error') is not null, null);

  -- ===== BEHAVIOR IDENTICAL: run the live function, capture its effect, then the __pre0304 copy on the SAME start =====
  -- The __pre0304 copies are not callable by the app (asserted above). For the comparison only, grant execute to
  -- authenticated inside THIS transaction (rolled back at the end) so the backup can be called as the same user.
  execute 'reset role';
  grant execute on function public.save_quotation_version__pre0304(uuid,jsonb) to authenticated;
  grant execute on function public.password_change_required__pre0304() to authenticated;

  -- reset qA to a known baseline (no versions, fixture pricing)
  delete from public.quotation_versions where quote_id = qa;
  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = qa;

  -- live call (empty search_path)
  r_live := pg_temp.as_j('a_admin@a.test', format('select public.save_quotation_version(%L, %L::jsonb)', qa, pricing));
  select count(*), (select q.pricing from public.quotes q where q.id = qa) into got_versions, got_pricing
    from public.quotation_versions where quote_id = qa;
  perform pg_temp.t('07 live save_quotation_version returns Q1 + computed total and writes a version',
    r_live ->> 'label' = 'Q1' and (r_live ->> 'total')::numeric = 236000 and got_versions = 1
    and (got_pricing ->> 'total')::numeric = 236000, r_live::text || ' versions=' || got_versions);

  -- reset to the SAME baseline, then call the __pre0304 copy (old path) with identical input
  delete from public.quotation_versions where quote_id = qa;
  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}'::jsonb where id = qa;
  r_pre := pg_temp.as_j('a_admin@a.test', format('select public.save_quotation_version__pre0304(%L, %L::jsonb)', qa, pricing));
  perform pg_temp.t('08 __pre0304 (old path) returns an IDENTICAL result to the live function',
    r_pre = r_live, 'live=' || r_live::text || ' pre=' || r_pre::text);

  -- password_change_required: must change = true (to_jsonb gives a clean jsonb boolean scalar)
  update public.profiles set must_change_password = true where id = a_admin;
  perform pg_temp.t('09 password_change_required: live = __pre0304 = true when must_change_password = true',
    pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())')
      = pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required__pre0304())')
    and pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())') = 'true'::jsonb,
    pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())')::text);

  -- must change = false
  update public.profiles set must_change_password = false where id = a_admin;
  perform pg_temp.t('10 password_change_required: live = __pre0304 = false when must_change_password = false',
    pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())')
      = pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required__pre0304())')
    and pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())') = 'false'::jsonb,
    pg_temp.as_j('a_admin@a.test', 'select to_jsonb(public.password_change_required())')::text);

  -- 11 nothing removed: both live functions + their helpers still present
  perform pg_temp.t('11 both live functions still exist with the same signature',
    to_regprocedure('public.save_quotation_version(uuid,jsonb)') is not null
    and to_regprocedure('public.password_change_required()') is not null, null);
end $$;

select name, result from _g304 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R67-DEFINER-SEARCHPATH-0304: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R67-DEFINER-SEARCHPATH-0304: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g304;
rollback;
