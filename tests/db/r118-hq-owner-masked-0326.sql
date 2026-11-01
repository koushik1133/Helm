-- r118-hq-owner-masked-0326.sql -- R118 (HQ audit F-01): the Helm HQ "Studio owner" card (hq_studio_owner_info) and the
-- backfill flags (hq_studio_owner_flags) send every e-mail MASKED; "Show" = hq_reveal('member', user id, 'email'), which
-- checks the HQ role and writes the hq.reveal row. Proves: masked owner / admins / history (owner, previous owner,
-- changed-by), person ids for Show, no raw address anywhere in the answer, the hq.view row is still written, Show
-- returns the real address + one hq.reveal row, Sales (studios.read) may read + reveal, Viewer / a studio admin / anon
-- are refused, the flags list is masked, the kept __pre0326 copies have no app privilege, re-run safe.
-- Re-applies 0326 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0326_r118_hq_owner_masked.sql
\ir ../../supabase/migrations/0326_r118_hq_owner_masked.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); execute 'set role anon'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.mkuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  return u;
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

-- ---- setup: HQ Owner / Sales / Viewer, studio A with an owner, a second admin and two owner-history rows -------------------
do $$ declare o uuid; a2 uuid; prev uuid; v_org uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by, role) values ('r118sales@helm.events', 'test', 'sales'), ('r118view@helm.events', 'test', 'viewer')
    on conflict do nothing;
  perform pg_temp.mkuser(e) from unnest(array['admin@helm.events', 'r118sales@helm.events', 'r118view@helm.events']) e;
  o := pg_temp.uid('a_admin@a.test');
  a2 := pg_temp.mkuser('r118second@a.test'); prev := pg_temp.mkuser('r118former@a.test');
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (a2, 'r118second@a.test', 'Second Admin', 'admin', v_org, false, now()),
           (prev, 'r118former@a.test', 'Former Owner', 'coordinator', v_org, false, now() - interval '400 days')
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, email = excluded.email;
  insert into public.team_owner_log(org_id, user_id, prev_user_id, source, hq_flag, by_user, by_email, reason, at)
    values (v_org, prev, null, 'backfill_admin', true, null, null, 'r118 backfill', now() - interval '300 days'),
           (v_org, o, prev, 'hq_recovery', false, pg_temp.uid('admin@helm.events'), 'admin@helm.events', 'r118 recovered, identity checked by a call back', now() - interval '1 day');
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) the card: every e-mail masked, person ids for Show --------------------------------------------------------------
do $$ declare r jsonb; t text; h jsonb; n0 int; n1 int; v_org uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su(); select count(*) into n0 from public.audit_log where action = 'hq.view' and entity = 'hq_studio_owner' and entity_id = v_org::text;
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_studio_owner_info(v_org); t := r::text;
  perform pg_temp.su(); select count(*) into n1 from public.audit_log where action = 'hq.view' and entity = 'hq_studio_owner' and entity_id = v_org::text;
  perform pg_temp.res('01 owner: e-mail masked (a...@a.test), user id kept, name kept',
    r -> 'owner' ->> 'email' = 'a_' || chr(8226) || chr(8226) || chr(8226) || '@a.test'
    and (r -> 'owner' ->> 'user_id')::uuid = pg_temp.uid('a_admin@a.test') and r -> 'owner' ? 'name', t);
  perform pg_temp.res('02 admins: every e-mail masked, user ids kept',
    jsonb_array_length(r -> 'admins') >= 2
    and not exists (select 1 from jsonb_array_elements(r -> 'admins') a where position(chr(8226) in coalesce(a ->> 'email', chr(8226))) = 0 or a ->> 'user_id' is null), t);
  select x into h from jsonb_array_elements(r -> 'history') x where x ->> 'source' = 'hq_recovery' limit 1;
  perform pg_temp.res('03 history: owner / previous owner / changed-by masked; owner_user_id, prev_user_id, by_user_id for Show',
    h ->> 'owner_email' like 'a_' || chr(8226) || '%' and h ->> 'prev_email' = 'r1' || chr(8226) || chr(8226) || chr(8226) || '@a.test'
    and h ->> 'by_email' = 'ad' || chr(8226) || chr(8226) || chr(8226) || '@helm.events'
    and (h ->> 'owner_user_id')::uuid = pg_temp.uid('a_admin@a.test') and (h ->> 'prev_user_id')::uuid = pg_temp.uid('r118former@a.test')
    and (h ->> 'by_user_id')::uuid = pg_temp.uid('admin@helm.events') and h ->> 'reason' like 'r118 recovered%', coalesce(h::text, t));
  perform pg_temp.res('04 no raw address anywhere in the answer',
    position('a_admin@a.test' in t) = 0 and position('r118second@a.test' in t) = 0 and position('r118former@a.test' in t) = 0
    and position('admin@helm.events' in t) = 0, t);
  perform pg_temp.res('05 same answer shape as 0283 (+ masked:true): owner, owner_missing, admins, history',
    r ? 'owner' and r ? 'owner_missing' and r ? 'admins' and r ? 'history' and (r ->> 'masked')::boolean, t);
  perform pg_temp.res('06 reading the card still writes ONE hq.view row', n1 = n0 + 1, n0 || '->' || n1);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) Show = hq_reveal('member', id, 'email'): role check + hq.reveal row + the real value -------------------------------
