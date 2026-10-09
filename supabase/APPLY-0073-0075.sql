-- APPLY-0073-0075.sql  --  ONE paste for the issue round (inventory 0073, chat/admin 0074, quotes/booklet 0075).
-- Run on STAGING first, then PROD, AFTER APPLY-0071-0072. Idempotent: safe to paste twice. Pure ASCII.
-- Read-only pre-checks inside each part only list rows (informational). The LAST result grid is the combined
-- VERIFY: every row must say ok = true. If a 0073 duplicate-name row is false, rename/deactivate the duplicate
-- items/vendors/dishes in the app and paste this file again.
-- ===================== APPLY-0073 =====================
-- APPLY-0073.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- REQUIRES 0071 + 0072 already applied (APPLY-0071-0072.sql).
-- Contents = supabase/migrations/0073_inventory_cancel_and_unique_names.sql verbatim.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: no row is updated or deleted. One CHECK superset swap (adds 'cancelled'),
-- two ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, the "ra del" policy on
-- inventory_checkouts dropped + DELETE revoked from anon/authenticated, and up to three partial
-- unique indexes that are created ONLY when no duplicates exist (otherwise skipped with a NOTICE).
-- EXPECTED: the last result grid (item, ok) has 16 rows and EVERY ok = true.
-- If row 14/15/16 is false: that table has duplicate ACTIVE names (see PRE-CHECK A/B/C). Rename or
-- deactivate the extras in the app (never delete), then paste this file again.

-- =====================================================================================
-- PRE-CHECKS (read-only, INFORMATIONAL ONLY - none of them blocks the apply; nothing is changed)
-- =====================================================================================
-- PRE-CHECK A: inventory items with the same ACTIVE name in one studio (expect 0 rows).
select 'A dup active inventory_items' as precheck, i.org_id, lower(btrim(i.name)) as name_key,
       count(*) as n, array_agg(i.id order by i.created_at) as ids
  from public.inventory_items i where i.active
 group by i.org_id, lower(btrim(i.name)) having count(*) > 1;

-- PRE-CHECK B: partners (vendors) with the same ACTIVE name in one studio (expect 0 rows).
select 'B dup active vendors' as precheck, v.org_id, lower(btrim(v.name)) as name_key,
       count(*) as n, array_agg(v.id order by v.created_at) as ids
  from public.vendors v where v.active
 group by v.org_id, lower(btrim(v.name)) having count(*) > 1;

-- PRE-CHECK C: dishes with the same ACTIVE category + name in one studio (expect 0 rows).
select 'C dup active dish_catalog' as precheck, d.org_id, lower(btrim(d.category)) as category_key,
       lower(btrim(d.name)) as name_key, count(*) as n, array_agg(d.id order by d.created_at) as ids
  from public.dish_catalog d where d.active
 group by d.org_id, lower(btrim(d.category)), lower(btrim(d.name)) having count(*) > 1;

-- PRE-CHECK D: check-out rows whose status is outside out/returned/partial (expect 0 rows).
select 'D unexpected checkout status' as precheck, c.id, c.status
  from public.inventory_checkouts c where c.status not in ('out', 'returned', 'partial', 'cancelled');

