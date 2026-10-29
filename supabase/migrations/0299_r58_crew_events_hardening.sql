-- 0299_r58_crew_events_hardening.sql - CANONICAL forward-only.
-- REQUIRES 0012 (worker_respond), 0035 / 0137 / 0156 / 0194 (event groups: _event_card, create_event_group,
--          chat_add_members, event_group_add_people), 0088 (custom_field_defs), 0132 (worker_assignment_updates,
--          _assign132_phone), 0153 (_a153_my_crew_ids), 0202 / 0287 (queue_nurture_greeting__pre0202), 0260
--          (_work_token_live), 0265 (crew_link_home), 0266 (inbox_feed, bell_feed, _r23_area), r24 run-sheet owner ids.
--
-- In plain words (R58, audit 2026-10-28 groups D-events-ops + B-shell):
--   D-01 Pay on a staff row LINKED to a team login (day rate + pay-like custom fields such as "salary") was hidden only
--        by the browser: every Staff viewer could read it straight from the table and Staff editors could change it.
--        Now the database itself keeps it to the studio admin (the owner rule from r20): the day_rate / attributes
--        columns are no longer readable from the table by signed-in users; the Staff page reads them through
--        staff_pay_fields(), which answers the pay of a linked row to the admin only (plain crew rows as before).
--        A trigger refuses a non-admin change of a linked row's pay, and puts back any pay field a non-admin save left
--        out (it was hidden from them) - never lost.
--   D-02 The raw crew-link token (work_tokens.token) was readable by every Staff viewer, so a view-only user could
--        open anyone's crew link and act as them. The column is no longer readable from the table; the Operations
--        page gets the links from work_links_for_event(), which answers them to Staff EDITORS only.
--   D-03 The crew link (worker_respond) could reject / re-accept a task that was already completed (even QC-passed).
--        Now it follows the same rules as the signed-in twin crew_task_respond: a completed / cancelled task is closed,
--        accept / reject only before the task has started.
--   D-04 Birthday / anniversary greetings filled {{studio}} with the hard-coded "Blueprint Stage". Now it is the
--        studio's own name (organizations.name of the contact's studio). It was the only user-facing place.
--   D-05 The crew link's open-shift board: the internal event code is no longer sent, the wage is shown only on a
--        shift the person has applied for / is on, and shifts on a day they marked themselves unavailable are left
--        out (unless they already claimed it).
--   D-06 Run-sheet items were matched to a crew link by the owner's NAME alone (two people with the same name saw
--        each other's items). Now by the person: the item's crew / vendor / team owner id and that person's phone;
--        old rows without an owner id still match only a staff record with that name AND the link's phone.
--   D-07 The crew role could read every event's run-sheet (with notes). Now a crew login reads run-sheet rows only
--        for events they have a task on (same rule as crew_event_brief). Other roles unchanged.
--   D-09 Inventory unit cost: readable from the table by every Inventory viewer. Now only through inventory_costs(),
--        for roles with Budget & finance view or Inventory edit (admin always).
--   BS-01 The event-group card carried the client's phone and e-mail to every group member. New / refreshed cards no
--        longer carry them; chat shows them through event_group_contact() only to people with Quotes view. Existing
--        cards are copied once to a private backup table (nothing lost) and the copy in chat drops phone / e-mail.
--        Adding someone to an EVENT group now follows the access matrix: they need Quotes view, or a task on that event.
--   BS-03 Inbox / bell rows carried the event code and title even for roles without Quotes view. Those two fields are
--        now left out for such roles.
--   D-08 (quote approval token for quotes-view roles) is left as the owner accepted it.
-- ZERO DATA LOSS: no table, column or row is deleted. Functions are re-issued with the previous body kept once as
--   <name>__pre0299 (no app privilege). Column privileges change (read access only). One new private table
--   (chat_card_contact_backup_r58) holds the original event-card text before phone / e-mail are taken out of chat.
--   Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): rename each <name>__pre0299 back over <name> and re-grant as before;
--   grant select on public.crew_members, public.work_tokens, public.inventory_items to authenticated;
--   drop policy "r58 crew own events" on public.run_sheet_items; drop trigger ab_r58_crew_pay_guard on crew_members;
--   the original card meta is in chat_card_contact_backup_r58.original_meta.

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['public.crew_members', 'public.work_tokens', 'public.inventory_items', 'public.run_sheet_items',
                            'public.event_tasks', 'public.chat_conversations', 'public.chat_members', 'public.chat_messages',
                            'public.custom_field_defs', 'public.organizations', 'public.nurture', 'public.profiles',
                            'public.quotes', 'public.vendors', 'public.role_access'] loop
    if to_regclass(v) is null then raise exception 'STOP 0299: % missing', v; end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'run_sheet_items'
                  and column_name in ('owner_crew_id', 'owner_vendor_id', 'owner_user_id') group by table_name having count(*) = 3) then
    raise exception 'STOP 0299: run_sheet_items owner ids (r24) missing'; end if;
  foreach v in array array['public.has_area(text,text)', 'public.user_role()', 'public.current_org_id()',
                            'public._r23_area(uuid,text,text,text)', 'public._a153_my_crew_ids()', 'public._work_token_live(uuid)',
                            'public._assign132_phone(text)', 'public.chat_is_member(uuid)', 'public._next_occasion(date)',
                            'public.studio_today(uuid,timestamp with time zone)', 'public._notify(uuid,text,text,text,jsonb)'] loop
    if to_regprocedure(v) is null then raise exception 'STOP 0299: % missing', v; end if;
  end loop;
  foreach v in array array['worker_respond(uuid,uuid,text)', 'queue_nurture_greeting__pre0202(uuid)', 'crew_link_home(uuid)',
                            'worker_assignment_updates(uuid)', '_event_card(uuid)', 'create_event_group(uuid,uuid[])',
                            'chat_add_members(uuid,uuid[])', 'event_group_add_people(uuid,jsonb)',
                            'inbox_feed(text,text,uuid,integer,text)', 'bell_feed(integer)'] loop
    if to_regprocedure('public.' || v) is null
       and to_regprocedure('public.' || replace(split_part(v, '(', 1), '__pre0202', '') || '__pre0299(' || split_part(v, '(', 2)) is null then
      raise exception 'STOP 0299: public.% missing', v; end if;
  end loop;
