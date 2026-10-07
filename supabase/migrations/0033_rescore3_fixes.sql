-- ============================================================================
-- 0033_rescore3_fixes.sql — CANONICAL forward-only. Security re-score #3 fixes.
-- Every ATTACK below was reproduced on the disposable test DB
-- (tests/db/rescore3-fixes.sql FAILS on 0001-0032 and passes after this file).
--
-- What this changes, in plain words:
--   1  CHANNEL FLAGS (sms_live / email_live / pay_live / otp_dev_echo) are read
--      from the studio whose link or event is being served — never from whichever
--      studio saved its settings last. (Before: _flag() took the newest 'channels'
--      row of ANY studio, so one studio turning on dev-echo made every studio's
--      approval link hand out its OTP code.) request_otp, create_payment and
--      _notify name the event's studio for the duration of the call; signed-in
--      callers fall back to their own studio; no studio = flag off. Each
--      database's own request_otp / create_payment / _notify bodies are kept
--      (*__base); only thin wrappers change. Config rows were already
--      per-studio under RLS (a studio admin can only write its own rows).
--   2  QC GUARD: event_tasks verify columns (verify_status / verified_by /
--      verified_at) can only be set through verify_task(). The guard trigger now
--      runs as the caller (SECURITY INVOKER) — as a definer it always saw the owner
--      role and never fired. Completing a task still queues it for QC; a pass /
--      reject always records the signed-in checker as verified_by.
--   3  MONEY
--      a  a quote with line items (chairs, guests, plates, …) must carry gstPct:
--         a top-level "subtotal" can no longer stand in for the items (it set the
--         total to anything). Subtotal-only legacy quotes still save, bounded.
--      b  a signed-in user can't lower a quote total below what the client has
--         already paid (minus approved / processed refunds).
--      c  no payment can be recorded as paid (by app users) on an event whose quote
--         total is 0 or missing (the overpayment cap used to switch off then).
--      d  mark_paid (the "Mark paid" button) needs the client's approval AND an
--         open payment request — it settles that request, so a receipt row always
--         exists. Otherwise: "record the payment" (record_payment) instead.
--      e  a coupon in a quote must be an active coupon of the same studio, of the
--         same kind, worth no more than the coupon says. Checked only when the
--         coupon is added or changed — quotes keep a coupon that is retired later.
--   4  ORG EXPORT: export_tenant_organization_package no longer contains live
--      link tokens (approval_token / share_token / token / code_hash). The
--      database's own export body is kept as *__base.
--   5  CROSS-STUDIO: event_tasks.depends_on and quotes.manager_id may only point at
--      the same studio's task / user (the 0026 reference guard).
--
-- Zero data loss: additive + idempotent. No row is deleted or rewritten; no
-- table/column is dropped. Every new check applies to NEW or CHANGED values only
-- (legacy rows such as the 8.27e15 total are never re-checked). Safe to run twice.
-- ============================================================================

-- ============================================================================
-- 1) channel flags: the served studio's row only
-- ============================================================================
-- 1a) per-studio reader (base-v1 ships it; created only if this database lacks it)
do $guard$ begin
  if to_regprocedure('public._flag(text,uuid)') is null then
    execute $sql$
