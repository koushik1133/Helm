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
