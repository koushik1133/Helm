-- APPLY-0302.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0262 (any order with 0284-0301). It stops with "STOP 0302" if the quote validity functions are missing.
-- R61 quote flow step 9 ("Share with client & approval"), the "Valid until" box:
--   * UNDO: after "Extend +14 days" or "Save date" the page shows an Undo button for 10 seconds (and in the
--     notification). Undo puts the previous date back exactly (and how it was set). It goes through the same server
--     checks as Extend, only the person who made the change can undo it, only within 10 minutes and only while nobody
--     changed the date since. It shows in the quote's History ("Undone - back to dd/mm/yyyy") and in the activity log;
--     the Extend row is kept - nothing is erased.
--   * the box also warns when the client's approval LINK itself stops working before the valid-until date.
-- One new nullable column (quote_validity_log.old_source), the History action list widened (adds 'undo'), two
-- functions re-issued (same names / arguments / grants; previous bodies kept as *__pre0302, not callable by the app),
-- one new function for the page (quote_validity_undo) + two private helpers. No row changed or deleted.
-- Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (flow.html step 9: Undo after Extend / Save date, the date box shows dd/mm/yyyy; step 10
--      payment schedule card tidied; step 4 saved-venue box same size as the other fields).
--   3  Check: open a sent quote -> step 9 -> Extend +14 days -> Undo -> the date is back and History shows
--      "Extended" and "Undone"; the client's link shows the same date.
begin;
-- 0302_r61_quote_validity_undo.sql - CANONICAL forward-only.
-- REQUIRES 0262 (quote_validity, quote_validity_log, _qv262_write, _qv262_guard, _qv262_state, _qv262_cfg,
--          quote_validity_get), 0039 (approval_link_age_until), 0198 (_a198_org_today), the base quotes / audit_log.
--
-- In plain words (r61 owner, quote flow step 9 "Share with client & approval"):
--   1  UNDO for the approval link's "Valid until" date. A click on "Extend +14 days" (or "Save date") by mistake can
--      now be taken back: for 10 minutes the person who made the change can undo it, and the date AND how it was set
--      (automatic / extended / picked by hand) go back exactly as they were. The undo goes through the same server
--      checks as Extend (someone who can edit quotes, this studio, the quote still open), is logged in the quote's
--      History ("Undone - back to dd/mm/yyyy") and in the activity log - nothing is erased.
--      Only the LATEST change can be undone, only while nobody changed the date since, and only when there was a
--      date before (a quote that never had a date is not turned back into "no date").
--   2  The quote's "Valid until" answer (quote_validity_get) also says when the client's approval LINK itself stops
--      working (link_until), so the page can warn when the link would stop before the quote's valid-until date.
--      History rows carry their id (needed for Undo). Every other key is unchanged.
-- Changes: quote_validity_log gets ONE new nullable column (old_source) and its action CHECK is widened to a
-- superset (adds 'undo'); _qv262_write and quote_validity_get re-issued (same names / arguments / grants; previous
-- bodies kept once as *__pre0302 with no app privilege); NEW quote_validity_undo(uuid, uuid) for signed-in staff and
-- NEW private _qv302_undo_row(uuid) / _qv302_link_until(uuid). No row is changed or deleted. Safe to run twice.
-- ASCII only.
-- ROLLBACK (manual, only if ever needed): revoke execute on function public.quote_validity_undo(uuid, uuid) from
--   authenticated; (the page then hides Undo). The new column / functions can stay.

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.quote_validity') is null or to_regclass('public.quote_validity_log') is null then
    raise exception 'STOP 0302: quote_validity / quote_validity_log missing - run 0262 first'; end if;
  if to_regprocedure('public._qv262_write(uuid,date,text,text,text)') is null or to_regprocedure('public._qv262_guard(uuid)') is null
     or to_regprocedure('public._qv262_state(uuid)') is null or to_regprocedure('public._qv262_cfg(uuid)') is null
     or to_regprocedure('public.quote_validity_get(uuid)') is null or to_regprocedure('public._qv262_actor_name(uuid)') is null then
    raise exception 'STOP 0302: the 0262 quote validity functions are missing - run 0262 first'; end if;
  if to_regprocedure('public.approval_link_age_until(uuid)') is null or to_regprocedure('public._a198_org_today(uuid)') is null
     or to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0302: approval_link_age_until (0039) / _a198_org_today (0198) / current_org_id / has_area missing'; end if;
