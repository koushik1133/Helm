-- ============================================================================
-- W15B-06-PRICING-HARDEN.sql — close the residual W15-001 bypass.
-- STATUS: SOURCE PREPARED. STAGING ONLY. NOT FOR PRODUCTION (until reviewed).
-- ----------------------------------------------------------------------------
-- Gap (runtime-confirmed): a pricing jsonb carrying a top-level `total` but NO
-- derivable shape (no gstPct+item/catering key, no top-level `subtotal`) fell
-- through to `coalesce(p->>'total')`, so an authenticated caller could persist an
-- arbitrary total by omitting gstPct. Fix: reject a client `total` that has no
-- computable shape, and make the trigger engage for that case too. Additive/idempotent.
-- ============================================================================
begin;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 0;
  end if;
  -- shipping payload carries raw inputs
  if (p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice') then
    return public.helm_quote_total_canonical(p);
  end if;
  -- legacy/test payload with a precomputed top-level subtotal
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
  -- unknown shape: a client-supplied total here cannot be trusted -> reject.
  if p ? 'total' then
    raise exception 'a pricing total without a computable shape (gstPct+items or subtotal) is not accepted' using errcode='22023';
  end if;
  return 0;
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- Trigger also engages when only a client `total` is present, so a direct
-- quotes.pricing write can't smuggle it past (helm_quote_total will reject).
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

notify pgrst, 'reload schema';
commit;