end $$;

-- ---- 2) keep each previous body once (rename-once; a re-run leaves the kept copy alone) ---------------------
do $$
declare r record; v_src text; v_keep text;
begin
  for r in select * from (values
      ('worker_respond',                 'uuid,uuid,text',                 'worker_respond__pre0299',            'r58-worker-respond-0299'),
      ('queue_nurture_greeting__pre0202','uuid',                           'queue_nurture_greeting__pre0299',    'r58-greeting-studio-0299'),
      ('crew_link_home',                 'uuid',                           'crew_link_home__pre0299',            'r58-crew-home-0299'),
      ('worker_assignment_updates',      'uuid',                           'worker_assignment_updates__pre0299', 'r58-assign-person-0299'),
      ('_event_card',                    'uuid',                           '_event_card__pre0299',               'r58-event-card-0299'),
      ('create_event_group',             'uuid,uuid[]',                    'create_event_group__pre0299',        'r58-event-group-members-0299'),
      ('chat_add_members',               'uuid,uuid[]',                    'chat_add_members__pre0299',          'r58-event-group-members-0299'),
      ('event_group_add_people',         'uuid,jsonb',                     'event_group_add_people__pre0299',    'r58-event-group-members-0299'),
      ('inbox_feed',                     'text,text,uuid,integer,text',    'inbox_feed__pre0299',                'r58-inbox-names-0299'),
      ('bell_feed',                      'integer',                        'bell_feed__pre0299',                 'r58-inbox-names-0299')
    ) t(fn, args, keep, marker) loop
    v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || r.fn || '(' || r.args || ')'));
    if to_regprocedure('public.' || r.keep || '(' || r.args || ')') is null and v_src is not null
       and position(r.marker in v_src) = 0 then
      execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.keep);
    end if;
    v_keep := 'public.' || r.keep || '(' || r.args || ')';
    if to_regprocedure(v_keep) is not null then
      execute format('revoke all on function %s from public', v_keep);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_keep); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_keep); end if;
    end if;
  end loop;
end $$;