-- =====================================================================================
-- CHANGES (0073)
-- =====================================================================================
-- 0073_inventory_cancel_and_unique_names.sql - CANONICAL forward-only.
-- Additive + idempotent. No row is updated or deleted by this migration.
-- REQUIRES 0015, 0025, 0071, 0072.
--
-- In plain words:
--   1  Owner decision #4: equipment check-out records are NEVER hard-deleted. A check-out recorded
--      by mistake (nothing returned yet) is CANCELLED with the new cancel_checkout() function:
--      status 'cancelled', who + when kept, the audit trigger logs it, and the stock is free again.
--      The checkouts status CHECK is widened to allow 'cancelled' (superset swap, guarded DO block).
--      The "ra del" RLS policy on inventory_checkouts is dropped and DELETE revoked from the API
--      roles, so the app can no longer delete a check-out row.
--   2  Every "how much is out" sum ignores cancelled rows: checkout_equipment (was "status <> returned",
--      which would have counted cancelled rows), reserve_inventory (0071, already out/partial only),
--      and checkin_equipment / worker_checkin_equipment refuse a cancelled row.
--   3  Owner decision #12: exact duplicate names among ACTIVE inventory items, partners (vendors) and
--      dishes (same category + name) are refused by partial unique indexes on
--      (org_id, lower(btrim(name))) WHERE active. Each index is created ONLY when no duplicates
--      exist today; otherwise it is skipped with a NOTICE (re-run this file after the owner has
--      renamed or deactivated the extras in the app). Existing data is never modified.
--      Staff phones and leads stay WARN-only in the app (no index).

-- ---- 1a) status CHECK: allow 'cancelled' (superset of out / returned / partial) -------------
do $$
declare v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conname = 'inventory_checkouts_status_check' and c.conrelid = 'public.inventory_checkouts'::regclass;
  if v_def is null or v_def not like '%cancelled%' then
    if v_def is not null then
      alter table public.inventory_checkouts drop constraint inventory_checkouts_status_check;
    end if;
    alter table public.inventory_checkouts add constraint inventory_checkouts_status_check
      check (status = any (array['out'::text, 'returned'::text, 'partial'::text, 'cancelled'::text]));
  end if;
end $$;

alter table public.inventory_checkouts add column if not exists cancelled_at timestamptz;
alter table public.inventory_checkouts add column if not exists cancelled_by uuid;

-- ---- 1b) cancel_checkout: the only way to take back a mistaken check-out --------------------
create or replace function public.cancel_checkout(p_id uuid, p_reason text default null)
returns public.inventory_checkouts
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.inventory_checkouts; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.has_area('inventory', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into v_row from public.inventory_checkouts
   where id = p_id and org_id = public.current_org_id() for update;
  if not found then raise exception 'checkout not found' using errcode = '42501'; end if;
  if v_row.status = 'cancelled' then return v_row; end if;              -- idempotent
  if v_row.status <> 'out' or coalesce(v_row.qty_in, 0) > 0 or v_row.checked_in_at is not null then
    raise exception 'This check-out already has items returned - check it in instead of cancelling it.'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and length(v_reason) > 500 then v_reason := left(v_reason, 500); end if;
  update public.inventory_checkouts
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         note = case when v_reason is null then note
                     else concat_ws(' | ', nullif(btrim(coalesce(note, '')), ''), 'Cancelled: ' || v_reason) end
   where id = p_id and org_id = public.current_org_id()
   returning * into v_row;
  return v_row;                                                           -- audit_trg logs the UPDATE
end $$;
revoke all on function public.cancel_checkout(uuid, text) from public, anon;
grant execute on function public.cancel_checkout(uuid, text) to authenticated;

-- ---- 1c) no hard delete of check-out rows from the API -------------------------------------
drop policy if exists "ra del" on public.inventory_checkouts;
revoke delete on public.inventory_checkouts from anon, authenticated;

-- ---- 2a) checkout_equipment: only out / partial rows count as out (0072 body otherwise) ------
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
    from public.inventory_checkouts where item_id = p_item and status in ('out','partial');
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

-- ---- 2b) check-in refuses a cancelled row (0072 bodies otherwise) ---------------------------
create or replace function public.checkin_equipment(p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean default false)
 returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_missing numeric; v_new_wo numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id and org_id = public.current_org_id() for update;
  if not found then raise exception 'checkout not found'; end if;
  if row.status = 'cancelled' then raise exception 'This check-out was cancelled - nothing to check in.'; end if;
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
  if row.status = 'cancelled' then raise exception 'This check-out was cancelled - nothing to check in.'; end if;
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

