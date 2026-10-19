-- APPLY-0253.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0249 (already on production). Order-independent of 0250-0252.
-- r22 two-step (MFA): the LOST PHONE path + one stricter HQ rule.
--   * hq_mfa_reset(email, reason): Helm HQ -> People -> "Reset" next to a person whose 2-step is on. Only an HQ
--     operator signed in WITH two-step, never their own account, reason required, max 10 a day, audited, kept in
--     the append-only public.mfa_resets log. The person's authenticator is marked unverified (never deleted).
--   * my_mfa_reset_info(): the person's Account panel says when Helm support reset it.
--   * is_platform_admin(): while hq_require_mfa is ON every HQ call (reads too) needs the code (aal2).
--     Switch OFF (today): nothing changes.
-- One new table, two new functions, triggers, one function made stricter. Nothing deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production) - full test in docs/security/MFA-OWNER-TEST-R22.md:
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true (two result grids: the
--      migration's own check inside the transaction, then the same check after commit).
--   2  Deploy the site (store-api.js, auth-ui.js, hq.js, login.html).
--   3  Check: HQ -> People -> a test account with 2-step "on" shows a Reset button (not on your own row).
begin;
-- 0253_mfa_assisted_reset.sql - CANONICAL forward-only.
-- REQUIRES 0029 (platform_admins, is_platform_admin), 0045 + 0047 (_hq_wgate), 0028 (auth.mfa_factors reads),
--          base audit_log.
--
-- In plain words (r22 owner: "make 2-step (MFA) working" - the LOST PHONE path):
--   Until now a person who lost the phone with their authenticator app had no way back in: the sign-in page said
--   "email security@helm.events", but Helm support had no tool to help. This adds a SAFE, Helm-HQ-assisted reset:
--
--   hq_mfa_reset(p_email, p_reason)  - Helm HQ -> People -> "Reset 2-step" on that person's row.
--     * only a Helm HQ operator (is_platform_admin) whose OWN session passed two-step (aal2) - always, whatever the
--       hq_require_mfa switch says. An operator without two-step cannot reset anyone.
--     * never your own account (no self-bypass): an operator who lost their own phone asks ANOTHER operator, or the
--       owner follows the SQL-editor runbook in docs/security/MFA-OWNER-TEST-R22.md.
--     * a reason of 10-500 characters is required (e.g. "phone lost - identity checked by call to +91..."), and at
--       most 10 resets per operator per 24 hours.
--     * what it does: the person's VERIFIED authenticator(s) are marked "unverified" (auth.mfa_factors.status). No
--       row is deleted: the next sign-in is password (or Google) only, Helm then offers set-up again, and the
--       person's own new set-up clears the stale entry (Supabase Auth's normal unenrol of an unfinished factor).
--     * every reset is written to audit_log (HQ Activity) AND to a new append-only log public.mfa_resets
--       (who, whom, when, why, how many factors). Rows in mfa_resets can never be changed or deleted.
--   my_mfa_reset_info()  - the signed-in person's own last reset time (no operator name), so the Account panel can
--     say "Your two-step was reset by Helm support on <date> - set it up again".
--
--   is_platform_admin() (0047) is replaced once: while hq_require_mfa is ON every HQ call - reads too - needs aal2
--     (before, an operator WITHOUT an authenticator could still READ HQ at aal1 through the API; only writes needed
--     aal2). With the switch OFF nothing changes.
--
-- ZERO DATA LOSS: one new table, two new functions, triggers, and the stricter is_platform_admin(). The only existing
-- data touched is the status column of the target person's verified TOTP factors (verified -> unverified), and only
-- through hq_mfa_reset by an authorised, audited operator. Nothing is deleted, no policy / table is changed. Additive,
-- idempotent, safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): revoke execute on function public.hq_mfa_reset(text, text) from authenticated;
--   and re-run the is_platform_admin() block of 0047_hq_mfa_optional.sql. (The log table and functions can stay.)

do $$ begin
  if to_regprocedure('public.is_platform_admin()') is null then raise exception 'STOP: 0029 (is_platform_admin) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then raise exception 'STOP: 0045 / 0047 (_hq_wgate) is not applied'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: base audit_log table missing'; end if;
  if to_regclass('auth.users') is null then raise exception 'STOP: auth.users missing'; end if;
end $$;

