-- trial-manifest-0167.sql -- 0167: publish snapshot model + the full sample dataset. Proves: only a
-- PUBLISHED snapshot seeds new trials (a half-edited master never leaks), every trial gets its OWN
-- independent copy of every table, quotes are re-priced by the server engine, approval tokens are
-- new per trial, dates move with the signup day, contacts stay dummy, Skip OTP works on the sent
-- sample quote, seats read "N of M", clear removes only sample rows, reset re-seeds.
-- Rolled back. Local disposable PG only.
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
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- row counts of every cloned table for one studio
create or replace function pg_temp.counts(p_org uuid) returns jsonb language plpgsql as $$
declare t text; n integer; out jsonb := '{}'::jsonb; begin
  foreach t in array public._sample_clone_tables() loop
    execute format('select count(*) from public.%I where org_id = $1', t) into n using p_org;
    out := out || jsonb_build_object(t, n);
  end loop; return out;
end $$;
create or replace function pg_temp.fp(p_org uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_items x where x.org_id = p_org),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.leads x where x.org_id = p_org),
    (select string_agg((to_jsonb(x) - 'updated_at')::text, ',' order by x.id) from public.quotes x where x.org_id = p_org),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.nurture x where x.org_id = p_org)));
$$;

-- ---- 0) shape --------------------------------------------------------------------------------------
do $$ declare m public.helm_trial_seed_manifest; begin
  perform pg_temp.su();
  select * into m from public.helm_trial_seed_manifest where is_current;
  perform pg_temp.res('01 manifest >= v5 (0171) published + current, v1 kept', m.version >= 5 and exists (select 1 from public.helm_trial_seed_manifest v where v.version = 1 and not v.is_current) and m.source_org = 'a5a5a5a5-0166-4000-8000-000000000001');
  perform pg_temp.res('02 switch still OFF', not (select active from public.helm_sample_template where id));
  perform pg_temp.res('03 dataset size (>= 0171: 165 items, 12 staff, 16 vendors, 4 venues, 6 packages, 145 dishes, 16 leads, 7 events)',
    (m.counts ->> 'inventory_items')::int >= 165 and (m.counts ->> 'crew_members')::int = 12 and (m.counts ->> 'vendors')::int = 16
    and (m.counts ->> 'venues')::int = 4 and (m.counts ->> 'menu_templates')::int = 6 and (m.counts ->> 'dish_catalog')::int = 145
    and (m.counts ->> 'leads')::int >= 16 and (m.counts ->> 'quotes')::int >= 7 and (m.counts ->> 'run_sheet_items')::int = 37 and (m.counts ->> 'studio_layout_templates')::int >= 3
    and (m.counts ->> 'event_tasks')::int = 10 and (m.counts ->> 'nurture')::int = 6, m.counts::text);
  perform pg_temp.res('04 master contacts all dummy',
    not exists (select 1 from jsonb_each(m.payload -> 'tables') t(k, rows), jsonb_array_elements(t.rows) r(j)
                 where (coalesce(r.j ->> 'email', '') <> '' and r.j ->> 'email' not like '%@example.com')
                    or (coalesce(r.j ->> 'phone', '') <> '' and right(regexp_replace(r.j ->> 'phone', '\D', '', 'g'), 10) not like '00000%')));
  perform pg_temp.res('05 every sample name is marked Demo',
    not exists (select 1 from public.leads where org_id = m.source_org and name not like E'Demo \u00b7%')
    and not exists (select 1 from public.crew_members where org_id = m.source_org and name not like E'Demo \u00b7%')
    and not exists (select 1 from public.inventory_items where org_id = m.source_org and name not like E'Demo \u00b7%'));
  perform pg_temp.res('06 RLS on manifest', (select relrowsecurity from pg_class where oid = 'public.helm_trial_seed_manifest'::regclass));
  perform pg_temp.res('07 master quotes priced by D8', not exists (select 1 from public.quotes q where q.org_id = m.source_org
       and (q.pricing ->> 'total')::numeric is distinct from public.helm_quote_total(q.pricing)));
