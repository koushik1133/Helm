-- ============================================================================
-- Phase 71 — Tenant isolation: SECURITY DEFINER functions must re-apply org
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER functions run as the owner and BYPASS Row-Level Security,
-- so any that read/write tenant tables must filter by org_id themselves. An
-- audit found several that did not (same class as the bell_feed leak in
-- phase70). This patches the confirmed cross-org READ leaks (return other orgs'
-- data with no guessed id) plus the simple by-id writers. Each adds
-- `org_id = public.current_org_id()`; a cross-org id now returns 0 rows / no-op.
-- Idempotent. Run AFTER phase57 (and phase70).  [by-id write hardening for the
-- remaining task/quote setters continues in phase72]
-- ============================================================================

-- 1) nurture_due — was returning EVERY org's client name/email/phone ----------
create or replace function public.nurture_due(p_within_days int default 30)
  returns table(
    id uuid, name text, email text, phone text, occasion text, occasion_type text,
    occasion_date date, next_date date, years int, auto_on boolean,
    greeted_this_year boolean, quote_id uuid, last_event text
  ) language sql stable security definer set search_path = public as $$
  select n.id, n.name, n.email, n.phone, n.occasion, coalesce(n.occasion_type,'custom'),
         n.occasion_date,
         public._next_occasion(n.occasion_date) as next_date,
         (extract(year from public._next_occasion(n.occasion_date))::int
            - extract(year from n.occasion_date)::int) as years,
         n.auto_on,
         coalesce(n.last_greeted > current_date - interval '335 days', false) as greeted_this_year,
         n.quote_id,
         (select q.title from public.quotes q where q.id = n.quote_id) as last_event
  from public.nurture n
  where public.has_area('nurture','view')
    and n.org_id = public.current_org_id()                       -- << org isolation
    and n.occasion_date is not null
    and public._next_occasion(n.occasion_date) <= current_date + (greatest(p_within_days,0) || ' days')::interval
  order by public._next_occasion(n.occasion_date);
$$;
grant execute on function public.nurture_due(int) to authenticated;

