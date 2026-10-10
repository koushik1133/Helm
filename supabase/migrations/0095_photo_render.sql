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
--       booklet pictures (0083, kind 3d / variant plain = "3D without labels"); <= 1.5 MB.
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
    values (v_org, r.quote_id, v_bk, '3d', 'plain', r.mime, r.bytes, r.data, auth.uid()) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'kind', '3d', 'variant', 'plain');
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
      'public.photo_render_settings_get()', 'public.photo_render_settings_set(boolean,integer,integer)'] loop
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
  end if;
end $$;
