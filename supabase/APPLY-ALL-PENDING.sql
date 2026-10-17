-- APPLY-ALL-PENDING = 0136 + 0137 + 0138 + 0139 + 0140 + 0141 + 0142 (helm-v01 dev pass 3: business currency, change-order tax in P&L, title length guard).
-- APPLY 0136 + 0137 + 0138 + 0139 + 0140 + 0141 + 0142 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
-- Idempotent: safe to run twice. ASCII only. Additive only: 0139/0140 add nullable columns + functions/triggers; 0138 rewrites demo sample staff phones only; 0141 SOFT-archives empty old drafts (never deletes); 0142 replaces two function bodies and adds a title-length trigger. Nothing is deleted.
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

-- ===== migrations/0139_crm_restore_lead.sql =====
-- 0139_crm_restore_lead.sql - CANONICAL forward-only. REQUIRES 0122 (archive_lead with org_id),
-- 0125 (lead audit trigger), phase29 (has_area).
--
-- In plain words:
--   When a lead is deleted, the delete dialog promises "It stays in the CRM archive". This adds a
--   one-click Restore for those archived "deleted" rows. restore_archived_lead(archive_id):
--     * only works on a "deleted" archive row of the signed-in user's OWN studio (current_org_id());
--     * only for people allowed to edit leads (has_area('leads','edit'));
--     * refuses if a live lead with the same id already exists (nothing is overwritten);
--     * refuses if that archive row was already restored;
--     * re-creates the lead from the saved snapshot with its original id, in the same studio
--       (a quote or owner that no longer exists is left blank rather than failing);
--     * marks the archive row restored (restored_at / restored_by). The archive row is NEVER deleted;
--     * writes an audit_log row "lead.restored".
--   Additive only: two nullable columns on lead_archive and one function. No row is deleted or changed
--   except the stamp on the archive row being restored.
-- Idempotent: "add column if not exists" + "create or replace function"; re-running changes nothing.

alter table public.lead_archive add column if not exists restored_at timestamptz;
alter table public.lead_archive add column if not exists restored_by uuid;

