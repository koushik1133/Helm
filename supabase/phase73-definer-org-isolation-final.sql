-- ============================================================================
-- Phase 73 — Final tenant-isolation pass: org-scope the remaining SECURITY
-- DEFINER by-id setters (quotes, plan, discovery/proposal, approval, closure,
-- inventory, nurture, vendor-tasks) + the admin-user functions.
-- ---------------------------------------------------------------------------
-- These mutate rows by a caller-supplied id/quote with only a role gate;
-- SECURITY DEFINER bypasses RLS, so a caller who supplied a foreign uuid could
-- read/write another org's data. Each now verifies the row / parent quote /
-- target user belongs to the caller's org (assert_quote_org() from phase72, or
-- an inline org filter). Idempotent. Run AFTER phase57, phase65, phase71, phase72.
-- ============================================================================

-- ---------- QUOTES ----------------------------------------------------------
create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int, p_event_date date default null
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
  v_stamp text := to_char(coalesce(p_event_date, now()), 'MMDDYYYY');
  v_next int; v_code text; v_try int := 0;
begin
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
end; $$;
grant execute on function public.create_quote(text,text,text,jsonb,int,date) to authenticated;

create or replace function public.add_quote_version(
  p_quote_id uuid, p_label text, p_data jsonb, p_object_count int
) returns public.quote_versions language plpgsql security definer set search_path = public as $$
declare v public.quote_versions; nextno int;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  select coalesce(max(version_no),0)+1 into nextno from public.quote_versions where quote_id = p_quote_id;
  insert into public.quote_versions (quote_id, version_no, label, data, object_count, created_by)
    values (p_quote_id, nextno, p_label, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid())
    returning * into v;
  update public.quotes set current_version = nextno, updated_at = now()
    where id = p_quote_id and org_id = public.current_org_id();
  return v;
end; $$;
grant execute on function public.add_quote_version(uuid,text,jsonb,int) to authenticated;

create or replace function public.confirm_quote(
  p_quote_id uuid, p_client jsonb, p_pricing jsonb
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized to confirm' using errcode='42501'; end if;
  update public.quotes
     set status='confirmed', client=coalesce(p_client,client), pricing=coalesce(p_pricing,pricing),
         confirmed_at=now(), confirmed_by=auth.uid(), updated_at=now()
   where id = p_quote_id and org_id = public.current_org_id() returning * into q;
  if not found then raise exception 'no such event' using errcode='42501'; end if;
  return q;
end; $$;
grant execute on function public.confirm_quote(uuid,jsonb,jsonb) to authenticated;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_stage not in ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed')
    then raise exception 'invalid stage: %', p_stage; end if;
  update public.quotes set lifecycle_stage = p_stage, updated_at = now()
    where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'no such event'; end if;
  return jsonb_build_object('stage', p_stage);
end; $$;
grant execute on function public.set_lifecycle_stage(uuid,text) to authenticated;

create or replace function public.rebrand_quote_code(p_quote_id uuid)
  returns text language plpgsql security definer set search_path = public as $$
declare q public.quotes; v_stamp text; v_next int; v_code text; v_try int := 0;
begin
  if not public.has_area('quotes','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'quote not found'; end if;
  if q.event_date is null then return q.code; end if;
  v_stamp := to_char(q.event_date, 'MMDDYYYY');
  if q.code like v_stamp || '-%' then return q.code; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      update public.quotes set code = v_code where id = p_quote_id and org_id = public.current_org_id();
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  return v_code;
end; $$;
grant execute on function public.rebrand_quote_code(uuid) to authenticated;

create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text; v_next int; v_code text; v_title text; v_try int := 0;
begin
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
end; $$;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

-- ---------- PLAN ------------------------------------------------------------
create or replace function public.set_event_plan(
  p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text,
  p_access_notes text, p_package text, p_menu text
) returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;
grant execute on function public.set_event_plan(uuid,text,text,text,text,text,text) to authenticated;

create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, menu_locked, locked_at, locked_by, updated_at, updated_by)
    values (p_quote_id, p_locked, case when p_locked then now() end, case when p_locked then auth.uid() end, now(), auth.uid())
  on conflict (quote_id) do update set
    menu_locked=p_locked, locked_at = case when p_locked then now() else null end,
    locked_by = case when p_locked then auth.uid() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;
grant execute on function public.set_plan_lock(uuid,boolean) to authenticated;

create or replace function public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  if p_field not in ('dry_run','briefing') then raise exception 'unknown sign-off field %', p_field; end if;
  insert into public.event_plan (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  update public.event_plan set
    dry_run_at  = case when p_field='dry_run'  then (case when p_done then now() else null end) else dry_run_at  end,
    briefing_at = case when p_field='briefing' then (case when p_done then now() else null end) else briefing_at end,
    updated_at  = now(), updated_by = auth.uid()
  where quote_id = p_quote_id
  returning * into r;
  return r;
end; $$;
grant execute on function public.set_plan_signoff(uuid,text,boolean) to authenticated;

-- ---------- DISCOVERY / PROPOSAL -------------------------------------------
create or replace function public.set_discovery(
  p_quote_id uuid, p_meet_date date, p_mode text, p_location text,
  p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric
) returns public.event_discovery language plpgsql security definer set search_path = public as $$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
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
end; $$;
grant execute on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) to authenticated;

create or replace function public.set_proposal(
  p_quote_id uuid, p_concept text, p_theme text,
  p_palette jsonb, p_images jsonb, p_scope jsonb
) returns public.event_proposal language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
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
end; $$;
grant execute on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) to authenticated;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  select share_token into tok from public.event_proposal where quote_id = p_quote_id;
  if tok is null and p_published then tok := gen_random_uuid(); end if;
  update public.event_proposal
     set published = p_published, share_token = coalesce(tok, share_token), updated_at = now()
   where quote_id = p_quote_id;
  return tok;
