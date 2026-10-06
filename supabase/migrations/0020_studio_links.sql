-- ============================================================================
-- 0020_studio_links.sql — CANONICAL forward-only. Branded, secure client links:
--   https://www.helm.events/<studio>/invite/<event-slug>
--   https://www.helm.events/<studio>/quote/<token>      (client approval)
--   https://www.helm.events/<studio>/proposal/<token>
--   https://www.helm.events/<studio>/portal/<token>
--   https://www.helm.events/<studio>/work/<token>       (crew checklist)
-- Security model:
--   * The <token>/<event-slug> stays the ONLY secret. <studio> is a public label.
--   * Anti-phishing: public pages ask public_link_studio() whether <studio> really
--     owns that link; on a mismatch they show "not found", so nobody can wrap their
--     own token in another studio's name (helm.events/trusted-studio/quote/<mine>).
--   * Renaming keeps every old name working for that studio (org_slug_history) and
--     a retired name can never be claimed by a different studio.
--   * Only admins / controls editors change the name; format + reserved words are
--     enforced by a trigger, so a direct table UPDATE can't bypass the rules.
--   * Old links (/i/<slug>, /approve.html?token=…) keep working.
-- Also aligns canonical with prod SEC-05 F8: studio settings writable by admin /
-- controls editors only (was: any member of the studio).
-- Additive + idempotent. Only writes the NEW public_slug column (backfill).
-- ============================================================================

-- ---- column + history ------------------------------------------------------
alter table public.organizations add column if not exists public_slug text;
create unique index if not exists organizations_public_slug_uidx on public.organizations (public_slug);

create table if not exists public.org_slug_history (
  slug       text primary key,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  retired_at timestamptz not null default now()
);
alter table public.org_slug_history enable row level security;      -- no policies: definer functions only
revoke all on public.org_slug_history from anon, authenticated;

