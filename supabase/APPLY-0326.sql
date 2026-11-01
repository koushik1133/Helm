-- APPLY-0326.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0326: ..." if an earlier migration it builds on is missing (0277 / 0283 / 0298).
-- R118 (HQ audit F-01): the Helm HQ "Studio owner" card now gets every e-mail MASKED from the database (owner, admins,
--   earlier owners, changed-by); "Show" goes through hq_reveal, which checks the HQ role and writes the hq.reveal log row.
--   Functions only: no table, column, row or policy is changed or deleted. Safe to run twice. ASCII only.
--   Independent of 0325 (either order).
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end (5 rows) must say ok = true.
--   2  Deploy the site (R118). In Helm HQ open a TEST studio -> Studio owner: e-mails show as ab...@x.com with a Show
--      button; pressing Show adds "A masked detail was shown" in Security & activity.
begin;
-- 0326_r118_hq_owner_masked.sql - CANONICAL forward-only. R118 (HQ audit F-01).
-- REQUIRES 0283 (hq_studio_owner_info, hq_studio_owner_flags, team_owner_log, _r283_owner / _r283_name /
--          _r283_active_admin / _r283_is_off / _r283_has_mfa) and 0298 (_r57_mask_email, hq_reveal).
--
-- In plain words:
--   The Helm HQ studio drawer's "Studio owner" card showed the owner's e-mail, every earlier owner's e-mail and every
--   studio admin's e-mail IN CLEAR, and nothing was written to the HQ log. Every other HQ list already gets these
--   values masked from the database (0298: ab...@x.com) and "Show" goes through hq_reveal, which checks the HQ role,
--   writes the "hq.reveal" audit row and returns the real value in ONE step.
--   Now hq_studio_owner_info answers the same card with every e-mail MASKED (owner, admins, history owner / previous
--   owner / changed-by), and adds the person ids (owner_user_id, prev_user_id, by_user_id) so the page can ask
--   hq_reveal('member', <user id>, 'email') for one of them (studios.read, logged). hq_studio_owner_flags masks its
--   owner_email the same way. Nothing else in the answers changes (same keys, same order, same gates and hq.view row).
--   "Recover studio owner" (HQ Owner only) reveals the chosen admin's e-mail through hq_reveal (logged) before it
--   calls hq_studio_owner_recover, which is unchanged.
-- The previous bodies are kept once as <name>__pre0326 (no app privilege) - the house pattern (0298).
-- ZERO DATA LOSS: no table, column, row or policy is created, changed or deleted (functions + privileges only).
-- Additive + idempotent: safe to run twice. ASCII only. Independent of 0325.

-- ---- 0) preflight ---------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.hq_studio_owner_info(uuid)') is null or to_regprocedure('public.hq_studio_owner_flags()') is null
     or to_regclass('public.team_owner_log') is null then
    raise exception 'STOP 0326: studio owner (0283) missing - run 0283 first'; end if;
  if to_regprocedure('public._r283_owner(uuid)') is null or to_regprocedure('public._r283_name(uuid)') is null
     or to_regprocedure('public._r283_active_admin(uuid,uuid)') is null or to_regprocedure('public._r283_is_off(uuid,uuid)') is null
     or to_regprocedure('public._r283_has_mfa(uuid)') is null then
    raise exception 'STOP 0326: 0283 helpers missing - run 0283 first'; end if;
  if to_regprocedure('public._r57_mask_email(text)') is null or to_regprocedure('public.hq_reveal(text,text,text)') is null then
    raise exception 'STOP 0326: HQ masking (0298) missing - run 0298 first'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null then raise exception 'STOP 0326: HQ roles (0277) missing'; end if;
end $$;

