-- R21-SECURITY-PREFLIGHT.sql - READ-ONLY. Paste into the Supabase SQL editor (staging or production) before turning
-- on two-step for HQ (helm_hq_settings.hq_require_mfa) or for studio admins (public/config.js mfaRequiredForAdmins).
-- Changes nothing (select only). Needs APPLY-0249 for the first block; the rest works on any version.
--
-- 1) HQ operators: who still needs to set up two-step. "blocking" = has a login and no authenticator: the switch
--    update refuses while any row says blocking = true. "pending" = never signed in (the sign-in page makes them
--    set it up first; not blocking).
select o.email, o.has_login, o.has_2step, o.last_sign_in_at,
       (o.has_login and not o.has_2step) as blocking, (not o.has_login) as pending
  from public._a249_operator_rows() o order by blocking desc, o.email;

-- 2) The two database switches today.
select hq_require_mfa, rpc_captcha_required, updated_at from public.helm_hq_settings where id;

-- 3) Studio admins without two-step (for mfaRequiredForAdmins: true - they will be asked to set it up at next
--    sign-in; nobody is locked out, but tell them first). Count only - no e-mail list.
select count(*) as studio_admins,
       count(*) filter (where exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status::text = 'verified')) as with_2step
  from public.profiles p where p.role = 'admin' and p.org_id is not null;

-- 4) Default-password accounts (top-10 action #1): must return 0 rows - see supabase/audit/P3-CHECK-default-passwords.sql.
