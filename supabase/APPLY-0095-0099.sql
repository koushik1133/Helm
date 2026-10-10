-- APPLY-0095-0099.sql - paste into the Supabase SQL editor (prod or staging). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains, in MANIFEST order:
--   0095 photo renders (3 new tables, RLS, no grants; render RPCs; booklet picture kind 'photo')
--   0096 studio layout templates (1 new table, archive-only, save / archive / default / duplicate RPCs)
--   0097 trial demo data (organizations.trial_mode, is_demo flags, demo seed / clear RPCs touching only
--        is_demo rows; demo events and contacts (+91 00000 00xxx, @example.com) never messaged or charged)
--   0098 client approval link: paid vs total from the quote_payments ledger (one read-only function)
--   0099 staff pkg_payment WhatsApp carries balance due / paid in full (one trigger function body)
-- Needs prod at 0094 (APPLY-0094.sql pasted first) - checked below with a clear message.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- ---- prerequisite: database is at 0094 ----------------------------------------------------------
do $$ begin
  if to_regprocedure('public.insights_range(date,date)') is null
     or position('per-currency-0094' in (select prosrc from pg_proc where oid = 'public.insights_range(date,date)'::regprocedure)) = 0 then
    raise exception 'APPLY-0095-0099: this database is not at 0094 yet - paste supabase/APPLY-0094.sql first, then this file';
  end if;
  if to_regclass('public.client_booklet_images') is null or to_regclass('public.venues') is null or to_regclass('public.package_selections') is null then
    raise exception 'APPLY-0095-0099: 0069 / 0083 / 0085 objects missing - this database is behind 0094; apply the earlier APPLY files first';
  end if;
end $$;

-- =================================================================================================
-- 0095_photo_render.sql
-- =================================================================================================
-- 0095_photo_render.sql - CANONICAL forward-only. Photo-realistic renders of a planned event.
--
-- In plain words:
--   The builder's "Render" button can turn the floor plan + 3D view into a realistic
--   photograph of the event (made by an image model on the SERVER - edge function
--   render-photo; the API key never reaches the browser). This migration adds where those
--   photos are kept, who may make them, and how many a studio may make each month.
--
--   Changes (all additive, idempotent; nothing is ever deleted):
--     * table photo_render_settings (one row per studio): enabled, monthly_quota (images per
--       calendar month), hourly_limit (render requests per hour). Missing row = defaults
--       (on, 60 / month, 20 / hour).
--     * table photo_render_usage: one row per render request (studio, user, event, model,
--       size, quality, number of images, status pending|ok|error, cost estimate in USD) - for
--       billing. Written only by the edge function (service role) + the begin RPC below.
--     * table photo_renders: the picture bytes (JPEG / PNG / WebP, <= 6 MB) in the database,
--       like the booklet pictures (0083) - no storage bucket, nothing public.
--       All three tables: RLS on, NO policies, no grants to anon / authenticated - only the
--       SECURITY DEFINER functions below (and the service role) touch them.
--     * new access area "photo_render" (Control Center -> Users & access). EDIT = may make
--       photo renders. Seeded EDIT for every role that can already EDIT quotes; admins always.
--     * photo_render_begin(event, n, quality, size, model, cost) - runs AS THE CALLER from the
--       edge function: signed in, own studio, quotes EDIT + photo_render EDIT, studio writable,
--       renders switched on, hourly rate limit, monthly quota (n images) under a studio lock.
--       Reserves a 'pending' usage row and returns its id.
--     * photo_render_list(event) / photo_render_image(render) - quotes VIEW, own studio.
--     * photo_render_use_in_booklet(render) - quotes EDIT: copies the photo into the client
--       booklet pictures (0083) as its OWN kind 'photo' (variant plain) - the automatic 2D / 3D
--       re-capture only ever writes 2d / 3d, so it never replaces the photo; <= 1.5 MB.
--       0083 extended additively: client_booklet_images kind may also be 'photo'; the signed-out
--       readers public_get_booklet (images.photo.plain flag) and public_get_booklet_image
--       (kind 'photo') show it inside the 3D section, same link / section / style rules.
--     * photo_render_job(usage) - quotes VIEW, own studio: status of one render request
--       (pending | ok | error) + its photo ids - the builder polls it (async renders).
--     * photo_render_settings_get() / photo_render_settings_set(enabled, quota, hourly) -
--       get: any staff member of the studio (+ this month's usage); set: Control Center EDIT.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._booklet_staff_quote(uuid,boolean)') is null then
    raise exception '0095: _booklet_staff_quote is not installed (apply 0065 first)'; end if;
  if to_regprocedure('public._bk_img_magic_ok(text,bytea)') is null then
    raise exception '0095: _bk_img_magic_ok is not installed (apply 0083 first)'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then
    raise exception '0095: rate_hit is not installed (apply 0050 first)'; end if;
  if to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0095: _studio_writable is not installed'; end if;
end $$;

-- ---- tables --------------------------------------------------------------------------------
create table if not exists public.photo_render_settings (
  org_id        uuid        primary key,
  enabled       boolean     not null default true,
  monthly_quota integer     not null default 60,
  hourly_limit  integer     not null default 20,
  updated_by    uuid        null,
  updated_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'photo_render_settings_quota_ck') then
    alter table public.photo_render_settings add constraint photo_render_settings_quota_ck
      check (monthly_quota between 0 and 10000 and hourly_limit between 1 and 500); end if;
end $$;

create table if not exists public.photo_render_usage (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null,
  user_id       uuid        null,
  quote_id      uuid        not null references public.quotes(id) on delete cascade,
  model         text        not null,
  size          text        not null,
  quality       text        not null,
  n             integer     not null,
  status        text        not null default 'pending',
  error         text        null,
  cost_usd      numeric(10,4) not null default 0,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz null
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'photo_render_usage_status_ck') then
    alter table public.photo_render_usage add constraint photo_render_usage_status_ck check (status in ('pending', 'ok', 'error')); end if;
  if not exists (select 1 from pg_constraint where conname = 'photo_render_usage_n_ck') then
    alter table public.photo_render_usage add constraint photo_render_usage_n_ck check (n between 1 and 4); end if;
end $$;
create index if not exists photo_render_usage_org_idx on public.photo_render_usage (org_id, created_at desc);

create table if not exists public.photo_renders (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null,
  quote_id    uuid        not null references public.quotes(id) on delete cascade,
  usage_id    uuid        null,
  created_by  uuid        null,
  style       text        not null default '',
  camera      text        not null default '',
  theme       text        not null default '',
  quality     text        not null default '',
  model       text        not null default '',
  size        text        not null default '',
  prompt      text        not null default '',
  mime        text        not null,
  bytes       integer     not null,
  data        bytea       not null,
  created_at  timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'photo_renders_mime_ck') then
    alter table public.photo_renders add constraint photo_renders_mime_ck check (mime in ('image/jpeg', 'image/png', 'image/webp')); end if;
  if not exists (select 1 from pg_constraint where conname = 'photo_renders_bytes_ck') then
    alter table public.photo_renders add constraint photo_renders_bytes_ck check (bytes > 0 and bytes <= 6291456 and bytes = octet_length(data)); end if;
  if not exists (select 1 from pg_constraint where conname = 'photo_renders_text_ck') then
    alter table public.photo_renders add constraint photo_renders_text_ck
      check (length(style) <= 40 and length(camera) <= 40 and length(theme) <= 200 and length(prompt) <= 32000); end if;
