-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor
--   PART 1-3  Team chat            (0016 core + 0017 attachments + 0018 read tracking)
--   PART 4    Invitation photos    (0019 — security audit Phase 2, finding P2-01)
--   PART 5    Studio client links  (0020 — helm.events/<studio>/quote/… + anti-phishing check)
-- ════════════════════════════════════════════════════════════════════════════
-- SAFE: additive + idempotent. Re-running changes nothing and deletes nothing.
--   STAGING has PARTS 1-3; PRODUCTION has PARTS 1-3 (you ran APPLY-CHAT.sql on 2026-10-06).
--   Re-running those is a no-op; PARTS 4 + 5 are new on both.
-- ORDER FOR PRODUCTION: merge/deploy the app code to main FIRST (it signs invitation
--   photos), THEN run this. Running it before the deploy hides invitation photos
--   until the deploy lands (no data is lost either way).
-- USE: project → SQL Editor → paste ALL → Run → check the VERIFY rows at the end.
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: not a Helm database (current_org_id missing). Wrong project?'; end if;
  if to_regclass('public.organizations') is null or to_regclass('public.profiles') is null then raise exception 'STOP: organizations/profiles missing — wrong project?'; end if;
  if to_regclass('public.event_sites') is null then raise exception 'STOP: event_sites missing — invitation sites (phase87) not installed on this project'; end if;
  raise notice 'Preflight OK — applying chat + invitation photos + studio links…';
