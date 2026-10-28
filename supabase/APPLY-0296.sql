-- APPLY-0296.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0292 (any order with 0293-0295). It stops with "STOP 0296" if quotes / organizations / audit_log,
-- tg_quote_delete_guard (0026), the trial purge (0184) or _demo_clear (0097 / 0167 / 0169) are missing.
-- R55 zero-data-loss fix: nothing important can be deleted by accident any more.
--   * Events (quotes) - including ones on the Deleted shelf - their saved versions, invitation websites and crew
--     assignments, and the studio's vendors, staff, stock items and packages can no longer be hard-deleted through
--     the API (the screens never did; they shelve or switch off) nor by hand in the SQL editor.
--     (Dishes, chair / plate types and coupons are not guarded here: low-value settings.)
--   * A studio (organizations row) delete is skipped with a WARNING and logged in audit_log (studio.delete_refused).
--   * TRUNCATE of these tables is refused.
--   * Still works: Delete / Restore (the shelf), Deactivate, the free-trial purge (0184, unchanged), "clear sample
--     data", and every hard delete the screens use (leads, layouts, guests, attendees, media, files, unpaid
--     milestones, ...).
--   * Not guarded: Supabase Auth -> Users -> Delete user. It removes the person's profile + personal settings only
--     (a person who created events can't be deleted at all); profile deletes are already copied to audit_log.
-- New guard functions + triggers and one wrapper (_demo_clear; previous body kept as _demo_clear__pre0296).
-- No table, column, row, policy or grant changed or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  No site deploy needed (no app file changed).
--   3  Check: Quotes -> Delete an event -> it moves to the Deleted shelf; Restore brings it back. Settings ->
--      vendors / staff -> remove one -> it is switched off as before.
--   BREAK-GLASS (only if a real deletion is ever needed, one transaction in the SQL editor):
--      begin; select set_config('helm.allow_purge', '<studio uuid>', true); delete from public.quotes where id = '...'; commit;
--      begin; select set_config('helm.allow_org_purge', '<studio uuid>', true); delete from public.organizations where id = '...'; commit;
begin;
-- 0296_r55_no_accidental_deletes.sql - CANONICAL forward-only.
-- REQUIRES 0042 / 0049 (quotes shelf + delete policy), 0026 (tg_quote_delete_guard), 0097 / 0167 / 0169 (_demo_clear),
--          0184 (trial purge: sets helm.trial_purge_org while it deletes), audit_log.
--
-- In plain words (r55, owner TOP PRIORITY "zero data loss: nothing may be deleted by accident"):
--   * An event (quote) is never removed by Helm's screens: "Delete" only moves it to the Deleted shelf. But the
--     database still let a signed-in user with delete rights remove a shelved event for good with one direct API call
--     (the 0042 / 0049 shelf policy), and that took ~30 linked tables (versions, guests, tasks, files, booklets...) with
--     it. From now on a database guard refuses every hard delete of an event, of its version history and invitation
--     website and crew assignments (event_tasks), and of the studio's vendors, staff, stock items and packages - all
--     things the screens only ever switch off or shelve, never delete. The screens keep working exactly as before.
--   * A studio (organizations row) can no longer be deleted by hand (SQL editor, table editor): the delete is skipped,
--     a WARNING is shown and an audit_log row "studio.delete_refused" records the attempt. TRUNCATE of these tables is
--     refused too.
--   * The jobs that are SUPPOSED to delete still work:
--       - the free-trial purge (0184) already marks its studio with helm.trial_purge_org while it deletes: allowed for
--         that one studio only (nothing in 0184 changes);
--       - "clear sample data" (_demo_clear) now marks its studio with helm.allow_purge = <studio id> while it runs
--         (one small wrapper; the previous body is kept as _demo_clear__pre0296);
--       - a future studio-closure job sets helm.allow_purge (rows) / helm.allow_org_purge (studio row) to 'on' or to
--         the studio id with set_config(..., true) inside its own SECURITY DEFINER function.
--     These marks are honoured only for server code: a direct delete made AS a signed-in user / visitor (role
--     authenticated / anon) is refused even if the mark is somehow present.
--   * Not guarded here (low-value settings the screens also only switch off): dishes, chair / plate types, coupons.
--   * Not changed (the screens rely on these hard deletes; listed in the PR): leads (copied to lead_archive first),
--     layouts, guests, attendees, requirements, run-sheet, checklist, media, files, costs, refunds, expense claims,
--     unpaid payment milestones, nurture, change requests, saved views, chat membership.
--   * Not guarded: deleting a login in Supabase Auth (auth.users). It cascades to the person's profile and personal
--     settings only (business rows point at auth.users with NO ACTION, so a person who created events cannot be
--     deleted at all); profile deletes are already copied to audit_log by audit_trg. A guard there would break the
--     Auth dashboard "Delete user" button the owner still needs.
-- BREAK-GLASS (owner only, SQL editor, one transaction):
--   begin; select set_config('helm.allow_purge', '<studio uuid>', true); delete from public.quotes where ...; commit;
--   begin; select set_config('helm.allow_org_purge', '<studio uuid>', true); delete from public.organizations where id = ...; commit;
-- ZERO DATA LOSS: only new functions + triggers and one wrapper (previous body kept). No table, column, row, policy or
-- grant is changed or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop trigger zzzzz_r55_no_hard_delete on each table listed in section 3,
--   drop trigger a0_r55_org_delete_guard on public.organizations, drop the a0_r55_no_truncate triggers,
--   alter function public._demo_clear(uuid) rename to _demo_clear__r55_off;
--   alter function public._demo_clear__pre0296(uuid) rename to _demo_clear;

-- ---- 1) preflight (only objects production already has) ------------------------------------------------------
do $$ begin
  if to_regclass('public.quotes') is null or to_regclass('public.organizations') is null or to_regclass('public.audit_log') is null then
    raise exception 'STOP 0296: quotes / organizations / audit_log missing'; end if;
  if to_regprocedure('public.tg_quote_delete_guard()') is null then
    raise exception 'STOP 0296: tg_quote_delete_guard() missing - run 0026 first'; end if;
  if to_regprocedure('public._trial_retention_purge_org(uuid)') is null then
    raise exception 'STOP 0296: _trial_retention_purge_org(uuid) missing - run 0184 first'; end if;
  if to_regprocedure('public._demo_clear(uuid)') is null and to_regprocedure('public._demo_clear__pre0296(uuid)') is null then
    raise exception 'STOP 0296: _demo_clear(uuid) missing - run 0097 / 0167 / 0169 first'; end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'STOP 0296: auth.uid() missing'; end if;
