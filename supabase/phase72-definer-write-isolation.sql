-- ============================================================================
-- Phase 72 — Tenant isolation: by-id WRITE vectors in SECURITY DEFINER funcs
-- ---------------------------------------------------------------------------
-- Continues phase71. These functions mutate tenant rows by a passed id/quote
-- with only a role gate — a caller in org B who guesses an org-A uuid could
-- write/delete org-A data (definer bypasses RLS). Each now verifies the row /
-- parent quote belongs to the caller's org. apply_menu_template additionally
-- guarded because it DELETES event_menu_items by quote_id.
-- Idempotent. Run AFTER phase55, phase62, phase71.
-- ============================================================================

-- helper: assert a quote belongs to the caller's org (raises otherwise) -------
create or replace function public.assert_quote_org(p_quote uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.quotes where id = p_quote and org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode='42501';
  end if;
end; $$;
grant execute on function public.assert_quote_org(uuid) to authenticated;

-- 1) verify_task — by-id write ------------------------------------------------
create or replace function public.verify_task(p_id uuid, p_pass boolean, p_note text default null)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not (public.user_role() in ('admin','manager','planner','quality')) then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
  end if;
  update public.event_tasks set
    verify_status = case when p_pass then 'passed' else 'rejected' end,
    verified_by   = auth.uid(),
    verified_at   = now(),
    verify_note   = nullif(btrim(coalesce(p_note,'')),''),
    status        = case when p_pass then status else 'in_progress' end,
    completed_at  = case when p_pass then completed_at else null end
  where id = p_id and org_id = public.current_org_id()           -- << org isolation
  returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
grant execute on function public.verify_task(uuid,boolean,text) to authenticated;

-- 2) assign_tasks — creates tasks/tokens for a quote --------------------------
create or replace function public.assign_tasks(
  p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; tok uuid; t text; n int := 0; s int;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id and org_id = public.current_org_id();  -- << org isolation
  if q.id is null then raise exception 'no such event'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'valid worker phone required'; end if;
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,p_phone,p_name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t and org_id=public.current_org_id();
    insert into public.event_tasks(quote_id,category,title,seq,crew_id,assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),p_crew_id,p_name,p_phone,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',p_phone,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok));
  return jsonb_build_object('work_token',tok,'tasks_created',n);
end; $$;
grant execute on function public.assign_tasks(uuid,text,text[],uuid,text,text) to authenticated;

-- 3) reassign_task — by-id write ----------------------------------------------
create or replace function public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare qt uuid; tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into qt from public.event_tasks where id=p_task_id and org_id=public.current_org_id();  -- << org isolation
  if qt is null then raise exception 'no such task'; end if;
  select token into tok from public.work_tokens where quote_id=qt and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,qt,p_phone,p_name); end if;
  update public.event_tasks set crew_id=p_crew_id, assignee_name=p_name, assignee_phone=p_phone,
    status='assigned', responded_at=null, started_at=null, completed_at=null where id=p_task_id;
  perform public._notify(qt,'sms',p_phone,'task_assigned', jsonb_build_object('reassigned',true,'token',tok));
  return jsonb_build_object('work_token',tok);
end; $$;
grant execute on function public.reassign_task(uuid,uuid,text,text) to authenticated;

-- 4) event menu dish RPCs — read/write by quote/id ----------------------------
create or replace function public.add_event_dish(p_quote uuid, p_dish uuid)
returns public.event_menu_items language plpgsql security definer set search_path = public as $$
declare d public.dish_catalog; locked boolean; nextseq int; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);                       -- << org isolation
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change dishes'; end if;
  select * into d from public.dish_catalog where id = p_dish and org_id = public.current_org_id();
  if d.id is null then raise exception 'no such dish'; end if;
  select coalesce(max(seq),0)+1 into nextseq from public.event_menu_items where quote_id = p_quote;
  insert into public.event_menu_items(quote_id,dish_id,dish_name,category,kind,seq)
    values (p_quote, d.id, d.name, d.category, d.kind, nextseq)
  returning * into row;
  return row;
end; $$;
grant execute on function public.add_event_dish(uuid,uuid) to authenticated;

create or replace function public.remove_event_dish(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q uuid; locked boolean;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id and org_id = public.current_org_id();
  if q is null then return; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  delete from public.event_menu_items where id = p_id and org_id = public.current_org_id();
end; $$;
grant execute on function public.remove_event_dish(uuid) to authenticated;

create or replace function public.set_event_dish_qty(p_id uuid, p_qty numeric)
returns public.event_menu_items language plpgsql security definer set search_path = public as $$
declare q uuid; locked boolean; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id and org_id = public.current_org_id();
  if q is null then raise exception 'no such menu item'; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'quantity cannot be negative'; end if;
  update public.event_menu_items set qty = p_qty where id = p_id and org_id = public.current_org_id() returning * into row;
  return row;
end; $$;
grant execute on function public.set_event_dish_qty(uuid,numeric) to authenticated;

-- 5) apply_menu_template — DELETES menu rows by quote; guard the quote org ----
create or replace function public.apply_menu_template(p_quote uuid, p_template uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.menu_templates; locked boolean; d jsonb; i int := 0;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);                       -- << org isolation (guards the delete below)
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change the package'; end if;
  select * into t from public.menu_templates where id = p_template and org_id = public.current_org_id();
  if t.id is null then raise exception 'no such package'; end if;

  delete from public.event_menu_items where quote_id = p_quote and org_id = public.current_org_id();
  for d in select * from jsonb_array_elements(t.dishes) loop
    i := i + 1;
    insert into public.event_menu_items(quote_id, dish_id, dish_name, category, kind, seq)
    values (
      p_quote,
      (select dc.id from public.dish_catalog dc where dc.org_id = public.current_org_id() and dc.name = (d->>'n') limit 1),
      d->>'n', d->>'c', coalesce(d->>'k','veg'), i);
  end loop;

  update public.event_plan
     set package = t.name, menu_template = t.name, menu_plate_price = t.price_per_plate
   where quote_id = p_quote;
  if not found then
    insert into public.event_plan(quote_id, package, menu_template, menu_plate_price)
    values (p_quote, t.name, t.name, t.price_per_plate);
  end if;
end; $$;
grant execute on function public.apply_menu_template(uuid,uuid) to authenticated;

notify pgrst, 'reload schema';

select 'phase72' t, 'task/menu by-id write vectors org-scoped' note;