end $$;
-- ═══════════════════ PART 1/3 — chat core (0016) ════════════════════════════
-- ============================================================================
-- 0016_feature_chat.sql
-- Team chat (WhatsApp-style): per-organization DMs, groups and an org-wide
-- "Everyone" broadcast, with text / image / voice messages, replies, reactions
-- and read state. Real-time via the supabase_realtime publication.
--
-- Forward-only, idempotent (create if not exists / create or replace / guarded).
-- Tenant isolation: every row carries org_id (default current_org_id()), RLS
-- gates every table by org AND by conversation membership. Media lives in a
-- PRIVATE 'chat-media' bucket (signed URLs only), org-prefixed object keys.
--
-- Access model: ANY authenticated member of the org may use chat (no has_area
-- gate — chat is for the whole team); visibility is scoped to the conversations
-- you belong to (plus the org's single broadcast channel).
--
-- NOTE (provider): the storage.buckets / storage.objects and ALTER PUBLICATION
-- statements may require the migration/storage-admin role; re-verify on staging.
-- ============================================================================

-- ---------------------------------------------------------------- tables -----
create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  kind            text not null default 'dm' check (kind in ('dm','group','broadcast')),
  title           text,                                   -- group / broadcast name (DMs derive their title client-side)
  dm_key          text,                                   -- deterministic "<uuidA>:<uuidB>" for DMs → dedupe one DM per pair
  created_by      uuid default auth.uid() references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create unique index if not exists chat_conv_dm_key_uq  on public.chat_conversations(org_id, dm_key) where dm_key is not null;
create unique index if not exists chat_conv_bcast_uq   on public.chat_conversations(org_id)          where kind = 'broadcast';
create index        if not exists chat_conv_org_recent on public.chat_conversations(org_id, last_message_at desc);

create table if not exists public.chat_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  org_id          uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  member_role     text not null default 'member' check (member_role in ('admin','member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,                            -- read receipts / unread counts
  primary key (conversation_id, user_id)
);
create index if not exists chat_members_user on public.chat_members(user_id);
create index if not exists chat_members_org  on public.chat_members(org_id);

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  org_id          uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  sender_id       uuid default auth.uid() references auth.users(id) on delete set null,
  kind            text not null default 'text' check (kind in ('text','image','voice','system')),
  body            text,                                   -- text content or image caption
  media_path      text,                                   -- storage key in 'chat-media' (image / voice)
  media_mime      text,
  media_duration  integer,                                -- voice note length, seconds
  reply_to        uuid references public.chat_messages(id) on delete set null,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted         boolean not null default false
);
create index if not exists chat_msg_conv on public.chat_messages(conversation_id, created_at);
create index if not exists chat_msg_org  on public.chat_messages(org_id);

create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id     uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists chat_react_msg on public.chat_reactions(message_id);

-- ------------------------------------------------------------- helpers -------
-- SECURITY DEFINER so it bypasses chat_members' own RLS → no policy recursion.
create or replace function public.chat_is_member(p_conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_members m
    where m.conversation_id = p_conversation and m.user_id = auth.uid()
  );
$$;

-- A conversation is visible to the caller if they belong to it, OR it is their
-- org's broadcast channel ("Everyone"), which every org member can see.
create or replace function public.chat_can_see(p_conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_conversations c
    where c.id = p_conversation
      and c.org_id = public.current_org_id()
      and ( c.kind = 'broadcast' or public.chat_is_member(c.id) )
  );
$$;

revoke all on function public.chat_is_member(uuid) from anon, public;
revoke all on function public.chat_can_see(uuid)  from anon, public;
grant execute on function public.chat_is_member(uuid) to authenticated;
grant execute on function public.chat_can_see(uuid)  to authenticated;

-- ----------------------------------------------------------------- RLS -------
alter table public.chat_conversations enable row level security;
alter table public.chat_members       enable row level security;
alter table public.chat_messages      enable row level security;
alter table public.chat_reactions     enable row level security;

-- conversations: see your own org's broadcast + any conversation you belong to
drop policy if exists chat_conv_sel on public.chat_conversations;
create policy chat_conv_sel on public.chat_conversations for select to authenticated
  using ( org_id = (select public.current_org_id()) and ( kind = 'broadcast' or public.chat_is_member(id) ) );
-- creating a conversation (RPCs normally do this; allow a client create of your own org row)
drop policy if exists chat_conv_ins on public.chat_conversations;
create policy chat_conv_ins on public.chat_conversations for insert to authenticated
  with check ( org_id = (select public.current_org_id()) );
-- members may bump last_message_at / rename a group
drop policy if exists chat_conv_upd on public.chat_conversations;
create policy chat_conv_upd on public.chat_conversations for update to authenticated
  using ( org_id = (select public.current_org_id()) and public.chat_is_member(id) )
  with check ( org_id = (select public.current_org_id()) );

-- members: you can read the roster of conversations you can see; manage only your own row
drop policy if exists chat_mem_sel on public.chat_members;
create policy chat_mem_sel on public.chat_members for select to authenticated
  using ( org_id = (select public.current_org_id()) and public.chat_can_see(conversation_id) );
drop policy if exists chat_mem_ins on public.chat_members;
create policy chat_mem_ins on public.chat_members for insert to authenticated
  with check ( org_id = (select public.current_org_id()) and ( user_id = auth.uid() or public.chat_is_member(conversation_id) ) );
drop policy if exists chat_mem_upd on public.chat_members;      -- update your own last_read_at
create policy chat_mem_upd on public.chat_members for update to authenticated
  using ( user_id = auth.uid() ) with check ( user_id = auth.uid() );
drop policy if exists chat_mem_del on public.chat_members;      -- leave a conversation
create policy chat_mem_del on public.chat_members for delete to authenticated
  using ( user_id = auth.uid() and org_id = (select public.current_org_id()) );

-- messages: read anything in a conversation you can see; send only as yourself into one you can see
drop policy if exists chat_msg_sel on public.chat_messages;
create policy chat_msg_sel on public.chat_messages for select to authenticated
  using ( org_id = (select public.current_org_id()) and public.chat_can_see(conversation_id) );
drop policy if exists chat_msg_ins on public.chat_messages;
create policy chat_msg_ins on public.chat_messages for insert to authenticated
  with check ( org_id = (select public.current_org_id()) and sender_id = auth.uid() and public.chat_can_see(conversation_id) );
drop policy if exists chat_msg_upd on public.chat_messages;     -- edit / soft-delete your own message
create policy chat_msg_upd on public.chat_messages for update to authenticated
  using ( org_id = (select public.current_org_id()) and sender_id = auth.uid() )
  with check ( org_id = (select public.current_org_id()) and sender_id = auth.uid() );

-- reactions: see reactions on visible messages; add/remove only your own
drop policy if exists chat_react_sel on public.chat_reactions;
create policy chat_react_sel on public.chat_reactions for select to authenticated
  using ( org_id = (select public.current_org_id())
          and exists (select 1 from public.chat_messages m where m.id = message_id and public.chat_can_see(m.conversation_id)) );
drop policy if exists chat_react_ins on public.chat_reactions;
create policy chat_react_ins on public.chat_reactions for insert to authenticated
  with check ( org_id = (select public.current_org_id()) and user_id = auth.uid()
               and exists (select 1 from public.chat_messages m where m.id = message_id and public.chat_can_see(m.conversation_id)) );
drop policy if exists chat_react_del on public.chat_reactions;
create policy chat_react_del on public.chat_reactions for delete to authenticated
  using ( org_id = (select public.current_org_id()) and user_id = auth.uid() );

-- Base table privileges (RLS still governs which ROWS each member sees). anon gets nothing.
grant select, insert, update, delete on public.chat_conversations to authenticated;
grant select, insert, update, delete on public.chat_members       to authenticated;
grant select, insert, update, delete on public.chat_messages      to authenticated;
grant select, insert, update, delete on public.chat_reactions     to authenticated;

-- ----------------------------------------------------------------- RPCs ------
-- Open (or create) the 1:1 DM between the caller and p_other (same org). Returns the conversation id.
create or replace function public.chat_start_dm(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_key text; v_id uuid;
begin
  if p_other is null or p_other = v_me then raise exception 'invalid recipient' using errcode='22023'; end if;
  if not exists (select 1 from public.profiles where id = p_other and org_id = v_org) then
    raise exception 'recipient is not in your organization' using errcode='42501';
  end if;
  v_key := case when v_me < p_other then v_me::text||':'||p_other::text else p_other::text||':'||v_me::text end;
  select id into v_id from public.chat_conversations where org_id = v_org and dm_key = v_key;
  if v_id is null then
    insert into public.chat_conversations (org_id, kind, dm_key, created_by) values (v_org, 'dm', v_key, v_me) returning id into v_id;
    insert into public.chat_members (conversation_id, user_id, org_id) values (v_id, v_me, v_org), (v_id, p_other, v_org)
      on conflict do nothing;
  end if;
  return v_id;
end; $$;

-- Create a group with a title and an initial member list (caller is added as admin).
create or replace function public.chat_create_group(p_title text, p_members uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_id uuid; u uuid;
begin
  if coalesce(btrim(p_title),'') = '' then raise exception 'group name required' using errcode='22023'; end if;
  insert into public.chat_conversations (org_id, kind, title, created_by) values (v_org, 'group', btrim(p_title), v_me) returning id into v_id;
  insert into public.chat_members (conversation_id, user_id, org_id, member_role) values (v_id, v_me, v_org, 'admin') on conflict do nothing;
  if p_members is not null then
    foreach u in array p_members loop
      if u <> v_me and exists (select 1 from public.profiles where id = u and org_id = v_org) then
        insert into public.chat_members (conversation_id, user_id, org_id) values (v_id, u, v_org) on conflict do nothing;
      end if;
    end loop;
  end if;
  return v_id;
end; $$;

-- Add members to an existing group (caller must already be a member).
create or replace function public.chat_add_members(p_conversation uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); u uuid;
begin
  if not public.chat_is_member(p_conversation) then raise exception 'not a member' using errcode='42501'; end if;
  if p_members is not null then
    foreach u in array p_members loop
      if exists (select 1 from public.profiles where id = u and org_id = v_org) then
        insert into public.chat_members (conversation_id, user_id, org_id) values (p_conversation, u, v_org) on conflict do nothing;
      end if;
    end loop;
  end if;
end; $$;

-- Find or create the org's single "Everyone" broadcast channel.
create or replace function public.chat_ensure_broadcast()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  select id into v_id from public.chat_conversations where org_id = v_org and kind = 'broadcast';
  if v_id is null then
    insert into public.chat_conversations (org_id, kind, title) values (v_org, 'broadcast', 'Everyone') returning id into v_id;
  end if;
  return v_id;
end; $$;

-- Post a message. Validates visibility, stamps sender + org, bumps the conversation.
create or replace function public.chat_send(p_conversation uuid, p_kind text, p_body text,
  p_media_path text default null, p_media_mime text default null, p_media_duration integer default null,
  p_reply_to uuid default null)
returns public.chat_messages language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); r public.chat_messages;
begin
  if not public.chat_can_see(p_conversation) then raise exception 'not authorized for this conversation' using errcode='42501'; end if;
  if coalesce(p_kind,'text') not in ('text','image','voice','system') then raise exception 'bad kind' using errcode='22023'; end if;
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, media_path, media_mime, media_duration, reply_to)
    values (p_conversation, v_org, auth.uid(), coalesce(p_kind,'text'), p_body, p_media_path, p_media_mime, p_media_duration, p_reply_to)
    returning * into r;
  update public.chat_conversations set last_message_at = now() where id = p_conversation and org_id = v_org;
  return r;
end; $$;

-- Toggle a reaction on a message.
create or replace function public.chat_react(p_message uuid, p_emoji text, p_on boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id();
begin
  if not exists (select 1 from public.chat_messages m where m.id = p_message and public.chat_can_see(m.conversation_id)) then
    raise exception 'message not visible' using errcode='42501';
  end if;
  if p_on then
    insert into public.chat_reactions (message_id, user_id, org_id, emoji) values (p_message, auth.uid(), v_org, p_emoji)
      on conflict do nothing;
  else
    delete from public.chat_reactions where message_id = p_message and user_id = auth.uid() and emoji = p_emoji;
  end if;
end; $$;

-- Mark a conversation read up to now (for the caller).
create or replace function public.chat_mark_read(p_conversation uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.chat_members set last_read_at = now() where conversation_id = p_conversation and user_id = auth.uid();
end; $$;

revoke all on function public.chat_start_dm(uuid)                                   from anon, public;
revoke all on function public.chat_create_group(text, uuid[])                       from anon, public;
revoke all on function public.chat_add_members(uuid, uuid[])                        from anon, public;
revoke all on function public.chat_ensure_broadcast()                              from anon, public;
revoke all on function public.chat_send(uuid, text, text, text, text, integer, uuid) from anon, public;
revoke all on function public.chat_react(uuid, text, boolean)                       from anon, public;
revoke all on function public.chat_mark_read(uuid)                                  from anon, public;
grant execute on function public.chat_start_dm(uuid)                                   to authenticated;
grant execute on function public.chat_create_group(text, uuid[])                       to authenticated;
grant execute on function public.chat_add_members(uuid, uuid[])                        to authenticated;
grant execute on function public.chat_ensure_broadcast()                              to authenticated;
grant execute on function public.chat_send(uuid, text, text, text, text, integer, uuid) to authenticated;
grant execute on function public.chat_react(uuid, text, boolean)                       to authenticated;
grant execute on function public.chat_mark_read(uuid)                                  to authenticated;

-- --------------------------------------------------------------- storage -----
-- Private bucket for chat images + voice notes. Signed URLs only; org-prefixed keys.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media','chat-media', false, 16777216,
        array['image/png','image/jpeg','image/webp','image/gif',
              'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'])
on conflict (id) do update set public = false, file_size_limit = 16777216,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif',
              'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'];

-- storage.objects policies: the first path segment is the org id; only same-org members touch it.
drop policy if exists chat_media_sel on storage.objects;
create policy chat_media_sel on storage.objects for select to authenticated
  using ( bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.current_org_id()::text );
drop policy if exists chat_media_ins on storage.objects;
create policy chat_media_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.current_org_id()::text );
drop policy if exists chat_media_del on storage.objects;
create policy chat_media_del on storage.objects for delete to authenticated
  using ( bucket_id = 'chat-media' and (storage.foldername(name))[1] = public.current_org_id()::text );

