-- APPLY-0166-0167.sql - paste into the Supabase SQL editor (STAGING first; production only when the owner says go).
-- Free-trial sandbox: 0166 skeleton (sample master studio, switch OFF, seat limit you + 2, trial outbox skip,
-- clear_sample_data) + 0167 publish-snapshot model (frozen manifest versions, clone from the CURRENT manifest
-- into each trial's own copy, full India sample dataset written into the sample master only, manifest v1).
-- Additive + idempotent: no existing studio's row is changed or removed. Safe to run twice. ASCII only.
-- The switch stays OFF. To turn it on (staging, after checking):
--   update public.helm_sample_template set active = true where id;
begin;
-- ============================================================================
-- 0166_trial_sandbox_skeleton.sql - CANONICAL forward-only. Free-trial sandbox SKELETON.
-- REQUIRES 0097 + 0100 (is_demo flags, _demo_seed, _demo_clear), 0116 + 0119 (trial studios,
--          start_self_serve_trial), 0127 (_trial_seed_custom), 0128 + 0146 (Skip OTP test mode).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md. This is the skeleton: the sample data itself is a
-- written by 0167 (publish snapshot model), and the clone is OFF until the owner switches it on.
--
-- In plain words:
--   1  ONE "sample master" studio (organizations.is_sample_master) + a one-row switch table
--      public.helm_sample_template (which studio, on/off, anchor date, version). Platform only:
--      RLS on, no policies, no grants to the app.
--   2  public._sample_clone_into(org): copies the master studio's business rows (venues, vendors,
--      staff, dishes, inventory, menu packages) into a NEW trial studio. Every id is remapped
--      (also ids inside jsonb, e.g. a package's dish list), dates are shifted so they look
--      current, emails become @example.com and phones the reserved +91 00000 pattern, links to
--      login users are dropped, every row is is_demo = true. Runs ONCE per studio (advisory lock
--      + organizations.sample_cloned_at). Service role / definer only.
--   3  Wiring: _demo_seed / _trial_seed_extra / _trial_seed_custom are wrapped. When the switch
--      is ON and the master has rows, a trial studio gets the clone INSTEAD of the built-in demo
--      data (identical data for every trial). When the switch is OFF (the default here) nothing
--      changes: the built-in demo seed runs exactly as before.
--   4  Seat limit: a studio in trial has at most 3 people (admin + 2), counting members and
--      open invitations (clients do not count). organizations.seat_limit overrides (null = 3 in
--      trial, no limit otherwise). Enforced by triggers on invitations + profiles, so every path
--      (create_invitation, accept_invitation, direct joins) is covered.
--   5  Outbound guard: comms_outbox / pkg_outbox / assign_notify_outbox rows for a studio in trial
--      (or the sample master) are stored as 'skipped' - nothing is sent. Switch: helm_sample_template.block_trial_outbound (default on).
--      Helm's own mail to the user (invites, welcome, security, codes) is NOT affected.
--   6  clear_sample_data(): admin of a trial (or converted ex-trial) studio removes ONLY that
--      studio's is_demo rows (the existing 0097 _demo_clear). The sample master is refused.
--   Skip OTP (0128/0146 trial_test_approve) is kept unchanged.
--
-- ZERO DATA LOSS / existing studios unaffected: additive + idempotent. New columns (nullable or
-- with defaults), new tables, new functions, triggers created only if missing. The three seed
-- functions are renamed to *__pre0166 once and wrapped (same signature, same grants). One new
-- studio row (the sample master, fixed id; its sample rows come from 0167). No DROP / DELETE /
-- TRUNCATE of anything that exists; no existing row is changed. ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._demo_seed(uuid)') is null or to_regprocedure('public._demo_clear(uuid)') is null then
    raise exception '0166: apply 0097 + 0100 (demo seed / clear) first'; end if;
  if to_regprocedure('public._trial_seed_extra(uuid)') is null or to_regprocedure('public._trial_seed_custom(uuid)') is null then
    raise exception '0166: apply 0116 + 0127 (trial seeds) first'; end if;
  if to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is null then
    raise exception '0166: apply 0119 (unified trial) first'; end if;
  if to_regprocedure('public._trial_test_mode_ok(uuid)') is null then
    raise exception '0166: apply 0128 (trial test mode) first'; end if;
end $$;

-- ---- 1) columns + tables (additive) ------------------------------------------------------------
alter table public.organizations add column if not exists is_sample_master boolean not null default false;
alter table public.organizations add column if not exists seat_limit integer;
alter table public.organizations add column if not exists sample_cloned_at timestamptz;
alter table public.organizations add column if not exists sample_source_org uuid;
alter table public.organizations add column if not exists sample_batch_id uuid;
alter table public.organizations add column if not exists sample_version integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_seat_limit_chk166') then
    alter table public.organizations add constraint organizations_seat_limit_chk166
      check (seat_limit is null or seat_limit between 1 and 10000);
  end if;
end $$;

create table if not exists public.helm_sample_template (
  id boolean primary key default true check (id),
  org_id uuid references public.organizations(id),
  active boolean not null default false,
  anchor_date date not null default current_date,
  version integer not null default 1 check (version >= 1),
  block_trial_outbound boolean not null default true,
  notes text check (notes is null or char_length(notes) <= 2000),
  updated_at timestamptz not null default now()
);
alter table public.helm_sample_template enable row level security;
revoke all on table public.helm_sample_template from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.helm_sample_template from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.helm_sample_template from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert, update on table public.helm_sample_template to service_role; end if;
end $$;

create table if not exists public.trial_sample_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_org uuid,
  version integer,
  batch_id uuid,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trial_sample_runs_org_idx166 on public.trial_sample_runs (org_id);
alter table public.trial_sample_runs enable row level security;
revoke all on table public.trial_sample_runs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.trial_sample_runs from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.trial_sample_runs from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.trial_sample_runs to service_role; end if;
end $$;

-- ---- 2) helpers --------------------------------------------------------------------------------
-- the tables the clone copies, parents first (0167 extends this to leads, quotes (priced
-- by the server engine), payment_milestones, event_checklist, layouts, tasks, run sheet).
create or replace function public._sample_clone_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-sandbox-0166
  select array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates']::text[];
$$;

create or replace function public._sample_template_ready()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- trial-sandbox-0166: switch on + a master studio with at least one row to copy
declare tpl public.helm_sample_template; t text; v_has boolean := false;
begin
  select * into tpl from public.helm_sample_template x where x.id;
  if tpl.org_id is null or not tpl.active then return false; end if;
  foreach t in array public._sample_clone_tables() loop
    execute format('select exists (select 1 from public.%I x where x.org_id = $1)', t) into v_has using tpl.org_id;
    if v_has then return true; end if;
  end loop;
  return false;
end $$;

create or replace function public._is_trial_org(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-sandbox-0166: the studio is in its free trial right now
  select p_org is not null and exists (select 1 from public.studio_subscriptions s where s.org_id = p_org and s.status = 'trial');
$$;

-- ---- 3) the clone ------------------------------------------------------------------------------
create or replace function public._sample_clone_into(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sandbox-0166: master studio -> ONE new trial studio. Own org only, once, is_demo rows.
declare
  tpl public.helm_sample_template; v_src uuid; v_shift integer; v_map jsonb; v_batch uuid := gen_random_uuid();
  v_tables text[] := public._sample_clone_tables(); t text; r record; k record; c record;
  v_txt text; v_row jsonb; v_cols text; v_counts jsonb := '{}'::jsonb; n integer; v_seq integer := 0; v_total integer := 0;
  v_rel regclass; v_col text;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'no studio' using errcode = '22023'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  if tpl.org_id is null or not tpl.active then return jsonb_build_object('cloned', false, 'reason', 'no_template'); end if;
  v_src := tpl.org_id;
  if p_org = v_src or exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then
    raise exception 'the sample master is never a clone target' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:sample_clone:' || p_org::text, 0));
  if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is not null) then
    return jsonb_build_object('cloned', false, 'reason', 'already_cloned'); end if;

  v_shift := current_date - tpl.anchor_date;
  v_map := jsonb_build_object(v_src::text, p_org::text);
  -- pass 1: a new id for every row (so any reference, in any order, resolves)
  foreach t in array v_tables loop
    for r in execute format('select x.id::text as id from public.%I x where x.org_id = $1', t) using v_src loop
      v_map := v_map || jsonb_build_object(r.id, gen_random_uuid()::text);
    end loop;
  end loop;
  if (select count(*) from jsonb_object_keys(v_map)) <= 1 then
    return jsonb_build_object('cloned', false, 'reason', 'template_empty'); end if;

  -- pass 2: insert, parents first
  foreach t in array v_tables loop
    v_rel := format('public.%I', t)::regclass; n := 0;
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_catalog.pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    for r in execute format('select to_jsonb(x) as j from public.%I x where x.org_id = $1 order by x.created_at nulls first, x.id', t) using v_src loop
      -- ids are unique uuids: a text replace remaps top-level AND nested (jsonb) references
      v_txt := r.j::text;
      for k in select e.key, e.value from jsonb_each_text(v_map) e loop
        if position(k.key in v_txt) > 0 then v_txt := replace(v_txt, k.key, k.value); end if;
      end loop;
      v_row := v_txt::jsonb;
      -- never carry a link to a login user, or to a tenant row this clone does not copy
      for c in select a.attname::text as col, rn.nspname::text as rns, rc.relname::text as rrel
                 from pg_catalog.pg_constraint cf
                 join pg_catalog.pg_attribute a on a.attrelid = cf.conrelid and a.attnum = cf.conkey[1]
                 join pg_catalog.pg_class rc on rc.oid = cf.confrelid
                 join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
                where cf.conrelid = v_rel and cf.contype = 'f' and array_length(cf.conkey, 1) = 1 loop
        if (c.rns = 'auth' and c.rrel = 'users') or (c.rns = 'public' and c.rrel = 'profiles')
           or (c.rns = 'public' and c.rrel <> 'organizations' and not (c.rrel = any(v_tables))
               and exists (select 1 from information_schema.columns ic where ic.table_schema = 'public'
                             and ic.table_name = c.rrel and ic.column_name = 'org_id')) then
          v_row := jsonb_set(v_row, array[c.col], 'null'::jsonb);
        end if;
      end loop;
      foreach v_col in array array['created_by', 'updated_by', 'profile_id'] loop
        if v_row ? v_col then v_row := jsonb_set(v_row, array[v_col], 'null'::jsonb); end if;
      end loop;
      -- contacts can never reach a person
      v_seq := v_seq + 1;
      foreach v_col in array array['email', 'contact_email'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb('sample-' || t || '-' || v_seq::text || '@example.com')); end if;
      end loop;
      foreach v_col in array array['phone', 'contact_phone'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb('+91 00000 ' || lpad((v_seq % 100000)::text, 5, '0'))); end if;
      end loop;
      -- dates follow the signup day
      for c in select a.attname::text as col, a.atttypid
                 from pg_catalog.pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped
                  and a.atttypid in ('date'::regtype, 'timestamptz'::regtype, 'timestamp'::regtype)
                  and a.attname not in ('created_at', 'updated_at') loop
        if v_shift <> 0 and jsonb_typeof(v_row -> c.col) = 'string' then
          if c.atttypid = 'date'::regtype then
            v_row := jsonb_set(v_row, array[c.col], to_jsonb(((v_row ->> c.col)::date + v_shift)));
          else
            v_row := jsonb_set(v_row, array[c.col], to_jsonb(((v_row ->> c.col)::timestamptz + make_interval(days => v_shift))));
          end if;
        end if;
      end loop;
      v_row := v_row || jsonb_build_object('org_id', p_org);
      if v_row ? 'is_demo' then v_row := v_row || jsonb_build_object('is_demo', true); end if;
      if v_row ? 'created_at' then v_row := v_row || jsonb_build_object('created_at', now()); end if;
      if v_row ? 'updated_at' then v_row := v_row || jsonb_build_object('updated_at', now()); end if;
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', t, v_cols, v_cols, t) using v_row;
      n := n + 1;
    end loop;
    v_counts := v_counts || jsonb_build_object(t, n); v_total := v_total + n;
  end loop;

  update public.organizations
     set sample_cloned_at = now(), sample_source_org = v_src, sample_batch_id = v_batch, sample_version = tpl.version
   where id = p_org;
  insert into public.trial_sample_runs(org_id, source_org, version, batch_id, counts)
    values (p_org, v_src, tpl.version, v_batch, v_counts);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_cloned', 'organizations', p_org::text,
            jsonb_build_object('version', tpl.version, 'batch', v_batch, 'counts', v_counts, 'shift_days', v_shift), p_org, now());
  return jsonb_build_object('cloned', true, 'seeded', true, 'source', 'sample_template', 'version', tpl.version,
                            'batch', v_batch, 'rows', v_total, 'counts', v_counts);
