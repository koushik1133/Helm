-- APPLY-0295.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0283 (any order with 0284-0292). It stops with "STOP 0295" if the export / its helpers are missing.
-- R54 security hotfix for Settings -> "Download studio data archive":
--   * only the studio owner or an admin can download it (before: anyone whose role could view the Users area);
--     free-trial studios are still refused;
--   * the file no longer carries hidden codes or other people's security state (invitations.mail_key_hash and
--     profiles.must_change_password leaked before); every token / password / secret / one-time code / two-step /
--     hash-like key is removed at any depth;
--   * every download writes one activity-log row (who, when, how many rows of each kind);
--   * the old unused export_org_data() (it still carried client approval links) can no longer be called by the app.
-- One function re-issued (same name / arguments / answer shape / grants), the previous body kept as
-- export_tenant_organization_package__pre0295 (not callable by the app), two private helpers added, one execute
-- grant taken away. No table, row, policy or index touched. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (control.html: the export button is for the owner / admins only, asks a short "keep it
--      private" question before downloading, and names the file after the studio with the India date).
--   3  Check: as an admin, Settings -> Data & compliance -> "Download studio data archive" -> confirm -> a file
--      helm-export-<studio>-<date>.json downloads; Settings -> Activity shows "studio.data_export".
begin;
-- 0295_r54_export_lockdown.sql - CANONICAL forward-only.
-- REQUIRES 0033 / 0156 (export_tenant_organization_package__pre0173 = the token-strip wrapper over __base),
--          0173 (export_tenant_organization_package = the free-trial wrapper, _tl173_guard, export_org_data wrapper),
--          0283 (_r283_owner = the studio owner), the base audit_log table, current_org_id / is_admin.
--
-- In plain words (r54 security hotfix for Settings -> "Download studio data archive"):
--   1  Only the studio OWNER or an ADMIN can download the studio data file. Before, anyone whose role could VIEW the
--      Users area could. Free-trial studios are still refused ("Not available in the free trial").
--   2  The file never carries hidden codes or other people's security state. On top of the old strip list
--      (approval_token, share_token, token, code_hash) every key anywhere in the file (at any depth) whose name looks
--      like a token / password / secret / one-time code / two-step factor / hash / api key is now removed - this
--      covers invitations.mail_key_hash and profiles.must_change_password, which leaked before.
--   3  Every download writes one activity-log row (audit_log, action studio.data_export): who, when, and how many
--      rows of each kind were in the file. Nothing else is stored (no copy of the data).
--   4  The old unused export_org_data() (it still carried quotes.approval_token) can no longer be called by the app
--      (execute revoked from anon / authenticated). The function itself is kept.
--   The previous export body is kept once as export_tenant_organization_package__pre0295 (not callable by the app).
-- ZERO DATA LOSS: no table, column, row, policy or index is created, changed or deleted. Two small private helper
-- functions are added, one function is re-issued (same name / arguments / result / grants), one renamed copy kept,
-- one execute grant taken away. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): alter function public.export_tenant_organization_package() rename to
--   export_tenant_organization_package__r54_off; alter function public.export_tenant_organization_package__pre0295()
--   rename to export_tenant_organization_package; grant execute on function public.export_tenant_organization_package()
--   to authenticated;

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.export_tenant_organization_package()') is null then
    raise exception 'STOP 0295: public.export_tenant_organization_package() missing'; end if;
  if to_regprocedure('public.export_tenant_organization_package__pre0173()') is null
     and to_regprocedure('public.export_tenant_organization_package__pre0295()') is null then
    raise exception 'STOP 0295: export_tenant_organization_package__pre0173() missing - run 0173 first'; end if;
  if to_regprocedure('public._tl173_guard()') is null then
    raise exception 'STOP 0295: public._tl173_guard() missing - run 0173 first'; end if;
  if to_regprocedure('public._r283_owner(uuid)') is null then
    raise exception 'STOP 0295: public._r283_owner(uuid) missing - run 0283 first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP 0295: current_org_id() / is_admin() missing'; end if;
  if to_regclass('public.audit_log') is null or to_regclass('public.organizations') is null then
    raise exception 'STOP 0295: audit_log / organizations missing'; end if;
