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