-- 2) queue_nurture_greeting — was readable/sendable by a foreign nurture id ----
create or replace function public.queue_nurture_greeting(p_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text := 'Blueprint Stage';
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id and org_id = public.current_org_id();  -- << org isolation
  if not found then raise exception 'contact not found'; end if;

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot and org_id = public.current_org_id();
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom' and org_id = public.current_org_id(); end if;

  v_years := coalesce(extract(year from public._next_occasion(n.occasion_date))::int
                      - extract(year from n.occasion_date)::int, 0);
  select q.title into v_last from public.quotes q where q.id = n.quote_id;
  v_last := coalesce(v_last, 'your event with us');
  select array_agg(url order by seq, created_at) into v_photos
    from (select url, seq, created_at from public.event_media
          where quote_id = n.quote_id and in_gallery = true order by seq, created_at limit 3) m;

  v_subject := replace(replace(replace(replace(replace(coalesce(tpl.subject,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);
  v_body := replace(replace(replace(replace(replace(coalesce(tpl.body,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);

  v_detail := jsonb_build_object(
    'subject', v_subject, 'body', v_body,
    'photos', to_jsonb(coalesce(v_photos, array[]::text[])),
    'occasion_type', ot, 'contact', n.name, 'auto', n.auto_on);

  perform public._notify(n.quote_id, 'email', n.email, 'nurture_'||ot, v_detail);
  update public.nurture set last_greeted = current_date where id = p_id and org_id = public.current_org_id();
  return v_detail;
end; $$;
grant execute on function public.queue_nurture_greeting(uuid) to authenticated;

-- 3) run_task_triggers — was scanning EVERY org's tasks (assignee phones) ------
create or replace function public.run_task_triggers(p_quote uuid default null)
  returns int language plpgsql security definer set search_path = public as $$
declare t record; dep public.event_tasks; cnt int := 0; ok boolean;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where org_id = public.current_org_id()                       -- << org isolation
      and (p_quote is null or quote_id = p_quote)
      and status in ('assigned','accepted')
      and planned_start is not null and planned_start <= now()
      and triggered_at is null
  loop
    ok := true;
    if t.depends_on is not null then
      select * into dep from public.event_tasks where id = t.depends_on and org_id = public.current_org_id();
      ok := found and dep.status = 'completed' and dep.verify_status = 'passed';
    end if;
    if ok then
      perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_due',
        jsonb_build_object('task', t.title, 'category', t.category));
      update public.event_tasks set triggered_at = now() where id = t.id;
      cnt := cnt + 1;
    end if;
  end loop;
  return cnt;
end $$;
grant execute on function public.run_task_triggers(uuid) to authenticated;

-- 4) run_task_reminders — was nudging EVERY org's special tasks ----------------
create or replace function public.run_task_reminders(p_quote uuid default null)
  returns int language plpgsql security definer set search_path = public as $$
declare t record; cnt int := 0;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where org_id = public.current_org_id()                       -- << org isolation
      and (p_quote is null or quote_id = p_quote)
      and is_special = true
      and status not in ('completed','cancelled')
      and (last_reminded_at is null
           or last_reminded_at <= now() - make_interval(mins => greatest(remind_every_min,1)))
  loop
    perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_reminder',
      jsonb_build_object('task', t.title, 'category', t.category, 'every_min', t.remind_every_min));
    update public.event_tasks set last_reminded_at = now() where id = t.id;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;
grant execute on function public.run_task_reminders(uuid) to authenticated;

-- 5) task_verify_summary — was counting any org's tasks by quote id -----------
create or replace function public.task_verify_summary(p_quote uuid)
  returns table(total int, completed int, pending int, passed int, rejected int)
  language sql stable security definer set search_path = public as $$
  select count(*)::int,
         count(*) filter (where status = 'completed')::int,
         count(*) filter (where verify_status = 'pending')::int,
         count(*) filter (where verify_status = 'passed')::int,
         count(*) filter (where verify_status = 'rejected')::int
  from public.event_tasks where quote_id = p_quote and org_id = public.current_org_id();  -- << org isolation
$$;
grant execute on function public.task_verify_summary(uuid) to authenticated;

-- 6) set_task_schedule — by-id write, was mutable across orgs -----------------
create or replace function public.set_task_schedule(
  p_id uuid, p_start timestamptz, p_end timestamptz, p_depends uuid)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if p_depends = p_id then raise exception 'a task cannot depend on itself'; end if;
  update public.event_tasks
     set planned_start = p_start,
         planned_end   = coalesce(p_end, planned_end),
         depends_on    = p_depends,
         triggered_at  = null
   where id = p_id and org_id = public.current_org_id()          -- << org isolation
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
grant execute on function public.set_task_schedule(uuid,timestamptz,timestamptz,uuid) to authenticated;

-- 7) set_task_special — by-id write ------------------------------------------
create or replace function public.set_task_special(p_id uuid, p_on boolean, p_every_min int default 5)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  update public.event_tasks
     set is_special = coalesce(p_on,false),
         remind_every_min = greatest(coalesce(p_every_min,5), 1),
         last_reminded_at = case when coalesce(p_on,false) then last_reminded_at else null end
   where id = p_id and org_id = public.current_org_id()          -- << org isolation
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
grant execute on function public.set_task_special(uuid,boolean,int) to authenticated;

-- 8) adjust_inventory_total — by-id write ------------------------------------
create or replace function public.adjust_inventory_total(p_item_id uuid, p_delta numeric)
  returns public.inventory_items language plpgsql security definer set search_path = public as $$
declare row public.inventory_items;
begin
  if not public.can_edit() then raise exception 'not allowed'; end if;
  update public.inventory_items
     set total_qty = greatest(0, coalesce(total_qty,0) + coalesce(p_delta,0))
   where id = p_item_id and org_id = public.current_org_id()     -- << org isolation
   returning * into row;
  if row.id is null then raise exception 'item not found'; end if;
  return row;
end; $$;
grant execute on function public.adjust_inventory_total(uuid, numeric) to authenticated;

notify pgrst, 'reload schema';

select 'phase71' t, 'definer read-leaks + simple by-id writers org-scoped' note;