end $$;

-- ---- 4) wiring: wrap the three trial seeds (renamed once, same signature) ----------------------
do $$ begin
  if to_regprocedure('public._demo_seed__pre0166(uuid)') is null then
    alter function public._demo_seed(uuid) rename to _demo_seed__pre0166; end if;
  if to_regprocedure('public._trial_seed_extra__pre0166(uuid)') is null then
    alter function public._trial_seed_extra(uuid) rename to _trial_seed_extra__pre0166; end if;
  if to_regprocedure('public._trial_seed_custom__pre0166(uuid)') is null then
    alter function public._trial_seed_custom(uuid) rename to _trial_seed_custom__pre0166; end if;
end $$;

create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sandbox-0166: a trial studio gets the master clone when it is switched on; else 0100 seed
declare r jsonb;
begin
  if p_org is not null and public._sample_template_ready()
     and exists (select 1 from public.organizations o where o.id = p_org and o.trial_ends_at is not null and not o.is_sample_master) then
    r := public._sample_clone_into(p_org);
    if coalesce((r ->> 'cloned')::boolean, false) then
      update public.organizations set trial_mode = 'demo' where id = p_org and trial_mode is distinct from 'demo';
      return r;
    end if;
    if r ->> 'reason' = 'already_cloned' then return r || jsonb_build_object('seeded', false); end if;
  end if;
  return public._demo_seed__pre0166(p_org);
end $$;

create or replace function public._trial_seed_extra(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sandbox-0166: the master clone replaces the built-in extras (identical data per trial)
begin
  if public._sample_template_ready() then return jsonb_build_object('seeded', false, 'reason', 'sample_template'); end if;
  return public._trial_seed_extra__pre0166(p_org);
end $$;

create or replace function public._trial_seed_custom(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sandbox-0166: the master clone replaces the 0127 owner seed hook
begin
  if public._sample_template_ready() then return jsonb_build_object('seeded', false, 'reason', 'sample_template'); end if;
  return public._trial_seed_custom__pre0166(p_org);
end $$;

-- ---- 5) seat limit (admin + 2 during the trial) -------------------------------------------------
create or replace function public._trial_seat_limit(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- trial-sandbox-0166: null = no limit
  select case when public._is_trial_org(p_org) then coalesce(o.seat_limit, 3) else o.seat_limit end
    from public.organizations o where o.id = p_org;
$$;

create or replace function public._ts166_tg_invite_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: members + open invitations may not pass the seat limit
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.status, 'pending') <> 'pending' or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'pending' and old.org_id is not distinct from new.org_id then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  select (select count(*) from public.profiles p where p.org_id = new.org_id and coalesce(p.role, '') <> 'client')
       + (select count(*) from public.invitations i
           where i.org_id = new.org_id and i.status = 'pending' and i.id is distinct from new.id
             and coalesce(i.role, '') <> 'client' and (i.expires_at is null or i.expires_at > now())
             and not exists (select 1 from public.profiles p where p.org_id = new.org_id and lower(p.email) = lower(i.email)))
    into v_used;
  if v_used >= v_lim then
    raise exception 'Your free trial includes % people (you + % more). Remove an invitation or upgrade to add more.', v_lim, v_lim - 1
      using errcode = '42501', hint = 'seat_limit';
  end if;
  return new;
end $$;

create or replace function public._ts166_tg_profile_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: joining a studio (any path) may not pass the seat limit
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.org_id is not distinct from new.org_id then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  select count(*) into v_used from public.profiles p
   where p.org_id = new.org_id and p.id <> new.id and coalesce(p.role, '') <> 'client';
  if v_used >= v_lim then
    raise exception 'Your free trial includes % people (you + % more). Upgrade to add more.', v_lim, v_lim - 1
      using errcode = '42501', hint = 'seat_limit';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'zzzz_ts166_seat_limit') then
    create trigger zzzz_ts166_seat_limit before insert or update of status, org_id on public.invitations
      for each row execute function public._ts166_tg_invite_seat();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'zzzz_ts166_seat_limit') then
    create trigger zzzz_ts166_seat_limit before insert or update of org_id on public.profiles
      for each row execute function public._ts166_tg_profile_seat();
  end if;
end $$;

-- ---- 6) outbound guard (trial / sample: queued as skipped, never sent) -------------------------
create or replace function public._sample_outbound_blocked(p_org uuid, p_recipient text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-sandbox-0166
  -- (p_recipient kept for the next phase: per-recipient rules; sample contacts are already
  --  undeliverable @example.com / +91 00000 and demo events are skipped by 0097)
  select (p_org is not null and exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master))
      or (p_org is not null and coalesce((select t.block_trial_outbound from public.helm_sample_template t where t.id), true)
          and public._is_trial_org(p_org));
$$;

create or replace function public._ts166_tg_outbox_skip()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166
declare v_rcpt text := coalesce(to_jsonb(new) ->> 'recipient', to_jsonb(new) ->> 'phone');
begin
  if new.status = 'pending' and public._sample_outbound_blocked(new.org_id, v_rcpt) then new.status := 'skipped'; end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['comms_outbox', 'pkg_outbox', 'assign_notify_outbox'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_ts166_outbox_skip') then
      execute format('create trigger zzzz_ts166_outbox_skip before insert on public.%I for each row execute function public._ts166_tg_outbox_skip()', t);
    end if;
  end loop;
end $$;

-- ---- 7) Clear sample data (admin, trial or converted ex-trial, is_demo rows only) --------------
create or replace function public.clear_sample_data()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sandbox-0166: removes ONLY this studio's is_demo rows (0097 _demo_clear); own data is never touched
declare v_org uuid := public.current_org_id(); o public.organizations; r jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org for update;
  if o.id is null or o.is_sample_master then raise exception 'not authorized' using errcode = '42501'; end if;
  if o.trial_ends_at is null then
    raise exception 'only a trial studio (or one that started as a trial) has sample data to clear' using errcode = '22023'; end if;
  r := public._demo_clear(v_org);
  update public.organizations set trial_mode = 'own' where id = v_org and trial_mode is distinct from 'own';
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'trial.sample_cleared',
           'organizations', v_org::text, jsonb_build_object('cleared', r), v_org, now();
  return jsonb_build_object('result', 'ok', 'cleared', r);
end $$;

-- ---- 8) the sample master studio (its data: 0167) ---------------------------------------------
insert into public.organizations(id, name, currency, timezone, country, is_sample_master)
select 'a5a5a5a5-0166-4000-8000-000000000001'::uuid, 'Helm Sample Master', 'INR', 'Asia/Kolkata', 'IN', true
 where not exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid);
update public.organizations set is_sample_master = true
 where id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid and not is_sample_master;

-- switch OFF until the owner has loaded the real data and checked it on staging
insert into public.helm_sample_template(id, org_id, active, anchor_date, version, notes)
values (true, 'a5a5a5a5-0166-4000-8000-000000000001'::uuid, false, current_date, 1,
        'Sample master studio. Data + publish: 0167. Switch on with active = true.')
on conflict (id) do nothing;

-- the sample dataset itself is written by 0167 (and published as manifest v1)

-- ---- 9) privileges -----------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._sample_clone_tables()', 'public._sample_template_ready()', 'public._is_trial_org(uuid)',
    'public._sample_clone_into(uuid)', 'public._demo_seed(uuid)', 'public._demo_seed__pre0166(uuid)',
    'public._trial_seed_extra(uuid)', 'public._trial_seed_extra__pre0166(uuid)',
    'public._trial_seed_custom(uuid)', 'public._trial_seed_custom__pre0166(uuid)',
    'public._trial_seat_limit(uuid)', 'public._ts166_tg_invite_seat()', 'public._ts166_tg_profile_seat()',
    'public._sample_outbound_blocked(uuid, text)', 'public._ts166_tg_outbox_skip()', 'public.clear_sample_data()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public._sample_clone_into(uuid)', 'public._demo_seed(uuid)', 'public._demo_seed__pre0166(uuid)',
                             'public._trial_seed_extra(uuid)', 'public._trial_seed_extra__pre0166(uuid)',
                             'public._trial_seed_custom(uuid)', 'public._trial_seed_custom__pre0166(uuid)',
                             'public.clear_sample_data()'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.clear_sample_data() to authenticated;
  end if;
end $$;

-- ============================================================================
-- 0167_trial_sample_manifest.sql - CANONICAL forward-only. Free-trial sample data: PUBLISH
-- SNAPSHOT model + the full India sample dataset.
-- REQUIRES 0166 (sample master studio, helm_sample_template switch, _sample_clone_into, seat
--          limit, outbox skip, clear_sample_data) and 0097/0100 (is_demo, _demo_clear, D8 pricing).
-- Design: docs/trial/TRIAL-ARCHITECTURE.md (option B: master studio + publish snapshot).
--
-- In plain words:
--   1  helm_trial_seed_manifest: FROZEN snapshots of the "Helm Sample Master" studio. The owner
--      edits the master with the normal screens; nothing reaches a trial until a platform admin
--      runs publish_sample_manifest(). Only the row with is_current = true seeds NEW trials, so a
--      half-edited master never leaks. Roll back with set_current_sample_manifest(version).
--      Platform only: RLS on, no policies, no grants to the app.
--   2  _sample_clone_into(org) now copies from the CURRENT MANIFEST (not the live master), and
--      covers the whole studio: venues, vendors, staff, dishes, inventory, menu packages, item
--      price list (rate cards), checklist + task templates, leads, quotes/events, layout
--      versions, payment milestones, payments (simulated), checklists, staff tasks, run sheet,
--      inventory reservations, event costs, closure (settlement), nurture contacts; the floor layout
--      travels as the event's layout version (quote_versions).
--      Each trial gets its OWN copy (new ids everywhere, also inside jsonb): edits in one trial
--      never touch another trial or the master. Quote totals are re-priced by the server pricing
--      engine (D8 trigger) on insert. Dates move with the signup day. Contacts stay undeliverable
--      (@example.com, +91 00000 reserved). Approval links get a NEW token per trial.
--   3  is_demo (+ the 0097 guard trigger) on nurture, checklist_templates, task_templates; the
--      0097 clear (_demo_clear, renamed *__pre0167 once and wrapped) also removes those sample rows.
--      "Reset demo data" can re-seed a trial whose sample rows were all cleared.
--   4  my_seat_usage(): any signed-in member reads "N of M seats used" for their own studio.
--   4b trial_welcome_setup(name, city, phone): step 1 of the 2-step trial welcome renames the
--      caller's own trial studio (name, link slug, city - default Hyderabad, optional phone).
--   5  The full sample dataset (India / Hyderabad, INR) is written into the master studio once,
--      and manifest v1 is published from it. The switch (helm_sample_template.active) stays OFF.
--
-- Switch on (staging, after checking): update public.helm_sample_template set active = true where id;
--
-- ZERO DATA LOSS: additive + idempotent. New table, new columns with defaults, new functions,
-- triggers created only if missing; _demo_clear renamed once and wrapped. The sample rows are
-- written ONLY into the sample master studio (fixed id) and only where that table is empty
-- there. No existing studio's row is changed or removed. ASCII only. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._sample_clone_into(uuid)') is null or to_regclass('public.helm_sample_template') is null then
    raise exception '0167: apply 0166 (trial sandbox skeleton) first'; end if;
  if to_regprocedure('public._demo_clear(uuid)') is null or to_regprocedure('public.helm_quote_total(jsonb)') is null then
    raise exception '0167: apply 0097 + 0100 first'; end if;
  if to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0167: apply 0029 (platform admin) first'; end if;
