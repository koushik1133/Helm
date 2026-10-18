-- 0194_event_group_people.sql - CANONICAL forward-only. REQUIRES 0016 (chat), 0035 (event groups),
-- 0041 (crew_members.profile_id), 0166 (_is_trial_org).
--
-- In plain words:
--   EVENT GROUP "ADD PEOPLE". An event group (the team chat of a confirmed event) could only hold
--   people who sign in to Helm (chat_members needs a login). The picker therefore listed only signed-in
--   teammates; in a free-trial studio that is usually nobody but the owner, so the staff, vendors and
--   client the owner ticked were never added and the group stayed empty.
--     1) New table chat_group_contacts: the staff (crew_members), vendors and the client of an event
--        group who do not sign in to Helm. It keeps only who they are (kind + their row id + name), not
--        their phone or e-mail. Members of the group can read it (row level security); nobody writes it
--        directly - only the RPCs below.
--     2) event_group_add_people(conversation, people jsonb): adds people to an event group the caller is
--        a member of. Each entry is {kind: user|staff|vendor|client, id}. A teammate (user) or a staff
--        member linked to a login becomes a real chat member; other staff, vendors and the client are
--        added as contacts. Names always come from the studio's own rows (never from the request), only
--        rows of the caller's studio are accepted, at most 200 entries. Nothing is sent to anyone (no
--        WhatsApp / SMS / e-mail) - in a free trial and outside it. Returns the counts.
--     3) event_group_remove_contact(conversation, contact): takes a contact off the group. The row is
--        kept and marked removed (removed_at), never deleted; adding the person again restores it.
--   Changes: 1 new table (+ 2 indexes, RLS, 1 read policy, the studio read-only guard trigger), 2 new functions. No existing table,
--   column, function, policy or row is changed. Additive + idempotent: safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.chat_conversations') is null or to_regclass('public.chat_members') is null
     or to_regprocedure('public.chat_is_member(uuid)') is null or to_regprocedure('public.chat_can_see(uuid)') is null then
    raise exception '0194: apply 0016 (chat) first'; end if;
  if to_regprocedure('public.create_event_group(uuid,uuid[])') is null then
    raise exception '0194: apply 0035 (event groups) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'crew_members' and column_name = 'profile_id') then
    raise exception '0194: apply 0041 (crew_members.profile_id) first'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then
    raise exception '0194: apply 0166 (_is_trial_org) first'; end if;
end $$;

-- ---- 1) the contacts of an event group ------------------------------------------------------------
create table if not exists public.chat_group_contacts (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  org_id          uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  kind            text not null check (kind in ('staff', 'vendor', 'client')),
  ref_id          uuid,
  ref_key         text not null,
  name            text not null check (char_length(name) between 1 and 120),
  added_by        uuid,
  created_at      timestamptz not null default now(),
  removed_at      timestamptz
);
create unique index if not exists chat_group_contacts_person_key
  on public.chat_group_contacts (conversation_id, kind, ref_key);
create index if not exists chat_group_contacts_org_idx on public.chat_group_contacts (org_id);

alter table public.chat_group_contacts enable row level security;
drop policy if exists chat_group_contacts_sel on public.chat_group_contacts;
create policy chat_group_contacts_sel on public.chat_group_contacts for select to authenticated
  using ( org_id = (select public.current_org_id()) and public.chat_can_see(conversation_id) );
revoke all on table public.chat_group_contacts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.chat_group_contacts from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.chat_group_contacts from authenticated';
    execute 'grant select on table public.chat_group_contacts to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table public.chat_group_contacts to service_role'; end if;
end $$;