-- -------------------------------------------------------------- realtime -----
-- postgres_changes respects RLS, so per-org delivery is enforced by the SELECT
-- policies above. replica identity full lets UPDATE/DELETE payloads carry the row.
alter table public.chat_messages  replica identity full;
alter table public.chat_reactions replica identity full;
alter table public.chat_conversations replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.chat_messages;      exception when others then null; end;
  begin alter publication supabase_realtime add table public.chat_reactions;     exception when others then null; end;
  begin alter publication supabase_realtime add table public.chat_conversations; exception when others then null; end;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select count(*) from pg_policies where tablename like 'chat\_%';            -- expect the policies above
-- select id, public, file_size_limit from storage.buckets where id='chat-media';
-- select relname from pg_publication_tables where pubname='supabase_realtime' and relname like 'chat_%';

-- ═══════════════════ PART 2/3 — attachments (0017) ══════════════════════════
-- ============================================================================
-- 0017_chat_attachments.sql
-- Rich attachments in team chat: a message can carry a "card" (a quote, a floor
-- layout, or — in future — any other object) alongside optional text. The card
-- payload is a free-form JSONB snapshot, so the feature is open-ended and needs
-- no further schema change to add new attachment types.
--
-- Forward-only, additive, idempotent. Depends on 0016_feature_chat.sql.
--   • chat_messages.meta  (jsonb)  — the attachment snapshot
--   • kind now allows 'card'
--   • chat_send() gains p_meta
-- Tenant isolation / RLS are unchanged (meta travels with the row it belongs to).
-- ============================================================================

