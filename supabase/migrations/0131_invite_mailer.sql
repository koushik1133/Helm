-- 0131_invite_mailer.sql - CANONICAL forward-only. Invitation e-mails. REQUIRES phase83 (invitations),
-- 0042/0072 (create_invitation), is_admin(), current_org_id().
--
-- In plain words:
--   Today an admin who invites a staff member gets a link to copy; the invitee gets NO e-mail.
--   This adds an OUTBOX so the dormant edge function invite-mailer can e-mail the link:
--     * invite_email_outbox - one row per invitation (unique invitation_id) = each pending invite
--       is e-mailed ONCE. RLS on, no grants to anon / authenticated (nobody can read tokens here).
--     * A trigger on invitations (AFTER INSERT, and AFTER UPDATE OF token - create_invitation
--       re-tokens a pending invite when the role changes, which makes the old link useless)
--       queues the row. Exception-safe: an outbox problem NEVER blocks creating an invite.
--     * resend_invitation_email(id) - admin of the SAME studio only, pending + unexpired invite
--       only, at most once per 10 minutes per invite. Re-queues the same outbox row.
--     * invite_email_kick_org() - tells the mailer which studio a signed-in admin may flush
--       right after creating an invite (null for anyone else).
--     * invite_email_outbox_claim / _mark - service_role only (the mailer).
--   Nothing is SENT by the database. Invites created before 0131 are NOT back-filled.
--   Additive + idempotent: no table / column / row is dropped, deleted or truncated. ASCII only.

create table if not exists public.invite_email_outbox (
  id            uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.invitations(id) on delete cascade,
  org_id        uuid references public.organizations(id) on delete set null,
  email         text not null,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts      integer not null default 0,
  send_count    integer not null default 0,
  queued_at     timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create unique index if not exists invite_email_outbox_inv_uq on public.invite_email_outbox (invitation_id);
create index if not exists invite_email_outbox_pending_idx on public.invite_email_outbox (queued_at) where sent_at is null;

alter table public.invite_email_outbox enable row level security;
revoke all on public.invite_email_outbox from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.invite_email_outbox from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.invite_email_outbox from authenticated; end if;
end $$;

-- ---- enqueue (internal; idempotent) ---------------------------------------------------------
-- helm-0131-invite-mailer. Returns 'queued' | 'already_queued' | 'not_pending' | 'bad_email'.
create or replace function public._ie131_enqueue(p_inv uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v record; v_email text;
begin
  select i.id, i.org_id, i.email, i.status, i.expires_at into v from public.invitations i where i.id = p_inv;
  if v.id is null or v.status <> 'pending' or v.expires_at <= now() then return 'not_pending'; end if;
  v_email := lower(btrim(coalesce(v.email, '')));
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_email) > 254 then return 'bad_email'; end if;
  insert into public.invite_email_outbox as o (invitation_id, org_id, email)
  values (v.id, v.org_id, v_email)
  on conflict (invitation_id) do update
     set status = 'pending', sent_at = null, claimed_at = null, attempts = 0,
         queued_at = now(), email = excluded.email
   where o.sent_at is not null;              -- already waiting? leave it alone (dedupe)
  if found then return 'queued'; end if;
  return 'already_queued';
end $$;

create or replace function public.tg_ie131_invitation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.status = 'pending' and (tg_op = 'INSERT' or old.token is distinct from new.token) then
      perform public._ie131_enqueue(new.id);
    end if;
  exception when others then raise warning 'invite-0131: enqueue skipped (%)', sqlstate;   -- never block the invite
  end;
  return null;
end $$;

drop trigger if exists ie131_invitation_email on public.invitations;
create trigger ie131_invitation_email after insert or update of token on public.invitations
  for each row execute function public.tg_ie131_invitation();

-- ---- admin: re-send the e-mail (rate-limited: once per 10 minutes per invite) ----------------
create or replace function public.resend_invitation_email(p_invitation_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_inv record; v_last timestamptz; v_res text;
begin
  -- helm-0131-invite-mailer
  if not public.is_admin() or v_org is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select i.id, i.org_id, i.status, i.expires_at into v_inv from public.invitations i
   where i.id = p_invitation_id and i.org_id = v_org;
  if v_inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if v_inv.status <> 'pending' or v_inv.expires_at <= now() then
    return jsonb_build_object('status', 'not_pending');
  end if;
  select o.queued_at into v_last from public.invite_email_outbox o where o.invitation_id = v_inv.id;
  if v_last is not null and v_last > now() - interval '10 minutes' then
    return jsonb_build_object('status', 'rate_limited',
      'retry_in', greatest(1, ceil(extract(epoch from (v_last + interval '10 minutes' - now())))::int));
  end if;
  v_res := public._ie131_enqueue(v_inv.id);
  if v_res = 'already_queued' then   -- stuck in the queue: refresh it so it is picked up now
    update public.invite_email_outbox set claimed_at = null, attempts = 0, queued_at = now()
     where invitation_id = v_inv.id and sent_at is null;
    v_res := 'queued';
  end if;
  return jsonb_build_object('status', v_res);
end $$;

-- ---- which studio may a signed-in caller flush right now? (admin only, else null) -----------
create or replace function public.invite_email_kick_org()
returns uuid language sql stable security definer set search_path = '' as $$
  select case when public.is_admin() then public.current_org_id() end;
$$;

-- ---- outbox RPCs (service role only - the dormant invite-mailer) -----------------------------
-- claim up to p_limit pending rows (optionally one studio only); re-claimable after 10 minutes;
-- 5 tries max. Invites that were accepted / revoked / expired meanwhile are marked skipped.
create or replace function public.invite_email_outbox_claim(p_limit integer default 25, p_org uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb;
begin
  update public.invite_email_outbox set status = 'failed', sent_at = now()
   where sent_at is null and attempts >= 5 and (p_org is null or org_id = p_org);
  for r in
    select o.id, o.email, o.invitation_id, i.token, i.role, i.expires_at, i.status as inv_status,
           i.org_id, i.invited_by
      from public.invite_email_outbox o
      join public.invitations i on i.id = o.invitation_id
     where o.sent_at is null
       and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
       and (p_org is null or o.org_id = p_org)
     order by o.queued_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of o skip locked
  loop
    if r.inv_status <> 'pending' or r.expires_at <= now() then
      update public.invite_email_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.invite_email_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'to', r.email, 'token', r.token, 'role', r.role, 'expires_at', r.expires_at,
      'studio', (select o2.name from public.organizations o2 where o2.id = r.org_id),
      'inviter', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = r.invited_by)));
  end loop;
  return v_out;
end $$;

create or replace function public.invite_email_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.invite_email_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.invite_email_outbox
     set status = p_status, sent_at = now(),
         send_count = send_count + case when p_status = 'sent' then 1 else 0 end
   where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- grants ----------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._ie131_enqueue(uuid)', 'public.tg_ie131_invitation()',
    'public.resend_invitation_email(uuid)', 'public.invite_email_kick_org()',
    'public.invite_email_outbox_claim(integer, uuid)', 'public.invite_email_outbox_mark(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.resend_invitation_email(uuid) to authenticated;
    grant execute on function public.invite_email_kick_org() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.invite_email_outbox_claim(integer, uuid) to service_role;
    grant execute on function public.invite_email_outbox_mark(uuid, text) to service_role;
    grant execute on function public.invite_email_kick_org() to service_role;
    grant select on public.invite_email_outbox to service_role;
  end if;
end $$;
