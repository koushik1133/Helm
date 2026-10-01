-- ============================================================================
-- 0001_pricing_authority.sql — CANONICAL forward-only migration (W15-001 fix).
-- Reuses the STAGING-verified wave15b logic (W15B-01 + W15B-06), now wired into
-- the deterministic canonical path so a clean deploy is hardened by default.
-- Idempotent (CREATE OR REPLACE). Forward-only. Preserves all data.
--
-- CLOSES: phase99 helm_quote_total() trusted the client `total` whenever the
-- pricing payload had no TOP-LEVEL `subtotal` — the real UI payload shape. A
-- can_edit() staffer could store total=1 on any quote (SOURCE+behaviorally proven
-- FAIL-before on PG17 2026-10-01).
--
-- FIX (fail-closed): server recomputes the total from the canonical RAW INPUTS
-- the UI sends; a precomputed top-level subtotal uses the legacy path; ANY payload
-- that carries a `total` but no computable shape is REJECTED (errcode 22023). The
-- client-supplied `total`/`computed` are NEVER trusted. A BEFORE trigger also
-- overwrites quotes.pricing.total with the server value on every write.
-- Atomicity is provided by the runner (psql -1 / one txn per file).
-- ============================================================================

-- (1) canonical total from raw inputs — mirrors store-api.js _canon/quoteTotal
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
  if chairs<0 or chair_price<0 or guests<0 or plate_price<0 or other<0
     or svc_pct<0 or disc_fixed<0 or disc_pct<0 or gp<0 then
    raise exception 'pricing components cannot be negative' using errcode='22003';
  end if;
  service_charge := pre_svc * svc_pct / 100;
  subtotal       := pre_svc + service_charge;
  discount := disc_fixed + subtotal * disc_pct / 100;
  coupon := p->'coupon';
  if coupon is not null and jsonb_typeof(coupon)='object' and (coupon ? 'value') then
    c_kind := coupon->>'kind'; c_val := coalesce((coupon->>'value')::numeric, 0);
    if c_kind = 'percent' then discount := discount + subtotal * c_val / 100;
    else discount := discount + c_val; end if;
  end if;
  discount := least(greatest(0, discount), subtotal);
  taxed := greatest(0, subtotal - discount);
  gst   := taxed * gp / 100;
  return round(taxed + gst);
end $fn$;
revoke all on function public.helm_quote_total_canonical(jsonb) from anon;
grant execute on function public.helm_quote_total_canonical(jsonb) to authenticated;

-- (2) authoritative helm_quote_total — fail-closed (W15B-06)
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 0; end if;
  if (p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice') then
    return public.helm_quote_total_canonical(p);
  end if;
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
  if p ? 'total' then
    raise exception 'a pricing total without a computable shape (gstPct+items or subtotal) is not accepted' using errcode='22023';
  end if;
  return 0;
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- (3) defense-in-depth: stamp the server total on every quotes write
create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object'
     and ( (new.pricing ? 'gstPct' and (new.pricing ? 'chairs' or new.pricing ? 'guests'
            or new.pricing ? 'other' or new.pricing ? 'catering' or new.pricing ? 'platePrice'))
           or (new.pricing ? 'subtotal') or (new.pricing ? 'total') ) then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;
drop trigger if exists zz_enforce_pricing_total on public.quotes;
create trigger zz_enforce_pricing_total before insert or update of pricing on public.quotes
  for each row execute function public.enforce_pricing_total();

-- ---- VERIFY (expect: tampered total rejected / recomputed; never trusts client) --
-- select public.helm_quote_total('{"gstPct":18,"chairs":100,"chairPrice":500,"guests":200,"platePrice":800,"total":1}') ; -- recomputes, ignores 1
-- select public.helm_quote_total('{"computed":{},"total":1}') ;  -- RAISES 22023
-- ---- ROLLBACK: restore phase99 body from supabase/phase99-server-pricing-authority.sql
