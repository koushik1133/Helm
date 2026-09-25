-- ============================================================================
-- WAVE-06-UPGRADE.sql  — MUTATES FUNCTIONS + adds a trigger. SOURCE PREPARED.
-- ----------------------------------------------------------------------------
-- MONEY-02 / D8: make the SERVER authoritative for the quote total. The browser
-- total becomes advisory — the database recomputes `pricing.total` from the
-- stored components (subtotal, discount, gstPct) on EVERY write to quotes.pricing
-- (save_quotation_version, confirm, or a direct PostgREST PATCH), so a tampered
-- client total can never be stored or charged.
--
-- Canonical formula mirrors the JS pricing._canon (Wave 6 locked decisions):
--   taxed = max(0, subtotal - min(discount, subtotal))     (D1 GST post-discount)
--   total = round( taxed * (1 + gstPct/100) )              (D5 single rate, D7 round)
--
-- SAFETY: additive & idempotent (CREATE OR REPLACE; DROP TRIGGER IF EXISTS then
-- CREATE). No table drops, no TRUNCATE, no data rewrite (existing rows are NOT
-- touched unless you run the optional backfill at the bottom). Preserves all
-- Wave-5 hardening on save_quotation_version (can_edit, assert_quote_org,
-- org-scope, anon revoke). Run WAVE-06-PREFLIGHT.sql first; VERIFY after.
--
-- Limitation (documented): the server recomputes total from subtotal/discount/
-- gstPct — the values the UI shows. It does NOT yet re-derive `subtotal` from raw
-- placed line items (those are not stored server-side in structured form); that is
-- a later schema change. This closes the direct "edit the total" tamper and
-- guarantees total is always internally consistent with its components.
-- ============================================================================

begin;

-- 1) Canonical server-side total (immutable; mirror of JS pricing._canon) -----
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
declare sub numeric; disc numeric; gp numeric; taxed numeric;
begin
  -- No components → nothing to recompute (legacy/edge quotes keep their total).
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? 'subtotal') then
    return coalesce((p->>'total')::numeric, 0);
  end if;
  sub  := coalesce((p->>'subtotal')::numeric, 0);
  disc := coalesce((p->>'discount')::numeric, 0);
  gp   := coalesce((p->>'gstPct')::numeric, 18);
  if sub < 0 or disc < 0 or gp < 0 then
    raise exception 'pricing components cannot be negative (subtotal=%, discount=%, gstPct=%)',
      sub, disc, gp using errcode='22003';
  end if;
  disc  := least(disc, sub);                 -- discount capped at subtotal
  taxed := greatest(0, sub - disc);          -- D1: GST base = post-discount
  return round(taxed * (1 + gp/100));        -- D5 single rate, D7 round final
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- 2) Trigger: recompute total on every write to quotes.pricing ----------------
create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object' and (new.pricing ? 'subtotal') then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;

drop trigger if exists quotes_enforce_pricing_total on public.quotes;
create trigger quotes_enforce_pricing_total
  before insert or update of pricing on public.quotes
  for each row execute function public.enforce_pricing_total();

-- 3) save_quotation_version stores the SERVER total, not the client's ----------
--    (identical to phase77 except tot := helm_quote_total(...) and the snapshot
--     pricing.total is normalised before it is written.)
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);                       -- server-authoritative
  if p_pricing is not null and (p_pricing ? 'subtotal') then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));
  end if;
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $sv$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ---------------------------------------------------------------------------
-- OPTIONAL BACKFILL (review first; touches stored money values). Realigns any
-- existing quote whose stored total drifts from the canonical recompute. NOT run
-- by this file. Preview, then apply.
--
-- -- preview:
-- select id, (pricing->>'total') as stored, public.helm_quote_total(pricing) as recomputed
--   from public.quotes
--  where pricing ? 'subtotal'
--    and (pricing->>'total')::numeric is distinct from public.helm_quote_total(pricing);
-- -- apply:
-- update public.quotes
--    set pricing = jsonb_set(pricing,'{total}', to_jsonb(public.helm_quote_total(pricing))),
--        updated_at = now()
--  where pricing ? 'subtotal'
--    and (pricing->>'total')::numeric is distinct from public.helm_quote_total(pricing);
-- ---------------------------------------------------------------------------
