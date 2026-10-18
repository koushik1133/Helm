-- APPLY-0206.sql - paste into the Supabase SQL editor (staging first, then production).
-- "Continue where you left off" stays until the quote is finished, on every device: the step each
-- person last worked on in the quote flow is now kept in the database (per quote, per person).
-- What it adds: 1 table (quote_flow_progress: which step, when, dismissed) and 4 functions -
-- mark_flow_step, mark_flow_resume_dismissed, my_unfinished_quotes (the app) and _flow_steps_done
-- (internal). It also teaches the empty-draft tidy-up (0141) to ignore that table, so merely opening
-- an empty draft does not keep it forever.
-- No existing table, column, row or policy is changed. No DROP / DELETE / UPDATE / TRUNCATE.
-- Safe to run twice. No edge function to redeploy.
begin;
-- 0206_flow_progress.sql - CANONICAL forward-only.
-- REQUIRES the base quotes / quote_versions / event_discovery / event_requirements / event_plan /
-- event_proposal tables, phase77 (quotation_versions), 0040 (quote shelves), 0045 (read-only guard
-- tg_studio_read_only), 0097 (quotes.is_demo) and 0141 (empty-draft cleanup).
--
-- In plain words ("Continue where you left off" that stays until the quote is finished, owner 2026-10-18):
--   The quote flow remembered the step a person last worked on only in that one browser, in ONE slot
--   per person, so the dashboard button often disappeared. It is now kept in the database, per quote
--   and per person:
--     * NEW table public.quote_flow_progress (quote_id, user_id, org_id, last_step, last_step_at,
--       dismissed_at), one row per person per quote. Studio members with quotes VIEW may read their own
--       studio's rows (needed for "last worked on by"). The app never writes the table directly: only
--       the two functions below write it, and only for the caller's OWN row.
--     * mark_flow_step(quote, step)       - "I am on step <step> of this quote": saves the step + time
--       and clears a Dismiss. Quotes EDIT + own studio. Never touches public.quotes (so no updated_at
--       change, no "changed elsewhere" conflict, no audit-log line per step). A read-only studio
--       (suspended / ended trial) is answered {ok:false, read_only:true} instead of an error.
--     * mark_flow_resume_dismissed(quote) - hide the dashboard button for this quote, for ME only, until
--       I next work on it (the next mark_flow_step clears it).
--     * my_unfinished_quotes(scope, limit, offset, quote, max_days) - the quotes still in progress:
--       own studio, not deleted / archived / auto-discarded, status 'quote' at a stage before Confirmed
--       (lead / discovery / proposal / quote - the same group 0040 / 0052 use; a quote moved to the
--       Discovery or Proposal stage in the workspace is still being prepared), nothing
--       sent to the client (approval 'none', no link, not confirmed), NO quotation version saved yet
--       (owner decision A: finished = a quotation saved in step 8), not trial sample data (is_demo,
--       decision D), and with some content (a step opened by anyone, or at least one step done).
--       scope 'mine' (dashboard, decision B): quotes I worked on (and did not dismiss), or quotes I
--       created that nobody has worked on yet; max_days hides ones idle longer than that (decision E:
--       the dashboard passes 60). scope 'studio' (Quotes > In progress): every unfinished quote of the
--       studio with who worked on it last. quote = just that one quote (event workspace banner).
--       Steps done copy flow.html stepDone(): client (name + phone + type + date), discovery, reqs,
--       venue, menu, proposal, layout (current layout has objects), quote (total > 0).
--     * _empty_draft_reason (0141) now also ignores quote_flow_progress, like audit_log: merely OPENING
--       an empty draft must not stop it from being tidied away.
--   Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, policies / triggers / constraints created
--   only when missing, CREATE OR REPLACE FUNCTION. No existing table, column, row or policy is changed or
--   deleted. ROLLBACK (manual, only if ever needed): drop the three functions + _flow_steps_done, re-run
--   0141 (restores the old ignore list), drop table public.quote_flow_progress (only progress markers).
-- ============================================================================

