-- APPLY-0201.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER the trial bundle (APPLY-TRIAL-BUNDLE.sql: 0173-0187) AND APPLY-0190 / APPLY-0194
-- (APPLY-RELEASE-1018.sql runs everything in the right order in one paste).
-- Release integration fix: (A) the free-trial sign-up keeps the one-free-trial-per-e-mail guard (0186) and the
-- 0180 sign-up rules (sample data, India, welcome) after 0190 had replaced the sign-up function; (B) the trial
-- retention purge list (0184) knows the 0194 group-chat contacts table.
-- Functions only: 3 bodies re-issued; no table, column or row change, nothing deleted. Safe to run twice. ASCII only.
begin;
-- ============================================================================
-- 0201_release_integration.sql - CANONICAL forward-only. Release integration fixes
-- (release/trial-and-fixes-1018): branches written in parallel, put back together.
-- REQUIRES 0180 (trial sign-up flow), 0184 (trial retention purge lists), 0186 (one free trial per e-mail:
--          start_self_serve_trial__pre0186, _trial_email_fingerprint, _trial_used), 0190 (trial clone
--          reliability), 0194 (chat_group_contacts).
--
-- In plain words:
-- A) THE FREE-TRIAL SIGN-UP ENTRY POINT keeps the trial-bundle rules.
--   Two branches changed the same database function, start_self_serve_trial (the one call that creates
--   a free-trial studio at sign-up), without seeing each other:
--     * the trial bundle: 0180 made every trial start WITH the sample data on INR / Asia/Kolkata and
--       set the welcome flag; 0186 then wrapped it so a person (user or e-mail) who already had a free
--       trial cannot start a second one (the 0180 body was kept as start_self_serve_trial__pre0186);
--     * 0190 (trial clone reliability, written on the older 0119 body) replaced start_self_serve_trial
--       to drop a slow time zone lookup.
--   Applied in number order, 0190 runs last and overwrites the 0186 wrapper with the old 0119 body:
--   the one-trial-per-e-mail guard would be gone and sign-ups would again use the visitor's currency /
--   time zone and "own data" mode. On a database where 0190 ran BEFORE 0186, the 0186 rename would
--   instead have kept the 0190 body (not the 0180 one) behind the wrapper.
--   This file puts the intended chain back in every case:
--     start_self_serve_trial          = the 0186 wrapper (refuses a second free trial, hint trial_used)
--     start_self_serve_trial__pre0186 = the 0180 body (sample data, India, welcome flag)
--   0190's speed-up is kept: the 0180 body never reads the time zone catalogue (it ignores the visitor
--   time zone), and 0190's faster sample clone (_sample_clone_into__pre0168) is untouched.
-- B) TRIAL RETENTION (0184) knows the 0194 table. 0194 (event group people) added chat_group_contacts
--   (a group chat's staff / vendor / client contacts) without seeing 0184, so the retention dry run
--   reported it as "unclassified" (kept, never purged). It is one of the studio's chat records: it is
--   added to _tr184_purge_tables next to chat_members (patched in place once, the way 0198 adds its
--   tables; skipped when 0184 is not installed). Nothing is deleted by this file: the purge itself
--   stays behind the owner switch (off by default).
--
-- ZERO DATA LOSS: three function bodies re-issued (CREATE OR REPLACE, same signatures); grants re-stated
-- exactly as 0186 left them. No table, column, index, trigger or row is created, changed or removed.
-- ASCII only. Safe to run twice (and on a database that already has the right chain: same result).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.start_self_serve_trial__pre0186(text,text,text,text)') is null
     or to_regprocedure('public._trial_used(uuid,text,uuid)') is null
     or to_regprocedure('public._trial_email_fingerprint(text)') is null then
    raise exception '0201: apply 0186 (one free trial per e-mail) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'organizations' and column_name = 'trial_welcome_pending') then
    raise exception '0201: apply 0180 (trial sign-up flow) first'; end if;
  if to_regprocedure('public._tz_name_ok(text)') is null then
    raise exception '0201: apply 0190 (trial clone reliability) first'; end if;
  if to_regclass('public.chat_group_contacts') is null then
    raise exception '0201: apply 0194 (event group people) first'; end if;
end $$;

-- ---- 1) the body behind the wrapper: the 0180 sign-up (sample data + India + welcome flag) ----------
create or replace function public.start_self_serve_trial__pre0186(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119 trial-signup-0180: always sample data + India; the welcome flag is set
-- (re-issued by release-0201 as the body behind the one-trial-0186 wrapper; no time zone catalogue read)
declare
  v_uid uuid := auth.uid();
  v_tz text := 'Asia/Kolkata'; v_cur text := 'INR';
  v_mode text := 'demo';
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_had uuid; v_org uuid; v_n bigint; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 80) then
    raise exception 'studio name must be 2 to 80 characters' using errcode = '22023'; end if;

  if v_name is null then
    -- one "Demo N" at a time across the whole database (same lock as 0116)
    perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
    v_n := public._trial_next_demo_number();
    v_name := 'Demo ' || v_n::text;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + make_interval(days => public._trial_days());
  -- the 0177 trigger stamps trial_region 'IN' and keeps INR / Asia/Kolkata / IN / GST on this update
  update public.organizations
     set trial_ends_at = v_end, trial_mode = v_mode, trial_welcome_pending = true
   where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  -- sample data: a failure here never blocks the trial (that block alone is rolled back)
  begin v_seed := public._demo_seed(v_org);
  exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  begin v_extra := public._trial_seed_extra(v_org);
  exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_self_serve_trial', 'name', v_name, 'mode', v_mode,
                              'requested_mode', left(coalesce(p_mode, ''), 20),
                              'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'mode', v_mode,
                            'currency', v_cur, 'timezone', v_tz, 'welcome', true,
                            'trial_ends_at', v_end, 'trial_days', public._trial_days(), 'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_self_serve_trial__pre0186(text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.start_self_serve_trial__pre0186(text, text, text, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.start_self_serve_trial__pre0186(text, text, text, text) from authenticated; end if;