-- ---- 1) append-only reset log (private: definer functions + service role only) ----------------------------------
create table if not exists public.mfa_resets (
  id               bigint generated always as identity primary key,
  target_user_id   uuid        not null,
  target_email     text,
  operator_user_id uuid        not null,
  operator_email   text,
  reason           text        not null,
  factors_reset    integer     not null default 0,
  at               timestamptz not null default now()
);
create index if not exists mfa_resets_target_idx on public.mfa_resets (target_user_id, at desc);
create index if not exists mfa_resets_operator_idx on public.mfa_resets (operator_user_id, at desc);
alter table public.mfa_resets enable row level security;
revoke all on table public.mfa_resets from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.mfa_resets from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.mfa_resets from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.mfa_resets from service_role;
    grant select on table public.mfa_resets to service_role;
  end if;
end $$;

create or replace function public.tg_a253_mfa_resets_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'mfa_resets is append-only' using errcode = '42501'; end $$;
revoke all on function public.tg_a253_mfa_resets_append_only() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a253_mfa_resets_append_only() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a253_mfa_resets_append_only() from authenticated; end if;
end $$;
drop trigger if exists a253_mfa_resets_append_only on public.mfa_resets;
create trigger a253_mfa_resets_append_only before update or delete on public.mfa_resets
  for each row execute function public.tg_a253_mfa_resets_append_only();
drop trigger if exists a253_mfa_resets_no_truncate on public.mfa_resets;
create trigger a253_mfa_resets_no_truncate before truncate on public.mfa_resets
  for each statement execute function public.tg_a253_mfa_resets_append_only();

