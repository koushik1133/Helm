-- APPLY-0186.sql - paste into the Supabase SQL editor (staging first, then production).
-- Owner post-trial policy 7 + 8: ONE free trial per studio / e-mail, and ONE trial extension
-- (1 to 7 days, reason required) that only Helm HQ can grant from the HQ studio page.
-- Run it AFTER every other pending trial file (0173-0185): it wraps start_self_serve_trial,
-- my_pending_start_trial and my_start_trial, so it must be the last one to touch them.
-- What it touches: 2 NEW private tables (trial_grants, trial_extensions; RLS on, no access for the app),
-- 1 trigger on studio_subscriptions, new functions, 3 functions wrapped (old bodies kept as *__pre0186).
-- The only rows written: the new trial_grants ledger is filled once from studios that already had a
-- trial (insert only). No existing row is updated or deleted. No DROP / DELETE / TRUNCATE.
-- Safe to run twice. No edge function needs a redeploy.
begin;
-- 0186_trial_one_per_email_extension.sql - CANONICAL forward-only.
-- REQUIRES 0029 + 0037 + 0047 (Helm HQ: is_platform_admin, _hq_gate, _hq_wgate), 0045 (studio_subscriptions,
--          subscription_payments), 0056 (my_start_trial, trial_source), 0058 (_trial_paid),
--          0116 + 0119 (start_self_serve_trial, _trial_locked), 0159 (my_pending_start_trial),
--          0166 (_is_trial_org, organizations.is_sample_master).
--
-- In plain words (owner post-trial policy items 7 + 8, docs/trial/POST-TRIAL-POLICY.md):
--   7. ONE free trial per studio and per e-mail.
--      * New private ledger public.trial_grants: one row per studio that ever started a trial
--        (studio id, the studio creator's user id, a one-way SHA-256 fingerprint of the creator's
--        e-mail - never the e-mail itself). A trigger writes the row whenever a studio's
--        subscription becomes 'trial'; the studios that already had a trial are filled in once here.
--        The ledger is not linked to the studio row on purpose: it stays if a studio or an account
--        is removed later, so the same e-mail cannot start over.
--      * The fingerprint ignores upper/lower case, spaces, a "+tag" (name+x@...) and, for Gmail,
--        dots in the name.
--      * start_self_serve_trial(), my_pending_start_trial() and my_start_trial() refuse a NEW free
--        trial when this user or this e-mail already had one (friendly message, SQLSTATE 22023,
--        hint 'trial_used'). Someone already in a studio is handed it back unchanged as before.
--        Studios that already have a subscription (paid or trial) go straight to the old code.
--   8. ONE trial extension per studio: 1 to 7 days, only a Helm HQ operator (platform admin; a
--      two-step session whenever HQ requires it) can grant it, a reason is required.
--      * New private table public.trial_extensions (primary key = studio: at most one, ever).
--      * hq_extend_trial(studio, days, reason): the studio must be on its free trial, or its free
--        trial ended unpaid (lapsed to past due / cancelled with no paid period, never paid, no
--        online checkout). The new end is
--        max(old end, now) + days, written to organizations.trial_ends_at (when set) and the
--        subscription; the status goes back to 'trial', so the read-only lock lifts. Audit rows:
--        'hq.trial.extend' (HQ log, with the reason) and 'subscription.trial_extended' (studio log).
--      * hq_trial_info(studio): what the HQ studio page shows (trial state, extension, can extend).
-- ZERO DATA LOSS / paid studios unaffected: additive + idempotent. Two new private tables (RLS on,
-- no grants, no policies), one trigger, new functions; three functions are wrapped with the same
-- signature and grants (the previous bodies are kept as *__pre0186, not callable by app roles).
-- The one-time fill only INSERTS into the new ledger (on conflict do nothing); no existing row is
-- updated or deleted. No DROP of data, DELETE or TRUNCATE. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is null then
    raise exception '0186: start_self_serve_trial (0119) is missing'; end if;
  if to_regprocedure('public.my_pending_start_trial()') is null then
    raise exception '0186: my_pending_start_trial (0159) is missing'; end if;
  if to_regprocedure('public.my_start_trial(text,text)') is null then
    raise exception '0186: my_start_trial (0056 / 0119) is missing'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public._hq_gate(text,text)') is null then
    raise exception '0186: Helm HQ (0029 / 0045 / 0047) is missing'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0186: apply 0116 + 0166 (trial helpers) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'studio_subscriptions' and column_name = 'trial_source') then
    raise exception '0186: studio_subscriptions.trial_source (0056) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0186: organizations.is_sample_master (0166) is missing'; end if;
