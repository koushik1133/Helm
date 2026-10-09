-- APPLY-0074.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0074_chat_admin_fixes.sql verbatim. REQUIRES 0072 (and 0016,
-- 0021, 0025). Independent of 0073 / 0075.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: CREATE OR REPLACE FUNCTION, new chat_prefs table (IF NOT EXISTS), policies and
-- triggers dropped/recreated by name. No row is updated or deleted.
-- EXPECTED: the last result grid (item, ok) has 9 rows and EVERY ok = true.

-- =====================================================================================
-- PRE-CHECKS (read-only, INFORMATIONAL ONLY - nothing is changed)
-- =====================================================================================
-- PRE-CHECK A: studios with NO admin today (the new guard keeps the last admin; it can not add one).
select 'A studio without admin' as precheck, o.id, o.name
  from public.organizations o
 where not exists (select 1 from public.profiles p where p.org_id = o.id and p.role = 'admin');

-- PRE-CHECK B: existing chat messages whose media key points at another conversation. Left as
-- they are (only NEW / changed media is checked); they simply do not load for that chat.
select 'B cross-chat media' as precheck, count(*) as n
  from public.chat_messages m
 where m.media_path ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/'
   and lower(split_part(m.media_path, '/', 1) || '/' || split_part(m.media_path, '/', 2))
       <> m.org_id::text || '/' || m.conversation_id::text;

-- =====================================================================================
-- 0074 (verbatim)
-- =====================================================================================
-- 0074_chat_admin_fixes.sql - CANONICAL forward-only. Additive + idempotent: CREATE OR REPLACE,
-- new table guarded by IF NOT EXISTS, DROP/CREATE of policies and triggers by name. No row is updated or
-- deleted. REQUIRES 0016 (chat), 0021 (profiles guard), 0025 (invitations guard), 0072.
--
-- In plain words:
--   1  Invitations: the 0025 guard (a direct UPDATE may only set status -> 'revoked') is
--      re-asserted, and only a PENDING invitation can be revoked directly. anon loses every
--      table grant on invitations (RLS already refused it). Verified: a manager with Users edit
--      could NOT change an invitation's role before this migration either (42501 from the guard).
--   2  The last admin of a studio can never lose the admin role, whatever the path
--      (admin_set_role, accept_invitation, any future RPC): a profiles trigger refuses it.
--   3  chat_prefs: per-user pinned / muted / favourite per conversation (was browser-only).
--      Own rows only (RLS); written through chat_set_pref, which checks conversation access.
--   4  Chat media stays scoped to its conversation: a new message may only carry a media key
--      under <its org>/<its conversation>/ - so a forwarded photo / voice note must be COPIED
--      into the target conversation (Storage copy, checked by the chat-media policies).

-- ---- 1) invitations ---------------------------------------------------------------------
create or replace function public.invitations_api_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      raise exception 'invitations are created by an admin from Users' using errcode = '42501';
    elsif (new.id, new.org_id, new.email, new.role, new.token, new.invited_by, new.expires_at,
           new.accepted_at, new.accepted_by, new.created_at)
          is distinct from
          (old.id, old.org_id, old.email, old.role, old.token, old.invited_by, old.expires_at,
           old.accepted_at, old.accepted_by, old.created_at)
       or (new.status is distinct from old.status and new.status <> 'revoked') then
      raise exception 'an invitation can only be revoked here' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.invitations_api_guard() from public, anon, authenticated;
drop trigger if exists invitations_api_guard_biu on public.invitations;
create trigger invitations_api_guard_biu before insert or update on public.invitations
  for each row execute function public.invitations_api_guard();
revoke all on public.invitations from anon;
revoke insert on public.invitations from authenticated;
drop policy if exists "a74 inv upd pending only" on public.invitations;
create policy "a74 inv upd pending only" on public.invitations as restrictive for update to authenticated
  using (status = 'pending' and public.has_area('users', 'edit'))
  with check (status in ('pending', 'revoked'));

-- ---- 2) last admin protected ------------------------------------------------------------
create or replace function public.profiles_last_admin_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'admin' and old.org_id is not null
     and new.org_id is not distinct from old.org_id
     and new.role is distinct from 'admin' then
    perform 1 from public.profiles p where p.org_id = old.org_id and p.role = 'admin' for update;
    if not exists (select 1 from public.profiles p
                    where p.org_id = old.org_id and p.role = 'admin' and p.id <> old.id) then
      raise exception 'a studio must keep at least one admin - make someone else admin first'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.profiles_last_admin_guard() from public, anon, authenticated;
drop trigger if exists profiles_last_admin_guard_bu on public.profiles;
create trigger profiles_last_admin_guard_bu before update of role on public.profiles
  for each row execute function public.profiles_last_admin_guard();