create or replace function public.restore_archived_lead(p_archive_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid := public.current_org_id();
  v_arc  public.lead_archive;
  v_lead public.leads;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'Sign in to a studio first.' using errcode = '42501';
  end if;
  if not public.has_area('leads', 'edit') then
    raise exception 'You do not have permission to restore leads.' using errcode = '42501';
  end if;

  -- lock the archive row so two clicks cannot restore it twice
  select * into v_arc from public.lead_archive a
   where a.id = p_archive_id and a.org_id = v_org
   for update;
  if not found then
    raise exception 'Archive record not found.' using errcode = 'P0002';
  end if;
  if v_arc.action <> 'deleted' then
    raise exception 'Only deleted leads can be restored.' using errcode = '22023';
  end if;
  if v_arc.restored_at is not null then
    raise exception 'This lead was already restored.' using errcode = '23505';
  end if;
  if v_arc.lead_id is null or v_arc.snapshot is null then
    raise exception 'This archive record has no saved lead to restore.' using errcode = '22023';
  end if;
  if exists (select 1 from public.leads l where l.id = v_arc.lead_id) then
    raise exception 'A live lead with this id already exists - nothing was changed.' using errcode = '23505';
  end if;

  -- rebuild the row from the snapshot (keeps every saved column, including ones added later)
  v_lead := jsonb_populate_record(null::public.leads, v_arc.snapshot);
  v_lead.id         := v_arc.lead_id;
  v_lead.org_id     := v_org;                               -- always the caller's studio
  v_lead.name       := coalesce(nullif(btrim(v_lead.name), ''), v_arc.name, 'Restored lead');
  v_lead.status     := coalesce(v_lead.status, v_arc.status, 'new');
  v_lead.created_at := coalesce(v_lead.created_at, now());
  v_lead.updated_at := now();
  if v_lead.quote_id is not null and not exists
       (select 1 from public.quotes q where q.id = v_lead.quote_id and q.org_id = v_org) then
    v_lead.quote_id := null;
  end if;
  if v_lead.owner is not null and not exists (select 1 from auth.users u where u.id = v_lead.owner) then
    v_lead.owner := null;
  end if;

  insert into public.leads select (v_lead).*;

  update public.lead_archive
     set restored_at = now(), restored_by = auth.uid()
   where id = v_arc.id;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
  select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'lead.restored',
         'leads', v_arc.lead_id::text,
         jsonb_build_object('archive_id', v_arc.id, 'name', v_lead.name), v_org, now();

  return jsonb_build_object('result', 'restored', 'lead_id', v_arc.lead_id);
end $$;

revoke all on function public.restore_archived_lead(uuid) from public, anon;
grant execute on function public.restore_archived_lead(uuid) to authenticated;

-- ===== migrations/0140_lead_dates_to_nurture.sql =====
-- 0140_lead_dates_to_nurture.sql - CANONICAL forward-only. REQUIRES 0105 (leads.birthday / leads.anniversary),
-- phase30 (nurture.occasion_type), 0084 (_a84_phone_ok).
--
-- In plain words:
--   A lead's Birthday / Anniversary now flows into Nurture by itself (no typing it twice).
--   * nurture gets two new nullable columns: source ('lead' for rows made by this sync, null = typed by hand)
--     and lead_id (which lead it came from). Existing rows are untouched (source stays null = manual).
--   * Saving a lead with a birthday/anniversary creates ONE nurture occasion per lead + type, or updates
--     that same row (name, phone, email, date) - never a duplicate (unique index + upsert).
--   * Clearing the date removes ONLY the row this sync created (source = 'lead'), and only if nobody
--     has worked on it (no note, still active, never greeted). If someone did, the row is kept and
--     handed over as a manual row (source -> null), so no follow-up history is ever lost.
--   * Hand-made nurture rows (source null) are never read, changed or deleted by this sync.
--   * Deleting a lead leaves its nurture rows alone (the CRM archive can restore the lead).
--   * The sync is best-effort: if it ever fails, the lead still saves (warning only).
--   * One-time backfill: leads that already have dates get their occasion (idempotent, insert-only).
-- Idempotent: safe to run twice.

alter table public.nurture add column if not exists source text;
alter table public.nurture add column if not exists lead_id uuid;

create unique index if not exists nurture_lead_occ_uidx
  on public.nurture (org_id, lead_id, occasion_type) where source = 'lead';

create or replace function public._n140_sync_one(p_lead public.leads, p_type text, p_date date)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_phone text; v_label text;
begin
  v_label := case p_type when 'birthday' then 'Birthday' else 'Anniversary' end;
  if p_date is null then
    -- untouched auto row -> remove; worked-on auto row -> keep as a manual row
    delete from public.nurture n
     where n.source = 'lead' and n.org_id = p_lead.org_id and n.lead_id = p_lead.id and n.occasion_type = p_type
       and n.note is null and n.status = 'active' and n.last_greeted is null;
    update public.nurture n set source = null
     where n.source = 'lead' and n.org_id = p_lead.org_id and n.lead_id = p_lead.id and n.occasion_type = p_type;
    return;
  end if;
  v_phone := case when p_lead.phone is not null and public._a84_phone_ok(p_lead.phone) then p_lead.phone end;
  insert into public.nurture (org_id, name, phone, email, occasion, occasion_type, occasion_date, next_followup,
                              status, quote_id, source, lead_id)
  values (p_lead.org_id, p_lead.name, v_phone, p_lead.email, v_label, p_type, p_date,
          public._next_occasion(p_date), 'active', p_lead.quote_id, 'lead', p_lead.id)
  on conflict (org_id, lead_id, occasion_type) where source = 'lead' do update
     set name = excluded.name,
         phone = coalesce(excluded.phone, public.nurture.phone),
         email = excluded.email,
         occasion_date = excluded.occasion_date,
         next_followup = case when public.nurture.occasion_date is distinct from excluded.occasion_date
                              then excluded.next_followup else public.nurture.next_followup end;
end $$;
revoke all on function public._n140_sync_one(public.leads, text, date) from public, anon, authenticated;

create or replace function public._n140_tg_lead_dates()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if TG_OP = 'UPDATE'
     and new.birthday is not distinct from old.birthday and new.anniversary is not distinct from old.anniversary
     and new.name is not distinct from old.name and new.phone is not distinct from old.phone
     and new.email is not distinct from old.email then
    return new;
  end if;
  begin
    if TG_OP = 'INSERT' then
      if new.birthday is not null then perform public._n140_sync_one(new, 'birthday', new.birthday); end if;
      if new.anniversary is not null then perform public._n140_sync_one(new, 'anniversary', new.anniversary); end if;
    else
      if new.birthday is not null or old.birthday is not null then perform public._n140_sync_one(new, 'birthday', new.birthday); end if;
      if new.anniversary is not null or old.anniversary is not null then perform public._n140_sync_one(new, 'anniversary', new.anniversary); end if;
    end if;
  exception when others then
    raise warning 'lead -> nurture date sync skipped for lead %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public._n140_tg_lead_dates() from public, anon, authenticated;

drop trigger if exists zz_n140_lead_dates on public.leads;
create trigger zz_n140_lead_dates after insert or update on public.leads
  for each row execute function public._n140_tg_lead_dates();

-- one-time backfill (insert-only; existing rows never changed)
insert into public.nurture (org_id, name, phone, email, occasion, occasion_type, occasion_date, next_followup,
                            status, quote_id, source, lead_id)
select l.org_id, l.name,
       case when l.phone is not null and public._a84_phone_ok(l.phone) then l.phone end,
       l.email, v.label, v.t, v.d, public._next_occasion(v.d), 'active', l.quote_id, 'lead', l.id
  from public.leads l
  cross join lateral (values ('birthday', 'Birthday', l.birthday), ('anniversary', 'Anniversary', l.anniversary)) v(t, label, d)
 where v.d is not null and l.org_id is not null
on conflict (org_id, lead_id, occasion_type) where source = 'lead' do nothing;

notify pgrst, 'reload schema';

-- ===== migrations/0141_empty_draft_cleanup.sql =====
-- 0141_empty_draft_cleanup.sql - CANONICAL forward-only. REQUIRES 0040 (quote Archive / Deleted
-- shelves: quotes.deleted_at / deleted_reason / shelf_restored_at, restore_quote_from_shelf) and
-- 0075 (start_blank_quote).
--
-- In plain words:
--   Clicking "Generate a quote" and walking away leaves empty draft quotes behind. This
--   tidies them away SAFELY:
--     * NOTHING IS EVER DELETED. A qualifying draft is only moved to the existing
--       "Deleted quotes" shelf (soft flag deleted_at, reason 'auto_empty_draft') and stamped
--       auto_discarded_at. Quotes > Deleted > "Show discarded drafts" lists them and the
--       existing one-click Restore (restore_quote_from_shelf) puts them back.
--     * A draft is touched only when EVERY check passes, and the checks run TWICE: once to
--       pick candidates, then again on the row-locked quote inside the UPDATE's WHERE.
--       Any single filled field / any related row => the draft is left alone.
--     * A draft someone restored (shelf_restored_at set) is never auto-discarded again.
--
--   "Empty" (public._empty_draft_reason returns NULL only when ALL hold):
--     status 'quote' (not sent: approval_status 'none', no approval token, not confirmed),
--     not already archived/deleted, created > 24h ago AND updated > 24h ago,
--     title blank / 'Untitled event' / equal to the quote code (start_blank_quote default),
--     no event type, no event date, no event time, no client name/email/phone (client and
--     pricing.client), consent not stale,
--     pricing has no non-empty value except plain tax/currency settings (so total, subtotal,
--     guests, items, packages, discounts must all be null/0/empty),
--     current_version = 1, at most ONE quote_versions row and it has zero items/objects,
--     and ZERO rows in every other table that references the quote.
--
--   Tables that reference quotes (repo scan of every quote_id column / FK, 2026-10-16):
--     assign_notify_outbox change_requests chat_conversations client_booklet_images
--     client_booklets client_link_issued client_link_opens comms_outbox design_stages
--     event_attendees event_checklist event_close_overrides event_closure event_costs
--     event_day event_discovery event_files event_guests event_issues event_media
--     event_menu_items event_plan event_proposal event_ratings event_refunds event_reminders
--     event_requirements event_resource_needs event_resources event_sites
--     event_stock_requests event_tasks expense_claims integration_webhook_events
--     inventory_checkouts inventory_reservations lead_archive leads
--     lifecycle_stage_overrides notifications nurture package_selections payment_milestones
--     payment_reconciliation photo_render_usage photo_renders pkg_credits pkg_otps
--     pkg_outbox proposal_risks quotation_versions quote_consents quote_otps quote_payments
--     quote_versions run_sheet_items task_evidence task_evidence_grants vendor_bills
--     work_tokens   (+ audit_log, which is a pure log and is the ONLY table ignored)
--   The function does NOT rely on that list: at run time it reads information_schema /
--   pg_constraint for EVERY public table with a quote_id column or a foreign key to
--   public.quotes, so a table added later is checked automatically. Any table it cannot
--   read makes the draft count as NOT empty (fail closed).
--
-- Entry points:
--   discard_empty_drafts()      app (Quotes page open): caller's studio only (current_org_id),
--                               quotes editors only; at most 200 per call.
--   discard_empty_drafts_all()  service role / pg_cron only (daily); loops studios.
--   pg_cron job 'helm_discard_empty_drafts' (03:17 daily) ONLY if pg_cron is installed.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, guarded cron.
-- No row is deleted; the only rows changed are qualifying empty drafts (soft flag).

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'quotes' and column_name = 'shelf_restored_at') then
    raise exception '0141: 0040 (quote shelves) is not installed'; end if;
  if to_regprocedure('public.restore_quote_from_shelf(uuid)') is null then
    raise exception '0141: restore_quote_from_shelf (0040) is not installed'; end if;
