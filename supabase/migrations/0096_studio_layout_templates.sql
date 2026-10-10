-- 0096_studio_layout_templates.sql - CANONICAL forward-only. Each studio's OWN floor-layout templates.
--
-- In plain words:
--   Besides the built-in "Classic templates", a studio can save any floor layout as its own
--   template (name, event type, short description, small preview picture) and reuse it on
--   new events. Templates can be renamed, duplicated, archived (never deleted) and one per
--   event type can be marked as the studio's default.
--
--   Changes (all additive, idempotent; nothing existing is deleted or rewritten):
--     * table studio_layout_templates (org_id = the studio). Row level security on: a signed-in
--       member reads only their OWN studio's templates, and only with "Floor layouts" or
--       "Control Center" view in the access matrix (admins always). No insert / update / delete
--       grants: every write goes through the functions below.
--     * templates can never be hard-deleted (trigger) - "delete" = archive.
--     * size limits: name 120 chars, description 1000, layout data 600 KB / 5000 objects,
--       preview picture 400 KB and only a data:image png / jpeg / webp.
--     * studio_template_save(id, data)        - add (id null) or edit; needs layouts OR controls EDIT.
--     * studio_template_set_archived(id, on)  - archive / restore (archiving clears "default").
--     * studio_template_set_default(id, on)   - one default per event type per studio.
--     * studio_template_duplicate(id)         - copy as "<name> (copy)".
--   Suspended studios are read-only (0045 guard); every change is written to audit_log.
--   Venue length x breadth already exists (0085 venues.length_m / width_m) - no venue change here.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0096: has_area(text,text) is not installed'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception '0096: tg_studio_read_only() is not installed (apply 0045 first)'; end if;
  if to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0096: _studio_writable(uuid) is not installed'; end if;
end $$;

create table if not exists public.studio_layout_templates (
  id           uuid        primary key default gen_random_uuid(),
  org_id       uuid        not null,
  name         text        not null,
  event_type   text        null,
  description  text        null,
  data         jsonb       not null default '{}'::jsonb,
  thumbnail    text        null,
  is_default   boolean     not null default false,
  archived     boolean     not null default false,
  created_by   uuid        null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'slt_name_ck') then
    alter table public.studio_layout_templates add constraint slt_name_ck check (length(btrim(name)) between 1 and 120); end if;
  if not exists (select 1 from pg_constraint where conname = 'slt_event_type_ck') then
    alter table public.studio_layout_templates add constraint slt_event_type_ck check (
      event_type is null or event_type ~ '^[a-z][a-z0-9_]{0,39}$'); end if;
  if not exists (select 1 from pg_constraint where conname = 'slt_desc_ck') then
    alter table public.studio_layout_templates add constraint slt_desc_ck check (coalesce(length(description), 0) <= 1000); end if;
  if not exists (select 1 from pg_constraint where conname = 'slt_data_ck') then
    alter table public.studio_layout_templates add constraint slt_data_ck check (
      jsonb_typeof(data) = 'object' and pg_column_size(data) <= 614400
      and (data -> 'items' is null or (jsonb_typeof(data -> 'items') = 'array' and jsonb_array_length(data -> 'items') <= 5000))); end if;
  if not exists (select 1 from pg_constraint where conname = 'slt_thumb_ck') then
    alter table public.studio_layout_templates add constraint slt_thumb_ck check (
      thumbnail is null or (length(thumbnail) <= 409600 and thumbnail ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')); end if;
  if not exists (select 1 from pg_constraint where conname = 'slt_default_live_ck') then
    alter table public.studio_layout_templates add constraint slt_default_live_ck check (not (is_default and archived)); end if;
end $$;

create index if not exists slt_org_idx on public.studio_layout_templates (org_id, archived, name);
create unique index if not exists slt_one_default_uidx on public.studio_layout_templates (org_id, coalesce(event_type, ''))
  where is_default and not archived;

alter table public.studio_layout_templates enable row level security;
revoke all on table public.studio_layout_templates from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.studio_layout_templates from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.studio_layout_templates from authenticated';
    execute 'grant select on table public.studio_layout_templates to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update on table public.studio_layout_templates to service_role'; end if;
end $$;

drop policy if exists "a96 templates read" on public.studio_layout_templates;
create policy "a96 templates read" on public.studio_layout_templates for select to authenticated
  using (org_id = (select public.current_org_id())
         and (public.has_area('layouts', 'view') or public.has_area('controls', 'view')));

create or replace function public._a96_tg_no_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Templates are never deleted - archive the template instead.' using errcode = '42501', hint = 'template_no_delete';
end $$;
revoke all on function public._a96_tg_no_delete() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a96_tg_no_delete() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a96_tg_no_delete() from authenticated'; end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_a96_no_delete' and tgrelid = 'public.studio_layout_templates'::regclass) then
    execute 'create trigger zz_a96_no_delete before delete on public.studio_layout_templates for each row execute function public._a96_tg_no_delete()';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.studio_layout_templates'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.studio_layout_templates for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
  if to_regprocedure('public.tg_audit()') is not null
     and not exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = 'public.studio_layout_templates'::regclass) then
    execute 'create trigger audit_trg after insert or delete or update on public.studio_layout_templates for each row execute function public.tg_audit()';
  end if;
end $$;

