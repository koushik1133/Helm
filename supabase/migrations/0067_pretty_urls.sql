-- ============================================================================
-- 0067_pretty_urls.sql - CANONICAL forward-only. Human-readable, studio-scoped
-- app URLs:  https://www.helm.events/<studio>/events/<event-number>/floor-plan
--
-- In plain words:
--   * The studio part of the URL is the studio's EXISTING link name
--     (organizations.public_slug, 0020): unique, lowercase a-z 0-9 -, 3..40,
--     auto-set for new studios, backfilled, rename history kept, editable only by
--     a studio admin through set_studio_link_name(). Nothing new is stored.
--   * More words are now reserved (every app page / route name, e.g. hq,
--     booklet, client, events, settings) so a NEW name can never shadow a route.
--     Existing names are NOT changed.
--   * my_studio_route(slug): signed-in caller only. Says whether the slug is the
--     caller's OWN studio (current or retired name) and returns the current one.
--     It never says anything about another studio (not even whether it exists).
--   * resolve_event_ref(ref): event number (quotes.code) or id -> id, in the
--     caller's studio only, and only when the caller may view quotes.
--   * resolve_client_ref(ref): event number / id / "<name>-<8 hex of lead id>"
--     -> lead or event id, caller's studio only, has_area gated.
--   * public_booklet_studio(token, slug): the public booklet resolves ONLY by its
--     unguessable token; the slug is cosmetic and must belong to the token's
--     studio, else NULL (the page shows "invalid link").
--
-- Additive + idempotent: 4 new functions, 1 replaced pure function (reserved
-- word list, superset). NO table, column or row is created, deleted or changed.
-- ============================================================================

do $$ begin
  if to_regclass('public.organizations') is null then raise exception '0067: public.organizations is not installed'; end if;
  if to_regclass('public.org_slug_history') is null then raise exception '0067: 0020 studio links are not installed'; end if;
  if to_regclass('public.client_booklets') is null then raise exception '0067: 0065 client booklets are not installed'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0067: has_area() is not installed'; end if;
end $$;

