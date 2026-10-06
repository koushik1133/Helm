-- ============================================================================
-- 0007_rpc_authz_guards.sql — CANONICAL forward-only (SEC-05 F10/F11/F12).
-- Re-authored from SEC-05 logic.
--   F11 mark_paid: restrict to admin/manager (was any can_edit role).
--   F12 verify-columns: a BEFORE trigger blocks direct PATCH of event_tasks
--       verify_* columns by the API roles (anon/authenticated) — QC must go
--       through verify_task() (DEFINER). Internal/owner writes are unaffected.
--   F10 has_area('<area>','edit') added to the key write RPCs (defense-in-depth
--       atop the existing can_edit() check): generate_approval_token (quotes),
--       record_payment (finance).
-- NOTE: F3 design_advance is N/A here — design_advance is a later feature phase not
-- present in base-v1 (2026-09-25); it is tracked for the feature-phase canonical
-- workstream. F1 _flag org-scoping: base-v1 already ships _flag(text,uuid).
-- Idempotent. Forward-only.
-- ============================================================================

-- ---- F11: mark_paid is admin/manager only ----------------------------------
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare q public.quotes;
begin
  if public.user_role() not in ('admin','manager') then
    raise exception 'not authorized' using errcode='42501';
  end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $function$;

-- ---- F12: guard event_tasks verify_* columns against direct PATCH -----------
create or replace function public.tg_guard_task_verify() returns trigger
  language plpgsql security definer set search_path = public as $tg$
begin
  if tg_op='UPDATE' and current_user in ('anon','authenticated') then
    if new.verify_status is distinct from old.verify_status
       or new.verified_by is distinct from old.verified_by
       or new.verified_at is distinct from old.verified_at then
      raise exception 'verify columns are set only via verify_task()' using errcode='42501';
    end if;
  end if;
  return new;
end $tg$;
drop trigger if exists zz_guard_task_verify on public.event_tasks;
create trigger zz_guard_task_verify before update on public.event_tasks
  for each row execute function public.tg_guard_task_verify();

-- F10: generate_approval_token requires has_area('quotes','edit')
CREATE OR REPLACE FUNCTION public.generate_approval_token(p_quote_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public.has_area('quotes','edit') then raise exception 'not authorized' using errcode='42501'; end if;  -- SEC-05 F10
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
end; $function$

;
-- F10: record_payment requires has_area('finance','edit')
CREATE OR REPLACE FUNCTION public.record_payment(p_quote uuid, p_amount numeric, p_method text DEFAULT 'cash'::text, p_receipt_no text DEFAULT NULL::text, p_milestone uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; rno text; seqn int; studio_email text; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public.has_area('finance','edit') then raise exception 'not authorized' using errcode='42501'; end if;  -- SEC-05 F10
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is not null then
    select * into existing from public.quote_payments
      where quote_id = p_quote and idempotency_key = p_idempotency_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'booking','confirmed', 'idempotent_replay', true);
    end if;
  end if;

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

  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now() where id = p_milestone and quote_id = p_quote;
  else
    update public.payment_milestones set status='paid', paid_at=now()
      where id = (select id from public.payment_milestones where quote_id = p_quote and status <> 'paid' order by seq, due_date limit 1);
  end if;

  update public.quotes
     set approval_status = 'paid',
         status = case when status <> 'confirmed' then 'confirmed' else status end,
         lifecycle_stage = case when lifecycle_stage in ('lead','discovery','proposal','quote','confirmed')
                                then 'planning' else lifecycle_stage end,
         updated_at = now()
   where id = p_quote and org_id = public.current_org_id();

  select business_email into studio_email from public.organizations where id = q.org_id;
  perform public._notify(p_quote,'email', q.client->>'email', 'payment_receipt',
    jsonb_build_object('code',q.code,'amount',p_amount,'receipt',rno,'method',coalesce(p_method,'cash'),'booking','confirmed'));
  perform public._notify(p_quote,'email', coalesce(studio_email,''), 'advance_paid',
    jsonb_build_object('code',q.code,'amount',p_amount,'client',q.client->>'name','receipt',rno,'method',coalesce(p_method,'cash')));

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'booking','confirmed');
end; $function$

;