end $$;

-- ---- 2) keep the previous body once (rename-once; a re-run leaves the kept copy alone) ----------------------
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package()'));
  if to_regprocedure('public.export_tenant_organization_package__pre0295()') is null and v_src is not null
     and position('r54-export-0295' in v_src) = 0 then
    alter function public.export_tenant_organization_package() rename to export_tenant_organization_package__pre0295;
  end if;
  if to_regprocedure('public.export_tenant_organization_package__pre0295()') is not null then
    revoke all on function public.export_tenant_organization_package__pre0295() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public.export_tenant_organization_package__pre0295() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public.export_tenant_organization_package__pre0295() from authenticated; end if;
  end if;
end $$;

-- ---- 3) helpers: which key names are secret-like, and a recursive scrub ------------------------------------
create or replace function public._r295_secret_key(p_key text)
returns boolean language sql immutable set search_path = '' as $$
  -- r54-export-0295: a key name that looks like a hidden code / password / security state
  select p_key is not null and (
       lower(p_key) in ('approval_token', 'share_token', 'token', 'code_hash', 'mail_key_hash', 'must_change_password', 'pin_hash')
    or lower(p_key) ~ '(token|passw|secret|api_?key|private_?key|recovery_code)'
    or lower(p_key) ~ '(^|_)(otp|totp|mfa|factor|factors|hash|salt|nonce)(_|$)');
$$;

create or replace function public._r295_scrub(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r54-export-0295: removes every secret-like key at any depth. A subtree whose text has no key that could match is
-- returned as it is (cheap pre-check; the pattern is wider than _r295_secret_key, so nothing is missed).
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) not in ('object', 'array') then return p; end if;
  if not (p::text ~* '"[^"]*(token|passw|secret|api_?key|private_?key|recovery_code|otp|mfa|factor|hash|salt|nonce)[^"]*"\s*:') then
    return p;
  end if;
  if jsonb_typeof(p) = 'object' then
    return coalesce((select jsonb_object_agg(t.key, public._r295_scrub(t.value))
                       from jsonb_each(p) t where not public._r295_secret_key(t.key)), '{}'::jsonb);
  end if;
  return coalesce((select jsonb_agg(public._r295_scrub(a.x) order by a.n)
                     from jsonb_array_elements(p) with ordinality a(x, n)), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['public._r295_secret_key(text)', 'public._r295_scrub(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

-- ---- 4) the export: owner / admin only, trial refused, scrubbed, one activity-log row per download -----------
create or replace function public.export_tenant_organization_package()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r54-export-0295: studio owner / admin only; free trial still refused; every secret-like key removed at any depth;
-- one audit_log row (studio.data_export) per download with the row counts
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v jsonb; v_counts jsonb;
begin
  if v_uid is null or v_org is null then
    raise exception 'no organization context' using errcode = '42501';
  end if;
  if not (coalesce(public.is_admin(), false) or public._r283_owner(v_org) is not distinct from v_uid) then
    raise exception 'Only the studio owner or an admin can download studio data.' using errcode = '42501', hint = 'owner_or_admin_only';
  end if;
  perform public._tl173_guard();                                   -- free trial: "Not available in the free trial"
  v := public.export_tenant_organization_package__pre0295();       -- trial check + token strip + the studio's rows
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  v := public._r295_scrub(v);
  if v ? 'profiles' and jsonb_typeof(v -> 'profiles') = 'array' then   -- named explicitly as well (belt and braces)
    v := jsonb_set(v, '{profiles}', coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then x - 'must_change_password' else x end order by n)
                                                from jsonb_array_elements(v -> 'profiles') with ordinality a(x, n)), '[]'::jsonb));
  end if;
  if v ? 'invitations' and jsonb_typeof(v -> 'invitations') = 'array' then
    v := jsonb_set(v, '{invitations}', coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then x - 'mail_key_hash' - 'token' else x end order by n)
                                                   from jsonb_array_elements(v -> 'invitations') with ordinality a(x, n)), '[]'::jsonb));
  end if;
  v_counts := coalesce((select jsonb_object_agg(t.key, case jsonb_typeof(t.value) when 'array' then jsonb_array_length(t.value)
                                                                                    when 'object' then 1 else 0 end)
                          from jsonb_each(v) t where jsonb_typeof(t.value) in ('array', 'object')), '{}'::jsonb);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'studio.data_export', 'organizations', v_org::text,
            jsonb_build_object('rows', v_counts, 'format', 'json', 'from', 'settings'), v_org, now());
  return v;