end $$;

-- ---- 2) the entry point: the 0186 wrapper (one free trial per user / e-mail) -------------------------
create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: a person who already had a free trial (this user or this e-mail) gets no second one
-- (re-issued by release-0201 after trial-clone-0190 had replaced it; the cheap path stays: no time zone catalogue read)
declare v_uid uuid := auth.uid(); v_email text; v_key text;
begin
  if v_uid is not null
     and not exists (select 1 from public.profiles p where p.id = v_uid and p.org_id is not null)
     and not coalesce(public.is_platform_admin(), false) then
    select u.email into v_email from auth.users u where u.id = v_uid;
    v_key := coalesce(public._trial_email_fingerprint(v_email), v_uid::text);
    perform pg_advisory_xact_lock(hashtextextended('helm:one_trial:' || v_key, 0));
    if public._trial_used(v_uid, v_email) then
      raise exception 'You have already used your free Helm trial with this email. Create your studio with a plan to continue, or contact Helm support if you need more time.'
        using errcode = '22023', hint = 'trial_used';
    end if;
  end if;
  return public.start_self_serve_trial__pre0186(p_name, p_timezone, p_currency, p_mode);
end $$;
revoke all on function public.start_self_serve_trial(text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.start_self_serve_trial(text, text, text, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.start_self_serve_trial(text, text, text, text) to service_role; end if;
end $$;

-- ---- 3) trial retention (0184): chat_group_contacts is a chat record of the studio --------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''chat_group_contacts''' in v_def) > 0 then return; end if;
  if position('''chat_members'', ''chat_conversations''' in v_def) = 0 then
    raise notice '0201: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''chat_members'', ''chat_conversations''',
                  '''chat_members'', ''chat_group_contacts'', ''chat_conversations''');
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 sign-up entry point is the 0186 one-trial wrapper', position('one-trial-0186' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) > 0
       and position('start_self_serve_trial__pre0186' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) > 0),
  ('02 behind it: the 0180 sign-up (sample data + India + welcome)', position('trial-signup-0180' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial__pre0186(text,text,text,text)'::regprocedure)) > 0),
  ('03 no time zone catalogue read on sign-up', position('pg_timezone_names' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) = 0
       and position('pg_timezone_names' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial__pre0186(text,text,text,text)'::regprocedure)) = 0),
  ('04 signed-in users can start a trial, anon cannot, nobody calls the inner body', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
       and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
       and not has_function_privilege('authenticated', 'public.start_self_serve_trial__pre0186(text,text,text,text)', 'execute')),
  ('05 trial retention purge list has chat_group_contacts', 'chat_group_contacts' = any(public._tr184_purge_tables())),
  ('06 trial retention: every studio table is classified', not exists (select 1 from unnest(public._tr184_org_tables()) t
       where t <> all(public._tr184_purge_tables()) and t <> all(public._tr184_keep_tables())))
) v(item, ok) order by item;