-- 1) Attachment payload column (snapshot: title/amount/ref id/deeplink/etc.).
alter table public.chat_messages add column if not exists meta jsonb;

-- 2) Allow the new 'card' message kind. Re-created idempotently.
alter table public.chat_messages drop constraint if exists chat_messages_kind_check;
alter table public.chat_messages
  add  constraint chat_messages_kind_check
  check (kind in ('text','image','voice','system','card'));

-- 3) chat_send() gains p_meta. Drop the old 7-arg version first so the named-arg
--    RPC call is never ambiguous, then recreate with the extra trailing param.
drop function if exists public.chat_send(uuid, text, text, text, text, integer, uuid);

create or replace function public.chat_send(
  p_conversation uuid, p_kind text, p_body text,
  p_media_path text default null, p_media_mime text default null, p_media_duration integer default null,
  p_reply_to uuid default null, p_meta jsonb default null)
returns public.chat_messages language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); r public.chat_messages;
begin
  if not public.chat_can_see(p_conversation) then raise exception 'not authorized for this conversation' using errcode='42501'; end if;
  if coalesce(p_kind,'text') not in ('text','image','voice','system','card') then raise exception 'bad kind' using errcode='22023'; end if;
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, media_path, media_mime, media_duration, reply_to, meta)
    values (p_conversation, v_org, auth.uid(), coalesce(p_kind,'text'), p_body, p_media_path, p_media_mime, p_media_duration, p_reply_to, p_meta)
    returning * into r;
  update public.chat_conversations set last_message_at = now() where id = p_conversation and org_id = v_org;
  return r;
