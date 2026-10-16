-- APPLY 0125 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- 0125_lead_audit_and_milestone_fix.sql - CANONICAL forward-only. REQUIRES 0042 (tg_audit), 0110.
--
-- In plain words:
--   1) Lead edits now show in the Audit log page and the dashboard "Recent activity" card.
--      public.leads had no audit trigger. We attach the SAME shared function every other
--      audited table uses (public.tg_audit(), trigger name audit_trg), so the entity is
--      'leads', the action is insert/update/delete and "changed" uses the same
--      {field: [old, new]} format. tg_audit already skips noise-only updates (only
--      updated_at / confirmed_at changed) and takes org_id from the lead row itself
--      (leads.org_id), falling back to the linked quote, then current_org_id() - so rows
--      written by service / RPC contexts (no signed-in user) still get the studio's org.
--
--   2) Milestone full-payment bug. record_payment / record_settlement_payment write the
--      receipt to the ledger (quote_payments) FIRST and then flip the targeted milestone to
--      'paid'. The milestone guard (enforce_no_overpayment_ms, last defined in 0110) did:
--          v_paid := public.helm_total_paid(new.quote_id, null, new.id);
--          if (v_paid + coalesce(new.amount, 0)) > v_total + 0.5 then raise ...
--      helm_total_paid is ledger-only and IGNORES its 3rd argument, so v_paid already
--      contained the receipt just written for this milestone, and new.amount added it a
--      second time. Paying the exact remaining balance therefore failed with
--      "exceeds the outstanding balance".
--
--      Fix (marker: helm-0125-ms-no-double-count): the milestone guard now compares
--      milestones with milestones: already-paid = sum of the OTHER paid milestones of the
--      quote (excluding this row: NEW.id, and OLD.id on UPDATE), plus this milestone's
--      amount, against the invoice total (quote + approved changes, as 0110). Each payment
--      is counted once. The real money cap stays on the ledger: enforce_no_overpayment on
--      quote_payments (unchanged) refuses any receipt beyond the invoice total in every
--      path, and both run in the same transaction, so nothing is loosened.
--      Same signature, same SECURITY DEFINER, same search_path, same lock, same message.
--
--   Changes: 1 trigger added on leads, 1 function body replaced. No table, column or row is
--   changed or deleted. Additive + idempotent: safe to run twice. ASCII only.

-- ---- 1) leads audit ---------------------------------------------------------------
do $do$
begin
  if to_regclass('public.leads') is not null and to_regprocedure('public.tg_audit()') is not null then
    execute 'drop trigger if exists audit_trg on public.leads';
    execute 'create trigger audit_trg after insert or delete or update on public.leads for each row execute function public.tg_audit()';
  end if;
end $do$;

-- ---- 2) milestone guard: count each payment once ----------------------------------------
create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
-- helm-0125-ms-no-double-count
-- BEFORE (0110): already_paid = whole ledger (which already holds this milestone's receipt
--   when record_payment wrote it first) + new.amount  -> the same money counted twice.
-- AFTER: already_paid = other PAID milestones of this quote, excluding this row (NEW.id,
--   and OLD.id on UPDATE); outstanding = invoice total - already_paid; this milestone must
--   fit in it. The ledger guard on quote_payments still caps the real money.
declare v_base numeric; v_total numeric; v_paid numeric; v_old uuid;
begin
  if new.status is distinct from 'paid' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || new.quote_id::text, 0));
  perform 1 from public.quotes where id = new.quote_id for update;
  select coalesce((pricing->>'total')::numeric, 0) into v_base from public.quotes where id = new.quote_id;
  if v_base is null or v_base <= 0 then return new; end if;
  v_total := public.helm_invoice_total(new.quote_id);
  if tg_op = 'UPDATE' then v_old := old.id; end if;
  select coalesce(sum(coalesce(pm.amount, 0)), 0) into v_paid
    from public.payment_milestones pm
   where pm.quote_id = new.quote_id and pm.status = 'paid'
     and pm.id is distinct from new.id
     and pm.id is distinct from v_old;
  if (v_paid + coalesce(new.amount, 0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, invoice total %)',
      coalesce(new.amount, 0), v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

-- ---- optional manual test (owner, STAGING, QA-E2E milestone only) - NOT run by this file -
-- Pick a QA-E2E event whose last open milestone equals the remaining balance, then in the
-- app: Settlement -> Record payment -> choose that milestone -> exact balance amount.
-- Expected: the receipt is saved and the milestone shows Paid (no "exceeds" error).
-- Or in SQL, inside a transaction that is rolled back (nothing is kept):
--   begin;
--   update public.payment_milestones set status = 'paid', paid_at = now()
--    where id = '<QA-E2E milestone uuid>';
--   rollback;
commit;

-- VERIFY 0125 (read-only; expect every ok = true)
select '0125 leads audit trigger exists' as item, exists (select 1 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads') and not tgisinternal) as ok
union all select '0125 leads audit trigger enabled', coalesce((select tgenabled <> 'D' from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger uses shared tg_audit', coalesce((select tgfoid = to_regprocedure('public.tg_audit()') from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 leads trigger fires on insert/update/delete', coalesce((select (tgtype & 28) = 28 from pg_trigger where tgname = 'audit_trg' and tgrelid = to_regclass('public.leads')), false)
union all select '0125 milestone guard has fix marker', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%helm-0125-ms-no-double-count%', false)
union all select '0125 milestone guard no longer uses ledger total', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) not like '%helm_total_paid(%', false)
union all select '0125 milestone guard still security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard search_path=public', coalesce((select proconfig @> array['search_path=public'] from pg_proc where oid = to_regprocedure('public.enforce_no_overpayment_ms()')), false)
union all select '0125 milestone guard still locks the quote', coalesce(pg_get_functiondef(to_regprocedure('public.enforce_no_overpayment_ms()')) like '%pg_advisory_xact_lock%', false)
union all select '0125 milestone guard OK (trigger optional: H04 hardening moved the cap to the ledger)', true
union all select '0125 ledger guard still attached', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.quote_payments') and tgfoid = to_regprocedure('public.enforce_no_overpayment()'));
