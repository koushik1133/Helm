-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor            (v8, 2026-10-06)
--   PART A  Helm HQ (private platform-owner dashboard) ..... 0029
--   PART B  Password rule = Supabase policy (+symbol) ...... 0030
--   PART C  User manual in a private storage bucket ........ 0031
-- BOTH production and staging need this (both are up to date through 0028 / v7).
-- SAFE TO RE-RUN: idempotent; changes no existing rows (0029 only adds the two Helm
--   operator emails to a new private list). If anything fails, the whole run rolls back.
-- USE: SQL Editor → paste ALL → Run → the last table must show every row "ok".
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: not a Helm database'; end if;
  if to_regproc('public._password_ok') is null or to_regproc('public._admin_create_user_core') is null
    then raise exception 'STOP: 0028 not installed — run APPLY-PENDING v7 first'; end if;
  raise notice 'Preflight OK — applying 0029 + 0030 + 0031…';
end $$;

-- ═══════════════════ PART A — Helm HQ (0029) ═══════════════════
-- ============================================================================
-- 0029_platform_admin.sql — Helm HQ: private platform-owner dashboard (read-only).
--
-- Who: ONLY Helm's own operators, listed by e-mail in public.platform_admins
-- (seeded: admin@helm.events, security@helm.events). Studio users — studio
-- admins included — and signed-out visitors get nothing.
--
-- The real control is here, in the database:
--   * public.platform_admins: RLS on, NO grants to anon/authenticated. Only the
--     SECURITY DEFINER functions below (owned by the migration role) read it.
--   * public.is_platform_admin(): true only when
--       - the caller is signed in (auth.uid()),
--       - the auth.users row's e-mail is CONFIRMED (email_confirmed_at not null),
--       - lower(that e-mail) is in platform_admins (the e-mail is read from
--         auth.users, never trusted from the token),
--       - and, when the account has a VERIFIED MFA factor, the token is aal2.
--     Policy: once an operator enrolls MFA every HQ call needs a two-step
--     session. To REQUIRE MFA for every operator even before enrolment, set
--     platform_admins.require_mfa = true for that row (then aal2 is mandatory and
--     an un-enrolled account is refused). Recommended after both owners enroll.
--   * hq_* RPCs: SECURITY DEFINER, search_path = '', each starts with the
--     is_platform_admin() check and raises 42501 'not authorized' otherwise.
--     Granted to authenticated only (anon/public revoked). All read-only apart
--     from one audit_log row per call (action 'hq.view').
--
-- Platform-admin accounts must NOT also be studio members (no profiles.org_id):
-- the audit_log org trigger would otherwise file the 'hq.view' rows under that
-- studio. They are written with org_id NULL (visible to nobody through RLS).
--
-- Drift-safe: optional objects (chat_messages, storage.objects, auth.mfa_factors,
-- auth.audit_log_entries) are reached with to_regclass + dynamic SQL, so a
-- database missing one still works. No non-canonical helper is used.
-- Additive + idempotent. The ONLY data change is inserting the two allowlisted
-- e-mails (on conflict do nothing).
-- ============================================================================

-- ---- 1) allowlist -----------------------------------------------------------
create table if not exists public.platform_admins (
  email       text primary key check (email = lower(email) and position('@' in email) > 1),
  added_at    timestamptz not null default now(),
  added_by    text,
  require_mfa boolean not null default false
);
alter table public.platform_admins add column if not exists require_mfa boolean not null default false;
alter table public.platform_admins enable row level security;
revoke all on table public.platform_admins from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.platform_admins from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.platform_admins from authenticated'; end if;
end $$;
-- (no policies on purpose: with RLS on and no grants, only definer code reads it)

insert into public.platform_admins(email, added_by) values
  ('admin@helm.events', 'migration 0029'),
  ('security@helm.events', 'migration 0029')
on conflict (email) do nothing;

-- ---- 2) helpers ---------------------------------------------------------------
-- safe numeric from jsonb text (pricing.total may be missing / malformed)
create or replace function public._hq_num(p text)
returns numeric language sql immutable set search_path = '' as $$
  select case when p ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then p::numeric else 0 end
