-- =============================================================================
-- PRODUCTION PRECHECK — SEC-05 / SEC-06 / SEC-07 (v2).  READ-ONLY.
-- Paste the whole file into the SQL editor of the PRODUCTION project
-- (nqltzgiwznphugcfhmbm) and Run. It changes nothing:
--   * SET TRANSACTION READ ONLY makes the database itself reject any write
--     (in the SQL editor the file runs as one transaction);
--   * the rest is ONE SELECT. query_to_xml() only runs read-only COUNT(*)
--     queries against tables that may or may not exist;
--   * no INSERT/UPDATE/DELETE/DDL/GRANT/REVOKE, no DO block, no RPC call,
--     no Edge Function, no storage change.
-- Output: one table (≈100 rows). Export it (CSV) or screenshot every row.
-- =============================================================================
set transaction read only;

with
fn(name) as (values
  ('_flag(text)'), ('_flag(text,uuid)'), ('_notify(uuid,text,text,text,jsonb)'), ('request_otp(uuid,text)'), ('create_payment(uuid)'),
  ('public_get_quote(uuid)'), ('public_get_proposal(uuid)'), ('public_get_portal(uuid)'), ('design_advance(uuid,text,text,timestamptz)'),
  ('generate_approval_token(uuid)'), ('revoke_approval_token(uuid)'), ('save_quotation_version(uuid,jsonb)'),
  ('record_payment(uuid,numeric,text,text,uuid,text,text)'), ('set_discovery(uuid,date,text,text,text,text,numeric,numeric)'),
  ('set_event_plan(uuid,text,text,text,text,text,text)'), ('set_proposal(uuid,text,text,jsonb,jsonb,jsonb)'),
  ('mark_paid(uuid,text)'), ('tg_guard_task_verify()'), ('return_reservation(uuid,numeric)'), ('invitation_preview(text)'),
  ('invitation_by_token(text)'), ('worker_get_tasks(uuid)'), ('verify_and_consent(uuid,text,text,boolean,text,text,text,text)'),
  ('tg_approval_token_expiry()'), ('tg_work_token_expiry()'), ('tg_work_token_renew()'), ('tg_otp_rate_limit()'), ('tg_quote_org_match()'),
  ('has_area(text,text)'), ('current_org_id()'), ('assert_quote_org(uuid)'), ('helm_quote_total(jsonb)'), ('can_edit()'), ('is_admin()')),
f as (select name, to_regprocedure('public.' || name) as oid,
             coalesce(pg_get_functiondef(to_regprocedure('public.' || name)), '') as body from fn),
b as (select name, body from f),
col as (select table_name || '.' || column_name as c, column_default from information_schema.columns where table_schema = 'public'),
cand as (select c.table_name::text t from information_schema.columns c
           join information_schema.columns o on o.table_schema = c.table_schema and o.table_name = c.table_name and o.column_name = 'org_id'
           join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
          where c.table_schema = 'public' and c.column_name = 'quote_id' and c.table_name <> 'quotes'),
cand_n as (select t,
             (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I x join public.quotes q on q.id = x.quote_id where x.org_id is distinct from q.org_id', t), false, true, '')))[1]::text::bigint as cross_org,
             (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I x where x.quote_id is not null and not exists (select 1 from public.quotes q where q.id = x.quote_id)', t), false, true, '')))[1]::text::bigint as dangling,
             exists (select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
                      where k.contype = 'f' and k.conrelid = ('public.' || t)::regclass and k.confrelid = 'public.quotes'::regclass and a.attname = 'quote_id') as fk,
             exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = 'zz_quote_org_match') as guarded
           from cand),
owners as (select distinct p.proowner r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
eff as (select o.r,
          coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 0 and defaclobjtype = 'f'), acldefault('f', o.r))
       || coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'), '{}'::aclitem[]) as acl
        from owners o),
