-- ============================================================================
-- Phase 93 — Show pricing on the client-facing proposal (Cluster C)
-- ---------------------------------------------------------------------------
-- public_get_proposal() returned concept/scope/event info but NOT the price, so
-- the shared proposal showed no total/breakdown. This re-creates it (additive)
-- to also return the linked quote's pricing (the same data the approval page
-- already exposes to the client) plus a convenience `total`. Token-scoped and
-- published-only, exactly as before — no new access surface. Idempotent.
-- ============================================================================
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $$;
grant execute on function public.public_get_proposal(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
select 'phase93 proposal-pricing' t, 'ready' s;
