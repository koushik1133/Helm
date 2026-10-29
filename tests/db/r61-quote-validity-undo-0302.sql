-- r61-quote-validity-undo-0302.sql - 0302: Undo for the quote's "Valid until" date (quote flow step 9).
-- Extend / Save date can be undone by the same person within 10 minutes, back to the previous date AND source,
-- through the same checks as Extend, logged in History + audit_log (nothing erased); only the latest change, only
-- while nobody changed the date since; never for another studio / a role without quotes edit / anon; the client page
-- (public_quote_validity) follows every change; link_until tells when the approval link itself stops.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
-- re-apply twice (the 0262 suite re-applies 0262 over the 0302 bodies; proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0302_r61_quote_validity_undo.sql
\ir ../../supabase/migrations/0302_r61_quote_validity_undo.sql
set client_min_messages = warning;
begin;
drop table if exists _g302; create temp table _g302(name text, result text); grant all on _g302 to anon, authenticated;

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
  insert into _g302 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create or replace function pg_temp.qv(p uuid) returns public.quote_validity language sql as $$ select * from public.quote_validity where quote_id = p $$;

-- setup: Studio A quotes 302a1 (sent, live link), 302a2 (never had a date), 302a3 (approved); 302b1 in Studio B
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid; u uuid; begin
  execute 'reset role';
  select org_id into b from public.profiles where email = 'b_admin@b.test';
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  delete from public.app_config where key = 'quote_validity';
  insert into public.app_config(org_id, key, value, updated_at) values (a, 'quote_validity', '{"enabled": true, "default_days": 14}'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  -- a second editor in A (same rights as a_admin for quotes) and a viewer without quotes edit
  select id into u from auth.users where email = 'a_mgr302@a.test'; if u is null then u := auth.seed_user('a_mgr302@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_mgr302@a.test', 'Mira Manager', 'admin', a, false, now()) on conflict (id) do update set role = 'admin', org_id = a;
  select id into u from auth.users where email = 'a_crew302@a.test'; if u is null then u := auth.seed_user('a_crew302@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_crew302@a.test', 'Cal Crew', 'crew', a, false, now()) on conflict (id) do update set role = 'crew', org_id = a;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('crew', 'quotes', true, false, a, now()) on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id,
                            approval_token, approval_token_expires_at, lifecycle_stage, event_date, created_at, updated_at)
  select x.id::uuid, x.code, x.title, 'quote', jsonb_build_object('name', 'Priya', 'email', 'priya302@example.org', 'phone', '9876543210'),
         '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}'::jsonb, 1, 'sent', x.org,
         x.tok::uuid, now() + interval '30 days', 'quote', pg_temp.today() + 60, now(), now()
    from (values ('a0000000-0000-4000-8000-0000000302a1', 'A-302-1', 'Undo302 One',   a, 'c0000000-0000-4000-8000-0000000302c1'),
                 ('a0000000-0000-4000-8000-0000000302a2', 'A-302-2', 'Undo302 Two',   a, 'c0000000-0000-4000-8000-0000000302c2'),
                 ('a0000000-0000-4000-8000-0000000302a3', 'A-302-3', 'Undo302 Three', a, 'c0000000-0000-4000-8000-0000000302c3'),
                 ('b0000000-0000-4000-8000-0000000302b1', 'B-302-1', 'Undo302 B',     b, 'c0000000-0000-4000-8000-0000000302c4')) x(id, code, title, org, tok)
  on conflict (id) do nothing;
  delete from public.quote_validity_log where quote_id in ('a0000000-0000-4000-8000-0000000302a1', 'a0000000-0000-4000-8000-0000000302a2',
    'a0000000-0000-4000-8000-0000000302a3', 'b0000000-0000-4000-8000-0000000302b1');
  -- 302a1: an automatic date 20 days out; 302a2: no date at all; 302a3: approved; 302b1 (B): automatic
  insert into public.quote_validity(quote_id, org_id, valid_until, source) values
    ('a0000000-0000-4000-8000-0000000302a1', a, pg_temp.today() + 20, 'auto'),
    ('a0000000-0000-4000-8000-0000000302a3', a, pg_temp.today() + 20, 'auto'),
    ('b0000000-0000-4000-8000-0000000302b1', b, pg_temp.today() + 20, 'auto')
  on conflict (quote_id) do update set valid_until = excluded.valid_until, source = 'auto';
  delete from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000302a2';
  update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000302a3';
end $$;

do $$
declare q1 uuid := 'a0000000-0000-4000-8000-0000000302a1'; q2 uuid := 'a0000000-0000-4000-8000-0000000302a2';
        q3 uuid := 'a0000000-0000-4000-8000-0000000302a3'; qb uuid := 'b0000000-0000-4000-8000-0000000302b1';
        j jsonb; k jsonb; lid text; n0 bigint; pub jsonb;
begin
  -- 01-04 shape + grants
  perform pg_temp.t('01 quote_validity_undo + re-issued get / write carry the 0302 marker, security definer, empty search path',
    (select bool_and(position('r61-qv-0302' in p.prosrc) > 0 and p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
       from pg_proc p where p.oid in (to_regprocedure('public.quote_validity_undo(uuid,uuid)'), to_regprocedure('public.quote_validity_get(uuid)'),
                                      to_regprocedure('public._qv262_write(uuid,date,text,text,text)'))), null);
  perform pg_temp.t('02 signed-in staff may call undo / get; anon may not',
    has_function_privilege('authenticated', 'public.quote_validity_undo(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.quote_validity_undo(uuid,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.quote_validity_get(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.quote_validity_get(uuid)', 'execute'), null);
  perform pg_temp.t('03 kept previous bodies + private helpers are not callable by the app',
    to_regprocedure('public._qv262_write__pre0302(uuid,date,text,text,text)') is not null and to_regprocedure('public.quote_validity_get__pre0302(uuid)') is not null
    and not has_function_privilege('authenticated', 'public._qv262_write__pre0302(uuid,date,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.quote_validity_get__pre0302(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._qv262_write(uuid,date,text,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._qv302_undo_row(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._qv302_link_until(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._qv302_link_until(uuid)', 'execute'), null);
  perform pg_temp.t('04 action CHECK is a superset (old values + undo), old_source column added',
    (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.quote_validity_log'::regclass and conname = 'quote_validity_log_action_check')
      ~ 'auto.*set.*extended.*bulk.*renew_request.*reminder_studio.*reminder_client.*expired_studio.*approve_refused.*undo'
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_validity_log' and column_name = 'old_source'), null);

  -- 05-07 Extend: the server moves the date (+14 from the later of today / current), the client page follows, logged
  j := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_extend(%L)', q1));
  perform pg_temp.t('05 Extend: date + 14, source extended, answer says so', (pg_temp.qv(q1)).valid_until = pg_temp.today() + 34
    and (pg_temp.qv(q1)).source = 'extended' and j ->> 'valid_until' = to_char(pg_temp.today() + 34, 'YYYY-MM-DD') and (j ->> 'days_left')::int = 34, j::text);
  pub := public.public_quote_validity('quote', 'c0000000-0000-4000-8000-0000000302c1');   -- what the client page reads (grants are the 0262 / 0297 suites' job; earlier suites may change them)
  perform pg_temp.t('06 the client page at the link shows the NEW date', pub ->> 'valid_until' = to_char(pg_temp.today() + 34, 'YYYY-MM-DD') and pub ->> 'state' = 'valid', pub::text);
  perform pg_temp.t('07 the answer offers Undo back to the old date, newest History row first with its id',
    j -> 'undo' ->> 'back_to' = to_char(pg_temp.today() + 20, 'YYYY-MM-DD') and j -> 'undo' ->> 'log_id' = j -> 'log' -> 0 ->> 'id'
    and j -> 'log' -> 0 ->> 'action' = 'extended' and (j -> 'undo' ->> 'until')::timestamptz > now() + interval '9 minutes', j::text);
  lid := j -> 'undo' ->> 'log_id';

  -- 08-10 who may undo
  k := pg_temp.as_j('a_mgr302@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('08 another editor cannot undo someone else''s change (date kept)', k ->> 'error' = '22023' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 34, k::text);
  k := pg_temp.as_j('a_crew302@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('09 a role without quotes edit is refused (42501)', k ->> 'error' = '42501' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 34, k::text);
  k := pg_temp.as_j('b_admin@b.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('10 another studio is refused (42501)', k ->> 'error' = '42501' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 34, k::text);
  k := pg_temp.as_j('anon', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('11 anon is refused', k ? 'error' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 34, k::text);
  k := pg_temp.as_j('a_mgr302@a.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('12 another editor is not offered the undo', k ? 'undo' and k -> 'undo' = 'null'::jsonb and k ->> 'valid_until' = to_char(pg_temp.today() + 34, 'YYYY-MM-DD'), k::text);

  -- 13-16 the undo itself
  select count(*) into n0 from public.audit_log where quote_id = q1 and action like 'quote_validity.%';
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('13 Undo restores the date AND the source exactly', (pg_temp.qv(q1)).valid_until = pg_temp.today() + 20 and (pg_temp.qv(q1)).source = 'auto'
    and k ->> 'valid_until' = to_char(pg_temp.today() + 20, 'YYYY-MM-DD') and (k ->> 'days_left')::int = 20, k::text);
  perform pg_temp.t('14 Undo is in History (newest first) and in audit_log - the Extend row is kept',
    k -> 'log' -> 0 ->> 'action' = 'undo' and k -> 'log' -> 0 ->> 'new' = to_char(pg_temp.today() + 20, 'DD/MM/YYYY')
    and k -> 'log' -> 0 ->> 'note' like 'Undone - back to %' and k -> 'log' -> 1 ->> 'action' = 'extended'
    and (select count(*) from public.quote_validity_log where quote_id = q1 and action in ('extended', 'undo')) = 2
    and (select count(*) from public.audit_log where quote_id = q1 and action like 'quote_validity.%') = n0 + 1
    and exists (select 1 from public.audit_log where quote_id = q1 and action = 'quote_validity.undo'), k::text);
  pub := public.public_quote_validity('quote', 'c0000000-0000-4000-8000-0000000302c1');   -- what the client page reads (grants are the 0262 / 0297 suites' job; earlier suites may change them)
  perform pg_temp.t('15 the client page follows the undo', pub ->> 'valid_until' = to_char(pg_temp.today() + 20, 'YYYY-MM-DD'), pub::text);
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('16 the same undo twice is refused (no offer after an undo)', k ->> 'error' = '22023' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 20, k::text);
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('17 after an undo nothing is offered', k -> 'undo' = 'null'::jsonb, k::text);

  -- 18-20 Save date -> undo; only the latest change; somebody else changed it since
  j := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_set(%L, %L, null)', q1, pg_temp.today() + 45));
  perform pg_temp.t('18 Save date is undoable back to the previous date', j -> 'undo' ->> 'back_to' = to_char(pg_temp.today() + 20, 'YYYY-MM-DD'), j::text);
  lid := j -> 'undo' ->> 'log_id';
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_extend(%L)', q1));
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('19 an older change cannot be undone once a newer one exists', k ->> 'error' = '22023' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 59, k::text);
  j := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_get(%L)', q1));
  lid := j -> 'undo' ->> 'log_id';
  k := pg_temp.as_j('a_mgr302@a.test', format('select public.quote_validity_set(%L, %L, null)', q1, pg_temp.today() + 10));
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('20 once someone else changed the date, the undo is refused (their date kept)', k ->> 'error' = '22023' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 10, k::text);
  k := pg_temp.as_j('a_mgr302@a.test', format('select public.quote_validity_get(%L)', q1));
  lid := k -> 'undo' ->> 'log_id';
  update public.quote_validity_log set created_at = created_at - interval '11 minutes' where id = lid::uuid;
  k := pg_temp.as_j('a_mgr302@a.test', format('select public.quote_validity_undo(%L, %L)', q1, lid));
  perform pg_temp.t('21 after 10 minutes the undo is refused', lid is not null and k ->> 'error' = '22023' and (pg_temp.qv(q1)).valid_until = pg_temp.today() + 10, k::text);

  -- 22-24 edge cases: no date before, approved quote, garbage id
  j := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_extend(%L)', q2));
  perform pg_temp.t('22 first date on a quote that had none: no undo offered (never turned back into "no date")',
    (pg_temp.qv(q2)).valid_until = pg_temp.today() + 14 and j -> 'undo' = 'null'::jsonb, j::text);
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q2, j -> 'log' -> 0 ->> 'id'));
  perform pg_temp.t('23 ... and the server refuses it', k ->> 'error' = '22023' and (pg_temp.qv(q2)).valid_until = pg_temp.today() + 14, k::text);
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q3, gen_random_uuid()));
  perform pg_temp.t('24 an approved quote is refused (validity no longer applies)', k ->> 'error' = '22023' and (pg_temp.qv(q3)).valid_until = pg_temp.today() + 20, k::text);
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_undo(%L, %L)', q1, gen_random_uuid()));
  perform pg_temp.t('25 an unknown change id is refused', k ->> 'error' = '22023', k::text);

  -- 26-28 link_until: when the approval link itself stops
  update public.quotes set approval_token_expires_at = (pg_temp.today() + 5)::timestamp at time zone 'Asia/Kolkata' where id = q1;
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('26 link_until = the last day the link opens (before the valid-until date here)',
    k ->> 'link_until' = to_char(pg_temp.today() + 4, 'YYYY-MM-DD') and k ->> 'link_until_label' = to_char(pg_temp.today() + 4, 'DD/MM/YYYY'), k::text);
  update public.quotes set approval_token_revoked_at = now() where id = q1;
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('27 a revoked link: no link_until', k -> 'link_until' = 'null'::jsonb, k::text);
  update public.quotes set approval_token_revoked_at = null, approval_token_expires_at = now() + interval '30 days' where id = q1;
  k := pg_temp.as_j('b_admin@b.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('28 another studio cannot read it (42501)', k ->> 'error' = '42501', k::text);

  -- 29-30 nothing else changed: every 0262 key still there; B untouched
  k := pg_temp.as_j('a_admin@a.test', format('select public.quote_validity_get(%L)', q1));
  perform pg_temp.t('29 every 0262 key is still in the answer',
    k ?& array['state', 'valid_until', 'valid_until_label', 'days_left', 'locked', 'auto_lock', 'source', 'set_at', 'can_edit', 'can_override', 'default_days', 'today', 'log']
    and (k -> 'log' -> 0) ?& array['at', 'action', 'old', 'new', 'who', 'note'], k::text);
  perform pg_temp.t('30 Studio B''s quote untouched', (pg_temp.qv(qb)).valid_until = pg_temp.today() + 20 and (pg_temp.qv(qb)).source = 'auto'
    and not exists (select 1 from public.quote_validity_log where quote_id = qb), null);
end $$;

select name, result from _g302 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R61-QV-UNDO-0302: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R61-QV-UNDO-0302: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g302;
rollback;
