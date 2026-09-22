-- ============================================================================
-- Phase 83 — Team invitations: "join an existing studio" onboarding
-- ---------------------------------------------------------------------------
-- Helm is one-org-per-user (profiles.org_id). Today teammates can only be added
-- by an admin minting the auth user directly (admin_create_user). This adds the
-- missing flow: an admin invites an email + role -> the invitee signs up -> they
-- ACCEPT the token and are attached to that studio.
--
-- PRODUCTION SAFEGUARDS baked in:
--   1) Signup race: accept_invitation attaches the caller whenever their profile
--      is UNASSIGNED (org_id IS NULL) — regardless of whether a signup trigger has
--      already inserted the profiles row — and creates the row if absent.
--   2) Email match: the signed-in account's JWT email must equal the invited
--      email (anti-forwarding). No one can redeem an invite for a third party.
--   3) Tight metadata: invitation_by_token returns ONLY org name, role, validity —
--      never the inviter id or the target email.
--
-- SAFE BY DESIGN (zero-data-loss guardrail): additive + idempotent only
--   (create table if not exists / create or replace / guarded add constraint).
--   No DROP TABLE / DROP COLUMN / TRUNCATE. RLS enabled; every row org-scoped.
--   Roles constrained to Helm's existing 10 via a CHECK — no new roles.
--
-- Idempotent. Run AFTER phase29 (roles), phase56 (organizations/current_org_id),
-- phase57 (has_area), phase58 (create_studio).
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_bytes / gen_random_uuid

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null,                                   -- constrained to the 10 roles below
  token       text not null unique default encode(gen_random_bytes(24), 'hex'),
  status      text not null default 'pending',                 -- pending | accepted | revoked | expired
  invited_by  uuid references auth.users(id),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists invitations_org_status_idx on public.invitations(org_id, status);
create index if not exists invitations_email_idx       on public.invitations(lower(email));

-- CHECK: role must be one of Helm's 10 valid roles (added idempotently so a
-- previously-created table without the constraint is upgraded in place).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'invitations_role_chk' and conrelid = 'public.invitations'::regclass
  ) then
    alter table public.invitations
      add constraint invitations_role_chk
      check (role in ('admin','manager','planner','sales','coordinator',
                      'supervisor','operations','crew','worker','client'));
  end if;
end $$;

-- ---- RLS: only admins of the SAME org can see/manage its invites -----------
alter table public.invitations enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='invitations'
  loop execute format('drop policy if exists %I on public.invitations', p.policyname); end loop;
end $$;
create policy "inv read"  on public.invitations for select to authenticated
  using ( public.has_area('users','view') and org_id = (select public.current_org_id()) );
create policy "inv ins"   on public.invitations for insert to authenticated
  with check ( public.has_area('users','edit') and org_id = (select public.current_org_id()) );
create policy "inv upd"   on public.invitations for update to authenticated
  using ( public.has_area('users','edit') and org_id = (select public.current_org_id()) )
  with check ( public.has_area('users','edit') and org_id = (select public.current_org_id()) );
create policy "inv del"   on public.invitations for delete to authenticated
  using ( public.has_area('users','edit') and org_id = (select public.current_org_id()) );

-- ---- create_invitation(email, role) -> token (admin only, org-scoped) ------
create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); v_row public.invitations;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_org is null then raise exception 'no organization context' using errcode='42501'; end if;
  if coalesce(btrim(p_email),'') = '' then raise exception 'email is required'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;

  -- idempotent: reuse a live pending invite for the same (org, email)
  select * into v_row from public.invitations
    where org_id = v_org and lower(email) = lower(btrim(p_email))
      and status = 'pending' and expires_at > now()
    order by created_at desc limit 1;
  if v_row.id is not null then
    return jsonb_build_object('token', v_row.token, 'reused', true);
  end if;

  insert into public.invitations(org_id, email, role, invited_by)
    values (v_org, lower(btrim(p_email)), p_role, auth.uid())
    returning * into v_row;
  return jsonb_build_object('token', v_row.token, 'reused', false);
end; $$;
revoke all on function public.create_invitation(text,text) from anon;
grant execute on function public.create_invitation(text,text) to authenticated;

-- ---- invitation_by_token(token) -> minimal info for the accept screen -------
-- SECURITY DEFINER because the invitee is not yet in the org (RLS would hide it).
-- Returns ONLY org name, role, and validity — never the inviter id or the email.
create or replace function public.invitation_by_token(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_row public.invitations; v_org text;
begin
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;
  select name into v_org from public.organizations where id = v_row.org_id;
  return jsonb_build_object(
    'valid',    (v_row.status = 'pending' and v_row.expires_at > now()),
    'status',   v_row.status,
    'role',     v_row.role,
    'org_name', v_org,
    'expired',  (v_row.expires_at <= now())
  );
end; $$;
revoke all on function public.invitation_by_token(text) from anon;
grant execute on function public.invitation_by_token(text) to authenticated;

-- ---- accept_invitation(token): attach the signed-in user to the studio -----
create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.invitations; v_uid uuid := auth.uid(); v_current uuid; v_email text;
begin
  if v_uid is null then raise exception 'must be signed in' using errcode='42501'; end if;
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then raise exception 'invalid invitation' using errcode='42501'; end if;

  -- idempotent: this same user re-accepting an invite they already accepted
  if v_row.status = 'accepted' and v_row.accepted_by = v_uid then
    return jsonb_build_object('ok', true, 'org_id', v_row.org_id, 'already', true);
  end if;
  if v_row.status <> 'pending' then raise exception 'invitation is %', v_row.status using errcode='42501'; end if;
  if v_row.expires_at <= now() then
    update public.invitations set status = 'expired' where id = v_row.id and status = 'pending';
    raise exception 'invitation has expired' using errcode='42501';
  end if;

  -- (2) EMAIL MATCH — the signed-in account must BE the invited email.
  -- Prefer the JWT claim; fall back to auth.users for providers that omit it.
  v_email := lower(nullif(auth.jwt() ->> 'email', ''));
  if v_email is null then
    select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  end if;
  if v_email is null or v_email <> lower(v_row.email) then
    raise exception 'this invitation was issued to a different email address' using errcode='42501';
  end if;

  -- (1) SIGNUP RACE / one-org-per-user: attach only when UNASSIGNED (org_id NULL)
  -- or already this same org. Never move a user out of a different studio.
  select org_id into v_current from public.profiles where id = v_uid;
  if v_current is not null and v_current <> v_row.org_id then
    raise exception 'you already belong to an organization' using errcode='42501';
  end if;

  -- attach this user (scoped to auth.uid()); works whether or not the signup
  -- trigger has already inserted the profiles row.
  update public.profiles set org_id = v_row.org_id, role = v_row.role
    where id = v_uid and (org_id is null or org_id = v_row.org_id);
  if not found then
    insert into public.profiles(id, email, org_id, role)
      select v_uid, u.email, v_row.org_id, v_row.role from auth.users u where u.id = v_uid
      on conflict (id) do update
        set org_id = excluded.org_id, role = excluded.role
        where public.profiles.org_id is null or public.profiles.org_id = excluded.org_id;
  end if;

  update public.invitations
     set status = 'accepted', accepted_at = now(), accepted_by = v_uid
   where id = v_row.id and status = 'pending';

  return jsonb_build_object('ok', true, 'org_id', v_row.org_id, 'role', v_row.role, 'already', false);
end; $$;
revoke all on function public.accept_invitation(text) from anon;
grant execute on function public.accept_invitation(text) to authenticated;

notify pgrst, 'reload schema';
select 'invitations' t, 'ready (email-match + race-safe)' s;
