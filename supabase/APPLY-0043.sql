-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0043 two-step sign-in enforced by the database (one paste)          (2026-10-07)
--   Members who have turned on two-step sign-in (a VERIFIED authenticator factor) must
--   finish the code step before the database shows them any studio data — a password-only
--   (aal1) session gets nothing, even if the browser check is bypassed. Members without
--   two-step sign-in, client links (approve / portal / work pages) and HQ are unaffected.
-- REQUIRES 0042 on this database — the preflight stops if not. STAGING first, then PROD.
--   After pasting: sign in as a member WITH two-step sign-in and confirm the app asks for
--   the code and then loads normally.
-- WHAT IT TOUCHES: current_org_id() (same OID, so every policy keeps using it) now wraps
--   this database's own body, kept once as current_org_id__pre0043(). No data changes.
-- SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regprocedure('public._a42_quote_shelved(uuid)') is null then
    raise exception 'STOP: 0042 not installed — paste APPLY-0042.sql first'; end if;
  if to_regprocedure('public.mfa_ok()') is null then raise exception 'STOP: public.mfa_ok() (0028) is missing'; end if;
  if to_regclass('auth.mfa_factors') is null then raise exception 'STOP: auth.mfa_factors is missing'; end if;
  raise notice 'Preflight OK — applying 0043…';
end $$;

-- ============================================================================
-- 0043_mfa_enforce.sql — CANONICAL forward-only. REQUIRES 0042.
-- Owner decision D3 (audit run 2, RC-6 / C-05): the second factor is enforced by the
-- DATABASE for every member who has enrolled one. A signed-in user with a VERIFIED
-- factor whose session is still aal1 (password only) gets NO studio: current_org_id()
-- returns NULL, so every RLS policy and every definer RPC that checks the studio fails
-- closed, exactly like a user without a studio. At aal2 nothing changes. Users without a
-- verified factor are unaffected (mfa_ok() is true for them). Visitors / service role
-- (auth.uid() null) are unaffected. HQ operators have no studio and use
-- is_platform_admin(), which already requires aal2 when a factor exists.
--
-- DRIFT-SAFE: current_org_id() is used by policies BY OID, so it is not renamed: this
-- database's own body is CLONED once to current_org_id__pre0043() and current_org_id()
-- becomes `mfa_ok() ? current_org_id__pre0043() : NULL`. Re-running is a no-op.
-- ============================================================================
do $$ declare d text; begin
  if to_regprocedure('public.mfa_ok()') is null then
    raise exception '0043: public.mfa_ok() (0028) is missing on this database';
  end if;
  if to_regprocedure('public.current_org_id__pre0043()') is null then
    d := pg_get_functiondef('public.current_org_id()'::regprocedure);
    d := replace(d, 'FUNCTION public.current_org_id(', 'FUNCTION public.current_org_id__pre0043(');
    execute d;
  end if;
  revoke all on function public.current_org_id__pre0043() from public, anon, authenticated;
  grant execute on function public.current_org_id__pre0043() to service_role;
end $$;

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  select case when public.mfa_ok() then public.current_org_id__pre0043() end;
$$;

-- ---- VERIFY (read-only) ----------------------------------------------------------
-- select pg_get_functiondef('public.current_org_id()'::regprocedure);

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('current_org_id() wraps this database''s own body (kept once, private)',
     to_regprocedure('public.current_org_id__pre0043()') is not null
     and pg_get_functiondef('public.current_org_id()'::regprocedure) like '%mfa-enforce-0043%'
     and not has_function_privilege('authenticated', 'public.current_org_id__pre0043()', 'execute')
     and has_function_privilege('authenticated', 'public.current_org_id()', 'execute')),
  ('mfa_ok() lets members without a verified factor through',
     position('verified' in (select prosrc from pg_proc where oid = 'public.mfa_ok()'::regprocedure)) > 0)
) v(item, ok);
-- informational: how many members will be asked for their code at the database
select count(distinct f.user_id) as members_with_two_step from auth.mfa_factors f where f.status::text = 'verified';
