-- SUPERSEDED by migrations 0071-0072 / APPLY-0071-0072.sql - do not paste
-- =====================================================================
-- PENDING-SQL-ALL.sql  --  running list of every SQL change still to be applied
-- Owner: Koushik. Kept up to date during the Oct-2026 edge-case pass.
--
-- RULES (all sections below follow them):
--   * ADDITIVE + IDEMPOTENT only: CREATE OR REPLACE / IF NOT EXISTS / guarded constraints.
--     No DELETE, TRUNCATE, UPDATE of rows or DROP TABLE. The single constraint swap (Section 2) is
--     explained there. Safe to paste twice.
--   * Pure ASCII, no temp tables, no session state (Supabase SQL editor safe).
--   * Each section: purpose comment, PRE-CHECK select, the change, VERIFY select + expected result.
--     If a PRE-CHECK that says "expect 0 rows" returns rows: fix by renaming/deactivating (never
--     delete) and do NOT run that section until it is empty.
--   * Paste ONE section at a time (PRE-CHECK, then the change, then VERIFY). Apply to STAGING
--     (xizehqgeyjcfpzrdymly) first, check VERIFY, then PROD (nqltzgiwznphugcfhmbm).
--
-- STATUS TABLE
--   Sec | What                                              | Status             | Depends on          | Risk
--   ----+---------------------------------------------------+--------------------+---------------------+------
--    1  | reserve_inventory (atomic stock reservation)       | LIVE (confirmed)   | -                   | low
--    2  | invitations/_valid_role: add designer + quality    | NOT YET APPLIED    | -                   | low (swaps one CHECK)
--    3  | create_invitation refuses existing members         | NOT YET APPLIED    | 2, migration 0042   | low
--    4  | chat body <= 4000 chars (CHECK ... NOT VALID)      | NOT YET APPLIED    | -                   | low
--    5  | deleted chat messages locked                       | NOT YET APPLIED    | migration 0025      | low
--    6  | checkout_equipment FOR UPDATE                      | NOT YET APPLIED    | migration 0015      | low
--    7  | checkin_equipment idempotent write-off + worker cap| NOT YET APPLIED    | -                   | medium (new refusal)
--    8  | adjust_inventory_total uses inventory area         | NOT YET APPLIED    | -                   | medium (access change)
--    9  | duplicate-name/phone unique indexes (partial)      | NOT YET APPLIED    | PRE-CHECKS empty    | HIGHEST (23505 in app)
--   10  | quote-number advisory lock + org timezone date     | NOT YET APPLIED    | -                   | medium (replaces 2 core fns)
--   11-13 owner-decision stubs (commented out)              | NOT EXECUTABLE     | owner decision      | -
--
-- ORDER TO RUN: 2, 3, 4, 5, 6, 7, 8, 10, then 9 last (9 may need data clean-up first; it is
-- independent of the others, so a blocked 9 never holds up the rest). Section 1 is already live.
--
-- NOTE for the repo: when this goes into migrations it must be renumbered
-- (0070 is already used by 0070_booklet_payments.sql) -> 0071+, and added to
-- supabase/migrations/MANIFEST so the "DB canonical" GitHub check passes.
-- =====================================================================


