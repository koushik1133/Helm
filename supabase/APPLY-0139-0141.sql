-- APPLY 0139-0141 (paste whole file in the Supabase SQL editor; ONE transaction; ends with read-only verify rows - expect every ok = true)
-- 0139 CRM restore, 0140 lead dates -> nurture, 0141 safe empty-draft soft-archive (never deletes). All additive + idempotent.
begin;

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

commit;

-- ===== VERIFY (read-only) =====
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
union all select '0141 nothing auto-discarded by the apply itself', not exists (select 1 from public.quotes where auto_discarded_at is not null);
