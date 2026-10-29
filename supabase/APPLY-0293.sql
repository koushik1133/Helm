-- APPLY-0293.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0292 (needs 0261 / 0266 / 0270 / 0292 - all on production; 0117 NOT needed). It stops with "STOP 0293" if
-- a piece it builds on is missing.
-- R52 fix for "notifications are not clearing":
--   1  The dashboard "N unread" (my_pending) counted every studio notification newer than the last "Mark all read",
--      ignoring the person's own "Mark read" / "Done" / snooze, personal mutes and the rows their role cannot see -
--      so after reading everything in the bell the dashboard still said e.g. "8 unread". It now shows exactly the
--      bell badge (the person's own inbox unread count).
--   2  A manager / coordinator / sales badge counted client follow-ups addressed to someone else (hidden from the
--      bell list), so it could never reach 0. The inbox now hides them exactly like the bell list.
--   3  The notification type list was worked out 81 times per read (each layer read the one below 3 times): the bell
--      took ~5 s and Control Center -> Notifications ~30 s (timed out). Now read once per layer: same list, fast.
--      Also locks two old 0078 bodies the app could still call (audit I-06).
-- Per person (one person's clearing never clears anyone else's). Two functions re-issued (same names / arguments /
-- answers / grants), previous bodies kept as my_pending__pre0293 / _r23_visible__pre0293 / notification_catalog__pre0293
-- (not callable by the app); the kept catalog layers only get "offset 0" (same answer).
-- No table, row, policy or index touched. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (the R52 frontend changes ship in the same PR).
--   3  Check: as a manager, open the bell, open / mark read every row -> the bell badge AND the dashboard
--      "N unread" both disappear; "Mark all read" clears both too; a new notification shows 1 in both.
--      Control Center -> Notifications opens within a second or two (it timed out before).
begin;
-- 0293_r52_notifications_clear.sql - CANONICAL forward-only.
-- REQUIRES 0266 + 0270 (per-person inbox: _r23_visible / _r23_rows / _r23_counts, notification_inbox_state),
--          0261 (client link view rows in the bell), 0292 (my_pending), 0036 / phase48 (notification_seen).
--
-- In plain words (r52 bug report from a studio user: "notifications are not clearing"):
--   Since 0266 every person has their OWN read / Done / Snooze marks (notification_inbox_state) and the bell badge
--   counts "unread in MY inbox". Two places still disagreed with that, so a count stayed up after it was cleared:
--   1  my_pending (the dashboard "N unread" badge on "My events & tasks") still counted the OLD way: every studio
--      notification newer than the last "Mark all read" time, minus switched-off types. It ignored a person's own
--      "Mark read" / "Done" (clicking a row in the bell, the /inbox page, its filtered "Mark all read"), their
--      personal mutes, and the rows their role may not see at all (money rows for crew, price changes for people who
--      cannot edit quotes, close requests for non-approvers, client link views). So after reading everything in the
--      bell the dashboard still said e.g. "8 unread" - and only the bell's unfiltered "Mark all read" cleared it.
--      Fix: my_pending's unread is now exactly the bell badge: the person's inbox unread count (_r23_counts), plus
--      Helm HQ notices for platform operators like the bell. Still fast: nothing is worked out when nothing can be
--      unread (no row newer than the last "Mark all read" and no row marked unread / back from a snooze), and the
--      person's rules are worked out once per call. If the inbox part fails, the previous (0292) count is used and
--      the answer says "degraded": true; a cancel / statement timeout is never swallowed.
--   2  Managers / coordinators / sales (anyone with Quotes view who is not an admin): the bell list hides client
--      "follow-up" rows addressed to someone else and hides client "link viewed" rows from people without Quotes
--      view (0261), but the inbox (and so the bell BADGE) still counted them. Those rows could never be opened or
--      marked read from the bell, so the badge never reached 0 ("2 unread" with nothing unread in the list).
--      Fix: the inbox visibility rule (_r23_visible) applies the same 0261 rule, so badge = list = /inbox.
--   3  Slowness (audit 2026-10-28 I-01): every notification catalog layer (0054 .. 0285) read the layer below three
--      times, so one catalog read ran the oldest list 81 times. The bell took ~5 s, the inbox / my settings ~2.5 s and
--      Control Center -> Notifications ~30 s (over the 8 s API limit, so it timed out and nothing could be changed).
--      Fix: notification_catalog() is re-issued as plpgsql reading the layer below once; the kept layers get
--      "offset 0" so each reads its own layer below once. Same list, byte for byte (the DB test compares).
--      Audit I-06: notification_catalog__pre0078 / notification_type_of__pre0078 are no longer callable by the app.
--   Per person, never per studio: one person's read / Done never clears anyone else's (unchanged).
-- ZERO DATA LOSS: three functions re-issued (same names, arguments, results, grants); each previous body kept once as
-- *__pre0293 (not callable by the app); kept catalog layers patched in place (only "offset 0" added - same answer).
-- No table, column, row, policy or index is created, changed or deleted.
-- Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   alter function public.my_pending() rename to my_pending__r52_off;
--   alter function public.my_pending__pre0293() rename to my_pending; grant execute on function public.my_pending() to authenticated;
--   alter function public._r23_visible(uuid, uuid) rename to _r23_visible__r52_off;
--   alter function public._r23_visible__pre0293(uuid, uuid) rename to _r23_visible;
--   alter function public.notification_catalog() rename to notification_catalog__r52_off;
--   alter function public.notification_catalog__pre0293() rename to notification_catalog;
--   grant execute on function public.notification_catalog() to authenticated;   (the "offset 0" layers can stay)

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r23_visible(uuid,uuid)') is null and to_regprocedure('public._r23_visible__pre0293(uuid,uuid)') is null then
    raise exception 'STOP 0293: public._r23_visible(uuid, uuid) missing - run 0266 first'; end if;
  if to_regprocedure('public._r23_rows(uuid,uuid)') is null or to_regprocedure('public._r23_counts(uuid,uuid)') is null
     or to_regprocedure('public._r23_area(uuid,text,text,text)') is null or to_regprocedure('public._r23_detail(jsonb,boolean)') is null then
    raise exception 'STOP 0293: the 0266 inbox helpers (_r23_rows / _r23_counts / _r23_area / _r23_detail) are missing - run 0266 first'; end if;
  if to_regclass('public.notification_inbox_state') is null or to_regclass('public.notification_mutes') is null
     or to_regclass('public.notification_seen') is null or to_regclass('public.event_tasks') is null then
    raise exception 'STOP 0293: notification_inbox_state / notification_mutes / notification_seen / event_tasks missing'; end if;
  if to_regprocedure('public.my_pending()') is null and to_regprocedure('public.my_pending__pre0293()') is null then
    raise exception 'STOP 0293: public.my_pending() missing - run 0292 first'; end if;
  if to_regprocedure('public.notification_catalog()') is null then
    raise exception 'STOP 0293: public.notification_catalog() missing - run 0036 first'; end if;
  if to_regprocedure('public._notify_hidden_types(uuid,uuid)') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.is_platform_operator()') is null then
    raise exception 'STOP 0293: _notify_hidden_types / notification_type_of / current_org_id / has_area / is_platform_operator missing'; end if;
end $$;

-- ---- 2) keep the previous bodies once (rename-once; a re-run leaves the kept copies alone) ----------------------
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)'));
  if to_regprocedure('public._r23_visible__pre0293(uuid,uuid)') is null and v_src is not null
     and position('r52-notif-0293' in v_src) = 0 then
    alter function public._r23_visible(uuid, uuid) rename to _r23_visible__pre0293;
  end if;
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_pending()'));
  if to_regprocedure('public.my_pending__pre0293()') is null and v_src is not null
     and position('r52-notif-0293' in v_src) = 0 then
    alter function public.my_pending() rename to my_pending__pre0293;
  end if;
  if to_regprocedure('public._r23_visible__pre0293(uuid,uuid)') is not null then
    revoke all on function public._r23_visible__pre0293(uuid, uuid) from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public._r23_visible__pre0293(uuid, uuid) from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public._r23_visible__pre0293(uuid, uuid) from authenticated; end if;
  end if;
  if to_regprocedure('public.my_pending__pre0293()') is not null then
    revoke all on function public.my_pending__pre0293() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public.my_pending__pre0293() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public.my_pending__pre0293() from authenticated; end if;
  end if;
