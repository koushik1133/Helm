-- 0146_audit_1017_pnl_trial.sql - CANONICAL forward-only. REQUIRES 0124 + 0142 (_vb_event_pnl), 0128 (trial test mode).
--
-- In plain words (security + functional audit 2026-10-17, docs/ops/SECURITY-AUDIT-2026-10-17.md):
--   1) Net profit double-counted vendor spend that was entered BOTH as a Budget "Vendor" cost line
--      and as a vendor bill not linked to a booking. Loose (unlinked) vendor spend now has one source:
--      the larger of the loose bills and the loose vendor cost lines.
--   2) Net profit ignored refunds paid back to the client. Processed refunds (kind 'refund') are now
--      subtracted and returned as 'refunds'.
--   3) trial_test_approve (skip the OTP in a trial studio) worked for ANYONE holding the approval
--      link. It now also needs the caller to be a signed-in member of that studio;
--      trial_test_mode_for_token only shows the button to such a member.
--   Changes: create or replace of 3 functions + 1 new private helper. No table, column or row is
--   changed or deleted. Grants kept. Additive + idempotent: safe to run twice. ASCII only.

-- ---- 0) private helper: is the caller a signed-in member of this studio -------------
create or replace function public._aud1017_is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- aud1017-member
  select p_org is not null and auth.uid() is not null
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id = p_org);
$$;
revoke all on function public._aud1017_is_member(uuid) from public, anon, authenticated;
grant execute on function public._aud1017_is_member(uuid) to service_role;

-- ---- 1+2) per-event P&L ----------------------------------------------------------------
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124 (0142: change-order tax split; 0146 aud1017: loose vendor spend counted once + refunds)
declare
  q record; v_base numeric; v_chg_rev numeric; v_chg_cost numeric; v_tax numeric; v_rev numeric;
  v_vendor numeric; v_other numeric; v_staff numeric; v_net numeric; v_billed numeric; v_bill_paid numeric;
  v_loose_bills numeric; v_loose_lines numeric; v_refunds numeric;