end $$;

-- ---- 1) private tables ---------------------------------------------------------------------
create table if not exists public.trial_grants (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  user_id      uuid,
  email_hash   text check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  source       text check (source is null or char_length(source) <= 40),
  started_at   timestamptz not null default now(),
  recorded_how text not null default 'trigger' check (recorded_how in ('trigger', 'backfill'))
);
create unique index if not exists trial_grants_org_uq on public.trial_grants(org_id);
create index if not exists trial_grants_user_idx on public.trial_grants(user_id) where user_id is not null;
create index if not exists trial_grants_email_idx on public.trial_grants(email_hash) where email_hash is not null;
alter table public.trial_grants enable row level security;
revoke all on table public.trial_grants from public, anon, authenticated;

create table if not exists public.trial_extensions (
  org_id           uuid primary key,
  days             integer not null check (days between 1 and 7),
  reason           text not null check (char_length(btrim(reason)) between 5 and 500),
  previous_status  text,
  previous_ends_at timestamptz,
  new_ends_at      timestamptz not null,
  granted_by       uuid,
  granted_by_email text,
  granted_at       timestamptz not null default now()
);
alter table public.trial_extensions enable row level security;
revoke all on table public.trial_extensions from public, anon, authenticated;
-- (no policies on purpose: only the SECURITY DEFINER functions below read or write these tables)

-- ---- 2) helpers ----------------------------------------------------------------------------
-- one-way e-mail fingerprint: lower case, trimmed, "+tag" dropped, Gmail dots dropped
create or replace function public._trial_email_fingerprint(p_email text)
returns text language plpgsql immutable set search_path = '' as $$
-- one-trial-0186
declare e text := lower(btrim(coalesce(p_email, ''))); v_local text; v_domain text;
begin
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+$' then return null; end if;
  v_local := split_part(e, '@', 1); v_domain := split_part(e, '@', 2);
  if position('+' in v_local) > 1 then v_local := split_part(v_local, '+', 1); end if;
  if v_domain in ('gmail.com', 'googlemail.com') then
    v_local := replace(v_local, '.', ''); v_domain := 'gmail.com';
  end if;
  if v_local = '' then return null; end if;
  return encode(sha256(convert_to(v_local || '@' || v_domain, 'UTF8')), 'hex');
end $$;
revoke all on function public._trial_email_fingerprint(text) from public, anon, authenticated;

-- has this user / this e-mail had a free trial (in a studio other than p_except_org)?
create or replace function public._trial_used(p_uid uuid, p_email text, p_except_org uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  -- one-trial-0186
  select exists (select 1 from public.trial_grants g
                  where (p_except_org is null or g.org_id <> p_except_org)
                    and ((p_uid is not null and g.user_id = p_uid)
                      or (g.email_hash is not null and g.email_hash = public._trial_email_fingerprint(p_email))));
$$;
revoke all on function public._trial_used(uuid, text, uuid) from public, anon, authenticated;

-- ledger row the moment a studio's subscription becomes 'trial' (every path: self-serve trial,
-- payment-pending trial, checkout, HQ). Never blocks the subscription change.
create or replace function public.tg_trial_grant_0186()
returns trigger language plpgsql security definer set search_path = '' as $$
-- one-trial-0186
declare v_uid uuid; v_email text; v_master boolean;
begin
  if new.status is distinct from 'trial' then return null; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'trial' then return null; end if;
  begin
    select o.created_by, coalesce(o.is_sample_master, false) into v_uid, v_master
      from public.organizations o where o.id = new.org_id;
    if not found or v_master then return null; end if;
    if v_uid is not null then select u.email into v_email from auth.users u where u.id = v_uid; end if;
    insert into public.trial_grants(org_id, user_id, email_hash, source, started_at, recorded_how)
      values (new.org_id, v_uid, public._trial_email_fingerprint(v_email),
              left(coalesce(new.trial_source, 'trial'), 40), now(), 'trigger')
    on conflict (org_id) do nothing;
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.tg_trial_grant_0186() from public, anon, authenticated;
drop trigger if exists zz_trial_grant_0186 on public.studio_subscriptions;
create trigger zz_trial_grant_0186 after insert or update of status on public.studio_subscriptions
  for each row execute function public.tg_trial_grant_0186();

