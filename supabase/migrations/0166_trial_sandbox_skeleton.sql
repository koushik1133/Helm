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
