-- APPLY 0144 (paste whole file in the Supabase SQL editor; ONE transaction; ends with read-only verify rows - expect every ok = true)
-- 0144: role gate fixes - can_edit() follows the access matrix, can_edit-only RPCs get their area check, payment receipts need a money area, event_activity / task_verify_summary need area view. Additive + idempotent; no rows changed. Run AFTER APPLY-0143.
begin;

-- ===== migrations/0144_role_gate_fixes.sql =====
-- 0144_role_gate_fixes.sql - CANONICAL forward-only. REQUIRES 0039 (publish_proposal wrapper),
-- 0052 (confirm_quote / set_plan_lock wrappers), phase29 (role_access), base has_area().
-- (Planned as "0143_role_gate_fixes"; 0143 was taken by 0143_roles_crew_defaults, so this is 0144.)
--
-- In plain words - the role audit (docs/ops/ROLE-ACCESS-AUDIT.md) found the database and the
-- Control Center access matrix disagreeing in four places. This migration makes the MATRIX the
-- single authority everywhere:
--
--   1) can_edit() was a hard-coded role list {admin, planner, sales, operations}. So an Event
--      manager or Event coordinator who the matrix lets edit the plan / staff / closure still got
--      "not authorized" from ~15 server functions, while Sales / Operations passed it even with every
--      edit switch off. can_edit() now means "admin, or this role may edit at least one area"; the
--      real per-area check stays inside each function. The few functions that ONLY checked
--      can_edit() are wrapped first with the area they touch:
--        add_quote_version  -> quotes or layouts edit      assign_tasks / reassign_task -> staff edit
--        assign_tasks_vendor -> staff or vendors edit      set_plan_signoff -> plan or ready edit
--        set_plan_lock      -> plan edit                   confirm_quote    -> quotes edit
--        publish_proposal   -> proposal or quotes edit     mgr_notify (SMS/WhatsApp to a client) ->
--                                                          quotes, finance or settlement edit
--   2) Payment receipts (quote_payments) were governed by the "quotes" area, so every role that can
--      merely VIEW an event (coordinator, supervisor, operations, quality, designer) could read every
--      receipt amount + method. Reading now also needs finance, settlement or package-payment view;
--      direct writes need finance or settlement edit (the app writes payments only through the
--      record_payment / settlement RPCs, which already check finance / settlement edit).
--   3) event_activity() (the event "activity trail") only checked the studio, so ANY signed-in
--      member - crew and client logins included - could read payment amounts and the client's
--      email / phone from it. It now needs quotes view, and payment lines need finance view.
--   4) task_verify_summary() only checked the studio; it now needs staff or quotes view.
--
-- Nothing is deleted or rewritten: no table rows change, no policy is dropped except this
-- migration's own (re-run safe). Restrictive policies only NARROW access. Idempotent.

-- ---- 1a) wrap the can_edit()-only functions ONCE (rename -> *__pre0144) --------------------------
do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['add_quote_version',   'uuid, text, jsonb, integer'],
    ['assign_tasks',        'uuid, text, text[], uuid, text, text'],
    ['assign_tasks_vendor', 'uuid, text, text[], uuid'],
    ['reassign_task',       'uuid, uuid, text, text'],
    ['set_plan_signoff',    'uuid, text, boolean'],
    ['set_plan_lock',       'uuid, boolean'],
    ['confirm_quote',       'uuid, jsonb, jsonb'],
    ['publish_proposal',    'uuid, boolean'],
    ['mgr_notify',          'uuid, text, text, text, jsonb']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0144', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0144: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0144');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0144', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0144', f[2]);
  end loop;
end $$;

