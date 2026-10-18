-- APPLY-0207.sql - paste into the Supabase SQL editor (staging first, then production).
-- Free-trial terms "I agree": the welcome right after a free-trial sign-up now starts with "Your 8-day free
-- trial" (what is included, what you can do, what is locked, what happens after) and the trial owner must tick
-- "I have read and agree to the free-trial terms, the Terms of Service and the Privacy Policy" before entering.
-- This file records that agreement on the server, so it works across devices and is asked only once per terms
-- version. A trial that finished the welcome before this file gets the same terms once as a window; invited
-- teammates get a short notice (no agreement). Paid studios and ended trials are never asked.
-- What it adds: table trial_terms_acceptances (RLS on, no app grants; kept by the trial-data deletion as a
-- consent record), _trial_terms_version(), my_trial_terms_status(), accept_trial_terms(version, user_agent).
-- No existing row is changed or deleted. No DROP / DELETE / UPDATE / TRUNCATE. Safe to run twice.
-- After it: deploy the app (trial-facts.js, trial-demo.js, trial-lock.js, store-api.js, dashboard / login pages).
begin;
-- 0207_trial_terms_acceptance.sql - CANONICAL forward-only.
-- REQUIRES 0045 (tg_studio_read_only), 0116 (_trial_locked), 0166 (_is_trial_org, organizations.is_sample_master),
--          0180 (organizations.trial_welcome_pending), 0184 (_tr184_keep_tables).
--
-- In plain words (owner request 2026-10-18: show the free-trial terms in the onboarding and require "I agree"):
--   * New small table public.trial_terms_acceptances: one row per (studio, person, terms version) with the
--     time and a short browser name (user agent, max 160 printable characters). kind = 'agree' for the
--     trial owner (the person who started the trial) who ticked "I have read and agree ...", 'notice' for an
--     invited teammate who read the short trial notice ("Got it"; no agreement is asked of them).
--     RLS on, no app grants: only the two functions below read or write it. It is a consent record, so the
--     60-day trial-data deletion (0184) KEEPS it (added to _tr184_keep_tables, like studio_consent_log).
--   * _trial_terms_version() = 'trial-2026-10-18' (= HelmTrialFacts.VERSION in public/trial-facts.js).
--     A new wording gets a new version: the owner is asked once more, nothing else changes.
--   * my_trial_terms_status(): for the signed-in member of a studio ON its free trial (running, not
--     read-only, not the sample master): must_agree (the owner has not agreed to this version yet ->
--     the welcome keeps showing "Your 8-day free trial" as its first step, on every device; an owner
--     who finished the welcome before this file gets a one-time "agree" window instead), notice (an
--     invited teammate has not seen the short notice yet). Paid studios, ended trials and clients:
--     everything false - nothing is ever asked of them.
--   * accept_trial_terms(version, user_agent): records it for the caller (insert once; a second call
--     changes nothing). Refuses a different version (a stale cached page), anybody signed out, a client
--     login, and a studio that is not on its free trial. An ended / read-only trial is answered
--     'not_needed' and nothing is written. The owner's agreement also writes one audit_log row.
--   No existing row is changed or deleted. Additive + idempotent: create table / index if not exists,
--   create or replace, one in-place list patch done once. No DROP, DELETE, UPDATE or TRUNCATE. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._is_trial_org(uuid)') is null then
    raise exception '0207: _is_trial_org (0166) is missing'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0207: _trial_locked (0116) is missing'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception '0207: tg_studio_read_only (0045) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'trial_welcome_pending') then
    raise exception '0207: organizations.trial_welcome_pending (0180) is missing'; end if;
end $$;

