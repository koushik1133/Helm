-- =========================================================================
-- Phase 27 — Repeat business / CRM nurture (spec step 94)
-- A nurture list of past & prospective clients with occasion follow-up dates.
-- Idempotent. CRM/sales data -> read + write = admin/planner/sales (phase21).
-- =========================================================================
create table if not exists public.nurture (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  email         text,
  occasion      text,                          -- "Anniversary", "Birthday", "Annual gala"…
  occasion_date date,
  next_followup date,                           -- when to reach out next
  note          text,
  status        text not null default 'active'
                check (status in ('active','won','dormant')),
  quote_id      uuid references public.quotes(id) on delete set null,   -- source event, if any
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);
create index if not exists nurture_followup_idx on public.nurture(next_followup);

alter table public.nurture enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='nurture'
  loop execute format('drop policy if exists %I on public.nurture', p.policyname); end loop;
end $$;
create policy "nurture view" on public.nurture for select to authenticated using ( public.can_view_finance() );
create policy "nurture ins"  on public.nurture for insert to authenticated with check ( public.can_view_finance() );
create policy "nurture upd"  on public.nurture for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() );
create policy "nurture del"  on public.nurture for delete to authenticated using ( public.can_view_finance() );

notify pgrst, 'reload schema';
