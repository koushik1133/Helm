-- W15B-00-PRECHECK.sql — run on STAGING before the UPGRADE. Read-only. No writes.
-- Confirms the current (phase99) inert behavior and captures a before-snapshot so
-- VERIFY can prove the change and ROLLBACK can be reasoned about. STAGING ONLY.
\echo '== current helm_quote_total on SHIPPING payload (no top-level subtotal) =='
-- Expect (pre-fix): returns the CLIENT total 1 (bug). Post-fix: recomputes 236000.
select public.helm_quote_total(
  '{"chairs":100,"chairPrice":1000,"guests":100,"platePrice":1000,"other":0,
    "serviceChargePct":0,"discount":0,"discountPct":0,"gstPct":18,
    "catering":{"mode":"inhouse","amount":0},"computed":{"subtotal":200000,"total":236000},"total":1}'::jsonb
) as shipping_payload_total;

\echo '== current helm_quote_total on LEGACY payload (top-level subtotal) =='
-- Expect: 236000 both pre- and post-fix (legacy path unchanged).
select public.helm_quote_total('{"subtotal":200000,"discount":0,"gstPct":18,"total":1}'::jsonb) as legacy_total;

\echo '== count of quotes with pricing (impact scope, read-only) =='
select count(*) as quotes_with_pricing from public.quotes where pricing ? 'total';
