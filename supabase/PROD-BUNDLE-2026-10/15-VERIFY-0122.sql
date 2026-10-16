-- VERIFY 0122 (read-only; expect every ok = true)
select '0122 seed function has the real "Demo ·"' as item, coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%Demo ' || chr(183) || ' %', false) as ok
union all select '0122 seed function has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%' || chr(172) || chr(8721) || '%', false)
union all select '0122 seed uses the studio currency', coalesce(pg_get_functiondef(to_regprocedure('public._trial_seed_extra(uuid)')) like '%0122%', false)
union all select '0122 read-only guard has no broken characters', not coalesce(pg_get_functiondef(to_regprocedure('public.tg_studio_read_only()')) like '%' || chr(8218) || chr(196) || '%', false)
union all select '0122 trial studios: no broken quote titles', not exists (select 1 from public.quotes q join public.organizations o on o.id = q.org_id where o.trial_ends_at is not null and q.title like '%' || chr(172) || chr(8721) || '%')
union all select '0122 trial studios: no broken vendor names', not exists (select 1 from public.vendors v join public.organizations o on o.id = v.org_id where o.trial_ends_at is not null and v.name like '%' || chr(172) || chr(8721) || '%')
union all select '0122 lead history records the lead''s studio', coalesce(pg_get_functiondef(to_regprocedure('public.archive_lead()')) like '%r.org_id%', false);