end $$;

-- ---- 1) manifest table (platform only) ---------------------------------------------------------
create table if not exists public.helm_trial_seed_manifest (
  version integer primary key check (version >= 1),
  source_org uuid not null,
  anchor_date date not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8388608),
  counts jsonb not null default '{}'::jsonb,
  is_current boolean not null default false,
  published_by uuid,
  published_at timestamptz not null default now(),
  notes text check (notes is null or char_length(notes) <= 2000)
);
create unique index if not exists helm_trial_seed_manifest_one_current167
  on public.helm_trial_seed_manifest ((true)) where is_current;
alter table public.helm_trial_seed_manifest enable row level security;
revoke all on table public.helm_trial_seed_manifest from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.helm_trial_seed_manifest from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.helm_trial_seed_manifest from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.helm_trial_seed_manifest to service_role; end if;
end $$;
alter table public.trial_sample_runs add column if not exists manifest_version integer;

-- ---- 2) is_demo on the newly seeded template tables (additive) ---------------------------------
do $$ declare t text; begin
  foreach t in array array['nurture', 'checklist_templates', 'task_templates'] loop
    execute format('alter table public.%I add column if not exists is_demo boolean not null default false', t);
    execute format('create index if not exists %I on public.%I (org_id) where is_demo', t || '_demo_idx167', t);
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_a97_demo_flag_guard') then
      execute format('create trigger zz_a97_demo_flag_guard before insert or update on public.%I for each row execute function public._a97_tg_demo_flag_guard()', t);
    end if;
  end loop;
end $$;

-- ---- 3) what a snapshot holds (parents first) ---------------------------------------------------
create or replace function public._sample_clone_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-sample-0167 (was trial-sandbox-0166)
  select array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates',
               'item_rate_cards', 'checklist_templates', 'task_templates',
               'leads', 'quotes', 'quote_versions', 'payment_milestones', 'quote_payments',
               'event_checklist', 'event_tasks', 'run_sheet_items', 'inventory_reservations',
               'event_costs', 'event_closure', 'nurture']::text[];
$$;

-- frozen copy of one studio: { tables: { t: [row, ...] } } (rows as stored, oldest first)
create or replace function public._sample_snapshot(p_src uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-sample-0167
declare t text; v_rows jsonb; v_tables jsonb := '{}'::jsonb; v_counts jsonb := '{}'::jsonb; v_has_created boolean;
begin
  foreach t in array public._sample_clone_tables() loop
    if to_regclass('public.' || t) is null then continue; end if;
    v_has_created := exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = format('public.%I', t)::regclass
                               and a.attname = 'created_at' and not a.attisdropped);
    execute format('select coalesce(jsonb_agg(to_jsonb(x) order by %s), ''[]''::jsonb) from public.%I x where x.org_id = $1',
                   case when v_has_created then 'x.created_at, to_jsonb(x)::text' else 'to_jsonb(x)::text' end, t)
      into v_rows using p_src;
    v_tables := v_tables || jsonb_build_object(t, v_rows);
    v_counts := v_counts || jsonb_build_object(t, jsonb_array_length(v_rows));
  end loop;
  return jsonb_build_object('tables', v_tables, 'counts', v_counts);
end $$;

create or replace function public._sample_publish_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-sample-0167: a platform admin, or the service role / SQL editor (no end-user JWT)
  -- (auth.role() is the CALLER's JWT role; current_user inside a definer function is the owner)
  select coalesce(public.is_platform_admin(), false) or coalesce(auth.role(), '') not in ('anon', 'authenticated');
$$;

-- ---- 4) publish / roll back -------------------------------------------------------------------
create or replace function public.publish_sample_manifest(p_notes text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167: snapshot the sample master into a NEW frozen version and make it current
declare tpl public.helm_sample_template; v_snap jsonb; v_ver integer; v_real integer;
begin
  if not public._sample_publish_ok() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  if tpl.org_id is null then raise exception 'no sample master studio is configured' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:sample_publish', 0));
  v_snap := public._sample_snapshot(tpl.org_id);
  if coalesce((v_snap #>> '{counts,quotes}')::integer, 0) + coalesce((v_snap #>> '{counts,inventory_items}')::integer, 0) = 0 then
    raise exception 'the sample master studio is empty - nothing to publish' using errcode = '22023'; end if;
  -- warn-level check: contact values that are not obviously dummy (they are rewritten at seed time anyway)
  select count(*) into v_real
    from jsonb_each(v_snap -> 'tables') t(k, rows), jsonb_array_elements(t.rows) r(j)
   where (coalesce(r.j ->> 'email', '') <> '' and lower(r.j ->> 'email') not like '%@example.com')
      or (coalesce(r.j ->> 'phone', '') <> '' and right(regexp_replace(r.j ->> 'phone', '\D', '', 'g'), 10) not like '00000%');
  select coalesce(max(m.version), 0) + 1 into v_ver from public.helm_trial_seed_manifest m;
  update public.helm_trial_seed_manifest set is_current = false where is_current;
  insert into public.helm_trial_seed_manifest(version, source_org, anchor_date, payload, counts, is_current, published_by, notes)
    values (v_ver, tpl.org_id, tpl.anchor_date, jsonb_build_object('tables', v_snap -> 'tables'), v_snap -> 'counts', true,
            auth.uid(), left(p_notes, 2000));
  update public.helm_sample_template set version = v_ver, updated_at = now() where id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_published', 'helm_trial_seed_manifest', v_ver::text,
            jsonb_build_object('version', v_ver, 'counts', v_snap -> 'counts', 'non_dummy_contacts', v_real), tpl.org_id, now());
  return jsonb_build_object('version', v_ver, 'counts', v_snap -> 'counts', 'anchor_date', tpl.anchor_date,
                            'non_dummy_contacts_rewritten_at_seed', v_real);
end $$;

create or replace function public.set_current_sample_manifest(p_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167: roll back / forward - only NEW trials are affected
begin
  if not public._sample_publish_ok() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.helm_trial_seed_manifest m where m.version = p_version) then
    raise exception 'no such sample version' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:sample_publish', 0));
  update public.helm_trial_seed_manifest set is_current = false where is_current and version <> p_version;
  update public.helm_trial_seed_manifest set is_current = true where version = p_version and not is_current;
  update public.helm_sample_template set version = p_version, updated_at = now() where id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_version_set', 'helm_trial_seed_manifest', p_version::text,
            jsonb_build_object('version', p_version), null, now());
  return jsonb_build_object('current', p_version);
end $$;

create or replace function public.sample_manifest_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-sample-0167: platform view of the switch + versions (no payloads)
declare tpl public.helm_sample_template;
begin
  if not public._sample_publish_ok() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  return jsonb_build_object('active', coalesce(tpl.active, false), 'master', tpl.org_id, 'anchor_date', tpl.anchor_date,
    'block_trial_outbound', coalesce(tpl.block_trial_outbound, true),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('version', m.version, 'current', m.is_current,
        'published_at', m.published_at, 'counts', m.counts, 'notes', m.notes) order by m.version desc)
      from public.helm_trial_seed_manifest m), '[]'::jsonb));
end $$;

-- ---- 5) ready = switch on + a current published version -----------------------------------------
create or replace function public._sample_template_ready()
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-sample-0167 (was trial-sandbox-0166: live master rows)
  select exists (select 1 from public.helm_sample_template t where t.id and t.active and t.org_id is not null)
     and exists (select 1 from public.helm_trial_seed_manifest m where m.is_current);
$$;

