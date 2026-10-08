-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0057 welcome e-mails (one paste) (2026-10-08)
--   * A NEW studio's owner gets one "Welcome to Helm" e-mail (first steps: add your first
--     lead, design a floor plan, invite your team). An invited member who joins a studio
--     gets one simpler "You've joined <studio>" e-mail.
--   * E-mails are only QUEUED (welcome_email_outbox); nothing is sent until the owner
--     deploys + enables the welcome-mailer edge function.
--   * Only people who create / join a studio AFTER this runs are queued (no back-fill).
-- WHAT IT TOUCHES: 1 new table (RLS on, no client access), 2 new AFTER triggers
--   (organizations insert, profiles org_id set — exception-safe, they can never block
--   creating or joining a studio), 2 service-role-only RPCs.
--   NO existing row is deleted or changed by running this.
-- SAFE TO RE-RUN. STAGING first, then PROD.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('public.organizations') is null or to_regclass('public.profiles') is null then raise exception 'STOP: base schema missing'; end if;
  if to_regprocedure('public.create_studio(text,text,text,text)') is null then raise exception 'STOP: create_studio missing'; end if;
  raise notice 'Preflight OK — applying 0057…';
end $$;

create table if not exists public.welcome_email_outbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete set null,
  user_id     uuid not null,
  kind        text not null check (kind in ('studio_owner', 'member')),
  email       text not null,
  channel     text not null default 'email' check (channel in ('email')),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  created_at  timestamptz not null default now()
);
create unique index if not exists welcome_email_outbox_user_kind_uq on public.welcome_email_outbox (user_id, kind);
create index if not exists welcome_email_outbox_pending_idx on public.welcome_email_outbox (created_at) where sent_at is null;

alter table public.welcome_email_outbox enable row level security;
revoke all on public.welcome_email_outbox from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.welcome_email_outbox from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.welcome_email_outbox from authenticated; end if;
end $$;

-- ---- enqueue (internal; idempotent; never raises) ------------------------------------------
create or replace function public._we57_enqueue(p_org uuid, p_user uuid, p_kind text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_email text;
begin
  if p_org is null or p_user is null or p_kind not in ('studio_owner', 'member') then return; end if;
  if p_org = '00000000-0000-4000-8000-000000000001'::uuid then return; end if;   -- Helm template studio
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = p_user;
  if v_email is null or v_email = '' then
    select lower(btrim(p.email)) into v_email from public.profiles p where p.id = p_user;
  end if;
  if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return; end if;
  insert into public.welcome_email_outbox(org_id, user_id, kind, email)
  values (p_org, p_user, p_kind, v_email)
  on conflict (user_id, kind) do nothing;
exception when others then
  raise warning 'welcome-0057: enqueue skipped (%)', sqlstate;   -- never block the caller
end $$;

-- new studio → its creator gets the owner welcome
create or replace function public.tg_we57_org()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.created_by is not null then perform public._we57_enqueue(new.id, new.created_by, 'studio_owner'); end if;
  exception when others then raise warning 'welcome-0057: org trigger skipped (%)', sqlstate;
  end;
  return null;
end $$;

-- a person's profile joins a studio → owner welcome if they created it, else member welcome
create or replace function public.tg_we57_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_creator uuid;
begin
  begin
    if new.org_id is not null and (tg_op = 'INSERT' or old.org_id is distinct from new.org_id) then
      select o.created_by into v_creator from public.organizations o where o.id = new.org_id;
      perform public._we57_enqueue(new.org_id, new.id,
        case when v_creator is not null and v_creator = new.id then 'studio_owner' else 'member' end);
    end if;
  exception when others then raise warning 'welcome-0057: profile trigger skipped (%)', sqlstate;
  end;
  return null;
end $$;

drop trigger if exists we57_org_welcome on public.organizations;
create trigger we57_org_welcome after insert on public.organizations
  for each row execute function public.tg_we57_org();
drop trigger if exists we57_profile_welcome on public.profiles;
create trigger we57_profile_welcome after insert or update of org_id on public.profiles
  for each row execute function public.tg_we57_profile();

-- ---- outbox RPCs (service role only — the dormant welcome-mailer) ---------------------------
-- claim up to p_limit pending rows (re-claimable after 10 minutes; 5 tries max).
create or replace function public.welcome_email_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb;
begin
  update public.welcome_email_outbox set status = 'failed', sent_at = now()
   where sent_at is null and attempts >= 5;
  for r in
    select w.* from public.welcome_email_outbox w
     where w.sent_at is null and (w.claimed_at is null or w.claimed_at < now() - interval '10 minutes')
     order by w.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  loop
    if r.org_id is null then   -- studio gone: nothing to welcome them to
      update public.welcome_email_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.welcome_email_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'to', r.email,
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = r.user_id)));
  end loop;
  return v_out;
end $$;

create or replace function public.welcome_email_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.welcome_email_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.welcome_email_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- grants ----------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._we57_enqueue(uuid, uuid, text)', 'public.tg_we57_org()', 'public.tg_we57_profile()',
    'public.welcome_email_outbox_claim(integer)', 'public.welcome_email_outbox_mark(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.welcome_email_outbox_claim(integer) to service_role;
    grant execute on function public.welcome_email_outbox_mark(uuid, text) to service_role;
    grant select on public.welcome_email_outbox to service_role;
  end if;
end $$;

-- ---- verify (every row should say true) ---------------------------------------------------
select item, ok from (values
  ('outbox table present', to_regclass('public.welcome_email_outbox') is not null),
  ('outbox RLS on', (select relrowsecurity from pg_class where oid = 'public.welcome_email_outbox'::regclass)),
  ('one welcome per person per kind', to_regclass('public.welcome_email_outbox_user_kind_uq') is not null),
  ('studio-created trigger', exists (select 1 from pg_trigger where tgname = 'we57_org_welcome' and tgrelid = 'public.organizations'::regclass)),
  ('member-joined trigger', exists (select 1 from pg_trigger where tgname = 'we57_profile_welcome' and tgrelid = 'public.profiles'::regclass)),
  ('clients cannot read outbox', not has_table_privilege('authenticated', 'public.welcome_email_outbox', 'select')
      and not has_table_privilege('anon', 'public.welcome_email_outbox', 'select')),
  ('claim/mark service-role only', not has_function_privilege('authenticated', 'public.welcome_email_outbox_claim(integer)', 'execute')
      and not has_function_privilege('anon', 'public.welcome_email_outbox_mark(uuid,text)', 'execute')
      and has_function_privilege('service_role', 'public.welcome_email_outbox_claim(integer)', 'execute')),
  ('enqueue helper not callable', not has_function_privilege('authenticated', 'public._we57_enqueue(uuid,uuid,text)', 'execute'))
) v(item, ok);
-- information only: queued welcomes (0 right after applying — no back-fill)
select kind, status, count(*) from public.welcome_email_outbox group by 1, 2;
