-- APPLY-0174.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0171 (and 0172). Free-trial seed fix: with helm_sample_template.active = true every
-- trial seed (signup, "Load demo data", "Reset demo data", AE studios) uses the CURRENT sample manifest;
-- a trial is never silently given the old built-in "Demo - Banjara Lawns / Sitara" seed; an old-seed
-- trial is not cloned on top of its old rows (use Clear sample data, then Load demo data).
-- Functions only: no table, column or row change, nothing deleted. Safe to run twice. ASCII only.
begin;
-- ============================================================================
-- 0174_trial_seed_current_manifest.sql - CANONICAL forward-only. Every trial seed uses the
-- CURRENT published sample manifest once the switch is on.
-- REQUIRES 0102 (_demo_seed_for) + 0166 + 0167 (sample master, manifest, _sample_clone_into).
--
-- In plain words (why prod trials still showed "Demo - Banjara Lawns / Sitara Convention Hall"):
--   1  _demo_seed (0167) fell back SILENTLY to the old built-in 0100 seed whenever the clone did
--      not run for any reason other than "already cloned" (e.g. 'no_template', 'template_empty').
--      With the switch ON a trial studio now never gets the old seed: it gets the manifest, or
--      nothing plus a clear reason ('sample_not_cloned') that is written to the audit log.
--   2  _demo_seed_for (0102: "Load demo data" / "Reset demo data") sent a studio whose country is
--      AE straight to the old Dubai seed, bypassing the manifest. A TRIAL studio now always goes
--      through _demo_seed (the manifest) while the switch is on. Paid studios: unchanged.
--   3  A trial seeded by the OLD seed (sample_cloned_at is null, old "Demo -" rows still there)
--      is never cloned on top of those rows (no mixed old + new data): the seed answers
--      'old_sample_present' and the studio uses "Clear sample data" first, then "Load demo data",
--      which clones the current manifest (old venues are switched off by the clear, never deleted).
--   4  With the switch OFF everything behaves exactly as before (0100 / 0102 seeds).
-- Zero data loss: functions only (CREATE OR REPLACE), no table / column / row change, nothing
-- deleted. Trial studios only. Idempotent.
-- ============================================================================
do $$ begin
  if to_regprocedure('public._sample_clone_into(uuid)') is null or to_regprocedure('public._demo_seed__pre0166(uuid)') is null
     or to_regprocedure('public._demo_seed_for(uuid)') is null or to_regprocedure('public._sample_template_ready()') is null then
    raise exception '0174: apply 0102 + 0166 + 0167 first'; end if;
end $$;

create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-seed-0174 (trial-sample-0167 / trial-sandbox-0166): a trial studio gets its own copy of the
-- CURRENT published sample while the switch is on (never the old built-in seed); else the 0100 seed
declare r jsonb;
begin
  if p_org is not null and public._sample_template_ready()
     and public._is_trial_org(p_org)
     and exists (select 1 from public.organizations o where o.id = p_org and not coalesce(o.is_sample_master, false)) then
    -- a studio holding OLD built-in sample rows (never cloned) is not cloned on top of them
    if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is null)
       and (exists (select 1 from public.quotes x where x.org_id = p_org and x.is_demo)
            or exists (select 1 from public.leads x where x.org_id = p_org and x.is_demo)
            or exists (select 1 from public.inventory_items x where x.org_id = p_org and x.is_demo and x.active)) then
      return jsonb_build_object('cloned', false, 'seeded', false, 'reason', 'old_sample_present');
    end if;
    -- "Reset demo data": a cloned trial whose sample rows are all gone may clone again (current manifest)
    if exists (select 1 from public.organizations o where o.id = p_org and o.sample_cloned_at is not null)
       and not exists (select 1 from public.quotes x where x.org_id = p_org and x.is_demo)
       and not exists (select 1 from public.leads x where x.org_id = p_org and x.is_demo)
       and not exists (select 1 from public.inventory_items x where x.org_id = p_org and x.is_demo and x.active) then
      update public.organizations set sample_cloned_at = null where id = p_org;
    end if;
    r := public._sample_clone_into(p_org);
    if coalesce((r ->> 'cloned')::boolean, false) then
      update public.organizations set trial_mode = 'demo' where id = p_org and trial_mode is distinct from 'demo';
      return r;
    end if;
    if r ->> 'reason' = 'already_cloned' then return r || jsonb_build_object('seeded', false); end if;
    -- switch on but the clone did not run: say so; never the old seed
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'trial.sample_not_cloned', 'organizations', p_org::text, coalesce(r, '{}'::jsonb), p_org, now());
    return coalesce(r, '{}'::jsonb) || jsonb_build_object('cloned', false, 'seeded', false, 'reason2', 'sample_not_cloned');
  end if;
  return public._demo_seed__pre0166(p_org);
end $$;

create or replace function public._demo_seed_for(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- trial-seed-0174 (demo-seed-0102): a TRIAL studio uses the sample manifest while it is on; AE -> Dubai seed otherwise
declare v_cc text;
begin
  if p_org is not null and public._sample_template_ready()
     and public._is_trial_org(p_org)
     and exists (select 1 from public.organizations o where o.id = p_org and not coalesce(o.is_sample_master, false)) then
    return public._demo_seed(p_org);
  end if;
  select upper(btrim(coalesce(o.country, ''))) into v_cc from public.organizations o where o.id = p_org;
  if v_cc = 'AE' then return public._demo_seed_ae(p_org); end if;
  return public._demo_seed(p_org);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public._demo_seed(uuid)', 'public._demo_seed_for(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 _demo_seed is the 0174 version', position('trial-seed-0174' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0),
  ('02 _demo_seed_for is the 0174 version', position('trial-seed-0174' in (select prosrc from pg_proc where oid = 'public._demo_seed_for(uuid)'::regprocedure)) > 0),
  ('03 app roles cannot call the seeders', not has_function_privilege('authenticated', 'public._demo_seed(uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public._demo_seed_for(uuid)', 'execute')),
  ('05 trial check uses _is_trial_org, not trial_ends_at', position('_is_trial_org' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0
       and position('trial_ends_at' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) = 0
       and position('_is_trial_org' in (select prosrc from pg_proc where oid = 'public._demo_seed_for(uuid)'::regprocedure)) > 0
       and position('trial_ends_at' in (select prosrc from pg_proc where oid = 'public._demo_seed_for(uuid)'::regprocedure)) = 0),
  ('04 switch on + manifest current (false = sample switch still off)', public._sample_template_ready())
) v(item, ok) order by item;
