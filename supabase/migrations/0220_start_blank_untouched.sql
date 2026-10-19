-- 0220_start_blank_untouched.sql - CANONICAL forward-only.
-- REQUIRES 0065 (client_booklets), 0069 (booklet sections: _bk_sections_norm / _bk_sections_all),
-- 0072 (create_quote), 0075 (start_blank_quote), 0141 (quotes.shelf_restored_at / auto_discarded_at)
-- and 0206 (quote_flow_progress).
--
-- In plain words (live production QA, 2026-10-18):
--   L1  "New quote" handed back the person's OWN in-progress draft and the app then renamed it: the
--       draft "Sharma" (title, event type, a layout and a booklet link, client name still empty) became
--       "QA-B Test Wedding" - same id, same code - and "Sharma" was gone. start_blank_quote (0075) only
--       looked at the client name, the event date and the layout items to decide "untouched".
--       It now reuses a draft ONLY when NOTHING was put into it:
--         * title blank / 'Untitled event' / the quote's code / exactly the title it was created with
--           (the app creates a blank quote titled with its own guessed code; any rename = touched),
--         * no event type, event date, event time, manager, consent flag,
--         * no client value at all (name, phone, e-mail, company, guests, hall size ... anything),
--         * pricing empty except plain tax / currency settings (so no guests, venue, totals, packages),
--         * version 1 only, created by the caller, with no items / objects and no other layout data,
--         * no approval link, not sent / confirmed, status 'quote', stage 'quote', never restored
--           from the shelf, and
--         * ZERO rows in EVERY other table that points at the quote (booklet links, quotation versions,
--           menu / event plan rows, payments, milestones, consents, files, tasks ... - found at run time
--           from information_schema / pg_constraint, like 0141) except audit_log and quote_flow_progress
--           (just opening the flow). A table it cannot read counts as touched (fail closed).
--       Anything else => a NEW quote is created (create_quote, same gates). The test runs on the row
--       locked FOR UPDATE inside the per-user advisory lock. start_blank_quote never writes, renames or
--       deletes an existing quote: when it reuses one, it returns it unchanged.
--   L11 The client booklet left out the floor plan and 3D view after a layout was saved: a link made while
--       the layout was still empty stored layout2d / layout3d = false (the share window skipped the
--       pictures), and nothing ever turned them back on. Now:
--         * client_booklets.sections_set_at (NEW, nullable): when a person last switched sections on the
--           LIVE link (booklet_set_sections). Never set by anything else.
--         * _bk220_layout_auto_on(booklet): turns layout2d AND layout3d on for a live, unexpired link when
--           both are off, nobody switched sections on the live link (sections_set_at is null), the
--           layout that was current when the link was made had no objects, and the quote's CURRENT
--           layout version now has objects. Only those two keys change; nothing else is touched.
--         * trigger zzzz_bk220_layout_auto_on (AFTER INSERT on quote_versions, object_count > 0) runs it
--           for that quote's live link; any error is swallowed (a layout save never fails because of it).
--         * booklet_layout_auto_on(quote)  - staff (quotes EDIT), run when the Share booklet window opens
--           (links whose layout was saved before this migration).
--         * booklet_set_sections(quote, sections) - staff (quotes EDIT): change which sections the LIVE
--           link shows, in place (same link, same token), and stamp sections_set_at.
--         * booklet_current(quote) also returns sections, image_variants and sections_set_at.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS (nullable, no default - no row is written),
-- CREATE OR REPLACE FUNCTION, trigger created only when missing. No row is written or deleted by this file.
-- ROLLBACK (manual, only if ever needed): re-run 0075 section 1 (old start_blank_quote), drop the trigger
-- zzzz_bk220_layout_auto_on + the 4 new functions, re-run the 0065 booklet_current body.

do $$ begin
  if to_regprocedure('public.create_quote(text, text, text, jsonb, integer, date)') is null then
    raise exception '0220: create_quote (0072) is not installed'; end if;
  if to_regprocedure('public.start_blank_quote(text, text)') is null then
    raise exception '0220: start_blank_quote (0075) is not installed'; end if;
  if to_regclass('public.client_booklets') is null then raise exception '0220: client_booklets (0065) is missing'; end if;
  if to_regprocedure('public._bk_sections_norm(jsonb)') is null or to_regprocedure('public._bk_sections_all()') is null then
    raise exception '0220: 0069 booklet sections are not installed'; end if;
  if to_regprocedure('public._booklet_staff_quote(uuid, boolean)') is null then
    raise exception '0220: _booklet_staff_quote (0065) is not installed'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'auto_discarded_at') then
    raise exception '0220: quotes.auto_discarded_at is missing (0141)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_booklets' and column_name = 'image_variants') then
    raise exception '0220: client_booklets.image_variants is missing (0083)'; end if;
