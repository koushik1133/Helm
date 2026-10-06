-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor        (rebuilt 2026-10-06, v2)
--   PART A  Invitation photos private ............. 0019   (prod: done · staging: done)
--   PART B  Studio client links + anti-phishing ... 0020   (prod: done · staging: NEW)
--   PART C  CRITICAL privilege lockdown ........... 0021   (prod: done · staging: NEW)
--   PART D  Links expire after the event .......... 0022   (prod: done · staging: NEW)
--   PART E  Fix: undated crew links keep 60 days .. 0023   (NEW on both)
-- Team chat (0016-0018) is already on both projects and is no longer in this file.
-- ════════════════════════════════════════════════════════════════════════════
-- SAFE: additive + idempotent; re-running parts already applied changes nothing.
-- The whole paste runs as ONE transaction: if any line fails, nothing is applied.
-- ORDER: run on STAGING first, then PRODUCTION. App code for C/D is backward
--   compatible, so the SQL can go before or after the code deploy.
-- USE: project → SQL Editor → paste ALL → Run → the last table must show all "ok".
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: not a Helm database (current_org_id missing). Wrong project?'; end if;
  if to_regclass('public.organizations') is null or to_regclass('public.profiles') is null then raise exception 'STOP: organizations/profiles missing — wrong project?'; end if;
  if to_regclass('public.event_sites') is null then raise exception 'STOP: event_sites missing (phase87 not installed)'; end if;
  if to_regprocedure('public.public_event_site(text)') is null and to_regprocedure('public.public_event_site__base(text)') is null then raise exception 'STOP: public_event_site missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='work_tokens' and column_name='expires_at')
    then raise exception 'STOP: work_tokens.expires_at missing (worker-token hardening not installed)'; end if;
  if to_regclass('public.chat_messages') is null then raise exception 'STOP: team chat (0016-0018) not installed — run APPLY-CHAT.sql first'; end if;
  raise notice 'Preflight OK — applying 0019-0023…';
end $$;

-- ═══════════════════ PART A — Invitation photos private (0019) ═══════════════════
-- ============================================================================
-- 0019_invite_media_published_read.sql — CANONICAL forward-only (security audit
-- Phase 2, finding P2-01).
-- Problem: 0013 made the invite-media bucket private with own-org-only read, but the
-- PUBLIC invitation page (/i/<slug>, anonymous guests) renders those photos — so on
-- any DB where 0013 is applied, guests' photos are broken, and prod was left with a
-- PUBLIC bucket (anyone holding a URL can fetch any photo, incl. drafts and photos
-- of UNPUBLISHED sites, forever).
-- Fix: keep the bucket PRIVATE and add one narrow read policy — an object is readable
-- by anon/authenticated ONLY while it is a photo on a PUBLISHED event site of the SAME
-- org + quote its key is filed under (<org_id>/<quote_id>/<uuid>.<ext>). Guests get it
-- through a short-lived signed URL (store-api sites.mediaUrls). Unpublish => unreadable.
-- A tenant can't "claim" another org's photo by pasting its URL into their own site:
-- the key's org/quote folders must match the publishing site.
-- Idempotent. Additive (no data touched). Forward-only.
-- ============================================================================

create or replace function public.invite_media_on_published_site(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.event_sites s
     where s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name
       )
  );
$$;
revoke all on function public.invite_media_on_published_site(text) from public;
grant execute on function public.invite_media_on_published_site(text) to anon, authenticated;

-- bucket stays private (re-pin in case it was flipped public in the dashboard)
update storage.buckets set public = false where id = 'invite-media' and public is distinct from false;

-- legacy phase88 "anyone can SELECT/list" policy must never come back (SEC-05 F6 / 0013)
drop policy if exists "invite_media_public_read" on storage.objects;
drop policy if exists "invite_media_published_read" on storage.objects;
create policy "invite_media_published_read" on storage.objects for select to anon, authenticated
  using ( bucket_id = 'invite-media' and public.invite_media_on_published_site(name) );

-- staff keep reading their OWN org's photos (draft thumbnails in the studio). 0013 /
-- SEC-05 F6 already create this; ensure it on any DB that predates them.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'invite_media_org_read') then
    create policy "invite_media_org_read" on storage.objects for select to authenticated
      using ( bucket_id = 'invite-media'
              and (storage.foldername(name))[1] = (select public.current_org_id())::text );
  end if;
end $$;

-- ---- VERIFY ----------------------------------------------------------------
-- select public from storage.buckets where id='invite-media';                       -- false
-- select policyname, roles from pg_policies where schemaname='storage' and policyname like 'invite_media%';


