-- APPLY-0083.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0082.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 10 rows, every ok = true.
-- No edge function, no dashboard setup, no JWT settings needed: the booklet pictures live in the database.
-- 0083_booklet_images.sql - CANONICAL forward-only. Client booklet pictures stored in the database.
--
-- In plain words:
--   The client booklet shows the 2D floor plan and the 3D view as real pictures from the
--   builder. Until now those pictures needed a storage bucket plus an edge function that is
--   switched off. Now the picture bytes are kept in the database itself, so the booklet works
--   with only the database + the website (no edge function, no dashboard setup).
--   Each picture comes in two styles:
--       labels - numbered badges + legend (the approved look)
--       plain  - the model without labels
--   The studio picks per link which styles the client may see ("With labels" / "Without labels").
--
--   Changes (all additive, idempotent; nothing is ever deleted):
--     * table client_booklet_images (org, event, kind 2d|3d, variant labels|plain, mime,
--       bytes, data bytea). RLS on with NO policies + no table grants: only the functions
--       below touch it. A new upload simply supersedes older rows (newest created_at wins).
--     * client_booklets.image_variants jsonb - which styles the client sees (default all).
--     * booklet_put_image(event, kind, variant, mime, base64) - studio members who may EDIT
--       quotes, own studio only, studio not read-only; JPEG / PNG / WebP checked by magic
--       bytes, <= 1.5 MB, rate limited.
--     * booklet_image_info(event) - quotes VIEW: newest time per kind/variant (no bytes).
--     * booklet_staff_image(event, kind, variant) - quotes VIEW: newest picture (preview).
--     * booklet_set_image_variants(event, {2d_labels,2d_plain,3d_labels,3d_plain}) - quotes EDIT.
--     * public_get_booklet (wrapped, kept as __pre0083) adds images.{2d,3d}.{labels,plain}
--       = true/false (no bytes), only for sections + styles the link shows.
--     * public_get_booklet_image(token, kind, variant) - signed-out: same live / unexpired /
--       unrevoked token checks + the booklet read limiter; returns {mime, data(base64)} or null.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_booklet(uuid)') is null then
    raise exception '0083: public_get_booklet(uuid) is not installed (apply 0081 first)'; end if;
  if to_regprocedure('public._booklet_staff_quote(uuid,boolean)') is null then
    raise exception '0083: _booklet_staff_quote is not installed (apply 0065 first)'; end if;
  if to_regprocedure('public._bk_on(jsonb,text)') is null then
    raise exception '0083: _bk_on is not installed (apply 0069 first)'; end if;
end $$;

create table if not exists public.client_booklet_images (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null,
  quote_id    uuid        not null references public.quotes(id) on delete cascade,
  booklet_id  uuid        null,
  kind        text        not null,
  variant     text        not null,
  mime        text        not null,
  bytes       integer     not null,
  data        bytea       not null,
  created_by  uuid        null,
  created_at  timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_booklet_images_kind_ck') then
    alter table public.client_booklet_images add constraint client_booklet_images_kind_ck check (kind in ('2d', '3d')); end if;
  if not exists (select 1 from pg_constraint where conname = 'client_booklet_images_variant_ck') then
    alter table public.client_booklet_images add constraint client_booklet_images_variant_ck check (variant in ('labels', 'plain')); end if;
  if not exists (select 1 from pg_constraint where conname = 'client_booklet_images_mime_ck') then
    alter table public.client_booklet_images add constraint client_booklet_images_mime_ck check (mime in ('image/jpeg', 'image/png', 'image/webp')); end if;
  if not exists (select 1 from pg_constraint where conname = 'client_booklet_images_bytes_ck') then
    alter table public.client_booklet_images add constraint client_booklet_images_bytes_ck check (bytes > 0 and bytes <= 1572864 and bytes = octet_length(data)); end if;
end $$;
create index if not exists client_booklet_images_latest_idx on public.client_booklet_images (quote_id, kind, variant, created_at desc);
create index if not exists client_booklet_images_org_idx on public.client_booklet_images (org_id);
alter table public.client_booklet_images enable row level security;
revoke all on table public.client_booklet_images from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.client_booklet_images from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.client_booklet_images from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert on table public.client_booklet_images to service_role'; end if;
  -- suspended studios are read-only (0045 guard) + quote <-> studio integrity (0004 G4)
  if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.client_booklet_images'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.client_booklet_images for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.client_booklet_images'::regclass) then
    execute 'create trigger zz_quote_org_match before insert or update on public.client_booklet_images for each row execute function public.tg_quote_org_match()';
  end if;