-- ---- 1) the record -----------------------------------------------------------------------------------------
create table if not exists public.trial_terms_acceptances (
  org_id      uuid        not null references public.organizations(id) on delete restrict,
  user_id     uuid        not null,
  version     text        not null check (version ~ '^trial-[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  kind        text        not null default 'agree' check (kind in ('agree', 'notice')),
  accepted_at timestamptz not null default now(),
  user_agent  text        check (user_agent is null or char_length(user_agent) <= 160),
  primary key (org_id, user_id, version)
);
comment on table public.trial_terms_acceptances is
  '0207: free-trial terms record - owner "I agree" (kind agree) / teammate notice seen (kind notice), per terms version. Definer functions only; kept by the trial-data deletion (consent record).';
create index if not exists trial_terms_acceptances_user_idx on public.trial_terms_acceptances(user_id);
alter table public.trial_terms_acceptances enable row level security;
revoke all on table public.trial_terms_acceptances from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.trial_terms_acceptances from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.trial_terms_acceptances from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.trial_terms_acceptances to service_role'; end if;
  -- the same read-only guard as every studio table (rows are only written while the trial runs anyway)
  if not exists (select 1 from pg_trigger where tgrelid = 'public.trial_terms_acceptances'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.trial_terms_acceptances '
            'for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;
-- (no policies on purpose: only the SECURITY DEFINER functions below read or write this table)

-- ---- 2) the current terms version ------------------------------------------------------------------------------
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-10-18'::text;
$$;

-- the caller's view of the studio's free trial: is it running, and is the caller its owner?
-- owner = the person who started the trial (organizations.created_by); when that person is no longer in the
-- studio, its admins stand in (so somebody can always agree).
create or replace function public._tt207_ctx()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-terms-0207
declare v_uid uuid := auth.uid(); v_org uuid; v_role text; o public.organizations; v_trial boolean := false; v_owner boolean := false;
begin
  if v_uid is null then return jsonb_build_object('signed_in', false); end if;
  v_org := public.current_org_id();
  v_role := coalesce(public.user_role(), '');
  if v_org is null or v_role in ('', 'client') then
    return jsonb_build_object('signed_in', true, 'org_id', v_org, 'member', false, 'trial', false, 'owner', false);
  end if;
  select * into o from public.organizations x where x.id = v_org;
  v_trial := o.id is not null and not coalesce(o.is_sample_master, false)
             and coalesce(public._is_trial_org(v_org), false)
             and not coalesce(public._trial_locked(v_org), false);
  v_owner := (o.created_by is not null and o.created_by = v_uid)
             or (coalesce(public.is_admin(), false)
                 and not exists (select 1 from public.profiles p where p.id = o.created_by and p.org_id = v_org));
  return jsonb_build_object('signed_in', true, 'org_id', v_org, 'member', true, 'trial', v_trial, 'owner', v_owner,
                            'welcome_pending', coalesce(o.trial_welcome_pending, false));
end $$;

-- ---- 3) status for the app ---------------------------------------------------------------------------------
create or replace function public.my_trial_terms_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-terms-0207: {version, trial, owner, accepted, accepted_at, kind, must_agree, notice, welcome_pending}
declare c jsonb := public._tt207_ctx(); v_ver text := public._trial_terms_version(); a public.trial_terms_acceptances;
  v_trial boolean; v_owner boolean;
begin
  if not coalesce((c ->> 'signed_in')::boolean, false) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_trial := coalesce((c ->> 'trial')::boolean, false);
  v_owner := v_trial and coalesce((c ->> 'owner')::boolean, false);
  if v_trial then
    select * into a from public.trial_terms_acceptances t
     where t.org_id = (c ->> 'org_id')::uuid and t.user_id = auth.uid() and t.version = v_ver;
  end if;
  return jsonb_build_object('version', v_ver, 'trial', v_trial, 'owner', v_owner,
    'accepted', a.org_id is not null, 'accepted_at', a.accepted_at, 'kind', a.kind,
    'must_agree', v_owner and a.org_id is null,
    'notice', v_trial and not v_owner and a.org_id is null,
    'welcome_pending', v_trial and coalesce((c ->> 'welcome_pending')::boolean, false));
end $$;