end; $$;

revoke all on function public.chat_send(uuid, text, text, text, text, integer, uuid, jsonb) from anon, public;
grant execute on function public.chat_send(uuid, text, text, text, text, integer, uuid, jsonb) to authenticated;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select column_name from information_schema.columns where table_name='chat_messages' and column_name='meta';
-- select pg_get_constraintdef(oid) from pg_constraint where conname='chat_messages_kind_check';

-- ═══════════════════ PART 3/3 — read tracking / bell (0018) ═════════════════
-- ============================================================================
-- 0018_chat_read_tracking.sql
-- Make read-state work for the org-wide "Everyone" broadcast (and any conversation
-- the caller can SEE but has no explicit chat_members row for yet). Before this,
-- chat_mark_read only UPDATEd an existing membership row, so the broadcast — which
-- has no per-user member rows — could never be marked read and always looked unread
-- (in the chat list and in the notification bell).
--
-- Fix: chat_mark_read upserts the caller's membership row, then stamps last_read_at.
-- This also enables read receipts on the broadcast. Forward-only, idempotent.
-- Depends on 0016_feature_chat.sql. Grants are preserved by create-or-replace.
-- ============================================================================

create or replace function public.chat_mark_read(p_conversation uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if not public.chat_can_see(p_conversation) then return; end if;   -- only convos I may see
  insert into public.chat_members (conversation_id, user_id, org_id)
    values (p_conversation, auth.uid(), public.current_org_id())
    on conflict (conversation_id, user_id) do nothing;
  update public.chat_members set last_read_at = now()
    where conversation_id = p_conversation and user_id = auth.uid();
end; $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select pg_get_functiondef('public.chat_mark_read(uuid)'::regprocedure);

-- ═══════════════════ PART 4/5 — invitation photos (0019) ═══════════════════
-- ============================================================================
-- 0019_invite_media_published_read.sql — CANONICAL forward-only (security audit
-- Phase 2, finding P2-01).
-- Problem: 0013 made the invite-media bucket private with own-org-only read, but the
-- PUBLIC invitation page (/i/<slug>, anonymous guests) renders those photos — so on
-- any DB where 0013 is applied, guests' photos are broken, and prod was left with a
-- PUBLIC bucket (anyone holding a URL can fetch any photo, incl. drafts and photos
-- of UNPUBLISHED sites, forever).
-- Fix: keep the bucket PRIVATE and add one narrow read policy — an object is readable
-- by anon/authenticated ONLY while it is a photo on a PUBLISHED event site of the SAME
-- org + quote its key is filed under (<org_id>/<quote_id>/<uuid>.<ext>). Guests get it
-- through a short-lived signed URL (store-api sites.mediaUrls). Unpublish => unreadable.
-- A tenant can't "claim" another org's photo by pasting its URL into their own site:
-- the key's org/quote folders must match the publishing site.
-- Idempotent. Additive (no data touched). Forward-only.
-- ============================================================================

create or replace function public.invite_media_on_published_site(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.event_sites s
     where s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name
       )
  );
