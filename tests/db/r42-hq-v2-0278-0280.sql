-- r42-hq-v2-0278-0280.sql -- R42 Helm HQ v2 SQL: hq_log_reveal (0278) and public_pricing_plans / hq_my_session /
-- _hq27_sessions_of + sid / studio credits (0280). Gates (HQ staff + aal2 + 0277 role matrix + fresh code), audit rows,
-- never anon, credits never deleted / rewritten, STOP without 0277, re-run safe. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
-- re-apply both files twice inside the test (re-run safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0278_hq_reveal_log.sql
\ir ../../supabase/migrations/0280_hq_v2_round2.sql
\ir ../../supabase/migrations/0278_hq_reveal_log.sql
\ir ../../supabase/migrations/0280_hq_v2_round2.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal) || coalesce(p_extra, '{}'::jsonb))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); execute 'set role anon'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.mkuser(p_email text) returns void language plpgsql as $$
begin
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
end $$;
create or replace function pg_temp.fresh() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint))) $$;
create or replace function pg_temp.stale() returns jsonb language sql as $$
  select jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 hour')::bigint))) $$;
-- the studio used below, read once as the database owner (RLS would hide it from an HQ person's own session)
select set_config('r42.org', (select id::text from public.organizations order by created_at, id limit 1), false);
create or replace function pg_temp.org() returns uuid language sql as $$ select nullif(current_setting('r42.org', true), '')::uuid $$;
grant execute on function pg_temp.org() to anon, authenticated, service_role;

-- ---- setup: one HQ person per role, a studio user who is not HQ, a visible and a hidden plan --------------------------
do $$ begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by, role) values
    ('r42sales@helm.events', 'test', 'sales'), ('r42sec@helm.events', 'test', 'security'), ('r42sup@helm.events', 'test', 'support'),
    ('r42view@helm.events', 'test', 'viewer'), ('r42adm@helm.events', 'test', 'admin')
  on conflict do nothing;
  perform pg_temp.mkuser(e) from unnest(array['admin@helm.events', 'r42sales@helm.events', 'r42sec@helm.events', 'r42sup@helm.events',
                                              'r42view@helm.events', 'r42adm@helm.events', 'r42studio@a.test']) e;
  insert into public.helm_plans(code, name, price_monthly, currency, active, description, features, sort_order)
    values ('r42vis', 'R42 Visible', 59, 'USD', true, 'Visible plan', '["One", "Two"]'::jsonb, 1),
           ('r42hid', 'R42 Hidden', 9, 'USD', false, 'Hidden plan', '[]'::jsonb, 2)
  on conflict (code) do nothing;
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) hq_log_reveal (0278) ---------------------------------------------------------------------------------------------
do $$ declare e text; n0 int; n1 int; begin
  perform pg_temp.as_anon();
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')');
  perform pg_temp.res('01 reveal: anon refused (no privilege)', e like '42501%', e);
  perform pg_temp.as_user('r42studio@a.test', 'aal2');
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')');
  perform pg_temp.res('02 reveal: a signed-in studio user (not HQ) refused', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')');
  perform pg_temp.res('03 reveal: HQ Owner without two-step (aal1) refused', e like '42501%', e);
  perform pg_temp.su(); select count(*) into n0 from public.audit_log where action = 'hq.reveal';
  perform pg_temp.as_user('r42sales@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_log_reveal(''studio'', %L, ''email'')', pg_temp.org()::text));
  perform pg_temp.su(); select count(*) into n1 from public.audit_log where action = 'hq.reveal';
  perform pg_temp.res('04 reveal: Sales at aal2 on a studio e-mail - allowed, ONE audit row with the field name only',
    e = '' and n1 = n0 + 1 and exists (select 1 from public.audit_log where action = 'hq.reveal' and entity = 'studio'
      and entity_id = pg_temp.org()::text and changed = '{"field": "email"}'::jsonb
      and actor = (select id from auth.users where email = 'r42sales@helm.events')), e || ' n0=' || n0 || ' n1=' || n1);
  perform pg_temp.as_user('r42sales@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_log_reveal(''billing'', ''payments'', ''csv_export'')') || '|' || pg_temp.try('select public.hq_log_reveal(''person'', ''u1'', ''email'')');
  perform pg_temp.res('05 reveal: Sales refused on billing + people (0277 role matrix, HQ_ROLE)', e like '42501%HQ_ROLE%|42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r42view@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')');
  perform pg_temp.res('06 reveal: Viewer refused on studios', e like '42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r42sup@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_log_reveal(''person'', ''u1'', ''email'')') || '|' || pg_temp.try('select public.hq_log_reveal(''request'', ''r1'', ''phone'')');
  perform pg_temp.res('07 reveal: Support allowed on people + requests', e = '|', e);
  e := pg_temp.try('select public.hq_log_reveal(''secrets'', ''x'', ''email'')') || '|' || pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''Bad Field!'')');
  perform pg_temp.res('08 reveal: unknown kind or a bad field name refused (22023)', e like '22023%|22023%', e);
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'''' or 1=1 --'', ''email'')');
  perform pg_temp.su();
  perform pg_temp.res('09 reveal: an odd id is not stored (entity_id null), the call still logs',
    e = '' and exists (select 1 from public.audit_log where action = 'hq.reveal' and entity = 'studio' and entity_id is null
      and actor = (select id from auth.users where email = 'r42sup@helm.events')), e);
  perform pg_temp.res('10 reveal: never callable by anon, callable by signed-in (checked inside)',
    not has_function_privilege('anon', 'public.hq_log_reveal(text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_log_reveal(text,text,text)', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) public_pricing_plans (0280) --------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.as_anon();
  e := pg_temp.try('select public.public_pricing_plans()');
  r := public.public_pricing_plans();
  perform pg_temp.su();
  perform pg_temp.res('11 pricing: anyone (anon) may read; visible plan listed with its price, hidden plan left out',
    e = '' and exists (select 1 from jsonb_array_elements(r) p where p ->> 'code' = 'r42vis' and p ->> 'name' = 'R42 Visible'
      and exists (select 1 from jsonb_array_elements(p -> 'prices') x where x ->> 'currency' = 'USD' and (x ->> 'monthly')::numeric = 59))
    and not exists (select 1 from jsonb_array_elements(r) p where p ->> 'code' = 'r42hid'), e || ' ' || left(coalesce(r::text, ''), 300));
  perform pg_temp.res('12 pricing: only name / texts / prices - never Razorpay ids, ids or which studio is on a plan',
    not exists (select 1 from jsonb_array_elements(r) p, jsonb_object_keys(p) k where k not in ('code', 'name', 'description', 'features', 'sort_order', 'prices'))
    and position('razorpay' in lower(r::text)) = 0 and position('org_id' in r::text) = 0);
  perform pg_temp.res('13 pricing: read-only (stable), no write in the body',
    (select p.provolatile from pg_proc p where p.oid = to_regprocedure('public.public_pricing_plans()')) = 's');
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) hq_my_session + _hq27_sessions_of (0280) -------------------------------------------------------------------------
do $$ declare e text; r jsonb; v_sid uuid := gen_random_uuid(); v_uid uuid; begin
  perform pg_temp.as_anon();
  e := pg_temp.try('select public.hq_my_session()');
  perform pg_temp.res('14 my session: anon refused', e like '42501%', e);
  perform pg_temp.as_user('r42studio@a.test', 'aal2');
  e := pg_temp.try('select public.hq_my_session()');
  perform pg_temp.res('15 my session: a studio user (not HQ) refused', e like '42501%', e);
  perform pg_temp.as_user('r42view@helm.events', 'aal1');
  e := pg_temp.try('select public.hq_my_session()');
  perform pg_temp.res('16 my session: HQ Viewer at aal1 refused (two-step always)', e like '42501%', e);
  perform pg_temp.su(); select id into v_uid from auth.users where email = 'r42view@helm.events';
  insert into auth.sessions(id, user_id, created_at, user_agent, ip) values (v_sid, v_uid, now() - interval '1 hour', 'Firefox', '192.0.2.1');
  perform pg_temp.as_user('r42view@helm.events', 'aal2', jsonb_build_object('session_id', v_sid));
  r := public.hq_my_session();
  perform pg_temp.su();
  perform pg_temp.res('17 my session: Viewer at aal2 sees own session - short id, started, ends at the earlier of idle / max age',
    r ->> 'sid' = left(v_sid::text, 8) and (r ->> 'expires_at')::timestamptz <= (r ->> 'hard_end_at')::timestamptz
    and (r ->> 'hard_end_at')::timestamptz between now() + interval '10 hours' and now() + interval '12 hours'
    and (r ->> 'idle_minutes')::int = 30, coalesce(r::text, ''));
  r := public._hq27_sessions_of(v_uid);
  perform pg_temp.res('18 HQ team list: sessions carry the short id (sid), same fields as 0277 otherwise',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'sid' = left(v_sid::text, 8) and x ? 'since' and x ? 'seen' and x ? 'device' and x ? 'ip' and x ? 'current'), r::text);
  perform pg_temp.res('19 _hq27_sessions_of stays internal (not callable by anon / signed-in)',
    not has_function_privilege('authenticated', 'public._hq27_sessions_of(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._hq27_sessions_of(uuid)', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) studio credits (0280) --------------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; v_id uuid; n0 int; begin
  perform pg_temp.as_anon();
  e := pg_temp.try(format('select public.hq_studio_credits(%L)', pg_temp.org())) || '|' || pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''anon try'')', pg_temp.org()));
  perform pg_temp.res('20 credits: anon refused (read + grant)', e like '42501%|42501%', e);
  perform pg_temp.as_user('r42studio@a.test', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''studio user try'')', pg_temp.org()));
  perform pg_temp.res('21 credits: a studio user (not HQ) cannot grant', e like '42501%', e);
  perform pg_temp.as_user('r42sales@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_studio_credits(%L)', pg_temp.org())) || '|' || pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''sales try'')', pg_temp.org()));
  perform pg_temp.res('22 credits: Sales may read, may not grant (HQ_ROLE)', e like '|42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r42sec@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''security try'')', pg_temp.org()));
  perform pg_temp.res('23 credits: Security may not grant', e like '42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r42view@helm.events', 'aal2');
  e := pg_temp.try(format('select public.hq_studio_credits(%L)', pg_temp.org()));
  perform pg_temp.res('24 credits: Viewer may not even read', e like '42501%HQ_ROLE%', e);
  perform pg_temp.as_user('r42adm@helm.events', 'aal1', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''aal1 try'')', pg_temp.org()));
  perform pg_temp.res('25 credits: Admin without two-step (aal1) refused', e like '42501%', e);
  perform pg_temp.as_user('r42adm@helm.events', 'aal2', pg_temp.stale());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''stale code try'')', pg_temp.org()));
  perform pg_temp.res('26 credits: Admin with a two-step code from 1 h ago asked for a fresh one (HQ_REAUTH)', e like '42501%HQ_REAUTH%', e);
  perform pg_temp.as_user('r42adm@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''gift'', 1, ''bad kind'')', pg_temp.org()))
    || '|' || pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 13, ''too many months'')', pg_temp.org()))
    || '|' || pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''no'')', pg_temp.org()))
    || '|' || pg_temp.try('select public.hq_grant_studio_credit(gen_random_uuid(), ''promo'', 1, ''unknown studio'')');
  perform pg_temp.res('27 credits: bad kind / months / a missing reason / unknown studio refused (22023)', e like '22023%|22023%|22023%|22023%', e);
  perform pg_temp.su(); select count(*) into n0 from public.audit_log where action = 'hq.credit.grant';
  perform pg_temp.as_user('r42adm@helm.events', 'aal2', pg_temp.fresh());
  r := public.hq_grant_studio_credit(pg_temp.org(), 'Referral', 2, '  Referred Utsav Collective  ');
  v_id := (r ->> 'id')::uuid;
  perform pg_temp.su();
  perform pg_temp.res('28 credits: Admin at aal2 with a fresh code grants; row kept with who + reason; ONE audit row hq.credit.grant',
    (select kind = 'referral' and months = 2 and reason = 'Referred Utsav Collective' and granted_by = 'r42adm@helm.events' and voided_at is null
       from public.hq_studio_credits where id = v_id)
    and (select count(*) from public.audit_log where action = 'hq.credit.grant') = n0 + 1
    and exists (select 1 from public.audit_log where action = 'hq.credit.grant' and entity_id = pg_temp.org()::text and changed ->> 'credit_id' = v_id::text),
    coalesce(r::text, ''));
  perform pg_temp.as_user('admin@helm.events', 'aal2', pg_temp.fresh());
  r := public.hq_studio_credits(pg_temp.org());
  perform pg_temp.res('29 credits: Owner reads the list and the month total', (r ->> 'months_total')::int >= 2
    and exists (select 1 from jsonb_array_elements(r -> 'credits') c where c ->> 'id' = v_id::text), r::text);
  perform pg_temp.as_user('r42adm@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try('select count(*) from public.hq_studio_credits') || '|' || pg_temp.try(format('delete from public.hq_studio_credits where id = %L', v_id));
  perform pg_temp.res('30 credits table: no direct app access (select / delete refused)', e like '42501%|42501%', e);
  perform pg_temp.su();
  e := pg_temp.try(format('delete from public.hq_studio_credits where id = %L', v_id))
    || '|' || pg_temp.try('truncate public.hq_studio_credits')
    || '|' || pg_temp.try(format('update public.hq_studio_credits set months = 12 where id = %L', v_id))
    || '|' || pg_temp.try(format('update public.hq_studio_credits set reason = ''rewritten reason'' where id = %L', v_id));
  perform pg_temp.res('31 credits: even the database owner cannot delete, truncate or rewrite a credit', e like '42501%|42501%|42501%|42501%', e);
  e := pg_temp.try(format('update public.hq_studio_credits set voided_at = now(), voided_by = ''admin@helm.events'' where id = %L', v_id))
    || '|' || pg_temp.try(format('update public.hq_studio_credits set voided_at = now() + interval ''1 day'' where id = %L', v_id));
  perform pg_temp.res('32 credits: voided once (kept), never un-voided or re-voided', e like '|42501%'
    and exists (select 1 from public.hq_studio_credits where id = v_id and voided_at is not null), e);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) suspended / removed HQ people are refused everywhere new ---------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  update public.platform_admins set status = 'suspended' where email = 'r42adm@helm.events';
  perform pg_temp.as_user('r42adm@helm.events', 'aal2', pg_temp.fresh());
  e := pg_temp.try('select public.hq_my_session()') || '|' || pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')')
    || '|' || pg_temp.try(format('select public.hq_grant_studio_credit(%L, ''promo'', 1, ''paused try'')', pg_temp.org()));
  perform pg_temp.res('33 a paused HQ person is refused by every new function', e like '42501%|42501%|42501%', e);
  perform pg_temp.su();
  update public.platform_admins set status = 'removed', removed_at = now() where email = 'r42sales@helm.events';
  perform pg_temp.as_user('r42sales@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_log_reveal(''studio'', ''x'', ''email'')');
  perform pg_temp.res('34 a removed HQ person is refused', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
select pg_temp.su();

-- ---- 6) STOP guards: without 0277 neither file changes anything ----------------------------------------------------------
\set g0278 `sed -n '/^do \$\$ begin/,/^end \$\$;/p' supabase/migrations/0278_hq_reveal_log.sql | head -4`
\set g0280 `sed -n '/^do \$\$ begin/,/^end \$\$;/p' supabase/migrations/0280_hq_v2_round2.sql | head -7`
savepoint s_stop;
alter function public._hq27_require(text, boolean) rename to _hq27_require_r42_hidden;
select pg_temp.try(:'g0278') as r35, pg_temp.try(:'g0280') as r36 \gset
rollback to savepoint s_stop;
insert into _rs select '35 STOP 0278 when 0277 is missing', case when :'r35' like '%STOP 0278%0277%' then 'PASS' else 'FAIL: ' || :'r35' end;
insert into _rs select '36 STOP 0280 when 0277 is missing', case when :'r36' like '%STOP 0280%0277%' then 'PASS' else 'FAIL: ' || :'r36' end;
insert into _rs select '37 the guards pass when 0277 is there', case when pg_temp.try(:'g0278') = '' and pg_temp.try(:'g0280') = '' then 'PASS' else 'FAIL: ' || pg_temp.try(:'g0278') || pg_temp.try(:'g0280') end;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('38 trial retention: hq_studio_credits is a KEPT table (never purged), nothing unclassified',
    (select count(*) from unnest(public._tr184_keep_tables()) x where x = 'hq_studio_credits') = 1
    and not ('hq_studio_credits' = any (public._tr184_purge_tables()))
    and public.trial_retention_dry_run() -> 'unclassified_tables' = '[]'::jsonb);
exception when others then perform pg_temp.su(); insert into _rs values ('38', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R42-HQ-V2: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R42-HQ-V2: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
