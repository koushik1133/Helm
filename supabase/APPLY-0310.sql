-- APPLY-0310.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0096. It stops with "0310: ..." if a needed table / function is missing.
-- R89 (owner): Settings > Layout templates keeps a version every time a studio template's layout is saved.
--   NEW table studio_layout_template_versions (read-only history, same read rule as the templates) and a trigger
--   that adds the next version whenever a template's layout changes. Existing templates get their layout as v1.
--   Nothing existing is changed or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (Settings > Layout templates then shows "Versions" on studio templates).
begin;
-- 0310_r89_template_versions.sql - CANONICAL forward-only. REQUIRES 0096 (studio_layout_templates, has_area).
--
-- In plain words (R89 owner: "edits to layout templates are saved with versions"):
--   Every time a studio template's floor layout is saved (a new template, or an edit in the builder), a
--   read-only copy of that layout is kept as the next version (v1, v2, v3 ...). Settings > Layout templates
--   lists the versions and can put an older one back; "put back" goes through the normal
--   studio_template_save, so it simply becomes the newest version - nothing is ever overwritten or removed.
--   Changes (all additive, idempotent; nothing existing is deleted or rewritten):
--     * NEW table studio_layout_template_versions (template_id, org_id, version_no, name, event_type, data,
--       created_by, created_at). Row level security: read exactly like the templates themselves (own studio,
--       Floor layouts or Control Center view). No insert / update / delete grant for the app; rows are written
--       only by the trigger below. Versions can never be changed or deleted (trigger).
--     * NEW trigger zz_r310_version on studio_layout_templates (after insert, or after an update that changes
--       the layout data): adds the next version row. Renames / archive / default changes add no version.
--     * existing templates get their current layout as v1 once (only when they have no version yet).
--   The free-trial rules are unchanged: trial studios still cannot save templates (0181 wrappers), so they
--   never add versions. No existing table / column / row / policy / function is changed or deleted.
--   Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regclass('public.studio_layout_templates') is null then
    raise exception '0310: studio_layout_templates is missing (apply 0096 first)'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0310: has_area(text,text) is not installed'; end if;
end $$;

create table if not exists public.studio_layout_template_versions (
  id           uuid        primary key default gen_random_uuid(),
  template_id  uuid        not null,
  org_id       uuid        not null,
  version_no   integer     not null,
  name         text        null,
  event_type   text        null,
  data         jsonb       not null default '{}'::jsonb,
  created_by   uuid        null,
  created_at   timestamptz not null default now()
);

create unique index if not exists sltv_tpl_ver_uidx on public.studio_layout_template_versions (template_id, version_no);
create index if not exists sltv_org_idx on public.studio_layout_template_versions (org_id, template_id);

alter table public.studio_layout_template_versions enable row level security;
revoke all on table public.studio_layout_template_versions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.studio_layout_template_versions from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.studio_layout_template_versions from authenticated';
    execute 'grant select on table public.studio_layout_template_versions to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on table public.studio_layout_template_versions to service_role'; end if;
end $$;

drop policy if exists "r310 template versions read" on public.studio_layout_template_versions;
create policy "r310 template versions read" on public.studio_layout_template_versions for select to authenticated
  using (org_id = (select public.current_org_id())
         and (public.has_area('layouts', 'view') or public.has_area('controls', 'view')));

-- versions are history: never changed, never deleted - except by the owner-switched trial purge (0184), exactly
-- like the 0096 templates themselves
create or replace function public._r310_tg_frozen()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r89-template-versions-0310
declare v_ok boolean := false;
begin
  if tg_op = 'DELETE' and to_regprocedure('public._trial_purge_allows(uuid)') is not null then
    execute 'select public._trial_purge_allows($1)' into v_ok using old.org_id;
    if coalesce(v_ok, false) then return old; end if;
  end if;
  raise exception 'Template versions are kept as history and cannot be changed or deleted.' using errcode = '42501', hint = 'template_version_frozen';
end $$;