$$;
revoke all on function public.invite_media_on_published_site(text) from public;
grant execute on function public.invite_media_on_published_site(text) to anon, authenticated;

-- bucket stays private (re-pin in case it was flipped public in the dashboard)
update storage.buckets set public = false where id = 'invite-media' and public is distinct from false;

-- legacy phase88 "anyone can SELECT/list" policy must never come back (SEC-05 F6 / 0013)
drop policy if exists "invite_media_public_read" on storage.objects;
drop policy if exists "invite_media_published_read" on storage.objects;
create policy "invite_media_published_read" on storage.objects for select to anon, authenticated
  using ( bucket_id = 'invite-media' and public.invite_media_on_published_site(name) );

-- staff keep reading their OWN org's photos (draft thumbnails in the studio). 0013 /
-- SEC-05 F6 already create this; ensure it on any DB that predates them.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'invite_media_org_read') then
    create policy "invite_media_org_read" on storage.objects for select to authenticated
      using ( bucket_id = 'invite-media'
              and (storage.foldername(name))[1] = (select public.current_org_id())::text );
  end if;
end $$;

-- ---- VERIFY ----------------------------------------------------------------
-- select public from storage.buckets where id='invite-media';                       -- false
-- select policyname, roles from pg_policies where schemaname='storage' and policyname like 'invite_media%';

-- ═══════════════════ PART 5/5 — studio client links (0020) ═════════════════
-- ============================================================================
-- 0020_studio_links.sql — CANONICAL forward-only. Branded, secure client links:
--   https://www.helm.events/<studio>/invite/<event-slug>
--   https://www.helm.events/<studio>/quote/<token>      (client approval)
--   https://www.helm.events/<studio>/proposal/<token>
--   https://www.helm.events/<studio>/portal/<token>
--   https://www.helm.events/<studio>/work/<token>       (crew checklist)
-- Security model:
--   * The <token>/<event-slug> stays the ONLY secret. <studio> is a public label.
--   * Anti-phishing: public pages ask public_link_studio() whether <studio> really
--     owns that link; on a mismatch they show "not found", so nobody can wrap their
--     own token in another studio's name (helm.events/trusted-studio/quote/<mine>).
--   * Renaming keeps every old name working for that studio (org_slug_history) and
--     a retired name can never be claimed by a different studio.
--   * Only admins / controls editors change the name; format + reserved words are
--     enforced by a trigger, so a direct table UPDATE can't bypass the rules.
--   * Old links (/i/<slug>, /approve.html?token=…) keep working.
-- Also aligns canonical with prod SEC-05 F8: studio settings writable by admin /
-- controls editors only (was: any member of the studio).
-- Additive + idempotent. Only writes the NEW public_slug column (backfill).
-- ============================================================================

-- ---- column + history ------------------------------------------------------
alter table public.organizations add column if not exists public_slug text;
create unique index if not exists organizations_public_slug_uidx on public.organizations (public_slug);

