-- =========================================================================
-- PHASE 20 — Closure, feedback, P&L & archive  [Block D — final checkpoint]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_closure = feedback / testimonial / consent / lessons + closed stamp.
-- event_ratings = ratings for the vendors & staff on this event.
-- The P&L is computed in the app from revenue, costs, expenses.
-- =========================================================================

create table if not exists public.event_closure (
  quote_id      uuid primary key references public.quotes(id) on delete cascade,
  client_rating int check (client_rating between 1 and 5),
  feedback      text,
  testimonial   text,
  media_consent boolean not null default false,
  lessons       text,
  closed_at     timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

create table if not exists public.event_ratings (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null check (kind in ('vendor','staff')),
  name       text not null,
  stars      int  not null check (stars between 1 and 5),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_ratings_quote_idx on public.event_ratings(quote_id, kind);

alter table public.event_closure enable row level security;
alter table public.event_ratings enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_closure','event_ratings')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read closure"  on public.event_closure for select to authenticated using ( true );
create policy "write closure" on public.event_closure for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read ratings"  on public.event_ratings for select to authenticated using ( true );
create policy "write ratings" on public.event_ratings for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- upsert the feedback / testimonial / lessons content
create or replace function public.set_closure(
  p_quote_id uuid, p_rating int, p_feedback text, p_testimonial text, p_media_consent boolean, p_lessons text
) returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_closure (quote_id, client_rating, feedback, testimonial, media_consent, lessons, updated_at, updated_by)
  values (p_quote_id, p_rating, p_feedback, p_testimonial, coalesce(p_media_consent,false), p_lessons, now(), auth.uid())
  on conflict (quote_id) do update set
    client_rating=excluded.client_rating, feedback=excluded.feedback, testimonial=excluded.testimonial,
    media_consent=excluded.media_consent, lessons=excluded.lessons, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

-- mark the event closed & archived (stamps closure + moves lifecycle to 'closed')
create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_closure (quote_id, closed_at, updated_by)
    values (p_quote_id, case when p_closed then now() end, auth.uid())
  on conflict (quote_id) do update set
    closed_at = case when p_closed then now() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  update public.quotes set lifecycle_stage = case when p_closed then 'closed' else 'settlement' end, updated_at=now()
   where id = p_quote_id;
  return r;
end; $$;

revoke all on function public.set_closure(uuid,int,text,text,boolean,text) from public, anon;
revoke all on function public.close_event(uuid,boolean)                    from public, anon;
grant execute on function public.set_closure(uuid,int,text,text,boolean,text) to authenticated;
grant execute on function public.close_event(uuid,boolean)                    to authenticated;