end $$;
create index if not exists photo_renders_quote_idx on public.photo_renders (quote_id, created_at desc);
create index if not exists photo_renders_org_idx on public.photo_renders (org_id);

do $$ declare t text; begin
  foreach t in array array['photo_render_settings', 'photo_render_usage', 'photo_renders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select, insert, update on table public.%I to service_role', t); end if;
  end loop;
  -- suspended studios are read-only (0045 guard) + quote <-> studio integrity (0004 G4)
  foreach t in array array['photo_render_settings', 'photo_render_usage', 'photo_renders'] loop
    if to_regprocedure('public.tg_studio_read_only()') is not null
       and not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(''org_id'')', t);
    end if;
  end loop;
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    if not exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.photo_renders'::regclass) then
      execute 'create trigger zz_quote_org_match before insert or update on public.photo_renders for each row execute function public.tg_quote_org_match()';
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'zz_quote_org_match' and tgrelid = 'public.photo_render_usage'::regclass) then
      execute 'create trigger zz_quote_org_match before insert or update on public.photo_render_usage for each row execute function public.tg_quote_org_match()';
    end if;
  end if;
end $$;

-- ---- access area: photo_render EDIT for roles that already EDIT quotes (never overwrites) -----
insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
  select ra.role, 'photo_render', true, true, ra.org_id, now()
    from public.role_access ra where ra.area = 'quotes' and ra.can_view and ra.can_edit
on conflict (role, area, org_id) do nothing;

-- ---- helpers -------------------------------------------------------------------------------
create or replace function public._photo_render_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce((select s.enabled from public.photo_render_settings s where s.org_id = p_org), true),
    'monthly_quota', coalesce((select s.monthly_quota from public.photo_render_settings s where s.org_id = p_org), 60),
    'hourly_limit', coalesce((select s.hourly_limit from public.photo_render_settings s where s.org_id = p_org), 20));
$$;

-- images used this calendar month (finished ok + still running in the last 15 minutes)
create or replace function public._photo_render_used(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(sum(u.n), 0)::int from public.photo_render_usage u
   where u.org_id = p_org and u.created_at >= date_trunc('month', now())
     and (u.status = 'ok' or (u.status = 'pending' and u.created_at > now() - interval '15 minutes'));
$$;

-- ---- begin (called AS THE CALLER by the edge function) --------------------------------------
create or replace function public.photo_render_begin(p_quote_id uuid, p_n integer, p_quality text, p_size text, p_model text, p_cost numeric)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- photo-render-0095
declare v_org uuid; v_cfg jsonb; v_used int; v_wait int; v_id uuid;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);          -- signed in, staff, own studio, quotes EDIT
  if not public.has_area('photo_render', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if p_n is null or p_n < 1 or p_n > 4 then raise exception 'number of images must be 1 to 4' using errcode = '22023'; end if;
  if coalesce(p_quality, '') not in ('low', 'medium', 'high') then raise exception 'bad quality' using errcode = '22023'; end if;
  if coalesce(p_size, '') !~ '^[0-9]{3,4}x[0-9]{3,4}$' then raise exception 'bad size' using errcode = '22023'; end if;
  if coalesce(p_model, '') !~ '^[a-z0-9.-]{1,60}$' then raise exception 'bad model' using errcode = '22023'; end if;
  v_cfg := public._photo_render_cfg(v_org);
  if not (v_cfg ->> 'enabled')::boolean then raise exception 'photo renders are switched off for this studio' using errcode = 'P0001', hint = 'render_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended('photo_render:' || v_org::text, 0));
  v_wait := public.rate_hit('photo_render.hour', md5('pr:' || v_org::text), 3600, (v_cfg ->> 'hourly_limit')::int);
  if v_wait > 0 then raise exception 'too many renders - try again in % seconds', v_wait using errcode = 'P0001', hint = 'render_rate_limited'; end if;
  v_used := public._photo_render_used(v_org);
  if v_used + p_n > (v_cfg ->> 'monthly_quota')::int then
    raise exception 'monthly photo render quota reached (% of % used)', v_used, (v_cfg ->> 'monthly_quota')::int using errcode = 'P0001', hint = 'render_quota';
  end if;
  insert into public.photo_render_usage(org_id, user_id, quote_id, model, size, quality, n, status, cost_usd)
    values (v_org, auth.uid(), p_quote_id, p_model, p_size, p_quality, p_n, 'pending', greatest(0, least(coalesce(p_cost, 0), 100)))
    returning id into v_id;
  return jsonb_build_object('usage_id', v_id, 'org_id', v_org, 'used', v_used + p_n, 'quota', (v_cfg ->> 'monthly_quota')::int);
end $$;

-- ---- read ----------------------------------------------------------------------------------
create or replace function public.photo_render_list(p_quote_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  v_org := public._booklet_staff_quote(p_quote_id, false);
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'created_at', r.created_at, 'style', r.style, 'camera', r.camera,
      'theme', r.theme, 'quality', r.quality, 'size', r.size, 'mime', r.mime, 'bytes', r.bytes) order by r.created_at desc)
    from (select * from public.photo_renders x where x.quote_id = p_quote_id and x.org_id = v_org order by x.created_at desc limit 60) r), '[]'::jsonb);
end $$;