cnt(k, needs, sql) as (values   -- read-only counts; skipped (→ null) when a table/column is absent
  ('approval_links', array['quotes.approval_token'],        'select count(*) as n from public.quotes where approval_token is not null'),
  ('approval_null_exp', array['quotes.approval_token','quotes.approval_token_expires_at'],     'select count(*) as n from public.quotes where approval_token is not null and approval_token_expires_at is null'),
  ('approval_expired', array['quotes.approval_token','quotes.approval_token_expires_at'],      'select count(*) as n from public.quotes where approval_token is not null and approval_token_expires_at <= now()'),
  ('approval_backfill_now', array['quotes.approval_token','quotes.approval_token_expires_at','quotes.updated_at','quotes.event_date'], 'select count(*) as n from public.quotes where approval_token is not null and approval_token_expires_at is null and greatest(least(updated_at + interval ''30 days'', now() + interval ''30 days''), coalesce(event_date::timestamptz + interval ''30 days'', ''-infinity'')) <= now()'),
  ('approval_backfill_7d', array['quotes.approval_token','quotes.approval_token_expires_at','quotes.updated_at','quotes.event_date'],  'select count(*) as n from public.quotes where approval_token is not null and approval_token_expires_at is null and greatest(least(updated_at + interval ''30 days'', now() + interval ''30 days''), coalesce(event_date::timestamptz + interval ''30 days'', ''-infinity'')) <= now() + interval ''7 days'''),
  ('approval_live_upcoming', array['quotes.approval_token','quotes.approval_token_expires_at','quotes.event_date'],'select count(*) as n from public.quotes where approval_token is not null and approval_token_expires_at is null and event_date >= current_date'),
  ('worker_links', array['work_tokens.token'],          'select count(*) as n from public.work_tokens'),
  ('worker_null_exp', array['work_tokens.expires_at'],       'select count(*) as n from public.work_tokens where expires_at is null'),
  ('worker_revoked', array['work_tokens.revoked_at'],        'select count(*) as n from public.work_tokens where revoked_at is not null'),
  ('worker_backfill_now', array['work_tokens.expires_at','work_tokens.created_at','quotes.event_date'],   'select count(*) as n from public.work_tokens w left join public.quotes q on q.id = w.quote_id where w.expires_at is null and greatest(w.created_at + interval ''60 days'', coalesce(q.event_date::timestamptz + interval ''14 days'', ''-infinity'')) <= now()'),
  ('otp_rows_24h', array['quote_otps.created_at'],          'select count(*) as n from public.quote_otps where created_at > now() - interval ''24 hours'''),
  ('otp_phones_over_3_1h', array['quote_otps.created_at','quote_otps.phone'],  'select count(*) as n from (select regexp_replace(coalesce(phone,''''),''[^0-9]'','''',''g'') d from public.quote_otps where created_at > now() - interval ''1 hour'' group by 1 having count(*) >= 3) z'),
  ('otp_quotes_over_10_24h', array['quote_otps.created_at','quote_otps.quote_id'],'select count(*) as n from (select quote_id from public.quote_otps where created_at > now() - interval ''1 day'' group by 1 having count(*) >= 10) z'),
  ('orgs', array['organizations.id'],                  'select count(*) as n from public.organizations'),
  ('quotes', array['quotes.id'],                'select count(*) as n from public.quotes'),
  ('orgs_without_role_access', array['role_access.org_id'], 'select count(*) as n from public.organizations o where not exists (select 1 from public.role_access ra where ra.org_id = o.id)'),
  ('orgs_channels_differ', array['app_config.org_id','app_config.key','app_config.value','app_config.updated_at'],  'select count(*) as n from public.organizations o left join public.app_config c on c.org_id = o.id and c.key = ''channels'' where c.value is distinct from (select value from public.app_config where key = ''channels'' order by updated_at desc limit 1)'),
  ('proposal_cross_org', array['event_proposal.org_id','event_proposal.quote_id'],    'select count(*) as n from public.event_proposal pr join public.quotes q on q.id = pr.quote_id where pr.org_id is distinct from q.org_id'),
  ('design_cross_org', array['design_stages.org_id','design_stages.quote_id'],      'select count(*) as n from public.design_stages d join public.quotes q on q.id = d.quote_id where d.org_id is distinct from q.org_id'),
  ('reservations_active', array['inventory_reservations.status'],   'select count(*) as n from public.inventory_reservations where status in (''reserved'',''allocated'')'),
  ('invitations_pending', array['invitations.status'],   'select count(*) as n from public.invitations where status = ''pending'''),
  ('sec_test_rows', array['organizations.name'],         'select count(*) as n from public.organizations where id::text like ''ee5ec0%'' or name like ''SEC0%-TEST%''')),