-- ---------------------------------------------------------------------
-- SECTION 1 -- public.reserve_inventory(uuid, uuid, numeric, text)   [STATUS: CONFIRMED LIVE on the database; re-running is harmless]
-- PRE-CHECK 1: none needed (function only, no data touched).
-- Why: two people reserving the last units at the same moment could both succeed.
-- This locks the item row, re-computes demand for the event date (live
-- reservations + open check-outs, ignoring archived/deleted/cancelled/closed
-- events) and inserts only if it still fits.
-- App side: inventory.reserve() calls it and falls back to the old behaviour if
-- the function does not exist. A user-confirmed "Reserve anyway" over-commit
-- deliberately bypasses it.
-- ---------------------------------------------------------------------
create or replace function public.reserve_inventory(p_item uuid, p_quote uuid, p_qty numeric, p_note text default null)
returns public.inventory_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric; v_date date; v_org uuid := public.current_org_id();
  v_load numeric; v_undated numeric; v_row public.inventory_reservations;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  perform public.assert_quote_org(p_quote);

  -- serialise concurrent reservations of the same item
  select total_qty into v_total from public.inventory_items
    where id = p_item and org_id = v_org for update;
  if not found then raise exception 'item not found' using errcode='42501'; end if;

  select event_date into v_date from public.quotes where id = p_quote;

  -- per (item, event) demand = greatest(live reservations, still-out check-outs); live events only
  with ev as (
    select q.id, q.event_date from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.archived_at is null
       and q.status <> 'cancelled' and not (q.lifecycle_stage = 'closed' and q.status = 'confirmed')
  ), per as (
    select e.id as qid, e.event_date,
           greatest(coalesce((select sum(r.qty) from public.inventory_reservations r
                               where r.item_id = p_item and r.quote_id = e.id and r.status in ('reserved','allocated')),0),
                    coalesce((select sum(c.qty_out - coalesce(c.qty_in,0)) from public.inventory_checkouts c
                               where c.item_id = p_item and c.quote_id = e.id and c.status in ('out','partial')),0)) as d
      from ev e
  )
  select coalesce(sum(d) filter (where event_date is not distinct from v_date and v_date is not null),0),
         coalesce(sum(d) filter (where event_date is null),0)
    into v_load, v_undated from per;

  -- stock checked out with no event counts as undated demand
  v_undated := v_undated + coalesce((select sum(c.qty_out - coalesce(c.qty_in,0)) from public.inventory_checkouts c
                                      where c.item_id = p_item and c.quote_id is null and c.status in ('out','partial')),0);

  -- a dateless target event is checked conservatively against everything on its own bucket
  if v_date is null then v_load := v_undated; v_undated := 0; end if;

  if v_load + v_undated + p_qty > v_total then
    raise exception 'not enough stock free (% left)', greatest(v_total - v_load - v_undated, 0) using errcode='P0001';
  end if;

  insert into public.inventory_reservations (item_id, quote_id, qty, note)
    values (p_item, p_quote, p_qty, nullif(btrim(coalesce(p_note,'')),''))
    returning * into v_row;
  return v_row;
end $$;