create or replace function public.photo_render_image(p_render_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.photo_renders;
begin
  select * into r from public.photo_renders x where x.id = p_render_id;
  if r.id is null then raise exception 'render not found' using errcode = 'P0002'; end if;
  perform public._booklet_staff_quote(r.quote_id, false);         -- raises for another studio
  if r.org_id is distinct from public.current_org_id() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('id', r.id, 'mime', r.mime, 'data', encode(r.data, 'base64'));
end $$;

-- ---- use in the client booklet (0083 picture: 3D without labels) -----------------------------
create or replace function public.photo_render_use_in_booklet(p_render_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.photo_renders; v_org uuid; v_id uuid; v_bk uuid;
begin
  select * into r from public.photo_renders x where x.id = p_render_id;
  if r.id is null then raise exception 'render not found' using errcode = 'P0002'; end if;
  v_org := public._booklet_staff_quote(r.quote_id, true);
  if r.org_id is distinct from v_org then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if r.bytes > 1572864 then raise exception 'this photo is larger than 1.5 MB - download it and add it by hand' using errcode = '22023'; end if;
  if not public._bk_img_magic_ok(r.mime, r.data) then raise exception 'picture type not allowed' using errcode = '22023'; end if;
  select b.id into v_bk from public.client_booklets b where b.quote_id = r.quote_id and b.org_id = v_org and b.revoked_at is null
   order by b.created_at desc limit 1;
  insert into public.client_booklet_images(org_id, quote_id, booklet_id, kind, variant, mime, bytes, data, created_by)
    values (v_org, r.quote_id, v_bk, 'photo', 'plain', r.mime, r.bytes, r.data, auth.uid()) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'kind', 'photo', 'variant', 'plain');
end $$;

-- ---- async render status (the edge function answers at once; the builder polls this) --------
create or replace function public.photo_render_job(p_usage_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.photo_render_usage;
begin
  select * into u from public.photo_render_usage x where x.id = p_usage_id;
  if u.id is null then raise exception 'render not found' using errcode = 'P0002'; end if;
  perform public._booklet_staff_quote(u.quote_id, false);         -- raises for another studio
  if u.org_id is distinct from public.current_org_id() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('id', u.id, 'status', case when u.status = 'pending' and u.created_at < now() - interval '15 minutes' then 'error' else u.status end,
    'error', case when u.status = 'pending' and u.created_at < now() - interval '15 minutes' then 'timeout' else u.error end,
    'renders', coalesce((select jsonb_agg(r.id order by r.created_at) from public.photo_renders r where r.usage_id = u.id and r.org_id = u.org_id), '[]'::jsonb));
end $$;

-- ---- 0083 extended: booklet picture kind 'photo' (never written by the 2D / 3D re-capture) ----
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'client_booklet_images_kind_ck'
               and pg_get_constraintdef(oid) not like '%photo%') then
    alter table public.client_booklet_images drop constraint client_booklet_images_kind_ck;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_booklet_images_kind_ck') then
    alter table public.client_booklet_images add constraint client_booklet_images_kind_ck check (kind in ('2d', '3d', 'photo'));
  end if;
end $$;

create or replace function public.public_get_booklet_image(p_token uuid, p_kind text, p_variant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083 (+ 0095 kind photo)
declare b public.client_booklets; i public.client_booklet_images; v_wait int;
begin
  if p_token is null or coalesce(p_kind, '') not in ('2d', '3d', 'photo') or coalesce(p_variant, '') not in ('labels', 'plain')
     or (p_kind = 'photo' and p_variant <> 'plain') then return null; end if;
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

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-images-0083: the 0081 reader, then which database pictures this link shows (+ 0095 photo)
declare r jsonb; b public.client_booklets; k text; v text; f jsonb := '{}'::jsonb; g jsonb;
begin
  r := public.public_get_booklet__pre0083(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r) <> 'object' then return r; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null then return r; end if;
  foreach k in array array['2d', '3d', 'photo'] loop
    g := '{}'::jsonb;
    foreach v in array case when k = 'photo' then array['plain'] else array['labels', 'plain'] end loop
      g := g || jsonb_build_object(v, public._bk_on(b.sections, case when k = '2d' then 'layout2d' else 'layout3d' end)
               and public._bk_img_on(b.image_variants, k, v)
               and exists (select 1 from public.client_booklet_images i where i.quote_id = b.quote_id and i.org_id = b.org_id and i.kind = k and i.variant = v));
    end loop;
    f := f || jsonb_build_object(k, g);
  end loop;
  return r || jsonb_build_object('images', f);
end $$;

-- ---- studio settings (Control Center) --------------------------------------------------------
create or replace function public.photo_render_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_role text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.org_id = v_org;
  if v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._photo_render_cfg(v_org) || jsonb_build_object(
    'used_this_month', public._photo_render_used(v_org),
    'cost_this_month_usd', coalesce((select sum(u.cost_usd) from public.photo_render_usage u where u.org_id = v_org
                                      and u.status = 'ok' and u.created_at >= date_trunc('month', now())), 0),
    'can_render', public.has_area('photo_render', 'edit') and public.has_area('quotes', 'edit'),
    'can_manage', public.has_area('controls', 'edit'));
end $$;

create or replace function public.photo_render_settings_set(p_enabled boolean, p_monthly_quota integer, p_hourly_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if p_monthly_quota is null or p_monthly_quota < 0 or p_monthly_quota > 10000 then raise exception 'monthly quota must be 0 to 10000' using errcode = '22023'; end if;
  if p_hourly_limit is null or p_hourly_limit < 1 or p_hourly_limit > 500 then raise exception 'hourly limit must be 1 to 500' using errcode = '22023'; end if;
  insert into public.photo_render_settings(org_id, enabled, monthly_quota, hourly_limit, updated_by, updated_at)
    values (v_org, coalesce(p_enabled, true), p_monthly_quota, p_hourly_limit, auth.uid(), now())
  on conflict (org_id) do update set enabled = excluded.enabled, monthly_quota = excluded.monthly_quota,
    hourly_limit = excluded.hourly_limit, updated_by = excluded.updated_by, updated_at = now();
  return public.photo_render_settings_get();
end $$;

-- ---- grants ----------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array['public._photo_render_cfg(uuid)', 'public._photo_render_used(uuid)',
      'public.photo_render_begin(uuid,integer,text,text,text,numeric)', 'public.photo_render_list(uuid)',
      'public.photo_render_image(uuid)', 'public.photo_render_use_in_booklet(uuid)',
      'public.photo_render_settings_get()', 'public.photo_render_settings_set(boolean,integer,integer)',
      'public.photo_render_job(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.photo_render_begin(uuid, integer, text, text, text, numeric) to authenticated;
    grant execute on function public.photo_render_list(uuid) to authenticated;
    grant execute on function public.photo_render_image(uuid) to authenticated;
    grant execute on function public.photo_render_use_in_booklet(uuid) to authenticated;
    grant execute on function public.photo_render_settings_get() to authenticated;
    grant execute on function public.photo_render_settings_set(boolean, integer, integer) to authenticated;
    grant execute on function public.photo_render_job(uuid) to authenticated;
    -- the two re-created 0083 readers keep exactly their 0083 callers
    grant execute on function public.public_get_booklet(uuid) to authenticated;
    grant execute on function public.public_get_booklet_image(uuid, text, text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
    grant execute on function public.public_get_booklet_image(uuid, text, text) to anon;
  end if;
end $$;

-- =================================================================================================
-- 0096_studio_layout_templates.sql
-- =================================================================================================
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

-- =================================================================================================
-- 0097_trial_demo.sql
-- =================================================================================================
-- ============================================================================
-- 0097_trial_demo.sql - CANONICAL forward-only. Free-trial "Try with demo data".
-- REQUIRES 0056 (my_start_trial), 0058 (my_trial_status), 0085 (venues),
--          0052 / 0093 wrappers (payment_link_begin, create_payment, otp_send_authorize).
--
-- In plain words: when a studio starts its 14-day trial the owner picks
--   "Try with demo data"  -> seed_demo_data() fills the studio with a clearly-marked
--                            sample studio (every name starts with "Demo -"), or
--   "Start with my own data" -> set_trial_mode('own') and the onboarding wizard.
-- Any time later: reset_demo_data() (wipe + re-seed the sample) or clear_demo_data()
-- (remove the sample, keep everything real) - both studio-admin only.
--
--   * organizations.trial_mode ('demo' | 'own' | null).
--   * is_demo boolean (default false) on every table the sample writes. Only the
--     database functions below may set it: the app (anon / authenticated) can never
--     flag a real row as demo or un-flag a demo row (trigger zz_a97_demo_flag_guard).
--   * ZERO DATA LOSS: clear/reset delete ONLY rows with is_demo = true AND org_id =
--     the caller's studio. A demo master row (staff, vendor, item, dish, package)
--     that one of the studio's REAL events still uses is kept (deactivated) instead
--     of deleted, so no real row is ever cascaded away or has a link nulled.
--     Venues are never deleted (0085 rule) - demo venues are deactivated.
--     Each function is one statement = one transaction: all or nothing.
--   * No real messages or money for demo records: whatsapp_authorize,
--     otp_send_authorize, payment_link_begin and create_payment refuse a demo event
--     (and WhatsApp refuses a demo contact's number); comms_outbox / pkg_outbox rows
--     for a demo event are stored as 'skipped' so the senders never pick them up.
--   * Billing / HQ: Helm bills per studio subscription (0045) - no usage counter
--     reads these tables, and HQ revenue reads only subscription payments, so demo
--     rows never count. my_demo_status() reports the counts for the UI.
-- Additive + idempotent. No real row is deleted or overwritten; seeding is fill-only.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.my_start_trial(text,text)') is null then
    raise exception '0097: 0056 (onboarding checkout) is not installed on this database'; end if;
  if to_regprocedure('public.my_trial_status()') is null then
    raise exception '0097: 0058 (trial reminders) is not installed on this database'; end if;
  if to_regclass('public.venues') is null then
    raise exception '0097: 0085 (venues) is not installed on this database'; end if;
end $$;

-- ---- 0) keep this database's own gate bodies (rename once) ------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['whatsapp_authorize', 'uuid, text'],
    ['otp_send_authorize', 'uuid, text'],
    ['payment_link_begin', 'uuid, integer'],
    ['create_payment',     'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0097', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0097: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0097');
    end if;
  end loop;
end $$;

-- ---- 1) columns (additive) ----------------------------------------------------------------
alter table public.organizations add column if not exists trial_mode text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_trial_mode_chk97') then
    alter table public.organizations add constraint organizations_trial_mode_chk97
      check (trial_mode is null or trial_mode in ('demo','own'));
  end if;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads','quotes','venues','menu_templates','dish_catalog','inventory_items',
                           'crew_members','vendors','layouts','event_checklist','quote_payments','payment_milestones'] loop
    execute format('alter table public.%I add column if not exists is_demo boolean not null default false', t);
    execute format('create index if not exists %I on public.%I (org_id) where is_demo', t || '_demo_idx97', t);
  end loop;
end $$;

-- ---- 2) only the database may set / clear the demo flag ------------------------------------
-- One exception keeps the owner's work safe: when someone renames a demo row so it no
-- longer starts with "Demo -", they have adopted it - it becomes a real row (is_demo
-- false) and clear / reset will never remove it.
create or replace function public._a97_tg_demo_flag_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_label text;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.is_demo then
      raise exception 'demo data is managed by Helm, not by the app' using errcode = '42501', hint = 'demo_flag';
    end if;
    if tg_op = 'UPDATE' and old.is_demo then
      v_label := coalesce(to_jsonb(new) ->> 'name', to_jsonb(new) ->> 'title', to_jsonb(new) ->> 'label');
      if v_label is not null and v_label not like E'Demo \u00b7%' then
        new.is_demo := false;                       -- adopted by the studio: now real
        return new;
      end if;
    end if;
    if tg_op = 'UPDATE' and new.is_demo is distinct from old.is_demo then
      raise exception 'demo data is managed by Helm, not by the app' using errcode = '42501', hint = 'demo_flag';
    end if;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads','quotes','venues','menu_templates','dish_catalog','inventory_items',
                           'crew_members','vendors','layouts','event_checklist','quote_payments','payment_milestones'] loop
    if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_a97_demo_flag_guard') then
      execute format('create trigger zz_a97_demo_flag_guard before insert or update on public.%I for each row execute function public._a97_tg_demo_flag_guard()', t);
    end if;
  end loop;
end $$;

-- ---- 3) helpers ----------------------------------------------------------------------------
create or replace function public._is_demo_quote(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select q.is_demo from public.quotes q where q.id = p_quote), false);
$$;
revoke all on function public._is_demo_quote(uuid) from public, anon, authenticated;

