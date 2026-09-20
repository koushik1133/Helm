-- ============================================================================
-- Phase 59 — Per-org uniqueness fix for seeded library tables (Block F, hotfix)
-- ---------------------------------------------------------------------------
-- Phase 57 re-scoped most global uniques to per-org, but three library tables
-- that create_studio() seeds were missed, so a second studio's default rows
-- collided with Helm's:
--   task_templates    : unique(category,title)  -> unique(org_id,category,title)
--   nurture_templates : pk(occasion_type)       -> pk(org_id,occasion_type)
--   nurture_automation: pk(id)                  -> pk(org_id,id)
-- Adding the per-org PK makes org_id NOT NULL on those two tables (already
-- backfilled to Helm in phase56, so no nulls). Idempotent + safe to re-run.
-- Run AFTER phase56/57/58.
-- ============================================================================

-- 1) task_templates: global unique(category,title) -> per-org ----------------
alter table public.task_templates drop constraint if exists task_templates_category_title_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='task_templates_org_cat_title_key') then
    alter table public.task_templates
      add constraint task_templates_org_cat_title_key unique (org_id, category, title);
  end if;
end $$;

-- 2) nurture_templates: pk(occasion_type) -> pk(org_id, occasion_type) --------
do $$ declare pk text;
begin
  select conname into pk from pg_constraint
    where conrelid='public.nurture_templates'::regclass and contype='p';
  if pk is not null and pk <> 'nurture_templates_org_pkey' then
    execute format('alter table public.nurture_templates drop constraint %I', pk);
  end if;
  if not exists (select 1 from pg_constraint where conname='nurture_templates_org_pkey') then
    alter table public.nurture_templates
      add constraint nurture_templates_org_pkey primary key (org_id, occasion_type);
  end if;
end $$;

-- 3) nurture_automation: pk(id) -> pk(org_id, id) ----------------------------
do $$ declare pk text;
begin
  select conname into pk from pg_constraint
    where conrelid='public.nurture_automation'::regclass and contype='p';
  if pk is not null and pk <> 'nurture_automation_org_pkey' then
    execute format('alter table public.nurture_automation drop constraint %I', pk);
  end if;
  if not exists (select 1 from pg_constraint where conname='nurture_automation_org_pkey') then
    alter table public.nurture_automation
      add constraint nurture_automation_org_pkey primary key (org_id, id);
  end if;
end $$;

notify pgrst, 'reload schema';

-- verify: the three per-org constraints now exist
select conname, contype from pg_constraint
where conname in ('task_templates_org_cat_title_key',
                  'nurture_templates_org_pkey',
                  'nurture_automation_org_pkey')
order by conname;