end $$;

-- ---- 2) the one rule: may this delete go ahead? ----------------------------------------------------------------
-- Server code only (never a direct delete made as anon / authenticated), and only when it marked this studio
-- (or 'on' = any studio) for this transaction. helm.trial_purge_org is the mark 0184 already sets.
create or replace function public._r55_purge_allowed(p_org uuid, p_org_row boolean default false)
returns boolean language sql stable set search_path = '' as $$
  -- r55-no-hard-delete-0296
  select current_user::text not in ('anon', 'authenticated')
     and (   coalesce(current_setting('helm.allow_org_purge', true), '') in ('on', coalesce(p_org::text, 'on'))
          or (not p_org_row and (
                 coalesce(current_setting('helm.allow_purge', true), '') in ('on', coalesce(p_org::text, 'on'))
              or (p_org is not null and coalesce(current_setting('helm.trial_purge_org', true), '') = p_org::text))))
$$;
-- (callable by every role on purpose: it only reads this transaction's marks, and the row guard runs as the caller)

-- row guard: events, their history / website, and the master lists the screens only switch off
create or replace function public._r55_tg_no_hard_delete()
returns trigger language plpgsql set search_path = '' as $$
-- r55-no-hard-delete-0296
declare v_org uuid; v_what text;
begin
  begin v_org := (to_jsonb(OLD) ->> 'org_id')::uuid; exception when others then v_org := null; end;
  if public._r55_purge_allowed(v_org) then return OLD; end if;
  v_what := case tg_table_name
    when 'quotes' then 'An event can''t be permanently deleted. Use Delete (it moves to the Deleted shelf) or Cancel instead.'
    when 'quote_versions' then 'Saved quote versions are kept for good and can''t be deleted.'
    when 'quotation_versions' then 'Saved quote versions are kept for good and can''t be deleted.'
    when 'event_sites' then 'An invitation website can''t be permanently deleted. Unpublish it instead.'
    else 'This record can''t be permanently deleted. Switch it off (deactivate) instead.' end;
  raise exception '%', v_what
    using errcode = '42501', hint = 'r55_no_hard_delete', detail = 'table ' || tg_table_name || ', studio ' || coalesce(v_org::text, '-');
end $$;
revoke all on function public._r55_tg_no_hard_delete() from public;

-- studio guard: a refused delete is SKIPPED (so the audit row survives), with a WARNING.
-- The trigger runs as the caller (so the server-code check sees who deletes); only the audit insert is a definer helper.
create or replace function public._r55_log_org_refusal(p_org uuid, p_name text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
-- r55-no-hard-delete-0296
declare v_claims jsonb; v_uid uuid;
begin
  begin v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then v_claims := null; end;
  begin v_uid := auth.uid(); exception when others then v_uid := null; end;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
  values (v_uid, coalesce(v_claims ->> 'email', 'db:' || session_user::text), 'studio.delete_refused', 'organizations', p_org::text,
          jsonb_build_object('name', p_name, 'by_role', p_role, 'session_user', session_user::text,
                             'note', 'r55: studio delete refused (no helm.allow_org_purge mark)'),
          p_org, now());
end $$;
revoke all on function public._r55_log_org_refusal(uuid, text, text) from public;

create or replace function public._r55_tg_org_delete_guard()
returns trigger language plpgsql set search_path = '' as $$
-- r55-no-hard-delete-0296
begin
  if public._r55_purge_allowed(OLD.id, true) then return OLD; end if;
  perform public._r55_log_org_refusal(OLD.id, OLD.name, current_user::text);
  raise warning 'R55: studio % (%) was NOT deleted - studios are never deleted by hand. The attempt is in audit_log (studio.delete_refused).',
    OLD.name, OLD.id;
  return null;
end $$;
revoke all on function public._r55_tg_org_delete_guard() from public;

-- TRUNCATE guard (statement level): only with helm.allow_org_purge / helm.allow_purge = 'on', never as an API role
create or replace function public._r55_tg_no_truncate()
returns trigger language plpgsql set search_path = '' as $$
-- r55-no-hard-delete-0296
begin
  if current_user::text not in ('anon', 'authenticated')
     and (coalesce(current_setting('helm.allow_org_purge', true), '') = 'on'
          or (tg_table_name <> 'organizations' and coalesce(current_setting('helm.allow_purge', true), '') = 'on')) then
    return null; end if;
  raise exception 'TRUNCATE of % is refused (r55: Helm data is never wiped in bulk).', tg_table_name
    using errcode = '42501', hint = 'r55_no_hard_delete';
end $$;
revoke all on function public._r55_tg_no_truncate() from public;

-- ---- 3) attach (each table only when present; re-run safe) -----------------------------------------------------
-- The row guard is named zzzzz_ so it fires LAST: the existing, more specific refusals (0026 "has payments", read-only
-- studio, trial limits) keep their own messages. The studio guard is a0_ so it skips the delete before anything else.
do $$ declare t text; begin
  foreach t in array array['quotes', 'quote_versions', 'quotation_versions', 'event_sites', 'vendors', 'crew_members',
                           'inventory_items', 'menu_templates', 'event_tasks'] loop
    continue when to_regclass('public.' || t) is null;
    execute format('drop trigger if exists zzzzz_r55_no_hard_delete on public.%I', t);
    execute format('create trigger zzzzz_r55_no_hard_delete before delete on public.%I for each row execute function public._r55_tg_no_hard_delete()', t);
    execute format('drop trigger if exists a0_r55_no_truncate on public.%I', t);
    execute format('create trigger a0_r55_no_truncate before truncate on public.%I for each statement execute function public._r55_tg_no_truncate()', t);
  end loop;
  drop trigger if exists a0_r55_org_delete_guard on public.organizations;
  create trigger a0_r55_org_delete_guard before delete on public.organizations
    for each row execute function public._r55_tg_org_delete_guard();
  drop trigger if exists a0_r55_no_truncate on public.organizations;
  create trigger a0_r55_no_truncate before truncate on public.organizations
    for each statement execute function public._r55_tg_no_truncate();
end $$;

-- ---- 4) "clear sample data" marks its own studio while it runs (previous body kept once) ----------------------
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._demo_clear(uuid)'));
  if to_regprocedure('public._demo_clear__pre0296(uuid)') is null and v_src is not null
     and position('r55-no-hard-delete-0296' in v_src) = 0 then
    alter function public._demo_clear(uuid) rename to _demo_clear__pre0296;
  end if;
