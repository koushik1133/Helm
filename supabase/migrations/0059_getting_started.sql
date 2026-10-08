-- ============================================================================
-- 0059_getting_started.sql — CANONICAL forward-only. Dashboard "Getting started"
-- checklist for new studios. REQUIRES 0041 (member_profiles) and 0045 (studio_account).
-- Independent of 0057 (welcome) and 0058 (trial); keep the order 0057, 0058, 0059.
--
-- In plain words:
--   * my_getting_started() — signed-in studio member. Works out, ON THE SERVER, which
--     getting-started steps are already done, from the studio's real data (no ticking
--     by hand). Studio admins get all 8 steps; other roles get a shorter list that only
--     includes what their access allows. Returns yes/no flags only — no names, phones,
--     e-mails or any other personal data, and only for the caller's own studio.
--       profile     your name + mobile are filled in (same rule as my_profile_status)
--       studio      studio account card: legal business name, city, billing address
--       pricing     the studio saved its default pricing in Control Center
--       lead        the studio has at least one lead
--       floor_plan  the studio has at least one saved floor plan (layout)
--       quote       the studio sent at least one quote (approval link sent)
--       team        someone else is in the studio, or an invitation was sent
--       mfa         you turned on two-step sign-in (optional)
--   * getting_started_state — one row per member: when they dismissed the checklist.
--     RLS on, no client access (reached only through the functions here).
--     A personal display preference, so it carries no org_id (and needs no studio
--     read-only guard): it holds no studio data at all.
--   * my_getting_started_dismiss(p_dismissed) — hide (true) or bring back (false) the
--     checklist for the caller only. Never deletes a row: it only sets/clears a date.
--
-- Additive + idempotent: 1 new table, 2 new functions. NO existing row is changed.
-- ============================================================================

do $$ begin
  if to_regclass('public.member_profiles') is null then raise exception '0059: 0041 (member_profiles) is not installed'; end if;
  if to_regclass('public.studio_account') is null then raise exception '0059: 0045 (studio_account) is not installed'; end if;
end $$;

-- ---- 1) per-member dismissal -------------------------------------------------------------
create table if not exists public.getting_started_state (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  dismissed_at timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.getting_started_state enable row level security;
revoke all on public.getting_started_state from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.getting_started_state from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.getting_started_state from authenticated'; end if;
end $$;

-- ---- 2) the checklist (read-only) ----------------------------------------------------------
create or replace function public.my_getting_started()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_role text; v_admin boolean; v_name text; v_phone text; v_dis timestamptz;
  v_steps jsonb := '[]'::jsonb;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role, p.full_name into v_role, v_name from public.profiles p where p.id = v_me and p.org_id = v_org;
  if not found or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  v_admin := public.is_admin();
  select m.phone into v_phone from public.member_profiles m where m.user_id = v_me;
  select s.dismissed_at into v_dis from public.getting_started_state s where s.user_id = v_me;

  v_steps := v_steps || jsonb_build_object('key', 'profile',
    'done', nullif(btrim(coalesce(v_name, '')), '') is not null and v_phone is not null);
  if v_admin then
    v_steps := v_steps || jsonb_build_object('key', 'studio', 'done', exists (
      select 1 from public.studio_account a where a.org_id = v_org
         and nullif(btrim(coalesce(a.legal_business_name, '')), '') is not null
         and nullif(btrim(coalesce(a.city, '')), '') is not null
         and nullif(btrim(coalesce(a.billing_address, '')), '') is not null));
    v_steps := v_steps || jsonb_build_object('key', 'pricing', 'done', exists (
      select 1 from public.app_config c where c.org_id = v_org and c.key = 'pricing'));
  end if;
  if v_admin or public.has_area('leads', 'edit') then
    v_steps := v_steps || jsonb_build_object('key', 'lead', 'done', exists (
      select 1 from public.leads l where l.org_id = v_org));
  end if;
  if v_admin or public.has_area('design', 'edit') or public.has_area('layouts', 'edit') then
    v_steps := v_steps || jsonb_build_object('key', 'floor_plan', 'done', exists (
      select 1 from public.layouts y where y.org_id = v_org));
  end if;
  if v_admin or public.has_area('quotes', 'edit') then
    v_steps := v_steps || jsonb_build_object('key', 'quote', 'done', exists (
      select 1 from public.quotes q where q.org_id = v_org and q.approval_status in ('sent', 'approved', 'paid')));
  end if;
  if v_admin then
    v_steps := v_steps || jsonb_build_object('key', 'team', 'done',
      exists (select 1 from public.profiles p where p.org_id = v_org and p.id <> v_me and p.role <> 'client')
      or exists (select 1 from public.invitations i where i.org_id = v_org));
  end if;
  v_steps := v_steps || jsonb_build_object('key', 'mfa', 'optional', true, 'done', exists (
    select 1 from auth.mfa_factors f where f.user_id = v_me and f.status = 'verified'));

  return jsonb_build_object('admin', v_admin, 'dismissed', v_dis is not null, 'steps', v_steps);
end $$;
revoke all on function public.my_getting_started() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_getting_started() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_getting_started() to authenticated'; end if;
end $$;

-- ---- 3) dismiss / bring back (caller only) -------------------------------------------------
create or replace function public.my_getting_started_dismiss(p_dismissed boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and p.role <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.getting_started_state (user_id, dismissed_at, updated_at)
    values (v_me, case when coalesce(p_dismissed, true) then now() end, now())
  on conflict (user_id) do update
    set dismissed_at = excluded.dismissed_at, updated_at = now();
  return jsonb_build_object('dismissed', coalesce(p_dismissed, true));
end $$;
revoke all on function public.my_getting_started_dismiss(boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_getting_started_dismiss(boolean) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_getting_started_dismiss(boolean) to authenticated'; end if;
end $$;