revoke all on function public.reserve_inventory(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.reserve_inventory(uuid, uuid, numeric, text) to authenticated;

-- VERIFY 1 (expect one row: reserve_inventory | true | authenticated can execute)
select p.proname,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'reserve_inventory';
-- expected: security_definer = true, authenticated_can_execute = true, anon_can_execute = false


-- ---------------------------------------------------------------------
-- SECTION 2 -- invitations / roles: allow 'designer' and 'quality'   (audit2-admin finding 1, "SQL A")
-- Why: the Control Center offers Designer and Quality, but _valid_role() has no 'designer' and
-- invitations_role_chk has neither, so admin_set_role / invites fail with a raw error.
-- Change: _valid_role() becomes a strict SUPERSET (adds 'designer'); the invitations CHECK is
-- swapped for a strict superset. No row is read or changed.
-- THE ONE DROP IN THIS FILE: a CHECK constraint cannot be widened in place, so the DO block drops
-- invitations_role_chk and re-adds it (same name) in one atomic block. It only runs if the live
-- constraint does not yet mention 'designer', and every existing row already satisfies the superset.
-- If you want zero drops, skip the DO block and remove designer/quality from ALL_ROLES in
-- public/store-api.js (~line 1001) instead.
-- Live-vs-repo: repo _valid_role = canonical-base/base-v1 line 1421 (nothing later redefines it).
-- ---------------------------------------------------------------------
-- PRE-CHECK 2 (read-only). Must return 0 rows; if it returns rows, FIX BY RENAMING/DEACTIVATING
-- (change those invitations' role to an allowed one), NEVER delete, and DO NOT run this section
-- until it is empty.
select id, email, role from public.invitations
 where role <> all (array['admin','manager','planner','sales','coordinator','supervisor',
                          'quality','operations','designer','crew','worker','client']);

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

-- VERIFY 2 (expect one row: designer_ok = true, constraint_has_designer = true)
select public._valid_role('designer') as designer_ok,
       (select pg_get_constraintdef(oid) like '%designer%' from pg_constraint
         where conname = 'invitations_role_chk' and conrelid = 'public.invitations'::regclass) as constraint_has_designer;
-- expected: designer_ok = true, constraint_has_designer = true


-- ---------------------------------------------------------------------
-- SECTION 3 -- create_invitation refuses people who are already members   (audit2-admin finding 2, "SQL B")
-- Why: an admin could invite their OWN e-mail at a lower role; accept_invitation then demotes them,
-- bypassing admin_set_role's "cannot remove your own admin role" guard (a studio with zero admins).
-- Change: the 0042 wrapper body is kept exactly (operator-email refusal, re-invite-at-new-role token
-- rotation, delegation to create_invitation__pre0042) and one member check is added.
-- Depends on: Section 2 (so Designer/Quality invites are accepted) and 0042 (create_invitation__pre0042,
-- _a42_is_operator_email). The DO block does nothing if those helpers are missing.
-- Live-vs-repo: latest repo definition is migrations/0042_audit_run2_fixes.sql:828.
-- App paths: control.html -> BPStore.invitations.create will now show the new refusal text when the
-- e-mail already belongs to a member of this studio (errcode 22023).
-- ---------------------------------------------------------------------
-- PRE-CHECK 3 (read-only). All three columns must be true. If any is false, DO NOT run this section
-- (it would be a no-op anyway) and fix the missing dependency first. Nothing is ever deleted.
select to_regprocedure('public.create_invitation__pre0042(text,text)') is not null as has_pre0042,
       to_regprocedure('public._a42_is_operator_email(text)') is not null as has_operator_fn,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles' and column_name = 'email') as has_profile_email;

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

-- VERIFY 3 (expect one row)
select p.prosrc like '%already a member of this studio%' as refuses_members,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'create_invitation';
-- expected: refuses_members = true, authenticated_can_execute = true, anon_can_execute = false


-- ---------------------------------------------------------------------
-- SECTION 4 -- chat message body length cap (4000 chars), NOT VALID   (audit2-admin finding 5, "SQL C")
-- Why: no limit anywhere; a 5 MB paste freezes every member's thread.
-- NOT VALID = enforced for every NEW or EDITED row; existing rows are never scanned or changed.
-- App paths: chat_send RPC and chat.editMessage will now fail with check violation 23514 on >4000
-- chars. public/chat.html textarea has no maxlength yet -> add maxlength="4000" there (separate
-- change, not in this file) so users never see the raw error.
-- ---------------------------------------------------------------------
-- PRE-CHECK 4 (read-only, informational because the constraint is NOT VALID): old rows over the cap.
-- A non-zero count is NOT a blocker; those rows stay as they are (but cannot be re-edited while long).
select count(*) as existing_rows_over_4000 from public.chat_messages where char_length(body) > 4000;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'chat_messages_body_len_chk' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages
      add constraint chat_messages_body_len_chk check (body is null or char_length(body) <= 4000) not valid;
  end if;
end $$;

-- VERIFY 4 (expect one row)
select conname, convalidated as validated from pg_constraint
 where conname = 'chat_messages_body_len_chk' and conrelid = 'public.chat_messages'::regclass;
-- expected: 1 row, validated = false (NOT VALID on purpose)


-- ---------------------------------------------------------------------
-- SECTION 5 -- deleted chat messages stay deleted   (audit2-admin finding 11, "SQL D", optional)
-- Why: the author could UPDATE deleted=false / change body on their own tombstone.
-- Change: the 0025 guard function is kept exactly; one rule is added: once deleted=true, API roles
-- cannot change deleted or body. The trigger chat_messages_api_guard_bu already exists from 0025 and
-- is NOT touched. Deleting (false -> true) still works.
-- Live-vs-repo: repo definition = migrations/0025_write_path_lockdown.sql:179.
-- ---------------------------------------------------------------------
-- PRE-CHECK 5 (read-only): the trigger must exist (expect 1 row). If 0 rows, apply 0025 first and
-- DO NOT run this section.
select tgname from pg_trigger
 where tgrelid = 'public.chat_messages'::regclass and tgname = 'chat_messages_api_guard_bu' and not tgisinternal;

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

-- VERIFY 5 (expect one row)
select p.prosrc like '%a deleted message can not be changed%' as locks_deleted
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'chat_messages_api_guard';
-- expected: locks_deleted = true


-- ---------------------------------------------------------------------
-- SECTION 6 -- checkout_equipment locks the item row   (audit2-data F1, "S1")
-- Why: two simultaneous check-outs both read the same free stock and both insert (over-issue).
-- Change: 0015 body kept exactly; the stock read now uses SELECT ... FOR UPDATE on the item row so
-- concurrent check-outs of one item queue up. Only user-visible difference: the error text uses a
-- plain hyphen instead of an em dash (no client code matches that text).
-- Live-vs-repo: repo = migrations/0015_checkout_overissue_guard.sql (phase73 copy is older).
-- ---------------------------------------------------------------------
-- PRE-CHECK 6 (read-only, informational): items already over-issued by a past race. Rows here are
-- NOT a blocker and are NOT changed by this section; review them by hand (never delete).
select i.id, i.name, i.total_qty, sum(greatest(c.qty_out - coalesce(c.qty_in,0),0)) as out_now
  from public.inventory_items i join public.inventory_checkouts c on c.item_id = i.id and c.status <> 'returned'
 group by i.id, i.name, i.total_qty
having sum(greatest(c.qty_out - coalesce(c.qty_in,0),0)) > i.total_qty;

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

-- VERIFY 6 (expect one row)
select p.prosrc ilike '%for update%' as locks_item_row,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'checkout_equipment';
-- expected: locks_item_row = true, anon_can_execute = false


-- ---------------------------------------------------------------------
-- SECTION 7 -- checkin_equipment idempotent write-off (S2) + worker_checkin_equipment cap (audit F3)
-- Why: with write-off ticked, every repeat call subtracted the missing quantity from total_qty
-- again (double-click / retry shrinks stock silently). Also qty_in could exceed qty_out and the
-- checkout row was read without a lock.
-- Change: new column inventory_checkouts.written_off (default 0, additive). checkin_equipment locks
-- the row, rejects qty_in > qty_out, and subtracts only the not-yet-written-off delta.
-- worker_checkin_equipment (crew-token path, anon-callable) gets the same upper bound + row lock.
-- Live-vs-repo: checkin_equipment = canonical-base/base-v1 line 1868 (never redefined in
-- migrations; phase73 copy older). worker_checkin_equipment = migrations/0012_token_otp_hardening.sql:150.
-- App paths: inventory return form and crew worker page. A returned count larger than the quantity
-- issued is now refused ('returned count cannot exceed quantity issued'); before, it was stored.
-- Write-offs that were already double-applied in the past are NOT detectable or repaired here.
-- ---------------------------------------------------------------------
-- PRE-CHECK 7 (read-only, informational): rows where qty_in already exceeds qty_out. Re-submitting
-- those would now be refused; the rows themselves are left alone. Not a blocker; never delete.
select id, item_id, qty_out, qty_in from public.inventory_checkouts where qty_in > qty_out;

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

-- VERIFY 7 (expect one row)
select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'written_off') as has_column,
       (select prosrc like '%written_off%' from pg_proc where proname = 'checkin_equipment' and pronamespace = 'public'::regnamespace) as checkin_idempotent,
       (select prosrc like '%cannot exceed quantity issued%' from pg_proc where proname = 'worker_checkin_equipment' and pronamespace = 'public'::regnamespace) as worker_capped;
-- expected: has_column = true, checkin_idempotent = true, worker_capped = true
-- (grants on worker_checkin_equipment for anon + authenticated, from phase52, are kept by CREATE OR REPLACE)


-- ---------------------------------------------------------------------
-- SECTION 8 -- adjust_inventory_total gated by the inventory area   (audit2-data F4, "S3")
-- Why: it checked generic can_edit(); every sibling inventory RPC uses has_area('inventory','edit').
-- Change: ONLY the gate (plus errcode 42501 on the refusal). The greatest(0, ...) clamp is kept
-- (changing it to raise would be a behaviour change - owner decision).
-- Live-vs-repo: repo = canonical-base/base-v1 line 1515 (phase71 copy is older). Grants are kept.
-- ---------------------------------------------------------------------
-- PRE-CHECK 8 (read-only, informational): roles that can edit something but NOT inventory - these
-- users LOSE the ability to adjust stock. Review; fix by granting inventory edit in the Control
-- Center access matrix (never by deleting). Not a blocker if the list is expected.
select role from public.role_access
 group by role
having bool_or(can_edit) and not bool_or(area = 'inventory' and can_edit);

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

-- VERIFY 8 (expect one row)
select p.prosrc like '%has_area(''inventory'',''edit'')%' as gated_by_area
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'adjust_inventory_total';
-- expected: gated_by_area = true


-- ---------------------------------------------------------------------
-- SECTION 9 -- duplicate-name / duplicate-phone unique indexes   (audit2-data F5, "S4")
-- Why: nothing stops two active items/vendors/dishes/crew (by phone)/leads (phone + event date)
-- with the same identity in one studio; stock counts split and crew get double-counted.
-- All indexes are PARTIAL (active rows / non-empty phone) so retired rows and legitimate repeats
-- (a repeat client with a different event date) still work. A violation makes CREATE INDEX fail
-- harmlessly (no data change) - but run the PRE-CHECKs and clear them first.
-- RUN 9a-9e FIRST. Each must return ZERO rows. If any returns rows: FIX BY RENAMING OR SETTING
-- active=false ON THE EXTRAS (a human-chosen change in the app), NEVER delete, and DO NOT run the
-- CREATE INDEX lines until all five are empty.
-- App paths that can now hit 23505 (UI should catch it and say "already exists"):
--   store-api.js ~3134 inventory insert and ~3142 BULK IMPORT (one INSERT of many rows: one
--   duplicate fails the whole batch); ~2562/2583 vendors; ~3373 dish_catalog; ~2356 crew insert;
--   ~2622 leads insert; renaming an item/vendor/dish to an existing name; re-activating an
--   inactive duplicate. Server side: 0041 member-profile sync inserts crew_members (it links an
--   unlinked row with the same phone first, so a clash only occurs if a DIFFERENT active crew row
--   already holds that mobile - which is exactly what the index flags).
-- The crew index (9d) is the riskiest: relatives sharing one mobile number would be refused.
-- ---------------------------------------------------------------------
-- PRE-CHECK 9a inventory_items (expect 0 rows)
select org_id, lower(btrim(name)) as n, count(*), array_agg(id) from public.inventory_items
 where active group by 1,2 having count(*) > 1;
-- PRE-CHECK 9b vendors (expect 0 rows)
select org_id, lower(btrim(name)) as n, count(*), array_agg(id) from public.vendors
 where active group by 1,2 having count(*) > 1;
-- PRE-CHECK 9c dish_catalog (expect 0 rows)
select org_id, lower(btrim(category)) as c, lower(btrim(name)) as n, count(*), array_agg(id) from public.dish_catalog
 where active group by 1,2,3 having count(*) > 1;
-- PRE-CHECK 9d crew_members by phone digits (expect 0 rows)
select org_id, regexp_replace(phone,'[^0-9]','','g') as d, count(*), array_agg(id) from public.crew_members
 where active and regexp_replace(coalesce(phone,''),'[^0-9]','','g') <> '' group by 1,2 having count(*) > 1;
-- PRE-CHECK 9e leads, same phone AND same event date (expect 0 rows)
select org_id, regexp_replace(phone,'[^0-9]','','g') as d, coalesce(event_date, date '0001-01-01') as ed, count(*), array_agg(id) from public.leads
 where regexp_replace(coalesce(phone,''),'[^0-9]','','g') <> '' group by 1,2,3 having count(*) > 1;

create unique index if not exists inventory_items_org_name_uidx
  on public.inventory_items (org_id, lower(btrim(name))) where active;
create unique index if not exists vendors_org_name_uidx
  on public.vendors (org_id, lower(btrim(name))) where active;
create unique index if not exists dish_catalog_org_cat_name_uidx
  on public.dish_catalog (org_id, lower(btrim(category)), lower(btrim(name))) where active;
create unique index if not exists crew_members_org_phone_uidx
  on public.crew_members (org_id, regexp_replace(phone,'[^0-9]','','g'))
  where active and regexp_replace(coalesce(phone,''),'[^0-9]','','g') <> '';
create unique index if not exists leads_org_phone_date_uidx
  on public.leads (org_id, regexp_replace(phone,'[^0-9]','','g'), coalesce(event_date, date '0001-01-01'))
  where regexp_replace(coalesce(phone,''),'[^0-9]','','g') <> '';

-- VERIFY 9 (expect 5 rows)
select indexname from pg_indexes where schemaname = 'public' and indexname in
 ('inventory_items_org_name_uidx','vendors_org_name_uidx','dish_catalog_org_cat_name_uidx',
  'crew_members_org_phone_uidx','leads_org_phone_date_uidx');
-- expected: 5 rows. CREATE INDEX (non-concurrent) briefly blocks writes on the table: run in a quiet window.


-- ---------------------------------------------------------------------
-- SECTION 10 -- quote numbers: advisory lock (S5) + org-timezone date for create_quote (builder finding 13)
-- Why: (a) a burst of >25 simultaneous creates for one date in one studio could surface a raw
-- unique_violation; (b) create_quote with no event date stamped the code with the DATABASE (UTC)
-- date, so between 00:00 and 05:30 IST a new quote got YESTERDAY's code.
-- Change: create_quote and rebrand_quote_code keep their repo bodies (canonical-base/base-v1 lines
-- 2106 and 2699; nothing later redefines them) and add (1) a transaction-scoped advisory lock on
-- (org, date stamp) as the first statement in the retry loop, (2) create_quote only: the stamp uses
-- the studio's own timezone (organizations.timezone, fallback Asia/Kolkata; an invalid zone name
-- falls back too). The unique (org_id, code) and the 25-retry loop are untouched; codes of
-- archived/deleted quotes are still counted, so numbers are never reused.
-- Live-vs-repo: if prod differs from the repo, STOP and compare with
--   select pg_get_functiondef('public.create_quote(text,text,text,jsonb,integer,date)'::regprocedure);
-- Grants (revoke from public/anon, grant authenticated) are preserved by CREATE OR REPLACE.
-- ---------------------------------------------------------------------
-- PRE-CHECK 10 (read-only): studios whose stored timezone is not a valid zone name (they would fall
-- back to Asia/Kolkata). Expect 0 rows; if rows, correct organizations.timezone in the app (never delete).
select o.id, o.name, o.timezone from public.organizations o
 where not exists (select 1 from pg_timezone_names z where z.name = o.timezone);