$$;
revoke all on function public._hq_num(text) from public;

create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text; v_confirmed timestamptz; v_req boolean;
  v_has_factor boolean := false;
  v_aal text := coalesce(auth.jwt() ->> 'aal', '');
begin
  if v_uid is null then return false; end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return false; end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then return false; end if;
  select pa.require_mfa into v_req from public.platform_admins pa where pa.email = v_email;
  if not found then return false; end if;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')'
      into v_has_factor using v_uid;
  end if;
  if (v_has_factor or coalesce(v_req, false)) and v_aal <> 'aal2' then return false; end if;
  return true;
end $$;
revoke all on function public.is_platform_admin() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.is_platform_admin() from anon'; end if;
end $$;
grant execute on function public.is_platform_admin() to authenticated;

-- internal: gate + audit row. Not callable by clients.
create or replace function public._hq_gate(p_entity text, p_entity_id text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', p_entity, p_entity_id, null, now()
      from auth.users u where u.id = auth.uid();
end $$;
revoke all on function public._hq_gate(text, text) from public;

-- per-studio rollup used by hq_studios / hq_overview / hq_studio_detail
create or replace function public._hq_studio_rows()
returns table(org_id uuid, name text, slug text, plan text, created_at timestamptz, owner_email text,
              users_count bigint, events_count bigint, confirmed_count bigint,
              revenue numeric, paid numeric, last_activity timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.slug, o.plan, o.created_at,
         coalesce(cu.email, (select p.email from public.profiles p where p.org_id = o.id and p.role = 'admin'
                              order by p.created_at limit 1)),
         (select count(*) from public.profiles p where p.org_id = o.id),
         (select count(*) from public.quotes q where q.org_id = o.id),
         (select count(*) from public.quotes q where q.org_id = o.id and q.status = 'confirmed'),
         coalesce((select sum(public._hq_num(q.pricing ->> 'total')) from public.quotes q
                    where q.org_id = o.id and q.status = 'confirmed'), 0),
         coalesce((select sum(qp.amount) from public.quote_payments qp
                    where qp.org_id = o.id and qp.status = 'paid' and not coalesce(qp.simulated, false)), 0),
         greatest(o.created_at,
                  (select max(q.updated_at) from public.quotes q where q.org_id = o.id),
                  (select max(a.at) from public.audit_log a where a.org_id = o.id),
                  (select max(u.last_sign_in_at) from public.profiles p join auth.users u on u.id = p.id where p.org_id = o.id))
    from public.organizations o
    left join auth.users cu on cu.id = o.created_by
$$;
revoke all on function public._hq_studio_rows() from public;

-- ---- 3) hq_overview -------------------------------------------------------------
create or replace function public.hq_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r jsonb := '{}'::jsonb; v jsonb; n bigint; m bigint;
  today date := current_date;
begin
  perform public._hq_gate('hq_overview');

  r := r || jsonb_build_object(
    'generated_at', now(),
    'studios', jsonb_build_object(
      'total',  (select count(*) from public.organizations),
      'new_7d', (select count(*) from public.organizations where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from public.organizations where created_at >= now() - interval '30 days')),
    'users', jsonb_build_object(
      'total',  (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from auth.users where created_at >= now() - interval '30 days'),
      'active_7d', (select count(*) from auth.users where last_sign_in_at >= now() - interval '7 days'),
      'active_30d',(select count(*) from auth.users where last_sign_in_at >= now() - interval '30 days')),
    'events', jsonb_build_object(
      'total', (select count(*) from public.quotes),
      'this_month', (select count(*) from public.quotes where created_at >= date_trunc('month', now())),
      'upcoming_30d', (select count(*) from public.quotes where status <> 'cancelled'
                         and event_date between today and today + 30),
      'confirmed', (select count(*) from public.quotes where status = 'confirmed')),
    'money', jsonb_build_object(
      'revenue_booked', coalesce((select sum(public._hq_num(pricing ->> 'total')) from public.quotes where status = 'confirmed'), 0),
      'received_all',   coalesce((select sum(amount) from public.quote_payments where status = 'paid' and not coalesce(simulated, false)), 0),
      'received_30d',   coalesce((select sum(amount) from public.quote_payments where status = 'paid' and not coalesce(simulated, false)
                                    and coalesce(paid_at, created_at) >= now() - interval '30 days'), 0),
      'outstanding',    coalesce((select sum(greatest(public._hq_num(q.pricing ->> 'total') - coalesce(
                                    (select sum(qp.amount) from public.quote_payments qp where qp.quote_id = q.id
                                       and qp.status = 'paid' and not coalesce(qp.simulated, false)), 0), 0))
                                  from public.quotes q where q.status = 'confirmed'), 0),
      'due_14d_count',  (select count(*) from public.payment_milestones where status not in ('paid','waived')
                           and due_date between today and today + 14),
      'due_14d_amount', coalesce((select sum(amount) from public.payment_milestones where status not in ('paid','waived')
                           and due_date between today and today + 14), 0),
      'overdue_count',  (select count(*) from public.payment_milestones where status not in ('paid','waived') and due_date < today),
      'overdue_amount', coalesce((select sum(amount) from public.payment_milestones where status not in ('paid','waived') and due_date < today), 0)));

  -- sign-ups per day, last 30 days (zero-filled)
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'studios', coalesce(s.c, 0), 'users', coalesce(u.c, 0)) order by d), '[]'::jsonb)
    into v
    from generate_series(today - 29, today, interval '1 day') d
    left join (select created_at::date k, count(*) c from public.organizations group by 1) s on s.k = d::date
    left join (select created_at::date k, count(*) c from auth.users group by 1) u on u.k = d::date;
  r := r || jsonb_build_object('signups_30d', v);

  select coalesce(jsonb_agg(x order by (x ->> 'revenue')::numeric desc, (x ->> 'events')::int desc), '[]'::jsonb) into v
    from (select jsonb_build_object('org_id', s.org_id, 'name', s.name, 'events', s.events_count,
                                    'revenue', s.revenue, 'paid', s.paid) x
            from public._hq_studio_rows() s order by s.revenue desc, s.events_count desc limit 10) t;
  r := r || jsonb_build_object('top_studios', v);

  select coalesce(jsonb_agg(jsonb_build_object('org_id', s.org_id, 'name', s.name, 'owner_email', s.owner_email,
                                               'last_activity', s.last_activity) order by s.last_activity nulls first), '[]'::jsonb)
    into v from public._hq_studio_rows() s where s.last_activity < now() - interval '30 days';
  r := r || jsonb_build_object('churn_risk', v);

  -- MFA adoption
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select count(distinct user_id) from auth.mfa_factors where status::text = ''verified''' into n;
    select count(*) into m from auth.users;
    r := r || jsonb_build_object('mfa', jsonb_build_object('users_with_mfa', n, 'users_total', m,
             'pct', case when m > 0 then round(100.0 * n / m, 1) else 0 end));
  end if;

  -- storage per bucket
  if to_regclass('storage.objects') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'objects', c, 'bytes', b) order by b desc), '[]'::jsonb)
                 from (select bucket_id, count(*) c,
                              coalesce(sum(case when (metadata ->> 'size') ~ '^[0-9]+$' then (metadata ->> 'size')::bigint end), 0) b
                         from storage.objects group by bucket_id) t$q$ into v;
    r := r || jsonb_build_object('storage', v);
  end if;

  if to_regclass('public.chat_messages') is not null then
    execute 'select count(*) from public.chat_messages where created_at >= now() - interval ''7 days''' into n;
    r := r || jsonb_build_object('chat_messages_7d', n);
  end if;

  -- GoTrue's own audit trail, when the database exposes it (Supabase does).
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute $q$select count(*) from auth.audit_log_entries
                  where created_at >= now() - interval '7 days'
                    and payload ->> 'action' in ('login','user_signedin','token_refreshed')$q$ into n;
      r := r || jsonb_build_object('auth_logins_7d', n);
    exception when others then null;
    end;
  end if;

  return r;