end $$;

alter table public.quotes add column if not exists auto_discarded_at timestamptz;

-- ---- 1) the single source of truth: why is this draft NOT empty? (NULL = empty) --------
create or replace function public._empty_draft_reason(p_quote_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- empty-drafts-0141
declare q public.quotes; t record; v_hit boolean; v_n int; k text; v jsonb;
begin
  select x.* into q from public.quotes x where x.id = p_quote_id;
  if not found then return 'missing'; end if;
  if coalesce(q.status, '') <> 'quote' then return 'status'; end if;
  if coalesce(q.approval_status, 'none') <> 'none' or q.approval_token is not null
     or q.confirmed_at is not null or q.confirmed_by is not null then return 'sent'; end if;
  if coalesce(q.lifecycle_stage, 'quote') <> 'quote' then return 'lifecycle'; end if;
  if q.deleted_at is not null or q.archived_at is not null then return 'shelved'; end if;
  if q.shelf_restored_at is not null or q.auto_discarded_at is not null then return 'restored_before'; end if;
  if q.created_at is null or q.created_at > now() - interval '24 hours' then return 'too_new'; end if;
  if q.updated_at is null or q.updated_at > now() - interval '24 hours' then return 'recently_edited'; end if;
  if not (coalesce(btrim(q.title), '') in ('', 'Untitled event') or btrim(q.title) = btrim(q.code)) then return 'title'; end if;
  if coalesce(btrim(q.event_type), '') <> '' then return 'event_type'; end if;
  if q.event_date is not null or coalesce(btrim(q.event_time), '') <> '' then return 'event_date'; end if;
  if q.manager_id is not null then return 'manager'; end if;
  if coalesce(q.consent_stale, false) then return 'consent'; end if;
  -- (quotes.currency / tax_snapshot are filled by the 0089 trigger on every quote: settings, not content)
  -- client (top level and pricing.client): any non-blank value blocks
  if exists (select 1 from jsonb_each(case when jsonb_typeof(q.client) = 'object' then q.client else '{}'::jsonb end) e
              where not (e.value in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb)
                         or (jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') = ''))) then return 'client'; end if;
  -- pricing: everything must be null / 0 / false / blank / empty, except plain settings
  if jsonb_typeof(q.pricing) = 'object' then
    for k, v in select e.key, e.value from jsonb_each(q.pricing) e loop
      continue when v in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, 'false'::jsonb, '0'::jsonb);
      continue when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric = 0;
      continue when jsonb_typeof(v) = 'string' and btrim(v #>> '{}') in ('', '0');
      continue when k in ('taxCountry', 'taxRegion', 'taxName', 'currency', 'taxRate', 'taxPct', 'taxMode',
                          'gstRate', 'taxInclusive', 'pricesIncludeTax', 'country')
                    and jsonb_typeof(v) in ('string', 'number', 'boolean');
      return 'pricing.' || k;
    end loop;
  elsif q.pricing is not null and q.pricing <> 'null'::jsonb then return 'pricing';
  end if;
  -- versions: only the first, and it is empty
  if coalesce(q.current_version, 1) <> 1 then return 'versions'; end if;
  select count(*) into v_n from public.quote_versions qv where qv.quote_id = q.id;
  if v_n > 1 then return 'versions'; end if;
  if exists (select 1 from public.quote_versions qv where qv.quote_id = q.id
              and (qv.version_no <> 1 or coalesce(qv.object_count, 0) <> 0
                   or (case when jsonb_typeof(qv.data -> 'items') = 'array' then jsonb_array_length(qv.data -> 'items') else 0 end) <> 0
                   or exists (select 1 from jsonb_each(case when jsonb_typeof(qv.data) = 'object' then qv.data else '{}'::jsonb end) d
                               where d.key <> 'items'
                                 and d.value not in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, 'false'::jsonb, '0'::jsonb)))) then
    return 'layout';
  end if;
  -- every other table that points at this quote (found at run time): ANY row blocks
  for t in
    select c.table_name as tbl, c.column_name as col
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
                                       and tb.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'quote_id'
       and c.table_name not in ('quotes', 'quote_versions', 'audit_log')
    union
    select cl.relname::text, a.attname::text
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
     where con.contype = 'f' and con.confrelid = 'public.quotes'::regclass
       and cl.relname not in ('quotes', 'quote_versions', 'audit_log')
  loop
    begin
      execute format('select exists (select 1 from public.%I where %I = $1)', t.tbl, t.col)
        into v_hit using q.id;
    exception when others then
      return 'unreadable:' || t.tbl;          -- fail closed: cannot prove it is empty
    end;
    if v_hit then return 'has:' || t.tbl; end if;
  end loop;
  return null;
end $$;
revoke all on function public._empty_draft_reason(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._empty_draft_reason(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._empty_draft_reason(uuid) from authenticated'; end if;
end $$;

-- ---- 2) one studio: select candidates (check #1), then lock + re-check (check #2) ----
create or replace function public._discard_empty_drafts_for(p_org uuid, p_limit int default 200)
returns int language plpgsql volatile security definer set search_path = '' as $$
-- empty-drafts-0141
declare r record; v_n int := 0;
begin
  if p_org is null then return 0; end if;
  for r in
    select x.id from public.quotes x
     where x.org_id = p_org
       and x.status = 'quote' and coalesce(x.approval_status, 'none') = 'none'
       and x.deleted_at is null and x.archived_at is null
       and x.shelf_restored_at is null and x.auto_discarded_at is null
       and x.created_at < now() - interval '24 hours'
       and x.updated_at < now() - interval '24 hours'
       and x.event_date is null
     order by x.created_at, x.id
     limit greatest(1, least(coalesce(p_limit, 200), 500))
  loop
    continue when public._empty_draft_reason(r.id) is not null;           -- check #1
    perform 1 from public.quotes x where x.id = r.id and x.org_id = p_org for update of x skip locked;
    continue when not found;                                               -- someone is editing it
    update public.quotes q
       set deleted_at = now(), deleted_by = null, deleted_reason = 'auto_empty_draft',
           auto_discarded_at = now()
     where q.id = r.id and q.org_id = p_org
       and q.deleted_at is null and q.archived_at is null
       and public._empty_draft_reason(q.id) is null;                       -- check #2, row locked
    if found then
      v_n := v_n + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
        values (null, null, 'quote.moved_to_deleted', 'quotes', r.id::text, r.id, p_org,
                jsonb_build_object('auto', true, 'reason', 'auto_empty_draft', 'run_by', auth.uid()));
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public._discard_empty_drafts_for(uuid, int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._discard_empty_drafts_for(uuid, int) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._discard_empty_drafts_for(uuid, int) from authenticated'; end if;
end $$;

-- ---- 3) app entry: the caller's studio only ------------------------------------------
create or replace function public.discard_empty_drafts()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- empty-drafts-0141
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('quotes', 'edit') then
    return jsonb_build_object('discarded', 0, 'skipped', true);          -- quietly do nothing
  end if;
  return jsonb_build_object('discarded', public._discard_empty_drafts_for(v_org, 200));
end $$;
revoke all on function public.discard_empty_drafts() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.discard_empty_drafts() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.discard_empty_drafts() to authenticated'; end if;
end $$;

-- ---- 4) service role / cron: every studio --------------------------------------------
create or replace function public.discard_empty_drafts_all()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- empty-drafts-0141
declare o record; v_total int := 0; v_n int;
begin
  for o in select distinct x.org_id from public.quotes x
            where x.status = 'quote' and x.deleted_at is null and x.archived_at is null
              and x.auto_discarded_at is null and x.created_at < now() - interval '24 hours' loop
    begin
      v_n := public._discard_empty_drafts_for(o.org_id, 500);
      v_total := v_total + v_n;
    exception when others then
      raise notice '0141: studio % skipped (%)', o.org_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('discarded', v_total);
end $$;
revoke all on function public.discard_empty_drafts_all() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.discard_empty_drafts_all() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.discard_empty_drafts_all() from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.discard_empty_drafts_all() to service_role'; end if;
end $$;

-- ---- 5) restore keeps working: clear the auto stamp too (restore_quote_from_shelf already
--         clears deleted_at and sets shelf_restored_at, which blocks any future auto-discard)
create or replace function public.tg_quote_auto_discard_restore()
returns trigger language plpgsql set search_path = '' as $$
-- empty-drafts-0141
begin
  if old.deleted_at is not null and new.deleted_at is null and new.auto_discarded_at is not null then
    new.auto_discarded_at := null;
  end if;
  return new;
end $$;
drop trigger if exists zz_quote_auto_discard_restore on public.quotes;
create trigger zz_quote_auto_discard_restore before update of deleted_at on public.quotes
  for each row execute function public.tg_quote_auto_discard_restore();
revoke all on function public.tg_quote_auto_discard_restore() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.tg_quote_auto_discard_restore() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.tg_quote_auto_discard_restore() from authenticated'; end if;
end $$;

-- ---- 6) pg_cron, ONLY if already installed (never created here) ----------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_discard_empty_drafts') then
        perform cron.schedule('helm_discard_empty_drafts', '17 3 * * *', 'select public.discard_empty_drafts_all()');
      end if;
    exception when others then
      raise notice 'pg_cron present but the job could not be scheduled (%); the app runs it on Quotes page open', sqlerrm;
    end;
  end if;
end $$;

-- ---- VERIFY (read-only; see supabase/APPLY-0141.sql for the rollback proof) -----------
-- select count(*) from public.quotes where auto_discarded_at is not null;
-- select q.code, public._empty_draft_reason(q.id) from public.quotes q where q.status = 'quote' limit 50;

-- 0142_money_currency_cotax_lengths.sql - CANONICAL forward-only. REQUIRES 0108, 0124, 0101 (_r101_quote_tax).
--
-- In plain words (helm-v01 dev pass 3):
--   1) Business page showed '-' for Booked / Collected / Outstanding: the studio row said USD while
--      every quote is INR, so dashboard_money put all the money under other_currencies. When the
--      studio has no live quote in its stored currency, dashboard_money now reports in the currency
--      most of its quotes use. organizations.currency itself is NOT changed.
--   2) _vb_event_pnl (event_pnl / business_pnl): the tax share of approved change orders is split out
--      at the quote's own rate (the app now adds GST on top when a change order is entered), so
--      profit is on ex-tax revenue everywhere.
--   3) Run-sheet and checklist (teardown / logistics) titles: a new or CHANGED title longer than
--      500 characters is refused (the app limits it to 200). Existing rows are never re-checked, so
--      nothing already saved can start failing; nothing is deleted.
--   Same function names, signatures, owners and grants. No table or column is created; no row changed.
-- Idempotent: create or replace + drop trigger if exists / create.
-- ============================================================================