create or replace function public.create_quote(p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count integer, p_event_date date default null::date)
 returns quotes
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q public.quotes;
  v_tz text := coalesce((select timezone from public.organizations where id = public.current_org_id()), 'Asia/Kolkata');
  v_stamp text;
  v_next int; v_code text; v_try int := 0;
begin
  begin
    v_stamp := to_char(coalesce(p_event_date::timestamp, now() at time zone v_tz), 'MMDDYYYY');
  exception when others then
    v_stamp := to_char(coalesce(p_event_date::timestamp, now() at time zone 'Asia/Kolkata'), 'MMDDYYYY');
  end;
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
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
end; $function$;

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

-- VERIFY 10 (expect two rows)
select p.proname,
       p.prosrc like '%helm:qcode:%' as has_lock,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('create_quote', 'rebrand_quote_code');
-- expected: 2 rows, has_lock = true, anon_can_execute = false for both.
-- Known gap: the dashboard "next code" hint (store-api.js ~2280) still uses the browser's local date;
-- it is only a hint, the server value wins.


-- =====================================================================
-- OWNER-DECISION SECTIONS -- COMMENTED-OUT STUBS. NOT EXECUTABLE. Do not paste.
-- Each needs a product decision first, then a new SECURITY DEFINER function
-- (set search_path = public, org-scoped by current_org_id(), has_area() gate, audit trail).
-- Source: docs/ISSUES-TRACKER-OCT-2026.md, "Earlier skipped (need server functions)".
-- =====================================================================
-- SECTION 11 (stub) -- undo a paid milestone
--   Needed: public.undo_milestone_payment(p_milestone uuid, p_reason text).
--   Decide first: is a payment ever reversed in place, or only by a correcting ledger entry?
--   Safe design: never remove or change the original payment row; add a reversing record (new row,
--   idempotency key, reason, who/when), recompute the milestone status from the ledger, take the
--   same per-quote advisory lock as record_payment, finance/admin area only, refuse on a closed event.
-- SECTION 12 (stub) -- clear a menu package from an event
--   Needed: public.clear_menu_package(p_quote uuid).
--   Decide first: what happens to dishes the client customised after picking the package, and to
--   priced lines? Safe design: detach the package link only and keep every selected dish and price
--   line, or snapshot the previous selection into version history first; re-price through the D8
--   pricing authority; refuse after the quote is approved/confirmed.
-- SECTION 13 (stub) -- per-staff open-task count
--   Needed: public.staff_open_task_counts() returning (crew_id, open_count).
--   Read-only aggregate over event_tasks (open statuses only, live events only), org-scoped,
--   has_area('crew','view') gate. Replaces the client-side count that truncates at the 1000-row
--   limit (audit2-data F8). No data change; open question is which statuses count as "open".


-- ================= END OF CURRENT PENDING SQL =================