-- a contact value that is already obviously dummy is kept (so a quote's client still matches its lead)
create or replace function public._sample_safe_email(p text, p_seq integer)
returns text language sql immutable set search_path = '' as $$
  select case when p is null or btrim(p) = '' then p
              when lower(btrim(p)) ~ '^[a-z0-9._+-]+@example\.com$' then lower(btrim(p))
              else 'sample-' || p_seq::text || '@example.com' end;
$$;
create or replace function public._sample_safe_phone(p text, p_seq integer)
returns text language sql immutable set search_path = '' as $$
  select case when p is null or btrim(p) = '' then p
              when right(regexp_replace(p, '\D', '', 'g'), 10) like '00000%' then p
              else '+91 00000 ' || lpad((p_seq % 100000)::text, 5, '0') end;
$$;

-- ---- 6) the clone: CURRENT MANIFEST -> one new trial studio --------------------------------------
create or replace function public._sample_clone_into(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167 (trial-sandbox-0166): own org only, once, every row is_demo, from the frozen manifest
declare
  tpl public.helm_sample_template; m public.helm_trial_seed_manifest; v_src uuid; v_shift integer; v_map jsonb;
  v_batch uuid := gen_random_uuid(); v_tables text[] := public._sample_clone_tables(); t text; r record; k record; c record;
  v_txt text; v_row jsonb; v_cols text; v_counts jsonb := '{}'::jsonb; n integer; v_seq integer := 0; v_total integer := 0;
  v_rel regclass; v_col text; v_has_id boolean; v_fix jsonb := '[]'::jsonb; f jsonb; v_pos integer; v_ins integer; v_sub jsonb;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'no studio' using errcode = '22023'; end if;
  select * into tpl from public.helm_sample_template x where x.id;
  select * into m from public.helm_trial_seed_manifest x where x.is_current;
  if tpl.org_id is null or not tpl.active or m.version is null then
    return jsonb_build_object('cloned', false, 'reason', 'no_template'); end if;
  v_src := m.source_org;
  if p_org = v_src or p_org = tpl.org_id or exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then
    raise exception 'the sample master is never a clone target' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:sample_clone:' || p_org::text, 0));
  if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is not null) then
    return jsonb_build_object('cloned', false, 'reason', 'already_cloned'); end if;

  v_shift := current_date - m.anchor_date;
  v_map := jsonb_build_object(v_src::text, p_org::text);
  -- pass 1: a new id for every row (any reference, in any order, resolves)
  foreach t in array v_tables loop
    for r in select e.j ->> 'id' as id from jsonb_array_elements(coalesce(m.payload #> array['tables', t], '[]'::jsonb)) e(j)
              where e.j ? 'id' loop
      v_map := v_map || jsonb_build_object(r.id, gen_random_uuid()::text);
    end loop;
  end loop;
  if (select count(*) from jsonb_object_keys(v_map)) <= 1 then
    return jsonb_build_object('cloned', false, 'reason', 'template_empty'); end if;

  -- pass 2: insert, parents first
  foreach t in array v_tables loop
    n := 0;
    if to_regclass('public.' || t) is null then continue; end if;
    v_rel := format('public.%I', t)::regclass;
    v_pos := array_position(v_tables, t);
    for r in select e.j from jsonb_array_elements(coalesce(m.payload #> array['tables', t], '[]'::jsonb)) e(j) loop
      -- ids are unique uuids: a text replace remaps top-level AND nested (jsonb) references
      v_txt := r.j::text;
      for k in select e.key, e.value from jsonb_each_text(v_map) e loop
        if position(k.key in v_txt) > 0 then v_txt := replace(v_txt, k.key, k.value); end if;
      end loop;
      v_row := v_txt::jsonb;
      v_has_id := v_row ? 'id';
      -- links: login users and tenant rows this clone does not copy are dropped; a link to a row
      -- inserted LATER (e.g. lead -> quote, task -> task) is set after every row is in
      for c in select a.attname::text as col, rn.nspname::text as rns, rc.relname::text as rrel
                 from pg_catalog.pg_constraint cf
                 join pg_catalog.pg_attribute a on a.attrelid = cf.conrelid and a.attnum = cf.conkey[1]
                 join pg_catalog.pg_class rc on rc.oid = cf.confrelid
                 join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
                where cf.conrelid = v_rel and cf.contype = 'f' and array_length(cf.conkey, 1) = 1 loop
        if not (v_row ? c.col) or jsonb_typeof(v_row -> c.col) = 'null' then continue; end if;
        if (c.rns = 'auth' and c.rrel = 'users') or (c.rns = 'public' and c.rrel = 'profiles')
           or (c.rns = 'public' and c.rrel <> 'organizations' and not (c.rrel = any(v_tables))
               and exists (select 1 from information_schema.columns ic where ic.table_schema = 'public'
                             and ic.table_name = c.rrel and ic.column_name = 'org_id')) then
          v_row := jsonb_set(v_row, array[c.col], 'null'::jsonb);
        elsif c.rns = 'public' and c.rrel = any(v_tables) and array_position(v_tables, c.rrel) >= v_pos and v_has_id then
          v_fix := v_fix || jsonb_build_array(jsonb_build_object('t', t, 'id', v_row ->> 'id', 'col', c.col, 'v', v_row ->> c.col));
          v_row := jsonb_set(v_row, array[c.col], 'null'::jsonb);
        end if;
      end loop;
      for c in select a.attname::text as col from pg_catalog.pg_attribute a
                where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.atttypid = 'uuid'::regtype
                  and a.attname in ('created_by', 'updated_by', 'profile_id', 'owner', 'confirmed_by', 'manager_id', 'archived_by',
                                    'deleted_by', 'verified_by', 'reviewed_by', 'drafted_by', 'published_by') loop
        if v_row ? c.col then v_row := jsonb_set(v_row, array[c.col], 'null'::jsonb); end if;
      end loop;
      -- contacts can never reach a person (already-dummy values are kept)
      v_seq := v_seq + 1;
      foreach v_col in array array['email', 'contact_email'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb(public._sample_safe_email(v_row ->> v_col, v_seq))); end if;
      end loop;
      foreach v_col in array array['phone', 'contact_phone', 'assignee_phone'] loop
        if v_row ? v_col and jsonb_typeof(v_row -> v_col) = 'string' then
          v_row := jsonb_set(v_row, array[v_col], to_jsonb(public._sample_safe_phone(v_row ->> v_col, v_seq))); end if;
      end loop;
      -- nested client contacts (quotes.client, quotes.pricing.client)
      foreach v_col in array array['client', 'pricing'] loop
        if jsonb_typeof(v_row -> v_col) = 'object' then
          v_sub := v_row -> v_col;
          if v_col = 'pricing' then v_sub := v_sub -> 'client'; end if;
          if jsonb_typeof(v_sub) = 'object' then
            if jsonb_typeof(v_sub -> 'email') = 'string' then v_sub := jsonb_set(v_sub, '{email}', to_jsonb(public._sample_safe_email(v_sub ->> 'email', v_seq))); end if;
            if jsonb_typeof(v_sub -> 'phone') = 'string' then v_sub := jsonb_set(v_sub, '{phone}', to_jsonb(public._sample_safe_phone(v_sub ->> 'phone', v_seq))); end if;
            if v_col = 'pricing' then v_row := jsonb_set(v_row, '{pricing,client}', v_sub); else v_row := jsonb_set(v_row, '{client}', v_sub); end if;
          end if;
        end if;
      end loop;
      -- an approval link is per trial: a fresh token, never the master's
      if t = 'quotes' and jsonb_typeof(v_row -> 'approval_token') = 'string' then
        v_row := v_row || jsonb_build_object('approval_token', gen_random_uuid(), 'approval_token_expires_at', now() + interval '30 days',
                                             'approval_token_revoked_at', null);
      end if;
      -- dates follow the signup day
      for c in select a.attname::text as col, a.atttypid
                 from pg_catalog.pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped
                  and a.atttypid in ('date'::regtype, 'timestamptz'::regtype, 'timestamp'::regtype)
                  and a.attname not in ('created_at', 'updated_at', 'approval_token_expires_at') loop
        if v_shift <> 0 and jsonb_typeof(v_row -> c.col) = 'string' then
          if c.atttypid = 'date'::regtype then
            v_row := jsonb_set(v_row, array[c.col], to_jsonb(((v_row ->> c.col)::date + v_shift)));
          else
            v_row := jsonb_set(v_row, array[c.col], to_jsonb(((v_row ->> c.col)::timestamptz + make_interval(days => v_shift))));
          end if;
        end if;
      end loop;
      v_row := v_row || jsonb_build_object('org_id', p_org);
      if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = v_rel and a.attname = 'is_demo' and not a.attisdropped) then
        v_row := v_row || jsonb_build_object('is_demo', true); end if;
      if v_row ? 'created_at' then v_row := v_row || jsonb_build_object('created_at', now()); end if;
      if v_row ? 'updated_at' then v_row := v_row || jsonb_build_object('updated_at', now()); end if;
      -- only the columns this snapshot carries (a column added later keeps its default)
      select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
        from pg_catalog.pg_attribute a
       where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and v_row ? a.attname::text;
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) on conflict do nothing',
                     t, v_cols, v_cols, t) using v_row;
      get diagnostics v_ins = row_count;
      n := n + v_ins;
    end loop;
    v_counts := v_counts || jsonb_build_object(t, n); v_total := v_total + n;
  end loop;

  -- links to rows inserted later
  for f in select e.value from jsonb_array_elements(v_fix) e loop
    execute format('update public.%I set %I = $1::uuid where id = $2::uuid and org_id = $3 and %I is distinct from $1::uuid',
                   f ->> 't', f ->> 'col', f ->> 'col')
      using f ->> 'v', f ->> 'id', p_org;
  end loop;

  update public.organizations
     set sample_cloned_at = now(), sample_source_org = v_src, sample_batch_id = v_batch, sample_version = m.version
   where id = p_org;
  insert into public.trial_sample_runs(org_id, source_org, version, batch_id, counts, manifest_version)
    values (p_org, v_src, m.version, v_batch, v_counts, m.version);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.sample_cloned', 'organizations', p_org::text,
            jsonb_build_object('version', m.version, 'batch', v_batch, 'counts', v_counts, 'shift_days', v_shift), p_org, now());
  return jsonb_build_object('cloned', true, 'seeded', true, 'source', 'sample_manifest', 'version', m.version,
                            'batch', v_batch, 'rows', v_total, 'counts', v_counts);
end $$;

-- ---- 7) seed wrapper: "Reset demo data" may re-seed a trial whose sample rows are all gone -----
create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167 (trial-sandbox-0166): a trial studio gets its own copy of the published sample; else 0100 seed
declare r jsonb;
begin
  if p_org is not null and public._sample_template_ready()
     and exists (select 1 from public.organizations o where o.id = p_org and o.trial_ends_at is not null and not o.is_sample_master) then
    if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is not null)
       and not exists (select 1 from public.quotes x where x.org_id = p_org and x.is_demo)
       and not exists (select 1 from public.leads x where x.org_id = p_org and x.is_demo)
       and not exists (select 1 from public.inventory_items x where x.org_id = p_org and x.is_demo and x.active) then
      update public.organizations set sample_cloned_at = null where id = p_org;
    end if;
    r := public._sample_clone_into(p_org);
    if coalesce((r ->> 'cloned')::boolean, false) then
      update public.organizations set trial_mode = 'demo' where id = p_org and trial_mode is distinct from 'demo';
      return r;
    end if;
    if r ->> 'reason' = 'already_cloned' then return r || jsonb_build_object('seeded', false); end if;
  end if;
  return public._demo_seed__pre0166(p_org);
end $$;

-- ---- 8) clear: also the sample templates + nurture contacts --------------------------------------
do $$ begin
  if to_regprocedure('public._demo_clear__pre0167(uuid)') is null then
    alter function public._demo_clear(uuid) rename to _demo_clear__pre0167; end if;
end $$;

create or replace function public._demo_clear(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167: the 0097 clear (is_demo rows of ONE studio) + nurture / checklist / task templates
declare r jsonb; n_n integer; n_ct integer; n_tt integer;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  -- a closed sample event locks its cost lines (0046/0084 money freeze): re-open ONLY this
  -- studio's sample events first so the 0097 clear can remove them with their children
  update public.event_closure c set closed_at = null
   where c.org_id = p_org and c.closed_at is not null
     and c.quote_id in (select q.id from public.quotes q where q.org_id = p_org and q.is_demo);
  r := public._demo_clear__pre0167(p_org);
  delete from public.nurture where org_id = p_org and is_demo;
  get diagnostics n_n = row_count;
  delete from public.checklist_templates where org_id = p_org and is_demo;
  get diagnostics n_ct = row_count;
  delete from public.task_templates where org_id = p_org and is_demo;
  get diagnostics n_tt = row_count;
  return coalesce(r, '{}'::jsonb) || jsonb_build_object('nurture', n_n, 'checklist_templates', n_ct, 'task_templates', n_tt);
end $$;

-- ---- 9) seats: "N of M used" for the signed-in member's own studio ------------------------------
create or replace function public.my_seat_usage()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-sample-0167: members + open invitations (clients do not count), same rule as the 0166 triggers
declare v_org uuid := public.current_org_id(); v_lim integer; v_mem integer; v_pend integer;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_lim := public._trial_seat_limit(v_org);
  select count(*) into v_mem from public.profiles p where p.org_id = v_org and coalesce(p.role, '') <> 'client';
  select count(*) into v_pend from public.invitations i
   where i.org_id = v_org and i.status = 'pending' and coalesce(i.role, '') <> 'client'
     and (i.expires_at is null or i.expires_at > now())
     and not exists (select 1 from public.profiles p where p.org_id = v_org and lower(p.email) = lower(i.email));
  return jsonb_build_object('limited', v_lim is not null, 'limit', v_lim, 'used', v_mem + v_pend,
    'members', v_mem, 'pending', v_pend, 'trial', public._is_trial_org(v_org),
    'at_limit', v_lim is not null and v_mem + v_pend >= v_lim,
    'extra_limit', case when v_lim is null then null else greatest(v_lim - 1, 0) end,
    'extra_used', greatest(v_mem + v_pend - 1, 0));
end $$;

