-- ============================================================================
-- 0063_notification_mutes.sql - CANONICAL forward-only. Per-person muted
-- notification types (bell "..." menu -> "Mute this type"; Muted types list).
--
-- In plain words:
--   * notification_mutes - one row per (person, studio, catalog type) the person
--     muted for THEMSELVES. RLS on; a person can only read their own rows; nobody
--     writes the table directly (no insert/update/delete grants) - only the two
--     RPCs below, which always use auth.uid() and current_org_id().
--   * my_notification_mutes() - the caller's muted types in their studio.
--   * set_notification_mute(p_type, p_muted) - mute / unmute one catalog type for
--     the caller. Unknown types are refused (22023). Returns the new list.
--   * The studio-wide admin matrix (0036 notification_prefs) is unchanged; a mute
--     only hides that type from the person's own bell and toasts.
--
-- Additive + idempotent: 1 new table, 2 new functions. No existing row changes.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.current_org_id()') is null then raise exception '0063: current_org_id() is not installed'; end if;
  if to_regprocedure('public.notification_catalog()') is null then raise exception '0063: notification_catalog() (0036) is not installed'; end if;
end $$;

create table if not exists public.notification_mutes (
  user_id    uuid not null,
  org_id     uuid not null,
  type       text not null,
  created_at timestamptz not null default now(),
  constraint notification_mutes_pk primary key (user_id, org_id, type),
  constraint notification_mutes_type_chk check (type ~ '^[a-z_]{1,40}$')
);
alter table public.notification_mutes enable row level security;
drop policy if exists nm_read_own on public.notification_mutes;
create policy nm_read_own on public.notification_mutes for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
revoke all on public.notification_mutes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.notification_mutes from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.notification_mutes from authenticated';
    execute 'grant select on public.notification_mutes to authenticated';
  end if;
end $$;

create or replace function public.my_notification_mutes()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(m.type order by m.type) from public.notification_mutes m
                    where m.user_id = v_me and m.org_id = v_org), '[]'::jsonb);
end $$;

create or replace function public.set_notification_mute(p_type text, p_muted boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_type text := lower(btrim(coalesce(p_type, '')));
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = v_type) then
    raise exception 'unknown notification type' using errcode = '22023';
  end if;
  if coalesce(p_muted, false) then
    insert into public.notification_mutes (user_id, org_id, type) values (v_me, v_org, v_type)
      on conflict (user_id, org_id, type) do nothing;
  else
    delete from public.notification_mutes where user_id = v_me and org_id = v_org and type = v_type;
  end if;
  return public.my_notification_mutes();
end $$;

revoke all on function public.my_notification_mutes() from public;
revoke all on function public.set_notification_mute(text, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.my_notification_mutes() from anon';
    execute 'revoke all on function public.set_notification_mute(text, boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_notification_mutes() to authenticated';
    execute 'grant execute on function public.set_notification_mute(text, boolean) to authenticated';
  end if;
end $$;
