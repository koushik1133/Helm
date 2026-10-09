-- APPLY-0083.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0082.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 9 rows, every ok = true.
-- 0083_snapshot_label_variants.sql - CANONICAL forward-only. Booklet pictures in 3 label styles.
--
-- In plain words:
--   The client booklet shows the 2D floor plan and the 3D view as pictures. Until now there
--   was ONE picture of each (numbered badges + a legend). The studio can now save the same
--   picture in three label styles so the client can switch between them:
--       2d / 3d              - numbers + legend (unchanged, old booklets keep working)
--       2d_none / 3d_none    - plain picture, no labels
--       2d_names / 3d_names  - small name tags
--   Storage keys stay inside the studio + event folder: <org>/<quote>/<kind>.<png|jpg|webp>,
--   same private bucket, same 3 MB / image-type limits.
--
--   Changes (all additive, idempotent):
--     * client_booklets.snap_variants jsonb (default {}) - the 4 extra kinds' storage paths.
--       A new link carries the previous link's variants (like 0069 carries 2d / 3d).
--     * booklet_snapshot_upload_ok / storage name guard / booklet_set_snapshot /
--       booklet_snapshot_path learn the 4 extra kinds (same tenant + section checks).
--     * public_get_booklet (wrapped, kept as __pre0083) adds snapshots.<variant> = true/false.
--   No row is deleted; existing 2d / 3d paths are untouched.
-- ============================================================================

alter table public.client_booklets add column if not exists snap_variants jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_booklets_snap_variants_obj') then
    alter table public.client_booklets add constraint client_booklets_snap_variants_obj check (jsonb_typeof(snap_variants) = 'object') not valid;
  end if;
end $$;