end $$;

-- ---- 3) the inbox visibility rule = the bell list (adds the 0261 client link view rule) -------------------------
create or replace function public._r23_visible(p_org uuid, p_uid uuid)
returns table(id uuid, kind text, channel text, status text, detail jsonb, created_at timestamptz, quote_id uuid, ntype text)
language sql stable security definer set search_path = '' as $$
  -- r23-inbox-0266 + r24-ci-0270 ("me" materialized: the person's rules once per call) + r52-notif-0293 (the 0261 bell
  -- rule: client link views only for Quotes viewers, a follow-up addressed to named people only for them; admins all)
  with me as materialized (
    select public._r23_area(p_org, p.role, 'quotes', 'view') as qv,
           public._r23_area(p_org, p.role, 'quotes', 'edit') as qe,
           (coalesce(p.role, '') in ('admin', 'manager', 'coordinator') or public._r23_area(p_org, p.role, 'closure', 'view')) as cl,
           (coalesce(p.role, '') = 'admin') as adm,
           coalesce(public._notify_hidden_types(p_org, p_uid), '{}'::text[]) as hid,
           coalesce((select array_agg(m.type) from public.notification_mutes m where m.user_id = p_uid and m.org_id = p_org), '{}'::text[]) as mut
      from public.profiles p
     where p.id = p_uid and p.org_id = p_org and p_org is not null
  )
  select n.id, n.kind, n.channel, n.status, public._r23_detail(n.detail, me.qv), n.created_at, n.quote_id, t.ty
    from me
    join public.notifications n on n.org_id = p_org
    cross join lateral (select public.notification_type_of(n.kind, n.channel) as ty) t
   where coalesce(n.kind, '') <> 'security_alert'
     and not (t.ty = any (me.hid))
     and not (t.ty = any (me.mut))
     and (me.qe or coalesce(n.kind, '') <> 'price_change')
     and (me.qv or coalesce(n.kind, '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)')
     and (me.cl or coalesce(n.kind, '') not in ('event_close_request', 'event_close_decision'))
     and (me.adm
          or coalesce(n.kind, '') not in ('client_link_viewed', 'client_view_followup')
          or (me.qv
              and not (n.kind = 'client_view_followup'
                       and jsonb_typeof(n.detail -> 'notify') = 'array'
                       and jsonb_array_length(n.detail -> 'notify') > 0
                       and not ((n.detail -> 'notify') ? p_uid::text))));
$$;

-- ---- 4) my_pending: the dashboard unread badge = the bell badge (per person inbox) ------------------------------
create or replace function public.my_pending()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r47-my-pending-0292 + r52-notif-0293: unread = the person's inbox unread (same as the bell badge: own read / Done /
-- snooze, mutes, role visibility), worked out only when something can be unread; empty answer when signed out / no
-- studio; a failing part degrades instead of failing the call
declare
  v_uid uuid; v_org uuid; v_view boolean := false; v_hid text[] := '{}'::text[]; v_seen timestamptz;
  v_up jsonb := '[]'::jsonb; v_unread integer := 0; v_hq integer := 0; v_degraded boolean := false;