-- who may change templates: Floor layouts EDIT or Control Center EDIT (admins always via has_area)
create or replace function public._a96_can_edit()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.current_org_id() is not null
     and (public.has_area('layouts', 'edit') or public.has_area('controls', 'edit'));
$$;

create or replace function public._a96_txt(p jsonb, k text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(coalesce(p ->> k, '')), '');
$$;

create or replace function public.studio_template_save(p_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-templates-0096
declare
  v_org uuid := public.current_org_id();
  v_name text; v_type text; v_desc text; v_thumb text; v_data jsonb; r public.studio_layout_templates;
begin
  if not public._a96_can_edit() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'template data must be an object' using errcode = '22023'; end if;
  v_name := public._a96_txt(p, 'name');
  if v_name is null or length(v_name) > 120 then raise exception 'Give the template a name (up to 120 characters).' using errcode = '22023'; end if;
  v_type := lower(public._a96_txt(p, 'event_type'));
  if v_type is not null and v_type !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'Unknown event type.' using errcode = '22023'; end if;
  v_desc := public._a96_txt(p, 'description');
  if coalesce(length(v_desc), 0) > 1000 then raise exception 'Description is too long (1000 characters max).' using errcode = '22023'; end if;
  v_thumb := public._a96_txt(p, 'thumbnail');
  if v_thumb is not null and (length(v_thumb) > 409600 or v_thumb !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$') then
    v_thumb := null;   -- a bad / oversized preview never blocks the save; the template just has no picture
  end if;
  v_data := p -> 'data';
  if p_id is null or v_data is not null then
    if v_data is null or jsonb_typeof(v_data) <> 'object' or jsonb_typeof(v_data -> 'items') is distinct from 'array' then
      raise exception 'The template needs a layout (items list).' using errcode = '22023'; end if;
    if jsonb_array_length(v_data -> 'items') > 5000 or pg_column_size(v_data) > 614400 then
      raise exception 'This layout is too large to save as a template.' using errcode = '22023'; end if;
  end if;

  if p_id is null then
    insert into public.studio_layout_templates(org_id, name, event_type, description, data, thumbnail, created_by)
      values (v_org, v_name, v_type, v_desc, v_data, v_thumb, auth.uid()) returning * into r;
  else
    update public.studio_layout_templates t set
        name = v_name, event_type = v_type, description = v_desc,
        data = coalesce(v_data, t.data),
        thumbnail = case when p ? 'thumbnail' then v_thumb else t.thumbnail end,
        -- moving a default template to another event type drops the default flag (no clash)
        is_default = t.is_default and coalesce(t.event_type, '') = coalesce(v_type, ''),
        updated_at = now()
      where t.id = p_id and t.org_id = v_org returning * into r;
    if r.id is null then raise exception 'no such template' using errcode = '42501'; end if;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.studio_template_set_archived(p_id uuid, p_archived boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-templates-0096
declare v_org uuid := public.current_org_id(); r public.studio_layout_templates;
begin
  if not public._a96_can_edit() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  update public.studio_layout_templates t set archived = coalesce(p_archived, false),
      is_default = case when coalesce(p_archived, false) then false else t.is_default end, updated_at = now()
   where t.id = p_id and t.org_id = v_org returning * into r;
  if r.id is null then raise exception 'no such template' using errcode = '42501'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.studio_template_set_default(p_id uuid, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-templates-0096
declare v_org uuid := public.current_org_id(); t0 public.studio_layout_templates; r public.studio_layout_templates;
begin
  if not public._a96_can_edit() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  select * into t0 from public.studio_layout_templates t where t.id = p_id and t.org_id = v_org;
  if t0.id is null then raise exception 'no such template' using errcode = '42501'; end if;
  if t0.archived and coalesce(p_on, false) then raise exception 'Restore the template before making it the default.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('slt.default:' || v_org::text || ':' || coalesce(t0.event_type, '')));
  if coalesce(p_on, false) then
    update public.studio_layout_templates t set is_default = false, updated_at = now()
     where t.org_id = v_org and coalesce(t.event_type, '') = coalesce(t0.event_type, '') and t.is_default and t.id <> p_id;
  end if;
  update public.studio_layout_templates t set is_default = coalesce(p_on, false), updated_at = now()
   where t.id = p_id and t.org_id = v_org returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.studio_template_duplicate(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- studio-templates-0096
declare v_org uuid := public.current_org_id(); r public.studio_layout_templates;
begin
  if not public._a96_can_edit() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  insert into public.studio_layout_templates(org_id, name, event_type, description, data, thumbnail, created_by)
    select t.org_id, left(t.name, 113) || ' (copy)', t.event_type, t.description, t.data, t.thumbnail, auth.uid()
      from public.studio_layout_templates t where t.id = p_id and t.org_id = v_org
    returning * into r;
  if r.id is null then raise exception 'no such template' using errcode = '42501'; end if;
  return to_jsonb(r);
end $$;

do $$ declare f text; begin
  foreach f in array array['public.studio_template_save(uuid,jsonb)', 'public.studio_template_set_archived(uuid,boolean)',
                           'public.studio_template_set_default(uuid,boolean)', 'public.studio_template_duplicate(uuid)',
                           'public._a96_can_edit()', 'public._a96_txt(jsonb,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
