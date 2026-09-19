-- ============================================================================
-- Phase 48 — Notification center (in-app bell)
-- ---------------------------------------------------------------------------
-- Surfaces the existing notifications outbox as an in-app feed with a bell +
-- unread badge. Reuses the notifications table (already fed by _notify on task
-- accept/reject/complete, assignments, approvals, payments, OTPs, reminders…).
-- Per-user read state is tracked with a lightweight "last seen" marker, so the
-- unread count = notifications created since you last opened the bell.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1) per-user "last seen" marker ---------------------------------------------
create table if not exists public.notification_seen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table public.notification_seen enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='notification_seen'
  loop execute format('drop policy if exists %I on public.notification_seen', p.policyname); end loop;
end $$;
create policy "seen self" on public.notification_seen for all to authenticated
  using ( user_id = auth.uid() ) with check ( user_id = auth.uid() );

-- 2) the bell feed: recent notifications + which are unread + a total unread count
create or replace function public.bell_feed(p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); seen timestamptz; result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select last_seen_at into seen from public.notification_seen where user_id = uid;
  seen := coalesce(seen, 'epoch'::timestamptz);
  with recent as (
    select n.id, n.kind, n.channel, n.recipient, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
    from public.notifications n
    left join public.quotes q on q.id = n.quote_id
    order by n.created_at desc
    limit greatest(1, least(p_limit, 100))
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from public.notifications where created_at > seen)
  ) into result;
  return result;
end; $$;

-- 3) mark everything up to now as seen (clears the badge) ---------------------
create or replace function public.bell_mark_seen()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode='42501'; end if;
  insert into public.notification_seen(user_id, last_seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = now();
end; $$;

revoke all on function public.bell_feed(int)     from anon;
revoke all on function public.bell_mark_seen()   from anon;
grant execute on function public.bell_feed(int)   to authenticated;
grant execute on function public.bell_mark_seen() to authenticated;

notify pgrst, 'reload schema';

-- verify
select 'notifications' k, count(*)::text v from public.notifications
union all select 'seen_rows', count(*)::text from public.notification_seen;
