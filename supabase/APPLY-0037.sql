-- HELM — 0037 HQ operator check (one paste). Run AFTER APPLY-0035 and APPLY-0036.
-- SAFE TO RE-RUN: changes no rows, drops no table or column. If anything fails, the whole run rolls back.
do $$ begin
  if to_regprocedure('public.is_platform_admin()') is null or to_regclass('public.platform_admins') is null
    then raise exception 'STOP: 0029 (HQ) not installed'; end if;
  if to_regprocedure('public.chat_directory()') is null then raise exception 'STOP: 0034 not installed'; end if;
  raise notice 'Preflight OK — applying 0037…';
end $$;

create or replace function public.is_platform_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz;
begin
  if v_uid is null then return false; end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return false; end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then return false; end if;
  return exists (select 1 from public.platform_admins pa where pa.email = v_email);
end $$;
revoke all on function public.is_platform_operator() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.is_platform_operator() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.is_platform_operator() to authenticated'; end if;
end $$;

create or replace function public.tg_no_studio_for_operator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and public.is_platform_operator() then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_no_studio_for_operator() from public, anon, authenticated;
drop trigger if exists ab_no_studio_for_operator on public.organizations;
create trigger ab_no_studio_for_operator before insert on public.organizations
  for each row execute function public.tg_no_studio_for_operator();

-- VERIFY — every row must say "ok"
select item, case when ok then 'ok' else 'FAIL' end as status from (values
  ('is_platform_operator: signed-in only, answers for the caller only',
     to_regprocedure('public.is_platform_operator()') is not null
     and has_function_privilege('authenticated', 'public.is_platform_operator()', 'EXECUTE')
     and not has_function_privilege('anon', 'public.is_platform_operator()', 'EXECUTE')),
  ('HQ accounts can never create a studio, whatever their two-step state',
     exists (select 1 from pg_trigger where tgname = 'ab_no_studio_for_operator' and tgrelid = 'public.organizations'::regclass)
     and pg_get_functiondef('public.tg_no_studio_for_operator()'::regprocedure) like '%is_platform_operator()%')
) v(item, ok);