begin
  begin
    v_uid := auth.uid();
    v_org := public.current_org_id();
  exception when others then
    v_uid := null; v_org := null;           -- a malformed token / missing helper reads as "no studio", never a 500
  end;
  if v_uid is null or v_org is null then
    return jsonb_build_object('upcoming', '[]'::jsonb, 'unread', 0, 'as_of', now());
  end if;

  -- upcoming events (quotes view only), with the per-event open / done task rollup (unchanged from 0292)
  begin
    v_view := coalesce(public.has_area('quotes', 'view'), false);
    if v_view then
      select coalesce(jsonb_agg(to_jsonb(ev) - 'r47_upd' order by (ev.event_date is null), ev.event_date, ev.r47_upd desc, ev.id), '[]'::jsonb) into v_up
        from (
          select q.id, q.code, q.title, q.event_type, q.event_date, q.event_time, q.lifecycle_stage,
                 (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is null)     as open_tasks,
                 (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is not null) as done_tasks,
                 q.updated_at as r47_upd
            from public.quotes q
           where q.org_id = v_org
             and coalesce(q.lifecycle_stage, '') <> 'closed'
           order by q.event_date nulls last, q.updated_at desc, q.id
           limit 25
        ) ev;
    end if;
  exception when others then
    v_up := '[]'::jsonb; v_degraded := true;
  end;

  -- unread = the person's inbox unread count (what the bell badge shows). A row can only be unread when it is newer
  -- than the last "Mark all read" time or the person's own state says unread / back from a snooze - when neither
  -- exists the answer is 0 without working anything out.
  begin
    v_seen := coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = v_uid), '-infinity'::timestamptz);
    if exists (select 1 from public.notifications n where n.org_id = v_org and n.created_at > v_seen)
       or exists (select 1 from public.notification_inbox_state st
                   where st.user_id = v_uid and st.org_id = v_org and st.done_at is null
                     and (st.unread_at is not null or st.snooze_returned_at is not null
                          or (st.snoozed_until is not null and st.snoozed_until <= now()))) then
      v_unread := coalesce((public._r23_counts(v_org, v_uid) ->> 'unread')::integer, 0);
    end if;
  exception when others then
    -- inbox part failed: the previous (0292) count, flagged degraded (a cancel / timeout is never caught here)
    v_degraded := true; v_unread := 0;
    begin
      v_hid := coalesce(public._notify_hidden_types(v_org, v_uid), '{}'::text[]);
      with g as materialized (
        select n.kind, n.channel, count(*) as c
          from public.notifications n
         where n.org_id = v_org
           and n.created_at > v_seen
         group by n.kind, n.channel
      )
      select coalesce(sum(g.c), 0)::integer into v_unread
        from g
       where not (public.notification_type_of(g.kind, g.channel) = any (v_hid));
    exception when others then
      v_unread := 0;
    end;
  end;

  -- Helm HQ notices for platform operators, exactly as the bell badge adds them (0250 / 0266)
  begin
    if to_regclass('public.hq_security_notices') is not null and to_regclass('public.hq_security_seen') is not null
       and public.is_platform_operator() then
      select count(*) into v_hq from public.hq_security_notices n
       where n.last_at > greatest(coalesce((select max(s.last_seen_at) from public.hq_security_seen s where s.user_id = v_uid), 'epoch'::timestamptz),
                                  coalesce((select max(s.last_seen_at) from public.notification_seen s where s.user_id = v_uid), 'epoch'::timestamptz));
    end if;
  exception when others then
    v_hq := 0; v_degraded := true;
  end;

  return jsonb_build_object('upcoming', coalesce(v_up, '[]'::jsonb), 'unread', coalesce(v_unread, 0) + coalesce(v_hq, 0), 'as_of', now())
         || case when v_degraded then jsonb_build_object('degraded', true) else '{}'::jsonb end;
