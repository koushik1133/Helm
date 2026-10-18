-- APPLY-0185.sql - paste into the Supabase SQL editor (staging first, then production).
-- Additive + idempotent: the upgrade data choice (keep sample data [default] / remove sample data / start
-- completely clean = archive, never delete), "Delete all sample data" (is_demo rows only) and restore.
-- Changes no row when it runs. Paid studios that never were a trial are unaffected. Safe to run twice.
begin;
-- ============================================================================
-- 0185_trial_upgrade_choice.sql - CANONICAL forward-only. REQUIRES 0040 (quote Archive shelf),
-- 0097 (is_demo, _demo_clear), 0127 (demo_choice), 0166 (_is_trial_org, sample master),
-- 0167 + 0169 (_demo_clear wrappers).
--
-- In plain words (owner post-trial policy items 4 + 5, docs/trial/POST-TRIAL-POLICY.md):
--   WHEN A FREE-TRIAL STUDIO UPGRADES, the studio admin chooses what happens to the data:
--     keep           (default) keep the sample data. Every sample row stays is_demo = true, so it
--                    keeps its "Sample" badge for good and "Delete all sample data" can still find it.
--     remove_sample  remove ONLY the sample rows (is_demo, the same _demo_clear the trial already
--                    uses); every record the studio added itself stays.
--     clean          start completely clean: the sample rows go as in remove_sample, and EVERY record
--                    of the studio's own is ARCHIVED - never deleted:
--                      events / quotes      -> the existing Archive shelf (quotes.archived_at, 0040;
--                                              Restore button in Quotes > Archive)
--                      inventory, vendors, staff (not linked to a login), venues, menu packages,
--                      dishes                -> switched off (active = false, the app's own "remove")
--                      leads, follow-ups (nurture), saved floor layouts
--                                           -> new nullable clean_archived_at; a RESTRICTIVE RLS policy
--                                              hides those rows from the app (no permissive policy is
--                                              widened, nothing becomes visible that was not)
--                    Every archived row is written to studio_clean_start_items (studio, batch, table,
--                    row id) so restore_clean_start() puts all of it back in one step. Settings, team
--                    members, plan + billing, templates and the price list are not touched.
--                    The server needs the typed phrase START CLEAN (the app also asks twice).
--   The choice is made once, only by an admin of the studio's OWN org (current_org_id()), only when
--   the studio started as a trial (its subscription / studio carries trial history) and is NO LONGER
--   in trial (public._is_trial_org() false - studio_subscriptions.status, never trial_ends_at) and is
--   on a paid / active plan. Paid studios that never were a trial are refused and unaffected.
--   Safety for sample events the studio really used after upgrading: a sample event with the
--   studio's own payments, a real OTP approval, refunds or uploaded files is ADOPTED (is_demo ->
--   false) before any clear in a non-trial studio, so it is kept with those records.
--   Control Center: delete_all_sample_data() - admin, own studio, is_demo rows only (_demo_clear).
--   my_upgrade_status() - read-only state for the dashboard / Control Center / checkout cards.
--
--   Changes: 3 nullable columns on organizations (+ a check + an API guard trigger), 1 nullable
--   column + 1 partial index + 1 restrictive policy on leads / nurture / layouts, 1 new table
--   (RLS on, no tenant policy, definer RPCs only, 0045 read-only guard), 10 new functions. No existing function replaced,
--   no row changed by this migration. No DROP TABLE / DROP COLUMN / TRUNCATE; the only row
--   removals anywhere are the existing _demo_clear of is_demo (sample) rows, on an admin's choice.
--   Additive + idempotent: safe to run twice. ASCII only.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._demo_clear(uuid)') is null or to_regprocedure('public._is_trial_org(uuid)') is null
     or to_regprocedure('public.trial_demo_choice(text)') is null or to_regprocedure('public._trial_locked(uuid)') is null
     or to_regprocedure('public._trial_paid(uuid)') is null or to_regprocedure('public._studio_writable(uuid)') is null
     or to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception '0185: apply 0040, 0097, 0116, 0127, 0166, 0167 and 0169 first'; end if;