-- ---- 3) one-time fill: studios that already had a trial (insert only, new table) -------------
insert into public.trial_grants(org_id, user_id, email_hash, source, started_at, recorded_how)
select o.id, coalesce(o.created_by, a.actor), public._trial_email_fingerprint(u.email),
       left(coalesce(s.trial_source, case when o.trial_mode is not null then 'self_serve' else 'trial' end), 40),
       coalesce(a.at, o.created_at, now()), 'backfill'
  from public.organizations o
  left join public.studio_subscriptions s on s.org_id = o.id
  left join lateral (select x.actor, x.at from public.audit_log x
                      where x.org_id = o.id and x.action = 'subscription.trial_started'
                      order by x.at limit 1) a on true
  left join auth.users u on u.id = coalesce(o.created_by, a.actor)
 where not coalesce(o.is_sample_master, false)
   and (s.status = 'trial' or s.trial_source is not null
        or (o.trial_mode is not null and o.trial_ends_at is not null)
        or a.at is not null)
on conflict (org_id) do nothing;

-- ---- 4) one free trial per e-mail: the three entry points --------------------------------------
do $$ begin
  if to_regprocedure('public.start_self_serve_trial__pre0186(text,text,text,text)') is null then
    alter function public.start_self_serve_trial(text, text, text, text) rename to start_self_serve_trial__pre0186;
  end if;
  if to_regprocedure('public.my_pending_start_trial__pre0186()') is null then
    alter function public.my_pending_start_trial() rename to my_pending_start_trial__pre0186;
  end if;
  if to_regprocedure('public.my_start_trial__pre0186(text,text)') is null then
    alter function public.my_start_trial(text, text) rename to my_start_trial__pre0186;
  end if;
end $$;
revoke all on function public.start_self_serve_trial__pre0186(text, text, text, text) from public, anon, authenticated;
revoke all on function public.my_pending_start_trial__pre0186() from public, anon, authenticated;
revoke all on function public.my_start_trial__pre0186(text, text) from public, anon, authenticated;

create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: a person who already had a free trial (this user or this e-mail) gets no second one
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
revoke all on function public.start_self_serve_trial(text, text, text, text) from public, anon;
grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated, service_role;

