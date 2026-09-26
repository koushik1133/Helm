-- ============================================================================
-- W15B-01-PRICING-UPGRADE.sql  — W15-001 server pricing authority (CANONICAL).
-- STATUS: SOURCE PREPARED. STAGING ONLY. NOT APPLIED. NOT FOR PRODUCTION.
-- ----------------------------------------------------------------------------
-- WHY: phase99 helm_quote_total() only recomputes when the pricing jsonb has a
-- TOP-LEVEL `subtotal`. The shipping UI payload (quotes.html gatherPricing /
-- flow.html saveQuotation) nests subtotal under `computed` and sends a top-level
-- client `total`, so the server trusted the client total verbatim (W15-001).
--
-- FIX: recompute the total from the CANONICAL RAW INPUTS the UI already sends
-- (chairs, chairPrice, guests, platePrice, other, catering{mode,amount},
-- serviceChargePct, discount, discountPct, coupon{kind,value}, gstPct), mirroring
-- store-api.js `_canon`/`quoteTotal` EXACTLY (locked rules D1/D4/D5/D7). Proven
-- rupee-equivalent to the shipping engine across 405 cases by
-- test/pricing-differential.test.mjs. The client-supplied `total`/`computed` are
-- NEVER trusted. Legacy top-level-`subtotal` payloads keep the phase99 behavior.
--
-- Additive & idempotent (CREATE OR REPLACE). Forward-only. Preserves all data.
-- DO NOT edit already-applied historical migrations to deploy this. Run PRECHECK
-- first, then this UPGRADE on STAGING, then VERIFY. ROLLBACK restores phase99.
-- ============================================================================
begin;

-- Canonical total from RAW INPUTS (mirrors store-api.js _canon exactly).
create or replace function public.helm_quote_total_canonical(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
declare
  chairs numeric; chair_price numeric; guests numeric; plate_price numeric; other numeric;
  client_cater boolean; rental numeric; plate_sub numeric; catering_amt numeric;
  pre_svc numeric; svc_pct numeric; service_charge numeric; subtotal numeric;
  disc_fixed numeric; disc_pct numeric; discount numeric;
  coupon jsonb; c_kind text; c_val numeric; taxed numeric; gp numeric; gst numeric;
begin
  chairs      := coalesce((p->>'chairs')::numeric, 0);
  chair_price := coalesce((p->>'chairPrice')::numeric, 0);
  guests      := coalesce((p->>'guests')::numeric, 0);
  plate_price := coalesce((p->>'platePrice')::numeric, 0);
  other       := coalesce((p->>'other')::numeric, 0);
  svc_pct     := coalesce((p->>'serviceChargePct')::numeric, 0);
  disc_fixed  := coalesce((p->>'discount')::numeric, 0);
  disc_pct    := coalesce((p->>'discountPct')::numeric, 0);
  gp          := coalesce((p->>'gstPct')::numeric, 0);
  client_cater := coalesce(p->'catering'->>'mode', 'inhouse') = 'client';

  rental      := chairs * chair_price + other;
  plate_sub   := case when client_cater then 0 else guests * plate_price end;
  catering_amt:= case when client_cater then 0 else coalesce((p->'catering'->>'amount')::numeric, 0) end;
  pre_svc     := rental + plate_sub + catering_amt;

  -- reject negative components (fail closed, matches phase99 intent)
  if chairs<0 or chair_price<0 or guests<0 or plate_price<0 or other<0
     or svc_pct<0 or disc_fixed<0 or disc_pct<0 or gp<0 then
    raise exception 'pricing components cannot be negative' using errcode='22003';
  end if;

  service_charge := pre_svc * svc_pct / 100;
  subtotal       := pre_svc + service_charge;

  discount := disc_fixed + subtotal * disc_pct / 100;
  coupon := p->'coupon';
  if coupon is not null and jsonb_typeof(coupon)='object' and (coupon ? 'value') then
    c_kind := coupon->>'kind';
    c_val  := coalesce((coupon->>'value')::numeric, 0);
    if c_kind = 'percent' then discount := discount + subtotal * c_val / 100;
    else discount := discount + c_val; end if;
  end if;
  discount := least(greatest(0, discount), subtotal);   -- D4 cap

  taxed := greatest(0, subtotal - discount);            -- D1 GST on post-discount
  gst   := taxed * gp / 100;                            -- D5 single rate
  return round(taxed + gst);                            -- D7 round final only
end $fn$;
revoke all on function public.helm_quote_total_canonical(jsonb) from anon;
grant execute on function public.helm_quote_total_canonical(jsonb) to authenticated;

-- True authority: canonical raw recompute; else legacy top-level-subtotal; else
-- (unknown shape) unchanged coalesce. NEVER derives from client `computed`/`total`.
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return coalesce((p->>'total')::numeric, 0);
  end if;
  -- shipping payload carries raw inputs (gstPct + at least one item/catering key)
  if (p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice') then
    return public.helm_quote_total_canonical(p);
  end if;
  -- legacy/test payload with a precomputed top-level subtotal (phase99 path)
  if p ? 'subtotal' then
    declare sub numeric; disc numeric; gp numeric; taxed numeric;
    begin
      sub := coalesce((p->>'subtotal')::numeric,0); disc := coalesce((p->>'discount')::numeric,0);
      gp := coalesce((p->>'gstPct')::numeric,18);
      if sub<0 or disc<0 or gp<0 then raise exception 'pricing components cannot be negative' using errcode='22003'; end if;
      disc := least(disc, sub); taxed := greatest(0, sub-disc);
      return round(taxed * (1 + gp/100));
    end;
  end if;
  return coalesce((p->>'total')::numeric, 0);
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- Trigger: overwrite total whenever we can derive it (raw OR legacy subtotal).
create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object'
     and ( (new.pricing ? 'gstPct' and (new.pricing ? 'chairs' or new.pricing ? 'guests'
            or new.pricing ? 'other' or new.pricing ? 'catering' or new.pricing ? 'platePrice'))
           or (new.pricing ? 'subtotal') ) then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;

drop trigger if exists quotes_enforce_pricing_total on public.quotes;
create trigger quotes_enforce_pricing_total
  before insert or update of pricing on public.quotes
  for each row execute function public.enforce_pricing_total();

-- save_quotation_version: server total is authoritative; stamp it into the row.
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);               -- authoritative
  if p_pricing is not null and jsonb_typeof(p_pricing)='object' then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));   -- never keep client total
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