end $$;

-- ---- 1) the choice on the studio (3 nullable columns) ------------------------------------------
alter table public.organizations add column if not exists upgrade_choice text;
alter table public.organizations add column if not exists upgrade_choice_at timestamptz;
alter table public.organizations add column if not exists upgrade_choice_by uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass
                  and conname = 'organizations_upgrade_choice_chk185') then
    alter table public.organizations add constraint organizations_upgrade_choice_chk185
      check (upgrade_choice is null or upgrade_choice in ('keep', 'remove_sample', 'clean'));
  end if;
end $$;

-- the app roles can read these columns but never write them (only the functions below may)
create or replace function public._tu185_tg_choice_guard()
returns trigger language plpgsql set search_path = '' as $$
-- trial-upgrade-0185
begin
  if current_user in ('anon', 'authenticated')
     and (new.upgrade_choice, new.upgrade_choice_at, new.upgrade_choice_by)
         is distinct from (old.upgrade_choice, old.upgrade_choice_at, old.upgrade_choice_by) then
    raise exception 'the upgrade data choice is made through the upgrade screen only' using errcode = '42501';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname = 'zz_tu185_choice_guard') then
    create trigger zz_tu185_choice_guard before update of upgrade_choice, upgrade_choice_at, upgrade_choice_by
      on public.organizations for each row execute function public._tu185_tg_choice_guard();
  end if;
end $$;

-- ---- 2) soft archive flag where a list has no flag of its own ----------------------------------
alter table public.leads   add column if not exists clean_archived_at timestamptz;
alter table public.nurture add column if not exists clean_archived_at timestamptz;
alter table public.layouts add column if not exists clean_archived_at timestamptz;
create index if not exists leads_clean_archived_idx185   on public.leads (org_id)   where clean_archived_at is not null;
create index if not exists nurture_clean_archived_idx185 on public.nurture (org_id) where clean_archived_at is not null;
create index if not exists layouts_clean_archived_idx185 on public.layouts (org_id) where clean_archived_at is not null;

-- RESTRICTIVE: an archived row is invisible and read-only for every app role; nobody can set the
-- flag through the API (with check). It only ever narrows what the existing policies allow.
do $$ declare t text; begin
  foreach t in array array['leads', 'nurture', 'layouts'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'helm_clean_archive_185') then
      execute format('create policy helm_clean_archive_185 on public.%I as restrictive for all to public '
                     'using (clean_archived_at is null) with check (clean_archived_at is null)', t);
    end if;
  end loop;
end $$;

-- ---- 3) the archive journal: one row per archived record (definer RPCs only) --------------------
create table if not exists public.studio_clean_start_items (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations(id),
  batch_id    uuid not null,
  tbl         text not null,
  row_id      uuid not null,
  archived_at timestamptz not null default now(),
  archived_by uuid,
  restored_at timestamptz,
  restored_by uuid,
  constraint studio_clean_start_items_tbl_chk185 check (tbl in ('quotes', 'leads', 'nurture', 'layouts', 'inventory_items',
    'vendors', 'crew_members', 'venues', 'menu_templates', 'dish_catalog')),
  constraint studio_clean_start_items_uq185 unique (batch_id, tbl, row_id)
);
create index if not exists studio_clean_start_items_org_idx185 on public.studio_clean_start_items (org_id, restored_at);
alter table public.studio_clean_start_items enable row level security;
-- like every studio table: no write while the studio is suspended / read-only (0045 guard)
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.studio_clean_start_items'::regclass and tgname = 'zzz_studio_read_only') then
    create trigger zzz_studio_read_only before insert or update or delete on public.studio_clean_start_items
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;
revoke all on public.studio_clean_start_items from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.studio_clean_start_items from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.studio_clean_start_items from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on public.studio_clean_start_items to service_role; end if;
end $$;