-- ═══════════════════ PART B — Studio client links + anti-phishing (0020) ═══════════════════
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


-- ═══════════════════ PART C — CRITICAL: members can't make themselves admin / change studio (0021) ═══════════════════
-- ============================================================================
-- 0021_profiles_privilege_lockdown.sql — CANONICAL forward-only (security audit
-- Phase 5, finding P5-01 — CRITICAL on any DB built from canonical, e.g. staging).
-- Problem: 0006 created profiles_self_update (USING/WITH CHECK id = auth.uid()) and
-- the authenticated role kept column UPDATE on every profiles column. So ANY signed-in
-- member could run  update profiles set role='admin', org_id='<other studio>'  on
-- their own row → instant admin, and a hop into another studio's data (verified on
-- the disposable DB: crew → admin → read studio B's quotes).
-- The app never writes profiles directly; every legitimate write goes through a
-- SECURITY DEFINER RPC (create_studio, admin_set_role, accept_invitation,
-- admin_create_user[_temp], clear_password_change_required, handle_new_user).
-- Fix (belt and braces):
--   1. drop the self-update policy;
--   2. revoke INSERT/UPDATE/DELETE on profiles from anon + authenticated;
--   3. a guard trigger rejects any role/org/id/email/must_change_password change,
--      and any insert/delete, made directly by anon/authenticated — so even a policy
--      or grant re-added by a legacy script can't re-open the hole. Definer RPCs run
--      as the function owner and are unaffected.
-- Idempotent. Additive (no data touched). Forward-only.
-- ============================================================================

drop policy if exists profiles_self_update on public.profiles;
revoke insert, update, delete on public.profiles from anon, authenticated;

create or replace function public.profiles_privilege_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- direct API callers only; SECURITY DEFINER RPCs run as their owner and pass through
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'UPDATE' then
      if new.id is distinct from old.id
         or new.role is distinct from old.role
         or new.org_id is distinct from old.org_id
         or new.email is distinct from old.email
         or new.must_change_password is distinct from old.must_change_password then
        raise exception 'a profile''s role or studio can only be changed by an admin' using errcode = '42501';
      end if;
    else
      raise exception 'profiles are managed by admins' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists profiles_privilege_guard_biud on public.profiles;
create trigger profiles_privilege_guard_biud before insert or update or delete on public.profiles
  for each row execute function public.profiles_privilege_guard();

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select policyname, cmd from pg_policies where schemaname='public' and tablename='profiles';      -- SELECT only
-- select has_table_privilege('authenticated','public.profiles','UPDATE');                           -- false
-- select tgname from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal;    -- includes the guard


