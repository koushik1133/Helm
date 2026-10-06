-- ════════════════════════════════════════════════════════════════════════════
-- HELM — Security audit Phase 5 · P5-01 follow-up — READ-ONLY (changes nothing)
-- For every time someone changed THEIR OWN role, is there a legitimate reason?
--   • they created a studio within 2 minutes  → normal sign-up (create_studio)
--   • they accepted an invitation within 2 min → normal join (accept_invitation)
--   • neither                                   → INVESTIGATE (possible self-promotion)
-- Also lists every rule on the profiles table (any other UPDATE rule = old exposure).
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as sort, 'profiles rule' as kind, p.policyname as who,
         p.cmd || ' for ' || array_to_string(p.roles, ',') as verdict, null::timestamptz as at
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'profiles'
  union all
  select 2, 'role change', coalesce(a.actor_email, a.actor::text),
         (a.changed->'role'->>0) || ' → ' || (a.changed->'role'->>1) || ' : ' ||
         case
           when exists (select 1 from public.organizations o
                         where o.created_by = a.actor
                           and abs(extract(epoch from (o.created_at - a.at))) < 120)
             then 'OK — created studio "' || (select o.name from public.organizations o where o.created_by = a.actor
                                                order by abs(extract(epoch from (o.created_at - a.at))) limit 1) || '"'
           when exists (select 1 from public.invitations i
                         where i.accepted_by = a.actor
                           and abs(extract(epoch from (i.accepted_at - a.at))) < 120)
             then 'OK — accepted an invitation'
           else 'INVESTIGATE — no studio creation or invite at that time'
         end,
         a.at
    from public.audit_log a
   where a.entity = 'profiles'
     and a.actor is not null and a.actor::text = a.entity_id
     and jsonb_typeof(a.changed->'role') = 'array'
) r
order by sort, at desc nulls last;