end $$;

alter table public.client_booklets add column if not exists image_variants jsonb not null
  default '{"2d_labels":true,"2d_plain":true,"3d_labels":true,"3d_plain":true}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_booklets_image_variants_obj') then
    alter table public.client_booklets add constraint client_booklets_image_variants_obj check (jsonb_typeof(image_variants) = 'object') not valid;
  end if;
end $$;

-- is this style switched on for the link (missing key = on)
create or replace function public._bk_img_on(p jsonb, p_kind text, p_variant text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(case when jsonb_typeof(p) = 'object' then p ->> (p_kind || '_' || p_variant) end, 'true') = 'true';
$$;

-- magic bytes for the three allowed types
create or replace function public._bk_img_magic_ok(p_mime text, p_data bytea)
returns boolean language sql immutable set search_path = '' as $$
  select case p_mime
    when 'image/jpeg' then octet_length(p_data) >= 4 and substring(p_data from 1 for 3) = '\xffd8ff'::bytea
    when 'image/png'  then octet_length(p_data) >= 8 and substring(p_data from 1 for 8) = '\x89504e470d0a1a0a'::bytea
    when 'image/webp' then octet_length(p_data) >= 12 and substring(p_data from 1 for 4) = '\x52494646'::bytea
                           and substring(p_data from 9 for 4) = '\x57454250'::bytea
    else false end;
$$;

create or replace function public.booklet_put_image(p_quote_id uuid, p_kind text, p_variant text, p_mime text, p_data text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083
declare v_org uuid; v_bin bytea; v_id uuid; v_bk uuid; v_wait int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);         -- signed in, own studio, quotes EDIT, event exists
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('2d', '3d') then raise exception 'kind must be 2d or 3d' using errcode = '22023'; end if;
  if coalesce(p_variant, '') not in ('labels', 'plain') then raise exception 'variant must be labels or plain' using errcode = '22023'; end if;
  if coalesce(p_mime, '') not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'picture must be JPEG, PNG or WebP' using errcode = '22023'; end if;
  if p_data is null or length(p_data) = 0 or length(p_data) > 2100000 then raise exception 'picture must be 1.5 MB or smaller' using errcode = '22023'; end if;
  v_wait := public.rate_hit('booklet.img_put', md5('bkimg:' || v_org::text), 3600, 240);
  if v_wait > 0 then raise exception 'too many uploads - try again in % seconds', v_wait using errcode = 'P0001'; end if;
  begin
    v_bin := decode(p_data, 'base64');
  exception when others then
    raise exception 'picture data is not valid base64' using errcode = '22023';
  end;
  if octet_length(v_bin) = 0 or octet_length(v_bin) > 1572864 then raise exception 'picture must be 1.5 MB or smaller' using errcode = '22023'; end if;
  if not public._bk_img_magic_ok(p_mime, v_bin) then raise exception 'picture content does not match its type' using errcode = '22023'; end if;
  select b.id into v_bk from public.client_booklets b
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null order by b.created_at desc limit 1;
  insert into public.client_booklet_images(org_id, quote_id, booklet_id, kind, variant, mime, bytes, data, created_by)
    values (v_org, p_quote_id, v_bk, p_kind, p_variant, p_mime, octet_length(v_bin), v_bin, auth.uid())
    returning id into v_id;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'booklet.snapshot', 'client_booklets', p_quote_id::text, p_quote_id,
            jsonb_build_object('kind', p_kind, 'variant', p_variant, 'bytes', octet_length(v_bin), 'set', true), v_org);
  return jsonb_build_object('ok', true, 'id', v_id, 'kind', p_kind, 'variant', p_variant, 'bytes', octet_length(v_bin));
end $$;