-- a phone number that belongs to a demo contact of this studio (never message it).
-- Demo contacts use +91 00000 00xxx: a national number starting 00000 is not a dialable
-- mobile anywhere, and any such number is refused outright (even if the demo flag is lost).
create or replace function public._is_demo_phone(p_org uuid, p_phone text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_phone is not null and length(regexp_replace(p_phone, '\D', '', 'g')) >= 7 and (
       right(regexp_replace(p_phone, '\D', '', 'g'), 10) like '00000%'
    or exists (select 1 from public.crew_members c where c.org_id = p_org and c.is_demo
                 and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
    or exists (select 1 from public.vendors v where v.org_id = p_org and v.is_demo
                 and right(regexp_replace(coalesce(v.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10))
    or exists (select 1 from public.leads l where l.org_id = p_org and l.is_demo
                 and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(p_phone, '\D', '', 'g'), 10)));
$$;
revoke all on function public._is_demo_phone(uuid, text) from public, anon, authenticated;

-- ---- 4) gates: no real messages / payments for demo records ---------------------------------
create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if public._is_demo_quote(p_quote)
     or public._is_demo_phone(coalesce((select q.org_id from public.quotes q where q.id = p_quote), public.current_org_id()), p_recipient) then
    raise exception 'Demo data: messages are switched off for demo events and contacts' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.whatsapp_authorize__pre0097(p_quote, p_recipient);
end $$;

create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo)
     or public._is_demo_phone(coalesce((select q.org_id from public.quotes q where q.approval_token = p_token), public.current_org_id()), p_phone) then
    raise exception 'Demo data: approval codes are not sent for demo events' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.otp_send_authorize__pre0097(p_token, p_phone);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo) then
    return jsonb_build_object('action', 'not_approved', 'reason', 'demo_data');
  end if;
  return public.payment_link_begin__pre0097(p_token, p_ttl_minutes);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.approval_token = p_token and q.is_demo) then
    raise exception 'Demo data: payments are switched off for demo events' using errcode = '42501', hint = 'demo_data';
  end if;
  return public.create_payment__pre0097(p_token);
end $$;

-- each wrapper gets exactly the callers its migration documents (0027 / 0033 / 0052);
-- the wrapped body is reachable only through its wrapper (and the service role)
do $$ declare f text[]; begin
  foreach f slice 1 in array array[['whatsapp_authorize','uuid, text'],['otp_send_authorize','uuid, text'],
                                   ['payment_link_begin','uuid, integer'],['create_payment','uuid']] loop
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1], f[2]);
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0097', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0097', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1], f[2]);
  end loop;
end $$;
grant execute on function public.whatsapp_authorize(uuid, text) to authenticated;
grant execute on function public.create_payment(uuid) to anon, authenticated;

-- outbox rows for a demo event are kept as 'skipped' - the senders never claim them
create or replace function public._a97_tg_outbox_demo_skip()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.quote_id is not null and public._is_demo_quote(new.quote_id) then new.status := 'skipped'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['comms_outbox','pkg_outbox'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zz_a97_outbox_demo_skip') then
      execute format('create trigger zz_a97_outbox_demo_skip before insert or update of status on public.%I for each row execute function public._a97_tg_outbox_demo_skip()', t);
    end if;
  end loop;
end $$;

-- ---- 5) status ------------------------------------------------------------------------------
create or replace function public.my_demo_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_mode text; v_rows int;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select o.trial_mode into v_mode from public.organizations o where o.id = v_org;
  select (select count(*) from public.quotes where org_id = v_org and is_demo)
       + (select count(*) from public.leads where org_id = v_org and is_demo)
       + (select count(*) from public.crew_members where org_id = v_org and is_demo)
       + (select count(*) from public.vendors where org_id = v_org and is_demo)
       + (select count(*) from public.inventory_items where org_id = v_org and is_demo)
       + (select count(*) from public.venues where org_id = v_org and is_demo and active)
       + (select count(*) from public.menu_templates where org_id = v_org and is_demo)
       + (select count(*) from public.layouts where org_id = v_org and is_demo)
    into v_rows;
  return jsonb_build_object('trial_mode', v_mode, 'demo_rows', v_rows, 'has_demo', v_rows > 0,
    'is_admin', coalesce(public.is_admin(), false));
end $$;