-- ---- 4) record it ------------------------------------------------------------------------------------------
create or replace function public.accept_trial_terms(p_version text, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-terms-0207: the trial owner agrees / a teammate saw the notice (once per terms version)
declare c jsonb := public._tt207_ctx(); v_ver text := public._trial_terms_version(); v_org uuid; v_kind text;
  v_ua text; v_hdr text; v_n int; a public.trial_terms_acceptances;
begin
  if not coalesce((c ->> 'signed_in')::boolean, false) or not coalesce((c ->> 'member')::boolean, false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_version is distinct from v_ver then
    raise exception 'These free-trial terms are out of date. Reload the page to read the current terms.'
      using errcode = '22023', hint = 'trial_terms_version'; end if;
  v_org := (c ->> 'org_id')::uuid;
  if not coalesce((c ->> 'trial')::boolean, false) then
    -- an ended (read-only) trial has nothing to agree to; a paid studio / the sample master never uses this
    if coalesce(public._is_trial_org(v_org), false) then
      return jsonb_build_object('result', 'not_needed', 'version', v_ver); end if;
    raise exception 'only a studio on its free trial uses these terms' using errcode = '22023'; end if;
  v_kind := case when coalesce((c ->> 'owner')::boolean, false) then 'agree' else 'notice' end;
  -- the browser name: PostgREST's request header first, else what the page sent; printable ASCII, 160 max
  begin v_hdr := (nullif(current_setting('request.headers', true), '')::jsonb) ->> 'user-agent';
  exception when others then v_hdr := null; end;
  v_ua := nullif(left(btrim(regexp_replace(coalesce(nullif(v_hdr, ''), p_user_agent, ''), '[^ -~]+', '', 'g')), 160), '');
  insert into public.trial_terms_acceptances(org_id, user_id, version, kind, accepted_at, user_agent)
    values (v_org, auth.uid(), v_ver, v_kind, now(), v_ua)
  on conflict (org_id, user_id, version) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 and v_kind = 'agree' then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'trial.terms_accepted',
             'organizations', v_org::text, jsonb_build_object('version', v_ver), v_org, now();
  end if;
  select * into a from public.trial_terms_acceptances t where t.org_id = v_org and t.user_id = auth.uid() and t.version = v_ver;
  return jsonb_build_object('result', case when v_n > 0 then 'ok' else 'already' end, 'version', v_ver,
                            'kind', a.kind, 'accepted_at', a.accepted_at);
end $$;

-- ---- 5) privileges -------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._trial_terms_version()', 'public._tt207_ctx()', 'public.my_trial_terms_status()',
                           'public.accept_trial_terms(text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_trial_terms_status() to authenticated';
    execute 'grant execute on function public.accept_trial_terms(text, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._trial_terms_version() to service_role';
    execute 'grant execute on function public.my_trial_terms_status() to service_role';
  end if;
end $$;

-- ---- 6) trial retention (0184): the record is consent evidence -> KEPT, never purged ----------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''trial_terms_acceptances''' in v_def) > 0 then return; end if;
  if position('''trial_grants'', ''trial_extensions''' in v_def) = 0 then
    raise notice '0207: _tr184_keep_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''trial_grants'', ''trial_extensions''',
                  '''trial_grants'', ''trial_extensions'', ''trial_terms_acceptances''');
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 table trial_terms_acceptances exists with RLS on and no permissive policy',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_terms_acceptances')), false)
     and not exists (select 1 from pg_policy where polrelid = to_regclass('public.trial_terms_acceptances') and polpermissive)),
  ('02 the app cannot read or write the table directly',
     not has_table_privilege('anon', 'public.trial_terms_acceptances', 'select')
     and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'select')
     and not has_table_privilege('authenticated', 'public.trial_terms_acceptances', 'insert')),
  ('03 studio read-only guard attached',
     exists (select 1 from pg_trigger where tgrelid = to_regclass('public.trial_terms_acceptances') and tgname = 'zzz_studio_read_only')),
  ('04 my_trial_terms_status + accept_trial_terms: SECURITY DEFINER, empty search_path',
     coalesce((select bool_and(prosecdef and 'search_path=""' = any(proconfig)) from pg_proc
               where oid in (to_regprocedure('public.my_trial_terms_status()'), to_regprocedure('public.accept_trial_terms(text,text)'))), false)),
  ('05 signed-in app may call them; anon may not',
     has_function_privilege('authenticated', 'public.my_trial_terms_status()', 'execute')
     and has_function_privilege('authenticated', 'public.accept_trial_terms(text,text)', 'execute')
     and not has_function_privilege('anon', 'public.my_trial_terms_status()', 'execute')
     and not has_function_privilege('anon', 'public.accept_trial_terms(text,text)', 'execute')),
  ('06 terms version is trial-2026-10-18', public._trial_terms_version() = 'trial-2026-10-18'),
  ('07 trial-data deletion keeps the record (listed once, never purged)',
     'trial_terms_acceptances' = any(public._tr184_keep_tables())
     and array_length(array_positions(public._tr184_keep_tables(), 'trial_terms_acceptances'), 1) = 1
     and not ('trial_terms_acceptances' = any(public._tr184_purge_tables()))),
  ('08 every studio table is still classified for the trial-data deletion',
     not exists (select 1 from unnest(public._tr184_org_tables()) t
                  where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())))
) v(item, ok) order by item;
