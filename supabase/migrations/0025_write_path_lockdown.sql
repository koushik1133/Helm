-- ============================================================================
-- 0025_write_path_lockdown.sql — CANONICAL forward-only. Security audit Phase 6
-- (mass assignment). Several tables could be written straight through the API by
-- anyone holding the table's area right, skipping the server function that owns
-- that change (and its checks). Every one was exploited on the disposable test DB
-- (tests/db/write-path-lockdown.sql) before this fix:
--   payment ledger ......... staff could add a fake paid receipt, change or delete a real one
--   client consent ......... staff could forge an "OTP-verified" consent (the legal record)
--   quote approval/payment . staff could mark a quote approved / paid / confirmed and
--                            revive a revoked client link (skipping OTP, mark_paid, confirm)
--   invitations ............ a non-admin with Users edit could mint an ADMIN invitation
--   team chat .............. any member could join a private chat (read its history),
--                            plant a fake DM between two colleagues, move messages,
--                            and open / delete every chat photo in the studio
--   crew links, proposal publish, invitation-site link name, vendor "settled",
--   equipment check-out ...... the same direct-write bypass, lower impact
--   admin_store_otp ......... the server-only OTP helper was callable by signed-in users
-- Fix pattern (as 0021): the app never writes these directly — every legitimate write
-- is a SECURITY DEFINER function (runs as its owner) or the service role (Edge
-- Functions). So direct writes by the API roles (anon / authenticated) are refused:
-- by revoking the table privilege AND by a guard trigger (belt and braces, so a
-- legacy "grant all" can't silently re-open it). Writes the app DOES make directly
-- (edit a chat message, revoke an invitation, edit quote details / invitation
-- content, vendors settle) keep working.
-- Additive + idempotent. No rows are changed or deleted.
-- ============================================================================

-- ---- shared guard: "only the server functions write this table" ---------------
create or replace function public.api_write_block()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- direct API callers only; SECURITY DEFINER functions run as their owner and pass
  if current_user in ('anon', 'authenticated') then
    raise exception 'this change can only be made through the app (%.%)', tg_table_name, lower(tg_op)
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public.api_write_block() from public, anon, authenticated;

-- ---- 1) money ledger + client consent: server functions only -----------------
revoke insert, update, delete on public.quote_payments from anon, authenticated;
drop trigger if exists aa_api_write_block on public.quote_payments;
create trigger aa_api_write_block before insert or update or delete on public.quote_payments
  for each row execute function public.api_write_block();

revoke insert, update, delete on public.quote_consents from anon, authenticated;
drop trigger if exists aa_api_write_block on public.quote_consents;
create trigger aa_api_write_block before insert or update or delete on public.quote_consents
  for each row execute function public.api_write_block();

-- ---- 2) crew links, proposal publish, equipment check-out: server functions only
--         (deleting stays as it is — the app removes check-outs / links directly)
revoke insert, update on public.work_tokens         from anon, authenticated;
revoke insert, update on public.event_proposal      from anon, authenticated;
revoke insert, update on public.inventory_checkouts from anon, authenticated;
drop trigger if exists aa_api_write_block on public.work_tokens;
create trigger aa_api_write_block before insert or update on public.work_tokens
  for each row execute function public.api_write_block();
drop trigger if exists aa_api_write_block on public.event_proposal;
create trigger aa_api_write_block before insert or update on public.event_proposal
  for each row execute function public.api_write_block();
drop trigger if exists aa_api_write_block on public.inventory_checkouts;
create trigger aa_api_write_block before insert or update on public.inventory_checkouts
  for each row execute function public.api_write_block();