create or replace function public.set_trial_mode(p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('demo','own') then raise exception 'choose demo or own' using errcode = '22023'; end if;
  update public.organizations set trial_mode = p_mode where id = v_org;
  return public.my_demo_status();
end $$;

-- ---- 6) seed (fill-only, idempotent) -----------------------------------------------------------
create or replace function public._demo_seed(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d date := current_date;
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  v_total numeric;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  -- fill-only: a studio that already has its demo events is left exactly as it is
  if exists (select 1 from public.quotes where org_id = p_org and is_demo) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  -- venues (re-use deactivated demo venues from an earlier clear instead of piling up)
  if exists (select 1 from public.venues where org_id = p_org and is_demo) then
    update public.venues set active = true where org_id = p_org and is_demo and not active;
  else
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                              event_types, restrictions, cost_min, cost_max, cost_basis, parking_spaces, rooms, power_backup_kw,
                              green_rooms, washrooms, address, city, contact_name, notes, is_demo)
    values
      (p_org, E'Demo \u00b7 Sitara Convention Hall', 'banquet_hall', 'ac', 'indoor', 600, 900, 60, 30, 'm',
       array['wedding','reception','engagement','corporate'], array['sound_curfew','no_fireworks'], 250000, 400000, 'per_day',
       150, 4, 250, 2, 12, E'Demo \u00b7 Plot 12, Hitech City Road, Madhapur', 'Hyderabad', E'Demo \u00b7 Venue manager',
       E'Demo venue \u2014 sample data. Sound off by 10:30 pm.', true),
      (p_org, E'Demo \u00b7 Banjara Lawns', 'lawn', 'non_ac', 'outdoor', 1000, 1500, 90, 50, 'm',
       array['wedding','reception','birthday','festival'], array['generator_required'], 180000, 300000, 'per_day',
       300, 2, 0, 1, 8, E'Demo \u00b7 Road No. 10, Jubilee Hills', 'Hyderabad', E'Demo \u00b7 Lawn manager',
       E'Demo venue \u2014 sample data. Generator needed after 8 pm.', true);
  end if;

  -- dishes + menu packages
  -- demo masters kept (inactive) by an earlier clear because a real event used them come
  -- back on; every insert below skips a name the studio already has (fill-only)
  update public.dish_catalog set active = true where org_id = p_org and is_demo and not active;
  update public.menu_templates set active = true where org_id = p_org and is_demo and not active;
  update public.inventory_items set active = true where org_id = p_org and is_demo and not active;
  update public.crew_members set active = true where org_id = p_org and is_demo and not active;
  update public.vendors set active = true where org_id = p_org and is_demo and not active;

  -- dishes + menu packages
  insert into public.dish_catalog(org_id, category, name, kind, is_demo) values
    (p_org, 'Starters', E'Demo \u00b7 Paneer Tikka', 'veg', true),
    (p_org, 'Starters', E'Demo \u00b7 Apollo Fish', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Hyderabadi Chicken Dum Biryani', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Veg Dum Biryani', 'veg', true),
    (p_org, 'Main course', E'Demo \u00b7 Bagara Baingan', 'veg', true),
    (p_org, 'Main course', E'Demo \u00b7 Mutton Haleem', 'nonveg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Double Ka Meetha', 'veg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Qubani Ka Meetha', 'veg', true)
  on conflict do nothing;
  -- packages: one per tier + diet per studio - only fill a slot the studio hasn't used
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  select x.* from (values
    (m1, p_org, 'gold', 'veg', E'Demo \u00b7 Gold Veg Thali', 950::numeric,
     E'[{"n":"Demo \u00b7 Paneer Tikka","c":"Starters","k":"veg"},{"n":"Demo \u00b7 Veg Dum Biryani","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Bagara Baingan","c":"Main course","k":"veg"},{"n":"Demo \u00b7 Double Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 901, E'Demo package \u2014 sample data.', 100, 1500, true),
    (m2, p_org, 'premium', 'nonveg', E'Demo \u00b7 Premium Nizami Feast', 1450::numeric,
     E'[{"n":"Demo \u00b7 Apollo Fish","c":"Starters","k":"nonveg"},{"n":"Demo \u00b7 Hyderabadi Chicken Dum Biryani","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Mutton Haleem","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Qubani Ka Meetha","c":"Desserts","k":"veg"}]'::jsonb,
     true, 902, E'Demo package \u2014 sample data.', 150, 2000, true)
  ) as x(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  where not exists (select 1 from public.menu_templates t where t.org_id = p_org and t.tier = x.tier and t.diet = x.diet);

  -- inventory
  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Chiavari chairs (gold)', 'Furniture', 600, 'pcs', 'A', 45, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Round tables (6 ft)', 'Furniture', 80, 'pcs', 'A', 300, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 LED par lights', 'Lighting', 48, 'pcs', 'B', 600, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Stage platforms (8x4 ft)', 'Staging', 24, 'pcs', 'A', 1200, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Chafing dishes', 'Catering', 40, 'pcs', 'B', 250, E'Demo item \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Floral mandap set', 'Decor', 2, 'sets', 'A', 35000, E'Demo item \u2014 sample data.', true, true)
  on conflict do nothing;

  -- staff + vendors (numbers are sample numbers; WhatsApp refuses every demo number)
  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select * from (values
    (p_org, E'Demo \u00b7 Ravi Kumar', '+91 00000 00101', 'Operations', 'Event manager', 'full_time', 3500, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Lakshmi Prasanna', '+91 00000 00102', 'Decor', 'Decor lead', 'full_time', 3000, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Imran Shaikh', '+91 00000 00103', 'Logistics', 'Logistics supervisor', 'part_time', 2200, E'Demo staff \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Sneha Reddy', '+91 00000 00104', 'Hospitality', 'Guest coordinator', 'on_call', 1800::numeric, E'Demo staff \u2014 sample data.', true, true)
  ) as x(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.name);
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Gulmohar Florists', 'Florist', 'vendor', '+91 00000 00201', 'demo.florist@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Deccan Sound & Lights', 'Sound & lights', 'rental', '+91 00000 00202', 'demo.sound@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Charminar Clicks', 'Photography', 'freelancer', '+91 00000 00203', 'demo.photo@example.com', E'Demo vendor \u2014 sample data.', true, true)
  on conflict do nothing;

  -- leads first (the quote->lead sync then matches THESE demo leads by their demo e-mail,
  -- never one of the studio's real leads)
  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo) values
    (p_org, E'Demo \u00b7 Ananya Reddy', '+91 00000 00301', 'demo.ananya@example.com', 'Instagram', 'Wedding', d + 45, 1500000, 500, E'Demo lead \u2014 sample data.', 'won', true),
    (p_org, E'Demo \u00b7 Rohit Sharma', '+91 00000 00302', 'demo.rohit@example.com', 'Referral', 'Engagement', d + 30, 600000, 200, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 TechNova HR team', '+91 00000 00303', 'demo.technova@example.com', 'Website', 'Corporate', d + 60, 800000, 350, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 Priya Varma', '+91 00000 00304', 'demo.priya@example.com', 'Walk-in', 'Birthday', d + 20, 250000, 120, E'Demo lead \u2014 sample data.', 'discovery', true),
    (p_org, E'Demo \u00b7 Karthik Rao', '+91 00000 00305', 'demo.karthik@example.com', 'Google', 'Reception', d + 90, 900000, 400, E'Demo lead \u2014 sample data. Just enquired.', 'new', true),
    (p_org, E'Demo \u00b7 Fatima Begum', '+91 00000 00306', 'demo.fatima@example.com', 'Instagram', 'Wedding', d + 75, 1200000, 450, E'Demo lead \u2014 sample data. Went with another planner.', 'lost', true);

  -- events in different stages
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, is_demo) values
    (q1, p_org, 'DEMO-101', E'Demo \u00b7 Ananya & Vikram Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 45, '19:00',
     E'{"name":"Demo \u00b7 Ananya Reddy","phone":"+91 00000 00301","email":"demo.ananya@example.com","city":"Hyderabad"}',
     '{"guests":500,"subtotal":1250000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', now(), true),
    (q2, p_org, 'DEMO-102', E'Demo \u00b7 Rohit & Meera Engagement', 'Engagement', 'quote', 'none', 'proposal', d + 30, '18:30',
     E'{"name":"Demo \u00b7 Rohit Sharma","phone":"+91 00000 00302","email":"demo.rohit@example.com","city":"Hyderabad"}',
     '{"guests":200,"subtotal":520000,"discount":20000,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q3, p_org, 'DEMO-103', E'Demo \u00b7 TechNova Annual Day', 'Corporate', 'quote', 'none', 'quote', d + 60, '17:00',
     E'{"name":"Demo \u00b7 TechNova HR team","phone":"+91 00000 00303","email":"demo.technova@example.com","city":"Hyderabad"}',
     '{"guests":350,"subtotal":720000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true),
    (q4, p_org, 'DEMO-104', E'Demo \u00b7 Aarav''s 1st Birthday', 'Birthday', 'quote', 'none', 'discovery', d + 20, '12:30',
     E'{"name":"Demo \u00b7 Priya Varma","phone":"+91 00000 00304","email":"demo.priya@example.com","city":"Hyderabad"}',
     '{"guests":120,"subtotal":210000,"discount":0,"gstPct":18,"currency":"INR","taxCountry":"IN"}', null, true);
  -- any lead the quote->lead sync created or linked for a demo event is demo too
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2, q3, q4)
     and name like E'Demo \u00b7 %';

  -- the confirmed wedding: advance paid, two instalments to go (the "invoices")
  select (pricing ->> 'total')::numeric into v_total from public.quotes where id = q1;
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq, is_demo) values
    (q1, p_org, E'Demo \u00b7 Advance (30%)', d - 5, round(v_total * 0.3), 'paid', now() - interval '5 days', E'Demo \u2014 sample data.', 1, true),
    (q1, p_org, E'Demo \u00b7 Second instalment (40%)', d + 15, round(v_total * 0.4), 'invoiced', null, E'Demo \u2014 sample data.', 2, true),
    (q1, p_org, E'Demo \u00b7 Balance (30%)', d + 44, v_total - round(v_total * 0.3) - round(v_total * 0.4), 'due', null, E'Demo \u2014 sample data.', 3, true);
  insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note, is_demo)
    values (q1, p_org, 'upi', round(v_total * 0.3), 'INR', 'paid', true, now() - interval '5 days', 'upi', 'DEMO-R-0001',
            E'Demo payment \u2014 sample data, no money moved.', true);

  -- checklist for the wedding
  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq, is_demo) values
    (q1, p_org, 'logistics', E'Demo \u00b7 Confirm hall booking with Sitara', 'Advance receipt filed.', E'Demo \u00b7 Ravi Kumar', d - 3, 'done', 1, true),
    (q1, p_org, 'logistics', E'Demo \u00b7 Book generator backup (250 kVA)', null, E'Demo \u00b7 Imran Shaikh', d + 30, 'open', 2, true),
    (q1, p_org, 'compliance', E'Demo \u00b7 Police & fire NOC', 'Apply 3 weeks before.', E'Demo \u00b7 Ravi Kumar', d + 20, 'open', 3, true),
    (q1, p_org, 'guests', E'Demo \u00b7 Share guest list template with family', null, E'Demo \u00b7 Sneha Reddy', d + 10, 'open', 4, true),
    (q1, p_org, 'comms', E'Demo \u00b7 Send final menu to client', null, E'Demo \u00b7 Lakshmi Prasanna', d + 25, 'open', 5, true),
    (q1, p_org, 'teardown', E'Demo \u00b7 Return rental lights to Deccan Sound', null, E'Demo \u00b7 Imran Shaikh', d + 46, 'open', 6, true);

  -- a finished floor layout for the wedding (opens in the 2D / 3D builder)
  insert into public.layouts(name, data, org_id, is_demo) values
    (E'Demo \u00b7 Ananya & Vikram Wedding \u2014 Sitara Hall', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('id','demo-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label',E'Demo \u00b7 Main Stage','properties','{}'::jsonb),
        jsonb_build_object('id','demo-mandap','type','mandap','category','decor','x',92,'y',26,'width',16,'height',16,'rotation',0,'label',E'Demo \u00b7 Mandap','properties','{}'::jsonb),
        jsonb_build_object('id','demo-dance','type','dancefloor','category','structure','x',88,'y',48,'width',24,'height',24,'rotation',0,'label',E'Demo \u00b7 Dance Floor','properties','{}'::jsonb),
        jsonb_build_object('id','demo-t1','type','table','category','seating','x',30,'y',40,'width',6,'height',6,'rotation',0,'label','Table 1','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t2','type','table','category','seating','x',44,'y',40,'width',6,'height',6,'rotation',0,'label','Table 2','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t3','type','table','category','seating','x',58,'y',40,'width',6,'height',6,'rotation',0,'label','Table 3','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t4','type','table','category','seating','x',30,'y',56,'width',6,'height',6,'rotation',0,'label','Table 4','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t5','type','table','category','seating','x',44,'y',56,'width',6,'height',6,'rotation',0,'label','Table 5','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t6','type','table','category','seating','x',58,'y',56,'width',6,'height',6,'rotation',0,'label','Table 6','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t7','type','table','category','seating','x',136,'y',40,'width',6,'height',6,'rotation',0,'label','Table 7','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t8','type','table','category','seating','x',150,'y',40,'width',6,'height',6,'rotation',0,'label','Table 8','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t9','type','table','category','seating','x',164,'y',40,'width',6,'height',6,'rotation',0,'label','Table 9','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t10','type','table','category','seating','x',136,'y',56,'width',6,'height',6,'rotation',0,'label','Table 10','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t11','type','table','category','seating','x',150,'y',56,'width',6,'height',6,'rotation',0,'label','Table 11','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-t12','type','table','category','seating','x',164,'y',56,'width',6,'height',6,'rotation',0,'label','Table 12','properties',jsonb_build_object('seats',8)),
        jsonb_build_object('id','demo-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Non-veg buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-photo','type','photobooth','category','av','x',20,'y',10,'width',8,'height',8,'rotation',0,'label',E'Demo \u00b7 Photo Booth','properties','{}'::jsonb),
        jsonb_build_object('id','demo-carpet','type','redcarpet','category','structure','x',97,'y',100,'width',6,'height',30,'rotation',0,'label',E'Demo \u00b7 Aisle','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit1','type','exit','category','safety','x',0,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit2','type','exit','category','safety','x',188,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb)),
      'grid', jsonb_build_object('snap', true, 'show', true, 'unit', 'ft', 'sizeFt', 2),
      'margins', jsonb_build_object('left', 0, 'right', 0, 'top', 0, 'bottom', 0),
      'venue', jsonb_build_object('capacity', 600),
      'scale', jsonb_build_object('pxPerFt', 12, 'worldFt', jsonb_build_object('w', 200, 'h', 140)),
      'demo', true), p_org, true);

  update public.organizations set trial_mode = 'demo' where id = p_org;
  return jsonb_build_object('seeded', true, 'quotes', 4, 'leads', 6, 'staff', 4, 'vendors', 3, 'inventory', 6,
                            'venues', 2, 'packages', 2, 'dishes', 8, 'layouts', 1);