create table if not exists public.org_slug_history (
  slug       text primary key,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  retired_at timestamptz not null default now()
);
alter table public.org_slug_history enable row level security;      -- no policies: definer functions only
revoke all on public.org_slug_history from anon, authenticated;

-- ---- rules -----------------------------------------------------------------
create or replace function public.studio_slug_reserved(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p = any (array[
    -- app pages (public/*.html) + routes
    '404','about','approve','audit','budget','builder','calendar','chat','closure','command','control',
    'crm','dashboard','design','discovery','event','flow','index','insights','inventory','invite-studio',
    'invite','issues','leads','login','logistics','media','nurture','ops','plan','portal','privacy',
    'proposal-view','proposal','quotes','ready','reports','resources','runsheet','services','settlement',
    'sim-pay','staff','teardown','templates','terms','vendors','work','quote','i',
    -- system / brand / infrastructure words
    'api','docs','vendor','assets','static','public','admin','administrator','app','www','mail','email',
    'help','support','security','well-known','logout','signup','register','settings','account','billing',
    'helm','helm-events','helmevents','official','status','blog','pricing','null','undefined','root',
    'system','test','dev','staging','prod','production','cdn','img','images','files','auth','oauth',
    'callback','robots','sitemap','favicon','studio','studios','new','edit','owner'
  ]);
$$;

create or replace function public.studio_slug_valid(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and p ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
     and position('--' in p) = 0
     and not public.studio_slug_reserved(p);
$$;

create or replace function public.studio_slugify(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'), '-'), 36), ''), 'studio');
$$;

-- free for p_org? (not another studio's current OR retired name)
create or replace function public.studio_slug_free(p_slug text, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.organizations o where o.public_slug = p_slug and o.id <> p_org)
     and not exists (select 1 from public.org_slug_history h where h.slug = p_slug and h.org_id <> p_org);
$$;
revoke all on function public.studio_slug_free(text, uuid) from public;

-- first free name for a studio: base, base-2, base-3, …
create or replace function public.studio_slug_pick(p_name text, p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_base text := btrim(left(public.studio_slugify(p_name), 36), '-'); v_try text; n int := 1;
begin
  if length(v_base) < 3 then v_base := v_base || '-studio'; end if;
  if public.studio_slug_reserved(v_base) then v_base := v_base || '-events'; end if;
  v_try := v_base;
  while not (public.studio_slug_valid(v_try) and public.studio_slug_free(v_try, p_org)) loop
    n := n + 1; v_try := v_base || '-' || n;
    if n > 500 then return 'studio-' || left(replace(p_org::text, '-', ''), 12); end if;
  end loop;
  return v_try;
end $$;
revoke all on function public.studio_slug_pick(text, uuid) from public;

-- ---- enforcement trigger (covers the RPC AND any direct UPDATE) -------------
create or replace function public.organizations_public_slug_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.public_slug is null then new.public_slug := public.studio_slug_pick(new.name, new.id); end if;
  elsif new.public_slug is distinct from old.public_slug then
    if new.public_slug is null then raise exception 'studio link name cannot be removed' using errcode = '22023'; end if;
    -- signed-in callers must be admin / controls editors (migrations & service role bypass: auth.uid() null)
    if auth.uid() is not null and not (public.is_admin() or public.has_area('controls', 'edit')) then
      raise exception 'only an admin can change the studio link name' using errcode = '42501';
    end if;
    new.public_slug := lower(btrim(new.public_slug));
  end if;
  if not public.studio_slug_valid(new.public_slug) then
    raise exception 'studio link name must be 3-40 letters, numbers or dashes (and not a reserved word)' using errcode = '22023';
  end if;
  if not public.studio_slug_free(new.public_slug, new.id) then
    raise exception 'that studio link name is already taken' using errcode = '23505';
  end if;
  if tg_op = 'UPDATE' and old.public_slug is not null and new.public_slug is distinct from old.public_slug then
    insert into public.org_slug_history (slug, org_id) values (old.public_slug, old.id) on conflict (slug) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists organizations_public_slug_guard_biu on public.organizations;
create trigger organizations_public_slug_guard_biu before insert or update of public_slug on public.organizations
  for each row execute function public.organizations_public_slug_guard();

-- ---- backfill existing studios (new column only; nothing else touched) ------
do $$ declare r record; begin
  for r in select id, name from public.organizations where public_slug is null order by created_at, id loop
    update public.organizations set public_slug = public.studio_slug_pick(r.name, r.id) where id = r.id;
  end loop;
end $$;

-- ---- SEC-05 F8 (aligned with prod): settings writable by admin/controls only --
drop policy if exists "org self write" on public.organizations;
create policy "org self write" on public.organizations for update to authenticated
  using ( id = (select public.current_org_id())
          and (public.is_admin() or public.has_area('controls','edit')) )
  with check ( id = (select public.current_org_id())
               and (public.is_admin() or public.has_area('controls','edit')) );

-- ---- admin RPC: rename ------------------------------------------------------
create or replace function public.set_studio_link_name(p_slug text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_slug text := lower(btrim(coalesce(p_slug, '')));
begin
  if auth.uid() is null or v_org is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not (public.is_admin() or public.has_area('controls', 'edit')) then
    raise exception 'only an admin can change the studio link name' using errcode = '42501';
  end if;
  update public.organizations set public_slug = v_slug where id = v_org;   -- guard trigger validates + records history
  return v_slug;
end $$;
revoke all on function public.set_studio_link_name(text) from public, anon;
grant execute on function public.set_studio_link_name(text) to authenticated;

-- ---- PUBLIC resolver (anon): does <studio> own this link? -------------------
-- Returns the studio's CURRENT link name when p_studio is its current or a retired
-- name; NULL otherwise (unknown/unpublished link or a different studio).
create or replace function public.public_link_studio(p_kind text, p_ref text, p_studio text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_tok uuid; v_slug text := lower(btrim(coalesce(p_studio, '')));
begin
  if p_ref is null or length(p_ref) > 200 or v_slug = '' or length(v_slug) > 60 then return null; end if;
  if p_kind = 'invite' then
    select s.org_id into v_org from public.event_sites s where s.slug = p_ref and s.status = 'published';
  elsif p_kind in ('quote', 'portal', 'proposal', 'work') then
    if p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    v_tok := p_ref::uuid;
    if p_kind in ('quote', 'portal') then
      select q.org_id into v_org from public.quotes q where q.approval_token = v_tok;
    elsif p_kind = 'proposal' then
      select q.org_id into v_org from public.event_proposal pr join public.quotes q on q.id = pr.quote_id
       where pr.share_token = v_tok and pr.published = true;
    else
      select w.org_id into v_org from public.work_tokens w where w.token = v_tok;
    end if;
  else
    return null;
  end if;
  if v_org is null then return null; end if;
  return (select o.public_slug from public.organizations o
           where o.id = v_org
             and (o.public_slug = v_slug
                  or exists (select 1 from public.org_slug_history h where h.org_id = v_org and h.slug = v_slug)));
end $$;
revoke all on function public.public_link_studio(text, text, text) from public;
grant execute on function public.public_link_studio(text, text, text) to anon, authenticated;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select count(*) filter (where public_slug is null) as missing, count(*) as studios from public.organizations;  -- missing = 0
-- select id, name, public_slug from public.organizations order by created_at;

-- ════════════════════════════════ VERIFY ════════════════════════════════════
select tablename, policyname from pg_policies where tablename like 'chat\_%' order by tablename, policyname;  -- ~13 rows
select id, public, file_size_limit from storage.buckets where id = 'chat-media';                              -- 1 row, public=false
select column_name from information_schema.columns where table_name='chat_messages' and column_name='meta';   -- 'meta'
select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename like 'chat_%' order by tablename;  -- chat_* realtime

-- ---- PART 4 VERIFY (read-only) — expect: public=false, and BOTH policies listed ----
select 'P4_bucket' as check, id, public, file_size_limit from storage.buckets where id = 'invite-media';
select 'P4_policies' as check, policyname, cmd, roles from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and policyname like 'invite_media%' order by policyname;
-- expect NO row named invite_media_public_read; invite_media_published_read + invite_media_org_read present.

-- ---- PART 5 VERIFY (read-only) — expect missing = 0, and each studio has a link name ----
select 'P5_studios' as check, count(*) filter (where public_slug is null) as missing, count(*) as studios from public.organizations;
select 'P5_names' as check, name, public_slug from public.organizations order by created_at;