begin
  select x.id, x.code, x.title, x.event_date, x.pricing, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur
    into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if not found then return null; end if;
  v_base := case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end;
  select coalesce(sum(c.price_delta), 0), coalesce(sum(c.cost_delta), 0) into v_chg_rev, v_chg_cost
    from public.change_requests c where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved';
  v_tax := coalesce(public._r101_quote_tax(q.pricing, v_base), 0);
  -- 0142: an approved change order's price_delta is what the client pays (incl. tax, as the
  -- overpay cap / booklet / Settlement use it). Split its tax at the quote's own rate so profit
  -- is on ex-tax revenue and the tax collected is complete.
  if v_tax > 0 and v_base - v_tax > 0 and v_chg_rev <> 0 then
    v_tax := v_tax + round(v_chg_rev * (v_tax / (v_base - v_tax)) / (1 + v_tax / (v_base - v_tax)), 2);
  end if;
  v_rev := v_base + v_chg_rev - v_tax;
  -- vendors: one source per active booking (its bills if any, else its cost line, else its cost)
  select coalesce(sum(case
           when exists (select 1 from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
             then (select sum(vb.amount) from public.vendor_bills vb where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void')
           when exists (select 1 from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
             then (select sum(coalesce(k.actual, k.estimated)) from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote)
           else coalesce(b.cost, 0) end), 0)
    into v_vendor
    from public.event_resources b where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled';
  -- 0146: spend not tied to an active booking has ONE source - the larger of the loose bills and
  -- the loose "vendor" cost lines (they usually record the same spend twice), never both.
  v_loose_bills := coalesce((select sum(vb.amount) from public.vendor_bills vb
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  v_loose_lines := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  v_vendor := v_vendor + greatest(v_loose_bills, v_loose_lines);
  -- logistics / other: non-vendor cost lines (not tied to a booking) + approved change cost
  v_other := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind <> 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0) + v_chg_cost;
  v_staff := coalesce((select sum(x.amount) from public.expense_claims x where x.quote_id = p_quote and x.org_id = p_org and x.status = 'paid'), 0);
  -- 0146: processed refunds to the client are money given back
  v_refunds := coalesce((select sum(r.amount) from public.event_refunds r
     where r.quote_id = p_quote and r.org_id = p_org and coalesce(r.kind, 'refund') = 'refund' and r.status = 'processed'), 0);
  v_net := v_rev - v_vendor - v_other - v_staff - v_refunds;
  select coalesce(sum(vb.amount), 0) into v_billed from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  select coalesce(sum(p.amount), 0) into v_bill_paid from public.vendor_payouts p join public.vendor_bills vb on vb.id = p.bill_id
    where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  return jsonb_build_object('quote_id', q.id, 'code', q.code, 'title', q.title, 'date', q.event_date, 'currency', q.cur,
    'revenue', v_rev, 'tax', v_tax, 'vendors', v_vendor, 'other', v_other, 'staff', v_staff, 'refunds', v_refunds, 'net_profit', v_net,
    'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
    'bills_total', v_billed, 'bills_paid', v_bill_paid, 'bills_due', v_billed - v_bill_paid);
end $$;
revoke all on function public._vb_event_pnl(uuid, uuid) from public, anon, authenticated;

-- ---- 3) trial test mode: members only ---------------------------------------------------
create or replace function public.trial_test_mode_for_token(p_token uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test (0146: only a signed-in member of the studio)
  select coalesce((select public._trial_test_mode_ok(q.org_id) and public._aud1017_is_member(q.org_id) from public.quotes q
                    where p_token is not null and q.approval_token = p_token
                      and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
                    limit 1), false);
$$;
revoke all on function public.trial_test_mode_for_token(uuid) from public;
grant execute on function public.trial_test_mode_for_token(uuid) to anon, authenticated, service_role;

create or replace function public.trial_test_approve(p_token uuid, p_phone text, p_client_name text,
                                                     p_terms_version text, p_consent_text text,
                                                     p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- helm-0128-trial-test: OTP skipped ONLY for an active trial studio; same verify_and_consent path
declare v_q uuid; v_org uuid; v_file text; v_phone text; v_code text; r bigint; v_out jsonb;
begin
  select q.id, q.org_id, coalesce(q.client ->> 'phone', '') into v_q, v_org, v_file
    from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  if v_q is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  -- 0146 aud1017: the skip is for the studio owner testing alone - a client (or anyone else
  -- holding the link) must go through the real OTP.
  if not public._trial_test_mode_ok(v_org) or not public._aud1017_is_member(v_org) then
    return jsonb_build_object('approved', false, 'error', 'trial_test_unavailable',
      'message', 'Skipping the OTP is only available in an active free-trial studio.');
  end if;
  if public.link_age_expired(public.approval_link_age_until(p_token)) or public._a42_quote_shelved(v_q) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then v_phone := nullif(v_file, ''); end if;
  if v_phone is null or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 8 then
    return jsonb_build_object('approved', false, 'error', 'phone_required',
      'message', 'Enter a mobile number (any test number works in trial test mode).');
  end if;
  v_phone := public._otp_canon_phone(p_token, v_phone);
  -- one-time random code, hashed like request_otp; never returned, never sent
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when r < 4294000000;
  end loop;
  v_code := lpad((r % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (v_q, v_phone, extensions.crypt(v_code, extensions.gen_salt('bf', 8)), now() + interval '10 minutes');
  v_out := public.verify_and_consent(p_token, v_phone, v_code, true, p_terms_version,
                                     p_consent_text, p_client_name, p_user_agent);
  if coalesce((v_out ->> 'approved')::boolean, false) then
    update public.quote_consents c set verified_via_otp = false
     where c.id = (select c2.id from public.quote_consents c2 where c2.quote_id = v_q
                    order by c2.created_at desc, c2.id desc limit 1)
       and c.verified_via_otp;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'approval.trial_test_skip', 'quotes', v_q::text,
              jsonb_build_object('trial_test', true, 'otp', 'skipped', 'client_name', p_client_name),
              v_org, now());
    v_out := v_out || jsonb_build_object('trial_test', true);
  end if;
  return v_out;
end $$;
revoke all on function public.trial_test_approve(uuid, text, text, text, text, text) from public;
grant execute on function public.trial_test_approve(uuid, text, text, text, text, text) to anon, authenticated, service_role;