-- ended-trial / suspended studios are read-only (the same 0045 guard every studio table has, 0136)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    execute 'drop trigger if exists zzz_studio_read_only on public.chat_group_contacts';
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.chat_group_contacts for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- 2) add people to an event group --------------------------------------------------------------
create or replace function public.event_group_add_people(p_conversation uuid, p_people jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0194-event-group-people
declare
  v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
  c record; e jsonb; v_kind text; v_ref uuid; v_name text; v_prof uuid; v_rows integer;
  v_users integer := 0; v_contacts integer := 0; v_skipped integer := 0; v_names text[] := '{}'; v_email text;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select cc.id, cc.kind, cc.quote_id into c
    from public.chat_conversations cc where cc.id = p_conversation and cc.org_id = v_org;
  if c.id is null or not public.chat_is_member(p_conversation) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if c.kind is distinct from 'group' or c.quote_id is null then
    raise exception 'People can be added this way only to an event group.' using errcode = '22023';
  end if;
  if p_people is null or jsonb_typeof(p_people) <> 'array' then
    raise exception 'people must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_people) > 200 then
    raise exception 'Add at most 200 people at a time.' using errcode = '22023';
  end if;

  for e in select x from jsonb_array_elements(p_people) as t(x) loop
    v_kind := case when jsonb_typeof(e) = 'object' then e ->> 'kind' end;
    v_ref := case when jsonb_typeof(e) = 'object'
                   and (e ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e ->> 'id')::uuid end;
    v_name := null; v_prof := null;
    if v_kind = 'user' then
      if v_ref is not null and v_ref <> v_me
         and exists (select 1 from public.profiles p where p.id = v_ref and p.org_id = v_org) then
        insert into public.chat_members (conversation_id, user_id, org_id) values (p_conversation, v_ref, v_org)
          on conflict do nothing;
        get diagnostics v_rows = row_count; v_users := v_users + v_rows; continue;
      end if;
      v_skipped := v_skipped + 1; continue;
    elsif v_kind = 'staff' then
      select cm.name, cm.profile_id into v_name, v_prof from public.crew_members cm
       where cm.id = v_ref and cm.org_id = v_org and cm.active;
      if v_name is null then v_skipped := v_skipped + 1; continue; end if;
      -- a staff member who signs in to Helm joins the chat itself
      if v_prof is not null and v_prof <> v_me
         and exists (select 1 from public.profiles p where p.id = v_prof and p.org_id = v_org) then
        insert into public.chat_members (conversation_id, user_id, org_id) values (p_conversation, v_prof, v_org)
          on conflict do nothing;
        get diagnostics v_rows = row_count; v_users := v_users + v_rows; continue;
      end if;
      if v_prof is not null and v_prof = v_me then v_skipped := v_skipped + 1; continue; end if;
    elsif v_kind = 'vendor' then
      select vv.name into v_name from public.vendors vv where vv.id = v_ref and vv.org_id = v_org and vv.active;
      if v_name is null then v_skipped := v_skipped + 1; continue; end if;
    elsif v_kind = 'client' then
      v_ref := null;
      select coalesce(nullif(btrim(q.client ->> 'name'), ''), 'Client') into v_name
        from public.quotes q where q.id = c.quote_id and q.org_id = v_org;
      if v_name is null then v_skipped := v_skipped + 1; continue; end if;
    else
      v_skipped := v_skipped + 1; continue;
    end if;
    v_name := left(btrim(regexp_replace(v_name, '[[:cntrl:]]', ' ', 'g')), 120);
    if v_name = '' then v_name := initcap(v_kind); end if;
    insert into public.chat_group_contacts (conversation_id, org_id, kind, ref_id, ref_key, name, added_by)
      values (p_conversation, v_org, v_kind, v_ref, coalesce(v_ref::text, v_kind), v_name, v_me)
      on conflict (conversation_id, kind, ref_key) do update
        set name = excluded.name, removed_at = null, added_by = excluded.added_by
        where public.chat_group_contacts.removed_at is not null or public.chat_group_contacts.name is distinct from excluded.name;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_contacts := v_contacts + 1; v_names := array_append(v_names, v_name); end if;
  end loop;

  if v_users + v_contacts > 0 then
    update public.chat_conversations set last_message_at = coalesce(last_message_at, now()) where id = p_conversation;
    select p.email into v_email from public.profiles p where p.id = v_me;
    insert into public.audit_log (actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
      values (v_me, v_email, 'chat.event_group.add_people', 'chat_conversations', p_conversation::text, c.quote_id, v_org,
              jsonb_build_object('users', v_users, 'contacts', v_contacts, 'names', to_jsonb(v_names)));
  end if;
  return jsonb_build_object('users', v_users, 'contacts', v_contacts, 'skipped', v_skipped,
                            'trial', coalesce(public._is_trial_org(v_org), false), 'messages_sent', 0);
end $$;

-- ---- 3) take a contact off an event group (kept, marked removed) ----------------------------------
create or replace function public.event_group_remove_contact(p_conversation uuid, p_contact uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- helm-0194-event-group-people
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_rows integer; v_q uuid; v_email text;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'view')
     or not public.chat_is_member(p_conversation) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.chat_group_contacts g set removed_at = now()
   where g.id = p_contact and g.conversation_id = p_conversation and g.org_id = v_org and g.removed_at is null;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    select cc.quote_id into v_q from public.chat_conversations cc where cc.id = p_conversation;
    select p.email into v_email from public.profiles p where p.id = v_me;
    insert into public.audit_log (actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
      values (v_me, v_email, 'chat.event_group.remove_contact', 'chat_group_contacts', p_contact::text, v_q, v_org, '{}'::jsonb);
  end if;
  return v_rows > 0;
end $$;

revoke all on function public.event_group_add_people(uuid, jsonb) from public;
revoke all on function public.event_group_remove_contact(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.event_group_add_people(uuid, jsonb) from anon';
    execute 'revoke all on function public.event_group_remove_contact(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_group_add_people(uuid, jsonb) to authenticated';
    execute 'grant execute on function public.event_group_remove_contact(uuid, uuid) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_group_add_people(uuid, jsonb) to service_role';
    execute 'grant execute on function public.event_group_remove_contact(uuid, uuid) to service_role'; end if;
end $$;