end $$;

do $$ begin
  revoke all on function public.export_tenant_organization_package() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.export_tenant_organization_package() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.export_tenant_organization_package() to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.export_tenant_organization_package() to service_role; end if;
end $$;

-- ---- 5) the old unused export_org_data(): kept, but the app can no longer call it ------------------------------
do $$ declare f text; begin
  foreach f in array array['public.export_org_data()', 'public.export_org_data__pre0173()'] loop
    continue when to_regprocedure(f) is null;
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 export is the 0295 body (owner / admin only, scrubbed, audited)',
     position('r54-export-0295' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package()')), '')) > 0),
  ('02 export is plpgsql, volatile, security definer, empty search path',
     coalesce((select p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql' and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                 from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('public.export_tenant_organization_package()')), false)),
  ('03 signed-in users can call the export (the owner / admin check is inside)',
     has_function_privilege('authenticated', 'public.export_tenant_organization_package()', 'execute')),
  ('04 anon cannot call the export',
     not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.export_tenant_organization_package()', 'execute')),
  ('05 owner / admin check, free-trial check and audit row are in the body',
     coalesce((select position('public.is_admin()' in p.prosrc) > 0 and position('public._r283_owner(v_org)' in p.prosrc) > 0
                      and position('public._tl173_guard()' in p.prosrc) > 0 and position('studio.data_export' in p.prosrc) > 0
                      and position('insert into public.audit_log' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package()')), false)),
  ('06 previous body kept once as export_tenant_organization_package__pre0295',
     to_regprocedure('public.export_tenant_organization_package__pre0295()') is not null),
  ('07 the kept previous body is not callable by the app',
     not has_function_privilege('authenticated', 'public.export_tenant_organization_package__pre0295()', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.export_tenant_organization_package__pre0295()', 'execute'))),
  ('08 the deny-list catches mail_key_hash, must_change_password, approval_token, code_hash, otp / factor / secret keys',
     public._r295_secret_key('mail_key_hash') and public._r295_secret_key('must_change_password') and public._r295_secret_key('approval_token')
     and public._r295_secret_key('share_token') and public._r295_secret_key('token') and public._r295_secret_key('code_hash')
     and public._r295_secret_key('client_otp') and public._r295_secret_key('mfa_factor_id') and public._r295_secret_key('api_secret')
     and not public._r295_secret_key('email') and not public._r295_secret_key('pin_code') and not public._r295_secret_key('code')),
  ('09 the scrub removes secret-like keys at any depth and keeps the rest',
     public._r295_scrub('{"a": {"keep": 1, "mail_key_hash": "x", "b": [{"token": "t", "name": "n"}]}, "must_change_password": true}'::jsonb)
       = '{"a": {"keep": 1, "b": [{"name": "n"}]}}'::jsonb),
  ('10 the helpers are not callable by the app',
     not has_function_privilege('authenticated', 'public._r295_scrub(jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public._r295_secret_key(text)', 'execute')),
  ('11 no signed-in person / no studio: the export refuses before reading anything',
     coalesce((select position('if v_uid is null or v_org is null then' in p.prosrc) > 0
                      and position('if v_uid is null or v_org is null then' in p.prosrc) < position('__pre0295()' in p.prosrc)
                 from pg_proc p where p.oid = to_regprocedure('public.export_tenant_organization_package()')), false)),
  ('12 the old export_org_data() is kept but not callable by anon / authenticated',
     to_regprocedure('public.export_org_data()') is not null
     and not has_function_privilege('authenticated', 'public.export_org_data()', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.export_org_data()', 'execute'))),
  ('13 nothing removed: audit_log, invitations, profiles, quotes still there',
     to_regclass('public.audit_log') is not null and to_regclass('public.invitations') is not null
     and to_regclass('public.profiles') is not null and to_regclass('public.quotes') is not null)
) v(item, ok) order by item;
