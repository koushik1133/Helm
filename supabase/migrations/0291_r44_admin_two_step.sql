-- 0291_r44_admin_two_step.sql - CANONICAL forward-only.
-- REQUIRES 0285 (r35: _r285_has_mfa, _r285_admins - studio admins need two-step for sensitive changes), 0266
--          (notification_inbox_state: a person's own read / done marks), 0164 (_is_system_change: helm.maintenance),
--          phase29 / phase57 (is_admin, current_org_id), the notifications table.
-- OPTIONAL: 0179 (_tb179_no_send: never for a free-trial / read-only / sample studio) - used when present.
--
-- In plain words (r44, owner-approved: "help studio admins set up two-step BEFORE they hit the block"):
--   1  studio_two_step_status() - for Settings -> Team: one yes / no per member of the caller's OWN studio
--      (user id + "has a verified authenticator"). Nothing else: no factor ids, no names, no e-mails, no times.
--      Only a studio admin may ask (anyone else: 42501). Other studios are never looked at.
--   2  two_step_intro_send(p_dry_run default true) - an OPTIONAL one-time bell notice for a later announcement:
--      "New: two-step protects your payment details. Set it up in 2 minutes." to every studio admin (and the 0283
--      owner when present) who has no verified authenticator. Bell only: no e-mail, no WhatsApp copy (detail via =
--      'comms', like 0241 / 0254). Sent ONCE per admin: NEW two_step_intro_sent (one row per person, private).
--      One bell row per studio (kind studio_security = admins only, 0285); the studio's other admins (who already
--      have two-step, or were told before) get it marked Done in their own inbox so it never shows for them.
--      Never for a free-trial / read-only / sample studio. Nobody in the app can call it: the owner runs it in the
--      SQL editor (dry run first: counts only, nothing written). Nothing runs it by itself.
-- Changes: 1 NEW table (RLS on, no API privilege), 2 NEW functions. No existing function, table, column, policy or
-- row is changed or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): drop function public.studio_two_step_status();
--   drop function public.two_step_intro_send(boolean); (the table can stay - unused)

-- ---- STOP guard: the pieces this builds on ----------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r285_has_mfa(uuid)') is null or to_regprocedure('public._r285_admins(uuid)') is null
     or to_regprocedure('public._r285_step_up(uuid)') is null then
    raise exception 'STOP 0291: apply 0285 first (r35 payment-details safety: two-step for sensitive changes)'; end if;
  if to_regclass('public.notification_inbox_state') is null then
    raise exception 'STOP 0291: apply 0266 first (notification inbox)'; end if;
  if to_regprocedure('public.is_admin()') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0291: phase29 / phase57 (is_admin, current_org_id) is not applied'; end if;
  if to_regclass('public.notifications') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP 0291: notifications / profiles are missing'; end if;
end $$;

-- ---- 1) the one-time notice ledger (private: RLS on, no API privilege) --------------------------------------------
-- one row per person who was sent the two-step notice; never updated or deleted by the app
create table if not exists public.two_step_intro_sent (
  user_id         uuid        primary key,
  studio          uuid,
  notification_id uuid,
  sent_at         timestamptz not null default now()
);
do $$ begin
  alter table public.two_step_intro_sent enable row level security;
  revoke all on table public.two_step_intro_sent from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.two_step_intro_sent from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.two_step_intro_sent from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select on table public.two_step_intro_sent to service_role; end if;
end $$;

-- ---- 2) Settings -> Team: who has two-step (yes / no only, own studio, admins only) -------------------------------
create or replace function public.studio_two_step_status()
returns table(user_id uuid, two_step boolean)
language plpgsql stable security definer set search_path = '' as $$
-- r44-0291
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_org := public.current_org_id();
  if v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only studio admins can see who has two-step.' using errcode = '42501'; end if;
  return query
    select p.id, public._r285_has_mfa(p.id)
      from public.profiles p
     where p.org_id = v_org
     order by p.id;
end $$;

-- ---- 3) OPTIONAL: the one-time bell notice (owner runs it; dry run by default) ------------------------------------
create or replace function public.two_step_intro_send(p_dry_run boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r44-0291
declare
  v_org uuid; v_new uuid[]; v_all uuid[]; v_nid uuid; v_studios integer := 0; v_people integer := 0;
  v_skip boolean; v_prev text := coalesce(current_setting('helm.maintenance', true), '');
  v_label constant text := 'New: two-step protects your payment details. Set it up in 2 minutes.';
begin
  for v_org in select o.id from public.organizations o where not coalesce(o.is_sample_master, false) order by o.id loop
    v_skip := false;
    if to_regprocedure('public._tb179_no_send(uuid)') is not null then
      begin execute 'select coalesce(public._tb179_no_send($1), false)' into v_skip using v_org; exception when others then v_skip := false; end;
    end if;
    if v_skip then continue; end if;
    select coalesce(array_agg(a.u order by a.u), '{}'::uuid[]) into v_all
      from (select distinct x as u from public._r285_admins(v_org) x where x is not null) a;
    select coalesce(array_agg(u order by u), '{}'::uuid[]) into v_new
      from unnest(v_all) u
     where not public._r285_has_mfa(u)
       and not exists (select 1 from public.two_step_intro_sent s where s.user_id = u);
    if cardinality(v_new) = 0 then continue; end if;
    v_studios := v_studios + 1; v_people := v_people + cardinality(v_new);
    if p_dry_run then continue; end if;
    -- a direct SQL-editor run counts as a "system change" (0164) and would be kept quiet: this send is deliberate
    perform set_config('helm.maintenance', 'off', true);
    v_nid := null;
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'studio_security', 'simulated',
              jsonb_build_object('label', v_label, 'event', 'two_step_intro', 'source', 'r44', 'via', 'comms'), v_org)
      returning id into v_nid;
    if v_nid is null then continue; end if;   -- a bell gate dropped it: nothing recorded, a later run can try again
    insert into public.two_step_intro_sent(user_id, studio, notification_id)
      select u, v_org, v_nid from unnest(v_new) u on conflict (user_id) do nothing;
    -- everyone else in the studio: this one row is marked Done in their own inbox (never shown, never counted)
    insert into public.notification_inbox_state(user_id, notification_id, org_id, read_at, done_at)
      select p.id, v_nid, v_org, now(), now() from public.profiles p
       where p.org_id = v_org and not (p.id = any (v_new))
      on conflict (user_id, notification_id) do nothing;
  end loop;
  perform set_config('helm.maintenance', v_prev, true);
  return jsonb_build_object('dry_run', p_dry_run, 'studios', v_studios, 'admins', v_people,
    'note', case when p_dry_run then 'Dry run: nothing sent. Run select public.two_step_intro_send(false); to send.'
                 else 'Sent once to each admin without two-step (bell only).' end);
end $$;

-- ---- 4) privileges ------------------------------------------------------------------------------------------------
do $$ begin
  revoke all on function public.studio_two_step_status() from public;
  revoke all on function public.two_step_intro_send(boolean) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.studio_two_step_status() from anon;
    revoke all on function public.two_step_intro_send(boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.studio_two_step_status() to authenticated;   -- the function itself: studio admins only
    revoke all on function public.two_step_intro_send(boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.two_step_intro_send(boolean) to service_role;
  end if;
end $$;

-- ---- VERIFY (read-only) ------------------------------------------------------------------------------------------------
-- select public.two_step_intro_send();        -- dry run: how many studios / admins would get the notice (nothing sent)
-- select count(*) from public.two_step_intro_sent;   -- admins already sent the notice
