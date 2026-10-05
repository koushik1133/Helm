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