create function public._flag(p text, p_org uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select coalesce((select (value->>p)::boolean from public.app_config
                   where key='channels' and org_id = p_org), false);
$fn$
$sql$;
  end if;
end $guard$;

-- 1b) the one-argument form: the studio named by the current call (helm.flag_org,
--     set transaction-locally by the wrappers below), else the signed-in user's
--     studio, else none (= off). Never "the newest row of any studio".
create or replace function public._flag(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- rescore3-0033
  select public._flag(p, coalesce(
    case when coalesce(current_setting('helm.flag_org', true), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         then current_setting('helm.flag_org', true)::uuid end,
    public.current_org_id()));
$$;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = '_flag'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

-- 1c) _notify: keep this database's body as _notify__base; the wrapper names the
--     event's studio so sent/simulated follows THAT studio's sms/email flags.
do $$ begin
  if to_regprocedure('public._notify__base(uuid,text,text,text,jsonb)') is null
     and to_regprocedure('public._notify(uuid,text,text,text,jsonb)') is not null then
    alter function public._notify(uuid,text,text,text,jsonb) rename to _notify__base;
  end if;
end $$;
revoke all on function public._notify__base(uuid,text,text,text,jsonb) from public, anon, authenticated;

create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
-- rescore3-0033 wrapper: flags are read for the event's own studio
declare v_prev text := current_setting('helm.flag_org', true); v_org uuid;
begin
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  if v_org is not null then perform set_config('helm.flag_org', v_org::text, true); end if;
  perform public._notify__base(p_quote, p_channel, p_to, p_kind, p_detail);
  perform set_config('helm.flag_org', coalesce(v_prev, ''), true);
end $$;
revoke all on function public._notify(uuid,text,text,text,jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._notify(uuid,text,text,text,jsonb) to service_role';
    execute 'grant execute on function public._notify__base(uuid,text,text,text,jsonb) to service_role';
  end if;
end $$;

-- 1d) request_otp: the 0032 wrapper + the link's studio for the flags.
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- rescore2-0032 wrapper (+ rescore3-0033: channel flags of the link's studio).
-- The code is still generated by request_otp__base
-- (secure: extensions.gen_random_bytes, see 0026).
declare q public.quotes; v_file text; v_fails int; v_sent int; v_prev text := current_setting('helm.flag_org', true); v_out jsonb;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is not null then
    v_file := public.helm_otp_phone_on_file(q.client);
    if v_file is not null and length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) >= 8
       and right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10) <> v_file then
      raise exception 'use the phone number the studio has on file for you' using errcode = 'P0001';
    end if;
    select coalesce(sum(o.attempts), 0), count(*) into v_fails, v_sent
      from public.quote_otps o where o.quote_id = q.id and o.created_at > now() - interval '24 hours';
    if v_fails >= 15 then
      raise exception 'too many wrong codes on this link — try again tomorrow or contact the studio' using errcode = 'P0001';
    end if;
    if v_sent >= 20 then
      raise exception 'too many OTP requests on this link today — try again tomorrow' using errcode = 'P0001';
    end if;
    perform set_config('helm.flag_org', q.org_id::text, true);
  end if;
  v_out := public.request_otp__base(p_token, p_phone);
  perform set_config('helm.flag_org', coalesce(v_prev, ''), true);
  return v_out;
end $$;
revoke all on function public.request_otp(uuid,text) from public;
grant execute on function public.request_otp(uuid,text) to anon, authenticated, service_role;

-- 1e) create_payment: the 0026 wrapper + the link's studio for pay_live.
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 0026 wrapper (idempotent open request) + rescore3-0033: pay_live of the link's studio
declare v_q public.quotes; v_amt numeric; v_live boolean; r public.quote_payments;
        v_prev text := current_setting('helm.flag_org', true); v_out jsonb;
begin
  select * into v_q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if v_q.id is not null and v_q.approval_status in ('approved', 'paid') then
    perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || v_q.id::text, 0));
    v_amt := coalesce(public.helm_pricing_num(v_q.pricing -> 'total'), 0);
    v_live := public._flag('pay_live', v_q.org_id);
    select * into r from public.quote_payments
     where quote_id = v_q.id and status = 'created' and amount = v_amt
       and provider = case when v_live then 'razorpay' else 'simulated' end
       and simulated = not v_live
     order by created_at desc limit 1;
    if r.id is not null then
      if v_live then
        return jsonb_build_object('payment_id', r.id, 'pending_provider', true, 'amount', r.amount, 'reused', true);
      end if;
      return jsonb_build_object('payment_id', r.id, 'link_url', r.link_url, 'amount', r.amount, 'live', false, 'reused', true);
    end if;
  end if;
  if v_q.id is not null then perform set_config('helm.flag_org', v_q.org_id::text, true); end if;
  v_out := public.create_payment__base(p_token);   -- validation, insert and notify exactly as before
  perform set_config('helm.flag_org', coalesce(v_prev, ''), true);
  return v_out;
end $$;
revoke all on function public.create_payment(uuid) from public;
grant execute on function public.create_payment(uuid) to anon, authenticated, service_role;