end; $$;
grant execute on function public.publish_proposal(uuid,boolean) to authenticated;

-- ---------- APPROVAL / PAYMENT ---------------------------------------------
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  select approval_token into tok from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if tok is null then tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_status = 'sent', updated_at = now()
      where id = p_quote_id and org_id = public.current_org_id();
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end
      where id = p_quote_id and org_id = public.current_org_id();
  end if;
  return tok;
end; $$;
grant execute on function public.generate_approval_token(uuid) to authenticated;

create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created' and org_id = public.current_org_id();
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $$;
grant execute on function public.mark_paid(uuid,text) to authenticated;

-- ---------- CLOSURE ---------------------------------------------------------
create or replace function public.set_closure(
  p_quote_id uuid, p_rating int, p_feedback text, p_testimonial text, p_media_consent boolean, p_lessons text
) returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_closure (quote_id, client_rating, feedback, testimonial, media_consent, lessons, updated_at, updated_by)
  values (p_quote_id, p_rating, p_feedback, p_testimonial, coalesce(p_media_consent,false), p_lessons, now(), auth.uid())
  on conflict (quote_id) do update set
    client_rating=excluded.client_rating, feedback=excluded.feedback, testimonial=excluded.testimonial,
    media_consent=excluded.media_consent, lessons=excluded.lessons, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;
grant execute on function public.set_closure(uuid,int,text,text,boolean,text) to authenticated;

create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_closure (quote_id, closed_at, updated_by)
    values (p_quote_id, case when p_closed then now() end, auth.uid())
  on conflict (quote_id) do update set
    closed_at = case when p_closed then now() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  update public.quotes set lifecycle_stage = case when p_closed then 'closed' else 'settlement' end, updated_at=now()
   where id = p_quote_id and org_id = public.current_org_id();
  return r;
end; $$;
grant execute on function public.close_event(uuid,boolean) to authenticated;

-- ---------- INVENTORY -------------------------------------------------------
create or replace function public.checkout_equipment(
  p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid, p_note text)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item and org_id = public.current_org_id()) then
    raise exception 'item not found' using errcode='42501'; end if;
  if p_quote is not null then perform public.assert_quote_org(p_quote); end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  if coalesce(btrim(p_issued_to),'') = '' then raise exception 'who is it issued to?'; end if;
  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $$;
grant execute on function public.checkout_equipment(uuid,uuid,numeric,text,uuid,text) to authenticated;

create or replace function public.checkin_equipment(
  p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean default false)
  returns public.inventory_checkouts language plpgsql security definer set search_path = public as $$
declare row public.inventory_checkouts; v_missing numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'checkout not found'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  v_missing := greatest(row.qty_out - coalesce(p_qty_in,0), 0);
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = nullif(btrim(coalesce(p_returned_by,'')),''),
         confirmed_by = auth.uid(),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= row.qty_out then 'returned' else 'partial' end
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if p_writeoff and v_missing > 0 then
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty,0) - v_missing)
     where id = row.item_id and org_id = public.current_org_id();
  end if;
  return row;