-- ---- 3) helpers -----------------------------------------------------------------------------------------------
-- a pay-like custom field (same words as the Staff page's staffPayAttr: key, or the studio's label for that key)
create or replace function public._r58_pay_key(p_org uuid, p_key text)
returns boolean language sql stable set search_path = '' as $$
  -- r58-crew-pay-0299
  select coalesce(p_key, '') ~* '(salary|wage|ctc|stipend|remuneration|compensation|payout|day_?rate|daily_?rate|per_?day|(^|[^a-z])pay([^a-z]|$))'
      or exists (select 1 from public.custom_field_defs d
                  where d.org_id = p_org and d.entity = 'staff' and d.key = p_key
                    and coalesce(d.label, '') ~* '(salary|wage|ctc|stipend|remuneration|compensation|payout|day_?rate|daily_?rate|per_?day|(^|[^a-z])pay([^a-z]|$))');
$$;

-- may this person be in this event's group? Quotes view (access matrix) or a live task on that event
create or replace function public._r58_may_join_event(p_org uuid, p_quote uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r58-event-group-members-0299
  select exists (
    select 1 from public.profiles p
     where p.id = p_user and p.org_id = p_org and coalesce(p.role, '') <> 'client'
       and (public._r23_area(p_org, p.role, 'quotes', 'view')
            or exists (select 1 from public.crew_members cm join public.event_tasks t on t.crew_id = cm.id
                        where cm.org_id = p_org and t.org_id = p_org and t.quote_id = p_quote
                          and coalesce(t.status, '') not in ('rejected', 'cancelled')
                          and (cm.profile_id = p_user
                               or (nullif(btrim(coalesce(cm.email, '')), '') is not null and lower(btrim(cm.email)) = lower(btrim(coalesce(p.email, '')))))))
  );
$$;

-- crew logins: the events they have a task on (crew_event_brief's rule)
create or replace function public._r58_is_crew_role()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r58-crew-runsheet-0299
  select coalesce(public.user_role(), '') in ('crew', 'worker');
$$;
create or replace function public._r58_crew_event_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  -- r58-crew-runsheet-0299
  select distinct t.quote_id from public.event_tasks t
   where t.org_id = public.current_org_id() and t.crew_id in (select public._a153_my_crew_ids());
$$;

-- inbox / bell rows without the event code / title
create or replace function public._r58_strip_event_names(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- r58-inbox-names-0299
  select case when p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'items') is distinct from 'array' then p
    else jsonb_set(p, '{items}', coalesce((select jsonb_agg(case when jsonb_typeof(x.e) = 'object' then x.e - 'event_code' - 'event_title' else x.e end order by x.o)
                                             from jsonb_array_elements(p -> 'items') with ordinality x(e, o)), '[]'::jsonb)) end;
$$;

-- ---- 4) D-01 staff pay ----------------------------------------------------------------------------------------
create or replace function public._r58_tg_crew_pay_guard()
returns trigger language plpgsql set search_path = '' as $$
-- r58-crew-pay-0299: pay on a staff row linked to a team login is the studio admin's only
declare k text; v_old jsonb; v_new jsonb;
begin
  if current_user not in ('anon', 'authenticated')
     and coalesce(current_setting('helm.a156_api_guard', true), '') <> 'on' then return new; end if;   -- definer RPCs / owner scripts
  if tg_op <> 'UPDATE' or old.profile_id is null or coalesce(public.user_role(), '') = 'admin' then return new; end if;
  if new.day_rate is distinct from old.day_rate then
    raise exception 'Only a studio admin can change the pay of a team member who signs in to Helm.' using errcode = '42501';
  end if;
  v_old := old.attributes; v_new := new.attributes;
  if v_new is distinct from v_old and jsonb_typeof(v_old) = 'object' and jsonb_typeof(v_new) = 'object' then
    for k in select e.key from jsonb_each(v_old) e loop
      if public._r58_pay_key(old.org_id, k) then
        if not (v_new ? k) then
          v_new := v_new || jsonb_build_object(k, v_old -> k);          -- hidden from this person: put back, never lost
        elsif (v_new -> k) is distinct from (v_old -> k) then
          raise exception 'Only a studio admin can change the pay of a team member who signs in to Helm.' using errcode = '42501';
        end if;
      end if;
    end loop;
    for k in select e.key from jsonb_each(v_new) e loop
      if not (v_old ? k) and public._r58_pay_key(old.org_id, k) then
        raise exception 'Only a studio admin can add pay details for a team member who signs in to Helm.' using errcode = '42501';
      end if;
    end loop;
    new.attributes := v_new;
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.crew_members'::regclass and tgname = 'ab_r58_crew_pay_guard') then
    create trigger ab_r58_crew_pay_guard before update on public.crew_members
      for each row execute function public._r58_tg_crew_pay_guard();
  end if;
end $$;

-- the pay of the staff rows the caller may see (Staff view): linked rows -> admin only; plain crew -> as before
create or replace function public.staff_pay_fields(p_ids uuid[])
returns table(id uuid, day_rate numeric, attributes jsonb, pay_hidden boolean)
language plpgsql stable security definer set search_path = '' as $$
-- r58-crew-pay-0299
#variable_conflict use_column
declare v_org uuid := public.current_org_id(); v_admin boolean;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if cardinality(p_ids) > 5000 then raise exception 'at most 5000 staff records at a time' using errcode = '22023'; end if;
  v_admin := coalesce(public.user_role(), '') = 'admin';
  return query
    select c.id,
           case when c.profile_id is null or v_admin then c.day_rate end,
           case when c.profile_id is null or v_admin or jsonb_typeof(c.attributes) is distinct from 'object' then c.attributes
                else coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(c.attributes) e
                                where not public._r58_pay_key(c.org_id, e.key)), '{}'::jsonb) end,
           (c.profile_id is not null and not v_admin)
      from public.crew_members c
     where c.org_id = v_org and c.id = any (p_ids);
