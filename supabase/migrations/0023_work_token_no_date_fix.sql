-- ============================================================================
-- 0023_work_token_no_date_fix.sql — CANONICAL forward-only. Fixes a bug in 0022
-- (found by live verification on production, 2026-10-06).
-- Bug: work_token_expiry_for() used greatest(deadline, now()+2 days) and fell back to
-- 60 days only when that was NULL — but Postgres greatest() IGNORES NULLs, so for an
-- event with NO date it returned now()+2 days instead of the intended 60 days. 0022's
-- backfill therefore cut crew links for undated events down to 2 days.
-- Fix: explicit CASE. Repair: live, non-revoked crew links on undated events get their
-- 60 days back (never shortened by this; dated events are untouched).
-- Idempotent. Nothing deleted.
-- ============================================================================

create or replace function public.work_token_expiry_for(p_quote uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case
           when x.deadline is null then now() + interval '60 days'          -- no event date → previous rule
           else greatest(x.deadline, now() + interval '2 days')               -- event + 7, but >= 2 days to open it
         end
    from (select public.client_link_deadline(q.event_date, q.org_id, public.client_link_window_days('work')) as deadline
            from public.quotes q where q.id = p_quote) x;
$$;
revoke all on function public.work_token_expiry_for(uuid) from public, anon;

-- repair links 0022 shortened (undated events only; live + not revoked; only ever extends)
update public.work_tokens w
   set expires_at = greatest(w.expires_at, now() + interval '60 days')
  from public.quotes q
 where q.id = w.quote_id
   and q.event_date is null
   and w.revoked_at is null
   and w.expires_at is not null and w.expires_at > now()
   and w.expires_at < now() + interval '59 days';

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select q.code, q.event_date, w.expires_at from public.work_tokens w join public.quotes q on q.id=w.quote_id
--  where w.revoked_at is null order by w.expires_at;
