-- =====================================================================
-- SEC-05/06/07 PRECHECK — READ-ONLY (SELECT / SHOW only)
-- Safe on STAGING and PRODUCTION: no INSERT/UPDATE/DELETE/DDL/GRANT/DO,
-- no mutating RPC. query_to_xml() is used only to run read-only COUNTs.
-- Run as one script in psql, or statement-by-statement in the SQL editor.
-- =====================================================================

-- 1  invite-media bucket
select 'bucket' as section, id, name, public, allowed_mime_types, file_size_limit
  from storage.buckets where id = 'invite-media';

-- 2  who is running this
select 'session' as section, current_user, session_user, current_database(), version();

-- 3  owners of public functions
select 'fn_owner' as section, pg_get_userbyid(p.proowner) as owner, count(*) as functions
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' group by 1, 2 order by 3 desc;

-- 4  default function ACLs (global + per schema) for every role
select 'default_acl' as section, pg_get_userbyid(defaclrole) as role,
       coalesce(nullif(defaclnamespace, 0)::regnamespace::text, '<global>') as scope, defaclacl
  from pg_default_acl where defaclobjtype = 'f' order by 2, 3;

-- 4b EFFECTIVE privileges a new function in public would get, per owner role
with owners as (select distinct p.proowner r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
eff as (select o.r,
         coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 0 and defaclobjtype = 'f'), acldefault('f', o.r))
      || coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'), '{}'::aclitem[]) as acl
   from owners o)