create or replace function public.add_quote_version(p_quote_id uuid, p_label text, p_data jsonb, p_object_count integer)
returns public.quote_versions language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('quotes', 'edit') or public.has_area('layouts', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.add_quote_version__pre0144(p_quote_id, p_label, p_data, p_object_count);
end $$;

create or replace function public.assign_tasks(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.assign_tasks__pre0144(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone);
end $$;

create or replace function public.assign_tasks_vendor(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('staff', 'edit') or public.has_area('vendors', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.assign_tasks_vendor__pre0144(p_quote_id, p_category, p_titles, p_vendor_id);
end $$;

create or replace function public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.reassign_task__pre0144(p_task_id, p_crew_id, p_name, p_phone);
end $$;

create or replace function public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
returns public.event_plan language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('plan', 'edit') or public.has_area('ready', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_plan_signoff__pre0144(p_quote_id, p_field, p_done);
end $$;

create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('plan', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_plan_lock__pre0144(p_quote_id, p_locked);
end $$;

create or replace function public.confirm_quote(p_quote_id uuid, p_client jsonb, p_pricing jsonb)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'no such event' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized to confirm' using errcode = '42501'; end if;
  return public.confirm_quote__pre0144(p_quote_id, p_client, p_pricing);
end $$;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('proposal', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.publish_proposal__pre0144(p_quote_id, p_published);
end $$;

create or replace function public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('quotes', 'edit') or public.has_area('finance', 'edit') or public.has_area('settlement', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.mgr_notify__pre0144(p_quote_id, p_channel, p_to, p_kind, p_detail);
end $$;

do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['add_quote_version',   'uuid, text, jsonb, integer'],
    ['assign_tasks',        'uuid, text, text[], uuid, text, text'],
    ['assign_tasks_vendor', 'uuid, text, text[], uuid'],
    ['reassign_task',       'uuid, uuid, text, text'],
    ['set_plan_signoff',    'uuid, text, boolean'],
    ['set_plan_lock',       'uuid, boolean'],
    ['confirm_quote',       'uuid, jsonb, jsonb'],
    ['publish_proposal',    'uuid, boolean'],
    ['mgr_notify',          'uuid, text, text, text, jsonb']
  ] loop
    execute format('revoke all on function public.%I(%s) from public, anon', f[1], f[2]);
    execute format('grant execute on function public.%I(%s) to authenticated, service_role', f[1], f[2]);
  end loop;
end $$;

-- ---- 1b) can_edit(): the matrix decides (admin, or the role may edit at least one area) ----------
create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.is_admin() or exists (
    select 1 from public.role_access ra
     where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.can_edit), false);
$$;

-- ---- 2) quote_payments: money needs a money area ---------------------------------------------------
alter table public.quote_payments enable row level security;
drop policy if exists a144_qp_money_read on public.quote_payments;
create policy a144_qp_money_read on public.quote_payments as restrictive for select to authenticated
  using (public.has_area('finance', 'view') or public.has_area('settlement', 'view') or public.has_area('pkg_payments', 'view'));
drop policy if exists a144_qp_money_ins on public.quote_payments;
create policy a144_qp_money_ins on public.quote_payments as restrictive for insert to authenticated
  with check (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));
drop policy if exists a144_qp_money_upd on public.quote_payments;
create policy a144_qp_money_upd on public.quote_payments as restrictive for update to authenticated
  using (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'))
  with check (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));
drop policy if exists a144_qp_money_del on public.quote_payments;
create policy a144_qp_money_del on public.quote_payments as restrictive for delete to authenticated
  using (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));

-- ---- 3) event_activity(): quotes view; payment lines need a money area ------------------------------
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare items jsonb; v_fin boolean;
begin
  perform public.assert_quote_org(p_quote);
  if not public.has_area('quotes', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_fin := public.has_area('finance', 'view') or public.has_area('settlement', 'view') or public.has_area('pkg_payments', 'view');
  select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('at', created_at, 'kind','version','text','Layout v'||version_no||coalesce(' - '||label,'')) a
      from public.quote_versions where quote_id = p_quote
    union all
    select jsonb_build_object('at', coalesce(paid_at,created_at), 'kind','payment',
             'text', case when status='paid' then 'Payment '||coalesce(receipt_no,'')||' - '||to_char(amount,'FM9999999999')||' ('||coalesce(method,provider)||')'
                          else 'Payment '||status||' - '||to_char(amount,'FM9999999999') end) a
      from public.quote_payments where quote_id = p_quote and v_fin
    union all
    select jsonb_build_object('at', paid_at, 'kind','milestone','text','Milestone paid: '||label||' ('||to_char(amount,'FM9999999999')||')') a
      from public.payment_milestones where quote_id = p_quote and status='paid' and v_fin
    union all
    select jsonb_build_object('at', created_at, 'kind','consent','text','Client consent recorded ('||coalesce(client_name,'')||')') a
      from public.quote_consents where quote_id = p_quote
    union all
    select jsonb_build_object('at', created_at, 'kind','notify','text',kind||' -> '||coalesce(recipient,'')) a
      from public.notifications where quote_id = p_quote
  ) t;
  return items;
end; $$;

-- ---- 4) task_verify_summary(): staff or quotes view ---------------------------------------------------
create or replace function public.task_verify_summary(p_quote uuid)
returns table(total integer, completed integer, pending integer, passed integer, rejected integer)
language sql stable security definer set search_path to 'public' as $$
  select count(*)::int,
         count(*) filter (where status = 'completed')::int,
         count(*) filter (where verify_status = 'pending')::int,
         count(*) filter (where verify_status = 'passed')::int,
         count(*) filter (where verify_status = 'rejected')::int
  from public.event_tasks
  where quote_id = p_quote and org_id = public.current_org_id()
    and (public.has_area('staff', 'view') or public.has_area('quotes', 'view'));
