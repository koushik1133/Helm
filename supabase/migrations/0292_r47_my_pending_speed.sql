-- 0292_r47_my_pending_speed.sql - CANONICAL forward-only.
-- REQUIRES 0036 (my_pending, _notify_hidden_types, notification_type_of, notification_seen), 0043 / 0283 (current_org_id),
--          0250 (_notify_hidden_types wrapper: security_alert always hidden).
--
-- In plain words (r47: production logged two "500" errors on POST /rest/v1/rpc/my_pending, 26 Oct 2026 13:09 UTC):
--   my_pending feeds the dashboard ("Upcoming & my tasks" + the "N unread" badge). Its unread count asks
--   _notify_hidden_types "which notification types has this person switched off?". Postgres folded that question into
--   the count, so it was worked out again FOR EVERY UNREAD NOTIFICATION ROW. Each answer walks the whole notification
--   catalog (28 types, each through the notify_* settings chain) - about 0.8 s per row on a test machine. A person with
--   only ~10 unread notifications therefore needed longer than the API time limit (8 s for signed-in users), the
--   database cancelled the call (SQLSTATE 57014) and the API answered 500. The dashboard calls it twice per load (the
--   page + the new shell), which is why there were two 500s one second apart.
--   Fix: my_pending is re-issued as a small plpgsql function that
--     * works the hidden types out ONCE per call (not per row),
--     * counts unread rows grouped by (kind, channel) first, so the type of each kind / channel pair is looked up once
--       (and only works the hidden types out when something is unread at all),
--     * answers {upcoming: [], unread: 0} straight away when there is no signed-in person or no studio (signed out,
--       deactivated, two-step not finished, temporary password, no studio) instead of running any query,
--     * never turns a failure of one part into a 500: if the upcoming list or the unread count fails, that part is
--       empty / 0 and the answer carries "degraded": true (a cancel / statement timeout is never swallowed).
--   Same rules, same result shape (upcoming, unread, as_of), same studio / area scoping (has_area('quotes','view')).
--   Events on the same date now keep a fixed order (most recently updated first) instead of whatever the sort gave.
--   The previous body is kept once as my_pending__pre0292 (not callable by the app) for reference / rollback.
-- ZERO DATA LOSS: one function re-issued (same name, arguments, result, grants), one renamed copy kept. No table,
-- column, row, policy or index is created, changed or deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): alter function public.my_pending() rename to my_pending__r47_off;
--   alter function public.my_pending__pre0292() rename to my_pending; grant execute on function public.my_pending()
--   to authenticated;

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.my_pending()') is null and to_regprocedure('public.my_pending__pre0292()') is null then
    raise exception 'STOP 0292: public.my_pending() missing - run 0036 first'; end if;
  if to_regprocedure('public._notify_hidden_types(uuid,uuid)') is null then
    raise exception 'STOP 0292: public._notify_hidden_types(uuid, uuid) missing - run 0036 first'; end if;
  if to_regprocedure('public.notification_type_of(text,text)') is null then
    raise exception 'STOP 0292: public.notification_type_of(text, text) missing - run 0036 first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.has_area(text,text)') is null then
    raise exception 'STOP 0292: current_org_id() / has_area(text, text) missing'; end if;
  if to_regclass('public.notification_seen') is null or to_regclass('public.event_tasks') is null then
    raise exception 'STOP 0292: notification_seen / event_tasks missing'; end if;
end $$;

-- ---- 2) keep the previous body once (rename-once; a re-run leaves the kept copy alone) ----------------------
do $$ declare v_src text; begin
  v_src := (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_pending()'));
  if to_regprocedure('public.my_pending__pre0292()') is null and v_src is not null
     and position('r47-my-pending-0292' in v_src) = 0 then
    alter function public.my_pending() rename to my_pending__pre0292;
  end if;
  if to_regprocedure('public.my_pending__pre0292()') is not null then
    revoke all on function public.my_pending__pre0292() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on function public.my_pending__pre0292() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on function public.my_pending__pre0292() from authenticated; end if;
  end if;
end $$;

-- ---- 3) my_pending: same answer, worked out once per call, never a 500 for an empty / unauthorised state ------
create or replace function public.my_pending()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r47-my-pending-0292: hidden types once per call, unread grouped by kind / channel, empty answer when signed out /
-- no studio, a failing part degrades to empty instead of failing the call
declare
  v_uid uuid; v_org uuid; v_view boolean := false; v_hid text[] := '{}'::text[]; v_seen timestamptz;
  v_up jsonb := '[]'::jsonb; v_unread integer := 0; v_degraded boolean := false;
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

  -- upcoming events (quotes view only), with the per-event open / done task rollup
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

  -- unread: notifications since the person last opened the bell, minus the types they switched off.
  -- The rows are grouped by (kind, channel) FIRST (materialized, so the type filter is never pushed back down to
  -- every row), and the hidden types are only worked out when there is something unread at all.
  begin
    v_seen := coalesce((select s.last_seen_at from public.notification_seen s where s.user_id = v_uid), '-infinity'::timestamptz);
    if exists (select 1 from public.notifications n where n.org_id = v_org and n.created_at > v_seen) then
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
    end if;
  exception when others then
    v_unread := 0; v_degraded := true;
  end;

  return jsonb_build_object('upcoming', coalesce(v_up, '[]'::jsonb), 'unread', coalesce(v_unread, 0), 'as_of', now())
         || case when v_degraded then jsonb_build_object('degraded', true) else '{}'::jsonb end;
end $$;

-- ---- 4) grants: as before (signed-in users only) -------------------------------------------------------------
do $$ begin
  revoke all on function public.my_pending() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.my_pending() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_pending() to authenticated; end if;
end $$;

notify pgrst, 'reload schema';
