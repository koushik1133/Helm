-- trial-sandbox-0166.sql -- 0166: master sample studio clone, trial seat limit, outbound guard,
-- Clear sample data. ZERO DATA LOSS proofs: the master is never changed, other studios are never
-- touched, clear removes only is_demo rows of the caller's studio. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.master_fp() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_items x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.vendors x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.menu_templates x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.dish_catalog x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001')));
$$;
create or replace function pg_temp.org_fp(p_org uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_items x where x.org_id = p_org),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.vendors x where x.org_id = p_org),
    (select string_agg((to_jsonb(x) - 'updated_at')::text, ',' order by x.id) from public.quotes x where x.org_id = p_org),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.leads x where x.org_id = p_org)));
$$;

-- ---- 0) migration shape ----------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 master studio exists + flagged', exists (select 1 from public.organizations where id = 'a5a5a5a5-0166-4000-8000-000000000001' and is_sample_master));
  perform pg_temp.res('02 switch row exists and is OFF', exists (select 1 from public.helm_sample_template where id and not active and org_id = 'a5a5a5a5-0166-4000-8000-000000000001'));
  perform pg_temp.res('03 placeholder: 2 items, 1 vendor, 1 package',
    (select count(*) from public.inventory_items where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 2
    and (select count(*) from public.vendors where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 1
    and (select count(*) from public.menu_templates where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 1);
  perform pg_temp.res('04 seed functions wrapped (pre kept)', to_regprocedure('public._demo_seed__pre0166(uuid)') is not null
    and to_regprocedure('public._trial_seed_extra__pre0166(uuid)') is not null and to_regprocedure('public._trial_seed_custom__pre0166(uuid)') is not null
    and position('trial-sandbox-0166' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0);
  perform pg_temp.put('master0', pg_temp.master_fp());
  perform pg_temp.put('orgA0', pg_temp.org_fp('a0000000-0000-4000-8000-000000000001'));
end $$;

-- ---- 1) switch OFF: the built-in demo seed runs exactly as before ---------------------------------
do $$ declare r jsonb; o uuid; begin
  perform pg_temp.newuser('ts_off@t.test'); perform pg_temp.login('ts_off@t.test');
  r := public.start_self_serve_trial('Off Studio', 'Asia/Kolkata', 'INR', 'demo');
  o := (r ->> 'org_id')::uuid; perform pg_temp.su(); perform pg_temp.put('orgOff', o::text);
  perform pg_temp.res('10 OFF: trial started', r ->> 'result' = 'started', r::text);
  perform pg_temp.res('11 OFF: built-in demo events seeded', (select count(*) from public.quotes where org_id = o and is_demo) > 0);
  perform pg_temp.res('12 OFF: not cloned', (select sample_cloned_at is null from public.organizations where id = o));
exception when others then perform pg_temp.su(); insert into _uf values ('1x off', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) switch ON: the trial gets an identical copy of the master ----------------------------------
do $$ declare r jsonb; o uuid; o2 uuid; d uuid; k jsonb; v public.vendors; begin
  perform pg_temp.su();
  -- a dish the package points at (nested jsonb id) to prove the remap
  insert into public.dish_catalog(org_id, category, name, kind, active)
    values ('a5a5a5a5-0166-4000-8000-000000000001', 'Starters', E'Demo \u00b7 Paneer tikka (TODO)', 'veg', true) returning id into d;
  update public.menu_templates set dishes = jsonb_build_array(jsonb_build_object('id', d::text, 'name', 'Paneer tikka'))
   where org_id = 'a5a5a5a5-0166-4000-8000-000000000001';
  perform pg_temp.put('masterDish', d::text);
  perform pg_temp.put('master1', pg_temp.master_fp());
  update public.helm_sample_template set active = true where id;

  perform pg_temp.newuser('ts_on@t.test'); perform pg_temp.login('ts_on@t.test');
  r := public.start_self_serve_trial('On Studio', 'Asia/Kolkata', 'INR', 'demo');
  o := (r ->> 'org_id')::uuid; perform pg_temp.su(); perform pg_temp.put('orgOn', o::text);
  perform pg_temp.res('20 ON: trial started', r ->> 'result' = 'started', r::text);
  perform pg_temp.res('21 ON: cloned (seed result)', (r -> 'seed' ->> 'cloned')::boolean, r::text);
  perform pg_temp.res('22 ON: same counts as master',
    (select count(*) from public.inventory_items where org_id = o) = 2 and (select count(*) from public.vendors where org_id = o) = 1
    and (select count(*) from public.menu_templates where org_id = o) = 1 and (select count(*) from public.dish_catalog where org_id = o) = 1);
  perform pg_temp.res('23 ON: built-in demo events NOT seeded', (select count(*) from public.quotes where org_id = o) = 0);
  perform pg_temp.res('24 ON: every row is_demo',
    not exists (select 1 from public.inventory_items where org_id = o and not is_demo)
    and not exists (select 1 from public.vendors where org_id = o and not is_demo)
    and not exists (select 1 from public.menu_templates where org_id = o and not is_demo));
  perform pg_temp.res('25 ON: new ids (no master id reused)',
    not exists (select 1 from public.inventory_items a join public.inventory_items b on a.id = b.id
                 where a.org_id = o and b.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'));
  select (m.dishes -> 0) into k from public.menu_templates m where m.org_id = o;
  perform pg_temp.res('26 ON: nested jsonb id remapped to the trial dish',
    (k ->> 'id')::uuid = (select id from public.dish_catalog where org_id = o) and (k ->> 'id') <> pg_temp.get('masterDish'), coalesce(k::text, 'null'));
  select * into v from public.vendors where org_id = o;
  perform pg_temp.res('27 ON: contacts made undeliverable', v.email like '%@example.com' and regexp_replace(v.phone, '\D', '', 'g') like '9100000%', v.email || ' ' || v.phone);
  perform pg_temp.res('28 ON: org stamped + run row',
    (select sample_cloned_at is not null and sample_source_org = 'a5a5a5a5-0166-4000-8000-000000000001' and sample_version = 1 from public.organizations where id = o)
    and exists (select 1 from public.trial_sample_runs where org_id = o));
  perform pg_temp.res('29 ON: master unchanged by the clone', pg_temp.master_fp() = pg_temp.get('master1'));

  r := public._sample_clone_into(o);
  perform pg_temp.res('30 clone twice: skipped, no duplicates', r ->> 'reason' = 'already_cloned' and (select count(*) from public.inventory_items where org_id = o) = 2, r::text);
  perform pg_temp.res('31 master is never a clone target', pg_temp.try('select public._sample_clone_into(''a5a5a5a5-0166-4000-8000-000000000001'')') like '42501%');

  -- a second trial gets the identical dataset
  perform pg_temp.newuser('ts_on2@t.test'); perform pg_temp.login('ts_on2@t.test');
  r := public.start_self_serve_trial('', 'Asia/Kolkata', 'INR', 'demo');
  o2 := (r ->> 'org_id')::uuid; perform pg_temp.su();
  perform pg_temp.res('32 second trial: identical names',
    (select string_agg(name, ',' order by name) from public.inventory_items where org_id = o2)
    = (select string_agg(name, ',' order by name) from public.inventory_items where org_id = o));
  perform pg_temp.newuser('ts_own@t.test'); perform pg_temp.login('ts_own@t.test');
  r := public.start_self_serve_trial('Own Studio', 'Asia/Kolkata', 'INR', 'own');
  perform pg_temp.su();
  perform pg_temp.res('33 own-data trial: nothing cloned', (select count(*) from public.inventory_items where org_id = (r ->> 'org_id')::uuid and is_demo) = 0
    and (select sample_cloned_at is null from public.organizations where id = (r ->> 'org_id')::uuid));
  perform pg_temp.put('orgOwn', r ->> 'org_id');
exception when others then perform pg_temp.su(); insert into _uf values ('2x on', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) the app can never reach the clone / the switch ---------------------------------------------
do $$ begin
  perform pg_temp.login('ts_on@t.test');
  perform pg_temp.res('40 app cannot run the clone', pg_temp.try('select public._sample_clone_into(''' || pg_temp.get('orgOn') || ''')') like '42501%');
  perform pg_temp.res('41 app cannot read the switch', pg_temp.try('select * from public.helm_sample_template') like '42501%');
  perform pg_temp.res('42 app cannot read the run log', pg_temp.try('select * from public.trial_sample_runs') like '42501%');
  perform pg_temp.res('43 app cannot see the master rows',
    not exists (select 1 from public.inventory_items where org_id = 'a5a5a5a5-0166-4000-8000-000000000001'));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('4x app', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) seat limit: admin + 2 during the trial ------------------------------------------------------
do $$ declare o uuid := pg_temp.get('orgOn')::uuid; u uuid; e text; begin
  perform pg_temp.su();
  perform pg_temp.res('50 1st invite OK', pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || o || ''', ''s1@t.test'', ''sales'', ''tok-s1'', ''pending'', now() + interval ''7 days'')') = '');
  perform pg_temp.res('51 2nd invite OK', pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || o || ''', ''s2@t.test'', ''manager'', ''tok-s2'', ''pending'', now() + interval ''7 days'')') = '');
  e := pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || o || ''', ''s3@t.test'', ''sales'', ''tok-s3'', ''pending'', now() + interval ''7 days'')');
  perform pg_temp.res('52 3rd invite refused (seat limit)', e like '42501%seat%' or e like '42501%people%', e);
  perform pg_temp.res('53 client invite does not count', pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || o || ''', ''c1@t.test'', ''client'', ''tok-c1'', ''pending'', now() + interval ''7 days'')') = '');
  -- invitee 1 joins: still 3 seats used (member replaces its invite)
  u := auth.seed_user('s1@t.test');
  e := pg_temp.try('insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (''' || u || ''', ''s1@t.test'', ''sales'', ''' || o || ''', false, now()) on conflict (id) do update set org_id = excluded.org_id, role = excluded.role');
  perform pg_temp.res('54 invitee joins within the limit', e = '', e);
  update public.invitations set status = 'accepted' where org_id = o and email = 's1@t.test';
  u := auth.seed_user('s2@t.test');
  e := pg_temp.try('insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (''' || u || ''', ''s2@t.test'', ''manager'', ''' || o || ''', false, now()) on conflict (id) do update set org_id = excluded.org_id, role = excluded.role');
  perform pg_temp.res('55 3rd person joins (limit reached)', e = '', e);
  u := auth.seed_user('s4@t.test');
  e := pg_temp.try('insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (''' || u || ''', ''s4@t.test'', ''sales'', ''' || o || ''', false, now()) on conflict (id) do update set org_id = excluded.org_id, role = excluded.role');
  perform pg_temp.res('56 4th person refused on direct join', e like '42501%', e);
  update public.organizations set seat_limit = 5 where id = o;
  perform pg_temp.res('57 seat_limit override allows more', pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || o || ''', ''s5@t.test'', ''sales'', ''tok-s5'', ''pending'', now() + interval ''7 days'')') = '');
  update public.organizations set seat_limit = null where id = o;
  perform pg_temp.res('58 non-trial studio: no limit',
    pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) select ''a0000000-0000-4000-8000-000000000001'', ''x'' || g || ''@a.test'', ''sales'', ''tok-a'' || g, ''pending'', now() + interval ''7 days'' from generate_series(1, 4) g') = '');
exception when others then perform pg_temp.su(); insert into _uf values ('5x seats', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) outbound guard -------------------------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('orgOn')::uuid; s text; begin
  perform pg_temp.su();
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values (o, 'follow_up', 'email', 'real.person@gmail.com', 'ts166-1') returning status into s;
  perform pg_temp.res('60 trial studio: email queued as skipped', s = 'skipped', s);
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values (o, 'wa_forward', 'whatsapp', '+919876543210', 'ts166-2') returning status into s;
  perform pg_temp.res('61 trial studio: WhatsApp queued as skipped', s = 'skipped', s);
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values ('a5a5a5a5-0166-4000-8000-000000000001', 'follow_up', 'email', 'someone@gmail.com', 'ts166-3') returning status into s;
  perform pg_temp.res('62 sample master: always skipped', s = 'skipped', s);
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values ('a0000000-0000-4000-8000-000000000001', 'follow_up', 'email', 'real.client@gmail.com', 'ts166-4') returning status into s;
  perform pg_temp.res('63 paid studio, real address: still pending', s = 'pending', s);
  update public.helm_sample_template set block_trial_outbound = false where id;
  insert into public.comms_outbox(org_id, purpose, channel, recipient, dedupe_key) values (o, 'follow_up', 'email', 'real.person2@gmail.com', 'ts166-5') returning status into s;
  perform pg_temp.res('64 switch off: trial real address pending', s = 'pending', s);
  update public.helm_sample_template set block_trial_outbound = true where id;
exception when others then perform pg_temp.su(); insert into _uf values ('6x outbound', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) Skip OTP test mode still on for a trial ------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('70 Skip OTP available in trial', public._trial_test_mode_ok(pg_temp.get('orgOn')::uuid));
  perform pg_temp.res('71 Skip OTP off for a paid studio', not public._trial_test_mode_ok('a0000000-0000-4000-8000-000000000001'));
end $$;

-- ---- 7) Clear sample data: only is_demo rows of the caller's studio ----------------------------------
do $$ declare o uuid := pg_temp.get('orgOn')::uuid; r jsonb; e text; begin
  perform pg_temp.login('ts_on@t.test');
  insert into public.inventory_items(org_id, name, category, total_qty, unit, active) values (o, 'My real chairs', 'Furniture', 10, 'pcs', true);
  perform pg_temp.su(); perform pg_temp.put('orgOff0', pg_temp.org_fp(pg_temp.get('orgOff')::uuid));
  perform pg_temp.login('s1@t.test');
  e := pg_temp.try('select public.clear_sample_data()');
  perform pg_temp.res('80 non-admin refused', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.clear_sample_data()');
  perform pg_temp.res('81 non-trial studio refused', e like '22023%', e);
  perform pg_temp.login('ts_on@t.test');
  r := public.clear_sample_data();
  perform pg_temp.su();
  perform pg_temp.res('82 sample rows gone', not exists (select 1 from public.inventory_items where org_id = o and is_demo and active)
    and not exists (select 1 from public.vendors where org_id = o and is_demo and active), r::text);
  perform pg_temp.res('83 own row survives', exists (select 1 from public.inventory_items where org_id = o and name = 'My real chairs' and not is_demo));
  perform pg_temp.res('84 other trial untouched', pg_temp.org_fp(pg_temp.get('orgOff')::uuid) = pg_temp.get('orgOff0'));
  perform pg_temp.res('85 master untouched', pg_temp.master_fp() = pg_temp.get('master1'));
  perform pg_temp.res('86 fixture studio A untouched', pg_temp.org_fp('a0000000-0000-4000-8000-000000000001') = pg_temp.get('orgA0'));
  perform pg_temp.res('87 audit row', exists (select 1 from public.audit_log where org_id = o and action = 'trial.sample_cleared'));
  perform pg_temp.login('ts_on@t.test');
  perform pg_temp.res('88 anon/app cannot clone after clear', pg_temp.try('select public._demo_seed(''' || o || ''')') like '42501%');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('8x clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-SANDBOX-0166: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-SANDBOX-0166: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
