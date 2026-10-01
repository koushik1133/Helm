-- grants-matrix.sql — least-privilege (F4/F5/G5) catalog assertions.
-- Requires 0005 applied. Prints PASS/FAIL per role×function expectation.
set client_min_messages = warning;
with checks(role, fn, want) as (values
  -- anon must NOT reach sensitive RPCs
  ('anon','public.admin_create_user(text,text,text)', false),
  ('anon','public.save_quotation_version(uuid,jsonb)', false),
  ('anon','public.mark_paid(uuid,text)', false),
  ('anon','public.create_helm_user(text,text,text)', false),
  ('anon','public.helm_total_paid(uuid,uuid,uuid)', false),
  ('anon','public._flag(text)', false),
  -- anon MUST keep the intentional public token RPCs
  ('anon','public.public_get_portal(uuid)', true),
  ('anon','public.request_otp(uuid,text)', true),
  ('anon','public.worker_get_tasks(uuid)', true),
  -- authenticated: app RPCs yes; info-leak helpers no
  ('authenticated','public.save_quotation_version(uuid,jsonb)', true),
  ('authenticated','public.admin_create_user(text,text,text)', true),
  ('authenticated','public.helm_total_paid(uuid,uuid,uuid)', false),
  ('authenticated','public._flag(text)', false),
  -- PUBLIC pseudo-role: no execute on sensitive
  ('public','public.admin_create_user(text,text,text)', false),
  ('public','public.create_helm_user(text,text,text)', false)
)
select role, fn, want as expected,
       has_function_privilege(role, fn, 'EXECUTE') as actual,
       case when has_function_privilege(role, fn, 'EXECUTE') = want then 'PASS' else 'FAIL' end as result
from checks order by role, fn;

select case when count(*) filter (where has_function_privilege(role, fn,'EXECUTE') <> want)=0
            then 'GRANTS-MATRIX: ALL PASS'
            else 'GRANTS-MATRIX: '||count(*) filter (where has_function_privilege(role, fn,'EXECUTE') <> want)||' FAILED' end
from (values
  ('anon','public.admin_create_user(text,text,text)', false),
  ('anon','public.save_quotation_version(uuid,jsonb)', false),
  ('anon','public.mark_paid(uuid,text)', false),
  ('anon','public.create_helm_user(text,text,text)', false),
  ('anon','public.helm_total_paid(uuid,uuid,uuid)', false),
  ('anon','public._flag(text)', false),
  ('anon','public.public_get_portal(uuid)', true),
  ('anon','public.request_otp(uuid,text)', true),
  ('anon','public.worker_get_tasks(uuid)', true),
  ('authenticated','public.save_quotation_version(uuid,jsonb)', true),
  ('authenticated','public.admin_create_user(text,text,text)', true),
  ('authenticated','public.helm_total_paid(uuid,uuid,uuid)', false),
  ('authenticated','public._flag(text)', false),
  ('public','public.admin_create_user(text,text,text)', false),
  ('public','public.create_helm_user(text,text,text)', false)
) as c(role, fn, want);

-- G5 default-privileges catalog assertion
select 'default-privileges entries revoking from public/anon: '||count(*)
from pg_default_acl d where d.defaclobjtype='f';