-- ---- 9b) 2-step trial welcome, step 1: "Name your trial studio" (admin of a trial studio only) ----
create or replace function public.trial_welcome_setup(p_name text, p_city text default 'Hyderabad', p_phone text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-sample-0167: name / slug / city / phone of the caller's OWN trial studio; sample data untouched
declare v_org uuid := public.current_org_id(); v_name text := btrim(coalesce(p_name, ''));
  v_city text := nullif(btrim(coalesce(p_city, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_slug text;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations o where o.id = v_org and o.trial_ends_at is not null and not o.is_sample_master) then
    raise exception 'only a free-trial studio uses this welcome step' using errcode = '22023'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'Enter a studio name (2 to 120 characters).' using errcode = '22023'; end if;
  if v_city is not null and char_length(v_city) > 120 then raise exception 'City is too long.' using errcode = '22023'; end if;
  if v_phone is not null and (char_length(v_phone) > 40 or v_phone !~ '^[0-9+() .-]{6,40}$') then
    raise exception 'Enter a valid phone number (or leave it empty).' using errcode = '22023'; end if;
  update public.organizations o
     set name = v_name,
         location = coalesce(v_city, 'Hyderabad'),
         brand = case when v_phone is null then o.brand else coalesce(o.brand, '{}'::jsonb) || jsonb_build_object('phone', v_phone) end
   where o.id = v_org;
  begin
    v_slug := public.studio_slug_pick(v_name, v_org);
    if v_slug is not null then update public.organizations set public_slug = v_slug where id = v_org and public_slug is distinct from v_slug; end if;
  exception when others then v_slug := null;   -- the name is saved; the link keeps its old slug
  end;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'trial.welcome_named', 'organizations', v_org::text,
            jsonb_build_object('name', v_name, 'city', coalesce(v_city, 'Hyderabad')), v_org, now());
  return jsonb_build_object('result', 'ok', 'name', v_name, 'city', coalesce(v_city, 'Hyderabad'),
    'slug', (select public_slug from public.organizations where id = v_org));
end $$;

-- ---- 10) privileges ----------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._sample_clone_tables()', 'public._sample_snapshot(uuid)', 'public._sample_publish_ok()',
    'public.publish_sample_manifest(text)', 'public.set_current_sample_manifest(integer)', 'public.sample_manifest_status()',
    'public._sample_template_ready()', 'public._sample_safe_email(text, integer)', 'public._sample_safe_phone(text, integer)',
    'public._sample_clone_into(uuid)', 'public._demo_seed(uuid)', 'public._demo_clear(uuid)', 'public._demo_clear__pre0167(uuid)',
    'public.my_seat_usage()', 'public.trial_welcome_setup(text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.publish_sample_manifest(text)', 'public.set_current_sample_manifest(integer)',
                             'public.sample_manifest_status()', 'public._sample_clone_into(uuid)', 'public._demo_seed(uuid)',
                             'public._demo_clear(uuid)', 'public._demo_clear__pre0167(uuid)', 'public.my_seat_usage()'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- publish / status re-check is_platform_admin() inside; seats are own-studio only
    grant execute on function public.publish_sample_manifest(text) to authenticated;
    grant execute on function public.set_current_sample_manifest(integer) to authenticated;
    grant execute on function public.sample_manifest_status() to authenticated;
    grant execute on function public.my_seat_usage() to authenticated;
    grant execute on function public.trial_welcome_setup(text, text, text) to authenticated;
  end if;
end $$;

-- ---- 11) the sample dataset (India / Hyderabad / INR) in the master studio ------------------------
-- Every name starts "Demo \u00b7", every e-mail is @example.com, every phone is +91 00000 xxxxx
-- (reserved, not dialable). Dates are relative to the day this runs (helm_sample_template.anchor_date).
-- Written only where the master has no rows of that kind yet: owner edits are never overwritten.
do $$
declare
  M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001';
  d date := current_date;
  q1 uuid := 'a5a5a5a5-0167-4000-8000-0000000000a1'; q2 uuid := 'a5a5a5a5-0167-4000-8000-0000000000a2';
  q3 uuid := 'a5a5a5a5-0167-4000-8000-0000000000a3'; q4 uuid := 'a5a5a5a5-0167-4000-8000-0000000000a4';
  v_t1 numeric; v_t4 numeric; a1 numeric; a2 numeric; a3 numeric; b1 numeric; b2 numeric;
  v_layout jsonb; v_fresh boolean;