end $$;

-- ---- 5) D-02 crew-link tokens: Staff editors only -------------------------------------------------------------
create or replace function public.work_links_for_event(p_quote uuid)
returns table(phone text, name text, token uuid)
language plpgsql stable security definer set search_path = '' as $$
-- r58-work-links-0299: the raw link is a key to that person's tasks - Staff EDIT only (view roles get no rows)
#variable_conflict use_column
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('staff', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not coalesce(public.has_area('staff', 'edit'), false) then return; end if;
  return query select w.phone, w.name, w.token from public.work_tokens w where w.quote_id = p_quote and w.org_id = v_org;
end $$;

-- ---- 6) D-09 inventory unit cost: Budget & finance view or Inventory edit -------------------------------------
create or replace function public.inventory_costs(p_ids uuid[])
returns table(id uuid, unit_cost numeric)
language plpgsql stable security definer set search_path = '' as $$
-- r58-inventory-cost-0299
#variable_conflict use_column
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (coalesce(public.has_area('finance', 'view'), false) or coalesce(public.has_area('inventory', 'edit'), false)) then return; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if cardinality(p_ids) > 5000 then raise exception 'at most 5000 items at a time' using errcode = '22023'; end if;
  return query select i.id, i.unit_cost from public.inventory_items i where i.org_id = v_org and i.id = any (p_ids);
end $$;

-- ---- 7) column privileges: the protected columns are no longer readable from the table by API roles ---------
do $$
declare r record; v_cols text; v_hide text;
begin
  for r in select * from (values ('crew_members', array['day_rate', 'attributes']),
                                 ('work_tokens', array['token']),
                                 ('inventory_items', array['unit_cost'])) t(tbl, hide) loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
      from pg_attribute a where a.attrelid = ('public.' || r.tbl)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> all (r.hide);
    select string_agg(quote_ident(h), ', ') into v_hide from unnest(r.hide) h;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke select on public.%I from anon', r.tbl);
      execute format('revoke select (%s) on public.%I from anon', v_hide, r.tbl);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke select on public.%I from authenticated', r.tbl);
      execute format('revoke select (%s) on public.%I from authenticated', v_hide, r.tbl);
      execute format('grant select (%s) on public.%I to authenticated', v_cols, r.tbl);
    end if;
  end loop;
end $$;

