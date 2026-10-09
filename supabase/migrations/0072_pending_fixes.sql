-- 0072_pending_fixes.sql - CANONICAL forward-only. Sections 2-8 + 10 of the old
-- supabase/PENDING-SQL-ALL.sql (section 1 = 0071; section 9, duplicate-name unique indexes, is
-- EXCLUDED pending an owner decision). Additive + idempotent: CREATE OR REPLACE, ADD COLUMN IF NOT
-- EXISTS, guarded CHECKs. No row is updated or deleted. Two CHECK swaps (invitations_role_chk widened,
-- chat_messages_body_len_chk 10000 -> 4000 NOT VALID) each run in one guarded DO block.
-- REQUIRES 0011 (create_quote / convert_lead_to_quote F10 gates), 0015, 0025, 0026, 0042.
--
-- In plain words:
--   2  Designer + Quality roles can be invited / assigned (no more raw CHECK error).
--   3  Inviting someone who is already a member is refused (22023) - stops an admin demoting
--      themselves (or the last admin) through an invite.
--   4  Chat messages are capped at 4000 chars for new/edited rows (chat.html maxlength = 4000).
--   5  A deleted chat message can not be undeleted or re-edited by its author.
--   6  checkout_equipment locks the item row, so two simultaneous check-outs cannot over-issue.
--   7  checkin_equipment locks the checkout row, refuses qty_in > qty_out and only writes off the
--      not-yet-written-off delta (new column inventory_checkouts.written_off, default 0).
--      worker_checkin_equipment (crew link) gets the same cap + row lock.
--      LEGACY ROWS: rows written off BEFORE this migration have written_off = 0, so ONE more
--      write-off on such a partial row could subtract again once (then it is recorded). They are
--      deliberately NOT backfilled (no row updates).
--   8  adjust_inventory_total needs inventory edit (was any can_edit()).
--   10 Quote codes: advisory lock per (studio, date stamp) so bursts never collide; with no event
--      date the stamp is the studio's local date (organizations.timezone), not UTC - applies to
--      create_quote AND convert_lead_to_quote. Bodies = 0011 (F10 has_area gates kept) / base-v1
--      (rebrand_quote_code); nothing later redefines them. Grants are kept by CREATE OR REPLACE.

-- ---- 2) _valid_role + invitations_role_chk: add designer + quality --------------------
create or replace function public._valid_role(p_role text)
 returns boolean language sql immutable set search_path to 'public' as $$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','designer','crew','worker','client');
$$;

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'invitations_role_chk' and conrelid = 'public.invitations'::regclass
                and pg_get_constraintdef(oid) not like '%designer%') then
    alter table public.invitations drop constraint invitations_role_chk;
    alter table public.invitations add constraint invitations_role_chk
      check (role = any (array['admin','manager','planner','sales','coordinator','supervisor',
                               'quality','operations','designer','crew','worker','client']));
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'invitations_role_chk' and conrelid = 'public.invitations'::regclass
                and pg_get_constraintdef(oid) not like '%designer%') then
    alter table public.invitations drop constraint invitations_role_chk;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'invitations_role_chk' and conrelid = 'public.invitations'::regclass) then
    alter table public.invitations add constraint invitations_role_chk
      check (role = any (array['admin','manager','planner','sales','coordinator','supervisor',
                               'quality','operations','designer','crew','worker','client']));
  end if;
end $$;

-- ---- 3) create_invitation refuses existing members (0042 wrapper kept) -------------------
do $outer$
begin
  if to_regprocedure('public.create_invitation__pre0042(text,text)') is not null
     and to_regprocedure('public._a42_is_operator_email(text)') is not null then
    execute $f$
create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $body$
declare v_org uuid := public.current_org_id(); v_id uuid;
begin
  if public._a42_is_operator_email(p_email) then
    raise exception 'this e-mail address can''t be invited' using errcode = '22023';
  end if;
  if public.is_admin() and v_org is not null then
    if exists (select 1 from public.profiles pr
                where pr.org_id = v_org
                  and lower(pr.email) = lower(btrim(coalesce(p_email, '')))) then
      raise exception 'that person is already a member of this studio - change their role in the Users list instead'
        using errcode = '22023';
    end if;
  end if;
  if public.is_admin() and v_org is not null and public._valid_role(p_role) then
    select i.id into v_id from public.invitations i
     where i.org_id = v_org and lower(i.email) = lower(btrim(coalesce(p_email, '')))
       and i.status = 'pending' and i.expires_at > now()
     order by i.created_at desc limit 1;
    if v_id is not null then
      update public.invitations i
         set role = p_role, token = encode(extensions.gen_random_bytes(24), 'hex')
       where i.id = v_id and i.role is distinct from p_role;
    end if;
  end if;
  return public.create_invitation__pre0042(p_email, p_role);
