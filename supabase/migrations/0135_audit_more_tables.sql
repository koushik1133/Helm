-- 0135_audit_more_tables.sql - CANONICAL forward-only. REQUIRES 0042 (tg_audit), 0124 (vendor bills).
--
-- In plain words:
--   Changes to vendor bills, vendor payouts, inventory reservations and run-sheet rows now
--   show up in the Audit log, using the same shared audit trigger every other audited table
--   uses (public.tg_audit(), trigger name audit_trg) - exactly like 0125 did for leads.
--   A table that does not exist yet is skipped. No table, column or row is created, changed
--   or deleted. Additive + idempotent (drop trigger if exists + create): safe to run twice. ASCII only.

do $do$
declare t text;
begin
  if to_regprocedure('public.tg_audit()') is null then return; end if;
  foreach t in array array['vendor_bills','vendor_payouts','inventory_reservations','run_sheet_items'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists audit_trg on public.%I', t);
      execute format('create trigger audit_trg after insert or delete or update on public.%I for each row execute function public.tg_audit()', t);
    end if;
  end loop;
end $do$;
