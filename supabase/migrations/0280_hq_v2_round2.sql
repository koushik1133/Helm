-- 0280_hq_v2_round2.sql - CANONICAL forward-only. Not applied anywhere yet (R42 PR: staging first when the owner says go).
-- REQUIRES 0045 + 0056 (helm_plans, helm_plan_prices, description / features / sort_order) and 0277 (_hq27_require,
--          _hq27_session_id, hq_staff_sessions, hq_session_revocations, helm_hq_settings).
--
-- In plain words (owner, r28 HQ v2 round 2):
--   1  PUBLIC PRICES FROM THE DATABASE. public_pricing_plans(): the plans HQ marks "visible" (helm_plans.active) with
--      name, description, features and the monthly / yearly price per currency - read-only, for the public pricing
--      page (anyone may call it, signed in or not). Never Razorpay ids, never which studio is on which plan.
--   2  MY HQ SESSION. hq_my_session(): the signed-in HQ person's own session - short id, started, last seen, and when
--      it ends (the earlier of: started + longest sign-in hours, last HQ use + idle minutes). Read-only.
--   3  SESSION IDS IN THE HQ TEAM LIST. _hq27_sessions_of (0277) re-issued with the same answer plus 'sid' (first 8
--      characters of the session id) - nothing else changes.
--   4  STUDIO CREDITS (e.g. referral free months). NEW private table hq_studio_credits (append-only; a credit is
--      cancelled by marking voided_at once - never deleted, never rewritten: triggers refuse delete / truncate / edits). hq_studio_credits(org) lists them (studios.read);
--      hq_grant_studio_credit(org, kind, months, reason) adds one (billing.write + a fresh two-step code, logged as
--      hq.credit.grant). A credit is a RECORD for HQ - it does not change a plan or an invoice by itself.
-- Additive + idempotent: one new table (RLS on, no API privilege; a KEPT table for trial retention 0184), new functions,
-- one read function re-issued with a superset answer. No existing row changed or deleted. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): revoke execute on the four new functions; re-run the _hq27_sessions_of block of
--   0277. The table can stay (unused).

do $$ begin
  if to_regclass('public.helm_plans') is null or to_regclass('public.helm_plan_prices') is null then raise exception 'STOP 0280: 0045 (helm_plans) is not applied'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regclass('public.hq_staff_sessions') is null then
    raise exception 'STOP 0280: 0277 (HQ staff roles) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_plans' and column_name = 'features') then
    raise exception 'STOP 0280: 0056 (plan description / features) is not applied'; end if;
end $$;

-- ---- 1) public pricing (read-only) ---------------------------------------------------------------------------------
create or replace function public.public_pricing_plans()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r28-hq-v2-0280
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', hp.code, 'name', hp.name, 'description', hp.description, 'features', coalesce(hp.features, '[]'::jsonb),
           'sort_order', hp.sort_order,
           'prices', coalesce((select jsonb_agg(jsonb_build_object('currency', pp.currency, 'monthly', pp.price_monthly, 'yearly', pp.price_yearly) order by pp.currency)
                                 from public.helm_plan_prices pp where pp.plan_id = hp.id), '[]'::jsonb)
                     || case when not exists (select 1 from public.helm_plan_prices pp where pp.plan_id = hp.id and pp.currency = hp.currency)
                             then jsonb_build_array(jsonb_build_object('currency', hp.currency, 'monthly', hp.price_monthly, 'yearly', null)) else '[]'::jsonb end)
         order by hp.sort_order, hp.code), '[]'::jsonb)
    from public.helm_plans hp
   where hp.active;
$$;

-- ---- 2) my HQ session -----------------------------------------------------------------------------------------------
create or replace function public.hq_my_session()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r28-hq-v2-0280
  v_sid uuid; v_start timestamptz; v_seen timestamptz; v_idle int; v_max int; h public.hq_staff_sessions;