end $$;
revoke all on function public._demo_seed(uuid) from public, anon, authenticated;

-- ---- 7) clear (ONLY is_demo rows of ONE studio) -----------------------------------------------
create or replace function public._demo_clear(p_org uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_q uuid[]; n_q int := 0; n_l int := 0; n_c int := 0; n_v int := 0; n_i int := 0; n_d int := 0; n_m int := 0;
  n_lay int := 0; n_ven int := 0; n_kept int := 0; k int;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  select coalesce(array_agg(id), '{}') into v_q from public.quotes where org_id = p_org and is_demo;

  -- demo events: their own child rows go with them (they are part of the demo event).
  -- Money rows first (as the definer) so the 0029 delete guard sees no payments left.
  delete from public.quote_payments where org_id = p_org and quote_id = any(v_q);
  delete from public.payment_milestones where org_id = p_org and quote_id = any(v_q);
  delete from public.event_refunds where quote_id = any(v_q);
  delete from public.quote_consents where quote_id = any(v_q);
  -- a REAL lead linked to a demo event keeps its row; only the link is released
  update public.leads set quote_id = null where org_id = p_org and not is_demo and quote_id = any(v_q);
  delete from public.quotes where org_id = p_org and is_demo and id = any(v_q);
  get diagnostics n_q = row_count;
  delete from public.leads where org_id = p_org and is_demo;
  get diagnostics n_l = row_count;
  delete from public.layouts where org_id = p_org and is_demo;
  get diagnostics n_lay = row_count;

  -- demo master rows: delete only when NO remaining (real) row points at them; otherwise
  -- keep + deactivate so nothing real is cascaded away or loses its link
  delete from public.crew_members c where c.org_id = p_org and c.is_demo
     and not exists (select 1 from public.event_tasks t where t.crew_id = c.id)
     and not exists (select 1 from public.inventory_checkouts x where x.issued_to_id = c.id);
  get diagnostics n_c = row_count;
  update public.crew_members set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.vendors v where v.org_id = p_org and v.is_demo
     and not exists (select 1 from public.event_resources r where r.vendor_id = v.id)
     and not exists (select 1 from public.event_tasks t where t.vendor_id = v.id);
  get diagnostics n_v = row_count;
  update public.vendors set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.inventory_items i where i.org_id = p_org and i.is_demo
     and not exists (select 1 from public.inventory_reservations r where r.item_id = i.id)
     and not exists (select 1 from public.inventory_checkouts x where x.item_id = i.id)
     and not exists (select 1 from public.inv_shortage_alerts a where a.item_id = i.id)
     and not exists (select 1 from public.event_resource_needs e where e.item_id = i.id)
     and not exists (select 1 from public.event_stock_requests s where s.item_id = i.id);
  get diagnostics n_i = row_count;
  update public.inventory_items set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.menu_templates m where m.org_id = p_org and m.is_demo
     and not exists (select 1 from public.package_selections s where s.package_id = m.id);
  get diagnostics n_m = row_count;
  update public.menu_templates set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  delete from public.dish_catalog x where x.org_id = p_org and x.is_demo
     and not exists (select 1 from public.event_menu_items e where e.dish_id = x.id);
  get diagnostics n_d = row_count;
  update public.dish_catalog set active = false where org_id = p_org and is_demo and active;
  get diagnostics k = row_count; n_kept := n_kept + k;

  -- venues are never deleted (0085): demo venues are switched off
  update public.venues set active = false where org_id = p_org and is_demo and active;
  get diagnostics n_ven = row_count;

  return jsonb_build_object('cleared', true, 'quotes', n_q, 'leads', n_l, 'staff', n_c, 'vendors', n_v, 'inventory', n_i,
    'packages', n_m, 'dishes', n_d, 'layouts', n_lay, 'venues_deactivated', n_ven, 'kept_in_use', n_kept);
end $$;
revoke all on function public._demo_clear(uuid) from public, anon, authenticated;

-- ---- 8) studio-admin entry points ----------------------------------------------------------------
create or replace function public.seed_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._demo_seed(v_org);
end $$;