end $body$
    $f$;
    execute 'revoke all on function public.create_invitation(text, text) from anon, public';
    execute 'grant execute on function public.create_invitation(text, text) to authenticated';
  end if;
end $outer$;

-- ---- 4) chat body cap 4000 ----------------------------------------------------------------
do $$
begin
  -- 0026 added chat_messages_body_len_chk with a 10000 cap. Swap it (same name, one atomic block)
  -- for the 4000 cap, NOT VALID: only new/edited rows are checked; old rows are never scanned.
  -- A delete sets body = null, which always passes, so long legacy messages can still be deleted.
  if exists (select 1 from pg_constraint
              where conname = 'chat_messages_body_len_chk' and conrelid = 'public.chat_messages'::regclass
                and pg_get_constraintdef(oid) not like '%<= 4000)%') then
    alter table public.chat_messages drop constraint chat_messages_body_len_chk;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'chat_messages_body_len_chk' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages
      add constraint chat_messages_body_len_chk check (char_length(body) <= 4000) not valid;
  end if;
end $$;

-- ---- 5) deleted chat messages stay deleted (0025 guard kept + one rule) ----------------
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
    if old.deleted is true and (new.deleted is distinct from old.deleted or new.body is distinct from old.body) then
      raise exception 'a deleted message can not be changed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.chat_messages_api_guard() from public, anon, authenticated;

-- ---- 6) checkout_equipment FOR UPDATE (0015 body kept) -------------------------------------
create or replace function public.checkout_equipment(
  p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid, p_note text)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_total numeric; v_out numeric; v_free numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item and org_id = public.current_org_id()) then
    raise exception 'item not found' using errcode='42501'; end if;
  if p_quote is not null then perform public.assert_quote_org(p_quote); end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  if coalesce(btrim(p_issued_to),'') = '' then raise exception 'who is it issued to?'; end if;

  -- physical availability guard; FOR UPDATE serialises concurrent check-outs of the same item
  select coalesce(total_qty,0) into v_total
    from public.inventory_items where id = p_item and org_id = public.current_org_id() for update;
  select coalesce(sum(greatest(qty_out - coalesce(qty_in,0), 0)), 0) into v_out
    from public.inventory_checkouts where item_id = p_item and status <> 'returned';
  v_free := v_total - v_out;
  if p_qty > v_free then
    raise exception 'cannot check out % - only % of % available (% already out on loan)',
      p_qty, v_free, v_total, v_out using errcode='23514';
  end if;

  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $$;
grant execute on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) to authenticated;

-- ---- 7) idempotent write-off + qty_in cap -------------------------------------------------
alter table public.inventory_checkouts add column if not exists written_off numeric not null default 0;

create or replace function public.checkin_equipment(p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean default false)
 returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_missing numeric; v_new_wo numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id and org_id = public.current_org_id() for update;
  if not found then raise exception 'checkout not found'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  if coalesce(p_qty_in,0) > row.qty_out then raise exception 'returned count cannot exceed quantity issued'; end if;
  v_missing := greatest(row.qty_out - coalesce(p_qty_in,0), 0);
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = nullif(btrim(coalesce(p_returned_by,'')),''),
         confirmed_by = auth.uid(),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= row.qty_out then 'returned' else 'partial' end
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if p_writeoff and v_missing > coalesce(row.written_off,0) then
    v_new_wo := v_missing - coalesce(row.written_off,0);
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty,0) - v_new_wo)
     where id = row.item_id and org_id = public.current_org_id();
    update public.inventory_checkouts set written_off = v_missing where id = p_id and org_id = public.current_org_id()
     returning * into row;
  end if;
  return row;
end; $$;
grant execute on function public.checkin_equipment(uuid,numeric,text,boolean) to authenticated;