-- the next version of a template, written after its layout data is saved
create or replace function public._r310_tg_version()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r89-template-versions-0310
declare v_no integer;
begin
  if tg_op = 'UPDATE' and new.data is not distinct from old.data then return null; end if;
  select coalesce(max(v.version_no), 0) + 1 into v_no
    from public.studio_layout_template_versions v where v.template_id = new.id;
  insert into public.studio_layout_template_versions (template_id, org_id, version_no, name, event_type, data, created_by)
  values (new.id, new.org_id, v_no, new.name, new.event_type, coalesce(new.data, '{}'::jsonb), auth.uid());
  return null;
end $$;

do $$
declare r text;
begin
  foreach r in array array['public', 'anon', 'authenticated'] loop
    if r = 'public' or exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public._r310_tg_frozen() from %s', case when r = 'public' then 'public' else quote_ident(r) end);
      execute format('revoke all on function public._r310_tg_version() from %s', case when r = 'public' then 'public' else quote_ident(r) end);
    end if;
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_r310_frozen' and tgrelid = 'public.studio_layout_template_versions'::regclass) then
    execute 'create trigger zz_r310_frozen before update or delete on public.studio_layout_template_versions for each row execute function public._r310_tg_frozen()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_r310_version' and tgrelid = 'public.studio_layout_templates'::regclass) then
    execute 'create trigger zz_r310_version after insert or update of data on public.studio_layout_templates for each row execute function public._r310_tg_version()';
  end if;
end $$;

-- existing templates: their current layout becomes v1 (only when they have no version yet)
insert into public.studio_layout_template_versions (template_id, org_id, version_no, name, event_type, data, created_by, created_at)
select t.id, t.org_id, 1, t.name, t.event_type, coalesce(t.data, '{}'::jsonb), t.created_by, coalesce(t.updated_at, now())
  from public.studio_layout_templates t
 where not exists (select 1 from public.studio_layout_template_versions v where v.template_id = t.id);

-- suspended / ended-trial studios are read-only (0045 guard), like every studio table; added after the v1 backfill
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.studio_layout_template_versions'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.studio_layout_template_versions for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- trial retention (0184) knows the new table: purged together with the studio's templates (patched in place,
-- skipped when 0184 is not installed or its body is not the expected one)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''studio_layout_template_versions''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''studio_layout_templates''', ''))) / length('''studio_layout_templates''') <> 1 then
        raise notice '0310: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''studio_layout_templates''', '''studio_layout_template_versions'', ''studio_layout_templates''');
      end if;
    end if;
  end if;
end $$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 table studio_layout_template_versions exists with row level security on',
     coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.studio_layout_template_versions')), false)),
  ('02 the app can only read versions (no insert / update / delete for anon or authenticated)',
     has_table_privilege('authenticated', 'public.studio_layout_template_versions', 'select')
     and not has_table_privilege('authenticated', 'public.studio_layout_template_versions', 'insert')
     and not has_table_privilege('authenticated', 'public.studio_layout_template_versions', 'update')
     and not has_table_privilege('authenticated', 'public.studio_layout_template_versions', 'delete')
     and not has_table_privilege('anon', 'public.studio_layout_template_versions', 'select')),
  ('03 read policy present',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'studio_layout_template_versions' and policyname = 'r310 template versions read')),
  ('04 version trigger on studio_layout_templates + frozen trigger on versions',
     exists (select 1 from pg_trigger where tgname = 'zz_r310_version' and tgrelid = 'public.studio_layout_templates'::regclass)
     and exists (select 1 from pg_trigger where tgname = 'zz_r310_frozen' and tgrelid = 'public.studio_layout_template_versions'::regclass)),
  ('05 every template has at least one version',
     not exists (select 1 from public.studio_layout_templates t
                  where not exists (select 1 from public.studio_layout_template_versions v where v.template_id = t.id))),
  ('06 trigger functions: security definer, empty search_path, not callable by the app',
     coalesce((select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
                 from pg_proc p where p.oid in (to_regprocedure('public._r310_tg_version()'), to_regprocedure('public._r310_tg_frozen()'))), false)
     and not has_function_privilege('authenticated', 'public._r310_tg_version()', 'execute')),
  ('08 read-only guard (suspended / ended-trial studios) on the versions table',
     exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.studio_layout_template_versions'::regclass)),
  ('07 trial retention purges the versions with the templates (when 0184 is installed)',
     to_regprocedure('public._tr184_purge_tables()') is null
     or 'studio_layout_template_versions' = any (public._tr184_purge_tables()))
) v(item, ok);