-- ---- 4) helpers -----------------------------------------------------------------------------------
-- the studio is past its trial and on a working plan (active, or a paid period that is overdue)
create or replace function public._tu185_converted(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-upgrade-0185: "in trial" comes from the subscription (_is_trial_org), never trial_ends_at
  select p_org is not null
     and not public._is_trial_org(p_org)
     and not public._trial_locked(p_org)
     and public._studio_writable(p_org)
     and (exists (select 1 from public.studio_subscriptions s where s.org_id = p_org
                   and (s.status = 'active' or (s.status = 'past_due' and s.current_period_end is not null)))
          or public._trial_paid(p_org));
$$;

-- the studio STARTED as a free trial (history only - not "is it in trial now", see _tu185_converted)
create or replace function public._tu185_was_trial(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-upgrade-0185
  select p_org is not null
     and not exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master)
     and (exists (select 1 from public.studio_subscriptions s where s.org_id = p_org
                   and (s.trial_ends_at is not null or s.trial_source is not null))
          or exists (select 1 from public.organizations o where o.id = p_org and o.trial_mode is not null));
$$;

-- a SAMPLE event the studio really used is adopted (kept as its own) before any clear
create or replace function public._tu185_adopt_used_samples(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185: own payments / a real OTP approval / refunds / uploads keep the event
declare n integer := 0;
begin
  if p_org is null then return 0; end if;
  update public.quotes q set is_demo = false
   where q.org_id = p_org and q.is_demo
     and (exists (select 1 from public.quote_payments p where p.quote_id = q.id and p.org_id = p_org
                   and not p.is_demo and p.status in ('paid', 'refunded'))
       or exists (select 1 from public.payment_milestones m where m.quote_id = q.id and m.org_id = p_org
                   and not m.is_demo and m.status = 'paid')
       or exists (select 1 from public.quote_consents c where c.quote_id = q.id and c.verified_via_otp)
       or exists (select 1 from public.event_refunds r where r.quote_id = q.id)
       or exists (select 1 from public.event_files f where f.quote_id = q.id)
       or exists (select 1 from public.event_media md where md.quote_id = q.id));
  get diagnostics n = row_count;
  return n;
end $$;

-- "start completely clean": archive (never delete) every own record of ONE studio, journaled
create or replace function public._tu185_archive_own(p_org uuid, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185: soft only - Archive shelf / active = false / clean_archived_at
declare v_batch uuid := gen_random_uuid(); v_out jsonb := '{}'::jsonb; n integer;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master) then
    raise exception 'the sample master is never archived' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:clean_start:' || p_org::text, 0));

  -- events / quotes -> the 0040 Archive shelf (Restore in Quotes > Archive)
  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'quotes', q.id, p_actor from public.quotes q
     where q.org_id = p_org and not q.is_demo and q.archived_at is null and q.deleted_at is null;
  update public.quotes q set archived_at = now(), archived_by = p_actor, archived_reason = 'manual'
   where q.org_id = p_org and q.archived_at is null and q.deleted_at is null
     and q.id in (select i.row_id from public.studio_clean_start_items i
                   where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'quotes');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('events', n);

  -- leads / follow-ups / saved floor layouts -> clean_archived_at (hidden by helm_clean_archive_185)
  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'leads', x.id, p_actor from public.leads x
     where x.org_id = p_org and not x.is_demo and x.clean_archived_at is null;
  update public.leads x set clean_archived_at = now()
   where x.org_id = p_org and x.clean_archived_at is null
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'leads');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('leads', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'nurture', x.id, p_actor from public.nurture x
     where x.org_id = p_org and not x.is_demo and x.clean_archived_at is null;
  update public.nurture x set clean_archived_at = now()
   where x.org_id = p_org and x.clean_archived_at is null
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'nurture');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('nurture', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'layouts', x.id, p_actor from public.layouts x
     where x.org_id = p_org and not x.is_demo and x.clean_archived_at is null;
  update public.layouts x set clean_archived_at = now()
   where x.org_id = p_org and x.clean_archived_at is null
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'layouts');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('layouts', n);

  -- master lists -> switched off (the app's own "remove"; a staff row linked to a login stays)
  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'inventory_items', x.id, p_actor from public.inventory_items x
     where x.org_id = p_org and not x.is_demo and x.active;
  update public.inventory_items x set active = false
   where x.org_id = p_org and x.active
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'inventory_items');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('inventory', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'vendors', x.id, p_actor from public.vendors x
     where x.org_id = p_org and not x.is_demo and x.active;
  update public.vendors x set active = false
   where x.org_id = p_org and x.active
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'vendors');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('vendors', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'crew_members', x.id, p_actor from public.crew_members x
     where x.org_id = p_org and not x.is_demo and x.active and x.profile_id is null;
  update public.crew_members x set active = false
   where x.org_id = p_org and x.active and x.profile_id is null
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'crew_members');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('staff', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'venues', x.id, p_actor from public.venues x
     where x.org_id = p_org and not x.is_demo and x.active;
  update public.venues x set active = false
   where x.org_id = p_org and x.active
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'venues');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('venues', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'menu_templates', x.id, p_actor from public.menu_templates x
     where x.org_id = p_org and not x.is_demo and x.active;
  update public.menu_templates x set active = false
   where x.org_id = p_org and x.active
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'menu_templates');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('packages', n);

  insert into public.studio_clean_start_items(org_id, batch_id, tbl, row_id, archived_by)
    select p_org, v_batch, 'dish_catalog', x.id, p_actor from public.dish_catalog x
     where x.org_id = p_org and not x.is_demo and x.active;
  update public.dish_catalog x set active = false
   where x.org_id = p_org and x.active
     and x.id in (select i.row_id from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch and i.tbl = 'dish_catalog');
  get diagnostics n = row_count; v_out := v_out || jsonb_build_object('dishes', n);

  return v_out || jsonb_build_object('batch_id', v_batch,
    'total', (select count(*) from public.studio_clean_start_items i where i.org_id = p_org and i.batch_id = v_batch));
end $$;

-- put every archived record of ONE studio back (rows the studio already changed stay as they are)
create or replace function public._tu185_restore_own(p_org uuid, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185: undo of _tu185_archive_own; a row that would clash with a newer one is skipped
declare it record; n_ok integer := 0; n_skip integer := 0; n integer;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:clean_start:' || p_org::text, 0));
  for it in select i.id, i.tbl, i.row_id from public.studio_clean_start_items i
             where i.org_id = p_org and i.restored_at is null order by i.id loop
    begin
      n := 0;
      if it.tbl = 'quotes' then
        update public.quotes q set archived_at = null, archived_by = null, archived_reason = null, shelf_restored_at = now()
         where q.id = it.row_id and q.org_id = p_org and q.archived_at is not null and q.deleted_at is null;
      elsif it.tbl = 'leads' then
        update public.leads x set clean_archived_at = null where x.id = it.row_id and x.org_id = p_org and x.clean_archived_at is not null;
      elsif it.tbl = 'nurture' then
        update public.nurture x set clean_archived_at = null where x.id = it.row_id and x.org_id = p_org and x.clean_archived_at is not null;
      elsif it.tbl = 'layouts' then
        update public.layouts x set clean_archived_at = null where x.id = it.row_id and x.org_id = p_org and x.clean_archived_at is not null;
      elsif it.tbl = 'inventory_items' then
        update public.inventory_items x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      elsif it.tbl = 'vendors' then
        update public.vendors x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      elsif it.tbl = 'crew_members' then
        update public.crew_members x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      elsif it.tbl = 'venues' then
        update public.venues x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      elsif it.tbl = 'menu_templates' then
        update public.menu_templates x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      elsif it.tbl = 'dish_catalog' then
        update public.dish_catalog x set active = true where x.id = it.row_id and x.org_id = p_org and not x.active;
      end if;
      get diagnostics n = row_count;
      update public.studio_clean_start_items i set restored_at = now(), restored_by = p_actor where i.id = it.id;
      n_ok := n_ok + n;
    exception when unique_violation or check_violation then
      n_skip := n_skip + 1;          -- e.g. a newer active row with the same name: left archived
    end;
  end loop;
  return jsonb_build_object('restored', n_ok, 'skipped', n_skip);
end $$;

-- ---- 5) the studio's state for the app (read-only) ------------------------------------------------
create or replace function public.my_upgrade_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-upgrade-0185: own studio only; any member except a client may read it, only admins act
declare v_org uuid := public.current_org_id(); o public.organizations; v_admin boolean;
  v_sample jsonb; v_own jsonb; v_st integer; v_ot integer; v_arch integer; v_conv boolean; v_was boolean; v_trial boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org;
  v_admin := coalesce(public.is_admin(), false);
  v_trial := public._is_trial_org(v_org);
  v_conv := public._tu185_converted(v_org);
  v_was := public._tu185_was_trial(v_org);
  v_sample := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and is_demo),
    'leads',     (select count(*) from public.leads where org_id = v_org and is_demo),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and is_demo and active),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and is_demo),
    'nurture',   (select count(*) from public.nurture where org_id = v_org and is_demo));
  v_own := jsonb_build_object(
    'events',    (select count(*) from public.quotes where org_id = v_org and not is_demo and archived_at is null and deleted_at is null),
    'leads',     (select count(*) from public.leads where org_id = v_org and not is_demo and clean_archived_at is null),
    'staff',     (select count(*) from public.crew_members where org_id = v_org and not is_demo and active and profile_id is null),
    'vendors',   (select count(*) from public.vendors where org_id = v_org and not is_demo and active),
    'inventory', (select count(*) from public.inventory_items where org_id = v_org and not is_demo and active),
    'venues',    (select count(*) from public.venues where org_id = v_org and not is_demo and active),
    'packages',  (select count(*) from public.menu_templates where org_id = v_org and not is_demo and active),
    'dishes',    (select count(*) from public.dish_catalog where org_id = v_org and not is_demo and active),
    'layouts',   (select count(*) from public.layouts where org_id = v_org and not is_demo and clean_archived_at is null),
    'nurture',   (select count(*) from public.nurture where org_id = v_org and not is_demo and clean_archived_at is null));
  select coalesce(sum(e.value::integer), 0) into v_st from jsonb_each_text(v_sample) e;
  select coalesce(sum(e.value::integer), 0) into v_ot from jsonb_each_text(v_own) e;
  select count(*) into v_arch from public.studio_clean_start_items i where i.org_id = v_org and i.restored_at is null;
  return jsonb_build_object(
    'is_admin', v_admin, 'in_trial', v_trial, 'converted', v_conv, 'was_trial', v_was,
    'choice', o.upgrade_choice, 'choice_at', o.upgrade_choice_at, 'legacy_choice', o.demo_choice,
    'pending', v_admin and v_conv and v_was and not coalesce(o.is_sample_master, false)
               and o.upgrade_choice is null and o.demo_choice is null and (v_st + v_ot) > 0,
    'has_sample', v_st > 0, 'sample', v_sample, 'sample_total', v_st,
    'own', v_own, 'own_total', v_ot,
    'archived', v_arch, 'can_restore', v_admin and v_arch > 0 and v_conv,
    'confirm_phrase', 'START CLEAN');