-- ---- 3) duplicate active names: partial unique indexes, only when the data is already clean ---
do $$
declare v_n bigint;
begin
  if to_regclass('public.inventory_items_org_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.inventory_items where active
      group by org_id, lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index inventory_items_org_name_uidx on public.inventory_items (org_id, lower(btrim(name))) where active';
    else
      raise notice '0073: inventory_items_org_name_uidx SKIPPED - % duplicate active name group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;

  if to_regclass('public.vendors_org_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.vendors where active
      group by org_id, lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index vendors_org_name_uidx on public.vendors (org_id, lower(btrim(name))) where active';
    else
      raise notice '0073: vendors_org_name_uidx SKIPPED - % duplicate active name group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;

  if to_regclass('public.dish_catalog_org_cat_name_uidx') is null then
    select count(*) into v_n from (select 1 from public.dish_catalog where active
      group by org_id, lower(btrim(category)), lower(btrim(name)) having count(*) > 1) d;
    if v_n = 0 then
      execute 'create unique index dish_catalog_org_cat_name_uidx on public.dish_catalog (org_id, lower(btrim(category)), lower(btrim(name))) where active';
    else
      raise notice '0073: dish_catalog_org_cat_name_uidx SKIPPED - % duplicate active dish group(s); rename or deactivate the extras in the app, then re-run 0073', v_n;
    end if;
  end if;
end $$;

-- =====================================================================================
-- VERIFY (expect 16 rows, ALL ok = true)
-- =====================================================================================


-- ===================== APPLY-0074 =====================
-- APPLY-0074.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0074_chat_admin_fixes.sql verbatim. REQUIRES 0072 (and 0016,
-- 0021, 0025). Independent of 0073 / 0075.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: CREATE OR REPLACE FUNCTION, new chat_prefs table (IF NOT EXISTS), policies and
-- triggers dropped/recreated by name. No row is updated or deleted.
-- EXPECTED: the last result grid (item, ok) has 9 rows and EVERY ok = true.

-- =====================================================================================
-- PRE-CHECKS (read-only, INFORMATIONAL ONLY - nothing is changed)
-- =====================================================================================
-- PRE-CHECK A: studios with NO admin today (the new guard keeps the last admin; it can not add one).
select 'A studio without admin' as precheck, o.id, o.name
  from public.organizations o
 where not exists (select 1 from public.profiles p where p.org_id = o.id and p.role = 'admin');

-- PRE-CHECK B: existing chat messages whose media key points at another conversation. Left as
-- they are (only NEW / changed media is checked); they simply do not load for that chat.
select 'B cross-chat media' as precheck, count(*) as n
  from public.chat_messages m
 where m.media_path ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/'
   and lower(split_part(m.media_path, '/', 1) || '/' || split_part(m.media_path, '/', 2))
       <> m.org_id::text || '/' || m.conversation_id::text;

-- =====================================================================================
-- 0074 (verbatim)
-- =====================================================================================
-- 0074_chat_admin_fixes.sql - CANONICAL forward-only. Additive + idempotent: CREATE OR REPLACE,
-- new table guarded by IF NOT EXISTS, DROP/CREATE of policies and triggers by name. No row is updated or
-- deleted. REQUIRES 0016 (chat), 0021 (profiles guard), 0025 (invitations guard), 0072.
--
-- In plain words:
--   1  Invitations: the 0025 guard (a direct UPDATE may only set status -> 'revoked') is
--      re-asserted, and only a PENDING invitation can be revoked directly. anon loses every
--      table grant on invitations (RLS already refused it). Verified: a manager with Users edit
--      could NOT change an invitation's role before this migration either (42501 from the guard).
--   2  The last admin of a studio can never lose the admin role, whatever the path
--      (admin_set_role, accept_invitation, any future RPC): a profiles trigger refuses it.
--   3  chat_prefs: per-user pinned / muted / favourite per conversation (was browser-only).
--      Own rows only (RLS); written through chat_set_pref, which checks conversation access.
--   4  Chat media stays scoped to its conversation: a new message may only carry a media key
--      under <its org>/<its conversation>/ - so a forwarded photo / voice note must be COPIED
--      into the target conversation (Storage copy, checked by the chat-media policies).

-- ---- 1) invitations ---------------------------------------------------------------------
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
drop trigger if exists invitations_api_guard_biu on public.invitations;
create trigger invitations_api_guard_biu before insert or update on public.invitations
  for each row execute function public.invitations_api_guard();
revoke all on public.invitations from anon;
revoke insert on public.invitations from authenticated;
drop policy if exists "a74 inv upd pending only" on public.invitations;
create policy "a74 inv upd pending only" on public.invitations as restrictive for update to authenticated
  using (status = 'pending' and public.has_area('users', 'edit'))
  with check (status in ('pending', 'revoked'));

-- ---- 2) last admin protected ------------------------------------------------------------
create or replace function public.profiles_last_admin_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.role = 'admin' and old.org_id is not null
     and new.org_id is not distinct from old.org_id
     and new.role is distinct from 'admin' then
    perform 1 from public.profiles p where p.org_id = old.org_id and p.role = 'admin' for update;
    if not exists (select 1 from public.profiles p
                    where p.org_id = old.org_id and p.role = 'admin' and p.id <> old.id) then
      raise exception 'a studio must keep at least one admin - make someone else admin first'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.profiles_last_admin_guard() from public, anon, authenticated;