-- ============================================================================
-- 2) QC guard: runs as the caller, so a direct API write is really checked
-- ============================================================================
create or replace function public.tg_guard_task_verify()
returns trigger language plpgsql security invoker set search_path = '' as $tg$
-- rescore3-0033: SECURITY INVOKER — current_user is the API role on a direct
-- write; verify_task() (SECURITY DEFINER) runs as its owner and passes.
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.verify_status not in ('unverified', 'pending') or new.verified_by is not null or new.verified_at is not null then
        raise exception 'verify columns are set only via verify_task()' using errcode = '42501';
      end if;
    elsif new.verify_status is distinct from old.verify_status
       or new.verified_by is distinct from old.verified_by
       or new.verified_at is distinct from old.verified_at then
      -- the one automatic step: completing a task queues it for QC (tg_task_verify)
      if not (new.verify_status = 'pending' and old.verify_status = 'unverified'
              and new.status = 'completed' and old.status is distinct from 'completed'
              and new.verified_by is not distinct from old.verified_by
              and new.verified_at is not distinct from old.verified_at) then
        raise exception 'verify columns are set only via verify_task()' using errcode = '42501';
      end if;
    end if;
  end if;
  -- whoever passes / rejects is the signed-in checker
  if new.verify_status in ('passed', 'rejected') and auth.uid() is not null
     and (tg_op = 'INSERT' or new.verify_status is distinct from old.verify_status) then
    new.verified_by := auth.uid();
  end if;
  return new;
end $tg$;
alter function public.tg_guard_task_verify() security invoker;
revoke all on function public.tg_guard_task_verify() from public, anon, authenticated;
drop trigger if exists zz_guard_task_verify on public.event_tasks;
create trigger zz_guard_task_verify before insert or update on public.event_tasks
  for each row execute function public.tg_guard_task_verify();

-- ============================================================================
-- 3a) items + top-level subtotal (new / changed pricing only; drafts untouched)
-- ============================================================================
create or replace function public.tg_quote_pricing_shape()
returns trigger language plpgsql security definer set search_path = '' as $$
-- rescore3-0033: with line items the total comes from the items; a top-level
-- subtotal (the legacy shape) must not stand in for them. Subtotal-only legacy
-- pricing still saves (bounded by 0026 / 0032).
declare p jsonb := new.pricing;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return new; end if;
  if tg_op = 'UPDATE' and p is not distinct from old.pricing then return new; end if;
  if (p ? 'subtotal') and not (p ? 'gstPct')
     and (p ? 'chairs' or p ? 'chairPrice' or p ? 'guests' or p ? 'platePrice' or p ? 'other' or p ? 'catering') then
    raise exception 'pricing with line items must include gstPct — the total is computed from the items, not from a subtotal'
      using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.tg_quote_pricing_shape() from public, anon, authenticated;
drop trigger if exists ab_quote_pricing_shape on public.quotes;
create trigger ab_quote_pricing_shape before insert or update of pricing on public.quotes
  for each row execute function public.tg_quote_pricing_shape();