-- ---- 2) HQ-assisted reset ---------------------------------------------------------------------------------------
create or replace function public.hq_mfa_reset(p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-mfa-reset-0253
declare
  v_me     uuid := auth.uid();
  v_aal    text := coalesce(auth.jwt() ->> 'aal', '');
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_target uuid; v_temail text; v_memail text; v_n int := 0; v_recent int;
begin
  -- who may: an HQ operator whose own session passed two-step, always (independent of hq_require_mfa)
  if v_me is null or not public.is_platform_admin() or v_aal <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501',
      hint = 'Only a Helm HQ operator signed in with two-step verification can reset two-step for someone else.';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'Enter the person''s e-mail address.' using errcode = '22023'; end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Give a reason of 10 to 500 characters (for example how you confirmed who they are).' using errcode = '22023';
  end if;
  select u.id, u.email into v_target, v_temail from auth.users u where lower(u.email) = v_email order by u.created_at limit 1;
  if v_target is null then raise exception 'No Helm account uses that e-mail address.' using errcode = 'P0002'; end if;
  -- no self-bypass: never your own account (another operator, or the owner's SQL-editor runbook)
  if v_target = v_me then
    raise exception 'You can''t reset your own two-step. Ask another Helm HQ operator to do it.' using errcode = '42501';
  end if;
  select count(*) into v_recent from public.mfa_resets r where r.operator_user_id = v_me and r.at > now() - interval '24 hours';
  if v_recent >= 10 then raise exception 'Too many two-step resets in the last 24 hours. Try again tomorrow.' using errcode = 'P0001'; end if;
  if to_regclass('auth.mfa_factors') is null then raise exception 'Two-step verification is not available on this database.' using errcode = 'P0001'; end if;
  execute 'select count(*) from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'''
    into v_n using v_target;
  if coalesce(v_n, 0) = 0 then
    return jsonb_build_object('ok', true, 'factors_reset', 0, 'message', 'This account has no two-step set up - nothing to reset.');
  end if;
  -- audited HQ write (refuses again if the caller is not an operator)
  perform public._hq_wgate('hq.mfa.reset', 'auth_user', v_target::text,
    jsonb_build_object('email', v_temail, 'factors', v_n, 'reason', v_reason));
  -- mark (never delete) the verified authenticator(s) as unverified
  execute 'update auth.mfa_factors set status = ''unverified'', updated_at = now() where user_id = $1 and status::text = ''verified'''
    using v_target;
  get diagnostics v_n = row_count;
  select u.email into v_memail from auth.users u where u.id = v_me;
  insert into public.mfa_resets(target_user_id, target_email, operator_user_id, operator_email, reason, factors_reset)
    values (v_target, v_temail, v_me, v_memail, v_reason, v_n);
  return jsonb_build_object('ok', true, 'factors_reset', v_n,
    'message', 'Two-step reset. At their next sign-in they use their password (or Google) only and Helm asks them to set two-step up again.');
end $$;
revoke all on function public.hq_mfa_reset(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hq_mfa_reset(text, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.hq_mfa_reset(text, text) to authenticated; end if;
end $$;

-- ---- 2b) HQ access while hq_require_mfa is ON: aal2 for EVERY HQ call (reads too) ------------------------------
-- Before 0253 an operator WITHOUT an authenticator (never set up, or just reset above) could still READ HQ at aal1
-- through the API while the switch was on (only writes needed aal2; the sign-in page already forced set-up, so the
-- app never let them in). Now the database agrees with the sign-in page: switch on -> HQ needs aal2, full stop.
-- Switch off -> exactly the 0047 rule (an operator who set two-step up must enter the code; one who did not may
-- use HQ at aal1). Nobody is locked out: the sign-in page takes an operator without two-step through set-up first,
-- and 0249 refuses the switch while an operator with a login has no authenticator.
create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  -- r22-mfa-0253: switch on => aal2 for every HQ call
  v_uid uuid := auth.uid(); v_has_factor boolean := false;
  v_aal text := coalesce(auth.jwt() ->> 'aal', '');
begin
  if v_uid is null or not public.is_platform_operator() then return false; end if;
  if v_aal = 'aal2' then return true; end if;
  if public._hq_require_mfa() then return false; end if;    -- switch on: the code (aal2) is required, always
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')'
      into v_has_factor using v_uid;
  end if;
  return not v_has_factor;                                   -- switch off: set up => must enter the code
end $$;
revoke all on function public.is_platform_admin() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.is_platform_admin() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.is_platform_admin() to authenticated; end if;
end $$;

-- ---- 3) the signed-in person's own last reset (Account panel notice; no operator identity) ----------------------
create or replace function public.my_mfa_reset_info()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r22-mfa-reset-0253
  select case when auth.uid() is null then null else
    (select jsonb_build_object('reset_at', r.at) from public.mfa_resets r
      where r.target_user_id = auth.uid() order by r.at desc limit 1) end
$$;
revoke all on function public.my_mfa_reset_info() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.my_mfa_reset_info() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.my_mfa_reset_info() to authenticated; end if;
end $$;

-- ---- VERIFY (read-only): every row must say ok = true ------------------------------------------------------------
select item, ok from (values
  ('01 reset function is 0253', position('r22-mfa-reset-0253' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hq_mfa_reset(text,text)')), '')) > 0),
  ('02 reset closed to visitors', not exists (select 1 from pg_roles where rolname = 'anon')
       or not has_function_privilege('anon', 'public.hq_mfa_reset(text,text)', 'execute')),
  ('03 reset log private + append-only', (select c.relrowsecurity from pg_class c where c.oid = 'public.mfa_resets'::regclass)
       and (not exists (select 1 from pg_roles where rolname = 'authenticated') or not has_table_privilege('authenticated', 'public.mfa_resets', 'select'))
       and exists (select 1 from pg_trigger where tgname = 'a253_mfa_resets_append_only' and tgrelid = 'public.mfa_resets'::regclass)),
  ('04 own reset info callable by signed-in users', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or has_function_privilege('authenticated', 'public.my_mfa_reset_info()', 'execute')),
  ('06 is_platform_admin is 0253 (switch on => aal2 for every HQ call)', position('r22-mfa-0253' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0),
  ('05 database owner may update auth.mfa_factors (the reset needs it)', to_regclass('auth.mfa_factors') is null
       or has_table_privilege((select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = to_regprocedure('public.hq_mfa_reset(text,text)')), 'auth.mfa_factors', 'update'))
) v(item, ok) order by item;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 reset function is 0253', position('r22-mfa-reset-0253' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hq_mfa_reset(text,text)')), '')) > 0),
  ('02 reset closed to visitors', not exists (select 1 from pg_roles where rolname = 'anon')
       or not has_function_privilege('anon', 'public.hq_mfa_reset(text,text)', 'execute')),
  ('03 reset log private + append-only', (select c.relrowsecurity from pg_class c where c.oid = 'public.mfa_resets'::regclass)
       and (not exists (select 1 from pg_roles where rolname = 'authenticated') or not has_table_privilege('authenticated', 'public.mfa_resets', 'select'))
       and exists (select 1 from pg_trigger where tgname = 'a253_mfa_resets_append_only' and tgrelid = 'public.mfa_resets'::regclass)),
  ('04 own reset info callable by signed-in users', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or has_function_privilege('authenticated', 'public.my_mfa_reset_info()', 'execute')),
  ('06 is_platform_admin is 0253 (switch on => aal2 for every HQ call)', position('r22-mfa-0253' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0),
  ('05 database owner may update auth.mfa_factors (the reset needs it)', to_regclass('auth.mfa_factors') is null
       or has_table_privilege((select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = to_regprocedure('public.hq_mfa_reset(text,text)')), 'auth.mfa_factors', 'update'))
) v(item, ok) order by item;
