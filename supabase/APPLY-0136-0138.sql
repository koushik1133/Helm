-- APPLY 0136 + 0137 + 0138 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
-- Idempotent: safe to run twice. ASCII only. No table or column is created; only 0138 changes rows (demo sample staff phones only); nothing is deleted.
begin;
-- 0136_tenant_guard_catchup.sql - CANONICAL forward-only. REQUIRES 0004 (tg_quote_org_match).
--
-- In plain words:
--   1) Every table that has both quote_id and org_id must carry the 0004 cross-studio guard
--      (trigger zz_quote_org_match): a row can never point at another studio's event. Tables
--      added since (vendor_bills 0124, event_reminders 0129, assign_notify_outbox 0132,
--      integration_webhook_events 0117) did not get it. This re-runs the 0004 install loop,
--      so any such table - now or later - is covered. Only adds triggers; no row is changed.
--   2) Trigger functions are never meant to be called directly. Newer ones (0124, 0132) only
--      revoked EXECUTE from PUBLIC, but Supabase grants anon / authenticated by default.
--      Revoke from all three for every public trigger function. Triggers keep firing (the
--      privilege is not checked when a trigger runs).
-- Idempotent: drop-if-exists + create, revoke is a no-op when already revoked.

do $$ declare r record; begin
  if to_regprocedure('public.tg_quote_org_match()') is null then return; end if;
  for r in
    select c.table_name from information_schema.columns c
      join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
      join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id'
      and c.table_name not in ('quotes','audit_log','lead_archive')
      and not exists (select 1 from pg_trigger tg join pg_class k on k.oid=tg.tgrelid
                      where k.relnamespace='public'::regnamespace and k.relname=c.table_name
                        and tg.tgname='zz_quote_org_match')
    order by 1
  loop
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', r.table_name);
  end loop;
end $$;

do $$ declare r record; begin
  for r in
    select p.oid::regprocedure as fn from pg_proc p
    where p.pronamespace='public'::regnamespace and p.prorettype='trigger'::regtype
  loop
    execute format('revoke execute on function %s from public', r.fn);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke execute on function %s from anon', r.fn); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke execute on function %s from authenticated', r.fn); end if;
  end loop;
end $$;

--   3) Every studio table (has org_id) carries the 0045 read-only guard zzz_studio_read_only,
--      so a suspended studio / ended trial cannot write through it. The tables added in
--      0116-0132 (user_dashboard_prefs, org_payment_accounts, org_whatsapp_accounts,
--      whatsapp_opt_outs, integration_webhook_events, trial_reminders, event_reminders,
--      invite_email_outbox, assign_notify_outbox) did not get it. The guard lets the service
--      role / cron through unchanged, so webhooks, ticks and mailers keep working; the
--      0116 trial exception for user_dashboard_prefs already lives inside the guard.
--      Only missing triggers are created; existing ones are left as they are.
do $$ declare t text; begin
  if to_regprocedure('public.tg_studio_read_only()') is null then return; end if;
  foreach t in array array['user_dashboard_prefs','org_payment_accounts','org_whatsapp_accounts','whatsapp_opt_outs',
                           'integration_webhook_events','trial_reminders','event_reminders','invite_email_outbox',
                           'assign_notify_outbox'] loop
    if to_regclass('public.' || t) is not null
       and exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || t) and a.attname = 'org_id' and not a.attisdropped)
       and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
end $$;

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

-- 0138_demo_staff_phones.sql - CANONICAL forward-only. REQUIRES 0122 (trial demo seed, crew_members.is_demo).
--
-- In plain words:
--   The trial demo seed gives the three sample staff placeholder phones "+91 00000 001xx".
--   Those are not valid Indian mobile numbers, so a fresh trial's Staff page showed a red
--   "Invalid phone - please fix" on every demo row. This rewrites ONLY demo sample rows
--   (is_demo = true, not linked to an account, phone starting "+91 00000") to the
--   valid-looking dummy "+91 90000 001xx" (same last digits). Real staff rows are never
--   touched. No table, column or row is created or deleted.
--   (The app also hides the warning for demo rows, so trials seeded later look right too.)
-- Idempotent: a second run matches no rows (the new numbers no longer start "+91 00000").

update public.crew_members
   set phone = '+91 9' || substr(phone, 6)
 where is_demo is true
   and profile_id is null
   and phone like '+91 00000 %'
   and length(phone) = 15;

commit;

-- VERIFY 0136 + 0137 + 0138 (read-only; expect every ok = true)
select '0136 zz_quote_org_match on every quote_id+org_id table' as item,
       coalesce(bool_and(exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.' || c.table_name) and tg.tgname = 'zz_quote_org_match')), true) as ok
  from information_schema.columns c
  join information_schema.columns o on o.table_schema = c.table_schema and o.table_name = c.table_name and o.column_name = 'org_id'
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
 where c.table_schema = 'public' and c.column_name = 'quote_id' and c.table_name not in ('quotes','audit_log','lead_archive')
union all
select '0136 trigger functions not executable by anon/authenticated',
       not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
                     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')))
union all
select '0136 zzz_studio_read_only on ' || t,
       to_regclass('public.' || t) is null
       or not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || t) and a.attname = 'org_id' and not a.attisdropped)
       or to_regprocedure('public.tg_studio_read_only()') is null
       or exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zzz_studio_read_only')
  from unnest(array['user_dashboard_prefs','org_payment_accounts','org_whatsapp_accounts','whatsapp_opt_outs',
                    'integration_webhook_events','trial_reminders','event_reminders','invite_email_outbox','assign_notify_outbox']) as t
union all
select '0137 create_event_group uses chr(183) (no mis-encoded dot)',
       coalesce((select position('chr(183)' in p.prosrc) > 0 and position(chr(172) || chr(8721) in p.prosrc) = 0
                   from pg_proc p where p.oid = to_regprocedure('public.create_event_group(uuid, uuid[])')), false)
union all
select '0137 create_event_group is security definer with empty search_path',
       coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
                   from pg_proc p where p.oid = to_regprocedure('public.create_event_group(uuid, uuid[])')), false)
union all
select '0137 create_event_group: authenticated yes, anon no',
       coalesce(has_function_privilege('authenticated', to_regprocedure('public.create_event_group(uuid, uuid[])'), 'EXECUTE')
                and not has_function_privilege('anon', to_regprocedure('public.create_event_group(uuid, uuid[])'), 'EXECUTE'), false)
union all
select '0138 no demo staff row left on a +91 00000 placeholder phone',
       not exists (select 1 from public.crew_members c where c.is_demo is true and c.profile_id is null and c.phone like '+91 00000 %');