-- 1) dashboard_money: dominant quote currency fallback (body otherwise identical to 0108)
create or replace function public.dashboard_money(p_months integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-money-0108 (0142: dominant quote currency fallback)
declare
  v_org uuid := public.current_org_id();
  v_q boolean; v_fin boolean; v_leads boolean;
  v_tz text; v_cur text; v_today date; v_start date;
  v_n integer := least(greatest(coalesce(p_months, 12), 1), 24);
  v_months jsonb; v_totals jsonb; v_other jsonb; v_overdue jsonb; v_pipe jsonb; v_leadc jsonb; v_up jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_q := public.has_area('quotes', 'view');
  v_fin := public.has_area('finance', 'view');
  if not (v_q or v_fin) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_leads := public.has_area('leads', 'view');

  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  -- 0142: organizations.currency can be a stale default (e.g. USD) while every quote is priced in
  -- INR - then every total came back 0 and the real money sat in other_currencies. When the studio
  -- has NO live quote in its stored currency, use the currency most of its quotes are priced in.
  if not exists (select 1 from public.quotes q where q.org_id = v_org and q.deleted_at is null
                   and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur) then
    select x.c into v_cur from (
      select upper(q.currency) as c, count(*) as n from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$'
       group by 1 order by 2 desc, 1 limit 1) x;
    v_cur := coalesce(v_cur, 'INR');
  end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;
  v_start := (date_trunc('month', v_today::timestamp) - make_interval(months => v_n - 1))::date;

  -- one pass over the studio's quotes (quotes_org_idx), ledger + change requests pre-aggregated per quote
  with q as (
    select q.id, q.code, q.title, q.client, q.status, coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.approval_status, 'none') as appr, q.confirmed_at, q.event_date,
           case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null
  ), cr as (
    select c.quote_id, sum(c.price_delta) as d from public.change_requests c
     where c.org_id = v_org and c.status = 'approved' group by c.quote_id
  ), led as (
    select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
     where p.org_id = v_org group by p.quote_id
  ), msp as (
    select m.quote_id, sum(m.amount) filter (where m.status = 'paid') as paid from public.payment_milestones m
     where m.org_id = v_org group by m.quote_id
  ), ev as (
    select q.*, q.base + coalesce(cr.d, 0) as value,
           case when led.quote_id is not null then coalesce(led.paid, 0) else coalesce(msp.paid, 0) end as paid,
           led.quote_id is not null as has_led
      from q left join cr on cr.quote_id = q.id left join led on led.quote_id = q.id left join msp on msp.quote_id = q.id
  )
  select
    case when v_q then jsonb_build_object(
      'currency', v_cur,
      'open',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr <> 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr <> 'sent' and cur = v_cur), 0)),
      'sent',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr = 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr = 'sent' and cur = v_cur), 0)),
      'confirmed', jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage <> 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage <> 'closed' and cur = v_cur), 0)),
      'closed',    jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage = 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage = 'closed' and cur = v_cur), 0)),
      'cancelled', jsonb_build_object('count', count(*) filter (where status = 'cancelled')),
      'total', count(*)) end,
    jsonb_build_object(
      'booked_all', case when v_q or v_fin then coalesce(sum(value) filter (where status = 'confirmed' and cur = v_cur), 0) end,
      'collected_all', case when v_fin then coalesce(sum(paid) filter (where cur = v_cur), 0) end,
      'outstanding', case when v_fin then coalesce(sum(greatest(value - paid, 0)) filter (where status = 'confirmed' and cur = v_cur), 0) end),
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', x.cur, 'booked_all', x.b, 'collected_all', x.c, 'outstanding', x.o) order by x.cur), '[]'::jsonb)
        from (select e2.cur, coalesce(sum(e2.value) filter (where e2.status = 'confirmed'), 0) as b, coalesce(sum(e2.paid), 0) as c,
                     coalesce(sum(greatest(e2.value - e2.paid, 0)) filter (where e2.status = 'confirmed'), 0) as o
                from ev e2 where e2.cur <> v_cur group by e2.cur) x) end,
    case when v_fin then (
      select coalesce(jsonb_agg(o order by (o ->> 'due_date'), (o ->> 'code')), '[]'::jsonb) from (
        select jsonb_build_object('quote_id', z.quote_id, 'milestone_id', z.id, 'code', z.code, 'title', z.title,
                 'client', nullif(btrim(coalesce(z.client ->> 'name', '')), ''), 'label', z.label, 'due_date', z.due_date,
                 'amount', z.amount, 'paid', z.mpaid, 'balance', z.amount - z.mpaid, 'currency', z.cur) as o
          from (
            select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                             when y.mstatus = 'paid' then y.amount else 0 end as mpaid
              from (
                select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, e.code, e.title, e.client, e.cur,
                       e.paid as qpaid, e.has_led,
                       coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                                    rows between unbounded preceding and 1 preceding), 0) as prior_amt
                  from public.payment_milestones m
                  join ev e on e.id = m.quote_id and e.status = 'confirmed'
                 where m.org_id = v_org
              ) y
          ) z
         where z.due_date is not null and z.due_date < v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
         order by z.due_date, z.code
         limit 10) s) end,
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('quote_id', u.id, 'value', u.value, 'paid', u.paid, 'currency', u.cur) order by u.event_date, u.code), '[]'::jsonb)
        from (select e3.id, e3.code, e3.event_date, e3.value, e3.paid, e3.cur from ev e3
               where e3.status = 'confirmed' and e3.event_date between v_today and v_today + 30
               order by e3.event_date, e3.code limit 50) u) end
    into v_pipe, v_totals, v_other, v_overdue, v_up
    from ev;

  -- months: booked by confirmation month (studio currency), collected by ledger paid month
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'),
           'booked', case when v_q or v_fin then coalesce(b.v, 0) end,
           'collected', case when v_fin then coalesce(c.v, 0) end) order by g.m), '[]'::jsonb)
    into v_months
    from generate_series(v_start::timestamp, date_trunc('month', v_today::timestamp), interval '1 month') g(m)
    left join (
      select date_trunc('month', (q.confirmed_at at time zone v_tz))::date as m,
             sum(case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end
                 + coalesce((select sum(c.price_delta) from public.change_requests c
                              where c.quote_id = q.id and c.org_id = v_org and c.status = 'approved'), 0)) as v
        from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed' and q.confirmed_at is not null
         and q.confirmed_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) b on b.m = g.m::date
    left join (
      select date_trunc('month', (p.paid_at at time zone v_tz))::date as m, sum(p.amount) as v
        from public.quote_payments p
        join public.quotes q on q.id = p.quote_id and q.org_id = v_org and q.deleted_at is null
       where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
         and p.paid_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) c on c.m = g.m::date;

  if v_leads then
    select coalesce(jsonb_object_agg(s.st, s.n), '{}'::jsonb) into v_leadc from (
      select coalesce(nullif(btrim(l.status), ''), 'new') as st, count(*) as n
        from public.leads l where l.org_id = v_org group by 1) s;
  end if;

  return jsonb_build_object('currency', v_cur, 'today', v_today, 'months_n', v_n,
    'finance', v_fin, 'months', v_months, 'totals', v_totals, 'other_currencies', v_other,
    'overdue', v_overdue, 'upcoming', v_up, 'pipeline', v_pipe, 'leads', v_leadc);
