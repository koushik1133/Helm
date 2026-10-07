-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- ═════════════════════════════════════════════════════════════════════════════
-- =========================================================================
-- Phase 32 — Fix _next_occasion() date math (nurture automation)
--
-- The phase30 version added the occasion's day-of-year offset to Jan 1, which
-- drifts by a day across leap years — a "today" occasion could roll a full year
-- forward, so nurture_due()/run_nurture_auto() would miss it. This recomputes the
-- next occurrence from the actual month/day (clamping Feb 29 → Feb 28 in non-leap
-- years so it never errors). nurture_due() and queue_nurture_greeting() call this,
-- so both are corrected. Idempotent. Run AFTER phase30.
-- =========================================================================

create or replace function public._next_occasion(p_date date) returns date
  language plpgsql stable set search_path = public as $$
declare
  y int := extract(year from current_date)::int;
  m int; d int; cand date;
begin
  if p_date is null then return null; end if;
  m := extract(month from p_date)::int;
  d := extract(day from p_date)::int;
  begin cand := make_date(y, m, d); exception when others then cand := make_date(y, m, 28); end;
  if cand < current_date then
    begin cand := make_date(y + 1, m, d); exception when others then cand := make_date(y + 1, m, 28); end;
  end if;
  return cand;
end $$;

notify pgrst, 'reload schema';