-- ---- 8) D-03 worker_respond: the crew_task_respond rules -----------------------------------------------------
create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r58-worker-respond-0299: 0012 body + the same state rules as crew_task_respond (closed / already started)
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  w := public._work_token_live(p_token);
  select * into tsk from public.event_tasks where id = p_task_id and quote_id = w.quote_id and assignee_phone = w.phone for update;
  if tsk.id is null then raise exception 'task not found'; end if;
  newst := case p_action
    when 'accept'   then 'accepted'
    when 'reject'   then 'rejected'
    when 'start'    then 'in_progress'
    when 'complete' then 'completed'
    else null end;
  if newst is null then raise exception 'invalid action'; end if;
  if tsk.status in ('completed', 'cancelled') then raise exception 'this task is already closed' using errcode = '22023'; end if;
  if p_action in ('accept', 'reject') and tsk.status not in ('assigned', 'accepted', 'rejected') then
    raise exception 'this task has already started' using errcode = '22023'; end if;
  if p_action = 'start'    and tsk.status not in ('accepted', 'assigned') then raise exception 'accept the task first'; end if;
  if p_action = 'complete' and tsk.status not in ('in_progress', 'accepted') then raise exception 'start the task first'; end if;
  update public.event_tasks set status = newst,
    responded_at = case when p_action in ('accept', 'reject') then now() else responded_at end,
    started_at   = case when p_action = 'start'    then now() else started_at end,
    completed_at = case when p_action = 'complete' then now() else completed_at end
    where id = p_task_id;
  perform public._notify(w.quote_id, 'sms', null, 'task_' || p_action, jsonb_build_object('task', tsk.title, 'worker', w.name));
  return jsonb_build_object('ok', true, 'status', newst);
end $$;

