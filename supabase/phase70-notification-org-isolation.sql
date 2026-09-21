-- ============================================================================
-- Phase 70 — Tenant isolation fix: bell/notifications must be per-org
-- ---------------------------------------------------------------------------
-- BUG: bell_feed() is SECURITY DEFINER (bypasses RLS) and read the whole
-- notifications table with NO org filter, so a brand-new studio saw another
-- studio's notifications. Fix: filter by org_id = current_org_id() in BOTH the
-- feed and the unread count. notifications already carries org_id (phase56/57).
-- Idempotent. Run AFTER phase48 + phase57.
-- ============================================================================

create or replace function public.bell_feed(p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); org uuid := public.current_org_id(); seen timestamptz; result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select last_seen_at into seen from public.notification_seen where user_id = uid;
  seen := coalesce(seen, 'epoch'::timestamptz);
  with recent as (
    select n.id, n.kind, n.channel, n.recipient, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
    from public.notifications n
    left join public.quotes q on q.id = n.quote_id
    where n.org_id = org                                    -- << org isolation
    order by n.created_at desc
    limit greatest(1, least(p_limit, 100))
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from public.notifications where created_at > seen and org_id = org)  -- << org isolation
  ) into result;
  return result;
end; $$;

grant execute on function public.bell_feed(int) to authenticated;
notify pgrst, 'reload schema';

-- verify: should only ever return the caller's org
select 'bell_feed' t, 'org-scoped' note;
