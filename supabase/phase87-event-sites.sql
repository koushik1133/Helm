-- ============================================================================
-- phase87-event-sites.sql  —  Digital invitation websites for confirmed events
-- ---------------------------------------------------------------------------
-- Lets an event manager build a public "digital invitation" site for a
-- CONFIRMED event, pick one of the starter templates, fill event-type details,
-- and PUBLISH it at a shareable link (served by Helm at /i/<slug>).
--
-- SECURITY MODEL (this is the first PUBLIC surface in Helm, so read carefully):
--   • event_sites is fully org-scoped + RLS, exactly like every other table.
--   • The ONLY anonymous-accessible path is public_event_site(slug), a
--     SECURITY DEFINER read that returns ONLY the display fields of a
--     PUBLISHED site (template, type, title, the public `data` json). It never
--     returns org_id, quote_id, created_by, or anything from any other table,
--     and returns nothing for draft/unpublished sites.
--   • `data` holds ONLY what the manager typed for the public page. No CRM,
--     quote totals, client contact rows, or other PII are ever copied in here.
--
-- GUARDRAILS: additive + idempotent + non-destructive. No DROP/TRUNCATE.
-- Every mutation carries an explicit key AND org_id = current_org_id().
-- Definer RPCs re-apply the org filter via assert_quote_org()/current_org_id().
-- Safe to run more than once.
-- ============================================================================

-- (No pgcrypto needed — gen_random_uuid() is Postgres core; see slug logic below.)

-- ---------------------------------------------------------------------------
-- 1) Table
-- ---------------------------------------------------------------------------
create table if not exists public.event_sites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  event_type   text not null default 'general',
  template     text not null default 'soiree',
  slug         text not null,
  title        text,
  data         jsonb not null default '{}'::jsonb,
  status       text not null default 'draft',
  published_at timestamptz,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One invitation site per event (idempotent add).
create unique index if not exists event_sites_quote_uidx on public.event_sites(quote_id);
-- Public slug is globally unique (it is the public URL id).
create unique index if not exists event_sites_slug_uidx  on public.event_sites(slug);
create index if not exists event_sites_org_idx    on public.event_sites(org_id);
create index if not exists event_sites_status_idx on public.event_sites(org_id, status);

-- Value guards (idempotent named CHECKs). The 5 starter templates + event types.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'event_sites_type_chk') then
    alter table public.event_sites add constraint event_sites_type_chk
      check (event_type in ('wedding','birthday','corporate','engagement','general'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_sites_template_chk') then
    alter table public.event_sites add constraint event_sites_template_chk
      check (template in ('eternal','confetti','summit','promise','soiree'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_sites_status_chk') then
    alter table public.event_sites add constraint event_sites_status_chk
      check (status in ('draft','published','unpublished'));
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2) Write guard trigger — force org_id + prove the quote belongs to this org
--    (mirrors phase84 event_attendees_guard). Client can NEVER set org_id.
-- ---------------------------------------------------------------------------
create or replace function public.event_sites_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.org_id := current_org_id();
  if new.org_id is null then
    raise exception 'no organization in context';
  end if;
  perform assert_quote_org(new.quote_id);   -- rejects a quote_id from another tenant
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists event_sites_guard_biu on public.event_sites;
create trigger event_sites_guard_biu
  before insert or update on public.event_sites
  for each row execute function public.event_sites_guard();

-- ---------------------------------------------------------------------------
-- 3) RLS — canonical 4-policy CRUD, gated on the quotes area + own org.
-- ---------------------------------------------------------------------------
alter table public.event_sites enable row level security;

drop policy if exists event_sites_select on public.event_sites;
create policy event_sites_select on public.event_sites
  for select using ( has_area('quotes','view') and org_id = (select current_org_id()) );

drop policy if exists event_sites_insert on public.event_sites;
create policy event_sites_insert on public.event_sites
  for insert with check ( has_area('quotes','edit') and org_id = (select current_org_id()) );

drop policy if exists event_sites_update on public.event_sites;
create policy event_sites_update on public.event_sites
  for update using ( has_area('quotes','edit') and org_id = (select current_org_id()) )
             with check ( has_area('quotes','edit') and org_id = (select current_org_id()) );

drop policy if exists event_sites_delete on public.event_sites;
create policy event_sites_delete on public.event_sites
  for delete using ( has_area('quotes','edit') and org_id = (select current_org_id()) );

-- ---------------------------------------------------------------------------
-- 4) create_event_site(quote_id, event_type, template)
--    Admin/edit-gated, org-checked, generates a hard-to-guess public slug,
--    idempotent (returns the existing site for this event if one exists).
-- ---------------------------------------------------------------------------
create or replace function public.create_event_site(
  p_quote_id uuid,
  p_event_type text default 'general',
  p_template text default 'soiree'
)
returns public.event_sites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_row  public.event_sites;
  v_base text;
  v_slug text;
begin
  if v_org is null then raise exception 'no organization in context'; end if;
  if not has_area('quotes','edit') then raise exception 'not permitted'; end if;
  perform assert_quote_org(p_quote_id);           -- quote must be in caller's org

  -- Idempotent: one site per event.
  select * into v_row from public.event_sites where quote_id = p_quote_id and org_id = v_org;
  if found then return v_row; end if;

  if coalesce(p_event_type,'') not in ('wedding','birthday','corporate','engagement','general') then
    p_event_type := 'general';
  end if;
  if coalesce(p_template,'') not in ('eternal','confetti','summit','promise','soiree') then
    p_template := 'soiree';
  end if;

  -- Placeholder slug only (never the quote code — that would leak an internal number
  -- into the public URL). The friendly, NAME-based slug is generated at publish time
  -- by publish_event_site(). Neutral + random so nothing internal is exposed.
  v_slug := 'draft-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);

  insert into public.event_sites (quote_id, event_type, template, slug, created_by)
  values (p_quote_id, p_event_type, p_template, v_slug, auth.uid())
  returning * into v_row;

  return v_row;
end$$;

-- ---------------------------------------------------------------------------
-- 5) publish_event_site(id, publish) — stamps published_at server-side.
--    Org-scoped; never touches another tenant's row.
-- ---------------------------------------------------------------------------
create or replace function public.publish_event_site(p_id uuid, p_publish boolean default true)
returns public.event_sites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_row  public.event_sites;
  v_base text;
  v_slug text;
  v_try  int := 0;
