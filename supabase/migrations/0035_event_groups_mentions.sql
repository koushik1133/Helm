-- ============================================================================
-- 0035_event_groups_mentions.sql — CANONICAL forward-only. Event groups + @mentions.
--
-- What this adds, in plain words:
--   1  An "event group": a team chat group tied to ONE confirmed quote/event.
--      create_event_group(quote, members) makes it (or returns the one that
--      already exists — never a duplicate, even when two people click at once),
--      adds the creator + the picked studio members, and posts an "event card":
--      client name/phone/e-mail, event type, date/time, venue, guest count,
--      layout summary, menu package + dishes, notes. The card is built HERE on
--      the server from an explicit whitelist — it NEVER carries an amount, price,
--      advance, payment, balance, discount or GST, and the app can't inject one.
--   2  refresh_event_group(conversation) posts an updated card (same whitelist)
--      when the event details changed; nothing is posted when nothing changed.
--      Only while the quote is still confirmed.
--   3  event_group_index() — which quotes in my studio already have a group (and
--      am I in it), so the Quotes page shows "Open event group" instead of
--      offering to create a second one.
--   4  @mentions: a message may carry meta.mentions (a list of user ids). A
--      trigger keeps only people who are in that conversation (and in the same
--      studio) — everyone else is silently dropped. chat_my_mentions() lists my
--      unread mentions for the notification bell (shown even if the chat is muted).
--
-- Rules enforced here (not in the browser):
--   * create: signed-in, same studio as the quote, quotes view access, quote
--     confirmed. Another studio's quote / unknown quote → "not authorized".
--   * event cards can only be posted by these functions (sender_id is null);
--     a user (direct insert or chat_send) posting meta.kind = 'event' is refused.
--   * one group per quote: unique index on chat_conversations.quote_id + a
--     per-quote transaction lock. If the quote is later deleted the group stays
--     (quote_id becomes null); if it is cancelled/un-confirmed the group stays but
--     no new event card can be posted.
--   * later members are added with the existing chat_add_members (any member of
--     the group may add studio members, same as any group).
--
-- Additive + idempotent: one nullable column, two indexes, functions, one trigger.
-- No existing row is changed or deleted. Forward-only.
-- ============================================================================

-- 1) link a group conversation to its quote ---------------------------------------
alter table public.chat_conversations add column if not exists quote_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'chat_conversations_quote_id_fkey'
                    and conrelid = 'public.chat_conversations'::regclass) then
    alter table public.chat_conversations
      add constraint chat_conversations_quote_id_fkey
      foreign key (quote_id) references public.quotes(id) on delete set null;
  end if;
end $$;
create unique index if not exists chat_conv_quote_uq on public.chat_conversations(quote_id) where quote_id is not null;
-- same G4 guard every quote_id + org_id table has (0004): the quote must be this studio's
drop trigger if exists zz_quote_org_match on public.chat_conversations;
create trigger zz_quote_org_match before insert or update on public.chat_conversations
  for each row execute function public.tg_quote_org_match();

-- mentions lookup ("which messages mention me") ------------------------------------
create index if not exists chat_msg_mentions_gin on public.chat_messages using gin ((meta -> 'mentions'));

-- 2) message meta guard: event cards are server-only; mentions are sanitised ----------
create or replace function public.tg_chat_message_meta()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_org uuid; v_ids jsonb;
begin
  if new.meta is null or jsonb_typeof(new.meta) <> 'object' then return new; end if;
  if tg_op = 'UPDATE' and new.meta is not distinct from old.meta then return new; end if;
  -- an event card is only ever written by create_event_group / refresh_event_group
  if new.meta ->> 'kind' = 'event' and new.sender_id is not null then
    raise exception 'Event cards are posted by Helm only.' using errcode = '42501';
  end if;
  if new.meta ? 'mentions' then
    select c.kind, c.org_id into v_kind, v_org from public.chat_conversations c where c.id = new.conversation_id;
    v_ids := '[]'::jsonb;
    if jsonb_typeof(new.meta -> 'mentions') = 'array' and v_org is not null then
      select coalesce(jsonb_agg(to_jsonb(s.u) order by s.first_ord), '[]'::jsonb) into v_ids
        from (select k.u, k.first_ord
                from (select e.v::uuid as u, min(e.ord) as first_ord
                        from jsonb_array_elements_text(new.meta -> 'mentions') with ordinality as e(v, ord)
                       where e.ord <= 200
                         and e.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       group by e.v::uuid) k
               where k.u is distinct from new.sender_id
                 and exists (select 1 from public.profiles p where p.id = k.u and p.org_id = v_org)
                 and (v_kind = 'broadcast'
                      or exists (select 1 from public.chat_members m
                                  where m.conversation_id = new.conversation_id and m.user_id = k.u))
               order by k.first_ord
               limit 50) s;
    end if;
    if v_ids = '[]'::jsonb then new.meta := new.meta - 'mentions';
    else new.meta := jsonb_set(new.meta, '{mentions}', v_ids); end if;
    if new.meta = '{}'::jsonb then new.meta := null; end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_chat_message_meta() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.tg_chat_message_meta() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.tg_chat_message_meta() from authenticated'; end if;
