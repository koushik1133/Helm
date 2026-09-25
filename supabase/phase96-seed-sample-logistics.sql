-- =========================================================================
-- Phase 96 — Sample logistics data for ONE event (code 09162026-01).
-- Adds example Permits / Comms / Logistics checklist rows + Payment milestones
-- so the tabs aren't empty. SAFE + IDEMPOTENT + ADDITIVE (inserts only when the
-- same row is missing; never overwrites/deletes). Change v_code to target another
-- event. Run the DO block on its own.
-- =========================================================================

do $$
declare
  v_code text := '09162026-01';   -- <-- the event to seed
  v_quote uuid;
  v_org   uuid;
  v_has_chk_org  boolean;
  v_has_mile_org boolean;
begin
  select id, org_id into v_quote, v_org from public.quotes where code = v_code limit 1;
  if v_quote is null then
    raise notice 'Event % not found — nothing seeded.', v_code; return;
  end if;

  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='event_checklist' and column_name='org_id') into v_has_chk_org;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='payment_milestones' and column_name='org_id') into v_has_mile_org;

  -- ---- checklist rows: Permits (compliance), Comms, Logistics -------------
  -- insert (quote_id, section, title[, owner][, org_id]) only when absent
  insert into public.event_checklist(quote_id, section, title, owner, status, seq
         , org_id )
  select v_quote, x.section, x.title, x.owner, 'open', x.seq
         , case when v_has_chk_org then v_org else null end
    from (values
      ('compliance','Venue fire-safety clearance','Ops',1),
      ('compliance','Public-liability insurance','Finance',2),
      ('compliance','Music / PPL licence','Ops',3),
      ('compliance','Alcohol permit (bar service)','Ops',4),
      ('comms','Send save-the-date to client','Sales',1),
      ('comms','Confirm final guest count','Planner',2),
      ('comms','Share run-sheet with client','Planner',3),
      ('comms','Post-event thank-you note','Sales',4),
      ('logistics','Vendor load-in schedule','Ops',1),
      ('logistics','Generator backup booked','Ops',2),
      ('logistics','Transport & parking plan','Ops',3),
      ('logistics','Teardown & handover','Ops',4)
    ) as x(section, title, owner, seq)
   where not exists (
     select 1 from public.event_checklist c
      where c.quote_id = v_quote and c.section = x.section and c.title = x.title);

  -- ---- payment milestones -------------------------------------------------
  insert into public.payment_milestones(quote_id, label, amount, status, due_date, seq
         , org_id )
  select v_quote, x.label, x.amount, x.status, x.due_date, x.seq
         , case when v_has_mile_org then v_org else null end
    from (values
      ('50% advance on booking', 200000::numeric, 'paid',     current_date - 20, 1),
      ('25% on setup day',       100000::numeric, 'invoiced', current_date + 5,  2),
      ('Final balance',          100000::numeric, 'due',      current_date + 20, 3)
    ) as x(label, amount, status, due_date, seq)
   where not exists (
     select 1 from public.payment_milestones m
      where m.quote_id = v_quote and m.label = x.label);

  raise notice 'Sample logistics seeded for event % (quote %).', v_code, v_quote;
end $$;

-- Verify (separate run):
-- select section, count(*) from public.event_checklist
--   where quote_id = (select id from public.quotes where code='09162026-01') group by section;
-- select label, amount, status from public.payment_milestones
--   where quote_id = (select id from public.quotes where code='09162026-01') order by seq;
