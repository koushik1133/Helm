-- ============================================================================
-- B5 — record_settlement_payment(): settlement-aware payment recorder.
-- Settlement (post-event balance collection) needs the SAME server protections as
-- an advance payment — idempotency, a server-generated unique receipt, and the
-- overpayment cap (the trg_no_overpayment trigger fires automatically on the
-- quote_payments insert) — WITHOUT record_payment's advance-payment side effects:
-- it must NOT (re)confirm the booking (approval_status/status/lifecycle flips) and
-- must NOT fire the "booking confirmed / advance paid" notifications.
--
-- This is a NEW, additive function (record_payment is untouched). Forward-only,
-- idempotent (create or replace). Verified on staging before any prod apply.
-- ============================================================================
create or replace function public.record_settlement_payment(
  p_quote uuid, p_amount numeric, p_method text default 'cash',
  p_receipt_no text default null, p_milestone uuid default null,
  p_note text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $function$
declare q public.quotes; rno text; seqn int; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  -- idempotency: a repeated key returns the existing receipt (no double-charge)
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is not null then
    select * into existing from public.quote_payments
      where quote_id = p_quote and idempotency_key = p_idempotency_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'context','settlement', 'idempotent_replay', true);
    end if;
  end if;

  -- insert the paid receipt; the overpayment trigger (trg_no_overpayment) enforces the
  -- cap across quote_payments + payment_milestones. Retry receipt-number collisions.
  loop
    tries := tries + 1;
    select count(*)+1 into seqn from public.quote_payments where quote_id = p_quote and status = 'paid';
    rno := coalesce(nullif(btrim(coalesce(p_receipt_no,'')),''), 'RCP-'||q.code||'-'||lpad(seqn::text,2,'0'));
    begin
      insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at, note, idempotency_key)
        values (p_quote, coalesce(p_method,'cash'), p_amount, 'paid', rno, rno, coalesce(p_method,'cash'),
                (coalesce(p_method,'cash') <> 'cash'), now(), nullif(btrim(coalesce(p_note,'')),''),
                nullif(btrim(coalesce(p_idempotency_key,'')),''));
      exit;
    exception
      when unique_violation then
        if nullif(btrim(coalesce(p_receipt_no,'')),'') is not null then
          raise exception 'receipt number % already exists for this event', rno using errcode='23505';
        end if;
        if tries >= 5 then raise; end if;
    end;
  end loop;

  -- mark the settlement milestone paid if one was targeted (no auto-advance otherwise)
  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now()
      where id = p_milestone and quote_id = p_quote;
  end if;

  -- DELIBERATELY does NOT flip approval_status/status/lifecycle and does NOT notify:
  -- settlement is post-confirmation balance collection, not a booking event.
  update public.quotes set updated_at = now() where id = p_quote and org_id = public.current_org_id();

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'context','settlement');
end; $function$;
revoke all on function public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text) from anon, public;
grant execute on function public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text) to authenticated;

-- VERIFY
select 'record_settlement_payment exists + authenticated can execute' as check,
       has_function_privilege('authenticated','public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text)','EXECUTE') as ok
union all
select 'revoked from anon (want true)',
       not has_function_privilege('anon','public.record_settlement_payment(uuid,numeric,text,text,uuid,text,text)','EXECUTE');
