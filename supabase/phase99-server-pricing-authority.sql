-- ============================================================================
-- phase99-server-pricing-authority.sql  — forward-only migration. SOURCE PREPARED.
-- ----------------------------------------------------------------------------
-- MONEY-02 / D8: the SERVER is authoritative for the quote total. Identical body
-- to supabase/wave6/WAVE-06-UPGRADE.sql (kept as the numbered canonical migration).
-- Additive & idempotent; preserves all Wave-5 hardening. Run PREFLIGHT first.
-- See docs/PRICING-DECISIONS-WAVE6.md for the decision record.
-- ============================================================================
begin;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
declare sub numeric; disc numeric; gp numeric; taxed numeric;
begin
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
  disc  := least(disc, sub);
  taxed := greatest(0, sub - disc);
  return round(taxed * (1 + gp/100));
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

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

create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);
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