end $$;

-- ---- 4) hq_studios ----------------------------------------------------------------
create or replace function public.hq_studios(p_search text default null, p_limit int default 25, p_offset int default 0)
returns table(org_id uuid, name text, slug text, plan text, created_at timestamptz, owner_email text,
              users_count bigint, events_count bigint, confirmed_count bigint,
              revenue numeric, paid numeric, last_activity timestamptz, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare s text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public._hq_gate('hq_studios', left(s, 80));
  return query
    select r.org_id, r.name, r.slug, r.plan, r.created_at, r.owner_email, r.users_count, r.events_count,
           r.confirmed_count, r.revenue, r.paid, r.last_activity, count(*) over ()
      from public._hq_studio_rows() r
     where s is null
        or strpos(lower(r.name), lower(s)) > 0
        or strpos(lower(coalesce(r.slug, '')), lower(s)) > 0
        or strpos(lower(coalesce(r.owner_email, '')), lower(s)) > 0
     order by r.created_at desc, r.org_id
     limit least(greatest(coalesce(p_limit, 25), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---- 5) hq_studio_detail ----------------------------------------------------------
create or replace function public.hq_studio_detail(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public._hq_gate('hq_studio_detail', p_org::text);
  select to_jsonb(s) into r from public._hq_studio_rows() s where s.org_id = p_org;
  if r is null then return null; end if;
  r := r || jsonb_build_object(
    'currency', (select currency from public.organizations where id = p_org),
    'location', (select location from public.organizations where id = p_org),
    'members', coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'role', p.role,
                    'created_at', p.created_at, 'last_sign_in_at', u.last_sign_in_at) order by p.created_at)
                  from public.profiles p left join auth.users u on u.id = p.id where p.org_id = p_org), '[]'::jsonb),
    'recent_events', coalesce((select jsonb_agg(x) from (
                    select jsonb_build_object('code', q.code, 'title', q.title, 'status', q.status,
                       'event_date', q.event_date, 'total', public._hq_num(q.pricing ->> 'total'), 'created_at', q.created_at) x
                      from public.quotes q where q.org_id = p_org order by q.created_at desc limit 15) t), '[]'::jsonb),
    'open_milestones', coalesce((select jsonb_agg(x) from (
                    select jsonb_build_object('label', m.label, 'due_date', m.due_date, 'amount', m.amount, 'status', m.status) x
                      from public.payment_milestones m where m.org_id = p_org and m.status not in ('paid','waived')
                     order by m.due_date nulls last limit 15) t), '[]'::jsonb));
  return r;
