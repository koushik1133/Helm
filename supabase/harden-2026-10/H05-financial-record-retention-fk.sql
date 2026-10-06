-- ============================================================================
-- H05 — retention-safe FKs: never silently cascade-delete financial / consent
--        / refund records when a quote is deleted (brief section E)
-- ----------------------------------------------------------------------------
-- SERIES: harden-2026-10 (forward-only). Apply order: H01 → H02 → H03 → H05 (H04 optional).
-- NOT APPLIED. Verify on an isolated test DB first. Never run on prod from here.
--
-- FINDING: quote_payments, quote_consents, payment_milestones, event_refunds all
-- have `… references quotes(id) ON DELETE CASCADE`. Deleting a quote would silently
-- destroy its money ledger, consent proof, settlement schedule, and refunds —
-- against retention requirements. (Mitigant today: the app exposes NO quote-delete
-- path — no RLS delete policy, no delete RPC — so this is only reachable by a
-- direct admin DELETE / service_role. H05 makes that accident impossible too.)
--
-- FIX: switch those FKs to ON DELETE RESTRICT so a quote that has any financial /
-- consent / refund record CANNOT be deleted. Removal must instead go through an
-- explicit archive / reversal workflow (not built here — see note). This does NOT
-- delete or alter any data; it only changes the delete rule.
--
-- SCOPE NOTE: quote_otps is intentionally LEFT as ON DELETE CASCADE — OTP codes are
-- short-lived, single-use, and not a retention record; cascading them with a (non-
-- existent) quote delete is acceptable. Flip it below if you want it preserved too.
--
-- Idempotent: each constraint is only rebuilt if it is not already RESTRICT.
-- Transactional: wrap in BEGIN/COMMIT in the SQL editor (brief: explicit tx bounds).
-- ============================================================================

-- ---- PRECHECK (read-only) — expect confdeltype = 'c' (CASCADE) for each today --
select conrelid::regclass as child_table, conname,
       case confdeltype when 'c' then 'CASCADE' when 'r' then 'RESTRICT'
            when 'a' then 'NO ACTION' when 'n' then 'SET NULL' else confdeltype::text end as on_delete
from pg_constraint
where confrelid = 'public.quotes'::regclass
  and conrelid in ('public.quote_payments'::regclass, 'public.quote_consents'::regclass,
                   'public.payment_milestones'::regclass, 'public.event_refunds'::regclass)
order by child_table;

-- ---- APPLY (idempotent; run inside a transaction) -------------------------
do $$
declare r record;
begin
  for r in
    select con.conname, con.conrelid::regclass::text as child, att.attname as col
    from pg_constraint con
    join lateral unnest(con.conkey) as k(attnum) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.confrelid = 'public.quotes'::regclass
      and con.contype = 'f'
      and con.confdeltype = 'c'                                  -- only the CASCADE ones
      and con.conrelid in ('public.quote_payments'::regclass, 'public.quote_consents'::regclass,
                           'public.payment_milestones'::regclass, 'public.event_refunds'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.child, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references public.quotes(id) on delete restrict',
                   r.child, r.conname, r.col);
    raise notice 'retention-locked %.% (now ON DELETE RESTRICT)', r.child, r.conname;
  end loop;
end $$;

-- ---- VERIFY (expect every row RESTRICT) -----------------------------------
select conrelid::regclass as child_table,
       case confdeltype when 'r' then 'RESTRICT' when 'c' then 'CASCADE' else confdeltype::text end as on_delete,
       (confdeltype = 'r') as ok
from pg_constraint
where confrelid = 'public.quotes'::regclass
  and conrelid in ('public.quote_payments'::regclass, 'public.quote_consents'::regclass,
                   'public.payment_milestones'::regclass, 'public.event_refunds'::regclass)
order by child_table;

-- ---- ROLLBACK (restore CASCADE) -------------------------------------------
-- For each of the 4 tables (example shown for quote_payments):
--   alter table public.quote_payments drop constraint quote_payments_quote_id_fkey,
--     add constraint quote_payments_quote_id_fkey foreign key (quote_id)
--       references public.quotes(id) on delete cascade;
--
-- NOTE (not built here, product decision): an explicit archive / reversal workflow
-- — soft-delete a quote (status='archived') and define reversal RPCs for payments /
-- refunds with immutable audit — so operators can retire an event without ever
-- hard-deleting financial history. Recommend before enabling any quote-delete UI.