begin
  if not exists (select 1 from public.organizations o where o.id = M and o.is_sample_master) then return; end if;
  v_fresh := not exists (select 1 from public.quotes x where x.org_id = M);
  if v_fresh then
    update public.helm_sample_template set anchor_date = d, updated_at = now(),
           notes = 'Sample dataset v1 (India). Edit the master studio, then publish_sample_manifest(). Switch: active.'
     where id and org_id = M;
  end if;

  -- venues (4, Hyderabad)
  if not exists (select 1 from public.venues x where x.org_id = M) then
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                              event_types, restrictions, cost_min, cost_max, cost_basis, parking_spaces, rooms, power_backup_kw,
                              green_rooms, washrooms, address, city, contact_name, contact_phone, contact_email, notes)
    values
      (M, E'Demo \u00b7 Sitara Convention Hall', 'banquet_hall', 'ac', 'indoor', 600, 900, 60, 30, 'm',
       array['wedding','reception','engagement','corporate'], array['sound_curfew','no_fireworks'], 250000, 400000, 'per_day',
       150, 4, 250, 2, 12, E'Demo \u00b7 Plot 12, Hitech City Road, Madhapur', 'Hyderabad', E'Demo \u00b7 Hall manager',
       '+91 00000 00401', 'demo.sitara@example.com', E'Sample venue. Sound off by 10:30 pm. Pillarless hall, 2 green rooms.'),
      (M, E'Demo \u00b7 Banjara Lawns', 'lawn', 'non_ac', 'outdoor', 1000, 1500, 90, 50, 'm',
       array['wedding','reception','birthday','festival'], array['generator_required'], 180000, 300000, 'per_day',
       300, 2, 0, 1, 8, E'Demo \u00b7 Road No. 10, Jubilee Hills', 'Hyderabad', E'Demo \u00b7 Lawn manager',
       '+91 00000 00402', 'demo.banjara@example.com', E'Sample venue. Generator needed after 8 pm. Monsoon cover on request.'),
      (M, E'Demo \u00b7 Golconda Grand Ballroom', 'hotel_ballroom', 'ac', 'indoor', 400, 600, 40, 25, 'm',
       array['wedding','engagement','corporate','conference'], array['no_outside_catering','decor_vendor_tieup'], 350000, 550000, 'per_day',
       200, 120, 500, 2, 10, E'Demo \u00b7 Gachibowli Financial District', 'Hyderabad', E'Demo \u00b7 Banquet sales',
       '+91 00000 00403', 'demo.golconda@example.com', E'Sample venue. In-house catering only; corkage on outside cakes.'),
      (M, E'Demo \u00b7 Skyline Rooftop, Kondapur', 'rooftop', 'non_ac', 'outdoor', 150, 250, 30, 18, 'm',
       array['birthday','engagement','corporate'], array['sound_curfew','no_open_flame'], 80000, 150000, 'per_slot',
       40, 0, 60, 1, 4, E'Demo \u00b7 Botanical Garden Road, Kondapur', 'Hyderabad', E'Demo \u00b7 Rooftop manager',
       '+91 00000 00404', 'demo.skyline@example.com', E'Sample venue. Lift to roof; music off by 11 pm.');
  end if;

  -- vendors (8)
  if not exists (select 1 from public.vendors x where x.org_id = M) then
    insert into public.vendors(org_id, name, category, kind, phone, email, notes, active) values
      (M, E'Demo \u00b7 Gulmohar Florists', 'Florist', 'vendor', '+91 00000 00201', 'demo.florist@example.com', E'Sample vendor. Fresh flowers from Gudimalkapur market; mandap florals from Rs 45,000.', true),
      (M, E'Demo \u00b7 Deccan Sound & Lights', 'Sound & lights', 'rental', '+91 00000 00202', 'demo.sound@example.com', E'Sample vendor. Line array + DJ console; 4-hour slot Rs 35,000.', true),
      (M, E'Demo \u00b7 Charminar Clicks', 'Photography', 'freelancer', '+91 00000 00203', 'demo.photo@example.com', E'Sample vendor. Candid + traditional; wedding day Rs 85,000.', true),
      (M, E'Demo \u00b7 DJ Nawab Beats', 'DJ', 'freelancer', '+91 00000 00204', 'demo.dj@example.com', E'Sample vendor. Sangeet / reception DJ, Rs 6,000 per hour, 3 hours minimum.', true),
      (M, E'Demo \u00b7 Hussain Sagar Caterers', 'Caterer', 'vendor', '+91 00000 00205', 'demo.caterer@example.com', E'Sample vendor. Overflow catering partner for 1000+ guests.', true),
      (M, E'Demo \u00b7 Pearl City Travels', 'Transport', 'vendor', '+91 00000 00206', 'demo.transport@example.com', E'Sample vendor. Tempo travellers + guest shuttles, Rs 4,500 per vehicle per day.', true),
      (M, E'Demo \u00b7 Glam Studio Makeovers', 'Makeup', 'freelancer', '+91 00000 00207', 'demo.makeup@example.com', E'Sample vendor. Bridal HD makeup Rs 25,000; family Rs 3,500 per person.', true),
      (M, E'Demo \u00b7 Pandit Sharma Ji (sample)', 'Officiant', 'freelancer', '+91 00000 00208', 'demo.pandit@example.com', E'Sample vendor. Telugu + Hindi ceremonies; samagri arranged.', true);
  end if;

  -- staff (10, crew records only - never login users)
  if not exists (select 1 from public.crew_members x where x.org_id = M) then
    insert into public.crew_members(org_id, name, phone, email, department, role, skills, emp_type, day_rate, notes, active) values
      (M, E'Demo \u00b7 Ravi Kumar', '+91 00000 00101', 'demo.ravi@example.com', 'Operations', 'Event manager', '["planning","client handling","vendor coordination"]', 'full_time', 3500, E'Sample staff.', true),
      (M, E'Demo \u00b7 Lakshmi Prasanna', '+91 00000 00102', 'demo.lakshmi@example.com', 'Decor', 'Decor lead', '["florals","stage design","draping"]', 'full_time', 3000, E'Sample staff.', true),
      (M, E'Demo \u00b7 Imran Shaikh', '+91 00000 00103', 'demo.imran@example.com', 'Logistics', 'Logistics supervisor', '["transport","loading","inventory"]', 'full_time', 2500, E'Sample staff.', true),
      (M, E'Demo \u00b7 Sneha Reddy', '+91 00000 00104', 'demo.sneha@example.com', 'Hospitality', 'Guest coordinator', '["guest handling","RSVP","Telugu","Hindi"]', 'part_time', 1800, E'Sample staff.', true),
      (M, E'Demo \u00b7 Chef Venkat Rao', '+91 00000 00105', 'demo.venkat@example.com', 'Catering', 'Head chef', '["Hyderabadi cuisine","menu planning","food safety"]', 'full_time', 4000, E'Sample staff.', true),
      (M, E'Demo \u00b7 Arjun Naidu', '+91 00000 00106', 'demo.arjun@example.com', 'Catering', 'Banquet captain', '["service","team lead"]', 'full_time', 2200, E'Sample staff.', true),
      (M, E'Demo \u00b7 Farhan Ali', '+91 00000 00107', 'demo.farhan@example.com', 'Catering', 'Server', '["service","buffet setup"]', 'on_call', 900, E'Sample staff.', true),
      (M, E'Demo \u00b7 Kavya Menon', '+91 00000 00108', 'demo.kavya@example.com', 'Decor', 'Decorator', '["florals","lighting"]', 'part_time', 1500, E'Sample staff.', true),
      (M, E'Demo \u00b7 Suresh Yadav', '+91 00000 00109', 'demo.suresh@example.com', 'Logistics', 'Driver', '["driving","loading"]', 'full_time', 1200, E'Sample staff. Holds a commercial licence (sample).', true),
      (M, E'Demo \u00b7 Raju Goud', '+91 00000 00110', 'demo.raju@example.com', 'Logistics', 'Helper', '["loading","setup","teardown"]', 'on_call', 800, E'Sample staff.', true);
  end if;

  -- dishes (30)
  if not exists (select 1 from public.dish_catalog x where x.org_id = M) then
    insert into public.dish_catalog(org_id, category, name, kind) values
      (M, 'Welcome drinks', E'Demo \u00b7 Rose Sharbat', 'veg'), (M, 'Welcome drinks', E'Demo \u00b7 Masala Chaas', 'veg'),
      (M, 'Welcome drinks', E'Demo \u00b7 Fresh Lime Soda', 'veg'),
      (M, 'Starters', E'Demo \u00b7 Paneer Tikka', 'veg'), (M, 'Starters', E'Demo \u00b7 Hara Bhara Kebab', 'veg'),
      (M, 'Starters', E'Demo \u00b7 Corn Cheese Balls', 'veg'), (M, 'Starters', E'Demo \u00b7 Apollo Fish', 'nonveg'),
      (M, 'Starters', E'Demo \u00b7 Chicken 65', 'nonveg'), (M, 'Starters', E'Demo \u00b7 Mutton Shikampuri Kebab', 'nonveg'),
      (M, 'Main course', E'Demo \u00b7 Veg Dum Biryani', 'veg'), (M, 'Main course', E'Demo \u00b7 Hyderabadi Chicken Dum Biryani', 'nonveg'),
      (M, 'Main course', E'Demo \u00b7 Kacchi Mutton Biryani', 'nonveg'), (M, 'Main course', E'Demo \u00b7 Bagara Baingan', 'veg'),
      (M, 'Main course', E'Demo \u00b7 Mirchi ka Salan', 'veg'), (M, 'Main course', E'Demo \u00b7 Paneer Butter Masala', 'veg'),
      (M, 'Main course', E'Demo \u00b7 Dal Makhani', 'veg'), (M, 'Main course', E'Demo \u00b7 Mutton Haleem', 'nonveg'),
      (M, 'Main course', E'Demo \u00b7 Butter Chicken', 'nonveg'), (M, 'Main course', E'Demo \u00b7 Gongura Mutton', 'nonveg'),
      (M, 'Breads & rice', E'Demo \u00b7 Butter Naan', 'veg'), (M, 'Breads & rice', E'Demo \u00b7 Rumali Roti', 'veg'),
      (M, 'Breads & rice', E'Demo \u00b7 Jeera Rice', 'veg'), (M, 'Breads & rice', E'Demo \u00b7 Curd Rice', 'veg'),
      (M, 'Desserts', E'Demo \u00b7 Double ka Meetha', 'veg'), (M, 'Desserts', E'Demo \u00b7 Qubani ka Meetha', 'veg'),
      (M, 'Desserts', E'Demo \u00b7 Gulab Jamun', 'veg'), (M, 'Desserts', E'Demo \u00b7 Kesar Rasmalai', 'veg'),
      (M, 'Hi-tea', E'Demo \u00b7 Mini Samosa', 'veg'), (M, 'Hi-tea', E'Demo \u00b7 Osmania Biscuits & Irani Chai', 'veg'),
      (M, 'Live counters', E'Demo \u00b7 Live Dosa Counter', 'special');
  end if;

  -- menu packages (6: one per tier x diet)
  if not exists (select 1 from public.menu_templates x where x.org_id = M) then
    insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests) values
      (M, 'standard', 'veg', E'Demo \u00b7 Silver Veg', 650,
       E'[{"n":"Demo \u00b7 Masala Chaas","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Hara Bhara Kebab","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Dal Makhani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Butter Naan","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Curd Rice","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Gulab Jamun","c":"Desserts","k":"veg"}]',
       true, 1, E'Sample package. 2 starters, 3 mains, 1 dessert. Buffet service.', 100, 1500),
      (M, 'gold', 'veg', E'Demo \u00b7 Gold Veg', 950,
       E'[{"n":"Demo \u00b7 Rose Sharbat","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Corn Cheese Balls","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Bagara Baingan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Paneer Butter Masala","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Rumali Roti","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Double ka Meetha","c":"Desserts","k":"veg"}]',
       true, 2, E'Sample package. 3 starters, 4 mains, 2 desserts, welcome drink.', 100, 1500),
      (M, 'premium', 'veg', E'Demo \u00b7 Royal Veg', 1350,
       E'[{"n":"Demo \u00b7 Rose Sharbat","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Hara Bhara Kebab","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Live Dosa Counter","c":"Live counters","k":"special"},{"n":"Demo \u00b7 Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Mirchi ka Salan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Paneer Butter Masala","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Butter Naan","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Qubani ka Meetha","c":"Desserts","k":"veg"},{"n":"Demo \u00b7 Kesar Rasmalai","c":"Desserts","k":"veg"}]',
       true, 3, E'Sample package. Live counter, 4 starters, 5 mains, 3 desserts.', 150, 2000),
      (M, 'standard', 'nonveg', E'Demo \u00b7 Classic Non-veg', 850,
       E'[{"n":"Demo \u00b7 Fresh Lime Soda","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Chicken 65","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Hyderabadi Chicken Dum Biryani","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Butter Chicken","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Dal Makhani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Butter Naan","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Gulab Jamun","c":"Desserts","k":"veg"}]',
       true, 4, E'Sample package. 2 starters, 3 mains, 1 dessert.', 100, 1500),
      (M, 'gold', 'nonveg', E'Demo \u00b7 Nizami Non-veg', 1250,
       E'[{"n":"Demo \u00b7 Rose Sharbat","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Apollo Fish","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Chicken 65","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Hyderabadi Chicken Dum Biryani","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Mirchi ka Salan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Gongura Mutton","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Rumali Roti","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Double ka Meetha","c":"Desserts","k":"veg"}]',
       true, 5, E'Sample package. 3 starters, 4 mains, 2 desserts.', 100, 1500),
      (M, 'premium', 'nonveg', E'Demo \u00b7 Royal Nizami Feast', 1650,
       E'[{"n":"Demo \u00b7 Rose Sharbat","c":"Welcome drinks","k":"veg"},{"n":"Demo \u00b7 Apollo Fish","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Mutton Shikampuri Kebab","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Kacchi Mutton Biryani","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Mutton Haleem","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Butter Chicken","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Bagara Baingan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Butter Naan","c":"Breads & rice","k":"veg"},{"n":"Demo \u00b7 Qubani ka Meetha","c":"Desserts","k":"veg"},{"n":"Demo \u00b7 Kesar Rasmalai","c":"Desserts","k":"veg"}]',
       true, 6, E'Sample package. Royal spread: 4 starters, 5 mains, 3 desserts, live counter optional.', 150, 2000);
  end if;

  -- inventory (40) - unit_cost = rental rate per unit (Rs); replacement cost in attributes
  if not exists (select 1 from public.inventory_items x where x.org_id = M) then
    insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, attributes)
    select M, E'Demo \u00b7 ' || v.n, v.c, v.q, v.u, v.p, v.r, E'Sample item.', true, jsonb_build_object('replacement_cost', v.rc)
      from (values
        ('Chiavari chair (gold)', 'Furniture', 600, 'pcs', 'A', 45, 2200), ('Banquet chair with cover', 'Furniture', 800, 'pcs', 'A', 25, 1200),
        ('Round table 6 ft', 'Furniture', 80, 'pcs', 'A', 300, 6500), ('Rectangular table 6x2.5 ft', 'Furniture', 60, 'pcs', 'A', 200, 4500),
        ('Cocktail table (high)', 'Furniture', 30, 'pcs', 'B', 250, 5000), ('Maharaja sofa (stage)', 'Furniture', 4, 'pcs', 'A', 6000, 85000),
        ('Lounge sofa set (3 pc)', 'Furniture', 10, 'sets', 'B', 3500, 60000),
        ('Satin table cloth (ivory)', 'Linen', 120, 'pcs', 'A', 150, 900), ('Chair sash (gold)', 'Linen', 600, 'pcs', 'B', 15, 120),
        ('Table runner (maroon)', 'Linen', 100, 'pcs', 'C', 60, 350), ('Napkins (cloth)', 'Linen', 1000, 'pcs', 'C', 8, 60),
        ('Floral mandap set', 'Decor', 2, 'sets', 'A', 45000, 350000), ('Stage backdrop frame 24x10 ft', 'Decor', 3, 'sets', 'A', 15000, 120000),
        ('Brass urli with floating candles', 'Decor', 20, 'pcs', 'B', 800, 6000), ('Artificial flower wall 8x8 ft', 'Decor', 4, 'pcs', 'B', 7000, 45000),
        ('Entrance arch (floral)', 'Decor', 2, 'pcs', 'A', 9000, 70000), ('Centrepiece vase set', 'Decor', 80, 'pcs', 'C', 250, 1500),
        ('LED par light', 'Lighting', 48, 'pcs', 'A', 600, 7000), ('Moving head light', 'Lighting', 12, 'pcs', 'A', 2500, 45000),
        ('Fairy lights (10 m)', 'Lighting', 200, 'pcs', 'C', 400, 1500), ('Crystal chandelier', 'Lighting', 6, 'pcs', 'A', 8000, 90000),
        ('Uplighter (battery)', 'Lighting', 40, 'pcs', 'B', 500, 4500),
        ('Line array speaker', 'Sound & AV', 8, 'pcs', 'A', 4000, 120000), ('Cordless microphone', 'Sound & AV', 10, 'pcs', 'A', 800, 12000),
        ('LED wall panel (0.5x0.5 m)', 'Sound & AV', 64, 'pcs', 'A', 450, 18000), ('Projector + 10 ft screen', 'Sound & AV', 2, 'sets', 'B', 6000, 90000),
        ('Chafing dish (stainless)', 'Tableware', 60, 'pcs', 'A', 250, 3500), ('Dinner plate (bone china)', 'Tableware', 1200, 'pcs', 'B', 12, 220),
        ('Glass tumbler', 'Tableware', 1200, 'pcs', 'C', 6, 60), ('Cutlery set (spoon, fork, knife)', 'Tableware', 1000, 'sets', 'B', 10, 150),
        ('German hangar tent 20x30 m', 'Tents & structures', 1, 'pcs', 'A', 150000, 2500000), ('Shamiana 20x20 ft', 'Tents & structures', 6, 'pcs', 'B', 6000, 60000),
        ('Stage platform 8x4 ft', 'Tents & structures', 24, 'pcs', 'A', 1200, 15000), ('Dance floor panel 4x4 ft', 'Tents & structures', 36, 'pcs', 'B', 700, 9000),
        ('Commercial gas stove (3 burner)', 'Kitchen equipment', 6, 'pcs', 'A', 1500, 25000), ('Biryani deg (large)', 'Kitchen equipment', 10, 'pcs', 'A', 1200, 18000),
        ('Water dispenser 20 L', 'Kitchen equipment', 12, 'pcs', 'C', 300, 4000), ('Generator 125 kVA', 'Power', 2, 'pcs', 'A', 18000, 1400000),
        ('Air cooler (industrial)', 'Power', 20, 'pcs', 'B', 1500, 22000), ('Red carpet (30 m roll)', 'Decor', 4, 'pcs', 'B', 2500, 18000)
      ) v(n, c, q, u, p, r, rc);
  end if;

  -- item price list (rate cards for spec-priced items) - the shipped defaults, kept in the master
  if not exists (select 1 from public.item_rate_cards x where x.org_id = M) and to_regprocedure('public._a86_default_rates()') is not null then
    insert into public.item_rate_cards(org_id, item_type, rates)
    select M, e.key, e.value from jsonb_each(public._a86_default_rates()) e
     where e.key in ('dj','generator','stage','lighting','led','chandelier','photobooth','chocolatefountain','chariot','smoke','dancers')
    on conflict do nothing;
  end if;

  -- studio templates: checklists + staff task templates (incl. a run-sheet template)
  if not exists (select 1 from public.checklist_templates x where x.org_id = M) then
    insert into public.checklist_templates(org_id, name, section, items, notes) values
      (M, E'Demo \u00b7 Wedding logistics', 'logistics', '["Confirm hall booking and advance receipt","Book generator backup","Confirm vendor load-in times","Share run sheet with staff","Arrange guest shuttles"]', E'Sample template.'),
      (M, E'Demo \u00b7 Permissions & safety', 'compliance', '["Police NOC (3 weeks before)","Fire NOC","Sound permission till 10:30 pm","First-aid kit on site"]', E'Sample template.'),
      (M, E'Demo \u00b7 Client communication', 'comms', '["Send final menu to client","Confirm guest count (7 days before)","Share payment schedule","Thank-you message after event"]', E'Sample template.'),
      (M, E'Demo \u00b7 Guest management', 'guests', '["Share guest list template","Welcome desk + RSVP list","Elderly seating near stage","Valet + parking plan"]', E'Sample template.'),
      (M, E'Demo \u00b7 Run-sheet template (wedding day)', 'logistics', '["06:00 Venue access + decor load-in","09:00 Stage + mandap ready","11:00 Sound check","15:00 Catering setup","17:30 Welcome drinks","18:30 Baraat arrival","19:30 Muhurtham","20:30 Dinner service","22:30 Music off","23:30 Teardown starts"]', E'Sample template. Copy the times into an event run sheet.');
  end if;
  if not exists (select 1 from public.task_templates x where x.org_id = M) then
    insert into public.task_templates(org_id, category, title, seq, default_duration_min) values
      (M, 'Setup', E'Demo \u00b7 Unload truck and stage materials', 1, 90), (M, 'Setup', E'Demo \u00b7 Build stage and dance floor', 2, 180),
      (M, 'Decor', E'Demo \u00b7 Mandap florals', 1, 240), (M, 'Decor', E'Demo \u00b7 Table centrepieces + linen', 2, 120),
      (M, 'Catering', E'Demo \u00b7 Buffet counters + chafing dishes', 1, 90), (M, 'Catering', E'Demo \u00b7 Live counter setup', 2, 60),
      (M, 'AV', E'Demo \u00b7 Sound check + mic test', 1, 45), (M, 'Teardown', E'Demo \u00b7 Pack and load rentals', 1, 150)
    on conflict do nothing;
  end if;

  if not v_fresh then return; end if;

  -- leads (8: every stage; four are linked to the events below by their e-mail)
  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status) values
    (M, E'Demo \u00b7 Karthik Rao', '+91 00000 00305', 'demo.karthik@example.com', 'Google', 'Reception', d + 90, 900000, 400, E'Sample lead. Just enquired.', 'new'),
    (M, E'Demo \u00b7 Priya Varma', '+91 00000 00304', 'demo.priya@example.com', 'Walk-in', 'Birthday', d + 40, 250000, 120, E'Sample lead. Called back, budget confirmed.', 'qualified'),
    (M, E'Demo \u00b7 Neha & Sameer', '+91 00000 00307', 'demo.neha@example.com', 'Referral', 'Wedding', d + 120, 2000000, 700, E'Sample lead. Site visit at Banjara Lawns booked.', 'discovery'),
    (M, E'Demo \u00b7 Fatima Begum', '+91 00000 00306', 'demo.fatima@example.com', 'Instagram', 'Wedding', d + 75, 1200000, 450, E'Sample lead. Went with another planner.', 'lost'),
    (M, E'Demo \u00b7 Ananya Reddy', '+91 00000 00301', 'demo.ananya@example.com', 'Instagram', 'Wedding', d + 10, 1500000, 450, E'Sample lead. Booked.', 'won'),
    (M, E'Demo \u00b7 Rohit Sharma', '+91 00000 00302', 'demo.rohit@example.com', 'Referral', 'Engagement', d + 21, 600000, 220, E'Sample lead. Quote sent for approval.', 'quoted'),
    (M, E'Demo \u00b7 TechNova HR team', '+91 00000 00303', 'demo.technova@example.com', 'Website', 'Corporate', d + 30, 800000, 300, E'Sample lead. Draft quote in progress.', 'quoted'),
    (M, E'Demo \u00b7 Meera Iyer', '+91 00000 00308', 'demo.meera@example.com', 'Referral', 'Engagement', d - 10, 700000, 250, E'Sample lead. Event done and settled.', 'won');

  -- events (the quote row IS the event); totals are set by the server pricing engine (D8)
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, currency) values
    (q1, M, 'SMP-1001', E'Demo \u00b7 Ananya & Vikram Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 10, '19:00',
     E'{"name":"Demo \u00b7 Ananya Reddy","phone":"+91 00000 00301","email":"demo.ananya@example.com","city":"Hyderabad","venue":"Demo \u00b7 Sitara Convention Hall"}',
     '{"guests":450,"platePrice":1250,"chairs":450,"chairPrice":45,"other":220000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', now() - interval '12 days', 'INR'),
    (q2, M, 'SMP-1002', E'Demo \u00b7 Rohit & Meera Engagement', 'Engagement', 'quote', 'sent', 'quote', d + 21, '18:30',
     E'{"name":"Demo \u00b7 Rohit Sharma","phone":"+91 00000 00302","email":"demo.rohit@example.com","city":"Hyderabad","venue":"Demo \u00b7 Golconda Grand Ballroom"}',
     '{"guests":220,"platePrice":1350,"chairs":220,"chairPrice":45,"other":120000,"discount":15000,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, 'INR'),
    (q3, M, 'SMP-1003', E'Demo \u00b7 TechNova Annual Day', 'Corporate', 'quote', 'none', 'quote', d + 30, '17:00',
     E'{"name":"Demo \u00b7 TechNova HR team","phone":"+91 00000 00303","email":"demo.technova@example.com","city":"Hyderabad","venue":"Demo \u00b7 Skyline Rooftop, Kondapur"}',
     '{"guests":300,"platePrice":850,"chairs":300,"chairPrice":25,"other":150000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, 'INR'),
    (q4, M, 'SMP-1000', E'Demo \u00b7 Meera & Aditya Engagement', 'Engagement', 'confirmed', 'paid', 'closed', d - 10, '19:30',
     E'{"name":"Demo \u00b7 Meera Iyer","phone":"+91 00000 00308","email":"demo.meera@example.com","city":"Hyderabad","venue":"Demo \u00b7 Banjara Lawns"}',
     '{"guests":250,"platePrice":950,"chairs":250,"chairPrice":45,"other":90000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', now() - interval '40 days', 'INR');
  -- the sent quote: an approval link (each trial gets its own new token at clone time)
  update public.quotes set approval_token = gen_random_uuid(), approval_token_expires_at = now() + interval '30 days'
   where id = q2 and approval_token is null;

  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end into v_t1 from public.quotes q where q.id = q1;
  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end into v_t4 from public.quotes q where q.id = q4;
  a1 := round(coalesce(v_t1, 0) * 0.3); a2 := round(coalesce(v_t1, 0) * 0.4); a3 := coalesce(v_t1, 0) - a1 - a2;
  b1 := round(coalesce(v_t4, 0) * 0.5); b2 := coalesce(v_t4, 0) - b1;

  -- money: confirmed wedding (advance paid, 2 to go); closed engagement (fully settled). Simulated only.
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq)
  select x.q, M, x.label, x.due, x.amt, x.st, x.pa, E'Sample milestone - no money moves.', x.seq
    from (values
      (q1, 'Advance (30%)', d - 12, a1, 'paid', now() - interval '12 days', 1),
      (q1, 'Second instalment (40%)', d + 3, a2, 'invoiced', null::timestamptz, 2),
      (q1, 'Balance (30%)', d + 9, a3, 'due', null::timestamptz, 3),
      (q4, 'Advance (50%)', d - 40, b1, 'paid', now() - interval '40 days', 1),
      (q4, 'Balance (50%)', d - 12, b2, 'paid', now() - interval '12 days', 2)
    ) as x(q, label, due, amt, st, pa, seq)
   where x.amt > 0;
  insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note)
  select x.q, M, x.prov, x.amt, 'INR', 'paid', true, x.pa, x.meth, x.rc, E'Sample payment - simulated, no money moved.'
    from (values
      (q1, 'upi', a1, now() - interval '12 days', 'upi', 'SMP-R-0001'),
      (q4, 'bank', b1, now() - interval '40 days', 'bank_transfer', 'SMP-R-0002'),
      (q4, 'upi', b2, now() - interval '12 days', 'upi', 'SMP-R-0003')
    ) as x(q, prov, amt, pa, meth, rc)
   where x.amt > 0;

  -- checklist (confirmed wedding)
  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq) values
    (q1, M, 'logistics', 'Confirm hall booking with Sitara', 'Advance receipt filed.', E'Demo \u00b7 Ravi Kumar', d - 8, 'done', 1),
    (q1, M, 'logistics', 'Book generator backup (125 kVA)', null, E'Demo \u00b7 Imran Shaikh', d + 2, 'open', 2),
    (q1, M, 'compliance', 'Police and fire NOC', 'Apply 3 weeks before.', E'Demo \u00b7 Ravi Kumar', d - 3, 'done', 3),
    (q1, M, 'guests', 'Share guest list template with family', null, E'Demo \u00b7 Sneha Reddy', d + 1, 'open', 4),
    (q1, M, 'comms', 'Send final menu to client', null, E'Demo \u00b7 Chef Venkat Rao', d + 4, 'open', 5),
    (q1, M, 'teardown', 'Return rental lights to Deccan Sound', null, E'Demo \u00b7 Imran Shaikh', d + 11, 'open', 6);

  -- run sheet (15 rows, wedding day)
  insert into public.run_sheet_items(quote_id, org_id, start_time, duration_min, title, owner, location, note, seq)
  select q1, M, x.t::time, x.dur, x.title, x.own, x.loc, x.note, x.seq from (values
    ('06:00', 60, 'Venue access, decor truck unload', E'Demo \u00b7 Imran Shaikh', 'Loading bay', null, 1),
    ('07:00', 180, 'Stage, mandap and dance floor build', E'Demo \u00b7 Lakshmi Prasanna', 'Main hall', null, 2),
    ('10:00', 120, 'Florals and centrepieces', E'Demo \u00b7 Kavya Menon', 'Main hall', null, 3),
    ('11:00', 45, 'Sound check and mic test', E'Demo \u00b7 Deccan Sound & Lights', 'Stage', null, 4),
    ('12:00', 60, 'Lighting focus and chandelier check', E'Demo \u00b7 Deccan Sound & Lights', 'Main hall', null, 5),
    ('14:00', 60, 'Bride makeup begins', E'Demo \u00b7 Glam Studio Makeovers', 'Green room 1', null, 6),
    ('15:00', 120, 'Kitchen + buffet counters setup', E'Demo \u00b7 Chef Venkat Rao', 'Kitchen', null, 7),
    ('16:30', 30, 'Staff briefing', E'Demo \u00b7 Ravi Kumar', 'Lobby', 'Uniforms, radios, guest flow.', 8),
    ('17:30', 60, 'Welcome drinks + photo booth open', E'Demo \u00b7 Arjun Naidu', 'Entrance', null, 9),
    ('18:30', 45, 'Baraat arrival', E'Demo \u00b7 DJ Nawab Beats', 'Driveway', null, 10),
    ('19:30', 60, 'Muhurtham / pheras', E'Demo \u00b7 Pandit Sharma Ji (sample)', 'Mandap', null, 11),
    ('20:30', 90, 'Dinner service', E'Demo \u00b7 Arjun Naidu', 'Buffet', null, 12),
    ('21:00', 60, 'Couple photos on stage', E'Demo \u00b7 Charminar Clicks', 'Stage', null, 13),
    ('22:30', 15, 'Music off (sound curfew)', E'Demo \u00b7 Ravi Kumar', 'Stage', null, 14),
    ('23:30', 150, 'Teardown and rentals loaded', E'Demo \u00b7 Raju Goud', 'Main hall', null, 15)
  ) as x(t, dur, title, own, loc, note, seq);

  -- staff tasks (10) for the wedding, linked to sample crew / vendors
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status, assignee_kind, vendor_id, planned_start, planned_end)
  select q1, M, x.cat, x.title, x.seq, c.id, coalesce(c.name, v.name), coalesce(c.phone, v.phone), x.st,
         case when v.id is not null then 'outsourced' else 'in_house' end, v.id,
         (((d + 10) + x.st_t::time) at time zone 'Asia/Kolkata'), (((d + 10) + x.en_t::time) at time zone 'Asia/Kolkata')
    from (values
      ('Setup', 'Unload truck and stage materials', 1, E'Demo \u00b7 Imran Shaikh', null, 'accepted', '06:00', '07:00'),
      ('Setup', 'Build stage and dance floor', 2, E'Demo \u00b7 Raju Goud', null, 'accepted', '07:00', '10:00'),
      ('Decor', 'Mandap florals', 3, null, E'Demo \u00b7 Gulmohar Florists', 'assigned', '07:00', '11:00'),
      ('Decor', 'Table centrepieces and linen', 4, E'Demo \u00b7 Kavya Menon', null, 'assigned', '10:00', '12:00'),
      ('AV', 'Sound check and mic test', 5, null, E'Demo \u00b7 Deccan Sound & Lights', 'accepted', '11:00', '11:45'),
      ('Catering', 'Buffet counters and chafing dishes', 6, E'Demo \u00b7 Chef Venkat Rao', null, 'assigned', '15:00', '17:00'),
      ('Catering', 'Service team briefing', 7, E'Demo \u00b7 Arjun Naidu', null, 'assigned', '16:30', '17:00'),
      ('Guests', 'Welcome desk and RSVP list', 8, E'Demo \u00b7 Sneha Reddy', null, 'accepted', '17:00', '19:00'),
      ('Logistics', 'Guest shuttle from Hitech City metro', 9, null, E'Demo \u00b7 Pearl City Travels', 'assigned', '17:00', '20:00'),
      ('Teardown', 'Pack and load rentals', 10, E'Demo \u00b7 Suresh Yadav', null, 'unassigned', '23:30', '23:59')
    ) as x(cat, title, seq, crew, vend, st, st_t, en_t)
    left join public.crew_members c on c.org_id = M and c.name = x.crew
    left join public.vendors v on v.org_id = M and v.name = x.vend;

  -- inventory reserved for the wedding
  insert into public.inventory_reservations(item_id, quote_id, org_id, qty, status, note)
  select i.id, q1, M, x.qty, 'reserved', E'Sample reservation.'
    from (values ('Chiavari chair (gold)', 450), ('Round table 6 ft', 56), ('LED par light', 24), ('Floral mandap set', 1), ('Chafing dish (stainless)', 30)) x(n, qty)
    join public.inventory_items i on i.org_id = M and i.name = E'Demo \u00b7 ' || x.n;

  -- settlement for the closed engagement: costs + closure
  insert into public.event_costs(quote_id, org_id, category, description, kind, estimated, actual, note) values
    (q4, M, 'Decor', 'Florals and stage (Gulmohar Florists)', 'vendor', 85000, 82000, E'Sample cost.'),
    (q4, M, 'Sound', 'Sound and DJ (Deccan Sound & Lights)', 'vendor', 40000, 40000, E'Sample cost.'),
    (q4, M, 'Staff', 'Crew day rates', 'internal', 30000, 28500, E'Sample cost.');
  insert into public.event_closure(quote_id, org_id, client_rating, feedback, testimonial, media_consent, lessons, closed_at)
  values (q4, M, 5, 'Sample feedback: smooth evening, food was the highlight.', 'Sample testimonial: the team handled everything on the day.',
          true, 'Sample lesson: book the generator one week earlier.', now() - interval '5 days')
  on conflict do nothing;

  -- the wedding floor layout: the event's layout version (opens in the builder from the event).
  -- (public.layouts always stamps the caller's studio, so the layout lives on the event version only)
  v_layout := jsonb_build_object(
    'items', jsonb_build_array(
      jsonb_build_object('id','smp-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label','Main stage','properties','{}'::jsonb),
      jsonb_build_object('id','smp-mandap','type','mandap','category','decor','x',92,'y',26,'width',16,'height',16,'rotation',0,'label','Mandap','properties','{}'::jsonb),
      jsonb_build_object('id','smp-dance','type','dancefloor','category','structure','x',88,'y',48,'width',24,'height',24,'rotation',0,'label','Dance floor','properties','{}'::jsonb),
      jsonb_build_object('id','smp-t1','type','table','category','seating','x',30,'y',40,'width',6,'height',6,'rotation',0,'label','Table 1','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t2','type','table','category','seating','x',44,'y',40,'width',6,'height',6,'rotation',0,'label','Table 2','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t3','type','table','category','seating','x',58,'y',40,'width',6,'height',6,'rotation',0,'label','Table 3','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t4','type','table','category','seating','x',30,'y',56,'width',6,'height',6,'rotation',0,'label','Table 4','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t5','type','table','category','seating','x',44,'y',56,'width',6,'height',6,'rotation',0,'label','Table 5','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t6','type','table','category','seating','x',58,'y',56,'width',6,'height',6,'rotation',0,'label','Table 6','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t7','type','table','category','seating','x',136,'y',40,'width',6,'height',6,'rotation',0,'label','Table 7','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t8','type','table','category','seating','x',150,'y',40,'width',6,'height',6,'rotation',0,'label','Table 8','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t9','type','table','category','seating','x',164,'y',40,'width',6,'height',6,'rotation',0,'label','Table 9','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t10','type','table','category','seating','x',136,'y',56,'width',6,'height',6,'rotation',0,'label','Table 10','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t11','type','table','category','seating','x',150,'y',56,'width',6,'height',6,'rotation',0,'label','Table 11','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-t12','type','table','category','seating','x',164,'y',56,'width',6,'height',6,'rotation',0,'label','Table 12','properties',jsonb_build_object('seats',8)),
      jsonb_build_object('id','smp-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label','Veg buffet','properties','{}'::jsonb),
      jsonb_build_object('id','smp-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label','Non-veg buffet','properties','{}'::jsonb),
      jsonb_build_object('id','smp-photo','type','photobooth','category','av','x',20,'y',10,'width',8,'height',8,'rotation',0,'label','Photo booth','properties','{}'::jsonb),
      jsonb_build_object('id','smp-carpet','type','redcarpet','category','structure','x',97,'y',100,'width',6,'height',30,'rotation',0,'label','Aisle','properties','{}'::jsonb),
      jsonb_build_object('id','smp-exit1','type','exit','category','safety','x',0,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb),
      jsonb_build_object('id','smp-exit2','type','exit','category','safety','x',188,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb)),
    'grid', jsonb_build_object('snap', true, 'show', true, 'unit', 'ft', 'sizeFt', 2),
    'margins', jsonb_build_object('left', 0, 'right', 0, 'top', 0, 'bottom', 0),
    'venue', jsonb_build_object('capacity', 600),
    'scale', jsonb_build_object('pxPerFt', 12, 'worldFt', jsonb_build_object('w', 200, 'h', 140)));
  insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id)
  values (q1, 1, 'Sample layout', v_layout, jsonb_array_length(v_layout -> 'items'), M)
  on conflict do nothing;

  -- nurture contacts (6) - never messaged (undeliverable contacts + trial outbound block)
  insert into public.nurture(org_id, name, phone, email, occasion, occasion_type, occasion_date, next_followup, note, status, auto_on, source) values
    (M, E'Demo \u00b7 Meera Iyer', '+91 00000 00308', 'demo.meera@example.com', 'Engagement anniversary', 'anniversary', d + 355, d + 340, E'Sample contact. Past client (5 stars).', 'won', false, 'event'),
    (M, E'Demo \u00b7 Srinivas Murthy', '+91 00000 00501', 'demo.srinivas@example.com', 'Daughter''s birthday', 'birthday', d + 25, d + 10, E'Sample contact. Did a 1st birthday last year.', 'active', false, 'manual'),
    (M, E'Demo \u00b7 Ayesha Khan', '+91 00000 00502', 'demo.ayesha@example.com', 'Wedding anniversary', 'anniversary', d + 60, d + 45, E'Sample contact.', 'active', false, 'manual'),
    (M, E'Demo \u00b7 Vamshi Krishna', '+91 00000 00503', 'demo.vamshi@example.com', 'Housewarming follow-up', 'custom', d + 15, d + 5, E'Sample contact. Asked about a gruhapravesam package.', 'active', false, 'lead'),
    (M, E'Demo \u00b7 Deepa Nair', '+91 00000 00504', 'demo.deepa@example.com', 'Son''s birthday', 'birthday', d + 120, d + 100, E'Sample contact.', 'dormant', false, 'manual'),
    (M, E'Demo \u00b7 Rahul Jain', '+91 00000 00505', 'demo.rahul@example.com', 'Company Diwali party', 'custom', d + 30, d + 7, E'Sample contact. Corporate repeat client.', 'active', false, 'manual');
