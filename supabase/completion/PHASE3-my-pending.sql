-- =====================================================================
-- PHASE 3 — my_pending(): personal dashboard feed (upcoming events + task rollup + unread)
-- =====================================================================
-- Returns, for the CALLER (org- and area-scoped), the active events they can see with
-- an open/done task rollup, plus an unread-notification count. Powers the dashboard
-- "Upcoming events + My pending tasks" widget (click an event → expand its tasks;
-- completed tasks shown collapsed).
--
-- SECURITY DEFINER but SAFE: explicitly filters org_id = current_org_id() and gates on
-- has_area('quotes','view') (so a role without quotes access gets an empty feed — same
-- rule as the RLS on quotes). auth.uid()/current_org_id() read the request JWT, so the
-- caller identity is honored even under definer.
-- Additive, idempotent (create or replace). Revoked from anon.
-- =====================================================================

create or replace function public.my_pending()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid, public.current_org_id() as org, public.has_area('quotes','view') as can_view
  ),
  ev as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.event_time, q.lifecycle_stage,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is null)     as open_tasks,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is not null) as done_tasks
    from public.quotes q, me
    where me.can_view
      and q.org_id = me.org
      and coalesce(q.lifecycle_stage,'') <> 'closed'
    order by q.event_date nulls last, q.updated_at desc
    limit 25
  ),
  unread as (
    select count(*)::int as c
    from public.notifications n, me
    where n.org_id = me.org
      and n.created_at > coalesce((select last_seen_at from public.notification_seen s where s.user_id = me.uid), '-infinity'::timestamptz)
  )
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(ev) order by (ev.event_date is null), ev.event_date) from ev), '[]'::jsonb),
    'unread',   (select c from unread),
    'as_of',    now()
  );
$$;

revoke all on function public.my_pending() from anon, public;
grant execute on function public.my_pending() to authenticated;

-- VERIFY
select 'my_pending exists + authenticated can execute' as check,
       has_function_privilege('authenticated', 'public.my_pending()', 'EXECUTE') as ok;