end $$;

-- ---- 1) the app cannot publish / read manifests -----------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.newuser('mf_x@t.test'); perform pg_temp.login('mf_x@t.test');
  e := pg_temp.try('select public.publish_sample_manifest(null)');
  perform pg_temp.res('10 non platform admin cannot publish', e like '42501%', e);
  e := pg_temp.try('select public.set_current_sample_manifest(1)');
  perform pg_temp.res('11 non platform admin cannot roll back', e like '42501%', e);
  e := pg_temp.try('select * from public.helm_trial_seed_manifest');
  perform pg_temp.res('12 app cannot read manifests', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.sample_manifest_status()');
  perform pg_temp.res('13 studio admin cannot read status', e like '42501%', e);
  perform pg_temp.su();
end $$;

-- ---- 2) switch ON: trial A gets a full, independent copy ---------------------------------------------
do $$ declare a uuid; b uuid; mc jsonb; ca jsonb; q record; e text; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('mf_a@t.test'); perform pg_temp.put('A', a::text);
  mc := (select counts from public.helm_trial_seed_manifest where is_current);
  ca := pg_temp.counts(a);
  perform pg_temp.res('20 trial A: every table matches the manifest counts', ca = mc, 'trial ' || ca::text || ' manifest ' || mc::text);
  perform pg_temp.res('21 trial A: every row is_demo',
    not exists (select 1 from public.quotes where org_id = a and not is_demo) and not exists (select 1 from public.leads where org_id = a and not is_demo)
    and not exists (select 1 from public.payment_milestones where org_id = a and not is_demo)
    and not exists (select 1 from public.nurture where org_id = a and not is_demo)
    and not exists (select 1 from public.checklist_templates where org_id = a and not is_demo)
    and not exists (select 1 from public.task_templates where org_id = a and not is_demo));
  perform pg_temp.res('22 trial A: no master id reused',
    not exists (select 1 from public.quotes x join public.quotes y on x.id = y.id where x.org_id = a and y.org_id = 'a5a5a5a5-0166-4000-8000-000000000001')
    and not exists (select 1 from public.crew_members x join public.crew_members y on x.id = y.id where x.org_id = a and y.org_id <> a));
  perform pg_temp.res('23 trial A: quote totals = server pricing engine', not exists (select 1 from public.quotes x where x.org_id = a
       and (x.pricing ->> 'total')::numeric is distinct from public.helm_quote_total(x.pricing)));
  perform pg_temp.res('24 trial A: children point at trial A parents',
    not exists (select 1 from public.payment_milestones m left join public.quotes x on x.id = m.quote_id and x.org_id = a where m.org_id = a and x.id is null)
    and not exists (select 1 from public.event_tasks t where t.org_id = a and t.crew_id is not null and not exists (select 1 from public.crew_members c where c.id = t.crew_id and c.org_id = a))
    and not exists (select 1 from public.event_tasks t where t.org_id = a and t.vendor_id is not null and not exists (select 1 from public.vendors v where v.id = t.vendor_id and v.org_id = a))
    and not exists (select 1 from public.inventory_reservations r where r.org_id = a and not exists (select 1 from public.inventory_items i where i.id = r.item_id and i.org_id = a))
    and (select count(*) from public.event_tasks where org_id = a and crew_id is not null) = 7);
  perform pg_temp.res('25 trial A: leads linked to its own events (>= 4)',
    (select count(*) from public.leads l join public.quotes x on x.id = l.quote_id and x.org_id = a where l.org_id = a) >= 4
    and (select count(*) from public.leads where org_id = a) >= 16);
  select * into q from public.quotes where org_id = a and approval_status = 'sent';
  perform pg_temp.res('26 sent quote: a NEW approval token per trial', q.approval_token is not null
    and q.approval_token <> (select approval_token from public.quotes where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and approval_status = 'sent')
    and q.approval_token_expires_at > now());
  perform pg_temp.put('A_token', q.approval_token::text);
  perform pg_temp.res('27 dates follow signup (anchor today: confirmed +10, closed -10)',
    exists (select 1 from public.quotes where org_id = a and lifecycle_stage = 'planning' and event_date = current_date + 10)
    and exists (select 1 from public.quotes where org_id = a and lifecycle_stage = 'closed' and event_date = current_date - 10));
  perform pg_temp.res('28 contacts dummy in trial (columns + client json)',
    not exists (select 1 from public.leads where org_id = a and email not like '%@example.com')
    and not exists (select 1 from public.crew_members where org_id = a and right(regexp_replace(phone, '\D', '', 'g'), 10) not like '00000%')
    and not exists (select 1 from public.quotes where org_id = a and (client ->> 'email') not like '%@example.com'));
  perform pg_temp.res('29 confirmed event has layout version + payments + run sheet + tasks',
    exists (select 1 from public.quotes x where x.org_id = a and x.lifecycle_stage = 'planning'
      and exists (select 1 from public.quote_versions v where v.quote_id = x.id and jsonb_array_length(v.data -> 'items') = 71)
      and exists (select 1 from public.quote_payments p where p.quote_id = x.id and p.status = 'paid' and p.simulated)
      and (select count(*) from public.run_sheet_items r where r.quote_id = x.id) = 15
      and (select count(*) from public.event_tasks t where t.quote_id = x.id) = 10));
  perform pg_temp.res('30 closed event settled (paid in full + closure)',
    exists (select 1 from public.quotes x where x.org_id = a and x.lifecycle_stage = 'closed'
      and (select sum(p.amount) from public.quote_payments p where p.quote_id = x.id and p.status = 'paid') = (x.pricing ->> 'total')::numeric
      and exists (select 1 from public.event_closure c where c.quote_id = x.id and c.closed_at is not null)));
  perform pg_temp.res('31 nothing pending in the trial outboxes',
    not exists (select 1 from public.comms_outbox where org_id = a and status = 'pending')
    and not exists (select 1 from public.assign_notify_outbox where org_id = a and status = 'pending'));

  -- independence: an edit in trial A never reaches trial B or the master
  b := pg_temp.trial('mf_b@t.test'); perform pg_temp.put('B', b::text);
  perform pg_temp.put('B0', pg_temp.fp(b)); perform pg_temp.put('M0', pg_temp.fp('a5a5a5a5-0166-4000-8000-000000000001'));
  perform pg_temp.login('mf_a@t.test');
  e := pg_temp.try('update public.leads set notes = ''edited in A'' where org_id = ''' || a || '''');
  perform pg_temp.su();
  perform pg_temp.res('32 trial A edit applied in A', e = '' and exists (select 1 from public.leads where org_id = a and notes = 'edited in A'), e);
  perform pg_temp.res('33 trial B + master untouched by A edit', pg_temp.fp(b) = pg_temp.get('B0')
    and pg_temp.fp('a5a5a5a5-0166-4000-8000-000000000001') = pg_temp.get('M0'));
  perform pg_temp.res('34 trial B identical dataset (names)',
    (select string_agg(name, ',' order by name) from public.crew_members where org_id = b) = (select string_agg(name, ',' order by name) from public.crew_members where org_id = a));
  perform pg_temp.login('mf_b@t.test');
  perform pg_temp.res('35 RLS: trial B cannot see trial A', not exists (select 1 from public.quotes where org_id = a)
    and not exists (select 1 from public.quotes where org_id = 'a5a5a5a5-0166-4000-8000-000000000001'));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x clone', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) publish snapshot: half-edited master never leaks; roll back --------------------------------
do $$ declare c uuid; d uuid; e uuid; r jsonb; nv int; begin
  perform pg_temp.su();
  update public.inventory_items set name = E'Demo \u00b7 HALF EDIT' where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and name = E'Demo \u00b7 Napkins (cloth)';
  c := pg_temp.trial('mf_c@t.test');
  perform pg_temp.res('40 unpublished master edit does NOT reach a new trial',
    not exists (select 1 from public.inventory_items where org_id = c and name like '%HALF EDIT%')
    and exists (select 1 from public.inventory_items where org_id = c and name = E'Demo \u00b7 Napkins (cloth)'));
  nv := (select max(version) from public.helm_trial_seed_manifest) + 1;
  r := public.publish_sample_manifest('test v2');
  perform pg_temp.res('41 publish makes the next version current', (r ->> 'version')::int = nv
    and (select version from public.helm_trial_seed_manifest where is_current) = nv
    and (select count(*) from public.helm_trial_seed_manifest where is_current) = 1, r::text);
  d := pg_temp.trial('mf_d@t.test');
  perform pg_temp.res('42 after publish the edit reaches NEW trials', exists (select 1 from public.inventory_items where org_id = d and name like '%HALF EDIT%')
    and (select sample_version from public.organizations where id = d) = nv);
  perform pg_temp.res('43 existing trials are never re-seeded', not exists (select 1 from public.inventory_items where org_id = c and name like '%HALF EDIT%'));
  perform public.set_current_sample_manifest(1);
  -- and the dates of a version follow ITS anchor: move v1's anchor 2 days back
  update public.helm_trial_seed_manifest set anchor_date = anchor_date - 2 where version = 1;
  e := pg_temp.trial('mf_e@t.test');
  perform pg_temp.res('44 roll back to v1: edit gone again', not exists (select 1 from public.inventory_items where org_id = e and name like '%HALF EDIT%')
    and (select sample_version from public.organizations where id = e) = 1);
  perform pg_temp.res('45 date shift = days since the anchor', exists (select 1 from public.quotes where org_id = e and lifecycle_stage = 'planning' and event_date = current_date + 12));
  perform pg_temp.res('46 publish audited', exists (select 1 from public.audit_log where action = 'trial.sample_published'));
exception when others then perform pg_temp.su(); insert into _uf values ('4x publish', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) Skip OTP on the sent sample quote (trial test mode) -----------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('mf_a@t.test');
  r := public.trial_test_approve(pg_temp.get('A_token')::uuid, null, E'Demo \u00b7 Rohit Sharma', 'v1', 'I agree (test)', 'test');
  perform pg_temp.su();
  perform pg_temp.res('50 Skip OTP approves the sent sample quote', coalesce((r ->> 'approved')::boolean, false), r::text);
  perform pg_temp.login('mf_b@t.test');
  e := coalesce((public.trial_test_approve(pg_temp.get('A_token')::uuid, null, 'x', 'v1', 'x', 'x')) ->> 'error', 'none');
  perform pg_temp.su();
  perform pg_temp.res('51 another studio cannot use the token', e <> 'none', e);
exception when others then perform pg_temp.su(); insert into _uf values ('5x otp', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) seats: "N of M used" ------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; e text; begin
  perform pg_temp.login('mf_a@t.test');
  r := public.my_seat_usage();
  perform pg_temp.res('60 seats: 1 of 3 (admin only)', (r ->> 'limit')::int = 3 and (r ->> 'used')::int = 1 and (r ->> 'extra_used')::int = 0
    and (r ->> 'extra_limit')::int = 2 and not (r ->> 'at_limit')::boolean, r::text);
  perform pg_temp.su();
  insert into public.invitations(org_id, email, role, token, status, expires_at) values (a, 'p1@t.test', 'sales', 'tok-mf1', 'pending', now() + interval '7 days');
  insert into public.invitations(org_id, email, role, token, status, expires_at) values (a, 'p2@t.test', 'manager', 'tok-mf2', 'pending', now() + interval '7 days');
  perform pg_temp.login('mf_a@t.test');
  r := public.my_seat_usage();
  perform pg_temp.res('61 pending invites count: 2 of 2 extra used, at limit', (r ->> 'used')::int = 3 and (r ->> 'pending')::int = 2
    and (r ->> 'extra_used')::int = 2 and (r ->> 'at_limit')::boolean, r::text);
  perform pg_temp.su();
  e := pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || a || ''', ''p3@t.test'', ''sales'', ''tok-mf3'', ''pending'', now() + interval ''7 days'')');
  perform pg_temp.res('62 3rd extra refused', e like '42501%', e);
  update public.invitations set status = 'revoked' where org_id = a and email = 'p2@t.test';
  e := pg_temp.try('insert into public.invitations(org_id, email, role, token, status, expires_at) values (''' || a || ''', ''p3@t.test'', ''sales'', ''tok-mf3'', ''pending'', now() + interval ''7 days'')');
  perform pg_temp.res('63 revoke frees the seat, re-add works', e = '', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.my_seat_usage();
  perform pg_temp.res('64 paid studio: no limit', not (r ->> 'limited')::boolean and r ->> 'limit' is null, r::text);
  perform pg_temp.su();
  perform pg_temp.res('65 anon cannot read seats', not has_function_privilege('anon', 'public.my_seat_usage()', 'execute'));
exception when others then perform pg_temp.su(); insert into _uf values ('6x seats', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5b) 2-step welcome, step 1: name the trial studio --------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; e text; begin
  perform pg_temp.login('mf_a@t.test');
  r := public.trial_welcome_setup('Aurora Events', null, '+91 98480 12345');
  perform pg_temp.su();
  perform pg_temp.res('66 welcome: studio renamed, city defaults to Hyderabad, phone kept',
    (select name = 'Aurora Events' and location = 'Hyderabad' and brand ->> 'phone' = '+91 98480 12345' from public.organizations where id = a)
    and (select count(*) from public.quotes where org_id = a and is_demo) >= 7, r::text);
  perform pg_temp.res('67 welcome: slug follows the name', (select public_slug like 'aurora-events%' from public.organizations where id = a), r::text);
  perform pg_temp.login('mf_a@t.test');
  e := pg_temp.try('select public.trial_welcome_setup('' '', ''x'', null)');
  perform pg_temp.res('68 welcome: empty name refused', e like '22023%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.trial_welcome_setup(''Hijack'', ''x'', null)');
  perform pg_temp.res('69 welcome: not for a paid studio', e like '22023%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('6y welcome', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) clear + reset ---------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; b uuid := pg_temp.get('B')::uuid; r jsonb; begin
  -- 0202: a trial studio cannot write task templates from the app any more, so this "own" template is
  -- written by Helm (superuser, no API claims); it is still the studio's own row (not is_demo)
  perform pg_temp.su();
  insert into public.task_templates(org_id, category, title, seq) values (a, 'Setup', 'My own task', 9);
  perform pg_temp.login('mf_a@t.test');
  insert into public.nurture(org_id, name, occasion_type) values (a, 'My real contact', 'custom');
  perform pg_temp.su(); perform pg_temp.put('B1', pg_temp.fp(b));
  perform pg_temp.login('mf_a@t.test');
  r := public.clear_sample_data();
  perform pg_temp.su();
  perform pg_temp.res('70 clear: sample events, leads, nurture, templates gone',
    not exists (select 1 from public.quotes where org_id = a and is_demo) and not exists (select 1 from public.leads where org_id = a and is_demo)
    and not exists (select 1 from public.nurture where org_id = a and is_demo) and not exists (select 1 from public.task_templates where org_id = a and is_demo)
    and not exists (select 1 from public.checklist_templates where org_id = a and is_demo)
    and not exists (select 1 from public.run_sheet_items where org_id = a) and not exists (select 1 from public.event_tasks where org_id = a), r::text);
  perform pg_temp.res('71 clear: own rows survive', exists (select 1 from public.task_templates where org_id = a and title = 'My own task')
    and exists (select 1 from public.nurture where org_id = a and name = 'My real contact'));
  perform pg_temp.res('72 clear: trial B untouched', pg_temp.fp(b) = pg_temp.get('B1'));
  perform pg_temp.login('mf_a@t.test');
  r := public.reset_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('73 reset re-seeds a cleared trial', (select count(*) from public.quotes where org_id = a and is_demo) = 4, r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('7x clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-MANIFEST-0167: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-MANIFEST-0167: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