end $$;

-- ---- 2) the log: which "source" a change replaced (so Undo restores it exactly) + 'undo' as an action ------------
alter table public.quote_validity_log add column if not exists old_source text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quote_validity_log_old_source_r302_check'
                   and conrelid = 'public.quote_validity_log'::regclass) then
    alter table public.quote_validity_log add constraint quote_validity_log_old_source_r302_check
      check (old_source is null or old_source in ('auto', 'manual', 'extended', 'bulk'));
  end if;
end $$;
-- widen the action CHECK to a superset (every old value kept + 'undo'); a re-run leaves it alone
do $$ declare c record; begin
  if exists (select 1 from pg_constraint where conrelid = 'public.quote_validity_log'::regclass and contype = 'c'
               and pg_get_constraintdef(oid) like '%''undo''%') then return; end if;
  for c in select conname from pg_constraint where conrelid = 'public.quote_validity_log'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%action%' and pg_get_constraintdef(oid) like '%approve_refused%' loop
    execute format('alter table public.quote_validity_log drop constraint %I', c.conname);
  end loop;
  alter table public.quote_validity_log add constraint quote_validity_log_action_check
    check (action in ('auto', 'set', 'extended', 'bulk', 'renew_request', 'reminder_studio', 'reminder_client',
                      'expired_studio', 'approve_refused', 'undo'));
end $$;

-- ---- 3) keep the previous bodies once (rename-once; a re-run leaves the kept copies alone) ----------------------
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._qv262_write(uuid,date,text,text,text)'));
  if to_regprocedure('public._qv262_write__pre0302(uuid,date,text,text,text)') is null and v_src is not null
     and position('r61-qv-0302' in v_src) = 0 then
    alter function public._qv262_write(uuid, date, text, text, text) rename to _qv262_write__pre0302;
  end if;
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.quote_validity_get(uuid)'));
  if to_regprocedure('public.quote_validity_get__pre0302(uuid)') is null and v_src is not null
     and position('r61-qv-0302' in v_src) = 0 then
    alter function public.quote_validity_get(uuid) rename to quote_validity_get__pre0302;
  end if;
end $$;

-- ---- 4) helpers ---------------------------------------------------------------------------------------------------
-- the latest date change of one quote, when the CALLER may still undo it (10 minutes, nobody changed it since,
-- there was a date before); else no row
create or replace function public._qv302_undo_row(p_quote uuid)
returns table (log_id uuid, back_to date, back_source text, made_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
-- r61-qv-0302
declare l record; v_cur date;
begin
  select x.id, x.action, x.old_until, x.new_until, x.old_source, x.actor, x.created_at into l
    from public.quote_validity_log x
   where x.quote_id = p_quote and x.action in ('auto', 'set', 'extended', 'bulk', 'undo')
   order by x.created_at desc, x.id desc limit 1;
  if l.id is null or l.action not in ('set', 'extended') or l.old_until is null or l.actor is null
     or l.actor is distinct from auth.uid() or l.created_at < now() - interval '10 minutes' then return; end if;
  select v.valid_until into v_cur from public.quote_validity v where v.quote_id = p_quote;
  if v_cur is distinct from l.new_until then return; end if;
  log_id := l.id; back_to := l.old_until; back_source := coalesce(l.old_source, 'manual'); made_at := l.created_at;
  return next;
end $$;

-- the last day the client's approval link still opens (studio's own date), or null (no live link / no limit)
create or replace function public._qv302_link_until(p_quote uuid)
returns date language plpgsql stable security definer set search_path = '' as $$
-- r61-qv-0302
declare v_at timestamptz; v_tz text; v_org uuid;
begin
  select least(q.approval_token_expires_at, public.approval_link_age_until(q.approval_token)), q.org_id into v_at, v_org
    from public.quotes q
   where q.id = p_quote and q.approval_token is not null and q.approval_token_revoked_at is null;
  if v_at is null then return null; end if;
  select nullif(btrim(o.timezone), '') into v_tz from public.organizations o where o.id = v_org;
  begin
    return ((v_at - interval '1 second') at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
  exception when others then
    return ((v_at - interval '1 second') at time zone 'Asia/Kolkata')::date;
  end;
end $$;

-- ---- 5) _qv262_write re-issued: also records the source it replaced; rows ordered by the real clock --------------
create or replace function public._qv262_write(p_quote uuid, p_date date, p_source text, p_action text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-quote-validity-0262 + r61-qv-0302: internal - callers check who may do it. 0302: the log row also keeps the
-- source being replaced (old_source, for an exact Undo) and is stamped with the real clock (two changes in one
-- request keep their order).
declare v_org uuid; v_old date; v_old_src text; v_uid uuid := auth.uid(); v_name text; v_email text;
begin
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  select x.valid_until, x.source into v_old, v_old_src from public.quote_validity x where x.quote_id = p_quote for update;
  insert into public.quote_validity(quote_id, org_id, valid_until, source, set_by, set_at)
    values (p_quote, v_org, p_date, p_source, v_uid, now())
  on conflict (quote_id) do update set valid_until = excluded.valid_until, source = excluded.source,
                                       set_by = excluded.set_by, set_at = excluded.set_at;
  v_name := public._qv262_actor_name(v_uid);
  select u.email into v_email from auth.users u where u.id = v_uid;
  insert into public.quote_validity_log(org_id, quote_id, action, old_until, new_until, actor, actor_name, note, old_source, created_at)
    values (v_org, p_quote, p_action, v_old, p_date, v_uid, v_name, p_note, v_old_src, clock_timestamp());
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'quote_validity.' || p_action, 'quotes', p_quote::text, p_quote,
            jsonb_build_object('old_valid_until', v_old, 'new_valid_until', p_date, 'note', p_note), v_org);
  return public.quote_validity_get(p_quote);