end $$;
drop trigger if exists chat_messages_meta_guard_biu on public.chat_messages;
create trigger chat_messages_meta_guard_biu before insert or update of meta on public.chat_messages
  for each row execute function public.tg_chat_message_meta();

-- 3) the event card (internal) — EXPLICIT WHITELIST, never a money field ----------------
--    Keys: kind, v, quote_id, code, title, status, event_type, event_date, event_time,
--    client{name,phone,email,company}, venue, venue_address, guests,
--    layout{kind,quote_id,version,object_count}, menu{package,notes,dishes[{name,category,kind}]},
--    notes, access_notes, generated_at. Nothing else is ever copied from the quote.
create or replace function public._event_card(p_quote uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  q record; ep record; v_objs integer; v_dishes jsonb; v_g text; v_guests integer; v_date text;
begin
  select qq.id, qq.code, qq.title, qq.status, qq.event_type, qq.event_date, qq.event_time,
         qq.current_version, qq.client, qq.pricing
    into q from public.quotes qq where qq.id = p_quote;
  if q.id is null then return null; end if;
  select e.venue_name, e.venue_address, e.access_notes, e.package, e.menu_template, e.menu
    into ep from public.event_plan e where e.quote_id = p_quote;
  select qv.object_count into v_objs from public.quote_versions qv
   where qv.quote_id = p_quote and qv.version_no = q.current_version limit 1;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'name', left(btrim(mi.dish_name), 120),
           'category', left(nullif(btrim(mi.category), ''), 60),
           'kind', left(nullif(btrim(mi.kind), ''), 30))) order by mi.seq, mi.dish_name), '[]'::jsonb)
    into v_dishes
    from (select m.dish_name, m.category, m.kind, m.seq from public.event_menu_items m
           where m.quote_id = p_quote and nullif(btrim(m.dish_name), '') is not null
           order by m.seq, m.dish_name limit 150) mi;
  -- guest count only (a number of people — never a rate or an amount)
  v_g := coalesce(nullif(btrim(q.pricing ->> 'guests'), ''), nullif(btrim(q.client ->> 'guests'), ''),
                  nullif(btrim(q.pricing ->> 'chairs'), ''));
  v_guests := case when v_g ~ '^[0-9]{1,7}(\.0+)?$' then floor(v_g::numeric)::integer end;
  v_date := coalesce(to_char(q.event_date, 'YYYY-MM-DD'),
                     case when (q.client ->> 'eventDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then q.client ->> 'eventDate' end);
  return jsonb_strip_nulls(jsonb_build_object(
    'kind', 'event', 'v', 1,
    'quote_id', q.id,
    'code', left(q.code, 40),
    'title', left(nullif(btrim(q.title), ''), 200),
    'status', q.status,
    'event_type', left(nullif(btrim(q.event_type), ''), 80),
    'event_date', v_date,
    'event_time', left(nullif(btrim(q.event_time), ''), 40),
    'client', nullif(jsonb_strip_nulls(jsonb_build_object(
                'name',    left(nullif(btrim(q.client ->> 'name'), ''), 120),
                'phone',   left(nullif(btrim(q.client ->> 'phone'), ''), 40),
                'email',   left(nullif(btrim(q.client ->> 'email'), ''), 200),
                'company', left(nullif(btrim(q.client ->> 'company'), ''), 120))), '{}'::jsonb),
    'venue', left(coalesce(nullif(btrim(ep.venue_name), ''), nullif(btrim(q.client ->> 'venue'), '')), 200),
    'venue_address', left(coalesce(nullif(btrim(ep.venue_address), ''), nullif(btrim(q.client ->> 'address'), '')), 400),
    'guests', v_guests,
    'layout', jsonb_build_object('kind', 'layout', 'quote_id', q.id, 'version', q.current_version, 'object_count', v_objs),
    'menu', nullif(jsonb_strip_nulls(jsonb_build_object(
                'package', left(coalesce(nullif(btrim(ep.menu_template), ''), nullif(btrim(ep.package), '')), 120),
                'notes',   left(nullif(btrim(ep.menu), ''), 1000),
                'dishes',  nullif(v_dishes, '[]'::jsonb))), '{}'::jsonb),
    'notes', left(nullif(btrim(q.client ->> 'notes'), ''), 2000),
    'access_notes', left(nullif(btrim(ep.access_notes), ''), 1000),
    'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ));
end $$;
revoke all on function public._event_card(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._event_card(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._event_card(uuid) from authenticated'; end if;
end $$;

-- 4) create (or open) the event group for a confirmed quote --------------------------------
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
  if q.id is null then raise exception 'not authorized' using errcode = '42501'; end if;   -- unknown or another studio's quote
  -- one creator at a time per quote (two people clicking at once get the same group)
  perform pg_advisory_xact_lock(hashtextextended('helm.event_group:' || p_quote::text, 0));
  select c.id into v_id from public.chat_conversations c where c.quote_id = p_quote and c.org_id = v_org;
  if v_id is not null then return v_id; end if;                                         -- already exists → open it
  if q.status is distinct from 'confirmed' then
    raise exception 'Confirm this quote before creating its event group.' using errcode = '22023';
  end if;
  v_name := coalesce(nullif(nullif(btrim(q.title), ''), 'Untitled event'), nullif(btrim(q.client ->> 'name'), ''), 'Event');
  v_title := left(regexp_replace(q.code || ' · ' || v_name, '[[:cntrl:]]', ' ', 'g'), 120);
  insert into public.chat_conversations (org_id, kind, title, created_by, quote_id)
    values (v_org, 'group', v_title, v_me, p_quote)
    on conflict (quote_id) where quote_id is not null do nothing
    returning id into v_id;
  if v_id is null then                                                                   -- lost a race outside the lock
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

-- 5) post an updated event card (only when something changed) ------------------------------
create or replace function public.refresh_event_group(p_conversation uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_quote uuid; v_status text; v_card jsonb; v_last jsonb; v_id uuid;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (select 1 from public.chat_members m where m.conversation_id = p_conversation and m.user_id = v_me) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select c.quote_id into v_quote from public.chat_conversations c where c.id = p_conversation and c.org_id = v_org;
  if v_quote is null then
    raise exception 'This group isn''t linked to an event any more.' using errcode = '22023';
  end if;
  select qq.status into v_status from public.quotes qq where qq.id = v_quote and qq.org_id = v_org;
  if v_status is distinct from 'confirmed' then
    raise exception 'This event is no longer confirmed — its details can''t be refreshed.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm.event_group:' || v_quote::text, 0));
  v_card := public._event_card(v_quote);
  select m.meta into v_last from public.chat_messages m
   where m.conversation_id = p_conversation and m.sender_id is null and m.kind = 'card'
     and m.meta ->> 'kind' = 'event' and not m.deleted
   order by m.created_at desc, m.id desc limit 1;
  if v_last is not null and (v_last - 'generated_at' - 'refreshed') = (v_card - 'generated_at') then
    return null;                                                                         -- nothing changed
  end if;
  insert into public.chat_messages (conversation_id, org_id, sender_id, kind, body, meta)
    values (p_conversation, v_org, null, 'card', 'Event details updated', v_card || jsonb_build_object('refreshed', true))
    returning id into v_id;
  update public.chat_conversations set last_message_at = now() where id = p_conversation;
  return v_id;
end $$;

-- 6) which quotes already have a group (my studio; quotes-view access) ---------------------
create or replace function public.event_group_index()
returns table(quote_id uuid, conversation_id uuid, is_member boolean)
language sql stable security definer set search_path = '' as $$
  select c.quote_id, c.id,
         exists (select 1 from public.chat_members m where m.conversation_id = c.id and m.user_id = auth.uid())
    from public.chat_conversations c
   where auth.uid() is not null
     and c.org_id = public.current_org_id()
     and c.quote_id is not null
     and public.has_area('quotes', 'view');
$$;

-- 7) my unread @mentions (for the bell; shown even when the chat is muted) -----------------
create or replace function public.chat_my_mentions(p_limit integer default 20)
returns table(id uuid, conversation_id uuid, sender_id uuid, kind text, body text, created_at timestamptz,
              conv_kind text, conv_title text, dm_key text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.conversation_id, m.sender_id, m.kind, left(m.body, 300), m.created_at, c.kind, c.title, c.dm_key
    from public.chat_messages m
    join public.chat_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    left join public.chat_members me on me.conversation_id = m.conversation_id and me.user_id = auth.uid()
   where auth.uid() is not null
     and m.org_id = public.current_org_id()
     and (m.meta -> 'mentions') ? (auth.uid())::text
     and not m.deleted
     and m.sender_id is distinct from auth.uid()
     and (me.user_id is not null or c.kind = 'broadcast')
     and m.created_at > coalesce(me.last_read_at, '-infinity'::timestamptz)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- grants: signed-in users only (never anon / public) -----------------------------------------
revoke all on function public.create_event_group(uuid, uuid[]) from public;
revoke all on function public.refresh_event_group(uuid) from public;
revoke all on function public.event_group_index() from public;
revoke all on function public.chat_my_mentions(integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.create_event_group(uuid, uuid[]) from anon';
    execute 'revoke all on function public.refresh_event_group(uuid) from anon';
    execute 'revoke all on function public.event_group_index() from anon';
    execute 'revoke all on function public.chat_my_mentions(integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.create_event_group(uuid, uuid[]) to authenticated';
    execute 'grant execute on function public.refresh_event_group(uuid) to authenticated';
    execute 'grant execute on function public.event_group_index() to authenticated';
    execute 'grant execute on function public.chat_my_mentions(integer) to authenticated';
  end if;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select has_function_privilege('anon','public.create_event_group(uuid,uuid[])','EXECUTE');          -- false
-- select has_function_privilege('authenticated','public.create_event_group(uuid,uuid[])','EXECUTE'); -- true
-- select has_function_privilege('authenticated','public._event_card(uuid)','EXECUTE');               -- false
-- select indexdef from pg_indexes where indexname = 'chat_conv_quote_uq';
