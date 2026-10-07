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