-- ---- 3) quote approval / payment / confirmation state ---------------------------
-- The app edits title, client, pricing, date/time, manager directly; the state below
-- belongs to confirm_quote, verify_and_consent, mark_paid, record_payment,
-- set_lifecycle_stage, close_event and the approval-link functions. Named "quotes_a…"
-- so it fires BEFORE zz_approval_token_expiry (which legitimately extends the link).
create or replace function public.quotes_api_state_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.status is distinct from 'quote' or new.approval_status is distinct from 'none'
         or new.approval_token is not null or new.approval_token_expires_at is not null
         or new.approval_token_revoked_at is not null or new.confirmed_at is not null
         or new.confirmed_by is not null or coalesce(new.lifecycle_stage, 'quote') <> 'quote' then
        raise exception 'a new quote starts as a draft quote' using errcode = '42501';
      end if;
    elsif new.status is distinct from old.status
       or new.approval_status is distinct from old.approval_status
       or new.approval_token is distinct from old.approval_token
       or new.approval_token_expires_at is distinct from old.approval_token_expires_at
       or new.approval_token_revoked_at is distinct from old.approval_token_revoked_at
       or new.confirmed_at is distinct from old.confirmed_at
       or new.confirmed_by is distinct from old.confirmed_by
       or new.lifecycle_stage is distinct from old.lifecycle_stage then
      raise exception 'approval, payment and confirmation status change only through their actions in the app'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.quotes_api_state_guard() from public, anon, authenticated;
drop trigger if exists quotes_api_state_guard_biu on public.quotes;
create trigger quotes_api_state_guard_biu before insert or update on public.quotes
  for each row execute function public.quotes_api_state_guard();

-- ---- 4) invitations: created only by an admin (create_invitation); the app may
--         only revoke one directly ------------------------------------------------
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
revoke insert on public.invitations from anon, authenticated;
drop trigger if exists invitations_api_guard_biu on public.invitations;
create trigger invitations_api_guard_biu before insert or update on public.invitations
  for each row execute function public.invitations_api_guard();

-- ---- 5) invitation site: link name + publishing only through publish_event_site
create or replace function public.event_sites_api_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      raise exception 'invitation sites are created from Invite Studio' using errcode = '42501';
    elsif new.slug is distinct from old.slug or new.status is distinct from old.status
       or new.published_at is distinct from old.published_at
       or new.quote_id is distinct from old.quote_id then
      raise exception 'publish or unpublish the invitation from Invite Studio' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.event_sites_api_guard() from public, anon, authenticated;
drop trigger if exists aa_event_sites_api_guard on public.event_sites;
create trigger aa_event_sites_api_guard before insert or update on public.event_sites
  for each row execute function public.event_sites_api_guard();

-- ---- 6) vendor bookings: marking "settled" needs Settlement edit -------------------
create or replace function public.event_resources_settle_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated')
     and ((tg_op = 'INSERT' and coalesce(new.settled, false))
          or (tg_op = 'UPDATE' and (new.settled is distinct from old.settled
                                    or new.settled_at is distinct from old.settled_at)))
     and not public.has_area('settlement', 'edit') then
    raise exception 'settling a vendor needs Settlement edit access' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.event_resources_settle_guard() from public, anon, authenticated;
drop trigger if exists event_resources_settle_guard_biu on public.event_resources;
create trigger event_resources_settle_guard_biu before insert or update on public.event_resources
  for each row execute function public.event_resources_settle_guard();

-- ---- 7) team chat ---------------------------------------------------------------
-- Conversations and memberships are created only by the chat functions; a member
-- can still leave (delete their own membership row).
revoke insert, update on public.chat_conversations from anon, authenticated;
revoke insert, update on public.chat_members       from anon, authenticated;
drop trigger if exists aa_api_write_block on public.chat_conversations;
create trigger aa_api_write_block before insert or update on public.chat_conversations
  for each row execute function public.api_write_block();
drop trigger if exists aa_api_write_block on public.chat_members;
create trigger aa_api_write_block before insert or update on public.chat_members
  for each row execute function public.api_write_block();

-- A message's author may edit its text or delete it — never move it, re-attribute
-- it, or swap in a different attachment.
create or replace function public.chat_messages_api_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and tg_op = 'UPDATE' then
    if (new.id, new.conversation_id, new.org_id, new.sender_id, new.kind, new.reply_to, new.created_at)
       is distinct from
       (old.id, old.conversation_id, old.org_id, old.sender_id, old.kind, old.reply_to, old.created_at)
       or (new.media_path is distinct from old.media_path and new.media_path is not null)
       or (new.meta is distinct from old.meta and new.meta is not null) then
      raise exception 'a message can only be edited or deleted' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.chat_messages_api_guard() from public, anon, authenticated;
