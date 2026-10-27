-- SCHEDULE-0279.sql - paste into the Supabase SQL editor AFTER APPLY-0279.sql (staging first, then production).
-- The daily referral job (referral_tick): confirms referrals whose 14-day hold is over, marks "did not start paying"
-- after 60 days, moves held / frozen / unused free months on (held -> upcoming / expired, frozen -> expired, 24-month
-- expiry) and uses the free months that are due (monthly: the renewal that is due; yearly: at once).
-- Runs ONLY if pg_cron is installed (it is never created here). Schedules once (safe to run twice). ASCII only.
-- Daily at 00:05 UTC (05:35 India time), ten minutes BEFORE the 00:15 UTC billing refresh (0045), so a free month moves
-- the period end before that refresh could mark the studio past due or queue a "renews soon" reminder.
-- Undo: select cron.unschedule('helm_referral_tick');
do $$ begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'SCHEDULE-0279: pg_cron is not installed - run the job by hand from HQ -> Referrals & partners -> Run now';
    return;
  end if;
  if to_regprocedure('public.referral_tick()') is null then
    raise exception 'STOP: APPLY-0279.sql is not applied'; end if;
  if not exists (select 1 from cron.job where jobname = 'helm_referral_tick') then
    perform cron.schedule('helm_referral_tick', '5 0 * * *', 'select public.referral_tick()');
  end if;
end $$;

-- VERIFY (ok = true; without pg_cron it says so and the job is run from HQ)
select item, ok from (values
  ('01 pg_cron installed (if false: HQ -> Referrals & partners -> Run now, daily)', exists (select 1 from pg_extension where extname = 'pg_cron')),
  ('02 helm_referral_tick scheduled once (or pg_cron not installed)',
     case when not exists (select 1 from pg_extension where extname = 'pg_cron') then true
          else (xpath('/row/n/text()', query_to_xml('select count(*) as n from cron.job where jobname = ''helm_referral_tick''', false, false, '')))[1]::text::int = 1 end)
) v(item, ok) order by item;