end $$;

-- ---- 6) quote_validity_get re-issued: + log ids, + undo offer, + when the approval link itself stops ------------
create or replace function public.quote_validity_get(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262 + r61-qv-0302 (every 0262 key unchanged; adds log[].id, undo, link_until, link_until_label)
declare v_org uuid := public.current_org_id(); s jsonb; c jsonb; v_admin boolean := coalesce(public.user_role(), '') = 'admin';
        v_edit boolean; v_log jsonb; u record; v_undo jsonb; v_link date;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this quote' using errcode = '42501'; end if;
  s := public._qv262_state(p_quote); c := public._qv262_cfg(v_org);
  v_edit := public.has_area('quotes', 'edit');
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'at', l.created_at, 'action', l.action,
           'old', to_char(l.old_until, 'DD/MM/YYYY'), 'new', to_char(l.new_until, 'DD/MM/YYYY'),
           'who', l.actor_name, 'note', l.note) order by l.created_at desc, l.id desc), '[]'::jsonb)
    into v_log from (select * from public.quote_validity_log x where x.quote_id = p_quote and x.org_id = v_org
                      order by x.created_at desc, x.id desc limit 10) l;
  if v_edit and s ->> 'state' in ('valid', 'expired') then
    select * into u from public._qv302_undo_row(p_quote);
    if u.log_id is not null then
      v_undo := jsonb_build_object('log_id', u.log_id, 'back_to', to_char(u.back_to, 'YYYY-MM-DD'),
                                   'back_to_label', to_char(u.back_to, 'DD/MM/YYYY'), 'until', u.made_at + interval '10 minutes');
    end if;
  end if;
  if s ->> 'state' in ('valid', 'expired') then v_link := public._qv302_link_until(p_quote); end if;
  return s || jsonb_build_object('can_edit', v_edit and s ->> 'state' in ('none', 'valid', 'expired'),
    'can_override', v_edit and ((c ->> 'allow_override')::boolean or v_admin),
    'default_days', (c ->> 'default_days')::integer, 'today', to_char(public._a198_org_today(v_org), 'YYYY-MM-DD'),
    'log', v_log, 'undo', v_undo,
    'link_until', to_char(v_link, 'YYYY-MM-DD'), 'link_until_label', to_char(v_link, 'DD/MM/YYYY'));
end $$;