end $$;

-- ---- 6) the choice (admin, own studio, once, after upgrading) -----------------------------------
create or replace function public.upgrade_data_choice(p_choice text, p_confirm text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185: keep | remove_sample (is_demo rows only) | clean (sample removed, own records ARCHIVED)
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid();
  v_choice text := lower(btrim(coalesce(p_choice, ''))); o public.organizations;
  v_adopt integer := 0; r_clear jsonb := null; r_arch jsonb := null;
begin
  if v_uid is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_choice not in ('keep', 'remove_sample', 'clean') then
    raise exception 'Choose keep, remove_sample or clean.' using errcode = '22023', hint = 'upgrade_choice'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:upgrade_choice:' || v_org::text, 0));
  select * into o from public.organizations x where x.id = v_org for update;
  if o.id is null or o.is_sample_master then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._tu185_was_trial(v_org) then
    raise exception 'Only a studio that started as a free trial makes this choice.' using errcode = '22023', hint = 'upgrade_not_trial'; end if;
  if not public._tu185_converted(v_org) then
    raise exception 'Choose a plan first - you decide about the sample data once the plan is active.'
      using errcode = '22023', hint = 'upgrade_not_converted'; end if;
  if o.upgrade_choice is not null then          -- once: a second click / tab changes nothing
    return jsonb_build_object('result', 'already', 'choice', o.upgrade_choice, 'at', o.upgrade_choice_at); end if;
  if v_choice = 'clean' and upper(btrim(coalesce(p_confirm, ''))) <> 'START CLEAN' then
    raise exception 'Type START CLEAN to confirm starting completely clean.' using errcode = '22023', hint = 'upgrade_confirm'; end if;

  if v_choice in ('remove_sample', 'clean') then
    v_adopt := public._tu185_adopt_used_samples(v_org);   -- a sample event you really used is kept as yours
    r_clear := public._demo_clear(v_org);                  -- ONLY this studio's is_demo rows
  end if;
  if v_choice = 'clean' then
    r_arch := public._tu185_archive_own(v_org, v_uid);     -- own records: archived, never deleted
  end if;

  update public.organizations x set upgrade_choice = v_choice, upgrade_choice_at = now(), upgrade_choice_by = v_uid,
         demo_choice = coalesce(x.demo_choice, case when v_choice = 'keep' then 'keep' else 'fresh' end),
         demo_choice_at = coalesce(x.demo_choice_at, now()),
         trial_mode = case when v_choice = 'keep' then x.trial_mode else 'own' end
   where x.id = v_org;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'trial.upgrade_choice',
           'organizations', v_org::text,
           jsonb_build_object('choice', v_choice, 'adopted', v_adopt, 'cleared', r_clear, 'archived', r_arch - 'batch_id'),
           v_org, now();
  return jsonb_build_object('result', 'ok', 'choice', v_choice, 'kept_in_use', v_adopt,
                            'cleared', r_clear, 'archived', r_arch);
end $$;

-- ---- 7) Control Center: "Delete all sample data" (is_demo rows only) -----------------------------
create or replace function public.delete_all_sample_data()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185: admin, own studio, ONLY is_demo rows (_demo_clear); own records never touched
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); o public.organizations;
  v_adopt integer := 0; r jsonb;
