-- APPLY-0306-ENABLE-HELM-STUDIO.sql - paste into the Supabase SQL editor on PRODUCTION, after APPLY-0306.sql.
-- R82: puts ONE studio on the referral pilot list - the owner's test studio with slug 'helm-studio' (its display name
-- may now be "Helm"; it is found by slug). Every other studio stays OFF. The global switch is NOT touched.
-- STOPS (changes nothing) unless exactly one studio has that slug. Safe to run twice (adds it once). ASCII only.
-- To undo later: update public.referral_settings set pilot_org_ids = array_remove(pilot_org_ids, '<id>'::uuid) where id;
begin;
do $$
declare n int; v uuid;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'referral_settings'
                  and column_name = 'pilot_org_ids') then
    raise exception 'STOP: run APPLY-0306.sql first'; end if;
  select count(*) into n from public.organizations where slug = 'helm-studio';
  if n <> 1 then raise exception 'STOP: expected exactly one studio with slug helm-studio, found %', n; end if;
  select id into v from public.organizations where slug = 'helm-studio';
  update public.referral_settings set pilot_org_ids = array_append(pilot_org_ids, v), updated_at = now()
   where id and not (v = any(pilot_org_ids));
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, null, 'referral.pilot_add', 'referral_settings', v::text, jsonb_build_object('slug', 'helm-studio', 'by', 'APPLY-0306-ENABLE'), v, now());
end $$;
commit;

-- ---- VERIFY ---------------------------------------------------------------------------------------------------
select 'helm-studio is on the pilot list' as check_name,
       (select o.id = any(s.pilot_org_ids) from public.referral_settings s, public.organizations o where s.id and o.slug = 'helm-studio') as ok
union all
select 'pilot list has exactly one studio', (select cardinality(pilot_org_ids) = 1 from public.referral_settings where id)
union all
select 'global switch is still OFF (everyone else stays off)', (select not program_on from public.referral_settings where id)
union all
select 'the program is on for helm-studio', (select public._r29_on_for(o.id) from public.organizations o where o.slug = 'helm-studio');