drop trigger if exists profiles_last_admin_guard_bu on public.profiles;
create trigger profiles_last_admin_guard_bu before update of role on public.profiles
  for each row execute function public.profiles_last_admin_guard();

-- ---- 3) chat_prefs ------------------------------------------------------------------------
create table if not exists public.chat_prefs (
  user_id         uuid not null default auth.uid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  pinned          boolean not null default false,
  muted           boolean not null default false,
  favourite       boolean not null default false,
  updated_at      timestamptz not null default now(),
  primary key (user_id, conversation_id)
);
alter table public.chat_prefs enable row level security;
revoke all on public.chat_prefs from anon, public;
revoke insert, update, delete on public.chat_prefs from authenticated;
grant select on public.chat_prefs to authenticated;
drop policy if exists chat_prefs_own_read on public.chat_prefs;
create policy chat_prefs_own_read on public.chat_prefs for select to authenticated
  using (user_id = auth.uid());

-- null = leave that flag as it is
create or replace function public.chat_set_pref(p_conversation uuid, p_pinned boolean default null,
                                                p_muted boolean default null, p_favourite boolean default null)
returns public.chat_prefs language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.chat_prefs;
begin
  if v_uid is null or p_conversation is null or not public.chat_can_see(p_conversation) then
    raise exception 'not authorized for this conversation' using errcode = '42501';
  end if;
  insert into public.chat_prefs as cp (user_id, conversation_id, pinned, muted, favourite, updated_at)
  values (v_uid, p_conversation, coalesce(p_pinned, false), coalesce(p_muted, false), coalesce(p_favourite, false), now())
  on conflict (user_id, conversation_id) do update
     set pinned    = coalesce(p_pinned, cp.pinned),
         muted     = coalesce(p_muted, cp.muted),
         favourite = coalesce(p_favourite, cp.favourite),
         updated_at = now()
  returning * into r;
  return r;
end $$;
revoke all on function public.chat_set_pref(uuid, boolean, boolean, boolean) from public, anon;
grant execute on function public.chat_set_pref(uuid, boolean, boolean, boolean) to authenticated;

-- ---- 4) chat media scoped to its conversation (new rows only) ---------------------------
create or replace function public.chat_messages_media_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- a malformed key is left to chat_messages_media_path_chk (same error as before)
  if new.media_path is not null
     and new.media_path ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/'
     and (tg_op = 'INSERT' or new.media_path is distinct from old.media_path)
     and lower(split_part(new.media_path, '/', 1) || '/' || split_part(new.media_path, '/', 2))
         is distinct from new.org_id::text || '/' || new.conversation_id::text then
    raise exception 'this attachment belongs to another conversation' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.chat_messages_media_scope() from public, anon, authenticated;
