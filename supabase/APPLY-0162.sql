-- APPLY-0162.sql - paste into the Supabase SQL editor. PRODUCTION ONLY (staging keeps the bypass ON for testing).
-- Additive + idempotent: sets ONE flag (helm_billing_settings.allow_trial_bypass = false). No table, column, function or other row is created, changed or deleted. Safe to run twice.
begin;
-- 0162_launch_bypass_off.sql - CANONICAL forward-only. Launch: switch off "Skip payment" on the server.
--
-- RUN ON PRODUCTION ONLY. Do NOT run on staging - staging keeps the bypass ON so the
-- "Skip payment (testing only)" button on /checkout can still be tested there.
--
-- In plain words:
--   * helm_billing_settings.allow_trial_bypass (added in 0056, default true) is the real server
--     gate for the "Skip payment (testing only)" checkout button. my_start_trial('bypass') refuses
--     when it is false. This sets it to false for launch.
--   * The browser switch (public/config.js onboarding.allowPaymentBypass) is already false on
--     helm.events / www.helm.events in the same PR; this is the server half.
--   * HQ can still turn it back on later from Helm HQ (hq_set_checkout_settings) if ever needed.
--
-- Additive + idempotent: updates ONE boolean on the single settings row (id = true). No table,
-- column, function or other row is created, changed or deleted. Safe to run twice.
-- Needs 0045 (helm_billing_settings) and 0056 (allow_trial_bypass).
-- ============================================================================

do $$ begin
  if to_regclass('public.helm_billing_settings') is null then raise exception '0162: apply 0045 first (helm_billing_settings missing)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'helm_billing_settings' and column_name = 'allow_trial_bypass') then
    raise exception '0162: apply 0056 first (allow_trial_bypass missing)';
  end if;
end $$;

update public.helm_billing_settings
   set allow_trial_bypass = false
 where id and allow_trial_bypass is distinct from false;
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 settings row exists', exists (select 1 from public.helm_billing_settings where id)),
  ('02 skip payment off on the server', not exists (select 1 from public.helm_billing_settings where coalesce(allow_trial_bypass, true)))
) v(item, ok);
