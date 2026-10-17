-- APPLY-0149.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: adds one NOT VALID CHECK on public.leads.guest_count; no rows change.
begin;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.leads'::regclass and conname = 'leads_guest_count_range_chk') then
    alter table public.leads
      add constraint leads_guest_count_range_chk
      check (guest_count is null or (guest_count >= 0 and guest_count <= 100000)) not valid;
  end if;
end $$;
commit;

-- verify (read-only)
select 'leads_guest_count_range_chk present' as item,
       exists (select 1 from pg_constraint where conrelid = 'public.leads'::regclass and conname = 'leads_guest_count_range_chk') as ok
union all select 'check allows null and 0..100000',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.leads'::regclass and conname = 'leads_guest_count_range_chk') ilike '%100000%', false);