create or replace function public.clear_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); r jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  r := public._demo_clear(v_org);
  update public.organizations set trial_mode = 'own' where id = v_org;
  return r;
end $$;

create or replace function public.reset_demo_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); c jsonb; s jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._demo_clear(v_org);
  s := public._demo_seed(v_org);
  return jsonb_build_object('cleared', c, 'seeded', s);
end $$;

-- ---- 9) grants -------------------------------------------------------------------------------------
revoke all on function public.my_demo_status() from public, anon;
revoke all on function public.set_trial_mode(text) from public, anon;
revoke all on function public.seed_demo_data() from public, anon;
revoke all on function public.clear_demo_data() from public, anon;
revoke all on function public.reset_demo_data() from public, anon;
grant execute on function public.my_demo_status() to authenticated, service_role;
grant execute on function public.set_trial_mode(text) to authenticated, service_role;
grant execute on function public.seed_demo_data() to authenticated, service_role;
grant execute on function public.clear_demo_data() to authenticated, service_role;
grant execute on function public.reset_demo_data() to authenticated, service_role;
revoke all on function public._a97_tg_outbox_demo_skip() from public, anon, authenticated;
revoke all on function public._a97_tg_demo_flag_guard() from public, anon, authenticated;

-- =================================================================================================
-- 0098_public_paid_status.sql
-- =================================================================================================
-- 0098_public_paid_status.sql - CANONICAL forward-only. Client approval link: paid vs total.
--
-- In plain words:
--   The client's approval page said "Payment received - your event is confirmed" as soon as
--   ANY payment was recorded (approval_status = 'paid'), even when only a Rs50,000 advance
--   was in against a Rs3,06,800 quote. This adds ONE read-only function the approval page
--   calls with the same link token: how much is paid (summed from the quote_payments
--   LEDGER - the same source the settlement page uses), the latest receipt number, the
--   quote total, the event date and the studio's "balance due N days before" term.
--   The page then says "Advance of Rs50,000 received ... Balance Rs2,56,800 due by ..."
--   and only "Paid in full" when paid >= total.
--
-- Security: the link is checked by calling public_get_quote first (same expiry, shelving
-- and auto-expire rules - an invalid link raises exactly as before). Returns figures only:
-- no names, phones, payment references or links.
--
-- Additive + idempotent: one new function + grant. NO table, NO column, NO row changed.
-- Needs 0042 (public_get_quote wrapper), 0010 (quote_payments.receipt_no).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_quote(uuid)') is null then raise exception '0098: public_get_quote missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quote_payments' and column_name = 'receipt_no') then
    raise exception '0098: apply 0010 first (quote_payments.receipt_no missing)';
  end if;
end $$;