end; $$;
grant execute on function public.checkin_equipment(uuid,numeric,text,boolean) to authenticated;

-- ---------- NURTURE ---------------------------------------------------------
create or replace function public.run_nurture_auto(p_within_days int default null)
  returns int language plpgsql security definer set search_path = public as $$
declare a public.nurture_automation; within int; d record; cnt int := 0;
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into a from public.nurture_automation where id = 1 and org_id = public.current_org_id();
  if not coalesce(a.enabled,false) then return 0; end if;
  within := coalesce(p_within_days, a.within_days, 0);
  for d in
    select nd.* from public.nurture_due(within) nd
    join public.nurture_templates t on t.occasion_type = nd.occasion_type and t.org_id = public.current_org_id()
    where nd.auto_on = true and nd.greeted_this_year = false
      and nd.email is not null and t.enabled = true
  loop
    perform public.queue_nurture_greeting(d.id);
    cnt := cnt + 1;
  end loop;
  return cnt;
end; $$;
grant execute on function public.run_nurture_auto(int) to authenticated;

-- ---------- VENDOR TASK SOURCING -------------------------------------------
create or replace function public.assign_tasks_vendor(
  p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; v public.vendors; tok uuid; t text; n int := 0; s int; ph text;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes  where id = p_quote_id and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event'; end if;
  select * into v from public.vendors where id = p_vendor_id and org_id = public.current_org_id();
  if v.id is null then raise exception 'no such vendor'; end if;
  ph := regexp_replace(coalesce(v.phone,''),'[^0-9+]','','g');
  if length(regexp_replace(ph,'[^0-9]','','g')) < 8 then
    raise exception 'This vendor has no phone number — add one in Vendors so the checklist can be sent.';
  end if;
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=ph;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,ph,v.name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t and org_id = public.current_org_id();
    insert into public.event_tasks(quote_id,category,title,seq,assignee_kind,vendor_id,
                                   assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),'outsourced',p_vendor_id,
              v.name,ph,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',ph,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok,
                       'outsourced',true,'vendor',v.name,'checklist',to_jsonb(coalesce(p_titles,'{}'::text[]))));
  return jsonb_build_object('work_token',tok,'tasks_created',n,'vendor',v.name);
end; $$;
grant execute on function public.assign_tasks_vendor(uuid,text,text[],uuid) to authenticated;

-- ---------- ADMIN / IDENTITY (org-scope user management) -------------------
create or replace function public.admin_set_role(p_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_id = auth.uid() and p_role <> 'admin' then
    raise exception 'you cannot remove your own admin role'; end if;
  update public.profiles set role = p_role where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'no such user'; end if;
end; $$;
grant execute on function public.admin_set_role(uuid,text) to authenticated;

create or replace function public.admin_delete_user(p_id uuid)
returns void language plpgsql security definer set search_path = auth, public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_id = auth.uid() then raise exception 'you cannot delete your own account'; end if;
  if not exists (select 1 from public.profiles where id = p_id and org_id = public.current_org_id()) then
    raise exception 'no such user'; end if;   -- only delete users in your own studio
  delete from auth.users where id = p_id;
end; $$;
grant execute on function public.admin_delete_user(uuid) to authenticated;

create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid; v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_email is null or position('@' in p_email) = 0 then raise exception 'invalid email'; end if;
  if length(coalesce(p_password,'')) < 4 then raise exception 'password too short'; end if;

  select id into uid from auth.users where email = lower(p_email);
  if uid is not null then raise exception 'a user with that email already exists'; end if;

  uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    lower(p_email), extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', lower(p_email)),
    'email', uid::text, now(), now(), now()
  );
  -- stamp the new user into the creating admin's org (profiles has no org_id default)
  insert into public.profiles (id, email, role, org_id) values (uid, lower(p_email), p_role, v_org)
    on conflict (id) do update set role = excluded.role, email = excluded.email, org_id = excluded.org_id;
  return uid;
end; $$;
grant execute on function public.admin_create_user(text,text,text) to authenticated;

notify pgrst, 'reload schema';

select 'phase73' t, 'all remaining definer setters org-scoped (quotes/plan/discovery/proposal/approval/closure/inventory/nurture/vendor-tasks/admin)' note;
