-- 0112_confirmed_at_stamp.sql - CANONICAL forward-only.
--
-- In plain words:
--   Recording the advance (record_payment) is how a quote becomes a confirmed booking, but
--   record_payment flips status to 'confirmed' WITHOUT setting quotes.confirmed_at (only the
--   older confirm_quote RPC stamps it). Business / Dashboard "Booked this month" and the
--   revenue chart (dashboard_money, 0108) count bookings by confirmed_at, so an event booked
--   through the normal flow was missing from "Booked this month" (found in QA-E2E Full Run 2:
--   booked_all 5,26,200 but October booked only 87,600).
--   Fix: a BEFORE UPDATE trigger that stamps confirmed_at = now() (and confirmed_by when empty)
--   the moment a quote's status changes to 'confirmed' while confirmed_at is still null.
--   It fires only on that transition, never overwrites an existing value, and the direct-write
--   guard (quotes_api_state_guard_biu, 0025) still blocks app users from changing status, so
--   only the server actions (record_payment, mark_paid, verify_and_consent, ...) reach it.
--   Named zz_* so it runs after quotes_api_state_guard_biu.
--
--   Changes: 1 new function + 1 new trigger. No table / column / row changed or deleted.
--   Existing confirmed quotes with a null confirmed_at are NOT backfilled (owner decision).
--   Additive + idempotent (create or replace / drop trigger if exists). Safe to run twice.

create or replace function public.quotes_stamp_confirmed_at()
returns trigger language plpgsql set search_path = '' as $$
-- confirmed-at-stamp-0112
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' and new.confirmed_at is null then
    new.confirmed_at := now();
    if new.confirmed_by is null then new.confirmed_by := auth.uid(); end if;
  end if;
  return new;
end $$;
revoke all on function public.quotes_stamp_confirmed_at() from public, anon, authenticated;
drop trigger if exists zz_quotes_stamp_confirmed_at on public.quotes;
create trigger zz_quotes_stamp_confirmed_at before update on public.quotes
  for each row execute function public.quotes_stamp_confirmed_at();
