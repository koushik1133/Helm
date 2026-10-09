-- 0080_notif_catalog_speed.sql
-- Speed fix for the notification catalog (Control Center > Notifications timed out on prod).
-- Each catalog layer (0054/0058/0069/0078) reads the previous layer through a subquery
-- "from (select <previous>() as c) x" and uses c three times. The planner pulls that subquery
-- up and calls the previous layer three times, so N layers cost 3^N calls (81 per lookup).
-- This adds "offset 0" to each such subquery (a planner fence), so every layer calls the one
-- below it exactly once. Function bodies and results are otherwise unchanged.
-- Idempotent: a layer already carrying the fence is skipped. No data is read or written.
do $fix$
declare r record; d text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'notification\_catalog%' and p.prokind = 'f'
  loop
    d := pg_get_functiondef(r.oid);
    if d ~ '\(\) as c\) x' then
      execute regexp_replace(d, '\(\) as c\) x', '() as c offset 0) x', 'g');
    end if;
  end loop;
end $fix$;