end $$;

-- ---- 6) hq_users ----------------------------------------------------------------------
create or replace function public.hq_users(p_search text default null, p_limit int default 25, p_offset int default 0)
returns table(user_id uuid, email text, studio text, org_id uuid, role text, created_at timestamptz,
              last_sign_in_at timestamptz, email_confirmed boolean, mfa_enabled boolean, total_count bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
declare s text := nullif(btrim(coalesce(p_search, '')), ''); has_mfa boolean := to_regclass('auth.mfa_factors') is not null;
begin
  perform public._hq_gate('hq_users', left(s, 80));
  return query execute format($q$
    select u.id, u.email::text, o.name, p.org_id, p.role, u.created_at, u.last_sign_in_at,
           u.email_confirmed_at is not null, %s, count(*) over ()
      from auth.users u
      left join public.profiles p on p.id = u.id
      left join public.organizations o on o.id = p.org_id
     where $1 is null or strpos(lower(coalesce(u.email, '')), lower($1)) > 0 or strpos(lower(coalesce(o.name, '')), lower($1)) > 0
     order by u.created_at desc, u.id
     limit $2 offset $3$q$,
    case when has_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = ''verified'')'
         else 'false' end)
  using s, least(greatest(coalesce(p_limit, 25), 1), 200), greatest(coalesce(p_offset, 0), 0);
end $$;

