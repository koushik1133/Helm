-- ============================================================================
-- Phase 76 — Advance payment → confirmed booking (online + offline + receipts)
-- ---------------------------------------------------------------------------
-- Accepting a quote is not a confirmed booking; recording the advance is.
-- record_payment() logs a payment (online link or offline cash), issues a
-- receipt number, marks the matching milestone paid, confirms the booking, and
-- notifies BOTH the client (receipt) and the studio/planner (advance paid).
-- Works in simulation/manual mode now; a real Razorpay webhook can call the
-- same milestone/receipt path later. Org-scoped (assert_quote_org).
-- Idempotent. Run AFTER phase14 (milestones) + phase72 (assert_quote_org).
-- ============================================================================

alter table public.quote_payments add column if not exists receipt_no text;
alter table public.quote_payments add column if not exists method text;   -- 'online' | 'cash'

create or replace function public.record_payment(
  p_quote uuid, p_amount numeric, p_method text default 'cash',
  p_receipt_no text default null, p_milestone uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; rno text; seqn int; studio_email text;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  -- receipt number (use the one entered for offline cash, else auto-generate)
  select count(*)+1 into seqn from public.quote_payments where quote_id = p_quote and status = 'paid';
  rno := coalesce(nullif(btrim(coalesce(p_receipt_no,'')),''), 'RCP-'||q.code||'-'||lpad(seqn::text,2,'0'));

  insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at, note)
    values (p_quote, coalesce(p_method,'cash'), p_amount, 'paid', rno, rno, coalesce(p_method,'cash'),
            (coalesce(p_method,'cash') <> 'cash'), now(), nullif(btrim(coalesce(p_note,'')),''));

  -- mark the chosen milestone paid (or the earliest unpaid one if none given)
  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now() where id = p_milestone and quote_id = p_quote;
  else
    update public.payment_milestones set status='paid', paid_at=now()
      where id = (select id from public.payment_milestones where quote_id = p_quote and status <> 'paid' order by seq, due_date limit 1);
  end if;

  -- recording the advance confirms the booking
  update public.quotes
     set approval_status = 'paid',
         status = case when status <> 'confirmed' then 'confirmed' else status end,
         lifecycle_stage = case when lifecycle_stage in ('lead','discovery','proposal','quote','confirmed')
                                then 'planning' else lifecycle_stage end,
         updated_at = now()
   where id = p_quote and org_id = public.current_org_id();

  -- acknowledge BOTH sides
  select business_email into studio_email from public.organizations where id = q.org_id;
  perform public._notify(p_quote,'email', q.client->>'email', 'payment_receipt',
    jsonb_build_object('code',q.code,'amount',p_amount,'receipt',rno,'method',coalesce(p_method,'cash'),'booking','confirmed'));
  perform public._notify(p_quote,'email', coalesce(studio_email,''), 'advance_paid',
    jsonb_build_object('code',q.code,'amount',p_amount,'client',q.client->>'name','receipt',rno,'method',coalesce(p_method,'cash')));

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'booking','confirmed');
end; $$;
revoke all on function public.record_payment(uuid,numeric,text,text,uuid,text) from anon;
grant execute on function public.record_payment(uuid,numeric,text,text,uuid,text) to authenticated;

-- consolidated activity trail for one event (versions, discounts, advances,
-- receipts, consents, notifications) — org-scoped, newest first
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare items jsonb;
begin
  perform public.assert_quote_org(p_quote);
  select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('at', created_at, 'kind','version','text','Layout v'||version_no||coalesce(' — '||label,'')) a
      from public.quote_versions where quote_id = p_quote
    union all
    select jsonb_build_object('at', coalesce(paid_at,created_at), 'kind','payment',
             'text', case when status='paid' then 'Payment '||coalesce(receipt_no,'')||' — '||to_char(amount,'FM9999999999')||' ('||coalesce(method,provider)||')'
                          else 'Payment '||status||' — '||to_char(amount,'FM9999999999') end) a
      from public.quote_payments where quote_id = p_quote
    union all
    select jsonb_build_object('at', paid_at, 'kind','milestone','text','Milestone paid: '||label||' ('||to_char(amount,'FM9999999999')||')') a
      from public.payment_milestones where quote_id = p_quote and status='paid'
    union all
    select jsonb_build_object('at', created_at, 'kind','consent','text','Client consent recorded ('||coalesce(client_name,'')||')') a
      from public.quote_consents where quote_id = p_quote
    union all
    select jsonb_build_object('at', created_at, 'kind','notify','text',kind||' → '||coalesce(recipient,'')) a
      from public.notifications where quote_id = p_quote
  ) t;
  return items;
end; $$;
revoke all on function public.event_activity(uuid) from anon;
grant execute on function public.event_activity(uuid) to authenticated;

notify pgrst, 'reload schema';

select 'record_payment + event_activity' t, 'ready' s;