drop trigger if exists chat_messages_media_scope_biu on public.chat_messages;
create trigger chat_messages_media_scope_biu before insert or update of media_path on public.chat_messages
  for each row execute function public.chat_messages_media_scope();

-- ---- VERIFY (read-only) -------------------------------------------------------------------
-- select tgname from pg_trigger where tgname in ('invitations_api_guard_biu','profiles_last_admin_guard_bu','chat_messages_media_scope_biu');
-- select to_regclass('public.chat_prefs'), has_function_privilege('authenticated','public.chat_set_pref(uuid,boolean,boolean,boolean)','EXECUTE');

-- =====================================================================================
-- VERIFY - every row must say ok = true
-- =====================================================================================


-- ===================== APPLY-0075 =====================
-- APPLY-0075.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- REQUIRES 0072 (APPLY-0071-0072.sql) to be applied first.
-- Contents = supabase/migrations/0075_ui_fixes.sql verbatim.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: ADD COLUMN IF NOT EXISTS (default false), CREATE OR REPLACE FUNCTION, a guarded
-- one-time rename of public_get_booklet to public_get_booklet__pre0075, one trigger. No row is
-- updated or deleted.
-- AFTER APPLYING: existing studios' business e-mail is hidden from client booklets until an admin
-- re-saves Control Center > Studio details once (that save marks it confirmed). This is on purpose:
-- older rows cannot tell a signup-seeded login e-mail from one the admin typed.
-- EXPECTED: the last result grid (item, ok) has 12 rows and EVERY ok = true.

-- =====================================================================================
-- PRE-CHECK (read-only, INFORMATIONAL ONLY): studios whose business e-mail will stop showing
-- in client booklets until an admin re-saves Studio details.
-- =====================================================================================
select 'business email hidden until re-saved' as precheck, o.id, o.name
  from public.organizations o
 where nullif(btrim(coalesce(o.business_email, '')), '') is not null;

-- =====================================================================================
-- CHANGES (0075)
-- =====================================================================================
-- 0075_ui_fixes.sql - CANONICAL forward-only. UI fix pass (L8 blank-quote reuse, #16 booklet
-- studio contact). REQUIRES 0072 (create_quote with F10 gate + advisory-locked codes) and
-- 0070 (public_get_booklet wrapper: sections filter, snapshots, menu.mode, payments helper).
--
-- In plain words:
--   1) start_blank_quote(code, title): the dashboard "Generate a quote" button used to make a
--      brand-new empty quote on every click. Now it hands back YOUR most recent untouched
--      blank quote in this studio, and only creates one when there is none. "Untouched" =
--      no client name, no event date, still version 1 with zero layout items, no payments,
--      milestones, consents or approval, status still 'quote', not archived or deleted,
--      version 1 saved by you, created less than 7 days ago. Same gates as create_quote
--      (quotes edit + can_create, F10). A per-user advisory lock stops two tabs creating two.
--      Nothing is ever deleted.
--   2) organizations.business_email_confirmed (new, default false): signup used to copy the
--      owner's login e-mail into business_email, and the client booklet showed it. Now the
--      booklet shows the studio e-mail ONLY when an admin saved it in Control Center >
--      Studio details (the app sends business_email_confirmed = true on that save). New
--      studios and server-side changes never count as confirmed; clearing the e-mail clears it.
--   3) public_get_booklet is wrapped ONCE (old body kept as public_get_booklet__pre0075):
--      same output as 0070 except studio.email is removed unless confirmed. Venue, sections,
--      snapshots, menu.mode, payments - unchanged.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, guarded rename.
-- No rows are deleted or rewritten.

