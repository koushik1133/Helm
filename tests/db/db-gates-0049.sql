-- db-gates-0049.sql — 0049: close gate (ledger balance + open checkouts, audited admin
-- override), quotes direct-write lockdown, clean default matrix for new studios (NV-08),
-- statement timeouts, per-studio storage quota + uploads/hour.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _g49; create temp table _g49(name text, result text); grant all on _g49 to anon, authenticated;

-- run p_sql as a user ('anon' / e-mail / null = superuser); 'ok:<rows>' or 'err:<state>:<msg>'
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare n bigint;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql; get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || n;
exception when others then
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g49 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

-- setup: an item checked out to quote A; sales gets closure edit in A (role with edit, below admin)
do $$ begin
  execute 'reset role';
  delete from public.inventory_checkouts where note = 'g49';
  delete from public.event_close_overrides where quote_id = 'a0000000-0000-4000-8000-00000000da01';  -- disposable test DB
  delete from public.quote_payments where quote_id = 'a0000000-0000-4000-8000-00000000da01' and provider_ref like 'g49-%';
  update public.event_closure set closed_at = null where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  update public.quotes set lifecycle_stage = 'settlement' where id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.inventory_items(id, name, total_qty, org_id) values
    ('a0000000-0000-4000-8000-0000000049e1', 'G49 Chiavari chair', 100, 'a0000000-0000-4000-8000-000000000001')
    on conflict (id) do nothing;
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, status, note, org_id) values
    ('a0000000-0000-4000-8000-0000000049e1', 'a0000000-0000-4000-8000-00000000da01', 40, 'Crew lead', 'out', 'g49',
     'a0000000-0000-4000-8000-000000000001');
  update public.role_access set can_view = false, can_edit = false where role = 'sales' and area = 'closure';
end $$;