-- ---- 3) chat_prefs ------------------------------------------------------------------------
create table if not exists public.chat_prefs (
  user_id         uuid not null default auth.uid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  pinned          boolean not null default false,
  muted           boolean not null default false,
  favourite       boolean not null default false,
  updated_at      timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
alter table public.chat_prefs enable row level security;
revoke all on public.chat_prefs from anon, public;
revoke insert, update, delete on public.chat_prefs from authenticated;
grant select on public.chat_prefs to authenticated;
drop policy if exists chat_prefs_own_read on public.chat_prefs;
create policy chat_prefs_own_read on public.chat_prefs for select to authenticated
  using (user_id = auth.uid());

-- null = leave that flag as it is
create or replace function public.chat_set_pref(p_conversation uuid, p_pinned boolean default null,
                                                p_muted boolean default null, p_favourite boolean default null)
returns public.chat_prefs language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.chat_prefs;
begin
  if v_uid is null or p_conversation is null or not public.chat_can_see(p_conversation) then
    raise exception 'not authorized for this conversation' using errcode = '42501';
  end if;
  insert into public.chat_prefs as cp (user_id, conversation_id, pinned, muted, favourite, updated_at)
  values (v_uid, p_conversation, coalesce(p_pinned, false), coalesce(p_muted, false), coalesce(p_favourite, false), now())
  on conflict (user_id, conversation_id) do update
     set pinned    = coalesce(p_pinned, cp.pinned),
         muted     = coalesce(p_muted, cp.muted),
         favourite = coalesce(p_favourite, cp.favourite),
         updated_at = now()
  returning * into r;
  return r;
end $$;
revoke all on function public.chat_set_pref(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.chat_set_pref(uuid, boolean, boolean, boolean) to authenticated;

-- ---- 4) chat media scoped to its conversation (new rows only) ---------------------------
create or replace function public.chat_messages_media_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- a malformed key is left to chat_messages_media_path_chk (same error as before)
  if new.media_path is not null
     and new.media_path ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/'
     and (tg_op = 'INSERT' or new.media_path is distinct from old.media_path)
     and lower(split_part(new.media_path, '/', 1) || '/' || split_part(new.media_path, '/', 2))
         is distinct from new.org_id::text || '/' || new.conversation_id::text then
    raise exception 'this attachment belongs to another conversation' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.chat_messages_media_scope() from public, anon, authenticated;
drop trigger if exists chat_messages_media_scope_biu on public.chat_messages;
create trigger chat_messages_media_scope_biu before insert or update of media_path on public.chat_messages
  for each row execute function public.chat_messages_media_scope();

-- ---- VERIFY (read-only) -------------------------------------------------------------------
-- select tgname from pg_trigger where tgname in ('invitations_api_guard_biu','profiles_last_admin_guard_bu','chat_messages_media_scope_biu');
-- select to_regclass('public.chat_prefs'), has_function_privilege('authenticated','public.chat_set_pref(uuid,boolean,boolean,boolean)','EXECUTE');

-- =====================================================================================
-- VERIFY - every row must say ok = true
-- =====================================================================================
select item, ok from (values
  ('invitations guard trigger',
     exists (select 1 from pg_trigger where tgname = 'invitations_api_guard_biu' and tgrelid = 'public.invitations'::regclass)),
  ('invitations: update only pending (restrictive)',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invitations'
               and policyname = 'a74 inv upd pending only' and permissive = 'RESTRICTIVE')),
  ('invitations: anon has no table access',
     not has_table_privilege('anon', 'public.invitations', 'select')
     and not has_table_privilege('anon', 'public.invitations', 'update')),
  ('last admin guard trigger',
     exists (select 1 from pg_trigger where tgname = 'profiles_last_admin_guard_bu' and tgrelid = 'public.profiles'::regclass)),
  ('chat_prefs exists with RLS',
     exists (select 1 from pg_class where oid = 'public.chat_prefs'::regclass and relrowsecurity)),
  ('chat_prefs: clients read only',
     has_table_privilege('authenticated', 'public.chat_prefs', 'select')
     and not has_table_privilege('authenticated', 'public.chat_prefs', 'insert')
     and not has_table_privilege('anon', 'public.chat_prefs', 'select')),
  ('chat_set_pref callable by authenticated only',
     has_function_privilege('authenticated', 'public.chat_set_pref(uuid,boolean,boolean,boolean)', 'execute')
     and not has_function_privilege('anon', 'public.chat_set_pref(uuid,boolean,boolean,boolean)', 'execute')),
  ('chat media scope trigger',
     exists (select 1 from pg_trigger where tgname = 'chat_messages_media_scope_biu' and tgrelid = 'public.chat_messages'::regclass)),
  ('guard functions not callable by clients',
     not has_function_privilege('authenticated', 'public.profiles_last_admin_guard()', 'execute')
     and not has_function_privilege('authenticated', 'public.chat_messages_media_scope()', 'execute'))
) v(item, ok);