do $$ declare r jsonb; n0 int; n1 int; e text; v_org uuid := 'a0000000-0000-4000-8000-000000000001'; v_prev uuid; begin
  perform pg_temp.su(); select count(*) into n0 from public.audit_log where action = 'hq.reveal'; v_prev := pg_temp.uid('r118former@a.test');
  perform pg_temp.as_user('r118sales@helm.events', 'aal2');
  r := public.hq_reveal('member', v_prev::text, 'email');
  perform pg_temp.su(); select count(*) into n1 from public.audit_log where action = 'hq.reveal';
  perform pg_temp.res('07 Show (Sales, studios.read): the real e-mail of a former owner + ONE hq.reveal row (field only)',
    r ->> 'value' = 'r118former@a.test' and n1 = n0 + 1
    and exists (select 1 from public.audit_log where action = 'hq.reveal' and entity = 'member' and entity_id = pg_temp.uid('r118former@a.test')::text
                 and changed = '{"field": "email"}'::jsonb and actor = pg_temp.uid('r118sales@helm.events')), coalesce(r::text, '') || ' ' || n0 || '->' || n1);
  perform pg_temp.as_user('r118sales@helm.events', 'aal2');
  r := public.hq_studio_owner_info(v_org);
  perform pg_temp.res('08 Sales reads the card masked too', r -> 'owner' ->> 'email' like '%' || chr(8226) || '%', r::text);
  perform pg_temp.as_user('r118view@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_studio_owner_info(%L)', v_org)) || '|' || pg_temp.try('select public.hq_studio_owner_flags()');
  perform pg_temp.res('09 Viewer (no studios.read) refused on the card and the flags', e like '42501%|42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  e := pg_temp.try(format('select public.hq_studio_owner_info(%L)', v_org));
  perform pg_temp.res('10 HQ without two-step (aal1) refused', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try(format('select public.hq_studio_owner_info(%L)', v_org)) || '|' || pg_temp.try('select public.hq_studio_owner_flags()');
  perform pg_temp.res('11 a studio admin (not HQ) refused', e like '42501%|42501%', e);
  perform pg_temp.as_anon();
  e := pg_temp.try(format('select public.hq_studio_owner_info(%L)', v_org));
  perform pg_temp.res('12 anon refused (no privilege)', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) the backfill flags, kept copies, structure ----------------------------------------------------------------------
do $$ declare f jsonb; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  f := public.hq_studio_owner_flags();
  perform pg_temp.su();
  perform pg_temp.res('13 flags: the flagged studio is listed, its owner_email masked, no raw address',
    exists (select 1 from jsonb_array_elements(f) x where x ->> 'org_id' = 'a0000000-0000-4000-8000-000000000001'
              and x ->> 'owner_email' = 'r1' || chr(8226) || chr(8226) || chr(8226) || '@a.test' and x ->> 'reason' = 'r118 backfill')
    and position('r118former@a.test' in f::text) = 0, coalesce(f::text, ''));
  perform pg_temp.res('14 the kept __pre0326 copies exist with no app privilege',
    to_regprocedure('public.hq_studio_owner_info__pre0326(uuid)') is not null and to_regprocedure('public.hq_studio_owner_flags__pre0326()') is not null
    and not has_function_privilege('authenticated', 'public.hq_studio_owner_info__pre0326(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.hq_studio_owner_flags__pre0326()', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_owner_flags__pre0326()', 'execute'));
  perform pg_temp.res('15 public functions: signed-in may call (role checked inside), anon may not; definer + empty search_path',
    has_function_privilege('authenticated', 'public.hq_studio_owner_info(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_owner_info(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.hq_studio_owner_flags()', 'execute')
    and (select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%') from pg_proc p
          where p.oid in ('public.hq_studio_owner_info(uuid)'::regprocedure, 'public.hq_studio_owner_flags()'::regprocedure)));
  perform pg_temp.res('16 re-run safe: applied twice, ONE kept copy each, public bodies carry the 0326 marker',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'hq_studio_owner_%__pre0326') = 2
    and pg_get_functiondef('public.hq_studio_owner_info(uuid)'::regprocedure) like '%r118-0326%'
    and pg_get_functiondef('public.hq_studio_owner_flags()'::regprocedure) like '%r118-0326%');
  perform pg_temp.res('17 hq_studio_owner_recover is untouched (0283 body)',
    pg_get_functiondef('public.hq_studio_owner_recover(uuid,text,text)'::regprocedure) not like '%r118-0326%');
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R118-HQ-OWNER-MASKED-0326: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R118-HQ-OWNER-MASKED-0326: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
