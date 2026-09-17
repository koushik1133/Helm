-- =========================================================================
-- PHASE 2 — Leads & pipeline (CRM front)
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:  public.leads  +  convert_lead_to_quote()  RPC.
-- =========================================================================

-- 1) LEADS TABLE ----------------------------------------------------------
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text,
  email        text,
  source       text,                    -- referral | website | walk-in | social | ad | other
  event_type   text,
  event_date   date,
  budget       numeric,
  guest_count  int,
  notes        text,
  status       text not null default 'new'
               check (status in ('new','qualified','discovery','quoted','won','lost')),
  quote_id     uuid references public.quotes(id) on delete set null,
  owner        uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists leads_status_idx  on public.leads (status);
create index if not exists leads_updated_idx on public.leads (updated_at desc);

drop trigger if exists leads_set_updated on public.leads;
create trigger leads_set_updated before update on public.leads
  for each row execute function public.set_updated_at();

-- 2) RLS ------------------------------------------------------------------
alter table public.leads enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='leads'
  loop execute format('drop policy if exists %I on public.leads', p.policyname); end loop;
end $$;
create policy "read leads"   on public.leads for select to authenticated using ( true );
create policy "insert leads" on public.leads for insert to authenticated with check ( public.can_create() );
create policy "update leads" on public.leads for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete leads" on public.leads for delete to authenticated using ( public.can_delete() );

-- 3) CONVERT LEAD -> QUOTE ------------------------------------------------
-- Reuses the existing quote engine (create_quote logic) without touching it.
-- Auto-generates the MMDDYYYY-NN code, links lead<->quote, marks lead 'quoted'.
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads;
  q public.quotes;
  v_stamp text := to_char(now(), 'MMDDYYYY');
  v_next  int;
  v_code  text;
  v_title text;
begin
  if not public.can_create() then
    raise exception 'not authorized to create' using errcode='42501';
  end if;

  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then
    -- already converted: just return the linked quote
    select * into q from public.quotes where id = l.quote_id;
    return q;
  end if;

  -- next running number for today's stamp
  select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
    into v_next from public.quotes where code like v_stamp || '-%';
  v_code  := v_stamp || '-' || lpad(v_next::text, 2, '0');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;

  insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage)
    values (v_code, v_title, l.event_type, 1,
            jsonb_strip_nulls(jsonb_build_object(
              'name',  l.name,
              'phone', l.phone,
              'email', l.email)),
            'discovery')     -- a converted lead opens at Discovery
    returning * into q;

  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());

  update public.leads
     set status = 'quoted', quote_id = q.id, updated_at = now()
   where id = p_lead_id;

  return q;
end; $$;

revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;