create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
 returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  w := public._work_token_live(p_token);
  select * into row from public.inventory_checkouts where id = p_id for update;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  if coalesce(p_qty_in,0) > row.qty_out then raise exception 'returned count cannot exceed quantity issued'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $function$;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'inventory_checkouts_written_off_nonneg_chk'
                    and conrelid = 'public.inventory_checkouts'::regclass) then
    alter table public.inventory_checkouts
      add constraint inventory_checkouts_written_off_nonneg_chk check (written_off >= 0) not valid;
  end if;
end $$;

-- ---- 8) adjust_inventory_total gated by inventory edit ------------------------------------
create or replace function public.adjust_inventory_total(p_item_id uuid, p_delta numeric)
 returns public.inventory_items language plpgsql security definer set search_path = public as $$
declare row public.inventory_items;
begin
  if not public.has_area('inventory','edit') then raise exception 'not allowed' using errcode='42501'; end if;
  update public.inventory_items
     set total_qty = greatest(0, coalesce(total_qty,0) + coalesce(p_delta,0))
   where id = p_item_id and org_id = public.current_org_id()
   returning * into row;
  if row.id is null then raise exception 'item not found'; end if;
  return row;
end; $$;

-- ---- 10) quote codes: advisory lock + studio-timezone stamp -------------------------------
CREATE OR REPLACE FUNCTION public.create_quote(p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count integer, p_event_date date DEFAULT NULL::date)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
  v_stamp text; v_today date;
  v_next int; v_code text; v_try int := 0;
begin
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  -- 0072: no event date -> stamp with the studio's own local date (organizations.timezone,
  -- fallback Asia/Kolkata; an invalid zone name falls back too), not the UTC server date
  begin
    v_today := (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = public.current_org_id()), 'Asia/Kolkata'))::date;
  exception when others then
    v_today := (now() at time zone 'Asia/Kolkata')::date;
  end;
  v_stamp := to_char(coalesce(p_event_date, v_today), 'MMDDYYYY');
  loop
    v_try := v_try + 1;
    perform pg_advisory_xact_lock(hashtextextended('helm:qcode:' || coalesce(public.current_org_id()::text, '') || v_stamp, 0));
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, event_date)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1, p_event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $function$
;

CREATE OR REPLACE FUNCTION public.convert_lead_to_quote(p_lead_id uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  l public.leads; q public.quotes;
  v_stamp text; v_today date; v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not (public.has_area('quotes','edit') or public.has_area('leads','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id and org_id = public.current_org_id();
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id and org_id = public.current_org_id(); return q; end if;
  -- 0072: no event date -> stamp with the studio's own local date (organizations.timezone,
  -- fallback Asia/Kolkata; an invalid zone name falls back too), not the UTC server date
  begin
    v_today := (now() at time zone coalesce((select o.timezone from public.organizations o where o.id = public.current_org_id()), 'Asia/Kolkata'))::date;
  exception when others then
    v_today := (now() at time zone 'Asia/Kolkata')::date;
  end;
  v_stamp := to_char(coalesce(l.event_date, v_today), 'MMDDYYYY');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' ' || chr(8212) || ' ' || l.event_type else '' end;
  loop
    v_try := v_try + 1;
    perform pg_advisory_xact_lock(hashtextextended('helm:qcode:' || coalesce(public.current_org_id()::text, '') || v_stamp, 0));
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
        values (v_code, v_title, l.event_type, 1,
                jsonb_strip_nulls(jsonb_build_object(
                  'name', l.name, 'phone', l.phone, 'email', l.email,
                  'guests', l.guest_count, 'budget', l.budget,
                  'eventDate', to_char(l.event_date, 'YYYY-MM-DD'), 'source', l.source)),
                'discovery', l.event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now()
    where id = p_lead_id and org_id = public.current_org_id();
  return q;
end; $function$
;

create or replace function public.rebrand_quote_code(p_quote_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q public.quotes; v_stamp text; v_next int; v_code text; v_try int := 0;
begin
  if not public.has_area('quotes','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'quote not found'; end if;
  if q.event_date is null then return q.code; end if;
  v_stamp := to_char(q.event_date, 'MMDDYYYY');
  if q.code like v_stamp || '-%' then return q.code; end if;
  loop
    v_try := v_try + 1;
    perform pg_advisory_xact_lock(hashtextextended('helm:qcode:' || coalesce(public.current_org_id()::text, '') || v_stamp, 0));
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      update public.quotes set code = v_code where id = p_quote_id and org_id = public.current_org_id();
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  return v_code;
end; $function$;