$$;

commit;

-- ===== VERIFY (read-only) =====
select 'can_edit follows the matrix' as check, pg_get_functiondef('public.can_edit()'::regprocedure) ilike '%role_access%' as ok
union all select 'add_quote_version wrapped', to_regprocedure('public.add_quote_version__pre0144(uuid,text,jsonb,integer)') is not null
union all select 'assign_tasks wrapped', to_regprocedure('public.assign_tasks__pre0144(uuid,text,text[],uuid,text,text)') is not null
union all select 'assign_tasks_vendor wrapped', to_regprocedure('public.assign_tasks_vendor__pre0144(uuid,text,text[],uuid)') is not null
union all select 'reassign_task wrapped', to_regprocedure('public.reassign_task__pre0144(uuid,uuid,text,text)') is not null
union all select 'set_plan_signoff wrapped', to_regprocedure('public.set_plan_signoff__pre0144(uuid,text,boolean)') is not null
union all select 'set_plan_lock wrapped', to_regprocedure('public.set_plan_lock__pre0144(uuid,boolean)') is not null
union all select 'confirm_quote wrapped', to_regprocedure('public.confirm_quote__pre0144(uuid,jsonb,jsonb)') is not null
union all select 'publish_proposal wrapped', to_regprocedure('public.publish_proposal__pre0144(uuid,boolean)') is not null
union all select 'mgr_notify wrapped', to_regprocedure('public.mgr_notify__pre0144(uuid,text,text,text,jsonb)') is not null
union all select 'inner functions not callable by the app', not has_function_privilege('authenticated','public.confirm_quote__pre0144(uuid,jsonb,jsonb)','execute')
union all select 'wrappers callable by the app', has_function_privilege('authenticated','public.confirm_quote(uuid,jsonb,jsonb)','execute')
union all select 'wrappers not callable by anon', not has_function_privilege('anon','public.mgr_notify(uuid,text,text,text,jsonb)','execute')
union all select 'payments read needs a money area', exists(select 1 from pg_policies where schemaname='public' and tablename='quote_payments' and policyname='a144_qp_money_read' and permissive='RESTRICTIVE')
union all select 'payments writes need a money edit', (select count(*) from pg_policies where schemaname='public' and tablename='quote_payments' and policyname in ('a144_qp_money_ins','a144_qp_money_upd','a144_qp_money_del') and permissive='RESTRICTIVE') = 3
union all select 'event_activity checks quotes view', pg_get_functiondef('public.event_activity(uuid)'::regprocedure) ilike '%has_area(''quotes'', ''view'')%'
union all select 'task_verify_summary checks area', pg_get_functiondef('public.task_verify_summary(uuid)'::regprocedure) ilike '%has_area(''staff'', ''view'')%'
union all select 'manager can still edit somewhere (matrix intact)', exists(select 1 from public.role_access where role='manager' and can_edit);
