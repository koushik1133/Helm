-- SEC-07 v2 — BLOCK 0: PRECHECK (read-only: SELECT only). STAGING (xizehqgeyjcfpzrdymly).
-- One result table. Nothing is changed.
with owners as (select distinct p.proowner r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
cand as (select c.table_name::text t from information_schema.columns c
    join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
    join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name and x.table_type='BASE TABLE'
   where c.table_schema='public' and c.column_name='quote_id' and c.table_name <> 'quotes'),
xorg as (select t, (xpath('/row/n/text()', query_to_xml(format(
    'select count(*) as n from public.%I x join public.quotes q on q.id = x.quote_id where x.org_id is distinct from q.org_id', t),
    false, true, '')))[1]::text::int as n from cand)
select * from (values
 (1, 'running as', current_user || ' / ' || session_user),
 (2, 'SEC-05 applied (generate_approval_token has F10)', (pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) like '%SEC-05 F10%')::text),
 (3, 'SEC-07 version now', case when pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) like '%SEC-07 G1%' then 'v2' when to_regprocedure('public.tg_otp_rate_limit()') is not null then 'v1' else 'none' end),
 (4, 'work_tokens.expires_at default (v1 sets one; v2 drops it)', coalesce((select column_default from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at'), '<none>')),
 (5, 'approval links / without expiry / already expired', (select count(*) from public.quotes where approval_token is not null) || ' / ' ||
      (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at is null) || ' / ' ||
      (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at <= now())),
 (6, 'approval links the v2 backfill would expire at once', (select count(*) from public.quotes where approval_token is not null and approval_token_expires_at is null
      and greatest(updated_at + interval '30 days', coalesce(event_date::timestamptz + interval '30 days', '-infinity')) <= now())::text),
 (7, 'worker links / without expiry / already expired', (select count(*) from public.work_tokens) || ' / ' ||
      (select count(*) from public.work_tokens where expires_at is null) || ' / ' ||
      (select count(*) from public.work_tokens where expires_at <= now())),
 (8, 'worker links the v2 backfill would expire at once', (select count(*) from public.work_tokens w left join public.quotes q on q.id = w.quote_id where w.expires_at is null
      and greatest(w.created_at + interval '60 days', coalesce(q.event_date::timestamptz + interval '14 days', '-infinity')) <= now())::text),
 (9, 'G4 candidate tables', (select count(*) from cand)::text),
 (10, 'G4 existing cross-studio rows (tables with >0)', coalesce((select string_agg(t || '=' || n, ', ' order by t) from xorg where n > 0), 'none')),
 (11, 'public function owners (can this role act for each?)', (select string_agg(pg_get_userbyid(r) || '=' || pg_has_role(current_user, r, 'MEMBER'), ', ') from owners)),
 (12, 'default function ACLs', coalesce((select string_agg(pg_get_userbyid(defaclrole) || '@' || coalesce(nullif(defaclnamespace, 0)::regnamespace::text, '<global>') || ' ' || defaclacl::text, ' | ' order by 1)
      from pg_default_acl where defaclobjtype = 'f'), '<none>')),
 (13, 'default_transaction_isolation', current_setting('default_transaction_isolation'))
) as t(n, check_name, value) order by n;
