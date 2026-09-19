-- ============================================================================
-- Phase 52 — Live event-day mobile view for crew
-- ---------------------------------------------------------------------------
-- Enhances the token-scoped crew page (work.html):
--   • worker_get_tasks now returns the event date/time (for the day header)
--   • worker_get_equipment  — kit currently checked out to this crew for this event
--   • worker_checkin_equipment — the crew records what they've returned (no write-off;
--     the office decides losses). All token-scoped, no login, safe for anon.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1) add event date/time to the worker task payload ---------------------------
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_date',q.event_date,'event_time',q.event_time),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone),
    'tasks', tasks);
end; $$;

-- 2) equipment currently out to this crew, for this event --------------------
create or replace function public.worker_get_equipment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; items jsonb; digits text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', i.name, 'unit', i.unit,
           'qty_out', c.qty_out, 'qty_in', c.qty_in, 'status', c.status
         ) order by i.name), '[]'::jsonb) into items
    from public.inventory_checkouts c
    join public.inventory_items i on i.id = c.item_id
    join public.crew_members cm on cm.id = c.issued_to_id
   where c.quote_id = w.quote_id
     and c.status in ('out','partial')
     and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits;
  return jsonb_build_object('equipment', items);
end; $$;

-- 3) crew records what they've returned (check-in) ---------------------------
create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into row from public.inventory_checkouts where id = p_id;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  -- confirm this checkout was issued to the crew behind this token (phone match)
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $$;

grant execute on function public.worker_get_equipment(uuid)              to anon, authenticated;
grant execute on function public.worker_checkin_equipment(uuid,uuid,numeric) to anon, authenticated;

notify pgrst, 'reload schema';

-- verify
select 'worker_get_tasks','ok' union all select 'worker_get_equipment','ok' union all select 'worker_checkin_equipment','ok';