begin
  perform public._hq27_require('self', false);
  v_sid := public._hq27_session_id();
  select coalesce(s.hq_idle_minutes, 30), coalesce(s.hq_max_hours, 12) into v_idle, v_max from public.helm_hq_settings s where s.id;
  v_idle := coalesce(v_idle, 30); v_max := coalesce(v_max, 12);
  if v_sid is not null then select * into h from public.hq_staff_sessions x where x.session_id = v_sid; end if;
  v_start := h.started_at; v_seen := coalesce(h.last_seen_at, now());
  if v_sid is not null and to_regclass('auth.sessions') is not null then
    begin execute 'select s.created_at from auth.sessions s where s.id = $1' into v_start using v_sid;
    exception when others then null; end;
  end if;
  v_start := coalesce(v_start, h.started_at, now());
  return jsonb_build_object('sid', case when v_sid is null then null else left(v_sid::text, 8) end,
    'started_at', v_start, 'last_seen_at', v_seen, 'idle_minutes', v_idle, 'max_hours', v_max,
    'expires_at', least(v_start + make_interval(hours => v_max), v_seen + make_interval(mins => v_idle)),
    'hard_end_at', v_start + make_interval(hours => v_max));
end $$;

-- ---- 3) sessions of an HQ person: same answer as 0277 + 'sid' -----------------------------------------------------------
create or replace function public._hq27_sessions_of(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb := '[]'::jsonb;
begin
  -- r28-hq-v2-0280 (0277 body + 'sid')
  if p_user is null then return '[]'::jsonb; end if;
  if to_regclass('auth.sessions') is not null then
    begin
      execute $q$
        select coalesce(jsonb_agg(z.j order by z.seen desc), '[]'::jsonb) from (
          select jsonb_build_object('sid', left(s.id::text, 8), 'since', s.created_at, 'seen', coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at),
                   'device', left(coalesce(to_jsonb(s) ->> 'user_agent', h.user_agent, ''), 200),
                   'ip', coalesce(public._hq27_ip_short(host(nullif(to_jsonb(s) ->> 'ip', '')::inet)), h.ip_short),
                   'hq_last', h.last_seen_at, 'current', s.id = public._hq27_session_id()) as j,
                 coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at) as seen
            from auth.sessions s
            left join public.hq_staff_sessions h on h.session_id = s.id
           where s.user_id = $1
             and not exists (select 1 from public.hq_session_revocations v where v.session_id = s.id)
             and (nullif(to_jsonb(s) ->> 'not_after', '') is null or (to_jsonb(s) ->> 'not_after')::timestamptz > now())
             and coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at) > now() - interval '7 days'
           order by 2 desc limit 10) z$q$ into r using p_user;
    exception when others then r := null;
    end;
  end if;
  if r is null or r = '[]'::jsonb then
    select coalesce(jsonb_agg(jsonb_build_object('sid', left(h.session_id::text, 8), 'since', h.started_at, 'seen', h.last_seen_at, 'device', coalesce(h.user_agent, ''),
             'ip', h.ip_short, 'hq_last', h.last_seen_at, 'current', h.session_id = public._hq27_session_id()) order by h.last_seen_at desc), '[]'::jsonb)
      into r from (select * from public.hq_staff_sessions x where x.user_id = p_user
                     and not exists (select 1 from public.hq_session_revocations v where v.session_id = x.session_id)
                     and x.last_seen_at > now() - interval '7 days' order by x.last_seen_at desc limit 10) h;
  end if;
  return coalesce(r, '[]'::jsonb);
end $$;

-- ---- 4) studio credits (records only; append-only) -------------------------------------------------------------------------
create table if not exists public.hq_studio_credits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete restrict,
  kind        text not null check (kind in ('referral', 'goodwill', 'promo')),
  months      integer not null check (months between 1 and 12),
  reason      text not null check (char_length(btrim(reason)) between 5 and 500),
  granted_by  text,
  granted_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   text
);
create index if not exists hq_studio_credits_org_idx on public.hq_studio_credits (org_id, granted_at desc);
alter table public.hq_studio_credits enable row level security;
do $$ begin
  revoke all on table public.hq_studio_credits from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.hq_studio_credits from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.hq_studio_credits from authenticated; end if;
end $$;
create or replace function public.tg_a280_credits_no_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r28-hq-v2-0280: a credit is never deleted (mark voided_at instead)
  raise exception 'hq_studio_credits rows are never deleted - mark voided_at instead' using errcode = '42501';
