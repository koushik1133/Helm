-- ════════════════════════════════════════════════════════════════════════════
-- HELM — Security audit Phase 5 · P5-01 — READ-ONLY CHECK (changes nothing)
-- Was this project exposed to "any member can make themselves admin / move into
-- another studio"? And did anyone ever do it? One result table:
--   exposure rows  → current state of the profiles rules on this project
--   history rows   → every time someone changed THEIR OWN role or studio
--                    (legit cases: creating a studio, accepting an invite)
-- USE: SQL Editor → paste → Run. Send a screenshot of the result.
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as sort, 'exposure' as kind,
         'self-update rule present on profiles' as item,
         case when exists (select 1 from pg_policies where schemaname='public' and tablename='profiles'
                            and policyname='profiles_self_update') then 'YES — exposed' else 'no' end as detail,
         null::timestamptz as at
  union all
  select 2, 'exposure', 'members can write profiles directly',
         case when has_table_privilege('authenticated','public.profiles','UPDATE') then 'YES' else 'no' end, null
  union all
  select 3, 'exposure', 'guard trigger installed (0021)',
         case when exists (select 1 from pg_trigger where tgrelid='public.profiles'::regclass
                            and tgname='profiles_privilege_guard_biud') then 'yes' else 'NO — not applied yet' end, null
  union all
  select 4, 'history', coalesce(a.actor_email, a.actor::text),
         concat_ws('  ',
           case when jsonb_typeof(a.changed->'role')   = 'array' then 'role '   || (a.changed->'role'->>0)   || ' → ' || (a.changed->'role'->>1) end,
           case when jsonb_typeof(a.changed->'org_id') = 'array' then 'studio ' || left(a.changed->'org_id'->>0, 8) || ' → ' || left(a.changed->'org_id'->>1, 8) end),
         a.at
    from public.audit_log a
   where a.entity = 'profiles'
     and a.actor is not null and a.actor::text = a.entity_id
     and (jsonb_typeof(a.changed->'role') = 'array' or jsonb_typeof(a.changed->'org_id') = 'array')
) r
order by sort, at desc nulls last;
