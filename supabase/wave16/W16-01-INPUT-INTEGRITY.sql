-- ============================================================================
-- W16-01-INPUT-INTEGRITY.sql — data-layer backstop for the Wave 16 input-
-- hardening pass. Additive, idempotent CHECK constraints so invalid numerics can
-- never reach the database even via a crafted request that bypasses the UI.
-- STATUS: APPLIED + VERIFIED ON STAGING (xizehqgeyjcfpzrdymly) 2026-09-28.
--   Pre-check found 0 violating rows (inventory_items.total_qty/unit_cost < 0,
--   quote_payments.amount < 0), so the constraints validate cleanly.
--   Verified at runtime: negative total_qty and negative payment amount are both
--   rejected (check_violation).
-- NOT FOR PRODUCTION until reviewed. Pair with the client hardener in
-- public/store-api.js (BPStore.validate + the global input[type=number] guard).
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_total_qty_nonneg') then
    alter table public.inventory_items add constraint inventory_items_total_qty_nonneg check (total_qty >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_unit_cost_nonneg') then
    alter table public.inventory_items add constraint inventory_items_unit_cost_nonneg check (unit_cost is null or unit_cost >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quote_payments_amount_pos') then
    alter table public.quote_payments add constraint quote_payments_amount_pos check (amount > 0);
  end if;
end $$;
