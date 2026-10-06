-- ============================================================================
-- H07 — storage & query efficiency: add the indexes that matter, skip the rest
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Pure-additive, idempotent, NO behaviour
-- change. Safe to run on staging and prod (CREATE INDEX IF NOT EXISTS). Tables are
-- small today so a plain CREATE INDEX is fine; on very large tables use the
-- CONCURRENTLY variant (cannot run inside a transaction block).
--
-- WHY: audit of the authoritative schema found index gaps on the two hottest
-- access patterns for a multi-tenant app:
--   * org_id  — EVERY RLS policy filters by org_id (current_org_id()); 2 tables
--               (profiles, quotation_versions) lacked a leading org_id index.
--   * quote_id — "the quote row IS the event"; most per-event reads filter by it;
--               several child tables lacked a quote_id index.
--   * a handful of real entity-join FKs (dish/item/need/crew/vendor/owner/user).
--
-- DELIBERATELY NOT INDEXED: 38 audit columns (created_by/updated_by/confirmed_by/
-- issued_by/…) that reference auth.users and are essentially never filtered or
-- joined on. Indexing them would add write-amplification + storage for ~no read
-- benefit — the opposite of "clean and efficient". (If a user-deletion cascade ever
-- becomes hot, revisit.)
--
-- DUPLICATE DATA: the one real duplicate-storage issue (paid milestone amount also
-- counted as money alongside the quote_payments ledger) was resolved by H04
-- (ledger-only helm_total_paid). No other structural duplication found.
-- ============================================================================

-- ---- PRECHECK (read-only): how many of these indexes are missing now --------
select count(*) as missing_before from (values
  ('profiles','org_id'),('quotation_versions','org_id'),
  ('event_attendees','quote_id'),('event_closure','quote_id'),('event_discovery','quote_id'),
  ('event_plan','quote_id'),('event_proposal','quote_id'),('leads','quote_id'),
  ('notifications','quote_id'),('nurture','quote_id'),('work_tokens','quote_id'),
  ('event_costs','booking_id'),('event_menu_items','dish_id'),('event_resource_needs','item_id'),
  ('event_resources','need_id'),('event_stock_requests','item_id'),('event_tasks','crew_id'),
  ('event_tasks','vendor_id'),('inventory_checkouts','issued_to_id'),('leads','owner'),
  ('notification_seen','user_id'),('quotes','manager_id')
) as want(tbl,col)
where not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indrelid
  join pg_attribute a on a.attrelid=c.oid and a.attnum=i.indkey[0]
  where c.relname=want.tbl and a.attname=want.col
);

-- ---- APPLY (idempotent) ----------------------------------------------------
-- RLS hot path: org_id
create index if not exists profiles_org_idx             on public.profiles(org_id);
create index if not exists quotation_versions_org_idx   on public.quotation_versions(org_id);
-- per-event hot path: quote_id
create index if not exists event_attendees_quote_idx    on public.event_attendees(quote_id);
create index if not exists event_closure_quote_idx      on public.event_closure(quote_id);
create index if not exists event_discovery_quote_idx    on public.event_discovery(quote_id);
create index if not exists event_plan_quote_idx         on public.event_plan(quote_id);
create index if not exists event_proposal_quote_idx     on public.event_proposal(quote_id);
create index if not exists leads_quote_idx              on public.leads(quote_id);
create index if not exists notifications_quote_idx      on public.notifications(quote_id);
create index if not exists nurture_quote_idx            on public.nurture(quote_id);
create index if not exists work_tokens_quote_idx        on public.work_tokens(quote_id);
-- entity joins
create index if not exists event_costs_booking_idx          on public.event_costs(booking_id);
create index if not exists event_menu_items_dish_idx        on public.event_menu_items(dish_id);
create index if not exists event_resource_needs_item_idx    on public.event_resource_needs(item_id);
create index if not exists event_resources_need_idx         on public.event_resources(need_id);
create index if not exists event_stock_requests_item_idx    on public.event_stock_requests(item_id);
create index if not exists event_tasks_crew_idx             on public.event_tasks(crew_id);
create index if not exists event_tasks_vendor_idx           on public.event_tasks(vendor_id);
create index if not exists inventory_checkouts_issued_to_idx on public.inventory_checkouts(issued_to_id);
create index if not exists leads_owner_idx                  on public.leads(owner);
create index if not exists notification_seen_user_idx       on public.notification_seen(user_id);
create index if not exists quotes_manager_idx               on public.quotes(manager_id);

-- ---- VERIFY (expect missing_after = 0) -------------------------------------
select count(*) as missing_after from (values
  ('profiles','org_id'),('quotation_versions','org_id'),
  ('event_attendees','quote_id'),('event_closure','quote_id'),('event_discovery','quote_id'),
  ('event_plan','quote_id'),('event_proposal','quote_id'),('leads','quote_id'),
  ('notifications','quote_id'),('nurture','quote_id'),('work_tokens','quote_id'),
  ('event_costs','booking_id'),('event_menu_items','dish_id'),('event_resource_needs','item_id'),
  ('event_resources','need_id'),('event_stock_requests','item_id'),('event_tasks','crew_id'),
  ('event_tasks','vendor_id'),('inventory_checkouts','issued_to_id'),('leads','owner'),
  ('notification_seen','user_id'),('quotes','manager_id')
) as want(tbl,col)
where not exists (
  select 1 from pg_index i join pg_class c on c.oid=i.indrelid
  join pg_attribute a on a.attrelid=c.oid and a.attnum=i.indkey[0]
  where c.relname=want.tbl and a.attname=want.col
);

-- ---- ROLLBACK (drop just these indexes; names are deterministic) -----------
-- drop index if exists public.profiles_org_idx, public.quotation_versions_org_idx, ... ;