begin
  if v_uid is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org for update;
  if o.id is null or o.is_sample_master then raise exception 'not authorized' using errcode = '42501'; end if;
  -- after upgrading, a sample event with your own payments / approval / files is kept as yours
  if not public._is_trial_org(v_org) then v_adopt := public._tu185_adopt_used_samples(v_org); end if;
  r := public._demo_clear(v_org);
  update public.organizations x set trial_mode = 'own' where x.id = v_org and x.trial_mode = 'demo';
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'sample.deleted_all',
           'organizations', v_org::text, jsonb_build_object('cleared', r, 'adopted', v_adopt), v_org, now();
  return jsonb_build_object('result', 'ok', 'cleared', r, 'kept_in_use', v_adopt);
end $$;

-- ---- 8) restore everything "start completely clean" archived (admin, own studio) -----------------
create or replace function public.restore_clean_start()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-upgrade-0185
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); r jsonb;
begin
  if v_uid is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if exists (select 1 from public.organizations o where o.id = v_org and o.is_sample_master) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.studio_clean_start_items i where i.org_id = v_org and i.restored_at is null) then
    return jsonb_build_object('result', 'nothing', 'restored', 0, 'skipped', 0); end if;
  r := public._tu185_restore_own(v_org, v_uid);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'trial.clean_start_restored',
           'organizations', v_org::text, r, v_org, now();
  return jsonb_build_object('result', 'ok') || r;