-- ---- 7) NEW: undo the latest Extend / Save date (same checks as Extend; logged, never erased) ------------------
create or replace function public.quote_validity_undo(p_quote uuid, p_log uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r61-qv-0302: only the caller's own latest change, within 10 minutes, while nobody changed the date since
declare u record;
begin
  perform public._qv262_guard(p_quote);          -- can edit quotes, this studio, switched on, quote still open
  if p_log is null then raise exception 'Nothing to undo.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:qv:' || p_quote::text, 0));
  select * into u from public._qv302_undo_row(p_quote);
  if u.log_id is null or u.log_id <> p_log then
    raise exception 'This change can no longer be undone - pick the date you want with Change date instead.' using errcode = '22023'; end if;
  return public._qv262_write(p_quote, u.back_to, u.back_source, 'undo', 'Undone - back to ' || to_char(u.back_to, 'DD/MM/YYYY'));
end $$;

-- ---- 8) privileges -------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._qv262_write(uuid, date, text, text, text)', 'public._qv302_undo_row(uuid)',
                           'public._qv302_link_until(uuid)', 'public._qv262_write__pre0302(uuid, date, text, text, text)',
                           'public.quote_validity_get__pre0302(uuid)'] loop
    continue when to_regprocedure(f) is null;
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      if f like '%__pre0302%' then execute format('revoke all on function %s from service_role', f);
      else execute format('grant execute on function %s to service_role', f); end if;
    end if;
  end loop;
  foreach f in array array['public.quote_validity_get(uuid)', 'public.quote_validity_undo(uuid, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 quote_validity_undo exists, security definer, empty search path, carries the 0302 marker',
     coalesce((select p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%' and position('r61-qv-0302' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.quote_validity_undo(uuid,uuid)')), false)),
  ('02 signed-in staff can call quote_validity_undo, anon cannot',
     has_function_privilege('authenticated', 'public.quote_validity_undo(uuid,uuid)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.quote_validity_undo(uuid,uuid)', 'execute'))),
  ('03 quote_validity_get re-issued (0302 marker, undo + link_until), still callable by signed-in staff only',
     coalesce((select position('r61-qv-0302' in p.prosrc) > 0 and position('link_until' in p.prosrc) > 0 and position('_qv302_undo_row' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.quote_validity_get(uuid)')), false)
     and has_function_privilege('authenticated', 'public.quote_validity_get(uuid)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.quote_validity_get(uuid)', 'execute'))),
  ('04 _qv262_write re-issued (records old_source), not callable by the app',
     coalesce((select position('r61-qv-0302' in p.prosrc) > 0 and position('old_source' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public._qv262_write(uuid,date,text,text,text)')), false)
     and not has_function_privilege('authenticated', 'public._qv262_write(uuid,date,text,text,text)', 'execute')),
  ('05 previous bodies kept once as *__pre0302, not callable by the app',
     to_regprocedure('public._qv262_write__pre0302(uuid,date,text,text,text)') is not null
     and to_regprocedure('public.quote_validity_get__pre0302(uuid)') is not null
     and not has_function_privilege('authenticated', 'public._qv262_write__pre0302(uuid,date,text,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.quote_validity_get__pre0302(uuid)', 'execute')),
  ('06 private helpers exist and are not callable by the app',
     to_regprocedure('public._qv302_undo_row(uuid)') is not null and to_regprocedure('public._qv302_link_until(uuid)') is not null
     and not has_function_privilege('authenticated', 'public._qv302_undo_row(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._qv302_link_until(uuid)', 'execute')),
  ('07 History actions widened to a superset (every old value + undo)',
     coalesce((select pg_get_constraintdef(c.oid) like '%approve_refused%' and pg_get_constraintdef(c.oid) like '%renew_request%'
                      and pg_get_constraintdef(c.oid) like '%reminder_client%' and pg_get_constraintdef(c.oid) like '%''undo''%'
                 from pg_constraint c where c.conrelid = 'public.quote_validity_log'::regclass and c.conname = 'quote_validity_log_action_check'), false)),
  ('08 quote_validity_log.old_source added (nullable)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_validity_log'
               and column_name = 'old_source' and is_nullable = 'YES')),
  ('09 nothing removed: quote_validity, quote_validity_log, extend, set, client page function still there',
     to_regclass('public.quote_validity') is not null and to_regclass('public.quote_validity_log') is not null
     and to_regprocedure('public.quote_validity_extend(uuid,integer)') is not null and to_regprocedure('public.quote_validity_set(uuid,date,text)') is not null
     and to_regprocedure('public.public_quote_validity(text,uuid)') is not null)
) v(item, ok) order by item;
