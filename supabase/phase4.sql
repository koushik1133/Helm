-- =========================================================================
-- PHASE 4 — Proposal & mood-board (light) + feasibility/risk checklist
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:
--   • public.event_proposal   — one shareable proposal per event (token-scoped)
--   • public.proposal_risks   — internal feasibility/risk checklist
--   • set_proposal()          — upsert proposal content (can_edit)
--   • publish_proposal()      — publish/unpublish + issue the share token
--   • public_get_proposal()   — anon read of a PUBLISHED proposal by token
-- Mirrors the approval token pattern; does not touch the quote/approval engine.
-- =========================================================================

-- 1) PROPOSAL (one row per event) ----------------------------------------
create table if not exists public.event_proposal (
  quote_id     uuid primary key references public.quotes(id) on delete cascade,
  concept      text,
  theme        text,
  palette      jsonb not null default '[]'::jsonb,   -- ["#rrggbb", ...]
  images       jsonb not null default '[]'::jsonb,   -- ["https://...", ...]
  scope        jsonb not null default '[]'::jsonb,   -- ["Stage décor", "Catering", ...]
  share_token  uuid,
  published    boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)
);
create unique index if not exists event_proposal_token_idx
  on public.event_proposal(share_token) where share_token is not null;

-- 2) FEASIBILITY / RISK checklist (internal) -----------------------------
create table if not exists public.proposal_risks (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  title       text not null,
  severity    text not null default 'medium' check (severity in ('low','medium','high')),
  mitigation  text,
  status      text not null default 'open'   check (status in ('open','mitigated','accepted')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists proposal_risks_quote_idx on public.proposal_risks(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_proposal enable row level security;
alter table public.proposal_risks enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_proposal','proposal_risks')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read proposal"  on public.event_proposal for select to authenticated using ( true );
create policy "write proposal" on public.event_proposal for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read risks"    on public.proposal_risks for select to authenticated using ( true );
create policy "insert risks"  on public.proposal_risks for insert to authenticated with check ( public.can_edit() );
create policy "update risks"  on public.proposal_risks for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete risks"  on public.proposal_risks for delete to authenticated using ( public.can_delete() );

-- 4) UPSERT proposal content ---------------------------------------------
create or replace function public.set_proposal(
  p_quote_id uuid, p_concept text, p_theme text,
  p_palette jsonb, p_images jsonb, p_scope jsonb
) returns public.event_proposal language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $$;

-- 5) PUBLISH / UNPUBLISH + issue share token ------------------------------
create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  -- ensure a proposal row exists
  insert into public.event_proposal (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  select share_token into tok from public.event_proposal where quote_id = p_quote_id;
  if tok is null and p_published then tok := gen_random_uuid(); end if;
  update public.event_proposal
     set published = p_published, share_token = coalesce(tok, share_token), updated_at = now()
   where quote_id = p_quote_id;
  return tok;
end; $$;

-- 6) PUBLIC: fetch a PUBLISHED proposal by token (anon) -------------------
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''));
end; $$;

revoke all on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) from public, anon;
revoke all on function public.publish_proposal(uuid,boolean)                 from public, anon;
grant execute on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.publish_proposal(uuid,boolean)                 to authenticated;
grant execute on function public.public_get_proposal(uuid)                      to anon, authenticated;