-- ---- rules -----------------------------------------------------------------
create or replace function public.studio_slug_reserved(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p = any (array[
    -- app pages (public/*.html) + routes
    '404','about','approve','audit','budget','builder','calendar','chat','closure','command','control',
    'crm','dashboard','design','discovery','event','flow','index','insights','inventory','invite-studio',
    'invite','issues','leads','login','logistics','media','nurture','ops','plan','portal','privacy',
    'proposal-view','proposal','quotes','ready','reports','resources','runsheet','services','settlement',
    'sim-pay','staff','teardown','templates','terms','vendors','work','quote','i',
    -- system / brand / infrastructure words
    'api','docs','vendor','assets','static','public','admin','administrator','app','www','mail','email',
    'help','support','security','well-known','logout','signup','register','settings','account','billing',
    'helm','helm-events','helmevents','official','status','blog','pricing','null','undefined','root',
    'system','test','dev','staging','prod','production','cdn','img','images','files','auth','oauth',
    'callback','robots','sitemap','favicon','studio','studios','new','edit','owner'
  ]);
$$;

create or replace function public.studio_slug_valid(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and p ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
     and position('--' in p) = 0
     and not public.studio_slug_reserved(p);
$$;

create or replace function public.studio_slugify(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'), '-'), 36), ''), 'studio');
$$;

-- free for p_org? (not another studio's current OR retired name)
create or replace function public.studio_slug_free(p_slug text, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.organizations o where o.public_slug = p_slug and o.id <> p_org)
     and not exists (select 1 from public.org_slug_history h where h.slug = p_slug and h.org_id <> p_org);
$$;
revoke all on function public.studio_slug_free(text, uuid) from public;

-- first free name for a studio: base, base-2, base-3, …
create or replace function public.studio_slug_pick(p_name text, p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_base text := btrim(left(public.studio_slugify(p_name), 36), '-'); v_try text; n int := 1;
begin
  if length(v_base) < 3 then v_base := v_base || '-studio'; end if;
  if public.studio_slug_reserved(v_base) then v_base := v_base || '-events'; end if;
  v_try := v_base;
  while not (public.studio_slug_valid(v_try) and public.studio_slug_free(v_try, p_org)) loop
    n := n + 1; v_try := v_base || '-' || n;
    if n > 500 then return 'studio-' || left(replace(p_org::text, '-', ''), 12); end if;
  end loop;
  return v_try;
end $$;
revoke all on function public.studio_slug_pick(text, uuid) from public;

-- ---- enforcement trigger (covers the RPC AND any direct UPDATE) -------------
create or replace function public.organizations_public_slug_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.public_slug is null then new.public_slug := public.studio_slug_pick(new.name, new.id); end if;
  elsif new.public_slug is distinct from old.public_slug then
    if new.public_slug is null then raise exception 'studio link name cannot be removed' using errcode = '22023'; end if;
    -- signed-in callers must be admin / controls editors (migrations & service role bypass: auth.uid() null)
    if auth.uid() is not null and not (public.is_admin() or public.has_area('controls', 'edit')) then
      raise exception 'only an admin can change the studio link name' using errcode = '42501';
    end if;
    new.public_slug := lower(btrim(new.public_slug));
  end if;
  if not public.studio_slug_valid(new.public_slug) then
    raise exception 'studio link name must be 3-40 letters, numbers or dashes (and not a reserved word)' using errcode = '22023';
  end if;
  if not public.studio_slug_free(new.public_slug, new.id) then
    raise exception 'that studio link name is already taken' using errcode = '23505';
  end if;
  if tg_op = 'UPDATE' and old.public_slug is not null and new.public_slug is distinct from old.public_slug then
    insert into public.org_slug_history (slug, org_id) values (old.public_slug, old.id) on conflict (slug) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists organizations_public_slug_guard_biu on public.organizations;
create trigger organizations_public_slug_guard_biu before insert or update of public_slug on public.organizations
  for each row execute function public.organizations_public_slug_guard();

-- ---- backfill existing studios (new column only; nothing else touched) ------
do $$ declare r record; begin
  for r in select id, name from public.organizations where public_slug is null order by created_at, id loop
    update public.organizations set public_slug = public.studio_slug_pick(r.name, r.id) where id = r.id;
  end loop;
end $$;

-- ---- SEC-05 F8 (aligned with prod): settings writable by admin/controls only --
drop policy if exists "org self write" on public.organizations;
create policy "org self write" on public.organizations for update to authenticated
  using ( id = (select public.current_org_id())
          and (public.is_admin() or public.has_area('controls','edit')) )
  with check ( id = (select public.current_org_id())
               and (public.is_admin() or public.has_area('controls','edit')) );

-- ---- admin RPC: rename ------------------------------------------------------
create or replace function public.set_studio_link_name(p_slug text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_slug text := lower(btrim(coalesce(p_slug, '')));
begin
  if auth.uid() is null or v_org is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not (public.is_admin() or public.has_area('controls', 'edit')) then
    raise exception 'only an admin can change the studio link name' using errcode = '42501';
  end if;
  update public.organizations set public_slug = v_slug where id = v_org;   -- guard trigger validates + records history
  return v_slug;
end $$;
revoke all on function public.set_studio_link_name(text) from public, anon;
grant execute on function public.set_studio_link_name(text) to authenticated;

-- ---- PUBLIC resolver (anon): does <studio> own this link? -------------------
-- Returns the studio's CURRENT link name when p_studio is its current or a retired
-- name; NULL otherwise (unknown/unpublished link or a different studio).
create or replace function public.public_link_studio(p_kind text, p_ref text, p_studio text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_tok uuid; v_slug text := lower(btrim(coalesce(p_studio, '')));
begin
  if p_ref is null or length(p_ref) > 200 or v_slug = '' or length(v_slug) > 60 then return null; end if;
  if p_kind = 'invite' then
    select s.org_id into v_org from public.event_sites s where s.slug = p_ref and s.status = 'published';
  elsif p_kind in ('quote', 'portal', 'proposal', 'work') then
    if p_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    v_tok := p_ref::uuid;
    if p_kind in ('quote', 'portal') then
      select q.org_id into v_org from public.quotes q where q.approval_token = v_tok;
    elsif p_kind = 'proposal' then
      select q.org_id into v_org from public.event_proposal pr join public.quotes q on q.id = pr.quote_id
       where pr.share_token = v_tok and pr.published = true;
    else
      select w.org_id into v_org from public.work_tokens w where w.token = v_tok;
    end if;
  else
    return null;
  end if;
  if v_org is null then return null; end if;
  return (select o.public_slug from public.organizations o
           where o.id = v_org
             and (o.public_slug = v_slug
                  or exists (select 1 from public.org_slug_history h where h.org_id = v_org and h.slug = v_slug)));
end $$;
revoke all on function public.public_link_studio(text, text, text) from public;
grant execute on function public.public_link_studio(text, text, text) to anon, authenticated;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select count(*) filter (where public_slug is null) as missing, count(*) as studios from public.organizations;  -- missing = 0
-- select id, name, public_slug from public.organizations order by created_at;
