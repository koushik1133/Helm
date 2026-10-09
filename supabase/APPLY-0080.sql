-- APPLY-0080.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0077-0079.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 3 rows, every ok = true.
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

-- VERIFY (expect 3 rows, ALL ok = true)
select item, ok from (values
  ('01 no catalog layer left without the fence', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'notification\_catalog%' and pg_get_functiondef(p.oid) ~ '\(\) as c\) x')),
  ('02 catalog still has the 0078 types', (select count(*) from jsonb_array_elements(public.notification_catalog()) e
      where e ->> 'type' in ('inventory_low_stock', 'client_follow_up', 'pkg_selected', 'billing_trial', 'security_alert')) = 5),
  ('03 functions still definer-safe (search_path empty)', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'notification\_catalog%' and not (coalesce(p.proconfig, '{}') @> array['search_path=""'])))
) v(item, ok)
order by item;