-- the 6 snapshot kinds (2d / 3d = numbers, the original pictures)
create or replace function public._bk_snap_kind_ok(p_kind text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_kind, '') in ('2d', '3d', '2d_none', '3d_none', '2d_names', '3d_names');
$$;
revoke all on function public._bk_snap_kind_ok(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk_snap_kind_ok(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public._bk_snap_kind_ok(text) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._bk_snap_kind_ok(text) to service_role'; end if;
end $$;

create or replace function public.booklet_snapshot_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- label-variants-0083
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_org uuid := public.current_org_id(); v_role text;
begin
  if auth.uid() is null or v_org is null then return false; end if;
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.org_id = v_org;
  if v_role is null or v_role = 'client' or not public.has_area('quotes', 'edit') then return false; end if;
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] is distinct from v_org::text then return false; end if;
  if v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_parts[3] !~ '^(2d|3d)(_none|_names)?\.(png|jpg|webp)$' then return false; end if;
  return exists (select 1 from public.quotes q where q.id = v_parts[2]::uuid and q.org_id = v_org and q.deleted_at is null)
     and public._studio_writable(v_org);
end $$;

do $$ begin
  if to_regprocedure('public.storage_object_name_ok__pre0069(text,text)') is not null then
    execute $f$
create or replace function public.storage_object_name_ok(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $b$
begin
  -- package-flow-0069 + label-variants-0083: <org>/<quote>/{2d|3d}[_none|_names].{png|jpg|webp} in the caller's studio
  if p_bucket = 'booklet-snapshots' then
    return p_name is not null and public.current_org_id() is not null and auth.uid() is not null
       and split_part(p_name, '/', 1) = public.current_org_id()::text
       and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(2d|3d)(_none|_names)?\.(png|jpg|webp)$';
  end if;
  return public.storage_object_name_ok__pre0069(p_bucket, p_name);
end $b$;
$f$;
    execute 'grant execute on function public.storage_object_name_ok(text, text) to authenticated, anon, service_role';
  end if;
end $$;

create or replace function public.booklet_set_snapshot(p_quote_id uuid, p_kind text, p_path text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- label-variants-0083
declare v_org uuid; n int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  if not public._bk_snap_kind_ok(p_kind) then raise exception 'unknown snapshot kind' using errcode = '22023'; end if;
  if p_path is not null and p_path !~ ('^' || v_org::text || '/' || p_quote_id::text || '/' || p_kind || '\.(png|jpg|webp)$') then
    raise exception 'bad snapshot path' using errcode = '22023'; end if;
  if p_kind = '2d' then
    update public.client_booklets b set snap_2d_path = p_path where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  elsif p_kind = '3d' then
    update public.client_booklets b set snap_3d_path = p_path where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  elsif p_path is null then
    update public.client_booklets b set snap_variants = coalesce(b.snap_variants, '{}'::jsonb) - p_kind
     where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  else
    update public.client_booklets b set snap_variants = coalesce(b.snap_variants, '{}'::jsonb) || jsonb_build_object(p_kind, p_path)
     where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  end if;
  get diagnostics n = row_count;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'booklet.snapshot', 'client_booklets', p_quote_id::text, p_quote_id, jsonb_build_object('kind', p_kind, 'set', p_path is not null), v_org);
  return jsonb_build_object('ok', n > 0, 'kind', p_kind, 'path', p_path);
end $$;

-- service role only (edge function booklet-snapshot)
create or replace function public.booklet_snapshot_path(p_token uuid, p_kind text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- label-variants-0083
declare b public.client_booklets; v text;
begin
  if p_token is null or not public._bk_snap_kind_ok(p_kind) then return null; end if;
  if public.rate_hit('booklet.snap', md5('booklet:' || p_token::text), 600, 120) > 0 then return null; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now()
     or not exists (select 1 from public.quotes q where q.id = b.quote_id and q.org_id = b.org_id and q.deleted_at is null) then return null; end if;
  if not public._bk_on(b.sections, case when left(p_kind, 2) = '2d' then 'layout2d' else 'layout3d' end) then return null; end if;
  if p_kind = '2d' then return b.snap_2d_path; end if;
  if p_kind = '3d' then return b.snap_3d_path; end if;
  v := coalesce(b.snap_variants, '{}'::jsonb) ->> p_kind;
  if v is null or v !~ ('^' || b.org_id::text || '/' || b.quote_id::text || '/' || p_kind || '\.(png|jpg|webp)$') then return null; end if;
  return v;
end $$;

-- a new link keeps the previous link's label variants (0069 does the same for 2d / 3d)
create or replace function public._bk_tg_carry_snap_variants()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if coalesce(new.snap_variants, '{}'::jsonb) = '{}'::jsonb then
    select b.snap_variants into v from public.client_booklets b
     where b.quote_id = new.quote_id and b.org_id = new.org_id and b.id <> new.id order by b.created_at desc limit 1;
    if v is not null and jsonb_typeof(v) = 'object' then new.snap_variants := v; end if;
  end if;
  return new;
end $$;
revoke all on function public._bk_tg_carry_snap_variants() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk_tg_carry_snap_variants() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._bk_tg_carry_snap_variants() from authenticated'; end if;
end $$;
drop trigger if exists zc_carry_snap_variants on public.client_booklets;
create trigger zc_carry_snap_variants before insert on public.client_booklets for each row execute function public._bk_tg_carry_snap_variants();

-- public reader: + snapshots.<variant> flags (no paths)
do $$ begin
  if to_regprocedure('public.public_get_booklet(uuid)') is null then
    raise exception '0083: public_get_booklet(uuid) is not installed (apply 0081 first)';
  end if;
  if to_regprocedure('public.public_get_booklet__pre0083(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0083;
  end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- label-variants-0083: the 0081 reader, then which label variants of the pictures exist
declare r jsonb; b public.client_booklets; v jsonb; k text; f jsonb := '{}'::jsonb;
begin
  r := public.public_get_booklet__pre0083(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r -> 'snapshots') <> 'object' then return r; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null then return r; end if;
  v := case when jsonb_typeof(b.snap_variants) = 'object' then b.snap_variants else '{}'::jsonb end;
  foreach k in array array['2d_none', '2d_names', '3d_none', '3d_names'] loop
    f := f || jsonb_build_object(k, public._bk_on(b.sections, case when left(k, 2) = '2d' then 'layout2d' else 'layout3d' end)
                                    and coalesce(jsonb_typeof(v -> k) = 'string', false));
  end loop;
  return jsonb_set(r, '{snapshots}', (r -> 'snapshots') || f);
end $$;

do $$ declare s text; begin
  foreach s in array array['public.public_get_booklet__pre0083(uuid)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.public_get_booklet__pre0083(uuid) to service_role;
  end if;
end $$;

-- VERIFY (expect 9 rows, ALL ok = true)
select item, ok from (values
  ('01 snap_variants column present', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_booklets' and column_name = 'snap_variants')),
  ('02 six kinds allow-listed', public._bk_snap_kind_ok('3d_none') and public._bk_snap_kind_ok('2d_names') and public._bk_snap_kind_ok('3d') and not public._bk_snap_kind_ok('3d_evil')),
  ('03 setter knows variants (0083 body)', position('label-variants-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.booklet_set_snapshot(uuid,text,text)'::regprocedure)) > 0),
  ('04 path fn knows variants, service-role only', position('label-variants-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.booklet_snapshot_path(uuid,text)'::regprocedure)) > 0
      and not has_function_privilege('anon', 'public.booklet_snapshot_path(uuid,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.booklet_snapshot_path(uuid,text)', 'execute')),
  ('05 upload guard knows variants', position('label-variants-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.booklet_snapshot_upload_ok(text)'::regprocedure)) > 0),
  ('06 storage name guard knows variants', position('label-variants-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.storage_object_name_ok(text,text)'::regprocedure)) > 0),
  ('07 reader wrapped; inner not anon-callable', position('label-variants-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.public_get_booklet(uuid)'::regprocedure)) > 0
      and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.public_get_booklet__pre0083(uuid)', 'execute')),
  ('08 carry trigger present', exists (select 1 from pg_trigger where tgname = 'zc_carry_snap_variants' and tgrelid = 'public.client_booklets'::regclass)),
  ('09 changed functions definer-safe (search_path empty)', (select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.public_get_booklet(uuid)'::regprocedure, 'public.booklet_set_snapshot(uuid,text,text)'::regprocedure,
                      'public.booklet_snapshot_path(uuid,text)'::regprocedure, 'public.booklet_snapshot_upload_ok(text)'::regprocedure,
                      'public._bk_tg_carry_snap_variants()'::regprocedure)))
) v(item, ok)
order by item;
