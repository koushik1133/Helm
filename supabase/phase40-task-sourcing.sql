-- ============================================================================
-- Phase 40 — Task sourcing: in-house crew OR outsourced vendor
-- ---------------------------------------------------------------------------
-- Adds an in-house / outsource dimension to event tasks. Outsourced tasks are
-- assigned to a vendor (from the vendors directory) and the checklist is sent
-- to that vendor through the same worker-link + notification outbox that crew
-- assignments already use — so a vendor opens work.html?token=… just like crew.
-- Idempotent: safe to run multiple times.
-- ============================================================================

-- 1) columns ------------------------------------------------------------------
alter table public.event_tasks add column if not exists assignee_kind text not null default 'in_house';
alter table public.event_tasks add column if not exists vendor_id uuid references public.vendors(id) on delete set null;

-- constrain assignee_kind (added separately so re-runs don't error)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_tasks_assignee_kind_chk') then
    alter table public.event_tasks
      add constraint event_tasks_assignee_kind_chk check (assignee_kind in ('in_house','outsourced'));
  end if;
end $$;

-- backfill any pre-existing rows (default already covers new rows)
update public.event_tasks set assignee_kind = 'in_house' where assignee_kind is null;

create index if not exists etask_vendor_idx on public.event_tasks(quote_id, vendor_id) where vendor_id is not null;

-- 2) RPC: assign a set of tasks (by title) in a category to an OUTSOURCED vendor
--    Reuses work_tokens (keyed by event+phone) so the vendor gets a worker link,
--    and queues the full checklist to the notification outbox.
create or replace function public.assign_tasks_vendor(
  p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; v public.vendors; tok uuid; t text; n int := 0; s int; ph text;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes  where id = p_quote_id;
  if q.id is null then raise exception 'no such event'; end if;
  select * into v from public.vendors where id = p_vendor_id;
  if v.id is null then raise exception 'no such vendor'; end if;
  ph := regexp_replace(coalesce(v.phone,''),'[^0-9+]','','g');
  if length(regexp_replace(ph,'[^0-9]','','g')) < 8 then
    raise exception 'This vendor has no phone number — add one in Vendors so the checklist can be sent.';
  end if;
  -- ensure a work link exists for (event, vendor phone)
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=ph;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,ph,v.name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t;
    insert into public.event_tasks(quote_id,category,title,seq,assignee_kind,vendor_id,
                                   assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),'outsourced',p_vendor_id,
              v.name,ph,'assigned',auth.uid());
    n := n + 1;
  end loop;
  -- send the checklist to the vendor (simulated outbox until SMS/WhatsApp is live)
  perform public._notify(p_quote_id,'sms',ph,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok,
                       'outsourced',true,'vendor',v.name,'checklist',to_jsonb(coalesce(p_titles,'{}'::text[]))));
  return jsonb_build_object('work_token',tok,'tasks_created',n,'vendor',v.name);
end; $$;

revoke all on function public.assign_tasks_vendor(uuid,text,text[],uuid) from anon;
grant execute on function public.assign_tasks_vendor(uuid,text,text[],uuid) to authenticated;

notify pgrst, 'reload schema';

-- verify -----------------------------------------------------------------------
select 'in_house'  kind, count(*) n from public.event_tasks where assignee_kind='in_house'
union all
select 'outsourced', count(*)      from public.event_tasks where assignee_kind='outsourced';