drop trigger if exists chat_messages_api_guard_bu on public.chat_messages;
create trigger chat_messages_api_guard_bu before update on public.chat_messages
  for each row execute function public.chat_messages_api_guard();

-- Opening a DM only ever lands in the real 1:1 conversation of these two people.
create or replace function public.chat_start_dm(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_key text; v_id uuid;
begin
  if p_other is null or p_other = v_me then raise exception 'invalid recipient' using errcode='22023'; end if;
  if not exists (select 1 from public.profiles where id = p_other and org_id = v_org) then
    raise exception 'recipient is not in your organization' using errcode='42501';
  end if;
  v_key := case when v_me < p_other then v_me::text||':'||p_other::text else p_other::text||':'||v_me::text end;
  select id into v_id from public.chat_conversations where org_id = v_org and dm_key = v_key and kind = 'dm';
  if v_id is null then
    if exists (select 1 from public.chat_conversations where org_id = v_org and dm_key = v_key) then
      raise exception 'this conversation needs an admin to check it' using errcode='42501';
    end if;
    insert into public.chat_conversations (org_id, kind, dm_key, created_by) values (v_org, 'dm', v_key, v_me) returning id into v_id;
  end if;
  -- both people are (back) in it; nobody else may be
  insert into public.chat_members (conversation_id, user_id, org_id) values (v_id, v_me, v_org), (v_id, p_other, v_org)
    on conflict do nothing;
  if exists (select 1 from public.chat_members where conversation_id = v_id and user_id not in (v_me, p_other)) then
    raise exception 'this conversation needs an admin to check it' using errcode='42501';
  end if;
  return v_id;
end; $$;
revoke all on function public.chat_start_dm(uuid) from anon, public;
grant execute on function public.chat_start_dm(uuid) to authenticated;

-- Chat photos / voice notes: only people in that conversation can open or upload
-- them, and only the uploader can delete one (was: anyone in the studio).
create or replace function public.chat_media_visible(p_name text)
returns boolean language plpgsql stable set search_path = '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_conv uuid;
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3
     or v_parts[1] is distinct from public.current_org_id()::text then
    return false;
  end if;
  begin v_conv := v_parts[2]::uuid; exception when others then return false; end;
  return public.chat_can_see(v_conv);
end $$;
revoke all on function public.chat_media_visible(text) from public, anon;
grant execute on function public.chat_media_visible(text) to authenticated;

drop policy if exists chat_media_sel on storage.objects;
create policy chat_media_sel on storage.objects for select to authenticated
  using ( bucket_id = 'chat-media' and public.chat_media_visible(name) );
drop policy if exists chat_media_ins on storage.objects;
create policy chat_media_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'chat-media' and public.chat_media_visible(name) );
drop policy if exists chat_media_del on storage.objects;
create policy chat_media_del on storage.objects for delete to authenticated
  using ( bucket_id = 'chat-media' and owner = auth.uid()
          and (storage.foldername(name))[1] = public.current_org_id()::text );

-- ---- 8) the OTP-store helper is for the send-otp Edge Function (service role) only
do $$ begin
  if to_regprocedure('public.admin_store_otp(uuid,text,text)') is not null then
    revoke all on function public.admin_store_otp(uuid, text, text) from public, anon, authenticated;
    grant execute on function public.admin_store_otp(uuid, text, text) to service_role;
  end if;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select has_table_privilege('authenticated','public.quote_payments','INSERT');            -- false
-- select has_function_privilege('authenticated','public.admin_store_otp(uuid,text,text)','EXECUTE'); -- false
-- select tgname, tgrelid::regclass from pg_trigger where tgname in
--   ('aa_api_write_block','quotes_api_state_guard_biu','invitations_api_guard_biu','aa_event_sites_api_guard',
--    'event_resources_settle_guard_biu','chat_messages_api_guard_bu');