-- ============================================================================
-- 3b + 3e) quote money guard: total >= already paid; coupons are real
--   Runs AFTER the total triggers (name sorts after zz_enforce_pricing_total), so it
--   sees the server-computed total. Applies to API callers: direct REST writes and
--   SECURITY DEFINER RPCs called by a signed-in user (confirm_quote, …) — identified
--   by the request's JWT role. service_role and the SQL editor are not affected.
-- ============================================================================
create or replace function public.tg_quote_money_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- rescore3-0033
declare c jsonb; v_code text; v_val numeric; k public.coupons; v_new numeric; v_old numeric; v_paid numeric;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'UPDATE' and new.pricing is not distinct from old.pricing then return new; end if;

  -- 3e) coupon added or changed: an active coupon of this studio, same kind, not inflated
  c := case when jsonb_typeof(new.pricing) = 'object' then new.pricing -> 'coupon' end;
  if jsonb_typeof(c) = 'object' and coalesce(public.helm_pricing_num(c -> 'value'), 0) > 0
     and (tg_op = 'INSERT'
          or c is distinct from (case when jsonb_typeof(old.pricing) = 'object' then old.pricing -> 'coupon' end)
          or (new.pricing ->> 'couponCode') is distinct from (case when jsonb_typeof(old.pricing) = 'object' then old.pricing ->> 'couponCode' end)) then
    v_code := nullif(btrim(coalesce(new.pricing ->> 'couponCode', c ->> 'code', '')), '');
    v_val  := public.helm_pricing_num(c -> 'value');
    if v_code is null then
      raise exception 'a coupon discount needs its coupon code' using errcode = '22023';
    end if;
    select * into k from public.coupons x
     where x.org_id = new.org_id and lower(x.code) = lower(v_code) and x.active
     order by x.created_at desc limit 1;
    if k.id is null then
      raise exception 'coupon "%" is not an active coupon of this studio', v_code using errcode = '22023';
    end if;
    if (coalesce(c ->> 'kind', '') = 'percent') is distinct from (k.kind = 'percent') or v_val > k.value then
      raise exception 'coupon "%" is worth % (%) — the quote can''t apply more', v_code, k.value, k.kind using errcode = '22023';
    end if;
  end if;

  -- 3b) the total can't drop below what the client has already paid (net of refunds)
  if tg_op = 'UPDATE' then
    v_new := case when jsonb_typeof(new.pricing) = 'object' then public.helm_pricing_num(new.pricing -> 'total') end;
    v_old := case when jsonb_typeof(old.pricing) = 'object' then public.helm_pricing_num(old.pricing -> 'total') end;
    if v_new is distinct from v_old and (v_new is null or v_old is null or v_new < v_old) then
      select coalesce(sum(qp.amount), 0) into v_paid from public.quote_payments qp
       where qp.quote_id = new.id and qp.status = 'paid';
      if v_paid > 0 then
        v_paid := v_paid - coalesce((select sum(r.amount) from public.event_refunds r
                                      where r.quote_id = new.id and r.kind = 'refund'
                                        and r.status in ('approved', 'processed')), 0);
        if v_paid > 0 and coalesce(v_new, 0) < v_paid - 0.5 then
          raise exception 'the quote total (%) can''t be lower than what the client has already paid (%) — record a refund first',
            coalesce(v_new, 0), v_paid using errcode = '23514';
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_quote_money_guard() from public, anon, authenticated;
drop trigger if exists zzz_quote_money_guard on public.quotes;
create trigger zzz_quote_money_guard before insert or update of pricing on public.quotes
  for each row execute function public.tg_quote_money_guard();

-- ============================================================================
-- 3c) no money settles against a 0 / missing quote total. Applies to API callers
--     (direct writes and signed-in RPCs: record_payment, mark_paid, settle_milestone,
--     …, identified by the request's JWT role). service_role (the Razorpay webhook,
--     which already files a 0-total payment as a reconciliation item) and owner
--     maintenance are not refused, so money that really arrived is never dropped.
-- ============================================================================
create or replace function public.tg_pay_needs_total()
returns trigger language plpgsql security definer set search_path = '' as $$
-- rescore3-0033
declare v_total numeric;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  if new.status is distinct from 'paid' or coalesce(new.amount, 0) <= 0 then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'paid' and new.amount is not distinct from old.amount then
    return new;                                    -- an already-paid row (legacy included) is not re-checked
  end if;
  select public.helm_pricing_num(q.pricing -> 'total') into v_total from public.quotes q where q.id = new.quote_id;
  if v_total is null or v_total <= 0 then
    raise exception 'this event has no quote total yet — price the quote before recording a payment'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.tg_pay_needs_total() from public, anon, authenticated;
drop trigger if exists trg_a_pay_needs_total on public.quote_payments;
create trigger trg_a_pay_needs_total before insert or update on public.quote_payments
  for each row execute function public.tg_pay_needs_total();
do $$ begin
  if to_regclass('public.payment_milestones') is not null then
    execute 'drop trigger if exists trg_a_pay_needs_total on public.payment_milestones';
    execute 'create trigger trg_a_pay_needs_total before insert or update on public.payment_milestones for each row execute function public.tg_pay_needs_total()';
  end if;
end $$;

