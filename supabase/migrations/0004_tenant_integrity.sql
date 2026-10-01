-- ============================================================================
-- 0004_tenant_integrity.sql — CANONICAL forward-only (SEC-05 F2 + SEC-07 G4).
-- Closes cross-tenant proposal/portal leakage (F2) and forged-org row planting (G4).
-- Behaviorally FAIL-before confirmed on PG17: org-B staff set org_id=B on a proposal
-- pointing at org-A's quote (tg_org_from_quote fills only when null), the row
-- inserted, and public_get_portal on A's token leaked B's "concept".
-- FIX:
--   F2 — public_get_portal/public_get_proposal only surface a proposal/quote whose
--        org_id matches (same tenant); a cross-org proposal is invisible.
--   G4 — a BEFORE INSERT/UPDATE reject trigger (zz_quote_org_match) on every public
--        base table carrying both quote_id and org_id asserts the row's org_id equals
--        the parent quote's org_id (audit_log/lead_archive are allow-dangling). This
--        blocks the plant at write time, under RLS or via a DEFINER RPC.
-- Idempotent. Forward-only.
-- ============================================================================

-- ---- G4: shared reject trigger function ------------------------------------
-- SECURITY DEFINER is REQUIRED: the guard must read the parent quote's true org
-- regardless of the caller's RLS view. Without it, an attacker in org B cannot see
-- org A's quote row, v_org resolves NULL, and the check silently skips (proven on
-- PG17: as org-B staff the plant succeeded until this was made definer).
create or replace function public.tg_quote_org_match() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_org uuid;
begin
  if new.quote_id is null then return new; end if;
  select org_id into v_org from public.quotes where id = new.quote_id;
  if v_org is not null and new.org_id is distinct from v_org then
    raise exception 'quote % belongs to another studio (row org % <> quote org %)',
      new.quote_id, new.org_id, v_org using errcode = '42501';
  end if;
  return new;
end $fn$;

-- install on every public base table with quote_id + org_id (except audit/archive)
do $$ declare r record; begin
  for r in
    select c.table_name from information_schema.columns c
      join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
      join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id'
      and c.table_name not in ('quotes','audit_log','lead_archive')
    order by 1
  loop
    execute format('drop trigger if exists zz_quote_org_match on public.%I', r.table_name);
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', r.table_name);
  end loop;
end $$;

-- F2: public_get_portal — only same-tenant proposal is surfaced
CREATE OR REPLACE FUNCTION public.public_get_portal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id and org_id = q.org_id;
  select jsonb_build_object('name', o.name, 'brand', o.brand) into studio
    from public.organizations o where o.id = q.org_id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'studio', studio,
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $function$

;
-- F2: public_get_proposal — resolve the quote only within the proposal's org
CREATE OR REPLACE FUNCTION public.public_get_proposal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id and org_id = pr.org_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $function$

;