-- ---- 1) keep each previous body once (__pre0326) --------------------------------------------------------------
-- wrap = true: the new function calls the kept body; if a re-run of 0283 put a plain body back under the public name,
-- that newer body becomes the kept one. wrap = false: re-issued in full; the FIRST kept copy stays.
do $$
declare r record; v_pub regprocedure; v_pre regprocedure;
begin
  for r in select * from (values ('hq_studio_owner_info', 'uuid', false), ('hq_studio_owner_flags', '', true)) x(fn, args, wrap) loop
    v_pub := to_regprocedure('public.' || r.fn || '(' || r.args || ')');
    v_pre := to_regprocedure('public.' || r.fn || '__pre0326(' || r.args || ')');
    if v_pub is not null and position('r118-0326' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      if v_pre is null then
        execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0326');
      elsif r.wrap then
        execute 'drop function ' || v_pre::text;
        execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0326');
      end if;
    end if;
    v_pre := to_regprocedure('public.' || r.fn || '__pre0326(' || r.args || ')');
    if r.wrap and v_pre is null then raise exception 'STOP 0326: %__pre0326 missing', r.fn; end if;
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
    end if;
  end loop;
end $$;

-- ---- 2) the studio owner card: e-mails masked, person ids for hq_reveal -----------------------------------------
create or replace function public.hq_studio_owner_info(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r118-0326: the 0283 answer (same gate, same hq.view row) with every e-mail masked (_r57_mask_email); the real one
-- only through hq_reveal('member', <user id>, 'email') - role check + hq.reveal row + value in one step
declare v_owner uuid;
begin
  perform public._hq27_require('studios.read', false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', 'hq_studio_owner', p_org::text, null, now() from auth.users u where u.id = auth.uid();
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'no such studio' using errcode = 'P0002'; end if;
  v_owner := public._r283_owner(p_org);
  return jsonb_build_object(
    'owner', case when v_owner is null then null else (select jsonb_build_object('user_id', p.id, 'name', public._r283_name(p.id),
                     'email', public._r57_mask_email(p.email), 'active', public._r283_active_admin(p_org, p.id))
                     from public.profiles p where p.id = v_owner) end,
    'owner_missing', v_owner is null or not public._r283_active_admin(p_org, v_owner),
    'admins', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', public._r283_name(p.id), 'email', public._r57_mask_email(p.email),
                          'active', not public._r283_is_off(p.id, p_org), 'two_step', public._r283_has_mfa(p.id)) order by p.created_at)
                          from public.profiles p where p.org_id = p_org and p.role = 'admin'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'source', l.source, 'hq_flag', l.hq_flag,
                          'owner_user_id', l.user_id, 'prev_user_id', l.prev_user_id, 'by_user_id', l.by_user,
                          'owner_email', public._r57_mask_email((select p.email from public.profiles p where p.id = l.user_id)),
                          'prev_email', public._r57_mask_email((select p.email from public.profiles p where p.id = l.prev_user_id)),
                          'by_email', public._r57_mask_email(l.by_email), 'reason', l.reason) order by l.id desc)
                          from public.team_owner_log l where l.org_id = p_org), '[]'::jsonb),
    'masked', true);
end $$;

-- ---- 3) the backfill flags: owner_email masked (the kept 0283 body gates + audits) -------------------------------
create or replace function public.hq_studio_owner_flags()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r118-0326: the 0283 list with owner_email masked
declare r jsonb;
begin
  perform public._hq27_require('studios.read', false);
  r := public.hq_studio_owner_flags__pre0326();
  if r is null or jsonb_typeof(r) <> 'array' then return r; end if;
  return coalesce((select jsonb_agg(case when jsonb_typeof(x.e -> 'owner_email') = 'string'
                                         then jsonb_set(x.e, '{owner_email}', to_jsonb(public._r57_mask_email(x.e ->> 'owner_email')))
                                         else x.e end order by x.n)
                     from jsonb_array_elements(r) with ordinality x(e, n)), '[]'::jsonb);
end $$;

-- ---- 4) grants: the same callers as 0283 (signed-in; the HQ role is checked inside) ------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.hq_studio_owner_info(uuid)', 'public.hq_studio_owner_flags()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 hq_studio_owner_info(uuid) is the 0326 body (e-mails masked, person ids for Show)',
     to_regprocedure('public.hq_studio_owner_info(uuid)') is not null
     and pg_get_functiondef('public.hq_studio_owner_info(uuid)'::regprocedure) like '%r118-0326%'
     and pg_get_functiondef('public.hq_studio_owner_info(uuid)'::regprocedure) like '%_r57_mask_email(l.by_email)%'),
  ('02 hq_studio_owner_flags() is the 0326 wrapper and the 0283 body is kept as __pre0326',
     pg_get_functiondef('public.hq_studio_owner_flags()'::regprocedure) like '%r118-0326%'
     and to_regprocedure('public.hq_studio_owner_flags__pre0326()') is not null
     and to_regprocedure('public.hq_studio_owner_info__pre0326(uuid)') is not null),
  ('03 signed-in can call both (the HQ role is checked inside); anon cannot',
     has_function_privilege('authenticated', 'public.hq_studio_owner_info(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_studio_owner_flags()', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_owner_info(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_owner_flags()', 'execute')),
  ('04 the kept __pre0326 copies have no app privilege',
     not has_function_privilege('authenticated', 'public.hq_studio_owner_info__pre0326(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.hq_studio_owner_flags__pre0326()', 'execute')
     and not has_function_privilege('anon', 'public.hq_studio_owner_flags__pre0326()', 'execute')),
  ('05 masking helper + hq_reveal (0298) are in place',
     public._r57_mask_email('owner@studio.test') = 'ow' || chr(8226) || chr(8226) || chr(8226) || '@studio.test'
     and to_regprocedure('public.hq_reveal(text,text,text)') is not null)
) v(item, ok);