end $$;

-- ---- 12) publish v1 once from the master (the switch stays OFF) ---------------------------------
do $$ begin
  if not exists (select 1 from public.helm_trial_seed_manifest)
     and exists (select 1 from public.quotes x where x.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'::uuid) then
    perform public.publish_sample_manifest('v1: India sample dataset shipped with 0167');
  end if;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 organizations sample columns', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'organizations'
       and column_name in ('is_sample_master', 'seat_limit', 'sample_cloned_at', 'sample_source_org', 'sample_batch_id', 'sample_version')) = 6),
  ('02 switch row present', exists (select 1 from public.helm_sample_template where id)),
  ('03 RLS on helm_sample_template', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.helm_sample_template')), false)),
  ('04 RLS on trial_sample_runs', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.trial_sample_runs')), false)),
  ('05 sample master studio', exists (select 1 from public.organizations where id = 'a5a5a5a5-0166-4000-8000-000000000001' and is_sample_master)),
  ('06 seed functions wrapped', to_regprocedure('public._demo_seed__pre0166(uuid)') is not null
       and to_regprocedure('public._trial_seed_extra__pre0166(uuid)') is not null and to_regprocedure('public._trial_seed_custom__pre0166(uuid)') is not null),
  ('07 clone not callable by the app', not has_function_privilege('authenticated', 'public._sample_clone_into(uuid)', 'execute')
       and not has_function_privilege('anon', 'public._sample_clone_into(uuid)', 'execute')),
  ('08 clear_sample_data callable by signed-in users only', has_function_privilege('authenticated', 'public.clear_sample_data()', 'execute')
       and not has_function_privilege('anon', 'public.clear_sample_data()', 'execute')),
  ('09 seat limit triggers', (select count(*) from pg_trigger where tgname = 'zzzz_ts166_seat_limit') = 2),
  ('10 outbox skip triggers', (select count(*) from pg_trigger where tgname = 'zzzz_ts166_outbox_skip') = 3),
  ('11 0166 marker', position('trial-sandbox-0166' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._sample_clone_into(uuid)'))) > 0),
  ('12 manifest table + RLS', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.helm_trial_seed_manifest')), false)),
  ('13 manifest v1 current', exists (select 1 from public.helm_trial_seed_manifest where is_current)),
  ('14 sample dataset in the master only (40 items, 4 events)', (select count(*) from public.inventory_items where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 40
       and (select count(*) from public.quotes where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 4),
  ('15 switch still OFF', not coalesce((select active from public.helm_sample_template where id), false)),
  ('16 clone seeds from the manifest (0167 marker)', position('trial-sample-0167' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._sample_clone_into(uuid)'))) > 0),
  ('17 clear wrapped (pre kept)', to_regprocedure('public._demo_clear__pre0167(uuid)') is not null),
  ('18 is_demo on nurture/checklist/task templates', (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'is_demo'
       and table_name in ('nurture', 'checklist_templates', 'task_templates')) = 3),
  ('19 app grants: seats + welcome yes, clone/manifest table no', has_function_privilege('authenticated', 'public.my_seat_usage()', 'execute')
       and has_function_privilege('authenticated', 'public.trial_welcome_setup(text, text, text)', 'execute')
       and not has_function_privilege('anon', 'public.my_seat_usage()', 'execute')
       and not has_table_privilege('authenticated', 'public.helm_trial_seed_manifest', 'select'))
) v(item, ok) order by item;
