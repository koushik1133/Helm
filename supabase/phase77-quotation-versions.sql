-- ============================================================================
-- Phase 77 — Quotation versioning (Q1, Q2, Q3 …)
-- ---------------------------------------------------------------------------
-- Every time the quotation is saved we keep a numbered snapshot (Q1, Q2 …)
-- instead of overwriting, so the full negotiation history is on record.
-- quotes.pricing still holds the latest (current) figures. Org-scoped.
-- Idempotent. Run AFTER phase57 + phase72.
-- ============================================================================

create table if not exists public.quotation_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id() references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  label       text not null,                 -- 'Q1', 'Q2', …
  pricing     jsonb not null default '{}'::jsonb,
  total       numeric not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists quotation_versions_quote_idx on public.quotation_versions(quote_id, created_at desc);

alter table public.quotation_versions enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='quotation_versions'
  loop execute format('drop policy if exists %I on public.quotation_versions', p.policyname); end loop;
end $$;
create policy "qv read"  on public.quotation_versions for select to authenticated
  using ( public.has_area('quotes','view') and org_id = (select public.current_org_id()) );
create policy "qv write" on public.quotation_versions for all to authenticated
  using ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) )
  with check ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) );

-- snapshot the quotation as the next Q-number, and keep quotes.pricing = latest
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int; lbl text; tot numeric; row public.quotation_versions;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  tot := coalesce((p_pricing->>'total')::numeric, 0);
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid())
    returning * into row;
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end; $$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';

select 'quotation_versions' t, 'ready' s;