end $$;

create or replace function public._demo_clear(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r55-no-hard-delete-0296: sample (is_demo) rows of THIS studio may be deleted while the clear runs
declare v_prev text := coalesce(current_setting('helm.allow_purge', true), ''); r jsonb;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if v_prev <> 'on' then perform set_config('helm.allow_purge', p_org::text, true); end if;
  r := public._demo_clear__pre0296(p_org);
  perform set_config('helm.allow_purge', v_prev, true);
  return r;
end $$;

do $$ begin
  revoke all on function public._demo_clear(uuid) from public;
  revoke all on function public._demo_clear__pre0296(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._demo_clear(uuid) from anon;
    revoke all on function public._demo_clear__pre0296(uuid) from anon;
    revoke all on function public._r55_log_org_refusal(uuid, text, text) from anon;
    revoke all on function public._r55_tg_no_hard_delete() from anon;
    revoke all on function public._r55_tg_org_delete_guard() from anon;
    revoke all on function public._r55_tg_no_truncate() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._demo_clear(uuid) from authenticated;
    revoke all on function public._demo_clear__pre0296(uuid) from authenticated;
    revoke all on function public._r55_log_org_refusal(uuid, text, text) from authenticated;
    revoke all on function public._r55_tg_no_hard_delete() from authenticated;
    revoke all on function public._r55_tg_org_delete_guard() from authenticated;
    revoke all on function public._r55_tg_no_truncate() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._demo_clear(uuid) to service_role; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 every guarded table that exists has the hard-delete guard',
     (select count(*) from unnest(array['quotes', 'quote_versions', 'quotation_versions', 'event_sites', 'vendors', 'crew_members',
                                        'inventory_items', 'menu_templates', 'event_tasks']) t
       where to_regclass('public.' || t) is not null
         and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zzzzz_r55_no_hard_delete'
                           and not g.tgisinternal and g.tgenabled <> 'D')) = 0),
  ('02 events (quotes) are guarded (fires after the 0026 money guard, which keeps its own message)',
     exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzzz_r55_no_hard_delete' and tgenabled <> 'D')
     and exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'aa_quote_delete_guard')),
  ('03 studio delete guard on organizations',
     exists (select 1 from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname = 'a0_r55_org_delete_guard' and tgenabled <> 'D')),
  ('04 TRUNCATE guards on quotes and organizations',
     (select count(*) from pg_trigger where tgname = 'a0_r55_no_truncate' and tgrelid in ('public.quotes'::regclass, 'public.organizations'::regclass)) = 2),
  ('05 here (no purge mark) nothing may be deleted',
     not public._r55_purge_allowed(gen_random_uuid()) and not public._r55_purge_allowed(gen_random_uuid(), true)),
  ('06 purge marks are honoured for server code only, never for a direct delete as anon / authenticated',
     position('not in (''anon'', ''authenticated'')' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._r55_purge_allowed(uuid,boolean)')), '')) > 0
     and position('helm.trial_purge_org' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._r55_purge_allowed(uuid,boolean)')), '')) > 0),
  ('07 "clear sample data" marks its own studio (0296 wrapper), previous body kept as _demo_clear__pre0296',
     position('r55-no-hard-delete-0296' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._demo_clear(uuid)')), '')) > 0
     and to_regprocedure('public._demo_clear__pre0296(uuid)') is not null),
  ('08 the app cannot call _demo_clear / its kept body / the studio-refusal logger / the guard trigger functions',
     not has_function_privilege('authenticated', 'public._demo_clear(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r55_tg_no_hard_delete()', 'execute')
     and not has_function_privilege('authenticated', 'public._r55_tg_org_delete_guard()', 'execute')
     and not has_function_privilege('authenticated', 'public._r55_tg_no_truncate()', 'execute')
     and not has_function_privilege('authenticated', 'public._demo_clear__pre0296(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r55_log_org_refusal(uuid,text,text)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or (not has_function_privilege('anon', 'public._demo_clear(uuid)', 'execute')
              and not has_function_privilege('anon', 'public._r55_log_org_refusal(uuid,text,text)', 'execute')))),
  ('09 the free-trial purge (0184) is unchanged and still marks its studio (helm.trial_purge_org)',
     position('helm.trial_purge_org' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._trial_retention_purge_org(uuid)')), '')) > 0),
  ('10 guard functions run with an empty search_path',
     (select count(*) from pg_proc where oid in (to_regprocedure('public._r55_purge_allowed(uuid,boolean)'), to_regprocedure('public._r55_tg_no_hard_delete()'),
        to_regprocedure('public._r55_tg_org_delete_guard()'), to_regprocedure('public._r55_tg_no_truncate()'), to_regprocedure('public._r55_log_org_refusal(uuid,text,text)'))
        and coalesce(array_to_string(proconfig, ','), '') like '%search_path=""%') = 5),
  ('11 the screens'' own hard deletes untouched (no guard on leads / layouts / guests / attendees / milestones)',
     not exists (select 1 from pg_trigger where tgname like '%r55%' and tgrelid::regclass::text in
       ('leads', 'layouts', 'event_guests', 'event_attendees', 'payment_milestones', 'event_media', 'event_files'))),
  ('12 nothing removed: the 0042 shelf policy and the quotes / organizations tables are still there',
     exists (select 1 from pg_policy where polrelid = 'public.quotes'::regclass and polname = 'a42 quotes delete from shelf')
     and to_regclass('public.organizations') is not null)
) v(item, ok) order by item;
