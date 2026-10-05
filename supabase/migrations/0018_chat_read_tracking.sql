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