-- ---- 7) hq_payments ---------------------------------------------------------------------
create or replace function public.hq_payments(p_from date default null, p_to date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare f date := coalesce(p_from, current_date - 30); t date := coalesce(p_to, current_date);
begin
  perform public._hq_gate('hq_payments', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object(
    'from', f, 'to', t,
    'payments', coalesce((select jsonb_agg(x) from (
       select jsonb_build_object('paid_at', coalesce(qp.paid_at, qp.created_at), 'amount', qp.amount, 'currency', qp.currency,
                'method', coalesce(qp.method, qp.provider), 'status', qp.status, 'receipt_no', qp.receipt_no,
                'simulated', coalesce(qp.simulated, false), 'studio', o.name, 'org_id', qp.org_id, 'event', q.code) x
         from public.quote_payments qp
         left join public.quotes q on q.id = qp.quote_id
         left join public.organizations o on o.id = qp.org_id
        where coalesce(qp.paid_at, qp.created_at) >= f and coalesce(qp.paid_at, qp.created_at) < t + 1
        order by coalesce(qp.paid_at, qp.created_at) desc limit 500) z), '[]'::jsonb),
    'milestones', coalesce((select jsonb_agg(x) from (
       select jsonb_build_object('due_date', m.due_date, 'amount', m.amount, 'status', m.status, 'label', m.label,
                'overdue', m.due_date < current_date, 'studio', o.name, 'org_id', m.org_id, 'event', q.code) x
         from public.payment_milestones m
         left join public.quotes q on q.id = m.quote_id
         left join public.organizations o on o.id = m.org_id
        where m.status not in ('paid','waived') and m.due_date is not null and m.due_date <= current_date + 14
        order by m.due_date limit 500) z), '[]'::jsonb));
end $$;

-- ---- 8) grants: authenticated only ---------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array['public.hq_overview()', 'public.hq_studios(text,int,int)', 'public.hq_studio_detail(uuid)',
                            'public.hq_users(text,int,int)', 'public.hq_payments(date,date)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  foreach fn in array array['public._hq_gate(text,text)', 'public._hq_studio_rows()', 'public._hq_num(text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
  end loop;
end $$;

-- ═══════════════════ PART B — Password rule (0030) ═══════════════════
-- ============================================================================
-- 0030_password_rule_symbols.sql — CANONICAL forward-only.
--
-- What this changes, in plain words:
--   The owner set Supabase Auth -> Password requirements to "Lowercase, uppercase
--   letters, digits and symbols", minimum 12. Supabase enforces that on sign-up,
--   reset and change-password, but passwords set by a studio admin through
--   admin_create_user (Control Center) go straight into auth.users and never pass
--   through Supabase's check. This migration makes the database rule identical:
--     * at least 12 characters
--     * at least one lowercase letter, one uppercase letter, one digit
--     * at least one symbol from Supabase's set:  !@#$%^&*()_+-=[]{};'\:"|<>?,./`~
--   Temp (one-time) passwords issued by admin_create_user_temp now always contain
--   all four kinds, and the error message says exactly what is needed.
--
-- Additive + idempotent: only CREATE OR REPLACE of three functions. No table,
-- column or row is touched. admin_create_user keeps the exact 0028 body (and its
-- 'auth-hardening-0028' marker, so re-running 0028 never re-renames anything);
-- only the error text changes. 0028 is not edited.
-- ============================================================================

-- ---- 1) the rule (one place) -----------------------------------------------
create or replace function public._password_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  -- password-rule-0030: = Supabase "lowercase, uppercase, digits and symbols", min 12
  select p is not null
     and length(p) >= 12
     and p ~ '[a-z]'
     and p ~ '[A-Z]'
     and p ~ '[0-9]'
     and length(translate(p, '!@#$%^&*()_+-=[]{};''\:"|<>?,./`~', '')) < length(p)
$$;
revoke all on function public._password_ok(text) from public, anon, authenticated;

-- ---- 2) admin_create_user: same 0028 body, new message -----------------------
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: password rule + bcrypt cost 12 + no cross-tenant email oracle
-- password-rule-0030: message matches the Supabase policy
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role using errcode = '22023'; end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'invalid email' using errcode = '22023'; end if;
  if not public._password_ok(p_password) then
    raise exception 'password must be at least 12 characters and include a lowercase letter, an uppercase letter, a number and a symbol' using errcode = '22023';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is not null then
    if exists (select 1 from public.profiles p where p.id = v_uid and p.org_id = public.current_org_id()) then
      raise exception 'this person is already a user in your studio' using errcode = '23505';
    end if;
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;

  v_uid := public._admin_create_user_core(v_email, p_password, p_role);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = v_uid;
  return v_uid;
end $$;
revoke all on function public.admin_create_user(text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

-- ---- 3) temp passwords always satisfy the new rule ---------------------------
create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028 / password-rule-0030
declare v_uid uuid; v_temp text; v_sym text := '!#%*-_+=?';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 'H' (upper) + 'm' (lower) + 16 random base64 chars (96 bits) + one random digit
  -- + one random symbol: always >= 12 chars with all four kinds.
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text
         || substr(v_sym, 1 + get_byte(extensions.gen_random_bytes(1), 0) % length(v_sym), 1);
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  update public.profiles set must_change_password = true where id = v_uid;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;
revoke all on function public.admin_create_user_temp(text, text) from public, anon;
grant execute on function public.admin_create_user_temp(text, text) to authenticated;

-- Verify after apply (read-only):
--   select public._password_ok('Abcdefghij1!') as ok, public._password_ok('abcdefghij12') as old_rule_rejected_now;
--   select pg_get_functiondef('public._password_ok(text)'::regprocedure) like '%password-rule-0030%';
-- ============================================================================

-- ═══════════════════ PART C — Manual bucket (0031) ═══════════════════
-- ============================================================================
-- 0031_manual_private_bucket.sql — CANONICAL forward-only.
--
-- What this changes, in plain words:
--   The Helm user manual used to be a public file (/docs/USER-MANUAL + screenshots):
--   anyone with the URL could read it. It now lives in a PRIVATE storage bucket,
--   "helm-manual", and the /manual page downloads it with the visitor's own
--   signed-in session. This file creates that bucket and ONE read rule:
--     * read (select): signed-in users who belong to a studio (current_org_id()
--       is set) — i.e. real Helm staff, not anonymous sessions or client links.
--     * NO insert / update / delete rule for anyone: only the owner (Dashboard →
--       Storage, which uses the service role) can upload or change manual files.
--
-- Additive + idempotent: creates the bucket if missing (or re-pins it private),
-- (re)creates one policy that only matches bucket_id = 'helm-manual'. No existing
-- bucket, object, table or row is touched. Upload of the files is an owner step
-- (docs/OWNER-ACTIONS-SECURITY.md → "User manual").
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('helm-manual', 'helm-manual', false, 5242880,
          array['text/html', 'image/webp', 'image/png', 'image/jpeg'])
  on conflict (id) do update set public = false, file_size_limit = 5242880,
          allowed_mime_types = array['text/html', 'image/webp', 'image/png', 'image/jpeg'];

drop policy if exists "helm_manual_staff_read" on storage.objects;
create policy "helm_manual_staff_read" on storage.objects for select to authenticated
  using ( bucket_id = 'helm-manual' and (select public.current_org_id()) is not null );

-- Verify after apply (read-only):
--   select id, public from storage.buckets where id = 'helm-manual';            -- public = false
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'helm_manual%';  -- one SELECT policy
-- ============================================================================

-- ════════════════════════════════ VERIFY (one table — every row must say ok) ═══
select item, case when ok then 'ok' else 'PROBLEM' end as status from (values
  ('A HQ allowlist exists and is private',
     to_regclass('public.platform_admins') is not null
     and not has_table_privilege('authenticated', 'public.platform_admins', 'SELECT')
     and not has_table_privilege('anon', 'public.platform_admins', 'SELECT')),
  ('A HQ operators listed (admin@ / security@helm.events)',
     (select count(*) from public.platform_admins where email in ('admin@helm.events','security@helm.events')) = 2),
  ('A HQ data functions installed, never callable by visitors',
     to_regproc('public.hq_overview') is not null and to_regproc('public.hq_users') is not null
     and not has_function_privilege('anon', 'public.hq_overview()', 'EXECUTE')),
  ('B password rule needs lower+upper+digit+symbol',
     public._password_ok('Abcdefghij1!') and not public._password_ok('abcdefghij12') and not public._password_ok('Abcdefghijk1')),
  ('C manual bucket exists and is private',
     exists (select 1 from storage.buckets where id = 'helm-manual' and not public))
) v(item, ok);