end $$;

-- ---- 5) the notification catalog: worked out once per layer (was 3x per layer -> the oldest body 81x per read) -----
-- Each catalog layer (0054 .. 0285) reads the layer below as "from (select previous() as c) x" and uses c three times.
-- Postgres folds that one-row subquery into its parent, so each use called the layer below again: 3 x 3 x 3 x 3 ...
-- (measured: one catalog read = the oldest body 81 times; bell_feed ~5 s, inbox_feed / my_notification_prefs ~2.5 s,
-- admin_get_notification_prefs ~30 s, over the 8 s API limit). "offset 0" keeps that subquery on its own, so each
-- layer asks the one below ONCE. Same text otherwise, same answer. Patched in place only where the pattern is found
-- exactly once (a body that looks different is left alone with a notice).
do $$ declare f record; v_def text; v_new text; v_pat text := '(select\s+public\.notification_catalog__pre\d{4}\(\)\s+as\s+c)\s*\)\s*x';
begin
  for f in select p.oid, p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.pronargs = 0 and p.proname ~ '^notification_catalog__pre\d{4}$'
              and p.proname <> 'notification_catalog__pre0293' loop
    if position('r52-notif-0293' in f.prosrc) > 0 then continue; end if;
    if (select count(*) from regexp_matches(f.prosrc, v_pat, 'g')) = 0 then continue; end if;   -- the 0036 base list
    if (select count(*) from regexp_matches(f.prosrc, v_pat, 'g')) <> 1 then
      raise notice '0293: public.%() has an unexpected body - left unchanged', f.proname; continue; end if;
    v_def := pg_get_functiondef(f.oid);
    v_new := regexp_replace(v_def, v_pat, '\1 offset 0 /* r52-notif-0293: worked out once */) x');
    if v_new = v_def then raise notice '0293: public.%() not patched', f.proname; continue; end if;
    execute v_new;
  end loop;