-- ============================================================================
-- 3d) mark_paid: approved quote + an open payment request (0026 wrapper + checks)
-- ============================================================================
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- 0026 wrapper (settles exactly one open quote_payments request) + rescore3-0033
declare v_status text;
begin
  -- same check as assert_quote_org: the event must belong to the caller's studio
  if not exists (select 1 from public.quotes where id = p_quote_id and org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  if coalesce(public.user_role(), '') not in ('admin', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote_id::text, 0));
  select approval_status into v_status from public.quotes where id = p_quote_id for update;
  if v_status is distinct from 'approved' and v_status is distinct from 'paid' then
    raise exception 'the client has not approved this quote yet — a payment can be marked received only after approval'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.quote_payments where quote_id = p_quote_id and status = 'created') then
    raise exception 'there is no open payment request for this event — record the payment (amount and receipt) instead'
      using errcode = 'P0001';
  end if;
  update public.quote_payments set status = 'cancelled'
   where quote_id = p_quote_id and status = 'created'
     and id <> (select id from public.quote_payments
                 where quote_id = p_quote_id and status = 'created'
                 order by created_at desc, id desc limit 1);
  return public.mark_paid__base(p_quote_id, p_provider_ref);
end $$;
revoke all on function public.mark_paid(uuid,text) from public, anon;
grant execute on function public.mark_paid(uuid,text) to authenticated, service_role;

-- ============================================================================
-- 4) org export without live link tokens (this database's body kept as __base)
-- ============================================================================
do $$ begin
  if to_regprocedure('public.export_tenant_organization_package__base()') is null
     and to_regprocedure('public.export_tenant_organization_package()') is not null then
    alter function public.export_tenant_organization_package() rename to export_tenant_organization_package__base;
  end if;
end $$;
revoke all on function public.export_tenant_organization_package__base() from public, anon, authenticated;

create or replace function public.export_tenant_organization_package()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- rescore3-0033 wrapper: the access checks and contents are the base's; every
-- exported row loses its link-token columns.
declare v jsonb; v_out jsonb := '{}'::jsonb; k text; e jsonb;
        v_secret text[] := array['approval_token', 'share_token', 'token', 'code_hash'];
begin
  v := public.export_tenant_organization_package__base();
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  for k, e in select t.key, t.value from jsonb_each(v) t loop
    if jsonb_typeof(e) = 'array' then
      e := coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then x - v_secret else x end order by n)
                       from jsonb_array_elements(e) with ordinality a(x, n)), '[]'::jsonb);
    elsif jsonb_typeof(e) = 'object' then
      e := e - v_secret;
    end if;
    v_out := v_out || jsonb_build_object(k, e);
  end loop;
  return v_out;
end $$;
revoke all on function public.export_tenant_organization_package() from public, anon;
grant execute on function public.export_tenant_organization_package() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.export_tenant_organization_package() to service_role';
  end if;
end $$;

-- ============================================================================
-- 5) cross-studio references (0026 tg_ref_org_match; new / changed values only)
-- ============================================================================
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'event_tasks' and column_name = 'depends_on') then
    execute 'drop trigger if exists zz_ref_org_match_depends_on on public.event_tasks';
    execute $t$create trigger zz_ref_org_match_depends_on before insert or update of depends_on, org_id on public.event_tasks
              for each row execute function public.tg_ref_org_match('depends_on', 'event_tasks')$t$;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'quotes' and column_name = 'manager_id') then
    execute 'drop trigger if exists zz_ref_org_match_manager_id on public.quotes';
    execute $t$create trigger zz_ref_org_match_manager_id before insert or update of manager_id, org_id on public.quotes
              for each row execute function public.tg_ref_org_match('manager_id', 'profiles')$t$;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select pg_get_functiondef('public._flag(text)'::regprocedure) like '%helm.flag_org%';            -- t
-- select prosecdef from pg_proc where oid = 'public.tg_guard_task_verify()'::regprocedure;        -- f
-- select tgname from pg_trigger where tgname in ('zzz_quote_money_guard','trg_a_pay_needs_total',
--        'zz_ref_org_match_depends_on','zz_ref_org_match_manager_id');
-- select to_regprocedure('public.export_tenant_organization_package__base()') is not null;       -- t
-- supabase/audit/GRANT-PARITY.sql lists every remaining grant drift.
-- ============================================================================
