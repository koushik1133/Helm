-- SEC-07 v2 — BLOCK 2: VERIFY (read-only). Verbatim from SEC-07-backend-hardening.sql (lines 265-321). Every row must read PASS.
with cand as (
  select c.table_name::text t from information_schema.columns c
    join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
    join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name and x.table_type='BASE TABLE'
   where c.table_schema='public' and c.column_name='quote_id' and c.table_name <> 'quotes'),
guarded as (
  select g.tgrelid::regclass::text t, encode(g.tgargs, 'escape') as args from pg_trigger g
   where g.tgname = 'zz_quote_org_match' and not g.tgisinternal),
fk as (
  select k.conrelid::regclass::text t from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
   where k.contype = 'f' and k.confrelid = 'public.quotes'::regclass and a.attname = 'quote_id'),
owners as (
  select distinct p.proowner r from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
eff as (   -- effective default ACL for a new public function: global entry (or the built-in default) + per-schema entry
  select o.r,
         coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 0 and defaclobjtype = 'f'),
                  acldefault('f', o.r))
      || coalesce((select defaclacl from pg_default_acl where defaclrole = o.r and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'),
                  '{}'::aclitem[]) as acl
    from owners o)
select 'G1 approval links all expire' as check,
       case when not exists (select 1 from public.quotes where approval_token is not null and approval_token_expires_at is null) then 'PASS' else 'FAIL' end as result
union all select 'G1 expiry trigger + renewing generate_approval_token',
       case when exists (select 1 from pg_trigger where tgname='zz_approval_token_expiry' and tgrelid='public.quotes'::regclass)
             and pg_get_functiondef('public.generate_approval_token(uuid)'::regprocedure) like '%SEC-07 G1%' then 'PASS' else 'FAIL' end
union all select 'G2 worker links all expire',
       case when not exists (select 1 from public.work_tokens where expires_at is null) then 'PASS' else 'FAIL' end
union all select 'G2 issue + renew triggers',
       case when exists (select 1 from pg_trigger where tgname='zz_work_token_expiry' and tgrelid='public.work_tokens'::regclass)
             and exists (select 1 from pg_trigger where tgname='zz_work_token_renew' and tgrelid='public.event_tasks'::regclass) then 'PASS' else 'FAIL' end
union all select 'G3 OTP limit trigger serialized (advisory locks)',
       case when exists (select 1 from pg_trigger where tgname='zz_otp_rate_limit' and tgrelid='public.quote_otps'::regclass)
             and pg_get_functiondef('public.tg_otp_rate_limit()'::regprocedure) like '%pg_advisory_xact_lock%' then 'PASS' else 'FAIL' end
union all select 'G4 candidates=' || (select count(*) from cand) || ' guarded=' || (select count(*) from guarded)
               || ' missing=' || (select count(*) from cand where t not in (select replace(t,'public.','') from guarded))
               || ' unexpected=' || (select count(*) from guarded where replace(t,'public.','') not in (select t from cand)),
       case when (select count(*) from cand where t not in (select replace(t,'public.','') from guarded)) = 0
             and (select count(*) from guarded where replace(t,'public.','') not in (select t from cand)) = 0 then 'PASS' else 'FAIL' end
union all select 'G4 every candidate has an FK or rejects unknown quotes (dangling only: audit_log, lead_archive)',
       case when not exists (select 1 from cand c
                              where c.t not in (select replace(t,'public.','') from fk)
                                and c.t not in ('audit_log','lead_archive'))
             and not exists (select 1 from guarded where args like 'allow_dangling%'
                                and replace(t,'public.','') not in ('audit_log','lead_archive')) then 'PASS' else 'FAIL' end
union all select 'G5 new public functions: PUBLIC ' ||
       case when (select bool_or(exists (select 1 from aclexplode(acl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) from eff) then 'CAN' else 'cannot' end
       || ' / anon ' ||
       case when (select bool_or(exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE')) from eff) then 'CAN' else 'cannot' end
       || ' / authenticated ' ||
       case when (select bool_and(exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE')) from eff) then 'can' else 'CANNOT' end
       || ' execute',
       case when (select bool_and(not exists (select 1 from aclexplode(acl) a where a.grantee in (0, 'anon'::regrole) and a.privilege_type = 'EXECUTE'))
                    and bool_and(exists (select 1 from aclexplode(acl) a where a.grantee = 'authenticated'::regrole and a.privilege_type = 'EXECUTE')) from eff)
            then 'PASS' else 'FAIL' end;