end $$;

-- the catalog itself: re-issued as plpgsql (never folded or inlined), the layer below read ONCE into a variable,
-- the same 0285 addition (studio_security, once). Only while the live body is the 0285 one (or this one); any other
-- body is left as it is and only gets the "offset 0" patch above via its kept layers (notice).
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()'));
  if position('r52-notif-0293' in coalesce(v_src, '')) = 0 and to_regprocedure('public.notification_catalog__pre0293()') is null then
    if position('r35-0285' in coalesce(v_src, '')) = 0 or to_regprocedure('public.notification_catalog__pre0285()') is null then
      raise notice '0293: notification_catalog() is not the 0285 body - left unchanged'; return; end if;
    alter function public.notification_catalog() rename to notification_catalog__pre0293;
  end if;
  if to_regprocedure('public.notification_catalog__pre0293()') is not null then
    revoke all on function public.notification_catalog__pre0293() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public.notification_catalog__pre0293() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public.notification_catalog__pre0293() from authenticated; end if;
  end if;
  if to_regprocedure('public.notification_catalog__pre0285()') is null then
    raise notice '0293: notification_catalog__pre0285() missing - catalog left unchanged'; return; end if;
  if position('r52-notif-0293' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.notification_catalog()')), '')) = 0
     and to_regprocedure('public.notification_catalog__pre0293()') is null then return; end if;
  execute $f$
create or replace function public.notification_catalog()
returns jsonb language plpgsql immutable security definer set search_path = '' as $b$
-- r35-0285: + studio_security (once) / r52-notif-0293: plpgsql, the layer below read ONCE (was 3x per layer)
declare c jsonb := public.notification_catalog__pre0285();
begin
  return case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'studio_security') then c
    else c || $cat$[
    {"type":"studio_security","group":"System","label":"Payment details and sensitive settings",
     "description":"Payment details (UPI / bank) changed, cancelled or live; reply-to or business e-mail, online-payment keys, money access, admins added or removed, two-step turned off. Admins only.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end;
end $b$
$f$;
  revoke all on function public.notification_catalog() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.notification_catalog() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.notification_catalog() to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.notification_catalog() to service_role; end if;
end $$;

-- audit I-06: two superseded 0078 bodies were still callable by signed-in users (harmless fixed lists) - locked like
-- every other kept __preNNNN body
do $$ declare s text; begin
  foreach s in array array['public.notification_catalog__pre0078()', 'public.notification_type_of__pre0078(text, text)'] loop
    if to_regprocedure(s) is null then continue; end if;
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
end $$;

-- ---- 6) grants: as before ---------------------------------------------------------------------------------------
do $$ begin
  revoke all on function public.my_pending() from public;
  revoke all on function public._r23_visible(uuid, uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.my_pending() from anon;
    revoke all on function public._r23_visible(uuid, uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_pending() to authenticated;
    revoke all on function public._r23_visible(uuid, uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._r23_visible(uuid, uuid) to service_role; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 my_pending is the 0293 body (unread = the person''s inbox unread)',
     position('r52-notif-0293' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_pending()')), '')) > 0),
  ('02 _r23_visible is the 0293 body (0261 client link view rule)',
     position('r52-notif-0293' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._r23_visible(uuid,uuid)')), '')) > 0),
  ('03 both are security definer with an empty search path',
     coalesce((select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%') and count(*) = 2
                 from pg_proc p where p.oid in (to_regprocedure('public.my_pending()'), to_regprocedure('public._r23_visible(uuid,uuid)'))), false)),
  ('04 signed-in users can call my_pending; anon cannot',
     has_function_privilege('authenticated', 'public.my_pending()', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.my_pending()', 'execute'))),
  ('05 _r23_visible is not callable by the app',
     not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public._r23_visible(uuid,uuid)', 'execute'))),
  ('06 previous bodies kept once as my_pending__pre0293 / _r23_visible__pre0293',
     to_regprocedure('public.my_pending__pre0293()') is not null and to_regprocedure('public._r23_visible__pre0293(uuid,uuid)') is not null),
  ('07 the kept previous bodies are not callable by the app',
     not has_function_privilege('authenticated', 'public.my_pending__pre0293()', 'execute')
     and not has_function_privilege('authenticated', 'public._r23_visible__pre0293(uuid,uuid)', 'execute')
     and (not exists (select 1 from pg_roles where rolname = 'anon')
          or (not has_function_privilege('anon', 'public.my_pending__pre0293()', 'execute')
              and not has_function_privilege('anon', 'public._r23_visible__pre0293(uuid,uuid)', 'execute')))),
  ('08 my_pending keeps the answer shape (upcoming, unread, as_of) and studio / quotes-view scoping',
     coalesce((select position('''upcoming''' in p.prosrc) > 0 and position('''unread''' in p.prosrc) > 0 and position('''as_of''' in p.prosrc) > 0
                      and position('has_area(''quotes'', ''view'')' in p.prosrc) > 0 and position('current_org_id()' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.my_pending()')), false)),
  ('09 my_pending counts with the inbox (_r23_counts) and skips the work when nothing can be unread',
     coalesce((select position('_r23_counts(v_org, v_uid)' in p.prosrc) > 0 and position('notification_inbox_state' in p.prosrc) > 0
                 from pg_proc p where p.oid = to_regprocedure('public.my_pending()')), false)),
  ('10 signed out (no token) answers an empty feed, not an error',
     coalesce((public.my_pending() -> 'upcoming') = '[]'::jsonb and (public.my_pending() ->> 'unread')::int = 0, false)),
  ('11 the inbox helpers it needs are present',
     to_regprocedure('public._r23_counts(uuid,uuid)') is not null and to_regprocedure('public._r23_rows(uuid,uuid)') is not null
     and to_regprocedure('public.bell_feed(integer)') is not null and to_regprocedure('public.inbox_act(uuid[],text,timestamptz,text)') is not null),
  ('12 nothing removed: notifications, notification_seen, notification_inbox_state still there',
     to_regclass('public.notifications') is not null and to_regclass('public.notification_seen') is not null
     and to_regclass('public.notification_inbox_state') is not null),
  ('13 reading / clearing is never blocked by a studio read-only trigger (per-person state)',
     not exists (select 1 from pg_trigger t where not t.tgisinternal
                  and t.tgrelid in ('public.notification_seen'::regclass, 'public.notification_inbox_state'::regclass))),
  ('14 notification_catalog is the 0293 plpgsql body and gives the same list as the kept previous body',
     coalesce((select l.lanname = 'plpgsql' and position('r52-notif-0293' in p.prosrc) > 0
                 from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('public.notification_catalog()')), false)
     and to_regprocedure('public.notification_catalog__pre0293()') is not null
     and public.notification_catalog()::text = public.notification_catalog__pre0293()::text),
  ('15 every kept catalog layer reads the layer below once (offset 0)',
     not exists (select 1 from pg_proc p where p.proname ~ '^notification_catalog__pre[0-9]{4}$' and p.proname <> 'notification_catalog__pre0293'
                  and p.prosrc ~ 'select\s+public\.notification_catalog__pre[0-9]{4}\(\)\s+as\s+c\s*\)')),
  ('16 signed-in users can call notification_catalog; the kept body and the two 0078 bodies they cannot',
     has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')
     and not has_function_privilege('authenticated', 'public.notification_catalog__pre0293()', 'execute')
     and (to_regprocedure('public.notification_catalog__pre0078()') is null
          or not has_function_privilege('authenticated', 'public.notification_catalog__pre0078()', 'execute'))
     and (to_regprocedure('public.notification_type_of__pre0078(text,text)') is null
          or not has_function_privilege('authenticated', 'public.notification_type_of__pre0078(text,text)', 'execute')))
) v(item, ok) order by item;
