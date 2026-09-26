-- W15B-03-ROLLBACK.sql — compensating restore of the phase99 pricing functions.
-- Run on STAGING only if the UPGRADE must be reverted. Restores the exact phase99
-- behavior (top-level-subtotal recompute; client total trusted otherwise — i.e.
-- reintroduces W15-001). Additive/idempotent. Drops the new canonical helper.
-- STAGING ONLY. NOT FOR PRODUCTION.
begin;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
declare sub numeric; disc numeric; gp numeric; taxed numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? 'subtotal') then
    return coalesce((p->>'total')::numeric, 0);
  end if;
  sub := coalesce((p->>'subtotal')::numeric, 0);
  disc := coalesce((p->>'discount')::numeric, 0);
  gp := coalesce((p->>'gstPct')::numeric, 18);
  if sub < 0 or disc < 0 or gp < 0 then
    raise exception 'pricing components cannot be negative' using errcode='22003';
  end if;
  disc := least(disc, sub); taxed := greatest(0, sub - disc);
  return round(taxed * (1 + gp/100));
end $fn$;

create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object' and (new.pricing ? 'subtotal') then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;

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

drop function if exists public.helm_quote_total_canonical(jsonb);
notify pgrst, 'reload schema';
commit;