end $$;

do $$ begin
  execute 'revoke all on function public.dashboard_money(integer) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_money(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_money(integer) to authenticated'; end if;
end $$;

-- 2) _vb_event_pnl: change-order tax split (body otherwise identical to 0124)
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124 (0142: change-order tax split)
declare
  q record; v_base numeric; v_chg_rev numeric; v_chg_cost numeric; v_tax numeric; v_rev numeric;
  v_vendor numeric; v_other numeric; v_staff numeric; v_net numeric; v_billed numeric; v_bill_paid numeric;
begin
  select x.id, x.code, x.title, x.event_date, x.pricing, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur
    into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if not found then return null; end if;
  v_base := case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end;
  select coalesce(sum(c.price_delta), 0), coalesce(sum(c.cost_delta), 0) into v_chg_rev, v_chg_cost
    from public.change_requests c where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved';
  v_tax := coalesce(public._r101_quote_tax(q.pricing, v_base), 0);
  -- 0142: an approved change order's price_delta is what the client pays (incl. tax, as the
  -- overpay cap / booklet / Settlement use it). Split its tax at the quote's own rate so profit
  -- is on ex-tax revenue and the tax collected is complete.
  if v_tax > 0 and v_base - v_tax > 0 and v_chg_rev <> 0 then
    v_tax := v_tax + round(v_chg_rev * (v_tax / (v_base - v_tax)) / (1 + v_tax / (v_base - v_tax)), 2);
  end if;
  v_rev := v_base + v_chg_rev - v_tax;
  -- vendors: one source per active booking (its bills if any, else its cost line, else its cost)
  select coalesce(sum(case
           when exists (select 1 from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
             then (select sum(vb.amount) from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
           when exists (select 1 from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
             then (select sum(coalesce(k.actual, k.estimated)) from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
           else coalesce(b.cost, 0) end), 0)
    into v_vendor
    from public.event_resources b where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled';
  -- + bills not tied to a booking (or tied to a cancelled one)
  v_vendor := v_vendor + coalesce((select sum(vb.amount) from public.vendor_bills vb
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  -- + vendor cost lines not tied to an active booking
  v_vendor := v_vendor + coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  -- logistics / other: non-vendor cost lines (not tied to a booking) + approved change cost
  v_other := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind <> 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0) + v_chg_cost;
  v_staff := coalesce((select sum(x.amount) from public.expense_claims x where x.quote_id = p_quote and x.org_id = p_org and x.status = 'paid'), 0);
  v_net := v_rev - v_vendor - v_other - v_staff;
  select coalesce(sum(vb.amount), 0) into v_billed from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  select coalesce(sum(p.amount), 0) into v_bill_paid from public.vendor_payouts p join public.vendor_bills vb on vb.id = p.bill_id
    where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  return jsonb_build_object('quote_id', q.id, 'code', q.code, 'title', q.title, 'date', q.event_date, 'currency', q.cur,
    'revenue', v_rev, 'tax', v_tax, 'vendors', v_vendor, 'other', v_other, 'staff', v_staff, 'net_profit', v_net,
    'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
    'bills_total', v_billed, 'bills_paid', v_bill_paid, 'bills_due', v_billed - v_bill_paid);
end $$;
revoke all on function public._vb_event_pnl(uuid, uuid) from public, anon, authenticated;

-- 3) title length guard (only when a title is inserted or changed)
create or replace function public.tg_title_len_0142()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.title is not null and char_length(new.title) > 500
     and (tg_op = 'INSERT' or new.title is distinct from old.title) then
    raise exception 'Title is too long (max 500 characters).' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.tg_title_len_0142() from public;
do $$ declare t text; begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_title_len_0142() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_title_len_0142() from authenticated'; end if;
  foreach t in array array['run_sheet_items', 'event_checklist'] loop
    if to_regclass('public.' || t) is not null and exists (select 1 from information_schema.columns
         where table_schema = 'public' and table_name = t and column_name = 'title') then
      execute format('drop trigger if exists zz_title_len_0142 on public.%I', t);
      execute format('create trigger zz_title_len_0142 before insert or update of title on public.%I for each row execute function public.tg_title_len_0142()', t);
    end if;
  end loop;
end $$;

commit;

-- VERIFY 0136 + 0137 + 0138 + 0139 + 0140 + 0141 + 0142 (read-only; expect every ok = true)
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
       not exists (select 1 from public.crew_members c where c.is_demo is true and c.profile_id is null and c.phone like '+91 00000 %')
union all
select '0139 lead_archive.restored_at column' as item, exists (select 1 from information_schema.columns where table_schema='public' and table_name='lead_archive' and column_name='restored_at') as ok
union all select '0139 lead_archive.restored_by column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='lead_archive' and column_name='restored_by')
union all select '0139 restore_archived_lead is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.restore_archived_lead(uuid)')), false)
union all select '0139 restore_archived_lead: authenticated yes, anon no', has_function_privilege('authenticated','public.restore_archived_lead(uuid)','execute') and not has_function_privilege('anon','public.restore_archived_lead(uuid)','execute')
union all select '0140 nurture.source + lead_id columns', (select count(*) = 2 from information_schema.columns where table_schema='public' and table_name='nurture' and column_name in ('source','lead_id'))
union all select '0140 unique index nurture_lead_occ_uidx', exists (select 1 from pg_indexes where schemaname='public' and indexname='nurture_lead_occ_uidx')
union all select '0140 trigger zz_n140_lead_dates on leads', exists (select 1 from pg_trigger where tgname='zz_n140_lead_dates' and tgrelid='public.leads'::regclass)
union all select '0140 sync helpers not executable by anon/authenticated', not has_function_privilege('anon','public._n140_sync_one(public.leads,text,date)','execute') and not has_function_privilege('authenticated','public._n140_sync_one(public.leads,text,date)','execute')
union all select '0140 no duplicate auto occasions', not exists (select 1 from public.nurture where source='lead' group by org_id, lead_id, occasion_type having count(*) > 1)
union all select '0141 quotes.auto_discarded_at column', exists (select 1 from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='auto_discarded_at')
union all select '0141 reason helper not callable by anon/authenticated', not has_function_privilege('anon','public._empty_draft_reason(uuid)','execute') and not has_function_privilege('authenticated','public._empty_draft_reason(uuid)','execute')
union all select '0141 per-studio worker not callable by anon/authenticated', not has_function_privilege('anon','public._discard_empty_drafts_for(uuid, integer)','execute') and not has_function_privilege('authenticated','public._discard_empty_drafts_for(uuid, integer)','execute')
union all select '0141 app entry: authenticated yes, anon no', has_function_privilege('authenticated','public.discard_empty_drafts()','execute') and not has_function_privilege('anon','public.discard_empty_drafts()','execute')
union all select '0141 all-studios entry not callable by anon/authenticated', not has_function_privilege('authenticated','public.discard_empty_drafts_all()','execute') and not has_function_privilege('anon','public.discard_empty_drafts_all()','execute')
union all select '0141 worker never hard-deletes', coalesce(pg_get_functiondef(to_regprocedure('public._discard_empty_drafts_for(uuid, integer)')) !~* 'delete\s+from', false)
union all select '0141 worker re-checks inside the update', coalesce(pg_get_functiondef(to_regprocedure('public._discard_empty_drafts_for(uuid, integer)')) ~ '_empty_draft_reason\(q\.id\) is null', false)
union all select '0141 restore trigger installed', exists (select 1 from pg_trigger where tgname='zz_quote_auto_discard_restore' and tgrelid='public.quotes'::regclass)
union all select '0141 nothing auto-discarded by the apply itself', not exists (select 1 from public.quotes where auto_discarded_at is not null)
union all
select '0142 dashboard_money has the dominant-currency fallback',
       coalesce((select position('0142: dominant quote currency fallback' in p.prosrc) > 0
                   from pg_proc p where p.oid = to_regprocedure('public.dashboard_money(integer)')), false)
union all
select '0142 dashboard_money: authenticated yes, anon no',
       coalesce(has_function_privilege('authenticated', to_regprocedure('public.dashboard_money(integer)'), 'EXECUTE')
                and not has_function_privilege('anon', to_regprocedure('public.dashboard_money(integer)'), 'EXECUTE'), false)
union all
select '0142 _vb_event_pnl splits change-order tax',
       coalesce((select position('0142: change-order tax split' in p.prosrc) > 0
                   from pg_proc p where p.oid = to_regprocedure('public._vb_event_pnl(uuid, uuid)')), false)
union all
select '0142 _vb_event_pnl not callable by anon/authenticated',
       coalesce(not has_function_privilege('anon', to_regprocedure('public._vb_event_pnl(uuid, uuid)'), 'EXECUTE')
                and not has_function_privilege('authenticated', to_regprocedure('public._vb_event_pnl(uuid, uuid)'), 'EXECUTE'), false)
union all
select '0142 title length trigger on ' || t,
       to_regclass('public.' || t) is null
       or exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zz_title_len_0142')
  from unnest(array['run_sheet_items', 'event_checklist']) as t
union all
select '0142 tg_title_len_0142 not executable by anon/authenticated',
       coalesce(not has_function_privilege('anon', to_regprocedure('public.tg_title_len_0142()'), 'EXECUTE')
                and not has_function_privilege('authenticated', to_regprocedure('public.tg_title_len_0142()'), 'EXECUTE'), false);