-- staff: newest picture time per kind / variant (no bytes) -> {"2d":{"labels":ts,"plain":ts},"3d":{...}}
create or replace function public.booklet_image_info(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-images-0083
declare v_org uuid; r jsonb := '{}'::jsonb; x record;
begin
  v_org := public._booklet_staff_quote(p_quote_id, false);
  for x in select i.kind, i.variant, max(i.created_at) as at from public.client_booklet_images i
            where i.quote_id = p_quote_id and i.org_id = v_org group by i.kind, i.variant loop
    r := jsonb_set(case when r ? x.kind then r else r || jsonb_build_object(x.kind, '{}'::jsonb) end,
                   array[x.kind, x.variant], to_jsonb(x.at));
  end loop;
  return r;
end $$;

-- staff: the newest picture (for the share dialog preview)
create or replace function public.booklet_staff_image(p_quote_id uuid, p_kind text, p_variant text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-images-0083
declare v_org uuid; i public.client_booklet_images;
begin
  v_org := public._booklet_staff_quote(p_quote_id, false);
  select * into i from public.client_booklet_images x
   where x.quote_id = p_quote_id and x.org_id = v_org and x.kind = p_kind and x.variant = p_variant
   order by x.created_at desc, x.id desc limit 1;
  if i.id is null then return null; end if;
  return jsonb_build_object('mime', i.mime, 'data', translate(encode(i.data, 'base64'), E'\n\r', ''), 'created_at', i.created_at, 'bytes', i.bytes);
end $$;

-- staff: which styles the live link shows
create or replace function public.booklet_set_image_variants(p_quote_id uuid, p_variants jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083
declare v_org uuid; k text; v jsonb := '{"2d_labels":true,"2d_plain":true,"3d_labels":true,"3d_plain":true}'::jsonb; n int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  if p_variants is null or jsonb_typeof(p_variants) <> 'object' then raise exception 'variants must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_variants) loop
    if not (v ? k) then raise exception 'unknown picture style %', k using errcode = '22023'; end if;
    if jsonb_typeof(p_variants -> k) <> 'boolean' then raise exception 'picture style % must be true or false', k using errcode = '22023'; end if;
  end loop;
  v := v || p_variants;
  update public.client_booklets b set image_variants = v
   where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0, 'image_variants', v);
end $$;

-- signed-out: one picture of a live link (base64), or null
create or replace function public.public_get_booklet_image(p_token uuid, p_kind text, p_variant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083
declare b public.client_booklets; i public.client_booklet_images; v_wait int;
begin
  if p_token is null or coalesce(p_kind, '') not in ('2d', '3d') or coalesce(p_variant, '') not in ('labels', 'plain') then return null; end if;
  v_wait := public.rate_hit('booklet.read', md5('booklet:' || p_token::text), 600, 120);   -- the booklet read limiter
  if v_wait > 0 then raise exception 'too many requests - try again in % seconds', v_wait using errcode = 'P0001'; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now()
     or not exists (select 1 from public.quotes q where q.id = b.quote_id and q.org_id = b.org_id and q.deleted_at is null) then return null; end if;
  if not public._bk_on(b.sections, case when p_kind = '2d' then 'layout2d' else 'layout3d' end) then return null; end if;
  if not public._bk_img_on(b.image_variants, p_kind, p_variant) then return null; end if;
  select * into i from public.client_booklet_images x
   where x.quote_id = b.quote_id and x.org_id = b.org_id and x.kind = p_kind and x.variant = p_variant
   order by x.created_at desc, x.id desc limit 1;
  if i.id is null then return null; end if;
  return jsonb_build_object('mime', i.mime, 'data', translate(encode(i.data, 'base64'), E'\n\r', ''));
end $$;

-- public reader: + images flags (no bytes)
do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0083(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0083;
  end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083: the 0081 reader, then which database pictures this link shows
declare r jsonb; b public.client_booklets; k text; v text; f jsonb := '{}'::jsonb; g jsonb;
begin
  r := public.public_get_booklet__pre0083(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null then return r; end if;
  foreach k in array array['2d', '3d'] loop
    g := '{}'::jsonb;
    foreach v in array array['labels', 'plain'] loop
      g := g || jsonb_build_object(v, public._bk_on(b.sections, case when k = '2d' then 'layout2d' else 'layout3d' end)
               and public._bk_img_on(b.image_variants, k, v)
               and exists (select 1 from public.client_booklet_images i where i.quote_id = b.quote_id and i.org_id = b.org_id and i.kind = k and i.variant = v));
    end loop;
    f := f || jsonb_build_object(k, g);
  end loop;
  return r || jsonb_build_object('images', f);
end $$;

do $$ declare s text; begin
  foreach s in array array['public.public_get_booklet__pre0083(uuid)', 'public.public_get_booklet(uuid)',
      'public.public_get_booklet_image(uuid,text,text)', 'public.booklet_put_image(uuid,text,text,text,text)',
      'public.booklet_image_info(uuid)', 'public.booklet_staff_image(uuid,text,text)',
      'public.booklet_set_image_variants(uuid,jsonb)', 'public._bk_img_on(jsonb,text,text)', 'public._bk_img_magic_ok(text,bytea)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
    grant execute on function public.public_get_booklet_image(uuid, text, text) to authenticated;
    grant execute on function public.booklet_put_image(uuid, text, text, text, text) to authenticated;
    grant execute on function public.booklet_image_info(uuid) to authenticated;
    grant execute on function public.booklet_staff_image(uuid, text, text) to authenticated;
    grant execute on function public.booklet_set_image_variants(uuid, jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
    grant execute on function public.public_get_booklet_image(uuid, text, text) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.public_get_booklet__pre0083(uuid) to service_role;
  end if;
end $$;

-- VERIFY (expect 10 rows, ALL ok = true)
select item, ok from (values
  ('01 client_booklet_images table + RLS on', exists (select 1 from pg_class c where c.oid = to_regclass('public.client_booklet_images') and c.relrowsecurity)),
  ('02 no direct table access for anon / authenticated', not has_table_privilege('anon', 'public.client_booklet_images', 'select')
      and not has_table_privilege('authenticated', 'public.client_booklet_images', 'select')
      and not has_table_privilege('authenticated', 'public.client_booklet_images', 'insert')),
  ('03 checks: kind / variant / mime / size', (select count(*) from pg_constraint where conrelid = to_regclass('public.client_booklet_images')
      and conname in ('client_booklet_images_kind_ck', 'client_booklet_images_variant_ck', 'client_booklet_images_mime_ck', 'client_booklet_images_bytes_ck')) = 4),
  ('04 studio read-only + quote/org triggers', (select count(*) from pg_trigger where tgrelid = to_regclass('public.client_booklet_images')
      and tgname in ('zzz_studio_read_only', 'zz_quote_org_match')) = 2),
  ('05 image_variants column present', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_booklets' and column_name = 'image_variants')),
  ('06 magic bytes checker', public._bk_img_magic_ok('image/jpeg', '\xffd8ffe0'::bytea) and not public._bk_img_magic_ok('image/png', '\xffd8ffe0'::bytea)
      and public._bk_img_magic_ok('image/png', '\x89504e470d0a1a0a'::bytea) and not public._bk_img_magic_ok('image/gif', '\x474946383961'::bytea)),
  ('07 anon may only read (reader + image)', has_function_privilege('anon', 'public.public_get_booklet_image(uuid,text,text)', 'execute')
      and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.booklet_put_image(uuid,text,text,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.booklet_staff_image(uuid,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.booklet_set_image_variants(uuid,jsonb)', 'execute')),
  ('08 reader wrapped; inner not anon-callable', position('booklet-images-0083' in (select p.prosrc from pg_proc p where p.oid = 'public.public_get_booklet(uuid)'::regprocedure)) > 0
      and not has_function_privilege('anon', 'public.public_get_booklet__pre0083(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.public_get_booklet__pre0083(uuid)', 'execute')),
  ('09 staff RPCs callable by signed-in users', has_function_privilege('authenticated', 'public.booklet_put_image(uuid,text,text,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.booklet_image_info(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.booklet_staff_image(uuid,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.booklet_set_image_variants(uuid,jsonb)', 'execute')),
  ('10 new functions definer-safe (search_path empty)', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.public_get_booklet(uuid)'::regprocedure, 'public.public_get_booklet_image(uuid,text,text)'::regprocedure,
                      'public.booklet_put_image(uuid,text,text,text,text)'::regprocedure, 'public.booklet_image_info(uuid)'::regprocedure,
                      'public.booklet_staff_image(uuid,text,text)'::regprocedure, 'public.booklet_set_image_variants(uuid,jsonb)'::regprocedure)))
) v(item, ok)
order by item;
