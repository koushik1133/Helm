-- APPLY-0079.sql - ONE paste for the Supabase SQL editor. Run on STAGING
-- (xizehqgeyjcfpzrdymly) first, check the final VERIFY, then PROD (nqltzgiwznphugcfhmbm).
-- Contents = supabase/migrations/0079_country_tax.sql verbatim, plus VERIFY.
-- Pure ASCII, no temp objects or session state. Idempotent: safe to paste twice.
-- Additive only: renames the current total function once and wraps it. No row is changed.
-- EXPECTED: the last result grid (item, ok) has 6 rows and EVERY ok = true.

-- 0079_country_tax.sql - CANONICAL forward-only. Country-based tax: tax-inclusive prices.
--
-- In plain words:
--   A studio now picks its country (India, UAE, UK, US, Singapore, Australia, Canada or
--   other). The country only changes LABELS (GST / VAT / Sales tax, GSTIN / TRN / ABN ...),
--   the currency symbol and the suggested default rate - the money is still ONE rate kept
--   in quotes.pricing.gstPct, so the existing D8 server pricing authority keeps working.
--   The one new money rule: an admin may say "my prices already include tax". A quote
--   saved that way carries pricing.taxInclusive = true, and its total is the post-discount
--   value itself (the tax is extracted from it for display, not added on top).
--
--   This file wraps helm_quote_total once more (the same rename-and-wrap pattern as 0026):
--     * the current function is kept, unchanged, as helm_quote_total__pretax
--     * the new helm_quote_total: when pricing.taxInclusive is true it prices the quote with
--       gstPct 0 (= round(post-discount value)); otherwise it returns EXACTLY what the old
--       function returned. Mirrors store-api.js pricing._canon (taxInclusive branch).
--
--   Existing quotes never carry taxInclusive, so every existing and re-priced India quote
--   comes to the same rupee as before. Additive + idempotent: no table, column or row is
--   created, changed or deleted. Pure calculation - reads no table, so it cannot cross
--   tenants; it runs inside the per-quote pricing trigger that is already org-scoped.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then
    raise exception '0079: helm_quote_total(jsonb) is not installed (apply 0001 + 0026 first)';
  end if;
  if to_regprocedure('public.helm_quote_total__pretax(jsonb)') is null then
    alter function public.helm_quote_total(jsonb) rename to helm_quote_total__pretax;
  end if;
end $$;

revoke all on function public.helm_quote_total__pretax(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total__pretax(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.helm_quote_total__pretax(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total__pretax(jsonb) to service_role;
  end if;
end $$;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable security definer set search_path = '' as $$
-- country-tax-0079: taxInclusive -> price at gstPct 0, else unchanged
begin
  if p is not null and jsonb_typeof(p) = 'object'
     and lower(coalesce(p ->> 'taxInclusive', '')) = 'true' then
    return public.helm_quote_total__pretax(p || jsonb_build_object('gstPct', 0));
  end if;
  return public.helm_quote_total__pretax(p);
end $$;

revoke all on function public.helm_quote_total(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.helm_quote_total(jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.helm_quote_total(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.helm_quote_total(jsonb) to service_role;
  end if;
end $$;

-- =====================================================================================
-- VERIFY (expect 6 rows, ALL ok = true)
-- =====================================================================================
select item, ok from (values
  ('01 wrapper + kept base exist', (to_regprocedure('public.helm_quote_total(jsonb)') is not null and to_regprocedure('public.helm_quote_total__pretax(jsonb)') is not null)),
  ('02 wrapper is the 0079 body, definer, search_path empty', (coalesce((select p.prosecdef and 'search_path=""' = any(p.proconfig) and p.prosrc like '%country-tax-0079%' from pg_proc p where p.oid = to_regprocedure('public.helm_quote_total(jsonb)')), false))),
  ('03 exclusive total unchanged (5000 + 18 pct = 5900)', (public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500}'::jsonb) = 5900)),
  ('04 inclusive total = post-discount value (5000)', (public.helm_quote_total('{"gstPct":18,"chairs":10,"chairPrice":500,"taxInclusive":true}'::jsonb) = 5000)),
  ('05 legacy subtotal shape unchanged (1180)', (public.helm_quote_total('{"subtotal":1000}'::jsonb) = 1180)),
  ('06 authenticated yes, anon no', (coalesce(has_function_privilege('authenticated', 'public.helm_quote_total(jsonb)', 'execute') and not has_function_privilege('anon', 'public.helm_quote_total(jsonb)', 'execute'), false)))
) v(item, ok)
order by item;
