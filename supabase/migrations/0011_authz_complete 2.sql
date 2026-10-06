-- ============================================================================
-- 0011_authz_complete.sql — CANONICAL forward-only. Completes matrix-aware
-- authorization (SEC-05 F10) on remaining org-mutating RPCs and closes two
-- previously UNGUARDED mutating RPCs. DB/RPC authorization is authoritative; the
-- client ROLE_CAPS is not. Idempotent (CREATE OR REPLACE). Forward-only.
-- ============================================================================
-- save_quotation_version
CREATE OR REPLACE FUNCTION public.save_quotation_version(p_quote uuid, p_pricing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
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
end $function$

;
-- set_discovery
CREATE OR REPLACE FUNCTION public.set_discovery(p_quote_id uuid, p_meet_date date, p_mode text, p_location text, p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric)
 RETURNS event_discovery
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('discovery','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_discovery
    (quote_id, meet_date, mode, location, attendees, notes, budget_min, budget_max, updated_at, updated_by)
  values
    (p_quote_id, p_meet_date, p_mode, p_location, p_attendees, p_notes, p_budget_min, p_budget_max, now(), auth.uid())
  on conflict (quote_id) do update set
    meet_date=excluded.meet_date, mode=excluded.mode, location=excluded.location,
    attendees=excluded.attendees, notes=excluded.notes,
    budget_min=excluded.budget_min, budget_max=excluded.budget_max,
    updated_at=now(), updated_by=auth.uid()
  returning * into d;
  return d;
end; $function$

;
-- set_event_plan
CREATE OR REPLACE FUNCTION public.set_event_plan(p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text, p_access_notes text, p_package text, p_menu text)
 RETURNS event_plan
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('plan','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $function$

;
-- set_proposal
CREATE OR REPLACE FUNCTION public.set_proposal(p_quote_id uuid, p_concept text, p_theme text, p_palette jsonb, p_images jsonb, p_scope jsonb)
 RETURNS event_proposal
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  if not (public.has_area('quotes','edit') or public.has_area('proposal','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $function$

;
-- create_quote (was NONE)
CREATE OR REPLACE FUNCTION public.create_quote(p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count integer, p_event_date date DEFAULT NULL::date)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
  v_stamp text := to_char(coalesce(p_event_date, now()), 'MMDDYYYY');
  v_next int; v_code text; v_try int := 0;
begin
  if not (public.has_area('quotes','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, event_date)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1, p_event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $function$

;
-- convert_lead_to_quote (was NONE)
CREATE OR REPLACE FUNCTION public.convert_lead_to_quote(p_lead_id uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  l public.leads; q public.quotes;
  v_stamp text; v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not (public.has_area('quotes','edit') or public.has_area('leads','edit')) then raise exception 'not authorized' using errcode='42501'; end if;  -- 0011 F10
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id and org_id = public.current_org_id();
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id and org_id = public.current_org_id(); return q; end if;
  v_stamp := to_char(coalesce(l.event_date, now()), 'MMDDYYYY');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
        values (v_code, v_title, l.event_type, 1,
                jsonb_strip_nulls(jsonb_build_object(
                  'name', l.name, 'phone', l.phone, 'email', l.email,
                  'guests', l.guest_count, 'budget', l.budget,
                  'eventDate', to_char(l.event_date, 'YYYY-MM-DD'), 'source', l.source)),
                'discovery', l.event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now()
    where id = p_lead_id and org_id = public.current_org_id();
  return q;
end; $function$

;