end $$;

-- ---- 9) privileges ---------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._tu185_tg_choice_guard()', 'public._tu185_converted(uuid)', 'public._tu185_was_trial(uuid)',
                           'public._tu185_adopt_used_samples(uuid)', 'public._tu185_archive_own(uuid, uuid)',
                           'public._tu185_restore_own(uuid, uuid)',
                           'public.my_upgrade_status()', 'public.upgrade_data_choice(text, text)',
                           'public.delete_all_sample_data()', 'public.restore_clean_start()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  end loop;
  foreach f in array array['public._tu185_tg_choice_guard()', 'public._tu185_converted(uuid)', 'public._tu185_was_trial(uuid)',
                           'public._tu185_adopt_used_samples(uuid)', 'public._tu185_archive_own(uuid, uuid)',
                           'public._tu185_restore_own(uuid, uuid)'] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  foreach f in array array['public.my_upgrade_status()', 'public.upgrade_data_choice(text, text)',
                           'public.delete_all_sample_data()', 'public.restore_clean_start()'] loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 columns added (choice on studio, archive flag on leads / nurture / layouts)',
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'organizations'
        and column_name in ('upgrade_choice', 'upgrade_choice_at', 'upgrade_choice_by')) = 3
      and (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'clean_archived_at'
        and table_name in ('leads', 'nurture', 'layouts')) = 3),
  ('02 choice check + API guard trigger',
      exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_upgrade_choice_chk185')
      and exists (select 1 from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname = 'zz_tu185_choice_guard' and tgenabled <> 'D')),
  ('03 restrictive archive policy on the 3 tables',
      (select count(*) from pg_policies where schemaname = 'public' and policyname = 'helm_clean_archive_185'
        and permissive = 'RESTRICTIVE' and tablename in ('leads', 'nurture', 'layouts')) = 3),
  ('04 journal table: RLS on, no app access, read-only guard',
      (select relrowsecurity from pg_class where oid = 'public.studio_clean_start_items'::regclass)
      and exists (select 1 from pg_trigger where tgrelid = 'public.studio_clean_start_items'::regclass and tgname = 'zzz_studio_read_only')
      and not has_table_privilege('anon', 'public.studio_clean_start_items', 'select')
      and not has_table_privilege('authenticated', 'public.studio_clean_start_items', 'select')),
  ('05 app RPCs: signed-in only',
      has_function_privilege('authenticated', 'public.my_upgrade_status()', 'execute')
      and has_function_privilege('authenticated', 'public.upgrade_data_choice(text, text)', 'execute')
      and has_function_privilege('authenticated', 'public.delete_all_sample_data()', 'execute')
      and has_function_privilege('authenticated', 'public.restore_clean_start()', 'execute')
      and not has_function_privilege('anon', 'public.upgrade_data_choice(text, text)', 'execute')
      and not has_function_privilege('anon', 'public.delete_all_sample_data()', 'execute')
      and not has_function_privilege('anon', 'public.restore_clean_start()', 'execute')
      and not has_function_privilege('anon', 'public.my_upgrade_status()', 'execute')),
  ('06 internal helpers: not callable by the app',
      not has_function_privilege('authenticated', 'public._tu185_archive_own(uuid, uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._tu185_restore_own(uuid, uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public._tu185_adopt_used_samples(uuid)', 'execute')
      and not has_function_privilege('anon', 'public._tu185_archive_own(uuid, uuid)', 'execute')),
  ('07 no studio still in its trial counts as upgraded',
      not exists (select 1 from public.studio_subscriptions s where s.status = 'trial' and public._tu185_converted(s.org_id))),
  ('08 every hidden (archived) row is in the restore journal',
      not exists (select 1 from public.leads x where x.clean_archived_at is not null and not exists (select 1 from public.studio_clean_start_items i
                   where i.tbl = 'leads' and i.row_id = x.id and i.restored_at is null))
      and not exists (select 1 from public.nurture x where x.clean_archived_at is not null and not exists (select 1 from public.studio_clean_start_items i
                   where i.tbl = 'nurture' and i.row_id = x.id and i.restored_at is null))
      and not exists (select 1 from public.layouts x where x.clean_archived_at is not null and not exists (select 1 from public.studio_clean_start_items i
                   where i.tbl = 'layouts' and i.row_id = x.id and i.restored_at is null))),
  ('09 the clear used is the is_demo-only _demo_clear', position('_demo_clear' in pg_get_functiondef('public.delete_all_sample_data()'::regprocedure)) > 0
      and position('_demo_clear' in pg_get_functiondef('public.upgrade_data_choice(text, text)'::regprocedure)) > 0)
) v(item, ok) order by item;