-- the caller and the studio's creator: has either had a free trial in another studio?
create or replace function public._trial_used_for_org(p_org uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- one-trial-0186
declare v_uid uuid := auth.uid(); v_creator uuid;
begin
  if p_org is null then return false; end if;
  select o.created_by into v_creator from public.organizations o where o.id = p_org;
  return (v_uid is not null and public._trial_used(v_uid, (select u.email from auth.users u where u.id = v_uid), p_org))
      or (v_creator is not null and public._trial_used(v_creator, (select u.email from auth.users u where u.id = v_creator), p_org));
end $$;
revoke all on function public._trial_used_for_org(uuid) from public, anon, authenticated;

create or replace function public.my_pending_start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: no free trial for a studio whose owner already had one elsewhere
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is not null and v_org is not null and coalesce(public.is_admin(), false)
     and not exists (select 1 from public.studio_subscriptions s where s.org_id = v_org)
     and public._trial_used_for_org(v_org) then
    raise exception 'You have already used your free Helm trial. Choose a plan and complete payment to continue, or contact Helm support.'
      using errcode = '22023', hint = 'trial_used';
  end if;
  return public.my_pending_start_trial__pre0186();
end $$;
revoke all on function public.my_pending_start_trial() from public, anon;
grant execute on function public.my_pending_start_trial() to authenticated;

create or replace function public.my_start_trial(p_source text default 'bypass', p_plan text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: no free trial for a studio whose owner already had one elsewhere
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is not null and v_org is not null and coalesce(public.is_admin(), false)
     and not exists (select 1 from public.studio_subscriptions s where s.org_id = v_org)
     and public._trial_used_for_org(v_org) then
    raise exception 'You have already used your free Helm trial. Choose a plan and complete payment to continue, or contact Helm support.'
      using errcode = '22023', hint = 'trial_used';
  end if;
  return public.my_start_trial__pre0186(p_source, p_plan);
end $$;
revoke all on function public.my_start_trial(text, text) from public, anon;
grant execute on function public.my_start_trial(text, text) to authenticated;

-- ---- 5) trial extension (HQ only) ------------------------------------------------------------
-- null = this studio can get its one extension; otherwise the reason it cannot (for people)
create or replace function public._trial_extend_block(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- one-trial-0186
declare o public.organizations; s public.studio_subscriptions;
begin
  select * into o from public.organizations x where x.id = p_org;
  if o.id is null then return 'Unknown studio.'; end if;
  if coalesce(o.is_sample_master, false) then return 'The sample studio has no trial.'; end if;
  if exists (select 1 from public.trial_extensions e where e.org_id = p_org) then
    return 'This studio already had its one trial extension.'; end if;
  select * into s from public.studio_subscriptions x where x.org_id = p_org;
  if s.org_id is null then return 'This studio is not on a free trial.'; end if;
  if s.status = 'suspended' then return 'This studio is suspended. Reactivate it first.'; end if;
  if coalesce(s.trial_source, '') = 'checkout' or s.provider_subscription_id is not null then
    return 'This studio pays through online checkout. Its trial cannot be extended here.'; end if;
  if public._is_trial_org(p_org) then return null; end if;
  if s.status in ('past_due', 'cancelled') and s.current_period_end is null and s.trial_ends_at is not null
     and not exists (select 1 from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null) then
    return null;                                                    -- free trial ended (lapsed), never paid
  end if;
  return 'Only a studio on its free trial (or whose free trial ended unpaid) can be extended.';
end $$;
revoke all on function public._trial_extend_block(uuid) from public, anon, authenticated;

create or replace function public.hq_extend_trial(p_org uuid, p_days integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: one extension per studio, 1 to 7 days, reason required, Helm HQ only
declare
  v_reason text := btrim(regexp_replace(coalesce(p_reason, ''), '[[:space:]]+', ' ', 'g'));
  o public.organizations; s public.studio_subscriptions; v_block text; v_n integer;
  v_old timestamptz; v_new timestamptz; v_new_date date;
begin
  perform public._hq_wgate('hq.trial.extend', 'organizations', p_org::text,
    jsonb_build_object('days', p_days, 'reason', left(v_reason, 500)));
  if p_org is null then raise exception 'Unknown studio.' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 7 then
    raise exception 'An extension is 1 to 7 days.' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 then
    raise exception 'Write the reason for the extension (at least 5 characters).' using errcode = '22023'; end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason can be up to 500 characters.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:trial_extend:' || p_org::text, 0));
  select * into s from public.studio_subscriptions x where x.org_id = p_org for update;
  v_block := public._trial_extend_block(p_org);
  if v_block is not null then raise exception '%', v_block using errcode = '22023', hint = 'trial_extend_refused'; end if;
  select * into o from public.organizations x where x.id = p_org for update;

  if o.trial_ends_at is not null then
    v_old := o.trial_ends_at;
    v_new := greatest(o.trial_ends_at, now()) + make_interval(days => p_days);
    v_new_date := (v_new at time zone 'UTC')::date;
  else
    v_old := (s.trial_ends_at::timestamp at time zone 'UTC');
    v_new_date := greatest(s.trial_ends_at, current_date) + p_days;
    v_new := (v_new_date::timestamp at time zone 'UTC');
  end if;

  insert into public.trial_extensions(org_id, days, reason, previous_status, previous_ends_at, new_ends_at,
                                      granted_by, granted_by_email, granted_at)
    select p_org, p_days, v_reason, s.status, v_old, v_new, auth.uid(), u.email, now()
      from (select 1) one left join auth.users u on u.id = auth.uid()
  on conflict (org_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'This studio already had its one trial extension.' using errcode = '22023', hint = 'trial_extend_refused'; end if;

  update public.studio_subscriptions
     set status = 'trial', trial_ends_at = v_new_date, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org;
  if o.trial_ends_at is not null then
    update public.organizations set trial_ends_at = v_new where id = p_org;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, 'Helm', 'subscription.trial_extended', 'organizations', p_org::text,
            jsonb_build_object('days', p_days, 'previous_ends_at', v_old, 'new_ends_at', v_new,
                               'previous_status', s.status, 'by', 'Helm'), p_org, now());
  return jsonb_build_object('org_id', p_org, 'days', p_days, 'status', 'trial',
                            'previous_ends_at', v_old, 'new_ends_at', v_new, 'trial_ends_on', v_new_date);
end $$;
revoke all on function public.hq_extend_trial(uuid, integer, text) from public, anon;
grant execute on function public.hq_extend_trial(uuid, integer, text) to authenticated;

create or replace function public.hq_trial_info(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186: trial state + the one extension, for the HQ studio page
declare o public.organizations; s public.studio_subscriptions; e public.trial_extensions; v_block text;
begin
  perform public._hq_gate('hq_trial_info', p_org::text);
  select * into o from public.organizations x where x.id = p_org;
  if o.id is null then raise exception 'Unknown studio.' using errcode = '22023'; end if;
  select * into s from public.studio_subscriptions x where x.org_id = p_org;
  select * into e from public.trial_extensions x where x.org_id = p_org;
  v_block := public._trial_extend_block(p_org);
  return jsonb_build_object(
    'org_id', p_org, 'status', s.status, 'trial_source', s.trial_source,
    'is_trial', public._is_trial_org(p_org), 'trial_mode', o.trial_mode,
    'trial_ends_at', coalesce(o.trial_ends_at, (s.trial_ends_at::timestamp at time zone 'UTC')),
    'locked', public._trial_locked(p_org),
    'had_trial', exists (select 1 from public.trial_grants g where g.org_id = p_org),
    'can_extend', v_block is null, 'why_not', v_block, 'max_days', 7,
    'extension', case when e.org_id is null then null else jsonb_build_object(
      'days', e.days, 'reason', e.reason, 'previous_status', e.previous_status,
      'previous_ends_at', e.previous_ends_at, 'new_ends_at', e.new_ends_at,
      'granted_at', e.granted_at, 'granted_by_email', e.granted_by_email) end);
end $$;
revoke all on function public.hq_trial_info(uuid) from public, anon;
grant execute on function public.hq_trial_info(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 trial_grants: table, RLS on, no app access', to_regclass('public.trial_grants') is not null
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_grants')), false)
     and not has_table_privilege('authenticated', 'public.trial_grants', 'select')
     and not has_table_privilege('anon', 'public.trial_grants', 'select')),
  ('02 trial_extensions: table, RLS on, no app access, one row per studio', to_regclass('public.trial_extensions') is not null
     and coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.trial_extensions')), false)
     and not has_table_privilege('authenticated', 'public.trial_extensions', 'select')
     and exists (select 1 from pg_constraint where conrelid = 'public.trial_extensions'::regclass and contype = 'p')),
  ('03 start_self_serve_trial wrapped (old body kept, not callable by the app)',
     position('one-trial-0186' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.start_self_serve_trial(text,text,text,text)')), '')) > 0
     and to_regprocedure('public.start_self_serve_trial__pre0186(text,text,text,text)') is not null
     and not has_function_privilege('authenticated', 'public.start_self_serve_trial__pre0186(text,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')),
  ('04 my_pending_start_trial wrapped', position('one-trial-0186' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_pending_start_trial()')), '')) > 0
     and to_regprocedure('public.my_pending_start_trial__pre0186()') is not null
     and not has_function_privilege('authenticated', 'public.my_pending_start_trial__pre0186()', 'execute')
     and has_function_privilege('authenticated', 'public.my_pending_start_trial()', 'execute')),
  ('05 my_start_trial wrapped', position('one-trial-0186' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_start_trial(text,text)')), '')) > 0
     and to_regprocedure('public.my_start_trial__pre0186(text,text)') is not null
     and not has_function_privilege('authenticated', 'public.my_start_trial__pre0186(text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.my_start_trial(text,text)', 'execute')),
  ('06 ledger trigger on studio_subscriptions', exists (select 1 from pg_trigger where tgrelid = 'public.studio_subscriptions'::regclass
     and tgname = 'zz_trial_grant_0186' and not tgisinternal)),
  ('07 every studio on a trial now has a ledger row', not exists (select 1 from public.studio_subscriptions s
     join public.organizations o on o.id = s.org_id
     where s.status = 'trial' and not coalesce(o.is_sample_master, false)
       and not exists (select 1 from public.trial_grants g where g.org_id = s.org_id))),
  ('08 ledger keeps fingerprints only (no e-mail addresses)', not exists (select 1 from public.trial_grants
     where email_hash is not null and email_hash !~ '^[0-9a-f]{64}$')),
  ('09 HQ functions: signed-in callers only (the HQ check is inside)',
     has_function_privilege('authenticated', 'public.hq_extend_trial(uuid,integer,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_extend_trial(uuid,integer,text)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_trial_info(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.hq_trial_info(uuid)', 'execute')),
  ('10 internal helpers not callable by the app',
     not has_function_privilege('authenticated', 'public._trial_used(uuid,text,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._trial_used_for_org(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._trial_extend_block(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._trial_email_fingerprint(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.tg_trial_grant_0186()', 'execute')
     and not has_function_privilege('anon', 'public._trial_used(uuid,text,uuid)', 'execute')),
  ('11 e-mail fingerprint ignores case, +tag and Gmail dots',
     public._trial_email_fingerprint(' A.B+x@GMail.com ') = public._trial_email_fingerprint('ab@gmail.com')
     and public._trial_email_fingerprint('a.b@example.com') <> public._trial_email_fingerprint('ab@example.com')),
  ('12 the sample studio is never in the ledger', not exists (select 1 from public.trial_grants g
     join public.organizations o on o.id = g.org_id where o.is_sample_master))
) v(item, ok) order by item;