end $$;

-- ---- L1-a) why is this draft NOT safe to hand back as a blank quote? (NULL = untouched) -------------
create or replace function public._blank_quote_touched_reason(p_quote_id uuid, p_uid uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- start-blank-0220
declare q public.quotes; t record; v_hit boolean; v_n int; k text; v jsonb; v_t0 text;
begin
  select x.* into q from public.quotes x where x.id = p_quote_id;
  if not found then return 'missing'; end if;
  if p_uid is null then return 'no_user'; end if;
  if coalesce(q.status, '') <> 'quote' then return 'status'; end if;
  if coalesce(q.approval_status, 'none') <> 'none' or q.approval_token is not null
     or q.confirmed_at is not null or q.confirmed_by is not null then return 'sent'; end if;
  if coalesce(q.lifecycle_stage, 'quote') <> 'quote' then return 'lifecycle'; end if;
  if q.deleted_at is not null or q.archived_at is not null then return 'shelved'; end if;
  if q.shelf_restored_at is not null or q.auto_discarded_at is not null then return 'restored_before'; end if;
  -- title: blank / default / the code / exactly the title the quote was created with (audit insert row)
  if not (coalesce(btrim(q.title), '') in ('', 'Untitled event') or btrim(q.title) = btrim(q.code)) then
    select a.changed ->> 'title' into v_t0 from public.audit_log a
     where a.entity = 'quotes' and a.quote_id = q.id and a.action = 'insert'
     order by a.at, a.id limit 1;
    if v_t0 is null or btrim(v_t0) <> btrim(q.title) then return 'title'; end if;
    if exists (select 1 from public.audit_log a
                where a.entity = 'quotes' and a.quote_id = q.id and a.action = 'update' and a.changed ? 'title') then
      return 'title'; end if;
  end if;
  if coalesce(btrim(q.event_type), '') <> '' then return 'event_type'; end if;
  if q.event_date is not null or coalesce(btrim(q.event_time), '') <> '' then return 'event_date'; end if;
  if q.manager_id is not null then return 'manager'; end if;
  if coalesce(q.consent_stale, false) then return 'consent'; end if;
  if q.capacity_decision is not null then return 'capacity'; end if;
  -- client: any non-blank value (name, phone, e-mail, company, guests, hall size, venue ...) blocks
  if jsonb_typeof(q.client) = 'object' then
    if exists (select 1 from jsonb_each(q.client) e
                where not (e.value in ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb, 'false'::jsonb)
                           or (jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') = ''))) then return 'client'; end if;
  elsif q.client is not null and q.client <> 'null'::jsonb then return 'client';
  end if;
  -- pricing: everything must be null / 0 / false / blank / empty, except plain tax / currency settings
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
  -- layout versions: exactly ONE, version 1, made by the caller, with no items / objects / other data
  if coalesce(q.current_version, 1) <> 1 then return 'versions'; end if;
  select count(*) into v_n from public.quote_versions qv where qv.quote_id = q.id;
  if v_n <> 1 then return 'versions'; end if;
  if not exists (select 1 from public.quote_versions qv where qv.quote_id = q.id and qv.version_no = 1 and qv.created_by = p_uid) then
    return 'not_mine'; end if;
  if exists (select 1 from public.quote_versions qv where qv.quote_id = q.id
              and (coalesce(qv.object_count, 0) <> 0
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
       and c.table_name not in ('quotes', 'quote_versions', 'audit_log', 'quote_flow_progress')
    union
    select cl.relname::text, a.attname::text
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
     where con.contype = 'f' and con.confrelid = 'public.quotes'::regclass
       and cl.relname not in ('quotes', 'quote_versions', 'audit_log', 'quote_flow_progress')
  loop
    begin
      execute format('select exists (select 1 from public.%I where %I = $1)', t.tbl, t.col)
        into v_hit using q.id;
    exception when others then
      return 'unreadable:' || t.tbl;          -- fail closed: cannot prove it is untouched
    end;
    if v_hit then return 'has:' || t.tbl; end if;
  end loop;
  return null;
end $$;
revoke all on function public._blank_quote_touched_reason(uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._blank_quote_touched_reason(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._blank_quote_touched_reason(uuid, uuid) from authenticated'; end if;
end $$;

-- ---- L1-b) start_blank_quote: same signature, same gates, the strict test above ---------------------
create or replace function public.start_blank_quote(p_code text, p_title text default null)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
-- ui-fixes-0075 (L8)
-- start-blank-0220: a draft is reused only when _blank_quote_touched_reason() finds nothing in it
declare v_org uuid; v_uid uuid; q public.quotes; r record;
begin
  v_uid := auth.uid(); v_org := public.current_org_id();
  if v_uid is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;  -- F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:blankq:' || v_org::text || ':' || v_uid::text, 0));
  for r in
    select x.id from public.quotes x
     where x.org_id = v_org
       and x.deleted_at is null and x.archived_at is null
       and x.created_at > now() - interval '7 days'
       and coalesce(btrim(x.client ->> 'name'), '') = ''
       and x.event_date is null
       and x.current_version = 1
       and coalesce(x.status, 'quote') = 'quote'
       and coalesce(x.approval_status, 'none') = 'none'
       and x.confirmed_at is null and x.approval_token is null
       and coalesce(btrim(x.event_type), '') = '' and coalesce(btrim(x.event_time), '') = '' and x.manager_id is null
       and exists (select 1 from public.quote_versions v
                    where v.quote_id = x.id and v.version_no = 1 and v.created_by = v_uid
                      and coalesce(v.object_count, 0) = 0)
       and not exists (select 1 from public.quote_versions v where v.quote_id = x.id and v.version_no <> 1)
     order by x.created_at desc, x.id desc
     limit 25
  loop
    select x.* into q from public.quotes x where x.id = r.id and x.org_id = v_org for update of x;
    continue when q.id is null;
    if public._blank_quote_touched_reason(q.id, v_uid) is null then return q; end if;   -- checked on the locked row
    q := null;
  end loop;
  return public.create_quote(p_code, coalesce(p_title, p_code), null, '{"items":[]}'::jsonb, 0, null);
end $$;
revoke all on function public.start_blank_quote(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.start_blank_quote(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.start_blank_quote(text, text) to authenticated'; end if;
end $$;

-- ---- L11-a) who last switched sections on the live link -------------------------------------------
alter table public.client_booklets add column if not exists sections_set_at timestamptz;

-- ---- L11-b) floor plan + 3D view on once the layout has objects ---------------------------------------
create or replace function public._bk220_layout_auto_on(p_booklet_id uuid, p_new_objects integer default null)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- booklet-layout-0220
declare b public.client_booklets; v_cur int; v_then int; n int;
begin
  select x.* into b from public.client_booklets x where x.id = p_booklet_id;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now() then return false; end if;
  if b.sections_set_at is not null then return false; end if;                        -- a person chose on the live link
  if jsonb_typeof(b.sections) <> 'object' then return false; end if;
  if coalesce(b.sections ->> 'layout2d', 'true') = 'true' or coalesce(b.sections ->> 'layout3d', 'true') = 'true' then
    return false; end if;                                                             -- only when BOTH are off
  -- the layout current when the link was made had no objects (the share window skipped the pictures)
  select coalesce(v.object_count, 0) into v_then from public.quote_versions v
   where v.quote_id = b.quote_id and v.created_at <= b.created_at
   order by v.version_no desc limit 1;
  if coalesce(v_then, 0) <> 0 then return false; end if;
  -- the quote's CURRENT layout has objects now (from the trigger: the version being saved, which becomes current)
  if p_new_objects is not null then v_cur := p_new_objects;
  else
    select coalesce(v.object_count, 0) into v_cur from public.quote_versions v join public.quotes q on q.id = v.quote_id
     where v.quote_id = b.quote_id and v.version_no = q.current_version and q.org_id = b.org_id;
  end if;
  if coalesce(v_cur, 0) <= 0 then return false; end if;
  update public.client_booklets x
     set sections = x.sections || '{"layout2d": true, "layout3d": true}'::jsonb
   where x.id = b.id and x.revoked_at is null and x.sections_set_at is null
     and x.sections ->> 'layout2d' = 'false' and x.sections ->> 'layout3d' = 'false';
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public._bk220_layout_auto_on(uuid, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk220_layout_auto_on(uuid, integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._bk220_layout_auto_on(uuid, integer) from authenticated'; end if;
end $$;

create or replace function public._bk220_tg_layout_auto_on()
returns trigger language plpgsql security definer set search_path = '' as $$
-- booklet-layout-0220: a saved layout with objects turns the floor plan / 3D view on for the live link
declare b uuid;
begin
  if coalesce(new.object_count, 0) <= 0 then return null; end if;
  begin
    for b in select x.id from public.client_booklets x
              where x.quote_id = new.quote_id and x.revoked_at is null and x.sections_set_at is null loop
      perform public._bk220_layout_auto_on(b, new.object_count);
    end loop;
  exception when others then
    null;                                                                             -- never fail a layout save
  end;
  return null;
end $$;
revoke all on function public._bk220_tg_layout_auto_on() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk220_tg_layout_auto_on() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._bk220_tg_layout_auto_on() from authenticated'; end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zzzz_bk220_layout_auto_on' and tgrelid = 'public.quote_versions'::regclass) then
    create trigger zzzz_bk220_layout_auto_on after insert on public.quote_versions
      for each row execute function public._bk220_tg_layout_auto_on();
  end if;
end $$;

-- staff: run it for this quote's live link (the Share booklet window calls this when it opens)
create or replace function public.booklet_layout_auto_on(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-layout-0220
declare v_org uuid; b public.client_booklets; v_changed boolean := false;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  select x.* into b from public.client_booklets x
   where x.quote_id = p_quote_id and x.org_id = v_org and x.revoked_at is null
   order by x.created_at desc limit 1;
  if b.id is null then return jsonb_build_object('ok', false, 'changed', false); end if;
  v_changed := public._bk220_layout_auto_on(b.id);
  select x.* into b from public.client_booklets x where x.id = b.id;
  return jsonb_build_object('ok', true, 'changed', v_changed, 'sections', public._bk_sections_norm(b.sections));
end $$;

-- staff: change which sections the LIVE link shows, in place (same link)
create or replace function public.booklet_set_sections(p_quote_id uuid, p_sections jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-layout-0220
declare v_org uuid; b public.client_booklets; v jsonb; n int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  if p_sections is null or jsonb_typeof(p_sections) <> 'object' then raise exception 'sections must be an object' using errcode = '22023'; end if;
  perform public._bk_sections_norm(p_sections);                                       -- unknown key / non-boolean -> 22023
  select x.* into b from public.client_booklets x
   where x.quote_id = p_quote_id and x.org_id = v_org and x.revoked_at is null
   order by x.created_at desc limit 1 for update;
  if b.id is null then raise exception 'no live booklet link for this event' using errcode = 'P0002'; end if;
  v := public._bk_sections_norm(coalesce(b.sections, '{}'::jsonb) || p_sections);
  update public.client_booklets x set sections = v, sections_set_at = now() where x.id = b.id;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'sections', v);
end $$;

do $$ declare s text; begin
  foreach s in array array['public.booklet_layout_auto_on(uuid)', 'public.booklet_set_sections(uuid, jsonb)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', s); end if;
  end loop;
end $$;

-- ---- L11-c) booklet_current also says which sections / picture styles the live link shows ------------
create or replace function public.booklet_current(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-layout-0220: the 0065 body + sections, image_variants, sections_set_at
declare v_org uuid; r public.client_booklets;
begin
  v_org := public._booklet_staff_quote(p_quote_id, false);
  select * into r from public.client_booklets b
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null
   order by b.created_at desc limit 1;
  if r.id is null then return null; end if;
  return jsonb_build_object('id', r.id, 'token', r.token, 'expires_at', r.expires_at, 'created_at', r.created_at,
                            'expired', r.expires_at <= now(), 'shared_versions', to_jsonb(r.shared_versions),
                            'terms', r.terms, 'note', r.note,
                            'sections', public._bk_sections_all() || coalesce(case when jsonb_typeof(r.sections) = 'object' then r.sections end, '{}'::jsonb),
                            'image_variants', r.image_variants, 'sections_set_at', r.sections_set_at);
end $$;
revoke all on function public.booklet_current(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.booklet_current(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.booklet_current(uuid) to authenticated'; end if;
end $$;