c as (select k, (xpath('/row/n/text()', query_to_xml(sql, false, true, '')))[1]::text::bigint as n from cnt
       where not exists (select 1 from unnest(needs) nd where nd not in (select col.c from col))),
v(k) as (select 1),
rows(n, area, item, status, detail) as (
  -- ================================================================ 0. environment
  select 1, '0 ENV', 'session', 'INFO', current_user || ' / ' || session_user || ' / db ' || current_database() || ' / ' || split_part(version(), ' on ', 1) from v
  union all select 2, '0 ENV', 'read-only guard active', case when current_setting('transaction_read_only') = 'on' then 'OK' else 'CHECK' end,
         'transaction_read_only=' || current_setting('transaction_read_only') || ' (on = database refuses writes for this run)' from v
  union all select 3, '0 ENV', 'transaction isolation (SEC-07 G3 assumes read committed)',
         case when current_setting('default_transaction_isolation') = 'read committed' then 'OK' else 'CHECK' end, current_setting('default_transaction_isolation') from v
  union all select 4, '0 ENV', 'size: studios / quotes', 'INFO', coalesce((select n from c where k = 'orgs')::text, '?') || ' / ' || coalesce((select n from c where k = 'quotes')::text, '?') from v
  union all select 5, '0 ENV', 'synthetic SEC test rows present (expect 0 on production)', case when coalesce((select n from c where k = 'sec_test_rows'), 0) = 0 then 'OK' else 'CHECK' end,
         coalesce((select n from c where k = 'sec_test_rows')::text, '?') from v
  union all select 6, '0 ENV', 'owners of public functions (can the SQL-editor role act for each?)', 'INFO',
         (select string_agg(pg_get_userbyid(r) || '=' || pg_has_role(current_user, r, 'MEMBER'), ', ') from owners) from v
  union all select 7, '0 ENV', 'default function ACLs (role@scope)', 'INFO',
         coalesce((select string_agg(pg_get_userbyid(defaclrole) || '@' || coalesce(nullif(defaclnamespace, 0)::regnamespace::text, '<global>') || ' ' || defaclacl::text, ' | ' order by 1)
                     from pg_default_acl where defaclobjtype = 'f'), '<none>') from v
  union all select 8, '0 ENV', 'triggers on core tables calling code outside public (webhooks/pg_net)', 'INFO',
         coalesce((select string_agg(t.tgrelid::regclass || '.' || t.tgname || '->' || p.pronamespace::regnamespace || '.' || p.proname, ', ')
                     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where not t.tgisinternal and p.pronamespace <> 'public'::regnamespace
                      and t.tgrelid in (select cc.oid from pg_class cc join pg_namespace nn on nn.oid = cc.relnamespace
                                         where nn.nspname = 'public' and cc.relname in ('quotes','quote_otps','work_tokens','event_tasks','organizations','profiles','invitations','inventory_reservations'))), 'none') from v

  -- ================================================================ 1. prerequisites
  union all select 10, '1 PREREQ', 'quotes.approval_token_expires_at (wave10)', case when exists (select 1 from col where c = 'quotes.approval_token_expires_at') then 'PRESENT' else 'MISSING' end, 'SEC-05 + SEC-07' from v
  union all select 11, '1 PREREQ', 'quotes.approval_token_revoked_at', case when exists (select 1 from col where c = 'quotes.approval_token_revoked_at') then 'PRESENT' else 'MISSING' end, 'SEC-07' from v
  union all select 12, '1 PREREQ', 'event_proposal.share_token_expires_at (PROD-01)', case when exists (select 1 from col where c = 'event_proposal.share_token_expires_at') then 'PRESENT' else 'MISSING' end, 'SEC-05' from v
  union all select 13, '1 PREREQ', 'design_stages.revision (completion bundle)', case when exists (select 1 from col where c = 'design_stages.revision') then 'PRESENT' else 'MISSING' end, 'SEC-05' from v
  union all select 14, '1 PREREQ', 'event_tasks.verify_status (phase35)', case when exists (select 1 from col where c = 'event_tasks.verify_status') then 'PRESENT' else 'MISSING' end, 'SEC-05' from v
  union all select 15, '1 PREREQ', 'event_tasks.assignee_phone', case when exists (select 1 from col where c = 'event_tasks.assignee_phone') then 'PRESENT' else 'MISSING' end, 'SEC-07' from v
  union all select 16, '1 PREREQ', 'work_tokens.expires_at / revoked_at (PROD-01)', case when exists (select 1 from col where c = 'work_tokens.expires_at') and exists (select 1 from col where c = 'work_tokens.revoked_at') then 'PRESENT' else 'MISSING' end,
         'default now: ' || coalesce((select column_default from col where c = 'work_tokens.expires_at'), '<none>') from v
  union all select 17, '1 PREREQ', 'inventory_reservations.org_id / inventory_items.total_qty', case when exists (select 1 from col where c = 'inventory_reservations.org_id') and exists (select 1 from col where c = 'inventory_items.total_qty') then 'PRESENT' else 'MISSING' end, 'SEC-06' from v
  union all select 18, '1 PREREQ', 'invitations.token', case when exists (select 1 from col where c = 'invitations.token') then 'PRESENT' else 'MISSING' end, 'SEC-06' from v
  union all select 19, '1 PREREQ', 'functions has_area / current_org_id / assert_quote_org / helm_quote_total(jsonb) / can_edit / is_admin',
         case when (select bool_and(oid is not null) from f where name in ('has_area(text,text)','current_org_id()','assert_quote_org(uuid)','helm_quote_total(jsonb)','can_edit()','is_admin()')) then 'PRESENT' else 'MISSING' end,
         coalesce((select string_agg(name, ', ') from f where oid is null and name in ('has_area(text,text)','current_org_id()','assert_quote_org(uuid)','helm_quote_total(jsonb)','can_edit()','is_admin()')), 'all present') from v
  union all select 20, '1 PREREQ', 'extensions.gen_random_bytes (pgcrypto)', case when to_regprocedure('extensions.gen_random_bytes(integer)') is not null then 'PRESENT' else 'MISSING' end, 'SEC-05' from v
  union all select 21, '1 PREREQ', 'hashtextextended() (PostgreSQL 11+)', case when to_regprocedure('hashtextextended(text,bigint)') is not null then 'PRESENT' else 'MISSING' end, 'SEC-07 G3' from v
  union all select 22, '1 PREREQ', 'studios without an access matrix (role_access)', case when coalesce((select n from c where k = 'orgs_without_role_access'), -1) = 0 then 'OK' else 'CHECK' end,
         coalesce((select n from c where k = 'orgs_without_role_access')::text, 'role_access table missing') || ' (SEC-05 F10: their non-admin staff become read-only via RPC)' from v

  -- ================================================================ 2. SEC-05
  union all select 30, '2 SEC-05', 'marker: generate_approval_token has SEC-05 F10', case when (select body from b where name = 'generate_approval_token(uuid)') like '%SEC-05 F10%' then 'APPLIED' else 'NOT APPLIED' end, '' from v
  union all select 31, '2 SEC-05', 'F1 _flag(text) org-scoped',
         case when (select body from b where name = '_flag(text)') like '%current_org_id%' and (select body from b where name = '_flag(text)') not like '%order by updated_at%' then 'APPLIED'
              when (select body from b where name = '_flag(text)') = '' then 'ABSENT' else 'NOT APPLIED (global flag body)' end, '' from v
  union all select 32, '2 SEC-05', 'F1 request_otp / create_payment / _notify use the quote''s org flags',
         case when (select body from b where name = 'request_otp(uuid,text)') like '%_flag(''otp_dev_echo'', q.org_id)%'
               and (select body from b where name = 'create_payment(uuid)') like '%_flag(''pay_live'', q.org_id)%'
               and (select body from b where name = '_notify(uuid,text,text,text,jsonb)') like '%v_org%' then 'APPLIED' else 'NOT APPLIED' end, '' from v
  union all select 33, '2 SEC-05', 'F1 impact: studios whose own channels row differs from today''s effective flags', 'INFO',
         coalesce((select n from c where k = 'orgs_channels_differ')::text, 'n/a (app_config.org_id absent)') || ' (these studios'' OTP/payment mode changes after F1)' from v
  union all select 34, '2 SEC-05', 'F2 proposal/portal tenant match',
         case when (select body from b where name = 'public_get_proposal(uuid)') like '%org_id = pr.org_id%' and (select body from b where name = 'public_get_portal(uuid)') like '%org_id = q.org_id%' then 'APPLIED' else 'NOT APPLIED' end,
         'cross-org proposal rows: ' || coalesce((select n from c where k = 'proposal_cross_org')::text, 'n/a') from v
  union all select 35, '2 SEC-05', 'F3 design_advance asserts quote org',
         case when (select body from b where name = 'design_advance(uuid,text,text,timestamptz)') like '%assert_quote_org%' then 'APPLIED'
              when (select body from b where name = 'design_advance(uuid,text,text,timestamptz)') = '' then 'ABSENT (function missing)' else 'NOT APPLIED' end,
         'cross-org design rows: ' || coalesce((select n from c where k = 'design_cross_org')::text, 'n/a') from v
  union all select 36, '2 SEC-05', 'F4 helm_total_paid / _flag not callable by clients',
         case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('helm_total_paid','_flag')
                                 and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) then 'APPLIED' else 'NOT APPLIED' end, '' from v
  union all select 37, '2 SEC-05', 'F5 staff-only RPCs: anon denied',
         case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
                                 and p.proname in ('admin_set_role','admin_create_user','admin_delete_user','create_quote','confirm_quote','generate_approval_token','mark_paid','record_payment','save_quotation_version','set_pricing_config','create_studio','accept_invitation')
                                 and (has_function_privilege('anon', p.oid, 'EXECUTE') or not has_function_privilege('authenticated', p.oid, 'EXECUTE'))) then 'APPLIED' else 'NOT APPLIED' end,
         'anon-executable SECURITY DEFINER functions now: ' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')) from v
  union all select 38, '2 SEC-05', 'F6 invite-media: no public listing policy',
         case when not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'invite_media_public_read')
               and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'invite_media_org_read') then 'APPLIED' else 'NOT APPLIED' end,
         coalesce((select string_agg(policyname, ', ') from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'invite_media%'), 'no invite_media policies') from v
  union all select 39, '2 SEC-05', 'F6 invite-media bucket limits (set in dashboard, not SQL)',
         case when not exists (select 1 from storage.buckets where id = 'invite-media') then 'BUCKET MISSING'
              when (select public and allowed_mime_types is not null and file_size_limit is not null and not ('image/svg+xml' = any(allowed_mime_types)) and not ('text/html' = any(allowed_mime_types))
                       and allowed_mime_types <@ array['image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif'] from storage.buckets where id = 'invite-media') then 'OK'
              else 'NOT SET' end,
         coalesce((select 'public=' || public || ' mime=' || coalesce(allowed_mime_types::text, 'null') || ' size=' || coalesce(file_size_limit::text, 'null') from storage.buckets where id = 'invite-media'), 'no bucket') from v
  union all select 40, '2 SEC-05', 'F7 invitation writes admin-only',
         case when (select bool_and(coalesce(qual, '') || coalesce(with_check, '') like '%is_admin%') from pg_policies where schemaname = 'public' and tablename = 'invitations' and cmd in ('INSERT','UPDATE','DELETE')) then 'APPLIED' else 'NOT APPLIED' end,
         coalesce((select string_agg(policyname || ':' || cmd, ', ') from pg_policies where schemaname = 'public' and tablename = 'invitations'), 'no policies') from v
  union all select 41, '2 SEC-05', 'F8 organizations write gated on admin/controls',
         case when (select bool_and(coalesce(qual, '') || coalesce(with_check, '') like '%has_area%') from pg_policies where schemaname = 'public' and tablename = 'organizations' and cmd = 'UPDATE') then 'APPLIED' else 'NOT APPLIED' end,
         coalesce((select string_agg(policyname || ':' || cmd, ', ') from pg_policies where schemaname = 'public' and tablename = 'organizations'), 'no policies') from v
  union all select 42, '2 SEC-05', 'F9 inventory_availability security_invoker',
         case when (select coalesce('security_invoker=true' = any(cl.reloptions), false) from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and cl.relname = 'inventory_availability') then 'APPLIED'
              when to_regclass('public.inventory_availability') is null then 'ABSENT (view missing)' else 'NOT APPLIED' end, '' from v
  union all select 43, '2 SEC-05', 'F10 quote-editing RPCs check the matrix area',
         case when (select count(*) from f where name in ('generate_approval_token(uuid)','save_quotation_version(uuid,jsonb)','record_payment(uuid,numeric,text,text,uuid,text,text)',
                                                          'set_discovery(uuid,date,text,text,text,text,numeric,numeric)','set_event_plan(uuid,text,text,text,text,text,text)','set_proposal(uuid,text,text,jsonb,jsonb,jsonb)')
                                                and body like '%SEC-05 F10%') = 6 then 'APPLIED'
              when (select count(*) from f where body like '%SEC-05 F10%') = 0 then 'NOT APPLIED' else 'PARTIAL' end,
         'with marker: ' || (select count(*) from f where body like '%SEC-05 F10%') || '/6; missing functions: '
         || coalesce((select string_agg(name, ', ') from f where oid is null and name in ('save_quotation_version(uuid,jsonb)','record_payment(uuid,numeric,text,text,uuid,text,text)',
                        'set_discovery(uuid,date,text,text,text,text,numeric,numeric)','set_event_plan(uuid,text,text,text,text,text,text)','set_proposal(uuid,text,text,jsonb,jsonb,jsonb)')), 'none') from v
  union all select 44, '2 SEC-05', 'F11 mark_paid admin/manager only', case when (select body from b where name = 'mark_paid(uuid,text)') like '%SEC-05 F11%' then 'APPLIED' else 'NOT APPLIED' end, '' from v
  union all select 45, '2 SEC-05', 'F12 event_tasks QC guard trigger',
         case when exists (select 1 from pg_trigger where tgname = 'zz_task_verify_guard' and tgrelid = to_regclass('public.event_tasks') and not tgisinternal) then 'APPLIED' else 'NOT APPLIED' end, '' from v
  union all select 46, '2 SEC-05', 'diagnostic: always-TRUE RLS policies on public tables (expect 0)', case when (select count(*) from pg_policies where schemaname = 'public' and (btrim(qual) = 'true' or btrim(with_check) = 'true')) = 0 then 'OK' else 'CHECK' end,
         coalesce((select string_agg(tablename || '.' || policyname, ', ') from pg_policies where schemaname = 'public' and (btrim(qual) = 'true' or btrim(with_check) = 'true')), 'none') from v

  -- ================================================================ 3. SEC-06
  union all select 50, '3 SEC-06', 'return_reservation(uuid,numeric) (atomic teardown return)',
         case when (select body from b where name = 'return_reservation(uuid,numeric)') like '%for update%' then 'APPLIED'
              when (select oid from f where name = 'return_reservation(uuid,numeric)') is null then 'NOT APPLIED' else 'DIFFERENT BODY' end,
         'active reservations: ' || coalesce((select n from c where k = 'reservations_active')::text, 'n/a') from v
  union all select 51, '3 SEC-06', 'invitation_preview(text) (anon invite banner)',
         case when (select oid from f where name = 'invitation_preview(text)') is null then 'NOT APPLIED'
              when has_function_privilege('anon', (select oid from f where name = 'invitation_preview(text)'), 'EXECUTE')
               and (select body from b where name = 'invitation_preview(text)') not like '%''email''%' then 'APPLIED' else 'DIFFERENT BODY' end,
         'pending invitations: ' || coalesce((select n from c where k = 'invitations_pending')::text, 'n/a') from v
  union all select 52, '3 SEC-06', 'invitation_by_token callable by anon? (info)',
         case when (select oid from f where name = 'invitation_by_token(text)') is null then 'ABSENT'
              when not has_function_privilege('anon', (select oid from f where name = 'invitation_by_token(text)'), 'EXECUTE') then 'OK' else 'INFO' end,
         case when has_function_privilege('anon', (select oid from f where name = 'invitation_by_token(text)'), 'EXECUTE')
              then 'anon can call it via the default PUBLIC grant (phase83 revoked only anon); it returns only org name/role/validity — pre-existing, not changed by SEC-06' else '' end from v

  -- ================================================================ 4. SEC-07
  union all select 60, '4 SEC-07', 'version installed',
         case when (select body from b where name = 'generate_approval_token(uuid)') like '%SEC-07 G1%' then 'v2'
              when (select oid from f where name = 'tg_otp_rate_limit()') is not null then 'v1 (upgrade path)' else 'NONE (fresh install path)' end,
         'expected on production: NONE' from v
  union all select 61, '4 SEC-07', 'G1 approval-link expiry trigger', case when exists (select 1 from pg_trigger where tgname = 'zz_approval_token_expiry' and tgrelid = 'public.quotes'::regclass) then 'PRESENT' else 'ABSENT' end, '' from v
  union all select 62, '4 SEC-07', 'G1 links: total / without expiry / already expired', 'INFO',
         coalesce((select n from c where k = 'approval_links')::text, '?') || ' / ' || coalesce((select n from c where k = 'approval_null_exp')::text, '?') || ' / ' || coalesce((select n from c where k = 'approval_expired')::text, '?') from v
  union all select 63, '4 SEC-07', 'G1 backfill impact: links that would expire IMMEDIATELY at apply', 'REVIEW', coalesce((select n from c where k = 'approval_backfill_now')::text, '?')
         || ' (within 7 days: ' || coalesce((select n from c where k = 'approval_backfill_7d')::text, '?') || '; links for upcoming events keep working: ' || coalesce((select n from c where k = 'approval_live_upcoming')::text, '?') || ')' from v
  union all select 64, '4 SEC-07', 'G2 worker-link triggers',
         case when exists (select 1 from pg_trigger where tgname = 'zz_work_token_expiry') and exists (select 1 from pg_trigger where tgname = 'zz_work_token_renew') then 'PRESENT' else 'ABSENT' end, '' from v
  union all select 65, '4 SEC-07', 'G2 worker links: total / without expiry / revoked', 'INFO',
         coalesce((select n from c where k = 'worker_links')::text, '?') || ' / ' || coalesce((select n from c where k = 'worker_null_exp')::text, '?') || ' / ' || coalesce((select n from c where k = 'worker_revoked')::text, '?') from v
  union all select 66, '4 SEC-07', 'G2 backfill impact: worker links that would expire IMMEDIATELY at apply', 'REVIEW', coalesce((select n from c where k = 'worker_backfill_now')::text, '?') from v
  union all select 67, '4 SEC-07', 'G3 OTP rate-limit trigger',
         case when (select body from b where name = 'tg_otp_rate_limit()') like '%helm:otp:phone:%' then 'PRESENT (v2 serialized)'
              when (select oid from f where name = 'tg_otp_rate_limit()') is not null then 'PRESENT (v1, NOT serialized)' else 'ABSENT' end, '' from v
  union all select 68, '4 SEC-07', 'G3 impact now: codes in 24 h / numbers at >=3 in last hour / quotes at >=10 today', 'INFO',
         coalesce((select n from c where k = 'otp_rows_24h')::text, '?') || ' / ' || coalesce((select n from c where k = 'otp_phones_over_3_1h')::text, '?') || ' / ' || coalesce((select n from c where k = 'otp_quotes_over_10_24h')::text, '?') from v
  union all select 69, '4 SEC-07', 'G4 guarded tables (quote_id + org_id)', case when (select count(*) from cand_n where not guarded) = 0 then 'PRESENT' when (select count(*) from cand_n where guarded) = 0 then 'ABSENT' else 'PARTIAL' end,
         'candidates=' || (select count(*) from cand_n) || ' guarded=' || (select count(*) from cand_n where guarded) || ' with FK to quotes=' || (select count(*) from cand_n where fk)
         || '; without FK: ' || coalesce((select string_agg(t, ', ' order by t) from cand_n where not fk), 'none') from v
  union all select 70, '4 SEC-07', 'G4 EXISTING cross-studio rows (must be 0 or reviewed; the guard does not touch existing rows)',
         case when (select coalesce(sum(cross_org), 0) from cand_n) = 0 then 'OK' else 'REVIEW' end,
         (select coalesce(sum(cross_org), 0) from cand_n) || coalesce(' in ' || (select string_agg(t || '=' || cross_org, ', ' order by t) from cand_n where cross_org > 0), '') from v
  union all select 71, '4 SEC-07', 'G4 existing rows pointing at deleted quotes (info; audit_log/lead_archive expected)', 'INFO',
         (select coalesce(sum(dangling), 0) from cand_n) || coalesce(' in ' || (select string_agg(t || '=' || dangling, ', ' order by t) from cand_n where dangling > 0), '') from v
  union all select 72, '4 SEC-07', 'G5 new public functions: PUBLIC / anon / authenticated execute by default',
         case when (select bool_and(not exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE'))
                        and bool_and(exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE')) from eff) then 'APPLIED' else 'NOT APPLIED' end,
         'PUBLIC ' || case when (select bool_or(exists (select 1 from aclexplode(acl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) from eff) then 'CAN' else 'cannot' end
         || ' / anon ' || case when (select bool_or(exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE')) from eff) then 'CAN' else 'cannot' end
         || ' / authenticated ' || case when (select bool_and(exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE')) from eff) then 'can' else 'CANNOT' end from v

  -- ================================================================ 5. fingerprints of every function SEC-05/06/07 read or replace
  union all select 100 + row_number() over (order by name), '5 FUNC', name,
         case when oid is null then 'ABSENT' else 'PRESENT' end,
         case when oid is null then '' else 'md5=' || md5(body) || ' secdef=' || (select prosecdef from pg_proc where oid = f.oid)
              || ' anon=' || has_function_privilege('anon', oid, 'EXECUTE') || ' auth=' || has_function_privilege('authenticated', oid, 'EXECUTE')
              || ' owner=' || pg_get_userbyid((select proowner from pg_proc where oid = f.oid)) end
    from f
)
select n, area, item, status, detail from rows order by n;
