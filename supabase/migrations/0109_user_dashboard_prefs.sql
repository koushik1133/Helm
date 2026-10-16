-- 0109_user_dashboard_prefs.sql - CANONICAL forward-only. Per-user dashboard layout + desk notes.
--
-- In plain words:
--   Each person can now arrange their own home dashboard (block order + which blocks are hidden)
--   and their "Desk notes" are kept on the server instead of only in one browser. One row per
--   person per studio. Nobody else - not even a studio admin - can read or change someone's row.
--
--     user_dashboard_prefs(user_id, org_id, layout jsonb, hidden jsonb, desk_notes text <= 2000)
--     my_dashboard_prefs()            -> jsonb  { layout, hidden, desk_notes, updated_at }
--     save_dashboard_layout(p jsonb)  -> void   { order: [...ids], hidden: [...ids] }  ({} = reset)
--     save_desk_notes(p_text text)    -> void
--
--   The layout only holds block ids (e.g. "calendar"); it never decides what a role can see -
--   role gating stays in the app and in each block's own RLS. User and studio always come from
--   the session (auth.uid() + current_org_id()), never from the caller.
--
--   Changes: one new table (RLS on, own row only, no delete, no anon) + three functions.
--   No existing table, column or row is changed or deleted. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.current_org_id()') is null then
    raise exception '0109: current_org_id() is not installed'; end if;
  if to_regclass('public.organizations') is null then
    raise exception '0109: public.organizations is missing'; end if;
end $$;

create table if not exists public.user_dashboard_prefs (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  org_id      uuid        not null references public.organizations(id) on delete cascade,
  layout      jsonb       not null default '{}'::jsonb,
  hidden      jsonb       not null default '[]'::jsonb,
  desk_notes  text        not null default '',
  updated_at  timestamptz not null default now(),
  primary key (user_id, org_id)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'udp_layout_shape' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_layout_shape
      check (jsonb_typeof(layout) = 'object' and pg_column_size(layout) < 8192); end if;
  if not exists (select 1 from pg_constraint where conname = 'udp_hidden_shape' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_hidden_shape
      check (jsonb_typeof(hidden) = 'array' and jsonb_array_length(hidden) <= 40); end if;
  if not exists (select 1 from pg_constraint where conname = 'udp_notes_len' and conrelid = 'public.user_dashboard_prefs'::regclass) then
    alter table public.user_dashboard_prefs add constraint udp_notes_len
      check (char_length(desk_notes) <= 2000); end if;
end $$;

alter table public.user_dashboard_prefs enable row level security;
revoke all on table public.user_dashboard_prefs from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.user_dashboard_prefs from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.user_dashboard_prefs from authenticated';
    execute 'grant select, insert, update on table public.user_dashboard_prefs to authenticated';   -- no DELETE
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.user_dashboard_prefs to service_role'; end if;
end $$;

drop policy if exists "a109 prefs own read" on public.user_dashboard_prefs;
create policy "a109 prefs own read" on public.user_dashboard_prefs for select to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
drop policy if exists "a109 prefs own insert" on public.user_dashboard_prefs;
create policy "a109 prefs own insert" on public.user_dashboard_prefs for insert to authenticated
  with check (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));
drop policy if exists "a109 prefs own update" on public.user_dashboard_prefs;
create policy "a109 prefs own update" on public.user_dashboard_prefs for update to authenticated
  using (user_id = (select auth.uid()) and org_id = (select public.current_org_id()))
  with check (user_id = (select auth.uid()) and org_id = (select public.current_org_id()));

create or replace function public.my_dashboard_prefs()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); r record;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.layout, p.hidden, p.desk_notes, p.updated_at into r
    from public.user_dashboard_prefs p where p.user_id = v_uid and p.org_id = v_org;
  if not found then
    return jsonb_build_object('layout', '{}'::jsonb, 'hidden', '[]'::jsonb, 'desk_notes', '', 'updated_at', null);
  end if;
  return jsonb_build_object('layout', r.layout, 'hidden', r.hidden, 'desk_notes', r.desk_notes, 'updated_at', r.updated_at);
end $$;

create or replace function public.save_dashboard_layout(p_layout jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_order jsonb := '[]'::jsonb; v_hidden jsonb := '[]'::jsonb; v_layout jsonb;
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_layout is null or jsonb_typeof(p_layout) <> 'object' then raise exception 'bad layout' using errcode = '22023'; end if;
  -- keep only short block ids, de-duplicated, max 40 (layout never carries anything else)
  if jsonb_typeof(p_layout -> 'order') = 'array' then
    select coalesce(jsonb_agg(x.v order by x.i), '[]'::jsonb) into v_order from (
      select v, min(i) as i from jsonb_array_elements_text(p_layout -> 'order') with ordinality t(v, i)
       where v ~ '^[a-z][a-z0-9_-]{0,31}$' group by v order by min(i) limit 40) x;
  end if;
  if jsonb_typeof(p_layout -> 'hidden') = 'array' then
    select coalesce(jsonb_agg(x.v order by x.i), '[]'::jsonb) into v_hidden from (
      select v, min(i) as i from jsonb_array_elements_text(p_layout -> 'hidden') with ordinality t(v, i)
       where v ~ '^[a-z][a-z0-9_-]{0,31}$' group by v order by min(i) limit 40) x;
  end if;
  v_layout := case when jsonb_array_length(v_order) > 0 then jsonb_build_object('v', 1, 'order', v_order) else '{}'::jsonb end;
  insert into public.user_dashboard_prefs as p (user_id, org_id, layout, hidden)
    values (v_uid, v_org, v_layout, v_hidden)
  on conflict (user_id, org_id) do update set layout = excluded.layout, hidden = excluded.hidden, updated_at = now();
end $$;

create or replace function public.save_desk_notes(p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- dashboard-prefs-0109
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into public.user_dashboard_prefs as p (user_id, org_id, desk_notes)
    values (v_uid, v_org, left(coalesce(p_text, ''), 2000))
  on conflict (user_id, org_id) do update set desk_notes = excluded.desk_notes, updated_at = now();
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.my_dashboard_prefs()', 'public.save_dashboard_layout(jsonb)', 'public.save_desk_notes(text)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function ' || f || ' to service_role'; end if;
  end loop;
end $$;
