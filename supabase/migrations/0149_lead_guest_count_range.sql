-- 0149_lead_guest_count_range.sql - CANONICAL forward-only. No prerequisites beyond public.leads.
--
-- In plain words - sales-role test (QA1017): the Leads form refuses a guest count below 0 or above
-- 100,000, but the database itself accepted -5 and 100001 when a lead was written directly
-- (the API, an import, or an old app tab). This adds a CHECK so a NEW or EDITED lead must have
-- an empty guest count or a whole number between 0 and 100,000 (the same cap the quote flow uses).
--
-- NOT VALID: rows that already exist are NOT checked and NOT changed. Nothing is deleted or
-- rewritten. (An existing out-of-range lead must get a valid guest count the next time it is
-- edited - the app form already requires that.) Idempotent: re-running changes nothing.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.leads'::regclass and conname = 'leads_guest_count_range_chk') then
    alter table public.leads
      add constraint leads_guest_count_range_chk
      check (guest_count is null or (guest_count >= 0 and guest_count <= 100000)) not valid;
  end if;
end $$;