select 'effective_new_fn' as section, pg_get_userbyid(r) as owner,
       exists (select 1 from aclexplode(acl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
       exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE') as anon_exec,
       exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE') as authenticated_exec
  from eff;

-- 5/6 transaction isolation (G3 assumes READ COMMITTED for API traffic)
show default_transaction_isolation;
select 'role_config' as section, rolname, rolconfig from pg_roles
 where rolname in ('anon', 'authenticated', 'authenticator', 'service_role', 'postgres') order by rolname;
select 'db_config' as section, d.datname, s.setconfig
  from pg_db_role_setting s left join pg_database d on d.oid = s.setdatabase
 where array_to_string(s.setconfig, ',') ilike '%isolation%';

-- 7/8 links without expiry (and how many the v2 backfill would expire at once)
select 'links' as section,
  (select count(*) from public.quotes where approval_token is not null) as approval_links,
  (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at is null) as approval_null_expiry,
  (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at is null
      and greatest(updated_at + interval '30 days', coalesce(event_date::timestamptz + interval '30 days', '-infinity')) <= now()) as approval_backfill_expires_now,
  (select count(*) from public.work_tokens) as worker_links,
  (select count(*) from public.work_tokens where expires_at is null) as worker_null_expiry,
  (select count(*) from public.work_tokens w left join public.quotes q on q.id = w.quote_id where w.expires_at is null
      and greatest(w.created_at + interval '60 days', coalesce(q.event_date::timestamptz + interval '14 days', '-infinity')) <= now()) as worker_backfill_expires_now;

-- 9/10/11 prerequisites
select 'prereq' as section, x.needs, x.present from (values
  ('SEC-05 quotes.approval_token_expires_at', exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_expires_at')),
  ('SEC-05 event_proposal.share_token_expires_at', exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_proposal' and column_name='share_token_expires_at')),
  ('SEC-05 design_stages.revision', exists (select 1 from information_schema.columns where table_schema='public' and table_name='design_stages' and column_name='revision')),
  ('SEC-05 event_tasks.verify_status', exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_tasks' and column_name='verify_status')),
  ('SEC-05 helm_quote_total(jsonb)', to_regprocedure('public.helm_quote_total(jsonb)') is not null),
  ('SEC-05 assert_quote_org(uuid)', to_regprocedure('public.assert_quote_org(uuid)') is not null),
  ('SEC-05 has_area(text,text)', to_regprocedure('public.has_area(text,text)') is not null),
  ('SEC-05 extensions.gen_random_bytes', to_regprocedure('extensions.gen_random_bytes(integer)') is not null),
  ('SEC-06 inventory_reservations.org_id', exists (select 1 from information_schema.columns where table_schema='public' and table_name='inventory_reservations' and column_name='org_id')),
  ('SEC-06 inventory_items.total_qty', exists (select 1 from information_schema.columns where table_schema='public' and table_name='inventory_items' and column_name='total_qty')),
  ('SEC-06 invitations.token', exists (select 1 from information_schema.columns where table_schema='public' and table_name='invitations' and column_name='token')),
  ('SEC-07 work_tokens.expires_at', exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at')),
  ('SEC-07 quotes.approval_token_revoked_at', exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='approval_token_revoked_at')),
  ('SEC-07 event_tasks.assignee_phone', exists (select 1 from information_schema.columns where table_schema='public' and table_name='event_tasks' and column_name='assignee_phone')),
  ('SEC-07 hashtextextended()', to_regprocedure('hashtextextended(text,bigint)') is not null),
  ('SEC-05 applied (generate_approval_token has F10)', coalesce((select pg_get_functiondef(p.oid) like '%SEC-05 F10%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='generate_approval_token' limit 1), false)),
  ('role_access rows exist for every studio', not exists (select 1 from public.organizations o where not exists (select 1 from public.role_access ra where ra.org_id = o.id)))
) as x(needs, present);

-- 12/15 objects the migrations create or replace: present? + fingerprint of today's body
select 'function' as section, f.name, p.oid is not null as exists_now,
       case when p.oid is not null then md5(pg_get_functiondef(p.oid)) end as body_md5,
       case when p.oid is not null then pg_get_functiondef(p.oid) like '%SEC-05%' end as has_sec05,
       case when p.oid is not null then pg_get_functiondef(p.oid) like '%SEC-07%' end as has_sec07
  from (values ('_flag(text)'),('_flag(text,uuid)'),('_notify(uuid,text,text,text,jsonb)'),('request_otp(uuid,text)'),('create_payment(uuid)'),
               ('public_get_proposal(uuid)'),('public_get_portal(uuid)'),('design_advance(uuid,text,text,timestamptz)'),
               ('generate_approval_token(uuid)'),('save_quotation_version(uuid,jsonb)'),
               ('record_payment(uuid,numeric,text,text,uuid,text,text)'),('set_discovery(uuid,date,text,text,text,text,numeric,numeric)'),
               ('set_event_plan(uuid,text,text,text,text,text,text)'),('set_proposal(uuid,text,text,jsonb,jsonb,jsonb)'),
               ('mark_paid(uuid,text)'),('tg_guard_task_verify()'),('return_reservation(uuid,numeric)'),('invitation_preview(text)'),
               ('tg_approval_token_expiry()'),('tg_work_token_expiry()'),('tg_work_token_renew()'),('tg_otp_rate_limit()'),('tg_quote_org_match()')) f(name)
  left join pg_proc p on p.oid = to_regprocedure('public.' || f.name)
 order by f.name;

select 'trigger' as section, tgname, tgrelid::regclass as on_table, pg_get_triggerdef(oid) as def
  from pg_trigger
 where not tgisinternal and tgname in ('zz_task_verify_guard','zz_approval_token_expiry','zz_work_token_expiry','zz_work_token_renew','zz_otp_rate_limit')
 order by 2, 3;

select 'policy' as section, schemaname, tablename, policyname, cmd, qual, with_check from pg_policies
 where (schemaname = 'public' and tablename in ('invitations','organizations'))
    or (schemaname = 'storage' and tablename = 'objects' and policyname like 'invite_media%')
 order by 2, 3, 4;

select 'view' as section, c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'inventory_availability';

-- 13 G4 candidate tables: FK to quotes? guard trigger present?
with cand as (
  select c.table_name::text t from information_schema.columns c
    join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
    join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name and x.table_type='BASE TABLE'
   where c.table_schema='public' and c.column_name='quote_id' and c.table_name <> 'quotes')
select 'g4_table' as section, t,
       exists (select 1 from pg_constraint k join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey)
                where k.contype='f' and k.conrelid=('public.'||t)::regclass and k.confrelid='public.quotes'::regclass and a.attname='quote_id') as fk_to_quotes,
       exists (select 1 from pg_trigger g where g.tgrelid=('public.'||t)::regclass and g.tgname='zz_quote_org_match') as guarded,
       (select string_agg(tgname, ',' order by tgname) from pg_trigger g where g.tgrelid=('public.'||t)::regclass and not g.tgisinternal
          and (g.tgtype & 2) = 2 and g.tgname > 'zz_quote_org_match') as before_triggers_after_guard,
       -- 14 existing cross-studio rows (read-only COUNT)
       (xpath('/row/n/text()', query_to_xml(format(
          'select count(*) as n from public.%I x join public.quotes q on q.id = x.quote_id where x.org_id is distinct from q.org_id', t),
          false, true, '')))[1]::text::int as cross_org_rows
  from cand order by t;