begin
  if v_org is null then raise exception 'no organization in context'; end if;
  if not has_area('quotes','edit') then raise exception 'not permitted'; end if;

  select * into v_row from public.event_sites where id = p_id and org_id = v_org;
  if not found then raise exception 'invitation site not found'; end if;

  if not p_publish then
    update public.event_sites set status = 'unpublished', updated_at = now()
     where id = p_id and org_id = v_org returning * into v_row;
    return v_row;
  end if;

  -- Friendly, NAME-based public slug (e.g. "koushik-goud-shaganti-a1b2c3").
  -- Built from the invitation name/title — NEVER the quote code. Stays stable
  -- while the name is unchanged; regenerates if missing, name changed, or the old
  -- slug was a placeholder/quote-code (so existing sites get cleaned up on re-publish).
  v_base := lower(coalesce(nullif(trim(v_row.title), ''), v_row.data->>'names', 'invitation'));
  v_base := trim(both '-' from regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'));
  v_base := left(v_base, 40);
  if coalesce(v_base, '') = '' then v_base := 'invitation'; end if;

  if v_row.slug is null or v_row.slug not like v_base || '-%' then
    loop
      v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
      exit when not exists (select 1 from public.event_sites where slug = v_slug and id <> p_id);
      v_try := v_try + 1; exit when v_try > 6;
    end loop;
  else
    v_slug := v_row.slug;   -- already name-based and current — keep the link stable
  end if;

  update public.event_sites
     set slug         = v_slug,
         status       = 'published',
         published_at = coalesce(published_at, now()),
         updated_at   = now()
   where id = p_id and org_id = v_org                 -- explicit key AND own org
  returning * into v_row;

  return v_row;
end$$;

-- ---------------------------------------------------------------------------
-- 6) public_event_site(slug) — the ONLY anon-visible path.
--    Returns ONLY public display fields of a PUBLISHED site. No org_id,
--    quote_id, created_by, timestamps-of-record, or cross-table data.
-- ---------------------------------------------------------------------------
create or replace function public.public_event_site(p_slug text)
returns table (event_type text, template text, title text, data jsonb)
language sql
security definer
set search_path = public
stable
as $$
  select s.event_type, s.template, s.title, s.data
    from public.event_sites s
   where s.slug = p_slug
     and s.status = 'published'
   limit 1;
$$;

-- Only the public read is exposed to anonymous visitors.
grant execute on function public.public_event_site(text) to anon, authenticated;
revoke execute on function public.create_event_site(uuid, text, text) from anon;
revoke execute on function public.publish_event_site(uuid, boolean)   from anon;

-- ============================================================================
-- Verification (run manually, optional):
--   -- as an admin whose org owns quote Q:
--   select * from create_event_site('<Q>','wedding','eternal');
--   update event_sites set title='Ayla & Sam', data='{"names":"Ayla & Sam"}'
--     where quote_id='<Q>';              -- RLS: only your org
--   select * from publish_event_site((select id from event_sites where quote_id='<Q>'), true);
--   -- as anon (published only, display fields only):
--   select * from public_event_site('<the slug>');
--   -- second create_event_site('<Q>',...) returns the SAME row (idempotent).
-- ============================================================================
