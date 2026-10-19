-- R21-RESERVED-DOMAIN-REPORT.sql - READ-ONLY. Paste into the Supabase SQL editor (staging first, then production).
-- Run AFTER APPLY-0248. Lists every EXISTING login on Helm's own domains (helm.events, helm.com, their
-- sub-domains and any look-alike domain HQ has added), so the owner can decide what to do with each one.
-- Changes NOTHING (one select). ASCII only. The same list is in HQ -> Staff access -> "Existing logins".
--
-- Columns:
--   email, created_at, last_sign_in_at, confirmed  - the login
--   banned_until                                   - set = sign-in already disabled
--   studio, studio_role                            - the studio this login belongs to (empty = none)
--   is_platform_admin                              - an HQ operator (never disable these)
--   allowlisted                                    - on the 0248 staff allowlist (or an HQ operator)
--   suggestion                                     - KEEP (staff) / REVIEW (studio member: check with that studio
--                                                    first - e.g. the old demo logins) / DISABLE? (no studio, not
--                                                    staff - e.g. anil@helm.events)
do $$ begin
  if to_regprocedure('public.email_is_reserved(text)') is null then raise exception 'STOP: run APPLY-0248.sql first'; end if;
end $$;

select lower(au.email) as email, public.reserved_email_domain(au.email) as domain,
       au.created_at, au.last_sign_in_at, au.email_confirmed_at is not null as confirmed,
       to_jsonb(au) ->> 'banned_until' as banned_until,
       o.name as studio, p.role as studio_role,
       exists (select 1 from public.platform_admins pa where lower(pa.email) = lower(au.email)) as is_platform_admin,
       not public.email_is_reserved(au.email) as allowlisted,
       case when not public.email_is_reserved(au.email) then 'KEEP (Helm staff)'
            when p.org_id is not null then 'REVIEW (studio member - check with the studio first)'
            else 'DISABLE? (no studio, not staff)' end as suggestion
  from auth.users au
  left join public.profiles p on p.id = au.id
  left join public.organizations o on o.id = p.org_id
 where au.email is not null and public.reserved_email_domain(au.email) is not null
 order by au.created_at;
