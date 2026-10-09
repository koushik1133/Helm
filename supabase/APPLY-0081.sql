-- APPLY-0081.sql - ONE paste. Run on STAGING first, then PROD, after APPLY-0080.
-- Pure ASCII, idempotent (safe to paste twice). Last grid: 5 rows, every ok = true.
-- 0081_booklet_tax_labels.sql - CANONICAL forward-only. Client booklet shows the exact tax label.
--
-- In plain words:
--   0079 lets a studio pick its country, so a quote's saved pricing may carry taxCountry,
--   taxName and taxInclusive (UAE "VAT", a custom name for other countries, "prices
--   include tax"). The public booklet reader (public_get_booklet) only passed currency and
--   the CGST/SGST/IGST amounts, so a custom tax name showed as plain "Tax" and an
--   inclusive quote could only be guessed. This file adds those three keys to the booklet
--   "quote" block - nothing else changes.
--
--   Same rename-and-wrap pattern as 0069/0070/0075:
--     * the current reader is kept, unchanged, as public_get_booklet__pre0081
--     * the new public_get_booklet calls it (token check, rate limit, audit, allow-lists all
--       stay there) and, only when it returned a quote block, adds:
--         taxCountry   - two capital letters only
--         taxName      - letters, digits, space and . / & ( ) - only, at most 24 chars
--         taxInclusive - true only when the saved value is exactly true
--       read from the SAME quote row the token points at (org-scoped join). The studio's
--       private settings (organizations.brand, billing details) are never read.
--
--   Additive + idempotent: no table, column or row is created, changed or deleted.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.public_get_booklet(uuid)') is null then
    raise exception '0081: public_get_booklet(uuid) is not installed (apply 0065 + 0075 first)';
  end if;
  if to_regprocedure('public.public_get_booklet__pre0081(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0081;
  end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-tax-0081: the 0075 reader, then the quote's tax label keys (allow-listed)
declare r jsonb; p jsonb; v_add jsonb := '{}'::jsonb; v_cc text; v_nm text;
begin
  r := public.public_get_booklet__pre0081(p_token);     -- validates token, rate limit, audit, sections
  if r is null or jsonb_typeof(r -> 'quote') <> 'object' then return r; end if;
  select case when jsonb_typeof(q.pricing) = 'object' then q.pricing else '{}'::jsonb end into p
    from public.client_booklets b
    join public.quotes q on q.id = b.quote_id and q.org_id = b.org_id and q.deleted_at is null
   where b.token = p_token;
  if p is null then return r; end if;
  v_cc := upper(coalesce(p ->> 'taxCountry', ''));
  if v_cc ~ '^[A-Z]{2}$' then v_add := v_add || jsonb_build_object('taxCountry', v_cc); end if;
  if jsonb_typeof(p -> 'taxName') = 'string' then
    v_nm := btrim(left(regexp_replace(p ->> 'taxName', '[^A-Za-z0-9 ./&()-]', '', 'g'), 24));
    if v_nm <> '' then v_add := v_add || jsonb_build_object('taxName', v_nm); end if;
  end if;
  if lower(coalesce(p ->> 'taxInclusive', '')) = 'true' then v_add := v_add || jsonb_build_object('taxInclusive', true); end if;
  if v_add = '{}'::jsonb then return r; end if;
  return jsonb_set(r, '{quote}', (r -> 'quote') || v_add);
end $$;

do $$ declare s text; begin
  foreach s in array array['public.public_get_booklet__pre0081(uuid)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.public_get_booklet__pre0081(uuid) to service_role;
  end if;
end $$;

-- VERIFY (expect 5 rows, ALL ok = true)
select item, ok from (values
  ('01 previous booklet reader kept as public_get_booklet__pre0081', to_regprocedure('public.public_get_booklet__pre0081(uuid)') is not null),
  ('02 public_get_booklet carries the 0081 tax keys', position('booklet-tax-0081' in pg_get_functiondef('public.public_get_booklet(uuid)'::regprocedure)) > 0),
  ('03 both functions definer-safe (search_path empty)', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('public_get_booklet', 'public_get_booklet__pre0081')
        and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']))),
  ('04 anon may call the reader but not the inner function', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.public_get_booklet__pre0081(uuid)', 'execute')),
  ('05 authenticated may call the reader, not the inner function', has_function_privilege('authenticated', 'public.public_get_booklet(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.public_get_booklet__pre0081(uuid)', 'execute'))
) v(item, ok)
order by item;