do $$ begin
  if to_regclass('public.quotes') is null then raise exception '0206: public.quotes is missing'; end if;
  if to_regclass('public.quote_versions') is null then raise exception '0206: public.quote_versions is missing'; end if;
  if to_regclass('public.quotation_versions') is null then raise exception '0206: public.quotation_versions is missing (phase77)'; end if;
  if to_regclass('public.event_discovery') is null or to_regclass('public.event_requirements') is null
     or to_regclass('public.event_plan') is null or to_regclass('public.event_proposal') is null then
    raise exception '0206: the quote flow tables (event_discovery / event_requirements / event_plan / event_proposal) are missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'is_demo') then
    raise exception '0206: quotes.is_demo is missing (0097)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'auto_discarded_at') then
    raise exception '0206: quotes.auto_discarded_at is missing (0141)'; end if;
  if to_regprocedure('public._empty_draft_reason(uuid)') is null then raise exception '0206: 0141 (_empty_draft_reason) is not installed'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0206: public.has_area(text,text) is missing'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0206: public.current_org_id() is missing'; end if;
end $$;

-- ---- 1) the table ------------------------------------------------------------------------------
create table if not exists public.quote_flow_progress (
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  user_id      uuid not null,
  org_id       uuid not null default public.current_org_id(),
  last_step    text,
  last_step_at timestamptz,
  dismissed_at timestamptz,
  primary key (quote_id, user_id)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_flow_progress'::regclass and conname = 'quote_flow_progress_step_0206') then
    alter table public.quote_flow_progress add constraint quote_flow_progress_step_0206
      check (last_step is null or last_step in ('client', 'discovery', 'reqs', 'venue', 'menu', 'proposal', 'layout', 'quote', 'pay'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quote_flow_progress'::regclass and conname = 'quote_flow_progress_step_at_0206') then
    alter table public.quote_flow_progress add constraint quote_flow_progress_step_at_0206
      check ((last_step is null) = (last_step_at is null));
  end if;
end $$;

create index if not exists quote_flow_progress_user_idx_0206 on public.quote_flow_progress(org_id, user_id, last_step_at desc);
create index if not exists quote_flow_progress_quote_idx_0206 on public.quote_flow_progress(quote_id, last_step_at desc);

alter table public.quote_flow_progress enable row level security;
revoke all on public.quote_flow_progress from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.quote_flow_progress from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.quote_flow_progress from authenticated';
    execute 'grant select on public.quote_flow_progress to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant all on public.quote_flow_progress to service_role'; end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_flow_progress' and policyname = 'a206 flow progress read') then
    execute $p$create policy "a206 flow progress read" on public.quote_flow_progress for select to authenticated
      using (org_id = (select public.current_org_id()) and public.has_area('quotes', 'view'))$p$;
  end if;
end $$;

-- suspended / ended-trial studios are read-only here too (0045 / 0183 guard), like every studio table
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.quote_flow_progress'::regclass and tgname = 'zzz_studio_read_only' and not tgisinternal) then
    create trigger zzz_studio_read_only before insert or update or delete on public.quote_flow_progress
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

-- a row's org_id must be its quote's studio (0004 G4 quote <-> org integrity trigger), like every quote table
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.quote_flow_progress'::regclass and tgname = 'zz_quote_org_match' and not tgisinternal) then
    create trigger zz_quote_org_match before insert or update on public.quote_flow_progress
      for each row execute function public.tg_quote_org_match();
  end if;
end $$;

-- ---- 2) which flow steps are done (same checks as flow.html stepDone) -----------------------------
create or replace function public._flow_steps_done(p_quote uuid)
returns text[] language sql stable security definer set search_path = '' as $$
-- flow-progress-0206
  select coalesce(array_remove(array[
    case when coalesce(btrim(q.client ->> 'name'), '') <> '' and coalesce(btrim(q.client ->> 'phone'), '') <> ''
          and coalesce(btrim(q.event_type), '') <> ''
          and (coalesce(btrim(q.client ->> 'eventDate'), '') <> '' or q.event_date is not null) then 'client' end,
    case when exists (select 1 from public.event_discovery d where d.quote_id = q.id
                       and (d.meet_date is not null or coalesce(btrim(d.mode), '') <> ''
                            or coalesce(btrim(d.attendees), '') <> '' or coalesce(btrim(d.notes), '') <> '')) then 'discovery' end,
    case when exists (select 1 from public.event_requirements r where r.quote_id = q.id) then 'reqs' end,
    case when exists (select 1 from public.event_plan p where p.quote_id = q.id
                       and (coalesce(btrim(p.venue_name), '') <> '' or coalesce(btrim(p.venue_address), '') <> ''
                            or coalesce(btrim(p.venue_contact), '') <> '' or coalesce(btrim(p.access_notes), '') <> ''))
              or coalesce(btrim(q.client ->> 'venue'), '') <> '' or coalesce(btrim(q.client ->> 'setting'), '') <> '' then 'venue' end,
    case when exists (select 1 from public.event_plan p where p.quote_id = q.id
                       and (coalesce(btrim(p.menu), '') <> '' or coalesce(btrim(p.menu_template), '') <> ''
                            or coalesce(btrim(p.package), '') <> '')) then 'menu' end,
    case when exists (select 1 from public.event_proposal pr where pr.quote_id = q.id
                       and (coalesce(btrim(pr.concept), '') <> '' or coalesce(btrim(pr.theme), '') <> ''
                            or (jsonb_typeof(pr.scope) = 'array' and jsonb_array_length(pr.scope) > 0))) then 'proposal' end,
    case when exists (select 1 from public.quote_versions v where v.quote_id = q.id
                       and v.version_no = coalesce(q.current_version, 1) and coalesce(v.object_count, 0) > 0) then 'layout' end,
    case when coalesce(q.pricing ->> 'total', '') ~ '^[0-9]{1,15}(\.[0-9]{1,6})?$'
          and (q.pricing ->> 'total')::numeric > 0 then 'quote' end
  ], null), '{}'::text[])
  from public.quotes q where q.id = p_quote;
$$;
revoke all on function public._flow_steps_done(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._flow_steps_done(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._flow_steps_done(uuid) from authenticated'; end if;
end $$;

-- ---- 3) save my step ------------------------------------------------------------------------------
create or replace function public.mark_flow_step(p_quote uuid, p_step text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- flow-progress-0206
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id(); v_step text := lower(btrim(coalesce(p_step, '')));
begin
  if v_uid is null or v_org is null or not coalesce(public.has_area('quotes', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_step not in ('client', 'discovery', 'reqs', 'venue', 'menu', 'proposal', 'layout', 'quote', 'pay') then
    raise exception 'unknown flow step' using errcode = '22023';
  end if;
  if p_quote is null or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  begin
    insert into public.quote_flow_progress as fp (quote_id, user_id, org_id, last_step, last_step_at, dismissed_at)
      values (p_quote, v_uid, v_org, v_step, clock_timestamp(), null)
      on conflict (quote_id, user_id) do update
        set last_step = excluded.last_step, last_step_at = excluded.last_step_at, dismissed_at = null
      where fp.org_id = v_org;
  exception when sqlstate '25006' then
    return jsonb_build_object('ok', false, 'read_only', true);      -- suspended / ended trial: quietly not saved
  end;
  return jsonb_build_object('ok', true, 'step', v_step);
end $$;
revoke all on function public.mark_flow_step(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mark_flow_step(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.mark_flow_step(uuid, text) to authenticated'; end if;
end $$;

-- ---- 4) Dismiss (for me, until I work on the quote again) -----------------------------------------
create or replace function public.mark_flow_resume_dismissed(p_quote uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- flow-progress-0206
declare v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_uid is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_quote is null or not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  begin
    insert into public.quote_flow_progress as fp (quote_id, user_id, org_id, dismissed_at)
      values (p_quote, v_uid, v_org, clock_timestamp())
      on conflict (quote_id, user_id) do update set dismissed_at = clock_timestamp()
      where fp.org_id = v_org;
  exception when sqlstate '25006' then
    return jsonb_build_object('ok', false, 'read_only', true);
  end;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mark_flow_resume_dismissed(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mark_flow_resume_dismissed(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.mark_flow_resume_dismissed(uuid) to authenticated'; end if;
end $$;

-- ---- 5) the unfinished quotes ---------------------------------------------------------------------
create or replace function public.my_unfinished_quotes(p_scope text default 'mine', p_limit int default 20, p_offset int default 0,
                                                       p_quote uuid default null, p_max_days int default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- flow-progress-0206
declare
  v_uid uuid := auth.uid(); v_org uuid := public.current_org_id();
  v_scope text := lower(btrim(coalesce(p_scope, 'mine')));
  v_lim int := greatest(1, least(coalesce(p_limit, 20), 100));
  v_off int := greatest(0, least(coalesce(p_offset, 0), 100000));
  v_edit boolean := false; v_locked boolean := false; v_total int := 0; v_rows jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_org is null or not coalesce(public.has_area('quotes', 'view'), false) then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'can_edit', false, 'steps_total', 8);   -- quietly nothing
  end if;
  if v_scope not in ('mine', 'studio') then raise exception 'scope must be mine or studio' using errcode = '22023'; end if;
  if p_max_days is not null and (p_max_days < 1 or p_max_days > 3650) then
    raise exception 'max_days must be 1 to 3650' using errcode = '22023';
  end if;
  v_edit := coalesce(public.has_area('quotes', 'edit'), false);
  -- editing blocked while the studio is read-only (suspended / ended trial): the page hides Continue-to-edit
  begin
    if to_regprocedure('public._studio_writable(uuid)') is not null then
      execute 'select not public._studio_writable($1)' into v_locked using v_org;
    end if;
    if not coalesce(v_locked, false) and to_regprocedure('public._trial_locked(uuid)') is not null then
      execute 'select coalesce(public._trial_locked($1), false)' into v_locked using v_org;
    end if;
  exception when others then v_locked := false;
  end;

  with base as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.client, q.updated_at, q.created_at,
           (coalesce(btrim(q.client ->> 'name'), '') <> '' or coalesce(btrim(q.event_type), '') <> '' or q.event_date is not null
            or not (coalesce(btrim(q.title), '') in ('', 'Untitled event') or btrim(q.title) = btrim(coalesce(q.code, ''))
                    or btrim(q.title) ~ '^[0-9]{8}-[0-9]{2,}$')) as filled
      from public.quotes q
     where q.org_id = v_org and (p_quote is null or q.id = p_quote)
       and q.deleted_at is null and q.archived_at is null and q.auto_discarded_at is null
       and coalesce(q.status, 'quote') = 'quote' and coalesce(q.lifecycle_stage, 'quote') in ('lead', 'discovery', 'proposal', 'quote')
       and coalesce(q.approval_status, 'none') = 'none' and q.approval_token is null and q.confirmed_at is null
       and not coalesce(q.is_demo, false)
       and not exists (select 1 from public.quotation_versions qv where qv.quote_id = q.id)
  ), x as (
    select b.*, me.last_step as my_step, me.last_step_at as my_step_at, me.dismissed_at as my_dismissed_at,
           lst.user_id as last_user, lst.last_step, lst.last_step_at, cr.created_by,
           public._flow_steps_done(b.id) as done
      from base b
      left join lateral (select fp.last_step, fp.last_step_at, fp.dismissed_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.user_id = v_uid and fp.org_id = v_org) me on true
      left join lateral (select fp.user_id, fp.last_step, fp.last_step_at from public.quote_flow_progress fp
                          where fp.quote_id = b.id and fp.org_id = v_org and fp.last_step is not null
                          order by fp.last_step_at desc, fp.user_id limit 1) lst on true
      left join lateral (select v.created_by from public.quote_versions v where v.quote_id = b.id and v.version_no = 1
                          order by v.created_at limit 1) cr on true
  ), y as (
    select x.*, greatest(x.updated_at, case when v_scope = 'mine' then x.my_step_at else x.last_step_at end) as activity
      from x
     where (x.filled or x.last_user is not null or cardinality(x.done) > 0)                  -- has some content (not a 0141 empty draft)
       and (v_scope = 'studio'
            or (x.my_dismissed_at is null
                and (x.my_step is not null or (x.last_user is null and x.created_by = v_uid))))
  ), z as (
    select y.* from y where p_max_days is null or y.activity > now() - make_interval(days => p_max_days)
  )
  select (select count(*) from z),
         coalesce((select jsonb_agg(r0.r order by r0.ord) from (
           select row_number() over (order by z.activity desc nulls last, z.id) as ord,
                  jsonb_strip_nulls(jsonb_build_object(
                    'id', z.id, 'code', z.code, 'title', z.title, 'event_type', z.event_type, 'event_date', z.event_date,
                    'client', jsonb_strip_nulls(jsonb_build_object(
                       'name', nullif(btrim(coalesce(z.client ->> 'name', '')), ''),
                       'city', case when jsonb_typeof(z.client -> 'city') = 'string' then z.client ->> 'city' end,
                       'venue', case when jsonb_typeof(z.client -> 'venue') = 'string' then z.client ->> 'venue' end,
                       'address', case when jsonb_typeof(z.client -> 'address') = 'string' then z.client ->> 'address' end,
                       'guests', case when jsonb_typeof(z.client -> 'guests') in ('number', 'string') then z.client -> 'guests' end,
                       'eventDate', case when jsonb_typeof(z.client -> 'eventDate') = 'string' then z.client ->> 'eventDate' end)),
                    'my_step', z.my_step, 'my_step_at', z.my_step_at,
                    'last_step', z.last_step, 'last_step_at', z.last_step_at,
                    'last_user_id', z.last_user, 'last_by_me', (z.last_user = v_uid),
                    'last_user_name', (select coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''))
                                         from public.profiles p where p.id = z.last_user and p.org_id = v_org),
                    'created_by_me', (z.created_by = v_uid),
                    'steps_done', to_jsonb(z.done), 'steps_total', 8,
                    'activity', z.activity, 'updated_at', z.updated_at)) as r
             from z order by z.activity desc nulls last, z.id
            limit v_lim offset v_off) r0(ord, r)), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows, 'can_edit', v_edit and not coalesce(v_locked, false),
                            'read_only', coalesce(v_locked, false), 'steps_total', 8, 'scope', v_scope);
end $$;
revoke all on function public.my_unfinished_quotes(text, int, int, uuid, int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_unfinished_quotes(text, int, int, uuid, int) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_unfinished_quotes(text, int, int, uuid, int) to authenticated'; end if;
end $$;

-- ---- 6) 0141: opening an empty draft does not make it "not empty" ------------------------------------
-- Same body as 0141 except the ignore list: quotes, quote_versions, audit_log AND quote_flow_progress.
create or replace function public._empty_draft_reason(p_quote_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- empty-drafts-0141
-- flow-progress-0206: quote_flow_progress (where someone last was in the flow) is ignored, like audit_log
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

-- ---- 7) trial retention (0184) knows the new table: it is one of the quote's own records ----------
-- Patched in place, the way 0198 / 0201 add their tables (skipped when 0184 is not installed). Nothing is
-- deleted by this file: the purge itself stays behind the owner switch (off by default).
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
  if position('''quote_flow_progress''' in v_def) > 0 then return; end if;
  -- 'quotes' appears exactly once in the list; the new table goes right before it (children first)
  if (length(v_def) - length(replace(v_def, '''quotes''', ''))) / length('''quotes''') <> 1 then
    raise notice '0206: _tr184_purge_tables has an unexpected body - left unchanged'; return;
  end if;
  execute replace(v_def, '''quotes''', '''quote_flow_progress'', ''quotes''');
end $$;

-- ---- VERIFY (read-only; see supabase/APPLY-0206.sql) ---------------------------------------------
-- select count(*) from public.quote_flow_progress;
-- select oid::regprocedure from pg_proc where proname in ('mark_flow_step', 'mark_flow_resume_dismissed', 'my_unfinished_quotes');

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 table quote_flow_progress exists with row security on',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.quote_flow_progress')), false)),
  ('02 the app may only read it (writes go through the functions)',
     has_table_privilege('authenticated', 'public.quote_flow_progress', 'select')
     and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'insert')
     and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'update')
     and not has_table_privilege('authenticated', 'public.quote_flow_progress', 'delete')
     and not has_table_privilege('anon', 'public.quote_flow_progress', 'select')),
  ('03 read policy limited to the own studio',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_flow_progress'
              and policyname = 'a206 flow progress read' and qual like '%current_org_id%')),
  ('04 read-only guard + quote/studio integrity trigger on the table',
     exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quote_flow_progress') and tgname = 'zzz_studio_read_only' and not tgisinternal)
     and exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quote_flow_progress') and tgname = 'zz_quote_org_match' and not tgisinternal)),
  ('05 functions are SECURITY DEFINER with an empty search_path',
     (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and 'search_path=""' = any(proconfig)
       and proname in ('mark_flow_step', 'mark_flow_resume_dismissed', 'my_unfinished_quotes', '_flow_steps_done')) = 4),
  ('06 signed-in app can call the three, anon none, helper internal',
     has_function_privilege('authenticated', 'public.mark_flow_step(uuid,text)', 'execute')
     and has_function_privilege('authenticated', 'public.mark_flow_resume_dismissed(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.my_unfinished_quotes(text,integer,integer,uuid,integer)', 'execute')
     and not has_function_privilege('anon', 'public.mark_flow_step(uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.my_unfinished_quotes(text,integer,integer,uuid,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._flow_steps_done(uuid)', 'execute')),
  ('07 empty-draft tidy-up ignores the new table',
     position('quote_flow_progress' in pg_get_functiondef('public._empty_draft_reason(uuid)'::regprocedure)) > 0),
  ('08 nobody signed in here -> the list is empty, no error',
     (public.my_unfinished_quotes('mine', 5, 0, null, null) ->> 'total')::int = 0),
  ('09 trial retention knows the new table (or 0184 is not installed)',
     to_regprocedure('public._tr184_purge_tables()') is null
     or 'quote_flow_progress' = any(public._tr184_purge_tables()))
) v(item, ok) order by item;