-- ---- 9) D-04 greeting e-mails: {{studio}} = the studio's own name ---------------------------------------------
create or replace function public.queue_nurture_greeting__pre0202(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
-- r58-greeting-studio-0299: 0287 body; {{studio}} is the contact's studio name (was the hard-coded demo name)
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text;
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'contact not found'; end if;
  select coalesce(nullif(btrim(o.name), ''), 'our team') into v_studio from public.organizations o where o.id = n.org_id;
  v_studio := coalesce(v_studio, 'our team');

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot and org_id = public.current_org_id();
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom' and org_id = public.current_org_id(); end if;

  v_years := coalesce(extract(year from public._next_occasion(n.occasion_date))::int
                      - extract(year from n.occasion_date)::int, 0);
  select q.title into v_last from public.quotes q where q.id = n.quote_id;
  v_last := coalesce(v_last, 'your event with us');
  select array_agg(url order by seq, created_at) into v_photos
    from (select url, seq, created_at from public.event_media
          where quote_id = n.quote_id and in_gallery = true order by seq, created_at limit 3) m;

  v_subject := replace(replace(replace(replace(replace(coalesce(tpl.subject,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);
  v_body := replace(replace(replace(replace(replace(coalesce(tpl.body,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);

  v_detail := jsonb_build_object(
    'subject', v_subject, 'body', v_body,
    'photos', to_jsonb(coalesce(v_photos, array[]::text[])),
    'occasion_type', ot, 'contact', n.name, 'auto', n.auto_on);

  perform public._notify(n.quote_id, 'email', n.email, 'nurture_'||ot, v_detail);
  update public.nurture set last_greeted = public.studio_today(public.current_org_id()) where id = p_id and org_id = public.current_org_id();
  return v_detail;
end; $$;

-- ---- 10) D-05 crew link open shifts: no event code, own wages only, not on days marked unavailable ------------
create or replace function public.crew_link_home(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r58-crew-home-0299: the 0265 answer, open shifts trimmed to what this person needs
declare v jsonb;
begin
  v := public.crew_link_home__pre0299(p_token);
  if v is null or jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'shifts') is distinct from 'array' then return v; end if;
  return jsonb_set(v, '{shifts}', coalesce((
    select jsonb_agg(case when x.s ->> 'my_status' in ('pending', 'approved') then x.s - 'event_code'
                          else (x.s - 'event_code') || jsonb_build_object('wage', null, 'basis', null) end order by x.o)
      from jsonb_array_elements(v -> 'shifts') with ordinality x(s, o)
     where jsonb_typeof(x.s) = 'object'
       and ((x.s ->> 'my_status') is not null or not coalesce((x.s ->> 'unavailable')::boolean, false))), '[]'::jsonb));
end $$;

-- ---- 11) D-06 run-sheet items for a crew link: by the person, never by a bare name -----------------------------
create or replace function public.worker_assignment_updates(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- helm-0132-assign-notify + r58-assign-person-0299: token-scoped (same liveness gate as worker_get_tasks); an item is
-- this link's when its owner id (staff / vendor / team login) is the person with the link's phone; old rows without
-- an owner id only when a staff record has that name AND the link's phone
declare w public.work_tokens; v_phone text; rs jsonb; tk jsonb;
begin
  w := public._work_token_live(p_token);
  v_phone := public._assign132_phone(w.phone);
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'start_time', to_char(i.start_time, 'HH24:MI'),
           'duration_min', i.duration_min, 'location', i.location, 'note', i.note, 'changed_at', i.assign_changed_at)
           order by i.start_time nulls last, i.seq), '[]'::jsonb) into rs
    from public.run_sheet_items i
   where i.quote_id = w.quote_id and v_phone is not null
     and ((i.owner_crew_id is not null
            and exists (select 1 from public.crew_members cm
                         where cm.id = i.owner_crew_id and cm.org_id = w.org_id and public._assign132_phone(cm.phone) = v_phone))
       or (i.owner_vendor_id is not null
            and exists (select 1 from public.vendors vv
                         where vv.id = i.owner_vendor_id and vv.org_id = w.org_id and public._assign132_phone(vv.phone) = v_phone))
       or (i.owner_user_id is not null
            and exists (select 1 from public.crew_members cm
                         where cm.profile_id = i.owner_user_id and cm.org_id = w.org_id and public._assign132_phone(cm.phone) = v_phone))
       or (i.owner_crew_id is null and i.owner_vendor_id is null and i.owner_user_id is null
            and nullif(btrim(coalesce(i.owner, '')), '') is not null
            and exists (select 1 from public.crew_members cm
                         where cm.org_id = w.org_id and cm.active and lower(btrim(cm.name)) = lower(btrim(i.owner))
                           and public._assign132_phone(cm.phone) = v_phone)));
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'changed_at', t.assign_changed_at)), '[]'::jsonb) into tk
    from public.event_tasks t
   where t.quote_id = w.quote_id and t.assignee_phone = w.phone and t.assign_changed_at is not null;
  return jsonb_build_object('runsheet', rs, 'tasks', tk);
end $$;

-- ---- 12) D-07 crew logins read run-sheet rows only for their own events ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_policy where polrelid = 'public.run_sheet_items'::regclass and polname = 'r58 crew own events') then
    create policy "r58 crew own events" on public.run_sheet_items as restrictive for select to authenticated
      using (not (select public._r58_is_crew_role()) or quote_id in (select public._r58_crew_event_ids()));
  end if;
end $$;

-- ---- 13) BS-01 event-group card without the client's phone / e-mail; members follow the access matrix ----------
create or replace function public._event_card(p_quote uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
-- r58-event-card-0299: the 0035 card without client phone / e-mail (shown to Quotes viewers via event_group_contact)
declare v jsonb; c jsonb;
begin
  v := public._event_card__pre0299(p_quote);
  if v is null or jsonb_typeof(v -> 'client') is distinct from 'object' then return v; end if;
  c := (v -> 'client') - 'phone' - 'email';
  return case when c = '{}'::jsonb then v - 'client' else jsonb_set(v, '{client}', c) end;
end $$;

create or replace function public.event_group_contact(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r58-event-card-0299: the client's phone / e-mail for an event card - Quotes view only (else null)
declare v_org uuid := public.current_org_id(); v jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then return null; end if;
  select jsonb_strip_nulls(jsonb_build_object('phone', left(nullif(btrim(q.client ->> 'phone'), ''), 40),
                                              'email', left(nullif(btrim(q.client ->> 'email'), ''), 200)))
    into v from public.quotes q where q.id = p_quote and q.org_id = v_org;
  return v;
end $$;

create or replace function public.create_event_group(p_quote uuid, p_members uuid[] default null)
returns uuid language plpgsql security definer set search_path = '' as $$
-- r58-event-group-members-0299: members who may not open this event (access matrix) are left out
declare v_org uuid := public.current_org_id(); v_keep uuid[];
begin
  if p_members is not null and v_org is not null then
    select array_agg(x.u order by x.o) into v_keep from unnest(p_members) with ordinality x(u, o)
     where x.u is not null and public._r58_may_join_event(v_org, p_quote, x.u);
  end if;
  return public.create_event_group__pre0299(p_quote, case when p_members is null then null else coalesce(v_keep, '{}'::uuid[]) end);
end $$;

create or replace function public.chat_add_members(p_conversation uuid, p_members uuid[])
returns void language plpgsql security definer set search_path = '' as $$
-- r58-event-group-members-0299: an EVENT group takes only people who may open that event (access matrix)
declare v_org uuid := public.current_org_id(); v_quote uuid; v_bad integer := 0;
begin
  select c.quote_id into v_quote from public.chat_conversations c where c.id = p_conversation and c.org_id = v_org;
  if v_quote is not null and p_members is not null and coalesce(public.user_role(), '') <> 'client'
     and public.chat_is_member(p_conversation) then
    select count(*) into v_bad from unnest(p_members) u
     where u is not null
       and exists (select 1 from public.profiles p where p.id = u and p.org_id = v_org)
       and not exists (select 1 from public.chat_members m where m.conversation_id = p_conversation and m.user_id = u)
       and not public._r58_may_join_event(v_org, v_quote, u);
    if v_bad > 0 then
      raise exception 'Some of the people you picked can''t join this event group: their role can''t open this event (Settings -> Users & access).'
        using errcode = '42501';
    end if;
  end if;
  perform public.chat_add_members__pre0299(p_conversation, p_members);
end $$;

create or replace function public.event_group_add_people(p_conversation uuid, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r58-event-group-members-0299: team logins who may not open this event (access matrix) are not added (not_allowed)
declare v_org uuid := public.current_org_id(); v_quote uuid; e jsonb; v_kind text; v_ref uuid; v_prof uuid;
        v_list jsonb := '[]'::jsonb; v_not integer := 0; r jsonb;
begin
  select c.quote_id into v_quote from public.chat_conversations c where c.id = p_conversation and c.org_id = v_org;
  if v_quote is null or p_people is null or jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 200
     or auth.uid() is null or not coalesce(public.has_area('quotes', 'view'), false) or not public.chat_is_member(p_conversation) then
    return public.event_group_add_people__pre0299(p_conversation, p_people);       -- its own checks / messages
  end if;
  for e in select x from jsonb_array_elements(p_people) as t(x) loop
    v_kind := case when jsonb_typeof(e) = 'object' then e ->> 'kind' end;
    v_ref := case when jsonb_typeof(e) = 'object'
                   and (e ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (e ->> 'id')::uuid end;
    v_prof := null;
    if v_kind = 'user' and v_ref is not null then v_prof := v_ref;
    elsif v_kind = 'staff' and v_ref is not null then
      select cm.profile_id into v_prof from public.crew_members cm where cm.id = v_ref and cm.org_id = v_org and cm.active;
    end if;
    if v_prof is not null and v_prof <> auth.uid()
       and exists (select 1 from public.profiles p where p.id = v_prof and p.org_id = v_org)
       and not exists (select 1 from public.chat_members m where m.conversation_id = p_conversation and m.user_id = v_prof)
       and not public._r58_may_join_event(v_org, v_quote, v_prof) then
      v_not := v_not + 1; continue;
    end if;
    v_list := v_list || jsonb_build_array(e);
  end loop;
  r := public.event_group_add_people__pre0299(p_conversation, v_list);
  if v_not > 0 and jsonb_typeof(r) = 'object' then
    r := r || jsonb_build_object('not_allowed', v_not, 'skipped', coalesce((r ->> 'skipped')::integer, 0) + v_not);
  end if;
  return r;
end $$;

-- existing event cards: keep the original once (private), then take phone / e-mail out of the chat copy
-- (no org_id column: the row lives and goes with its chat message - a studio purge of the message removes it too)
create table if not exists public.chat_card_contact_backup_r58 (
  message_id      uuid primary key references public.chat_messages(id) on delete cascade,
  conversation_id uuid,
  original_meta   jsonb not null,
  saved_at        timestamptz not null default now()
);
alter table public.chat_card_contact_backup_r58 enable row level security;
do $$ begin
  revoke all on public.chat_card_contact_backup_r58 from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.chat_card_contact_backup_r58 from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.chat_card_contact_backup_r58 from authenticated; end if;
end $$;
insert into public.chat_card_contact_backup_r58 (message_id, conversation_id, original_meta)
  select m.id, m.conversation_id, m.meta from public.chat_messages m
   where m.sender_id is null and m.kind = 'card' and jsonb_typeof(m.meta) = 'object' and m.meta ->> 'kind' = 'event'
     and jsonb_typeof(m.meta -> 'client') = 'object' and ((m.meta -> 'client') ? 'phone' or (m.meta -> 'client') ? 'email')
  on conflict (message_id) do nothing;
update public.chat_messages m
   set meta = case when ((m.meta -> 'client') - 'phone' - 'email') = '{}'::jsonb then m.meta - 'client'
                   else jsonb_set(m.meta, '{client}', (m.meta -> 'client') - 'phone' - 'email') end
 where m.sender_id is null and m.kind = 'card' and jsonb_typeof(m.meta) = 'object' and m.meta ->> 'kind' = 'event'
   and jsonb_typeof(m.meta -> 'client') = 'object' and ((m.meta -> 'client') ? 'phone' or (m.meta -> 'client') ? 'email')
   and exists (select 1 from public.chat_card_contact_backup_r58 b where b.message_id = m.id);

-- ---- 14) BS-03 inbox / bell: no event code / title without Quotes view ----------------------------------------
create or replace function public.inbox_feed(p_tab text default 'unread', p_filter text default null, p_quote uuid default null,
                                             p_limit integer default 50, p_cursor text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r58-inbox-names-0299: the 0266 page; event code / title only for people with Quotes view
declare v jsonb;
begin
  v := public.inbox_feed__pre0299(p_tab, p_filter, p_quote, p_limit, p_cursor);
  if coalesce(public.has_area('quotes', 'view'), false) then return v; end if;
  return public._r58_strip_event_names(v);
end $$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r58-inbox-names-0299: the 0266 bell; event code / title only for people with Quotes view
declare v jsonb;
begin
  v := public.bell_feed__pre0299(p_limit);
  if coalesce(public.has_area('quotes', 'view'), false) then return v; end if;
  return public._r58_strip_event_names(v);
end $$;

-- ---- 15) grants (the re-issued functions keep their previous callers; new ones as named) -----------------------
do $$
declare r record; v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
        v_has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  for r in select * from (values
      ('public.worker_respond(uuid,uuid,text)',                  true,  true),
      ('public.crew_link_home(uuid)',                            true,  true),
      ('public.worker_assignment_updates(uuid)',                 true,  true),
      ('public.queue_nurture_greeting__pre0202(uuid)',           false, false),
      ('public._event_card(uuid)',                               false, false),
      ('public.create_event_group(uuid,uuid[])',                 false, true),
      ('public.chat_add_members(uuid,uuid[])',                   false, true),
      ('public.event_group_add_people(uuid,jsonb)',              false, true),
      ('public.inbox_feed(text,text,uuid,integer,text)',         false, true),
      ('public.bell_feed(integer)',                              false, true),
      ('public.staff_pay_fields(uuid[])',                        false, true),
      ('public.work_links_for_event(uuid)',                      false, true),
      ('public.inventory_costs(uuid[])',                         false, true),
      ('public.event_group_contact(uuid)',                       false, true),
      ('public._r58_pay_key(uuid,text)',                         false, true),     -- the pay trigger runs as the caller
      ('public._r58_is_crew_role()',                             false, true),     -- run-sheet policy
      ('public._r58_crew_event_ids()',                           false, true),     -- run-sheet policy
      ('public._r58_may_join_event(uuid,uuid,uuid)',             false, false),
      ('public._r58_strip_event_names(jsonb)',                   false, false),
      ('public._r58_tg_crew_pay_guard()',                        false, false)
    ) t(fn, to_anon, to_auth) loop
    execute format('revoke all on function %s from public', r.fn);
    if v_has_anon then
      if r.to_anon then execute format('grant execute on function %s to anon', r.fn);
      else execute format('revoke all on function %s from anon', r.fn); end if;
    end if;
    if v_has_auth then
      if r.to_auth then execute format('grant execute on function %s to authenticated', r.fn);
      else execute format('revoke all on function %s from authenticated', r.fn); end if;
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', r.fn);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