-- ═══════════════════ PART D — Links expire after the event (0022) ═══════════════════
-- ============================================================================
-- 0022_client_link_windows.sql — CANONICAL forward-only. Public links stop working
-- a set time after the EVENT (end of that day, in the studio's timezone):
--   invitation website (guests) ........ event + 7 days   (NEW — never expired before)
--   proposal link ...................... event + 7 days   (NEW — never expired before)
--   crew task link ..................... event + 7 days   (was: 60 days rolling); a task
--                                        assigned later still gets >= 2 days to open it
--   client approval / portal / payment . event + 30 days  (unchanged, tg_approval_token_expiry:
--                                        clients pay the balance + see the gallery after)
-- Event date = quotes.event_date; for invitations the LATER of that and the
-- invitation's own date (guests are never cut off early). No date => no time limit.
-- Drift-safe: the two public RPCs get a thin wrapper and keep each project's OWN
-- original body (renamed *__base, anon can't call it directly) — so this can't undo a
-- production-only fix inside those functions.
-- Additive + idempotent. Data change: live crew links (not revoked/expired) are
-- re-timed to the new rule; nothing is deleted.
-- ============================================================================

-- ---- helpers -----------------------------------------------------------------
create or replace function public.try_date(p text)
returns date language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(p, 10)::date;
exception when others then return null;
end $$;

-- end of (event day + p_days) in the studio's timezone; NULL when no event date
create or replace function public.client_link_deadline(p_event date, p_org uuid, p_days int)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  if p_event is null then return null; end if;
  select nullif(btrim(o.timezone), '') into v_tz from public.organizations o where o.id = p_org;
  begin
    return ((p_event + p_days + 1)::timestamp at time zone coalesce(v_tz, 'Asia/Kolkata'));
  exception when others then
    return ((p_event + p_days + 1)::timestamp at time zone 'Asia/Kolkata');
  end;
end $$;
revoke all on function public.client_link_deadline(date, uuid, int) from public, anon;

create or replace function public.client_link_window_days(p_kind text)
returns int language sql immutable set search_path = '' as $$
  select case p_kind when 'invite' then 7 when 'proposal' then 7 when 'work' then 7
                     when 'quote' then 30 when 'portal' then 30 else 7 end;
$$;

-- invitation: live until (later of quote date / invitation date) + 7 days
create or replace function public.event_site_live_until(p_site_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.client_link_deadline(
           greatest(q.event_date, public.try_date(s.data->>'date')), s.org_id, public.client_link_window_days('invite'))
    from public.event_sites s left join public.quotes q on q.id = s.quote_id
   where s.id = p_site_id;
$$;
revoke all on function public.event_site_live_until(uuid) from public, anon;
grant execute on function public.event_site_live_until(uuid) to authenticated;   -- studio shows "live until"

-- ---- 1) invitation website ---------------------------------------------------
do $$ begin
  if to_regprocedure('public.public_event_site__base(text)') is null
     and to_regprocedure('public.public_event_site(text)') is not null then
    alter function public.public_event_site(text) rename to public_event_site__base;
  end if;
end $$;
revoke all on function public.public_event_site__base(text) from public, anon, authenticated;

create or replace function public.public_event_site(p_slug text)
returns table(event_type text, template text, title text, data jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare v_until timestamptz;
begin
  select public.event_site_live_until(s.id) into v_until
    from public.event_sites s where s.slug = p_slug and s.status = 'published';
  if v_until is not null and now() >= v_until then
    raise exception 'this invitation has ended' using errcode = 'P0001';
  end if;
  return query select * from public.public_event_site__base(p_slug);
end $$;
revoke all on function public.public_event_site(text) from public;
grant execute on function public.public_event_site(text) to anon, authenticated;

-- invitation photos follow the same window (0019 policy helper)
create or replace function public.invite_media_on_published_site(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.event_sites s
     where s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name
       )
  );
$$;
revoke all on function public.invite_media_on_published_site(text) from public;
grant execute on function public.invite_media_on_published_site(text) to anon, authenticated;

-- ---- 2) proposal link --------------------------------------------------------
do $$ begin
  if to_regprocedure('public.public_get_proposal__base(uuid)') is null
     and to_regprocedure('public.public_get_proposal(uuid)') is not null then
    alter function public.public_get_proposal(uuid) rename to public_get_proposal__base;
  end if;
end $$;
revoke all on function public.public_get_proposal__base(uuid) from public, anon, authenticated;

create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz;
begin
  select public.client_link_deadline(q.event_date, q.org_id, public.client_link_window_days('proposal')) into v_until
    from public.event_proposal pr join public.quotes q on q.id = pr.quote_id
   where pr.share_token = p_token and pr.published = true;
  if v_until is not null and now() >= v_until then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_proposal__base(p_token);
end $$;
revoke all on function public.public_get_proposal(uuid) from public;
grant execute on function public.public_get_proposal(uuid) to anon, authenticated;

-- ---- 3) crew task links ------------------------------------------------------
create or replace function public.work_token_expiry_for(p_quote uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select coalesce(
           greatest(public.client_link_deadline(q.event_date, q.org_id, public.client_link_window_days('work')),
                    now() + interval '2 days'),
           now() + interval '60 days')                     -- no event date → previous rule
    from public.quotes q where q.id = p_quote;
$$;
revoke all on function public.work_token_expiry_for(uuid) from public, anon;

-- assignment renews the link to the event-based window (replaces the 60-day roll)
create or replace function public.tg_work_token_renew()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_phone is null then return new; end if;
  update public.work_tokens w
     set expires_at = public.work_token_expiry_for(new.quote_id)
   where w.quote_id = new.quote_id and w.phone = new.assignee_phone and w.revoked_at is null;
  return new;
end $$;

-- moving the event date re-times that event's live crew links
create or replace function public.tg_quote_event_date_links()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.event_date is distinct from old.event_date then
    update public.work_tokens w
       set expires_at = public.work_token_expiry_for(new.id)
     where w.quote_id = new.id and w.revoked_at is null
       and (w.expires_at is null or w.expires_at > now());
  end if;
  return new;
end $$;
drop trigger if exists zz_quote_event_date_links on public.quotes;
create trigger zz_quote_event_date_links after update of event_date on public.quotes
  for each row execute function public.tg_quote_event_date_links();

-- new crew links start on the event-based window too (same trigger name as before)
create or replace function public.tg_work_token_expiry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.expires_at is null then new.expires_at := public.work_token_expiry_for(new.quote_id); end if;
  return new;
end $$;
drop trigger if exists work_token_default_expiry_bi on public.work_tokens;
drop trigger if exists zz_work_token_expiry on public.work_tokens;
create trigger zz_work_token_expiry before insert on public.work_tokens
  for each row execute function public.tg_work_token_expiry();

-- re-time LIVE crew links that already exist (revoked / expired ones untouched)
update public.work_tokens w
   set expires_at = public.work_token_expiry_for(w.quote_id)
 where w.revoked_at is null and (w.expires_at is null or w.expires_at > now());

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select s.slug, public.event_site_live_until(s.id) from public.event_sites s where s.status='published';
-- select quote_id, phone, expires_at from public.work_tokens where revoked_at is null order by expires_at;


-- ═══════════════════ PART E — Fix: undated crew links keep 60 days (0023) ═══════════════════
-- ============================================================================
-- 0023_work_token_no_date_fix.sql — CANONICAL forward-only. Fixes a bug in 0022
-- (found by live verification on production, 2026-10-06).
-- Bug: work_token_expiry_for() used greatest(deadline, now()+2 days) and fell back to
-- 60 days only when that was NULL — but Postgres greatest() IGNORES NULLs, so for an
-- event with NO date it returned now()+2 days instead of the intended 60 days. 0022's
-- backfill therefore cut crew links for undated events down to 2 days.
-- Fix: explicit CASE. Repair: live, non-revoked crew links on undated events get their
-- 60 days back (never shortened by this; dated events are untouched).
-- Idempotent. Nothing deleted.
-- ============================================================================

create or replace function public.work_token_expiry_for(p_quote uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select case
           when x.deadline is null then now() + interval '60 days'          -- no event date → previous rule
           else greatest(x.deadline, now() + interval '2 days')               -- event + 7, but >= 2 days to open it
         end
    from (select public.client_link_deadline(q.event_date, q.org_id, public.client_link_window_days('work')) as deadline
            from public.quotes q where q.id = p_quote) x;
$$;
revoke all on function public.work_token_expiry_for(uuid) from public, anon;

-- repair links 0022 shortened (undated events only; live + not revoked; only ever extends)
update public.work_tokens w
   set expires_at = greatest(w.expires_at, now() + interval '60 days')
  from public.quotes q
 where q.id = w.quote_id
   and q.event_date is null
   and w.revoked_at is null
   and w.expires_at is not null and w.expires_at > now()
   and w.expires_at < now() + interval '59 days';

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select q.code, q.event_date, w.expires_at from public.work_tokens w join public.quotes q on q.id=w.quote_id
--  where w.revoked_at is null order by w.expires_at;


-- ════════════════════════════════ VERIFY (one table — every row must say ok) ═══
select item, case when ok then 'ok' else 'PROBLEM' end as status from (values
  ('A invite photos bucket is private',
     (select not public from storage.buckets where id='invite-media')),
  ('A guests read only published-invite photos',
     exists (select 1 from pg_policies where schemaname='storage' and policyname='invite_media_published_read')
     and not exists (select 1 from pg_policies where schemaname='storage' and policyname='invite_media_public_read')),
  ('B every studio has a link name',
     not exists (select 1 from public.organizations where public_slug is null)),
  ('B anti-phishing link check installed',
     to_regprocedure('public.public_link_studio(text,text,text)') is not null),
  ('C members cannot edit profiles directly',
     not has_table_privilege('authenticated','public.profiles','UPDATE')
     and not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_self_update')),
  ('C profile privilege guard installed',
     exists (select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='profiles_privilege_guard_biud')),
  ('D invitation + proposal links expire (wrappers in place)',
     to_regprocedure('public.public_event_site__base(text)') is not null
     and to_regprocedure('public.public_get_proposal__base(uuid)') is not null),
  ('D originals not callable by the public',
     not has_function_privilege('anon','public.public_event_site__base(text)','execute')
     and not has_function_privilege('anon','public.public_get_proposal__base(uuid)','execute')),
  ('D guests can still open invitations',
     has_function_privilege('anon','public.public_event_site(text)','execute')),
  ('E undated crew links keep 60 days',
     not exists (select 1 from public.work_tokens w join public.quotes q on q.id = w.quote_id
                  where q.event_date is null and w.revoked_at is null
                    and w.expires_at > now() and w.expires_at < now() + interval '59 days'))
) v(item, ok);