-- ---- 1) close gate ---------------------------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true)$q$);
  perform pg_temp.t('close: sales WITHOUT closure edit is refused', r like 'err:42501%', r);
  insert into public.role_access(role, area, can_view, can_edit, org_id) values ('sales', 'closure', true, true, 'a0000000-0000-4000-8000-000000000001')
    on conflict (org_id, role, area) do update set can_view = true, can_edit = true;

  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true)$q$);
  perform pg_temp.t('close: refused while ledger balance owed + equipment out', r like 'err:P0001%balance still owed: %' and r like '%G49 Chiavari chair x40%', r);
  perform pg_temp.t('close: refused close left the event open',
    not exists (select 1 from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01' and closed_at is not null)
    and (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = 'settlement', null);

  -- a milestone marked paid is NOT money on the ledger
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event_blockers('a0000000-0000-4000-8000-00000000da01')$q$);
  perform pg_temp.t('blockers: admin can read the reasons', r = 'ok:1', r);

  insert into public.quote_payments(quote_id, amount, status, provider_ref, org_id)
    select 'a0000000-0000-4000-8000-00000000da01',
           (select (pricing ->> 'total')::numeric from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01')
             - public.helm_total_paid('a0000000-0000-4000-8000-00000000da01', null, null),
           'paid', 'g49-full', 'a0000000-0000-4000-8000-000000000001';   -- whatever is left (earlier suites may have paid some)
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true)$q$);
  perform pg_temp.t('close: paid in full but equipment out → still refused (checkout only)', r like 'err:P0001%' and r not like '%balance%' and r like '%checkout%', r);

  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'client keeps chairs for a week')$q$);
  perform pg_temp.t('override: a non-admin (sales with closure edit) cannot override', r like 'err:42501%Only an admin%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, '   ')$q$);
  perform pg_temp.t('override: admin with a blank reason is refused', r like 'err:P0001%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'abc')$q$);
  perform pg_temp.t('override: admin with a too-short reason is refused', r like 'err:22023%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'cross studio attempt')$q$);
  perform pg_temp.t('override: Org B admin cannot close Org A event', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.close_event_blockers('a0000000-0000-4000-8000-00000000da01')$q$);
  perform pg_temp.t('blockers: Org B admin cannot read Org A blockers', r like 'err:42501%', r);
  perform pg_temp.t('override: refused attempts recorded nothing',
    not exists (select 1 from public.event_close_overrides where quote_id = 'a0000000-0000-4000-8000-00000000da01'), null);

  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'client keeps chairs for a week')$q$);
  perform pg_temp.t('override: admin with a reason closes the event', r = 'ok:1'
    and exists (select 1 from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01' and closed_at is not null), r);
  perform pg_temp.t('override: audited in event_close_overrides (reason, actor, blockers)',
    exists (select 1 from public.event_close_overrides o join auth.users u on u.id = o.actor
             where o.quote_id = 'a0000000-0000-4000-8000-00000000da01' and o.reason = 'client keeps chairs for a week'
               and u.email = 'a_admin@a.test' and o.open_checkouts = 1 and o.balance_owed = 0
               and o.org_id = 'a0000000-0000-4000-8000-000000000001'), null);
  perform pg_temp.t('override: audited in audit_log',
    exists (select 1 from public.audit_log where action = 'close_override' and quote_id = 'a0000000-0000-4000-8000-00000000da01'
             and changed ->> 'reason' = 'client keeps chairs for a week'), null);

  r := pg_temp.as_try('a_staff@a.test', $q$select 1 from public.event_close_overrides$q$);
  perform pg_temp.t('overrides: Org A closure user reads A''s overrides', r = 'ok:1', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select 1 from public.event_close_overrides$q$);
  perform pg_temp.t('overrides: Org B reads none of A''s overrides', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$insert into public.event_close_overrides(org_id, quote_id, reason) values ('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-00000000da01','forged entry')$q$);
  perform pg_temp.t('overrides: no direct insert (forging) by API roles', r like 'err:42501%', r);

  -- reopen, return the kit → a normal close works with no override
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', false)$q$);
  perform pg_temp.t('reopen (p_closed=false) is never gated', r = 'ok:1', r);
  update public.inventory_checkouts set status = 'returned', qty_in = qty_out where note = 'g49';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true)$q$);
  perform pg_temp.t('close: nothing outstanding → closes without override', r = 'ok:1'
    and (select lifecycle_stage from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = 'closed', r);
  perform pg_temp.t('close: a plain close adds no override row',
    (select count(*) from public.event_close_overrides where quote_id = 'a0000000-0000-4000-8000-00000000da01') = 1, null);

  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000000da01', 'closed')$q$);
  perform pg_temp.t('set_lifecycle_stage → closed still refused', r like 'err:22023%', r);
  r := pg_temp.as_try('anon', $q$select public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'anon try')$q$);
  perform pg_temp.t('anon cannot call close_event', r like 'err:42501%', r);
end $$;

-- ---- 2) quotes direct-write lockdown -------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set title = 'Wedding A (renamed)', client = client || '{"note":"g49"}', pricing = pricing, event_date = event_date, event_time = event_time where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: allowed columns still update directly (updateMeta)', r = 'ok:1', r);
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set manager_id = null where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: manager_id still updates (setEventManager)', r = 'ok:1', r);
  r := pg_temp.as_try('a_staff@a.test', $q$update public.quotes set status = 'confirmed' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: direct status write refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$update public.quotes set lifecycle_stage = 'settlement' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: direct lifecycle_stage write refused (even admin)', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$update public.quotes set org_id = 'b0000000-0000-4000-8000-000000000001' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: direct org_id write refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$update public.quotes set approval_token = gen_random_uuid() where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: direct approval_token write refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$insert into public.quotes(code, title) values ('G49-X', 'direct insert')$q$);
  perform pg_temp.t('quotes: direct INSERT refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$delete from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: direct DELETE of a live quote removes nothing (shelf-only policy)', r = 'ok:0', r);
  r := pg_temp.as_try('anon', $q$update public.quotes set title = 'x'$q$);
  perform pg_temp.t('quotes: anon cannot update', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$update public.quotes set title = 'hijack' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.t('quotes: Org B admin updates 0 Org A rows', r = 'ok:0', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.create_quote('G49-RPC', 'via rpc', 'wedding', '{}'::jsonb, 0, null)$q$);
  perform pg_temp.t('quotes: create_quote RPC still works', r = 'ok:1', r);
  perform pg_temp.t('quotes: no table-level UPDATE left for authenticated',
    not has_table_privilege('authenticated', 'public.quotes', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.quotes', 'INSERT')
    and not has_table_privilege('anon', 'public.quotes', 'DELETE')
    and has_column_privilege('authenticated', 'public.quotes', 'pricing', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.quotes', 'status', 'UPDATE'), null);
  delete from public.quotes where code = 'G49-RPC';
end $$;

-- ---- 3) NV-08 clean matrix for a NEW studio ---------------------------------------------
do $$ declare r text; v_org uuid; v_before text; v_after text; n int; begin
  execute 'reset role';
  insert into public.organizations(id, name, currency, timezone) values ('00000000-0000-4000-8000-000000000001', 'Helm template', 'INR', 'Asia/Kolkata')
    on conflict (id) do nothing;
  insert into public.role_access(role, area, can_view, can_edit, org_id) values
    ('sales', 'finance', true, true, '00000000-0000-4000-8000-000000000001'),
    ('crew',  'zz_custom', true, true, '00000000-0000-4000-8000-000000000001')
    on conflict (org_id, role, area) do update set can_view = true, can_edit = true;
  select string_agg(role || area || can_view || can_edit, ',' order by role, area) into v_before
    from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001';
  if not exists (select 1 from auth.users where email = 'g49_new@c.test') then perform auth.seed_user('g49_new@c.test'); end if;
  r := pg_temp.as_try('g49_new@c.test', $q$select public.create_studio('G49 New Studio', 'g49_new@c.test')$q$);
  select org_id into v_org from public.profiles where email = 'g49_new@c.test';
  perform pg_temp.t('NV-08: create_studio works for a new user', r = 'ok:1' and v_org is not null, r);
  perform pg_temp.t('NV-08: template studio''s widened rows NOT copied (sales finance off)',
    exists (select 1 from public.role_access where org_id = v_org and role = 'sales' and area = 'finance' and not can_view and not can_edit), null);
  perform pg_temp.t('NV-08: template-only custom area is switched off',
    not exists (select 1 from public.role_access where org_id = v_org and area = 'zz_custom' and (can_view or can_edit)), null);
  select count(*) into n from public.role_access ra join public._a49_default_matrix() d using (role, area)
   where ra.org_id = v_org and ra.can_view = d.can_view and ra.can_edit = d.can_edit;
  perform pg_temp.t('NV-08: every default (role, area) row present and equal', n = (select count(*) from public._a49_default_matrix()), n::text);
  perform pg_temp.t('NV-08: admin full on every area',
    not exists (select 1 from public.role_access where org_id = v_org and role = 'admin' and not (can_view and can_edit)), null);
  perform pg_temp.t('NV-08: manager edits closure, sales sees leads only, crew nothing',
    exists (select 1 from public.role_access where org_id = v_org and role = 'manager' and area = 'closure' and can_edit)
    and (select count(*) from public.role_access where org_id = v_org and role = 'sales' and can_view) = 2
    and not exists (select 1 from public.role_access where org_id = v_org and role in ('crew', 'worker', 'client') and (can_view or can_edit)), null);
  select string_agg(role || area || can_view || can_edit, ',' order by role, area) into v_after
    from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.t('NV-08: existing studio''s matrix untouched', v_before = v_after, null);
  r := pg_temp.as_try('g49_new@c.test', $q$select public.create_studio('Second try')$q$);
  perform pg_temp.t('NV-08: second create_studio returns the same studio (no reseed)', r = 'ok:1'
    and (select count(*) from public.organizations where created_by = (select id from auth.users where email = 'g49_new@c.test')) = 1, r);
end $$;

-- ---- 4) limits -----------------------------------------------------------------------
do $$ begin
  perform pg_temp.t('timeouts: anon statement_timeout <= 8s',
    exists (select 1 from pg_db_role_setting d join pg_roles r on r.oid = d.setrole, unnest(d.setconfig) s
             where r.rolname = 'anon' and d.setdatabase = 0 and s in ('statement_timeout=8s', 'statement_timeout=3s')), null);
  perform pg_temp.t('timeouts: authenticated statement_timeout <= 15s',
    exists (select 1 from pg_db_role_setting d join pg_roles r on r.oid = d.setrole, unnest(d.setconfig) s
             where r.rolname = 'authenticated' and d.setdatabase = 0 and s in ('statement_timeout=15s', 'statement_timeout=8s')), null);
end $$;

do $$ declare r text; v_qa bigint; v_rb int; begin
  execute 'reset role';
  delete from storage.objects where metadata ->> 'g49' = '1';
  drop policy if exists g49_test_allow_all on storage.objects;
  create policy g49_test_allow_all on storage.objects for insert to anon, authenticated with check (true);
  create temp table if not exists _g49_subs as select org_id from public.studio_subscriptions
    where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
  -- limits relative to what earlier suites already stored: A has 1000 bytes of room, B one upload left this hour
  select coalesce(sum(case when coalesce(metadata ->> 'size', '') ~ '^[0-9]{1,15}$' then (metadata ->> 'size')::bigint else 0 end), 0) + 1000 into v_qa
    from storage.objects where name like 'a0000000-0000-4000-8000-000000000001/%';
  select count(*) + 1 into v_rb from storage.objects
   where name like 'b0000000-0000-4000-8000-000000000001/%' and created_at > now() - interval '1 hour';
  insert into public.studio_subscriptions(org_id, storage_quota_bytes, uploads_per_hour) values ('a0000000-0000-4000-8000-000000000001', v_qa, null)
    on conflict (org_id) do update set storage_quota_bytes = v_qa, uploads_per_hour = null;
  insert into public.studio_subscriptions(org_id, storage_quota_bytes, uploads_per_hour) values ('b0000000-0000-4000-8000-000000000001', null, v_rb)
    on conflict (org_id) do update set storage_quota_bytes = null, uploads_per_hour = v_rb;

  r := pg_temp.as_try('a_admin@a.test', $q$insert into storage.objects(bucket_id, name, metadata) values ('event-docs', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || replace(gen_random_uuid()::text, '-', '') || '.pdf', '{"size":600,"g49":"1"}')$q$);
  perform pg_temp.t('quota: Org A upload under its quota allowed', r = 'ok:1', r);
  r := pg_temp.as_try('a_admin@a.test', $q$insert into storage.objects(bucket_id, name, metadata) values ('event-docs', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || replace(gen_random_uuid()::text, '-', '') || '.pdf', '{"size":600,"g49":"1"}')$q$);
  perform pg_temp.t('quota: Org A upload over its quota refused with a clear message', r like 'err:53400%storage is full%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$insert into storage.objects(bucket_id, name, metadata) values ('event-docs', 'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/' || replace(gen_random_uuid()::text, '-', '') || '.pdf', '{"size":600,"g49":"1"}')$q$);
  perform pg_temp.t('quota: Org B unaffected by Org A''s quota', r = 'ok:1', r);
  r := pg_temp.as_try('b_admin@b.test', $q$insert into storage.objects(bucket_id, name, metadata) values ('event-docs', 'b0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-00000000da01/' || replace(gen_random_uuid()::text, '-', '') || '.pdf', '{"size":10,"g49":"1"}')$q$);
  perform pg_temp.t('rate: Org B 2nd upload in the hour refused ', r like 'err:53400%Too many uploads%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$insert into storage.objects(bucket_id, name, metadata) values ('event-docs', 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || replace(gen_random_uuid()::text, '-', '') || '.pdf', '{"size":1,"g49":"1"}')$q$);
  perform pg_temp.t('quota: Org B cannot write into Org A''s prefix', r like 'err:%', r);
  perform pg_temp.t('quota: default limits are 2 GB / 200 per hour',
    (select storage_quota_bytes = 2147483648 and uploads_per_hour = 200 from public.studio_upload_limits(gen_random_uuid())), null);
  perform pg_temp.t('quota policy is RESTRICTIVE',
    exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'upload_quota_insert' and permissive = 'RESTRICTIVE'), null);

  execute 'reset role';
  drop policy if exists g49_test_allow_all on storage.objects;
  delete from storage.objects where metadata ->> 'g49' = '1';
  update public.studio_subscriptions set storage_quota_bytes = null, uploads_per_hour = null
   where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
  delete from public.studio_subscriptions                                   -- only the rows this suite created
   where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')
     and org_id not in (select org_id from _g49_subs);
end $$;

-- leave quote A as the fixture had it (disposable test DB)
do $$ begin
  execute 'reset role';
  delete from public.inventory_checkouts where note = 'g49';
  delete from public.quote_payments where provider_ref like 'g49-%';
  update public.event_closure set closed_at = null where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  update public.quotes set lifecycle_stage = 'quote', title = 'Wedding A', client = client - 'note' where id = 'a0000000-0000-4000-8000-00000000da01';
  update public.role_access set can_view = false, can_edit = false where role = 'sales' and area = 'closure';
end $$;

select name, result from _g49 order by name;
select case when count(*) filter (where result not like 'PASS%') = 0 then 'DB-GATES-0049: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'DB-GATES-0049: ' || count(*) filter (where result not like 'PASS%') || ' FAILED' end from _g49;