-- ---- reserved words (superset of 0020) ----------------------------------------
create or replace function public.studio_slug_reserved(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p = any (array[
    -- app pages (public/*.html) + routes
    '404','about','approve','audit','booklet','budget','builder','calendar','chat','checkout','client',
    'clients','closure','command','control','crm','dashboard','design','discovery','event','events',
    'flow','hq','index','insights','inventory','invite-studio','invite','issues','leads','login',
    'logistics','manual','media','nurture','ops','plan','portal','privacy','profile-setup',
    'proposal-view','proposal','quotes','ready','refund-policy','reports','reset-password','resources',
    'runsheet','services','settlement','sim-pay','staff','teardown','templates','terms','vendors','work',
    'quote','i','tasks','floor-plan','trusted-types','telemetry','config','store-api',
    -- system / brand / infrastructure words
    'api','docs','vendor','assets','static','public','admin','administrator','app','www','mail','email',
    'help','support','security','well-known','logout','signup','register','settings','account','billing',
    'helm','helm-events','helmevents','official','status','blog','pricing','null','undefined','root',
    'system','test','dev','staging','prod','production','cdn','img','images','files','auth','oauth',
    'callback','robots','sitemap','favicon','studio','studios','new','edit','owner'
  ]);
$$;

-- ---- signed-in: is <slug> my own studio? ----------------------------------------
create or replace function public.my_studio_route(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_cur text; v_s text := lower(btrim(coalesce(p_slug, '')));
begin
  if auth.uid() is null or v_org is null then return jsonb_build_object('own', false, 'slug', null); end if;
  select o.public_slug into v_cur from public.organizations o where o.id = v_org;
  if length(v_s) between 1 and 60 and (v_s = v_cur
     or exists (select 1 from public.org_slug_history h where h.org_id = v_org and h.slug = v_s)) then
    return jsonb_build_object('own', true, 'slug', v_cur);
  end if;
  return jsonb_build_object('own', false, 'slug', v_cur);
end $$;

-- ---- event number / id -> id (caller org + quotes view) ------------------------
create or replace function public.resolve_event_ref(p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_r text := btrim(coalesce(p_ref, '')); v_id uuid; v_code text; n int;
begin
  if auth.uid() is null or v_org is null or v_r = '' or length(v_r) > 80 then return null; end if;
  if not public.has_area('quotes', 'view') then return null; end if;
  if v_r ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select q.id, q.code into v_id, v_code from public.quotes q
     where q.id = v_r::uuid and q.org_id = v_org;
  else
    select count(*) into n from public.quotes q where q.org_id = v_org and upper(q.code) = upper(v_r);
    if n <> 1 then
      select count(*) into n from public.quotes q where q.org_id = v_org and q.deleted_at is null and upper(q.code) = upper(v_r);
      if n <> 1 then return null; end if;
      select q.id, q.code into v_id, v_code from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and upper(q.code) = upper(v_r);
    else
      select q.id, q.code into v_id, v_code from public.quotes q where q.org_id = v_org and upper(q.code) = upper(v_r);
    end if;
  end if;
  if v_id is null then return null; end if;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;

-- ---- client ref -> lead / event id (caller org + has_area) ---------------------
create or replace function public.resolve_client_ref(p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_r text := lower(btrim(coalesce(p_ref, ''))); v_id uuid; v_name text; v_hex text; n int; e jsonb;
begin
  if auth.uid() is null or v_org is null or v_r = '' or length(v_r) > 120 then return null; end if;
  if v_r ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    if public.has_area('leads', 'view') then
      select l.id, l.name into v_id, v_name from public.leads l where l.id = v_r::uuid and l.org_id = v_org;
      if v_id is not null then return jsonb_build_object('id', v_id, 'kind', 'lead', 'name', v_name); end if;
    end if;
    e := public.resolve_event_ref(v_r);
    if e is not null then return jsonb_build_object('id', e->>'id', 'kind', 'event', 'code', e->>'code'); end if;
    return null;
  end if;
  v_hex := substring(v_r from '(?:^|-)([0-9a-f]{8})$');
  if v_hex is not null and public.has_area('leads', 'view') then
    select count(*) into n from public.leads l where l.org_id = v_org and left(l.id::text, 8) = v_hex;
    if n = 1 then
      select l.id, l.name into v_id, v_name from public.leads l where l.org_id = v_org and left(l.id::text, 8) = v_hex;
      return jsonb_build_object('id', v_id, 'kind', 'lead', 'name', v_name);
    end if;
  end if;
  e := public.resolve_event_ref(p_ref);
  if e is not null then return jsonb_build_object('id', e->>'id', 'kind', 'event', 'code', e->>'code'); end if;
  return null;
end $$;

-- ---- public booklet: slug must belong to the token's studio --------------------
create or replace function public.public_booklet_studio(p_token text, p_studio text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_s text := lower(btrim(coalesce(p_studio, '')));
begin
  if p_token is null or p_token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  if v_s = '' or length(v_s) > 60 then return null; end if;
  select b.org_id into v_org from public.client_booklets b where b.token = p_token::uuid;
  if v_org is null then return null; end if;
  return (select o.public_slug from public.organizations o
           where o.id = v_org
             and (o.public_slug = v_s
                  or exists (select 1 from public.org_slug_history h where h.org_id = v_org and h.slug = v_s)));
end $$;

-- ---- grants ---------------------------------------------------------------------
revoke all on function public.my_studio_route(text) from public;
revoke all on function public.resolve_event_ref(text) from public;
revoke all on function public.resolve_client_ref(text) from public;
revoke all on function public.public_booklet_studio(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.my_studio_route(text) from anon';
    execute 'revoke all on function public.resolve_event_ref(text) from anon';
    execute 'revoke all on function public.resolve_client_ref(text) from anon';
    execute 'grant execute on function public.public_booklet_studio(text, text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_studio_route(text) to authenticated';
    execute 'grant execute on function public.resolve_event_ref(text) to authenticated';
    execute 'grant execute on function public.resolve_client_ref(text) to authenticated';
    execute 'grant execute on function public.public_booklet_studio(text, text) to authenticated';
  end if;
end $$;
