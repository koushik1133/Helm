-- ============================================================================
-- WAVE-06-ROLLBACK.sql  — reverts WAVE-06-UPGRADE.sql (D8 server authority).
-- Drops the enforcement trigger + helper and restores save_quotation_version to
-- its phase77 body (client total trusted). Does NOT rewrite any stored data.
-- Only run if you must back the change out. Idempotent.
-- ============================================================================
begin;

drop trigger if exists quotes_enforce_pricing_total on public.quotes;
drop function if exists public.enforce_pricing_total();

-- Restore phase77 save_quotation_version verbatim (pre-D8).
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  tot := coalesce((p_pricing->>'total')::numeric, 0);
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $sv$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

-- helm_quote_total is harmless to keep, but drop it for a clean revert:
drop function if exists public.helm_quote_total(jsonb);

notify pgrst, 'reload schema';
commit;
