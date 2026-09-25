-- ============================================================================
-- phase97-fix-app_config-multitenant.sql
-- ----------------------------------------------------------------------------
-- CORRECTIVE. Idempotent. Safe to re-run.
--
-- Context / why this exists:
--   app_config is MULTI-TENANT. Its primary key is (org_id, key) (phase57).
--   get_pricing_config() and set_pricing_config() are ORG-SCOPED and rely on
--   `on conflict (org_id, key)`. A one-off Wave-5 dedup mistakenly:
--     (a) removed a per-org 'pricing' row (treating normal per-org rows as dupes), and
--     (b) added a WRONG global `unique (key)` constraint (app_config_key_uk) that
--         breaks per-org config saves.
--
--   This migration reverses (b) and restores the admin org's pricing config,
--   INCLUDING assetPrices, org-scoped so get_pricing_config() returns it.
--
--   It does NOT touch any other org's rows, does NOT delete anything, and does
--   NOT add any global unique constraint. The composite PK (org_id, key) already
--   guarantees correct uniqueness.
-- ============================================================================

-- 1) Remove the incorrect global unique constraint if it exists.
alter table public.app_config drop constraint if exists app_config_key_uk;

-- 2) Restore the admin org's pricing config WITH object/item prices (org-scoped upsert).
do $$
declare v_org uuid; v_base jsonb;
begin
  select p.org_id into v_org
    from public.profiles p
    join auth.users u on u.id = p.id
   where lower(u.email) = 'admin@helm.com'
   limit 1;

  if v_org is null then
    raise notice 'admin@helm.com org not found — skipping pricing restore';
    return;
  end if;

  -- Start from the existing org pricing row if present, else a sane default base.
  select value into v_base from public.app_config where key='pricing' and org_id = v_org;
  if v_base is null then
    v_base := '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb;
  end if;

  -- Only fill assetPrices if missing/empty; never clobber a customized set.
  if not (v_base ? 'assetPrices') or (v_base->'assetPrices') = '{}'::jsonb then
    v_base := v_base || jsonb_build_object('assetPrices', jsonb_build_object(
      'stage',45000,'tent',35000,'canopy',25000,'mandap',75000,'arch',9000,'floralarch',15000,
      'dancefloor',20000,'redcarpet',8000,'viprisers',18000,'truss',6000,
      'videowall',120000,'ledscreen',60000,'linearray',40000,'subwoofer',12000,'foh',20000,
      'piano',30000,'press',15000,'dj',10000,'photobooth',12000,
      'bar',12000,'buffet',9000,'truck',25000,'greenroom',8000,'generator',15000,'parking',10000,
      'chandelier',12000,'fountain',20000,'restroom',12000,'coatcheck',5000,'firstaid',4000));
  end if;

  insert into public.app_config(org_id, key, value, updated_at)
    values (v_org, 'pricing', v_base, now())
    on conflict (org_id, key) do update set value = excluded.value, updated_at = now();
end $$;

-- Verify (read-only):
-- select org_id, key, (value ? 'assetPrices') as has_asset,
--        jsonb_object_keys_count(value->'assetPrices') as n
--   from public.app_config where key='pricing';