end $$;
drop trigger if exists a280_credits_no_delete on public.hq_studio_credits;
create trigger a280_credits_no_delete before delete on public.hq_studio_credits for each row execute function public.tg_a280_credits_no_delete();
drop trigger if exists a280_credits_no_truncate on public.hq_studio_credits;
create trigger a280_credits_no_truncate before truncate on public.hq_studio_credits for each statement execute function public.tg_a280_credits_no_delete();
-- r42: a credit row is never rewritten - only voided_at / voided_by may be set, once (null -> a time)
create or replace function public.tg_a280_credits_void_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r42-hq-v2-0280
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.kind is distinct from old.kind
     or new.months is distinct from old.months or new.reason is distinct from old.reason or new.granted_by is distinct from old.granted_by
     or new.granted_at is distinct from old.granted_at or old.voided_at is not null or new.voided_at is null then
    raise exception 'hq_studio_credits rows are never changed - only voided once' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists a280_credits_void_only on public.hq_studio_credits;
create trigger a280_credits_void_only before update on public.hq_studio_credits for each row execute function public.tg_a280_credits_void_only();

-- trial retention (0184): a credit is an HQ billing record - KEPT like the other billing ledgers, never purged
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''hq_studio_credits''' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, '''audit_log''', ''))) / length('''audit_log''') <> 1 then
    raise exception 'STOP 0280: _tr184_keep_tables() has an unexpected body - nothing changed'; end if;
  execute replace(v_def, '''audit_log''', '''audit_log'', ''hq_studio_credits''');
end $$;

create or replace function public.hq_studio_credits(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r28-hq-v2-0280
  perform public._hq27_require('studios.read', false);
  return jsonb_build_object('credits', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'months', c.months, 'reason', c.reason,
            'granted_by', c.granted_by, 'granted_at', c.granted_at, 'voided_at', c.voided_at) order by c.granted_at desc)
            from public.hq_studio_credits c where c.org_id = p_org), '[]'::jsonb),
    'months_total', coalesce((select sum(c.months) from public.hq_studio_credits c where c.org_id = p_org and c.voided_at is null), 0));
end $$;

create or replace function public.hq_grant_studio_credit(p_org uuid, p_kind text, p_months integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r28-hq-v2-0280
  v_kind text := lower(btrim(coalesce(p_kind, ''))); v_reason text := btrim(coalesce(p_reason, '')); v_id uuid; v_email text;
begin
  perform public._hq27_require('billing.write', true);   -- role + two-step + a fresh code for this change
  if v_kind not in ('referral', 'goodwill', 'promo') then raise exception 'kind must be referral, goodwill or promo' using errcode = '22023'; end if;
  if p_months is null or p_months < 1 or p_months > 12 then raise exception 'a credit is 1 to 12 months' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then raise exception 'give a reason (5-500 characters)' using errcode = '22023'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'studio not found' using errcode = '22023'; end if;
  select u.email into v_email from auth.users u where u.id = auth.uid();
  insert into public.hq_studio_credits(org_id, kind, months, reason, granted_by) values (p_org, v_kind, p_months, v_reason, v_email) returning id into v_id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), v_email, 'hq.credit.grant', 'organization', p_org::text, jsonb_build_object('kind', v_kind, 'months', p_months, 'credit_id', v_id), null, now());
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---- grants -------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  revoke all on function public.tg_a280_credits_no_delete() from public;
  revoke all on function public.tg_a280_credits_void_only() from public;
  revoke all on function public._hq27_sessions_of(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._hq27_sessions_of(uuid) from anon;
    revoke all on function public.tg_a280_credits_no_delete() from anon;
    revoke all on function public.tg_a280_credits_void_only() from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._hq27_sessions_of(uuid) from authenticated;
    revoke all on function public.tg_a280_credits_no_delete() from authenticated;
    revoke all on function public.tg_a280_credits_void_only() from authenticated;
  end if;
  -- signed-in only (each checks HQ staff + permission inside); never anon
  foreach f in array array['public.hq_my_session()', 'public.hq_studio_credits(uuid)', 'public.hq_grant_studio_credit(uuid, text, integer, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the public pricing page (signed out too): read-only plan names, texts and prices
  revoke all on function public.public_pricing_plans() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then grant execute on function public.public_pricing_plans() to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.public_pricing_plans() to authenticated; end if;
end $$;

notify pgrst, 'reload schema';
