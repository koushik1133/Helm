-- 0137_event_group_title_dot.sql - CANONICAL forward-only. REQUIRES 0035 (create_event_group).
--
-- In plain words:
--   The event-group chat title is "<code> <middle dot> <event name>". On the live databases the
--   middle dot inside create_event_group was pasted with the wrong text encoding, so new groups
--   were named "DEMO-101 <garbled> Demo ..." (the dot showed as two odd characters). This re-creates the
--   function with the dot written as chr(183), so the file is plain ASCII and cannot be mangled
--   by a copy/paste again. Same body, same security (definer, search_path '', has_area gate,
--   same-studio checks), same grants. No table or row is changed: existing titles are shown
--   correctly by the app (display-side fix in store-api.js).
-- Idempotent: create or replace + revoke/grant.

create or replace function public.create_event_group(p_quote uuid, p_members uuid[] default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  q record; v_id uuid; v_name text; v_title text; v_card jsonb; u uuid; n integer := 0; v_email text;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select qq.id, qq.code, qq.title, qq.status, qq.client into q
    from public.quotes qq where qq.id = p_quote and qq.org_id = v_org;
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm.event_group:' || p_quote::text, 0));
  select c.id into v_id from public.chat_conversations c where c.quote_id = p_quote and c.org_id = v_org;
  if v_id is not null then return v_id; end if;
  if q.status is distinct from 'confirmed' then
    raise exception 'Confirm this quote before creating its event group.' using errcode = '22023';
  end if;
  v_name := coalesce(nullif(nullif(btrim(q.title), ''), 'Untitled event'), nullif(btrim(q.client ->> 'name'), ''), 'Event');
  v_title := left(regexp_replace(q.code || ' ' || chr(183) || ' ' || v_name, '[[:cntrl:]]', ' ', 'g'), 120);
  insert into public.chat_conversations (org_id, kind, title, created_by, quote_id)
    values (v_org, 'group', v_title, v_me, p_quote)
    on conflict (quote_id) where quote_id is not null do nothing
    returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.chat_conversations c where c.quote_id = p_quote and c.org_id = v_org;
    return v_id;
  end if;
  insert into public.chat_members (conversation_id, user_id, org_id, member_role)
    values (v_id, v_me, v_org, 'admin') on conflict do nothing;
  if p_members is not null then
    foreach u in array p_members loop
      n := n + 1; exit when n > 200;
      if u is not null and u <> v_me and exists (select 1 from public.profiles p where p.id = u and p.org_id = v_org) then
        insert into public.chat_members (conversation_id, user_id, org_id) values (v_id, u, v_org) on conflict do nothing;
      end if;
    end loop;
  end if;
  v_card := public._event_card(p_quote);
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, meta)
    values (v_id, v_org, null, 'card', 'Event details', v_card);
  update public.chat_conversations set last_message_at = now() where id = v_id;
  select p.email into v_email from public.profiles p where p.id = v_me;
  insert into public.audit_log (actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
    values (v_me, v_email, 'chat.event_group.create', 'chat_conversations', v_id::text, p_quote, v_org,
            jsonb_build_object('title', v_title));
  return v_id;
end $$;

revoke all on function public.create_event_group(uuid, uuid[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.create_event_group(uuid, uuid[]) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_event_group(uuid, uuid[]) to authenticated'; end if;
end $$;