create or replace function public.public_quote_paid_status(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare q public.quotes; v_paid numeric; v_n int; v_last text; v_last_amt numeric; v_days text; v_total numeric;
begin
  perform public.public_get_quote(p_token);   -- raises on an invalid / expired / shelved link
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select coalesce(sum(amount), 0), count(*) into v_paid, v_n from public.quote_payments where quote_id = q.id and status = 'paid';
  select receipt_no, amount into v_last, v_last_amt from public.quote_payments
    where quote_id = q.id and status = 'paid' order by coalesce(paid_at, created_at) desc limit 1;
  select value->>'balanceDueDays' into v_days from public.app_config where key = 'pricing' and org_id = q.org_id;
  v_total := case when coalesce(q.pricing->>'total', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (q.pricing->>'total')::numeric else null end;
  return jsonb_build_object('total', v_total, 'paid', v_paid, 'payments', v_n,
    'last_receipt', v_last, 'last_amount', v_last_amt, 'event_date', q.event_date,
    'balance_due_days', case when coalesce(v_days, '') ~ '^[0-9]{1,3}$' then v_days::int else null end);
end $$;

revoke all on function public.public_quote_paid_status(uuid) from public;
grant execute on function public.public_quote_paid_status(uuid) to anon, authenticated;

-- =================================================================================================
-- 0099_pkg_payment_balance.sql
-- =================================================================================================
-- 0099_pkg_payment_balance.sql - CANONICAL forward-only. Staff "payment received" WhatsApp carries the balance.
--
-- In plain words:
--   When a client pays on a package-flow event, the staff WhatsApp said only "a payment of
--   Rs50,000 was received". The sender (pkg-client-notify templates.ts) already appends
--   "Balance due: Rs2,56,800." or "Paid in full." when the payload has a `balance` - but the
--   0069 trigger never sent one (India audit #15). This re-creates that ONE trigger function so
--   the payload also carries `balance` (quote total minus the quote_payments LEDGER, the same
--   source settlement + 0098 use) and the quote's `currency`.
--
--   Balance is added only for ledger rows (quote_payments) and only when the quote total is a
--   number; for a milestone-only payment the text stays exactly as before.
--
-- Additive + idempotent: one function body replaced (same signature, same triggers, same
-- never-blocks-a-payment exception guard). NO table, NO column, NO row changed.
-- Needs 0069 (_pkg_notify / _pkg_tg_payment), 0089 (quotes.currency).
-- ============================================================================

do $$ begin
  if to_regprocedure('public._pkg_notify(uuid,text,jsonb,text)') is null then raise exception '0099: apply 0069 first (_pkg_notify missing)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'currency') then
    raise exception '0099: apply 0089 first (quotes.currency missing)';
  end if;
end $$;

create or replace function public._pkg_tg_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_detail jsonb; v_total numeric; v_paid numeric; v_cur text;
begin
  begin
    if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid')
       and exists (select 1 from public.package_selections s where s.quote_id = new.quote_id and s.status = 'accepted') then
      v_detail := jsonb_build_object('payment_id', new.id, 'amount', new.amount, 'source', tg_table_name,
                                     'path', 'settlement.html?quote=' || new.quote_id::text || '#payments');
      select case when coalesce(q.pricing->>'total', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (q.pricing->>'total')::numeric end,
             nullif(btrim(coalesce(q.currency, '')), '')
        into v_total, v_cur from public.quotes q where q.id = new.quote_id;
      if v_cur is not null then v_detail := v_detail || jsonb_build_object('currency', v_cur); end if;
      if tg_table_name = 'quote_payments' and v_total is not null then
        select coalesce(sum(p.amount), 0) into v_paid from public.quote_payments p where p.quote_id = new.quote_id and p.status = 'paid';
        v_detail := v_detail || jsonb_build_object('balance', greatest(v_total - v_paid, 0));
      end if;
      perform public._pkg_notify(new.quote_id, 'pkg_payment', v_detail, 'pay:' || tg_table_name || ':' || new.id::text);
    end if;
  exception when others then raise warning 'pkg-0099: payment notice skipped (%)', sqlstate;
  end;
  return null;
end $$;
revoke all on function public._pkg_tg_payment() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._pkg_tg_payment() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._pkg_tg_payment() from authenticated; end if;
end $$;

commit;

select item, ok from (values
  ('0095 01 photo tables exist with RLS on', (select count(*) from pg_class where oid in (to_regclass('public.photo_render_settings'), to_regclass('public.photo_render_usage'), to_regclass('public.photo_renders')) and relrowsecurity) = 3),
  ('0095 02 no table grants to anon / authenticated', not has_table_privilege('anon', 'public.photo_renders', 'select') and not has_table_privilege('authenticated', 'public.photo_renders', 'select') and not has_table_privilege('authenticated', 'public.photo_render_usage', 'select')),
  ('0095 03 render RPCs for signed-in staff only', has_function_privilege('authenticated', 'public.photo_render_begin(uuid,integer,text,text,text,numeric)', 'execute') and has_function_privilege('authenticated', 'public.photo_render_job(uuid)', 'execute') and not has_function_privilege('anon', 'public.photo_render_job(uuid)', 'execute') and not has_function_privilege('anon', 'public.photo_render_begin(uuid,integer,text,text,text,numeric)', 'execute')),
  ('0095 04 booklet picture kind photo allowed', (select pg_get_constraintdef(oid) like '%photo%' from pg_constraint where conname = 'client_booklet_images_kind_ck')),
  ('0095 05 booklet readers still open to the client link (anon)', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute') and has_function_privilege('anon', 'public.public_get_booklet_image(uuid,text,text)', 'execute') and not has_function_privilege('anon', 'public.public_get_booklet__pre0083(uuid)', 'execute')),
  ('0096 01 studio_layout_templates exists with RLS on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.studio_layout_templates')), false)),
  ('0096 02 template RPCs for signed-in staff, not anon', has_function_privilege('authenticated', 'public.studio_template_save(uuid,jsonb)', 'execute') and not has_function_privilege('anon', 'public.studio_template_save(uuid,jsonb)', 'execute')),
  ('0097 01 organizations.trial_mode + is_demo flags', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'trial_mode') and (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'is_demo' and table_name in ('quotes', 'leads', 'crew_members', 'vendors')) = 4),
  ('0097 02 message / payment gates wrap the originals', to_regprocedure('public.whatsapp_authorize__pre0097(uuid,text)') is not null and to_regprocedure('public.otp_send_authorize__pre0097(uuid,text)') is not null and to_regprocedure('public.create_payment__pre0097(uuid)') is not null and to_regprocedure('public.payment_link_begin__pre0097(uuid,integer)') is not null),
  ('0097 03 +91 00000 numbers are always refused', position('00000%' in (select prosrc from pg_proc where oid = 'public._is_demo_phone(uuid,text)'::regprocedure)) > 0),
  ('0097 04 demo RPCs for signed-in staff, not anon', has_function_privilege('authenticated', 'public.seed_demo_data()', 'execute') and not has_function_privilege('anon', 'public.seed_demo_data()', 'execute') and not has_function_privilege('anon', 'public.clear_demo_data()', 'execute')),
  ('0098 01 public_quote_paid_status for the approval link', has_function_privilege('anon', 'public.public_quote_paid_status(uuid)', 'execute')),
  ('0099 01 pkg_payment notice carries balance', position('balance' in (select prosrc from pg_proc where oid = 'public._pkg_tg_payment()'::regprocedure)) > 0),
  ('0095-0099 all new functions are security definer with empty search_path', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('photo_render_begin', 'photo_render_job', 'photo_render_use_in_booklet', 'public_get_booklet_image', 'studio_template_save', 'seed_demo_data', '_is_demo_phone', 'public_quote_paid_status', '_pkg_tg_payment')
      and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])))
) v(item, ok)
order by item;