do $$ begin
  if to_regprocedure('public.create_quote(text, text, text, jsonb, integer, date)') is null then
    raise exception '0075: create_quote (0072) is not installed'; end if;
  if to_regprocedure('public.public_get_booklet(uuid)') is null then
    raise exception '0075: public_get_booklet (0065/0070) is not installed'; end if;
  if to_regprocedure('public._bk_payments(uuid, uuid, jsonb)') is null then
    raise exception '0075: 0070 (_bk_payments) is not installed'; end if;
end $$;

-- ---- 1) L8: reuse the caller's untouched blank quote -------------------------------------
create or replace function public.start_blank_quote(p_code text, p_title text default null)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
-- ui-fixes-0075 (L8)
declare v_org uuid; v_uid uuid; q public.quotes;
begin
  v_uid := auth.uid(); v_org := public.current_org_id();
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;  -- F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:blankq:' || v_org::text || ':' || v_uid::text, 0));
  select x.* into q from public.quotes x
   where x.org_id = v_org
     and x.deleted_at is null and x.archived_at is null
     and x.created_at > now() - interval '7 days'
     and coalesce(btrim(x.client ->> 'name'), '') = ''
     and x.event_date is null
     and x.current_version = 1
     and coalesce(x.status, 'quote') = 'quote'
     and coalesce(x.approval_status, 'none') = 'none'
     and x.confirmed_at is null and x.approval_token is null
     and exists (select 1 from public.quote_versions v
                  where v.quote_id = x.id and v.version_no = 1 and v.created_by = v_uid
                    and coalesce(v.object_count, 0) = 0
                    and (case when jsonb_typeof(v.data -> 'items') = 'array' then jsonb_array_length(v.data -> 'items') else 0 end) = 0)
     and not exists (select 1 from public.quote_versions v where v.quote_id = x.id and v.version_no <> 1)
     and not exists (select 1 from public.quote_payments p where p.quote_id = x.id)
     and not exists (select 1 from public.payment_milestones m where m.quote_id = x.id)
     and not exists (select 1 from public.quote_consents c where c.quote_id = x.id)
   order by x.created_at desc, x.id desc
   limit 1
   for update of x;
  if q.id is not null then return q; end if;
  return public.create_quote(p_code, coalesce(p_title, p_code), null, '{"items":[]}'::jsonb, 0, null);
end $$;
revoke all on function public.start_blank_quote(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.start_blank_quote(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.start_blank_quote(text, text) to authenticated'; end if;
end $$;

-- ---- 2) #16: business e-mail shown to clients only once an admin saved it ------------------
alter table public.organizations add column if not exists business_email_confirmed boolean not null default false;

create or replace function public.tg_org_bizmail_confirm()
returns trigger language plpgsql set search_path = '' as $$
-- ui-fixes-0075 (#16)
begin
  if tg_op = 'INSERT' then
    new.business_email_confirmed := false;              -- signup seeding never counts
  elsif nullif(btrim(coalesce(new.business_email, '')), '') is null then
    new.business_email_confirmed := false;              -- no e-mail, nothing to confirm
  elsif current_user not in ('anon', 'authenticated')
        and new.business_email is distinct from old.business_email then
    new.business_email_confirmed := false;              -- server-side change: not an admin save
  end if;
  return new;
end $$;
revoke all on function public.tg_org_bizmail_confirm() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.tg_org_bizmail_confirm() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.tg_org_bizmail_confirm() from authenticated'; end if;
end $$;
drop trigger if exists bec75_bizmail_confirm on public.organizations;
create trigger bec75_bizmail_confirm before insert or update on public.organizations
  for each row execute function public.tg_org_bizmail_confirm();

-- ---- 3) booklet: studio e-mail only when confirmed ----------------------------------------
do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0075(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0075;
  end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- ui-fixes-0075: the 0070 reader, then studio.email only when the admin confirmed it
declare r jsonb; v_ok boolean;
begin
  r := public.public_get_booklet__pre0075(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r -> 'studio') <> 'object' then return r; end if;
  select coalesce(o.business_email_confirmed, false) into v_ok
    from public.client_booklets b join public.organizations o on o.id = b.org_id
   where b.token = p_token;
  if not coalesce(v_ok, false) then r := jsonb_set(r, '{studio}', (r -> 'studio') - 'email'); end if;
  return r;
end $$;

do $$ declare s text; begin
  foreach s in array array['public.public_get_booklet__pre0075(uuid)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.public_get_booklet__pre0075(uuid) to service_role;
  end if;
end $$;

-- =====================================================================================
-- VERIFY (expect 12 rows, ALL ok = true)
-- =====================================================================================


-- ===================== COMBINED VERIFY (every row should be true) =====================
select '0073 ' || item as item, ok from (values
  ('01 checkouts status check allows cancelled', (coalesce((select pg_get_constraintdef(c.oid) like '%cancelled%' from pg_constraint c where c.conname = 'inventory_checkouts_status_check' and c.conrelid = 'public.inventory_checkouts'::regclass), false))),
  ('02 cancelled_at + cancelled_by columns', ((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name in ('cancelled_at','cancelled_by')) = 2)),
  ('03 cancel_checkout security definer + search_path empty', (coalesce((select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_checkout'), false))),
  ('04 cancel_checkout gated by inventory edit + org', (coalesce((select bool_and(p.prosrc like '%has_area(''inventory'', ''edit'')%' and p.prosrc like '%current_org_id()%') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_checkout'), false))),
  ('05 cancel_checkout authenticated can execute', (coalesce((select bool_and(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_checkout'), false))),
  ('06 cancel_checkout anon can NOT execute', (coalesce((select not bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cancel_checkout'), false))),
  ('07 no permissive delete policy on inventory_checkouts', (not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'inventory_checkouts' and permissive = 'PERMISSIVE' and cmd in ('DELETE','ALL')))),
  ('08 authenticated has no DELETE on inventory_checkouts', (not has_table_privilege('authenticated', 'public.inventory_checkouts', 'delete'))),
  ('09 anon has no DELETE on inventory_checkouts', (not has_table_privilege('anon', 'public.inventory_checkouts', 'delete'))),
  ('10 checkout_equipment counts only out/partial', (coalesce((select bool_and(p.prosrc like '%status in (''out'',''partial'')%' and p.prosrc like '%for update%') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'checkout_equipment'), false))),
  ('11 reserve_inventory counts only out/partial', (coalesce((select bool_and(p.prosrc like '%c.status in (''out'',''partial'')%') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'reserve_inventory'), false))),
  ('12 checkin_equipment refuses cancelled + keeps cap', (coalesce((select bool_and(p.prosrc like '%was cancelled%' and p.prosrc like '%written_off%' and p.prosrc like '%cannot exceed quantity issued%') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'checkin_equipment'), false))),
  ('13 worker_checkin_equipment refuses cancelled, anon (crew link) kept', (coalesce((select bool_and(p.prosrc like '%was cancelled%' and p.prosrc like '%for update%' and has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'worker_checkin_equipment'), false))),
  ('14 inventory_items active-name unique index', (to_regclass('public.inventory_items_org_name_uidx') is not null)),
  ('15 vendors active-name unique index', (to_regclass('public.vendors_org_name_uidx') is not null)),
  ('16 dish_catalog active category+name unique index', (to_regclass('public.dish_catalog_org_cat_name_uidx') is not null))
) v(item, ok)
union all
select '0074 ' || item as item, ok from (values
  ('invitations guard trigger',
     exists (select 1 from pg_trigger where tgname = 'invitations_api_guard_biu' and tgrelid = 'public.invitations'::regclass)),
  ('invitations: update only pending (restrictive)',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'invitations'
               and policyname = 'a74 inv upd pending only' and permissive = 'RESTRICTIVE')),
  ('invitations: anon has no table access',
     not has_table_privilege('anon', 'public.invitations', 'select')
     and not has_table_privilege('anon', 'public.invitations', 'update')),
  ('last admin guard trigger',
     exists (select 1 from pg_trigger where tgname = 'profiles_last_admin_guard_bu' and tgrelid = 'public.profiles'::regclass)),
  ('chat_prefs exists with RLS',
     exists (select 1 from pg_class where oid = 'public.chat_prefs'::regclass and relrowsecurity)),
  ('chat_prefs: clients read only',
     has_table_privilege('authenticated', 'public.chat_prefs', 'select')
     and not has_table_privilege('authenticated', 'public.chat_prefs', 'insert')
     and not has_table_privilege('anon', 'public.chat_prefs', 'select')),
  ('chat_set_pref callable by authenticated only',
     has_function_privilege('authenticated', 'public.chat_set_pref(uuid,boolean,boolean,boolean)', 'execute')
     and not has_function_privilege('anon', 'public.chat_set_pref(uuid,boolean,boolean,boolean)', 'execute')),
  ('chat media scope trigger',
     exists (select 1 from pg_trigger where tgname = 'chat_messages_media_scope_biu' and tgrelid = 'public.chat_messages'::regclass)),
  ('guard functions not callable by clients',
     not has_function_privilege('authenticated', 'public.profiles_last_admin_guard()', 'execute')
     and not has_function_privilege('authenticated', 'public.chat_messages_media_scope()', 'execute'))
) v(item, ok)
union all
select '0075 ' || item as item, ok from (values
  ('01 start_blank_quote exists', (to_regprocedure('public.start_blank_quote(text, text)') is not null)),
  ('02 start_blank_quote security definer + search_path empty', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.start_blank_quote(text, text)')), false))),
  ('03 start_blank_quote keeps quotes-edit gate (F10) + can_create', (coalesce((select p.prosrc like '%has_area(''quotes'', ''edit'')%' and p.prosrc like '%can_create()%' from pg_proc p where p.oid = to_regprocedure('public.start_blank_quote(text, text)')), false))),
  ('04 start_blank_quote per-user advisory lock', (coalesce((select p.prosrc like '%helm:blankq:%' from pg_proc p where p.oid = to_regprocedure('public.start_blank_quote(text, text)')), false))),
  ('05 start_blank_quote authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.start_blank_quote(text, text)', 'execute') and not has_function_privilege('anon', 'public.start_blank_quote(text, text)', 'execute'), false))),
  ('06 organizations.business_email_confirmed boolean not null default false', (exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'business_email_confirmed' and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'))),
  ('07 confirm trigger installed', (exists (select 1 from pg_trigger t where t.tgrelid = 'public.organizations'::regclass and t.tgname = 'bec75_bizmail_confirm' and not t.tgisinternal))),
  ('08 public_get_booklet__pre0075 kept (0070 body)', (coalesce((select p.prosrc like '%booklet-payments-0070%' from pg_proc p where p.oid = to_regprocedure('public.public_get_booklet__pre0075(uuid)')), false))),
  ('09 public_get_booklet wrapper hides unconfirmed e-mail', (coalesce((select p.prosrc like '%ui-fixes-0075%' and p.prosrc like '%business_email_confirmed%' and p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.public_get_booklet(uuid)')), false))),
  ('10 public_get_booklet still callable by anon + authenticated', (coalesce(has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute') and has_function_privilege('authenticated', 'public.public_get_booklet(uuid)', 'execute'), false))),
  ('11 __pre0075 NOT callable by anon / authenticated', (coalesce(not has_function_privilege('anon', 'public.public_get_booklet__pre0075(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.public_get_booklet__pre0075(uuid)', 'execute'), false))),
  ('12 booklet chain intact (__pre0075 -> __pre0069 -> 0065 reader)', (coalesce((select p.prosrc like '%public_get_booklet__pre0069(p_token)%' from pg_proc p where p.oid = to_regprocedure('public.public_get_booklet__pre0075(uuid)')), false) and to_regprocedure('public.public_get_booklet__pre0069(uuid)') is not null))
) v(item, ok)
order by 1;
