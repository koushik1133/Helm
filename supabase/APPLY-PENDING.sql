-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor            (v6, 2026-10-06)
--   PART A  Business logic + cryptography ................ 0026  (audit Phase 7)
--   PART B  File uploads + card payments + messaging ...... 0027  (audit Phase 8)
--   PART C  Login + password hardening .................... 0028  (audit Phase 3-4 follow-up)
-- BOTH production and staging need this (both are up to date through 0025).
-- RUN supabase/audit/P7-10-PRECHECK.sql FIRST (read-only) and send me its result.
-- ════════════════════════════════════════════════════════════════════════════
-- SAFE TO RE-RUN: every part is idempotent. NO rows are changed or deleted. New data
--   rules are NOT VALID: existing rows are not re-checked. Nothing here uses temporary
--   tables or session state. If any statement fails, Supabase rolls the whole run back.
-- USE: SQL Editor → paste ALL → Run → the last table must show every row "ok".
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: not a Helm database (current_org_id missing). Wrong project?'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quote_payments'::regclass and tgname = 'aa_api_write_block')
    then raise exception 'STOP: 0025 not installed — run the previous APPLY-PENDING (v5) first'; end if;
  if to_regprocedure('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)') is null
     and not exists (select 1 from pg_proc where proname = 'verify_and_consent' and pronamespace = 'public'::regnamespace)
    then raise exception 'STOP: verify_and_consent missing'; end if;
  if to_regprocedure('public.admin_create_user_temp(text,text,text)') is null
     and not exists (select 1 from pg_proc where proname = 'admin_create_user_temp' and pronamespace = 'public'::regnamespace)
    then raise exception 'STOP: admin_create_user_temp missing'; end if;
  raise notice 'Preflight OK — applying 0026 + 0027 + 0028…';
end $$;

-- ═══════════════════ PART A — Business logic + cryptography (0026) ═══════════════════
-- ============================================================================
-- 0026_business_logic_crypto.sql — CANONICAL forward-only. Security audit Phase 7
-- (business logic + cryptography). Every attack below was reproduced on the
-- disposable test DB (tests/db/business-logic.sql) before this fix:
--   1  money: 'NaN' / 'Infinity' / negative numbers were accepted in quote pricing,
--      payments, milestones, expenses, refunds, costs, stock … A NaN or Infinity
--      quote total switches the overpayment cap OFF (NaN sorts above every number),
--      and a NaN coupon value silently turns a quote total into 0.
--   2  deleting a quote (any quotes-edit user, straight through the API) cascaded
--      and destroyed its paid receipts, the client's OTP consent and refunds.
--   3  OTP lockout never tripped: verify_and_consent raised on a wrong code, which
--      rolled back the attempt counter (prod has the C2b fix; canonical did not).
--   4  the DB-side OTP code came from random() (not cryptographically secure).
--   5  create_payment (public, link holders) inserted a new payment row + SMS on
--      every call (spam), and the duplicates then made mark_paid fail.
--   6  another studio could plant rows pointing at YOUR stock items, vendors, crew,
--      dishes … (foreign keys did not check the studio).
--   7  the API roles held TRUNCATE / TRIGGER / REFERENCES on every table
--      (row-level security does not apply to TRUNCATE).
--   8  client consent did not record WHAT was approved; several money / legal
--      tables were not in the audit log.
--   9  whoever entered a refund could approve it themselves.
--   10 unbounded text / contact fields (megabyte notes, "a@x.com, b@y.com" emails).
-- Drift-safe: functions whose production body may differ from canonical get a thin
-- wrapper and keep each project's OWN body renamed *__base (pattern of 0022):
-- helm_quote_total, create_payment, mark_paid. verify_and_consent and request_otp
-- are replaced in full: verify_and_consent = the prod C2b body + the H02 row lock
-- (a superset of prod), request_otp = the canonical body with a secure code.
-- Zero data loss: additive + idempotent. Every new CHECK is NOT VALID (existing
-- rows are never re-checked or changed). No row is deleted or rewritten.
-- ============================================================================

-- ============================================================================
-- 1) MONEY: finite, non-negative, bounded
-- ============================================================================

-- 1a) numeric money / quantity columns. "x >= 0 and x < 1e12" is FALSE for NaN
--     (NaN < 1e12 is false in PG), +Infinity and -Infinity, so one CHECK covers all.
--     Signed columns (price/cost deltas) get "x > -1e12 and x < 1e12".
--     PRECHECK (read-only) for a target DB — rows that would block a later UPDATE:
--       select count(*) from public.quote_payments where not (amount >= 0 and amount < 1e12);
do $$
declare r record; v_name text;
begin
  for r in select * from (values
      ('quote_payments','amount',false), ('payment_milestones','amount',false),
      ('expense_claims','amount',false), ('event_refunds','amount',false),
      ('event_costs','estimated',false), ('event_costs','actual',false),
      ('event_resources','cost',false), ('event_resources','advance',false), ('event_resources','qty',false),
      ('quotation_versions','total',false), ('coupons','value',false),
      ('crew_members','day_rate',false), ('chair_types','price',false), ('plate_types','price',false),
      ('menu_templates','price_per_plate',false), ('event_plan','menu_plate_price',false),
      ('event_discovery','budget_min',false), ('event_discovery','budget_max',false),
      ('leads','budget',false), ('inventory_items','total_qty',false), ('inventory_items','unit_cost',false),
      ('inventory_reservations','qty',false), ('inventory_checkouts','qty_out',false),
      ('inventory_checkouts','qty_in',false), ('event_stock_requests','qty',false),
      ('event_resource_needs','qty',false), ('event_menu_items','qty',false),
      ('change_requests','price_delta',true), ('change_requests','cost_delta',true)
    ) v(tbl, col, signed)
  loop
    v_name := left(r.tbl || '_' || r.col || '_finite_chk', 63);
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = r.tbl and column_name = r.col)
       and not exists (select 1 from pg_constraint
                        where conname = v_name and conrelid = format('public.%I', r.tbl)::regclass) then
      if r.signed then
        execute format('alter table public.%I add constraint %I check (%I > -1e12 and %I < 1e12) not valid',
                       r.tbl, v_name, r.col, r.col);
      else
        execute format('alter table public.%I add constraint %I check (%I >= 0 and %I < 1e12) not valid',
                       r.tbl, v_name, r.col, r.col);
      end if;
    end if;
  end loop;
end $$;

-- 1b) quote pricing (jsonb). The numbers the server computes the total from must
--     be finite, non-negative and bounded; percentages 0..100. Strings that are not
--     numbers are left to the original function (it raises exactly as before).
create or replace function public.helm_pricing_num(p jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) not in ('number', 'string') then return null; end if;
  return (p #>> '{}')::numeric;
exception when others then return null;
end $$;

create or replace function public.helm_pricing_assert_sane(p jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare k text; v numeric; v_pct boolean;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return; end if;
  foreach k in array array['chairs','chairPrice','guests','platePrice','other','subtotal','discount',
                           'gstPct','discountPct','serviceChargePct'] loop
    v := public.helm_pricing_num(p -> k);
    v_pct := k in ('gstPct','discountPct','serviceChargePct');
    if v is not null and not (v >= 0 and v < (case when v_pct then 100.0000001 else 1e12 end)) then
      raise exception 'pricing value "%" must be a number from 0 to % (got %)',
        k, case when v_pct then '100' else '999,999,999,999' end, v using errcode = '22003';
    end if;
  end loop;
  if jsonb_typeof(p -> 'catering') = 'object' then
    v := public.helm_pricing_num(p -> 'catering' -> 'amount');
    if v is not null and not (v >= 0 and v < 1e12) then
      raise exception 'pricing value "catering.amount" must be a number from 0 to 999,999,999,999 (got %)', v
        using errcode = '22003';
    end if;
  end if;
  if jsonb_typeof(p -> 'coupon') = 'object' then
    v := public.helm_pricing_num(p -> 'coupon' -> 'value');
    if v is not null and not (v >= 0 and v < 1e12) then
      raise exception 'pricing value "coupon.value" must be a number from 0 to 999,999,999,999 (got %)', v
        using errcode = '22003';
    end if;
  end if;
end $$;
revoke all on function public.helm_pricing_num(jsonb) from public, anon;
revoke all on function public.helm_pricing_assert_sane(jsonb) from public, anon;
grant execute on function public.helm_pricing_num(jsonb) to authenticated, service_role;
grant execute on function public.helm_pricing_assert_sane(jsonb) to authenticated, service_role;

-- wrap helm_quote_total (keeps this project's own body as helm_quote_total__base)
do $$ begin
  if to_regprocedure('public.helm_quote_total__base(jsonb)') is null
     and to_regprocedure('public.helm_quote_total(jsonb)') is not null then
    alter function public.helm_quote_total(jsonb) rename to helm_quote_total__base;
  end if;
end $$;
-- the pricing trigger runs as the caller, so the base stays callable by staff
-- (it is a pure calculation, exactly as before); never by anon.
revoke all on function public.helm_quote_total__base(jsonb) from public, anon;
grant execute on function public.helm_quote_total__base(jsonb) to authenticated, service_role;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  perform public.helm_pricing_assert_sane(p);
  v := public.helm_quote_total__base(p);
  if v is not null and not (v >= 0 and v < 1e13) then
    raise exception 'the quote total is out of range (%)', v using errcode = '22003';
  end if;
  return v;
end $$;
revoke all on function public.helm_quote_total(jsonb) from public, anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated, service_role;

-- 1c) payments against a quote whose stored total is not a real number are refused
--     (a NaN / Infinity total used to mean "no cap"). Runs before trg_no_overpayment,
--     does not replace it (prod's guard body is kept as is).
create or replace function public.tg_pay_total_finite()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_total numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select public.helm_pricing_num(q.pricing -> 'total') into v_total from public.quotes q where q.id = new.quote_id;
  if v_total is not null and not (v_total >= 0 and v_total < 1e13) then
    raise exception 'this event''s quote total is invalid (%) — fix the pricing before recording a payment', v_total
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.tg_pay_total_finite() from public, anon, authenticated;
drop trigger if exists trg_a_pay_total_finite on public.quote_payments;
create trigger trg_a_pay_total_finite before insert or update on public.quote_payments
  for each row execute function public.tg_pay_total_finite();
drop trigger if exists trg_a_pay_total_finite on public.payment_milestones;
create trigger trg_a_pay_total_finite before insert or update on public.payment_milestones
  for each row execute function public.tg_pay_total_finite();

-- ============================================================================
-- 2) a quote with money / consent / refund records cannot be deleted
-- ============================================================================
-- Unpaid drafts still delete (their payment intents, OTPs, links cascade as before).
-- Applies to EVERY role, including SECURITY DEFINER functions and the service role.
-- Owner maintenance only: in a superuser session
--   select set_config('helm.allow_financial_delete', 'on', true);  -- this transaction
-- SECURITY DEFINER so RLS can't hide the child rows from the check; the caller's
-- role is read from the 'role' setting (unchanged by SECURITY DEFINER).
create or replace function public.tg_quote_delete_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('helm.allow_financial_delete', true), '') = 'on'
     and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated', 'service_role') then
    return old;
  end if;
  if exists (select 1 from public.quote_payments where quote_id = old.id and status in ('paid', 'refunded'))
     or exists (select 1 from public.payment_milestones where quote_id = old.id and status = 'paid')
     or exists (select 1 from public.quote_consents where quote_id = old.id)
     or exists (select 1 from public.event_refunds where quote_id = old.id) then
    raise exception 'This event has payments, a client approval or refunds on record, so it can''t be deleted. Cancel it instead.'
      using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke all on function public.tg_quote_delete_guard() from public, anon, authenticated;
drop trigger if exists aa_quote_delete_guard on public.quotes;
create trigger aa_quote_delete_guard before delete on public.quotes
  for each row execute function public.tg_quote_delete_guard();

-- ============================================================================
-- 3) OTP verification: the attempt counter persists (5 tries, then locked) and the
--    active code row is locked (single use under concurrency).
--    Body = supabase/prod-fix/C2b (what prod runs) + harden-2026-10/H02 FOR UPDATE.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;

  -- lock the active OTP row: concurrent verifications serialize here
  select * into rec from public.quote_otps
    where quote_id = q.id and phone = p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1
    for update;

  if rec.id is null then
    return jsonb_build_object('approved', false, 'error','no_active_code', 'message','no active code — request a new OTP');
  end if;
  if rec.attempts >= 5 then
    return jsonb_build_object('approved', false, 'error','locked', 'message','too many attempts — request a new OTP');
  end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    -- RETURN (not raise) so the increment commits
    update public.quote_otps set attempts = attempts + 1 where id = rec.id;
    return jsonb_build_object('approved', false, 'error','incorrect_code', 'message','incorrect code',
      'remaining', greatest(0, 5 - (rec.attempts + 1)));
  end if;
  if p_agreed is not true then
    return jsonb_build_object('approved', false, 'error','not_agreed', 'message','you must accept the terms to confirm');
  end if;

  update public.quote_otps set verified_at = now() where id = rec.id;        -- single use
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status = 'approved', updated_at = now() where id = q.id;
  return jsonb_build_object('approved', true);
end; $function$;
revoke all on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) from public;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated, service_role;

-- ============================================================================
-- 4) request_otp: cryptographically secure, uniform 6-digit code
--    (rejection sampling over 32 random bits from pgcrypto's gen_random_bytes).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.request_otp(p_token uuid, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; code text; recent int; live boolean; r bigint;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;   -- 0 .. 2^32-1
    exit when r < 4294000000;                                                     -- drop the biased tail
  end loop;
  code := lpad((r % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf', 8)), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $function$;
revoke all on function public.request_otp(uuid,text) from public;
grant execute on function public.request_otp(uuid,text) to anon, authenticated, service_role;

-- ============================================================================
-- 5) create_payment is idempotent; mark_paid settles exactly one open intent
-- ============================================================================
do $$ begin
  if to_regprocedure('public.create_payment__base(uuid)') is null
     and to_regprocedure('public.create_payment(uuid)') is not null then
    alter function public.create_payment(uuid) rename to create_payment__base;
  end if;
  if to_regprocedure('public.mark_paid__base(uuid,text)') is null
     and to_regprocedure('public.mark_paid(uuid,text)') is not null then
    alter function public.mark_paid(uuid,text) rename to mark_paid__base;
  end if;
end $$;
revoke all on function public.create_payment__base(uuid) from public, anon, authenticated;
revoke all on function public.mark_paid__base(uuid,text) from public, anon, authenticated;

-- An open payment request for the same quote, amount and provider mode is handed
-- back instead of creating another row + another SMS. Same per-quote lock as the
-- overpayment guard, so two clicks at once still produce one row.
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_q public.quotes; v_amt numeric; v_live boolean; r public.quote_payments;
begin
  select * into v_q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if v_q.id is not null and v_q.approval_status in ('approved', 'paid') then
    perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || v_q.id::text, 0));
    v_amt := coalesce(public.helm_pricing_num(v_q.pricing -> 'total'), 0);
    v_live := public._flag('pay_live');
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
  return public.create_payment__base(p_token);   -- validation, insert and notify exactly as before
end $$;
revoke all on function public.create_payment(uuid) from public;
grant execute on function public.create_payment(uuid) to anon, authenticated, service_role;

-- Older duplicate open requests are marked 'cancelled' (never deleted) so only the
-- newest one is settled; the original mark_paid then runs unchanged. If it refuses
-- (not an admin/manager, …) the whole call rolls back, cancellations included.
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  -- same check as assert_quote_org: the event must belong to the caller's studio
  if not exists (select 1 from public.quotes where id = p_quote_id and org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote_id::text, 0));
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
-- 6) cross-studio references: a row may only point at records of its own studio
-- ============================================================================
-- For every single-column foreign key from a table with org_id to an org-owned
-- table (other than quotes — 0004 — and organizations). Checked on insert and
-- when the reference or org_id changes, so existing rows are never re-checked.
-- Today: event_tasks.crew_id/vendor_id, inventory_checkouts.item_id/issued_to_id,
-- inventory_reservations.item_id, event_resource_needs.item_id,
-- event_stock_requests.item_id, event_resources.vendor_id/need_id,
-- event_costs.booking_id, event_menu_items.dish_id, chat_members/chat_messages
-- .conversation_id, chat_messages.reply_to, chat_reactions.message_id.
create or replace function public.tg_ref_org_match()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ref text := to_jsonb(new) ->> tg_argv[0]; v_org uuid;
begin
  if v_ref is null then return new; end if;
  execute format('select org_id from public.%I where id = $1', tg_argv[1]) into v_org using v_ref::uuid;
  if v_org is not null and new.org_id is distinct from v_org then
    raise exception '% belongs to another studio', tg_argv[1] using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_ref_org_match() from public, anon, authenticated;

do $$
declare r record; v_trg text;
begin
  for r in
    select c.conrelid::regclass::text as child, a.attname as col, p.relname as parent
      from pg_constraint c
      join pg_class ch on ch.oid = c.conrelid
      join pg_class p  on p.oid = c.confrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and ch.relnamespace = 'public'::regnamespace and p.relnamespace = 'public'::regnamespace
       and p.relname not in ('quotes', 'organizations')
       and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'org_id' and not x.attisdropped)
       and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'org_id' and not x.attisdropped)
       and exists (select 1 from pg_attribute x join pg_constraint k on k.conrelid = c.confrelid and k.contype = 'p'
                    where x.attrelid = c.confrelid and x.attname = 'id' and x.attnum = all (k.conkey))
     order by 1, 2
  loop
    v_trg := left('zz_ref_org_match_' || r.col, 63);
    execute format('drop trigger if exists %I on %s', v_trg, r.child);
    execute format('create trigger %I before insert or update of %I, org_id on %s for each row execute function public.tg_ref_org_match(%L, %L)',
                   v_trg, r.col, r.child, r.col, r.parent);
  end loop;
end $$;

-- ============================================================================
-- 7) API roles: no TRUNCATE / TRIGGER / REFERENCES (RLS does not cover TRUNCATE)
-- ============================================================================
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- ============================================================================
-- 8) non-repudiation
-- ============================================================================
-- 8a) audit log on the legal / money tables that were missing it
do $$
declare t text;
begin
  foreach t in array array['quote_consents','payment_milestones','event_refunds','event_resources',
                           'inventory_checkouts','event_closure','quotation_versions'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'audit_trg') then
      execute format('create trigger audit_trg after insert or delete or update on public.%I for each row execute function public.tg_audit()', t);
    end if;
  end loop;
end $$;

-- 8b) the consent records WHAT was approved, filled from the quote at that moment
--     (new columns; old consents stay as they are)
alter table public.quote_consents add column if not exists quote_total numeric;
alter table public.quote_consents add column if not exists quote_version integer;
alter table public.quote_consents add column if not exists pricing_snapshot jsonb;
alter table public.quote_consents add column if not exists consent_text_sha256 text;
alter table public.quote_consents add column if not exists request_ip text;
alter table public.quote_consents add column if not exists phone_matches_client boolean;

create or replace function public.tg_consent_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_hdr text; v_ip text;
begin
  select * into q from public.quotes where id = new.quote_id;
  new.quote_total      := public.helm_pricing_num(q.pricing -> 'total');
  new.quote_version    := q.current_version;
  new.pricing_snapshot := q.pricing;
  new.consent_text_sha256 := case when new.consent_text is null then null
                                  else encode(sha256(convert_to(new.consent_text, 'UTF8')), 'hex') end;
  new.phone_matches_client := case
    when nullif(regexp_replace(coalesce(q.client ->> 'phone', ''), '[^0-9]', '', 'g'), '') is null
      or nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9]', '', 'g'), '') is null then null
    else right(regexp_replace(q.client ->> 'phone', '[^0-9]', '', 'g'), 10)
       = right(regexp_replace(new.phone, '[^0-9]', '', 'g'), 10) end;
  begin
    v_hdr := current_setting('request.headers', true);
    if v_hdr is not null and v_hdr <> '' then
      v_ip := btrim(split_part(coalesce(v_hdr::jsonb ->> 'x-forwarded-for', v_hdr::jsonb ->> 'x-real-ip', ''), ',', 1));
    end if;
  exception when others then v_ip := null;
  end;
  new.request_ip := left(nullif(v_ip, ''), 64);
  new.user_agent := left(new.user_agent, 1000);   -- browsers send < 1000; bound the stored copy
  return new;
end $$;
revoke all on function public.tg_consent_snapshot() from public, anon, authenticated;
drop trigger if exists ab_consent_snapshot on public.quote_consents;
create trigger ab_consent_snapshot before insert on public.quote_consents
  for each row execute function public.tg_consent_snapshot();

-- ============================================================================
-- 9) refunds: maker-checker. Whoever entered a refund cannot approve / complete
--    it themselves, unless they are the studio admin (a one-person studio must
--    still work). Who entered it is stamped by the server and can't be changed.
-- ============================================================================
create or replace function public.tg_refund_maker_checker()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      if new.created_by is distinct from old.created_by then
        raise exception 'who entered a refund can''t be changed' using errcode = '42501';
      end if;
      if new.status is distinct from old.status and new.status in ('approved', 'processed')
         and old.created_by is not null and old.created_by = auth.uid()
         and coalesce(public.user_role(), '') <> 'admin' then
        raise exception 'Someone else must approve a refund you entered.' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.tg_refund_maker_checker() from public, anon, authenticated;
drop trigger if exists ab_refund_maker_checker on public.event_refunds;
create trigger ab_refund_maker_checker before insert or update on public.event_refunds
  for each row execute function public.tg_refund_maker_checker();

-- ============================================================================
-- 10) server-side bounds on staff-writable text (NOT VALID: old rows untouched)
--     and on contact fields that feed SMS / WhatsApp / email
-- ============================================================================
do $$
declare r record; v_name text;
begin
  for r in select * from (values
      -- names / titles / labels
      ('quotes','title',300), ('leads','name',300), ('crew_members','name',300), ('vendors','name',300),
      ('nurture','name',300), ('event_attendees','name',300), ('inventory_items','name',300),
      ('event_tasks','title',500), ('event_tasks','assignee_name',300), ('payment_milestones','label',300),
      ('expense_claims','who',300), ('event_resources','label',500), ('coupons','code',64),
      ('change_requests','title',500), ('event_issues','title',500), ('quote_consents','client_name',300),
      ('quote_consents','terms_version',64),
      -- phones / emails
      ('leads','phone',40), ('crew_members','phone',40), ('vendors','phone',40), ('nurture','phone',40),
      ('event_tasks','assignee_phone',40), ('quote_consents','phone',40),
      ('leads','email',320), ('crew_members','email',320), ('vendors','email',320), ('nurture','email',320),
      ('event_attendees','email',320),
      -- notes / free text
      ('leads','notes',20000), ('crew_members','notes',20000), ('vendors','notes',20000),
      ('nurture','note',20000), ('event_refunds','reason',5000), ('event_refunds','note',5000),
      ('expense_claims','description',5000), ('payment_milestones','note',5000),
      ('event_costs','description',5000), ('event_costs','note',5000), ('inventory_items','notes',20000),
      ('event_tasks','note',20000), ('change_requests','detail',20000), ('event_issues','detail',20000),
      ('event_resources','note',20000), ('quote_consents','consent_text',20000),
      ('quote_consents','user_agent',1000), ('chat_messages','body',10000)
    ) v(tbl, col, maxlen)
  loop
    v_name := left(r.tbl || '_' || r.col || '_len_chk', 63);
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = r.tbl and column_name = r.col
                  and data_type in ('text', 'character varying'))
       and not exists (select 1 from pg_constraint
                        where conname = v_name and conrelid = format('public.%I', r.tbl)::regclass) then
      execute format('alter table public.%I add constraint %I check (char_length(%I) <= %s) not valid',
                     r.tbl, v_name, r.col, r.maxlen);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'quotes_client_size_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_client_size_chk
      check (client is null or octet_length(client::text) <= 20000) not valid;
  end if;
end $$;

-- Contact shape, checked for direct API writes only and only when the value is new
-- or changed (old rows and server-side syncs are never blocked):
--   phone: digits and + ( ) . / - , ; spaces only
--   email: ONE address (no lists, no spaces, no <>) — it becomes an email recipient
create or replace function public.helm_contact_ok(p_phone text, p_email text)
returns text language sql immutable set search_path = '' as $$
  select case
    when nullif(btrim(coalesce(p_phone, '')), '') is not null
         and (p_phone !~ '^[0-9+()./,; -]{1,40}$' or p_phone !~ '[0-9]')
      then 'Enter a valid phone number'
    when nullif(btrim(coalesce(p_email, '')), '') is not null
         and (char_length(p_email) > 254 or btrim(p_email) !~ '^[^[:space:]@,;<>"]+@[^[:space:]@,;<>"]+\.[^[:space:]@,;<>"]+$')
      then 'Enter a single valid email address'
  end;
$$;
revoke all on function public.helm_contact_ok(text, text) from public, anon;
grant execute on function public.helm_contact_ok(text, text) to authenticated, service_role;

create or replace function public.tg_contact_shape_guard()
returns trigger language plpgsql set search_path = '' as $$
declare n jsonb; o jsonb; v_phone text; v_email text; v_err text;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  n := to_jsonb(new);
  if tg_op = 'UPDATE' then o := to_jsonb(old); end if;
  if tg_table_name = 'quotes' then
    n := coalesce(n -> 'client', '{}'::jsonb); o := coalesce(o -> 'client', '{}'::jsonb);
    if jsonb_typeof(n) <> 'object' then return new; end if;
    if (n ? 'email') and jsonb_typeof(n -> 'email') not in ('string', 'null') then
      raise exception 'Enter a single valid email address' using errcode = '23514';
    end if;
    if (n ? 'phone') and jsonb_typeof(n -> 'phone') not in ('string', 'number', 'null') then
      raise exception 'Enter a valid phone number' using errcode = '23514';
    end if;
  end if;
  if tg_argv[0] <> '-' and (o is null or (n ->> tg_argv[0]) is distinct from (o ->> tg_argv[0])) then
    v_phone := n ->> tg_argv[0];
  end if;
  if tg_argv[1] <> '-' and (o is null or (n ->> tg_argv[1]) is distinct from (o ->> tg_argv[1])) then
    v_email := n ->> tg_argv[1];
  end if;
  v_err := public.helm_contact_ok(v_phone, v_email);
  if v_err is not null then raise exception '%', v_err using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function public.tg_contact_shape_guard() from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select * from (values
      ('quotes','phone','email'), ('leads','phone','email'), ('crew_members','phone','email'),
      ('vendors','phone','email'), ('nurture','phone','email'), ('event_attendees','-','email'),
      ('event_tasks','assignee_phone','-')
    ) v(tbl, ph, em)
  loop
    if to_regclass('public.' || r.tbl) is not null then
      execute format('drop trigger if exists ab_contact_shape_guard on public.%I', r.tbl);
      execute format('create trigger ab_contact_shape_guard before insert or update on public.%I for each row execute function public.tg_contact_shape_guard(%L, %L)',
                     r.tbl, r.ph, r.em);
    end if;
  end loop;
end $$;

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select public.helm_quote_total('{"gstPct":18,"chairs":"NaN","chairPrice":1}');          -- raises 22003
-- select pg_get_functiondef('public.request_otp(uuid,text)'::regprocedure) ilike '%gen_random_bytes%';  -- t
-- select pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure) ilike '%for update%'; -- t
-- select count(*) from information_schema.role_table_grants where table_schema='public'
--   and grantee in ('anon','authenticated') and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES');   -- 0
-- select tgname, tgrelid::regclass from pg_trigger where tgname like 'zz_ref_org_match_%' order by 2;

-- ═══════════════════ PART B — File uploads + card payments + messaging (0027) ═══════════════════
-- ============================================================================
-- 0027_uploads_payments.sql — CANONICAL forward-only. Security audit Phase 8
-- (risky functionality: file uploads, card payments, outbound messaging).
-- Every ATTACK below was reproduced on the disposable test DB before this fix
-- (tests/db/uploads-payments.sql):
--   uploads  — invite-media write/replace/delete only checked the org folder, so the
--              lowest-privilege member (crew) could replace or delete the photos on a
--              client's PUBLISHED invitation; no per-event / per-user upload caps;
--              object keys of any shape (org/x/evil.html.png, 10k-char names).
--   payments — finance editors could set a payment milestone to 'paid' (or edit /
--              delete a paid one) by a direct API write, skipping the receipt ledger,
--              the overpayment lock and the audit trail.
--   messaging/payment Edge Functions — need small server-side helpers: a per-studio
--              rate counter, a "who may be messaged for this event" check, a
--              serialized payment-link reservation, and a reconciliation record for
--              money that arrives after a quote is already paid.
--
-- Limits chosen (documented in supabase/functions/README.md as well):
--   invite-media  8 MB/file, png/jpeg/webp/gif, <=120 stored objects per event
--                 (60 shown on the site — event_sites.data.photos <= 60 — plus head-room
--                 for replaced/removed photos that are still in storage)
--   event-docs   10 MB/file, pdf/png/jpeg/webp, <=200 objects per event
--   chat-media   16 MB/file, images + voice notes (unchanged), no per-chat cap
--   every bucket <=100 uploads per user per 10 minutes
--   WhatsApp     <=100 messages per studio per hour (send-whatsapp)
--   OTP SMS      <=200 per studio per day (send-otp), on top of admin_store_otp's
--                5 per quote per 10 minutes
-- Anti-virus: FLAG-ONLY (agreed). Recommendation: a post-upload scan (ClamAV in a
-- container or a scanning API) for event-docs PDFs that marks event_files clean before
-- signed URLs are issued. Not built here. Storage still checks only the client-declared
-- Content-Type against allowed_mime_types; the browser re-sniffs magic bytes, and files
-- are served from the separate *.supabase.co origin under the declared type.
--
-- Rules followed: additive + idempotent; constraints on existing data are NOT VALID;
-- no row is changed or deleted; no bucket is ever made public. Caller-checking guard
-- triggers are plain (not definer) and test current_user in ('anon','authenticated')
-- like 0021/0025, so SECURITY DEFINER functions (owner) and the service role pass.
-- No existing function body is rewritten (prod-drift safe): new helpers + policies +
-- triggers only.
-- ============================================================================

-- =============================================================================
-- 1) BUCKETS: private, strict MIME allowlist + size cap (re-pinned; never public)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('invite-media','invite-media', false, 8388608,
          array['image/png','image/jpeg','image/webp','image/gif'])
  on conflict (id) do update set public = false, file_size_limit = 8388608,
          allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'];
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('event-docs','event-docs', false, 10485760,
          array['application/pdf','image/png','image/jpeg','image/webp'])
  on conflict (id) do update set public = false, file_size_limit = 10485760,
          allowed_mime_types = array['application/pdf','image/png','image/jpeg','image/webp'];
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('chat-media','chat-media', false, 16777216,
          array['image/png','image/jpeg','image/webp','image/gif',
                'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'])
  on conflict (id) do update set public = false, file_size_limit = 16777216,
          allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif',
                'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a'];

-- =============================================================================
-- 2) UPLOAD HELPERS used by the storage.objects policies
--    storage_key_ok        — object key = <caller org>/<folder uuid>/<random>.<ext>
--                            (folder = one of the caller's events for invite-media /
--                            event-docs); extension on the bucket's allowlist.
--    storage_upload_allowed — storage_key_ok + per-event object cap + per-user rate.
-- =============================================================================
create or replace function public.storage_key_ok(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts  text[] := string_to_array(coalesce(p_name, ''), '/');
  v_org    uuid   := public.current_org_id();
  v_folder uuid;
begin
  if v_org is null or auth.uid() is null then return false; end if;
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] is distinct from v_org::text then
    return false;
  end if;
  begin v_folder := v_parts[2]::uuid; exception when others then return false; end;
  -- canonical lower-case uuid text only (uppercase / brace / no-dash forms would
  -- otherwise dodge the per-folder cap below)
  if v_parts[2] is distinct from v_folder::text then return false; end if;

  if p_bucket = 'invite-media' then
    if v_parts[3] !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.(png|jpg|webp|gif)$' then
      return false;
    end if;
  elsif p_bucket = 'event-docs' then
    if v_parts[3] !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\.(pdf|png|jpg|webp)$' then
      return false;
    end if;
  elsif p_bucket = 'chat-media' then
    if v_parts[3] !~ '^[A-Za-z0-9-]{1,64}\.(png|jpg|webp|gif|webm|ogg|m4a|mp3)$' then
      return false;
    end if;
    return true;                         -- conversation membership: chat_media_visible()
  else
    return false;
  end if;

  -- invite-media / event-docs: the folder must be one of the caller's own events
  return exists (select 1 from public.quotes q where q.id = v_folder and q.org_id = v_org);
end $$;
revoke all on function public.storage_key_ok(text, text) from public, anon;
grant execute on function public.storage_key_ok(text, text) to authenticated;

create or replace function public.storage_upload_allowed(p_bucket text, p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
  v_cap   int;
  n       int;
begin
  if not public.storage_key_ok(p_bucket, p_name) then return false; end if;
  v_cap := case p_bucket when 'invite-media' then 120 when 'event-docs' then 200 else null end;
  -- per-event object cap (the row being inserted is not counted yet)
  if v_cap is not null then
    select count(*) into n from storage.objects o
     where o.bucket_id = p_bucket and o.name like v_parts[1] || '/' || v_parts[2] || '/%';
    if n >= v_cap then return false; end if;
  end if;
  -- per-user upload frequency, all buckets
  select count(*) into n from storage.objects o
   where o.owner = auth.uid() and o.created_at > now() - interval '10 minutes';
  if n >= 100 then return false; end if;
  return true;
end $$;
revoke all on function public.storage_upload_allowed(text, text) from public, anon;
grant execute on function public.storage_upload_allowed(text, text) to authenticated;

-- =============================================================================
-- 3) invite-media: write / replace / delete need Invite Studio edit rights
--    (event_sites RLS = has_area('quotes','edit')); was: any member of the org.
--    Reads are unchanged (0013 org read + 0019 published-site read).
-- =============================================================================
-- legacy phase88 name for the same ungated insert (may still exist on prod/staging;
-- permissive policies are OR'd, so it would re-open the hole)
drop policy if exists "invite_media_org_insert" on storage.objects;
drop policy if exists "invite_media_org_write" on storage.objects;
create policy "invite_media_org_write" on storage.objects for insert to authenticated
  with check ( bucket_id = 'invite-media'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and public.has_area('quotes', 'edit')
               and public.storage_upload_allowed(bucket_id, name) );
drop policy if exists "invite_media_org_update" on storage.objects;
create policy "invite_media_org_update" on storage.objects for update to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and public.has_area('quotes', 'edit') )
  with check ( bucket_id = 'invite-media'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and public.has_area('quotes', 'edit')
               and public.storage_key_ok(bucket_id, name) );
drop policy if exists "invite_media_org_delete" on storage.objects;
create policy "invite_media_org_delete" on storage.objects for delete to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and public.has_area('quotes', 'edit') );

-- =============================================================================
-- 4) event-docs: keep the 0009 area gate, add key shape + caps on write
-- =============================================================================
drop policy if exists event_docs_insert on storage.objects;
create policy event_docs_insert on storage.objects for insert to authenticated
  with check ( bucket_id = 'event-docs'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit'))
               and public.storage_upload_allowed(bucket_id, name) );
drop policy if exists event_docs_update on storage.objects;
create policy event_docs_update on storage.objects for update to authenticated
  using ( bucket_id = 'event-docs'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit')) )
  with check ( bucket_id = 'event-docs'
               and (storage.foldername(name))[1] = (select public.current_org_id())::text
               and (public.has_area('quotes', 'edit') or public.has_area('media', 'edit'))
               and public.storage_key_ok(bucket_id, name) );
-- event_docs_select / event_docs_delete (0009) already require the area: unchanged.

-- =============================================================================
-- 5) chat-media: keep 0025 membership check, add key shape + per-user rate
-- =============================================================================
drop policy if exists chat_media_ins on storage.objects;
create policy chat_media_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'chat-media' and public.chat_media_visible(name)
               and public.storage_upload_allowed(bucket_id, name) );

-- =============================================================================
-- 6) metadata caps (NOT VALID: existing rows are never re-checked or touched)
-- =============================================================================
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_sites_photos_max'
                  and conrelid = 'public.event_sites'::regclass) then
    alter table public.event_sites add constraint event_sites_photos_max
      check (jsonb_typeof(data -> 'photos') is distinct from 'array'
             or jsonb_array_length(data -> 'photos') <= 60) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_files_filename_safe'
                  and conrelid = 'public.event_files'::regclass) then
    alter table public.event_files add constraint event_files_filename_safe
      check (char_length(filename) between 1 and 255 and filename !~ '[[:cntrl:]]') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_files_path_in_event'
                  and conrelid = 'public.event_files'::regclass) then
    alter table public.event_files add constraint event_files_path_in_event
      check (storage_path like org_id::text || '/' || quote_id::text || '/%') not valid;
  end if;
end $$;

-- =============================================================================
-- 7) PAYMENT MILESTONES: the paid transition is a money event — server functions only
--    (record_payment / record_settlement_payment / settle_milestone / mark_paid run as
--    their owner and pass). Non-paid schedule edits keep working for finance editors.
-- =============================================================================
create or replace function public.payment_milestones_paid_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.status = 'paid' then
      raise exception 'a milestone can only be marked paid by recording the payment' using errcode = '42501';
    elsif tg_op = 'UPDATE' and (old.status = 'paid' or new.status = 'paid') then
      raise exception 'a paid milestone can only change through the payment functions' using errcode = '42501';
    elsif tg_op = 'DELETE' and old.status = 'paid' then
      raise exception 'a paid milestone cannot be deleted' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public.payment_milestones_paid_guard() from public, anon, authenticated;
drop trigger if exists aa_milestone_paid_guard on public.payment_milestones;
create trigger aa_milestone_paid_guard before insert or update or delete on public.payment_milestones
  for each row execute function public.payment_milestones_paid_guard();

-- settle_milestone: the app's "mark this milestone paid" — writes the receipt to the
-- quote_payments ledger AND flips the milestone, under the per-quote money lock.
-- Same right as the old direct write (has_area finance edit), but the amount comes
-- from the milestone row (server), not the browser. The milestone flips BEFORE the
-- ledger row so the 0003 milestone guard does not count the same money twice.
create or replace function public.settle_milestone(
  p_milestone uuid, p_method text default 'cash', p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.payment_milestones; q public.quotes; existing public.quote_payments;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_method text := lower(coalesce(nullif(btrim(coalesce(p_method, '')), ''), 'cash'));
  rno text; seqn int; tries int := 0;
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones where id = p_milestone and org_id = public.current_org_id();
  if m.id is null then raise exception 'no such milestone' using errcode = '42501'; end if;
  perform public.assert_quote_org(m.quote_id);
  if v_method !~ '^[a-z_]{2,20}$' then raise exception 'unknown payment method' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || m.quote_id::text, 0));
  select * into q from public.quotes where id = m.quote_id and org_id = public.current_org_id() for update;
  select * into m from public.payment_milestones where id = p_milestone for update;   -- re-read under the lock

  if v_key is not null then
    select * into existing from public.quote_payments where quote_id = m.quote_id and idempotency_key = v_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'milestone', m.id, 'idempotent_replay', true);
    end if;
  end if;
  if m.status = 'paid'   then raise exception 'this milestone is already paid' using errcode = '23514'; end if;
  if m.status = 'waived' then raise exception 'this milestone was waived — change it back to due first' using errcode = '23514'; end if;
  if not (coalesce(m.amount, 0) > 0) then raise exception 'amount must be greater than zero' using errcode = '23514'; end if;

  update public.payment_milestones set status = 'paid', paid_at = now() where id = m.id;

  loop
    tries := tries + 1;
    select count(*) + 1 into seqn from public.quote_payments where quote_id = m.quote_id and status = 'paid';
    rno := 'RCP-' || q.code || '-' || lpad(seqn::text, 2, '0') || case when tries > 1 then '-' || tries::text else '' end;
    begin
      insert into public.quote_payments(quote_id, org_id, provider, amount, status, provider_ref, receipt_no, method,
                                        simulated, paid_at, note, idempotency_key)
        values (m.quote_id, q.org_id, v_method, m.amount, 'paid', rno, rno, v_method,
                (v_method <> 'cash'), now(), left('Milestone: ' || coalesce(m.label, ''), 200), v_key);
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  update public.quotes set updated_at = now() where id = m.quote_id and org_id = public.current_org_id();

  return jsonb_build_object('receipt_no', rno, 'amount', m.amount, 'method', v_method, 'milestone', m.id);
end $$;
revoke all on function public.settle_milestone(uuid, text, text) from public, anon;
grant execute on function public.settle_milestone(uuid, text, text) to authenticated;

-- =============================================================================
-- 8) PAYMENT LINKS (create-payment-link Edge Function, service role only)
--    One open live link per quote: begin() reserves a 'created' row under the
--    per-quote money lock (a second caller gets 'busy' or the reusable link), the
--    function then calls Razorpay and attach()es the plink id + URL; on failure it
--    fail()s the reservation. A changed total supersedes (cancels) the old links and
--    returns their plink ids so the function can cancel them at Razorpay too.
-- =============================================================================
alter table public.quote_payments add column if not exists link_expires_at timestamptz;
-- the Razorpay payment id (pay_…) that settled a row: webhook replay detection
alter table public.quote_payments add column if not exists provider_payment_ref text;
create unique index if not exists quote_payments_provider_payment_uk
  on public.quote_payments (provider, provider_payment_ref) where provider_payment_ref is not null;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes int default 4320)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes; open_row public.quote_payments; v_total numeric; v_super jsonb;
  v_id uuid; v_exp timestamptz;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null or q.approval_token_revoked_at is not null
     or (q.approval_token_expires_at is not null and q.approval_token_expires_at <= now()) then
    return jsonb_build_object('action', 'invalid');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || q.id::text, 0));
  select * into q from public.quotes where id = q.id for update;
  if q.approval_status = 'paid' then return jsonb_build_object('action', 'paid'); end if;
  if q.approval_status is distinct from 'approved' then return jsonb_build_object('action', 'not_approved'); end if;
  begin v_total := round((q.pricing ->> 'total')::numeric, 2); exception when others then v_total := null; end;
  if v_total is null or v_total = 'NaN'::numeric or v_total <= 0 or v_total > 100000000 then
    return jsonb_build_object('action', 'nothing_due');
  end if;

  select * into open_row from public.quote_payments
   where quote_id = q.id and provider = 'razorpay' and status = 'created' and simulated = false
   order by created_at desc limit 1;
  if open_row.id is not null then
    if open_row.provider_ref is null and open_row.created_at > now() - interval '2 minutes' then
      return jsonb_build_object('action', 'busy');          -- another request is creating it right now
    end if;
    if open_row.amount = v_total
       and coalesce(open_row.provider_ref, '') ~ '^plink_[A-Za-z0-9]+$'
       and coalesce(open_row.link_url, '') ~ '^https://rzp\.io/[A-Za-z0-9/_-]+$'
       and (open_row.link_expires_at is null or open_row.link_expires_at > now() + interval '15 minutes') then
      return jsonb_build_object('action', 'reuse', 'link_url', open_row.link_url, 'amount', v_total);
    end if;
  end if;

  -- supersede every other open link of this quote (stale amount / expired / stuck)
  with c as (
    update public.quote_payments set status = 'cancelled'
     where quote_id = q.id and status = 'created'
    returning provider, provider_ref
  )
  select coalesce(jsonb_agg(provider_ref) filter (where provider = 'razorpay'
                  and coalesce(provider_ref, '') ~ '^plink_[A-Za-z0-9]+$'), '[]'::jsonb)
    into v_super from c;

  v_exp := now() + make_interval(mins => greatest(20, least(coalesce(p_ttl_minutes, 4320), 43200)));
  if q.approval_token_expires_at is not null and q.approval_token_expires_at < v_exp then
    v_exp := greatest(q.approval_token_expires_at, now() + interval '20 minutes');
  end if;
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, link_expires_at)
    values (q.id, q.org_id, 'razorpay', v_total, 'created', false, v_exp)
    returning id into v_id;
  return jsonb_build_object('action', 'create', 'payment_id', v_id, 'quote_id', q.id, 'org_id', q.org_id,
    'code', q.code, 'amount', v_total, 'expire_by', floor(extract(epoch from v_exp))::bigint,
    'client', coalesce(q.client, '{}'::jsonb), 'supersede', v_super);
end $$;

create or replace function public.payment_link_attach(p_payment uuid, p_provider_ref text, p_link_url text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if coalesce(p_provider_ref, '') !~ '^plink_[A-Za-z0-9]+$'
     or coalesce(p_link_url, '') !~ '^https://rzp\.io/[A-Za-z0-9/_-]+$' then
    return false;
  end if;
  update public.quote_payments set provider_ref = p_provider_ref, link_url = p_link_url
   where id = p_payment and status = 'created' and provider = 'razorpay' and provider_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.payment_link_fail(p_payment uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.quote_payments set status = 'failed'
   where id = p_payment and status = 'created' and provider = 'razorpay' and provider_ref is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

revoke all on function public.payment_link_begin(uuid, int)        from public, anon, authenticated;
revoke all on function public.payment_link_attach(uuid, text, text) from public, anon, authenticated;
revoke all on function public.payment_link_fail(uuid)              from public, anon, authenticated;
grant execute on function public.payment_link_begin(uuid, int)        to service_role;
grant execute on function public.payment_link_attach(uuid, text, text) to service_role;
grant execute on function public.payment_link_fail(uuid)              to service_role;

-- =============================================================================
-- 9) PAYMENT RECONCILIATION — money the webhook could not apply (quote already paid,
--    amount short of the total, paid link superseded). Written by razorpay-webhook
--    (service role); finance viewers of the studio can read it; refunds are manual.
-- =============================================================================
create table if not exists public.payment_reconciliation (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  quote_id uuid references public.quotes(id) on delete set null,
  provider text not null default 'razorpay',
  provider_event text,
  provider_link_ref text,
  provider_payment_ref text,
  amount_paise bigint,
  expected_paise bigint,
  reason text not null,
  status text not null default 'open',
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  constraint payment_reconciliation_reason_check
    check (reason in ('already_paid', 'amount_mismatch', 'superseded_link', 'overpayment', 'unmatched')),
  constraint payment_reconciliation_status_check check (status in ('open', 'refunded', 'resolved'))
);
create unique index if not exists payment_reconciliation_payment_uk
  on public.payment_reconciliation (provider, provider_payment_ref) where provider_payment_ref is not null;
create index if not exists payment_reconciliation_org_idx on public.payment_reconciliation (org_id, status);
alter table public.payment_reconciliation enable row level security;
revoke all on public.payment_reconciliation from anon, authenticated;
grant select on public.payment_reconciliation to authenticated;
grant all on public.payment_reconciliation to service_role;
drop policy if exists payment_reconciliation_read on public.payment_reconciliation;
create policy payment_reconciliation_read on public.payment_reconciliation for select to authenticated
  using ( public.has_area('finance', 'view') and org_id = (select public.current_org_id()) );
drop trigger if exists zz_quote_org_match on public.payment_reconciliation;
create trigger zz_quote_org_match before insert or update on public.payment_reconciliation
  for each row execute function public.tg_quote_org_match();

-- finance editors close an item once the refund / reconciliation is done (no deletes)
create or replace function public.resolve_payment_reconciliation(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('refunded', 'resolved') then raise exception 'status must be refunded or resolved' using errcode = '22023'; end if;
  update public.payment_reconciliation
     set status = p_status, resolved_at = now(), resolved_by = auth.uid(), note = left(nullif(btrim(coalesce(p_note, '')), ''), 500)
   where id = p_id and org_id = public.current_org_id() and status = 'open';
  if not found then raise exception 'no such open item' using errcode = '42501'; end if;
end $$;
revoke all on function public.resolve_payment_reconciliation(uuid, text, text) from public, anon;
grant execute on function public.resolve_payment_reconciliation(uuid, text, text) to authenticated;

-- razorpay_settle — the webhook's whole decision in ONE transaction under the per-quote
-- money lock (service role only). Returns {result: settled | replay | reconcile |
-- unmatched}. Money is never dropped: a payment that cannot settle the quote (already
-- paid, short of the total, on a superseded link, or over the balance) is recorded in
-- payment_reconciliation for a refund / manual match. The quote is resolved from the
-- link's provider_ref first; notes.quote_id is only a fallback.
create or replace function public.razorpay_settle(
  p_quote uuid, p_link_ref text, p_payment_ref text, p_paid_paise bigint, p_event text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.quotes; v_quote uuid := p_quote; v_map public.quote_payments; v_row uuid;
  v_exp bigint; v_reason text;
  v_pay text := nullif(btrim(coalesce(p_payment_ref, '')), '');
  v_link text := nullif(btrim(coalesce(p_link_ref, '')), '');
begin
  if v_link is not null then
    select * into v_map from public.quote_payments
     where provider = 'razorpay' and provider_ref = v_link order by created_at desc limit 1;
    if v_map.id is not null then v_quote := v_map.quote_id; end if;
  end if;
  if v_quote is null then return jsonb_build_object('result', 'unmatched'); end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || v_quote::text, 0));
  select * into q from public.quotes where id = v_quote for update;
  if q.id is null then return jsonb_build_object('result', 'unmatched'); end if;

  -- at-least-once delivery: the same payment id is applied exactly once
  if v_pay is not null and (
       exists (select 1 from public.quote_payments where provider = 'razorpay' and provider_payment_ref = v_pay)
    or exists (select 1 from public.payment_reconciliation where provider = 'razorpay' and provider_payment_ref = v_pay)) then
    return jsonb_build_object('result', 'replay', 'quote_id', q.id, 'org_id', q.org_id);
  end if;

  begin v_exp := round(coalesce((q.pricing ->> 'total')::numeric, 0) * 100); exception when others then v_exp := null; end;
  if q.approval_status = 'paid' then v_reason := 'already_paid';
  elsif v_map.id is not null and v_map.status is distinct from 'created' then v_reason := 'superseded_link';
  elsif p_paid_paise is null or v_exp is null or v_exp <= 0 or p_paid_paise < v_exp then v_reason := 'amount_mismatch';
  end if;

  if v_reason is null then
    if v_map.id is not null then
      v_row := v_map.id;
    else
      select id into v_row from public.quote_payments
       where quote_id = q.id and provider = 'razorpay' and status = 'created' and simulated = false
       order by created_at desc limit 1;
    end if;
    begin
      if v_row is not null then
        update public.quote_payments set status = 'paid', paid_at = now(), provider_payment_ref = v_pay where id = v_row;
      else
        insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, paid_at, provider_payment_ref)
          values (q.id, q.org_id, 'razorpay', round(v_exp / 100.0, 2), 'paid', false, now(), v_pay);
      end if;
    exception when check_violation then
      v_reason := 'overpayment';            -- 23514 from the 0003 overpayment guard
    end;
  end if;

  if v_reason is not null then
    insert into public.payment_reconciliation(org_id, quote_id, provider, provider_event, provider_link_ref,
                                              provider_payment_ref, amount_paise, expected_paise, reason)
      values (q.org_id, q.id, 'razorpay', left(p_event, 60), v_link, v_pay, p_paid_paise, v_exp, v_reason)
      on conflict do nothing;
    return jsonb_build_object('result', 'reconcile', 'reason', v_reason, 'quote_id', q.id, 'org_id', q.org_id);
  end if;

  -- the paid link wins; every other open link of the quote is cancelled
  update public.quote_payments set status = 'cancelled' where quote_id = q.id and status = 'created';
  update public.quotes set approval_status = 'paid', updated_at = now() where id = q.id;
  return jsonb_build_object('result', 'settled', 'quote_id', q.id, 'org_id', q.org_id);
end $$;
revoke all on function public.razorpay_settle(uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.razorpay_settle(uuid, text, text, bigint, text) to service_role;

-- =============================================================================
-- 10) MESSAGING: channel log, per-studio rate counter, recipient + sender checks
-- =============================================================================
-- WhatsApp sends were logged with channel 'whatsapp', which the CHECK rejected (the
-- insert failed silently). Widen the set additively; existing rows already satisfy it.
alter table public.notifications drop constraint if exists notifications_channel_check;
alter table public.notifications add constraint notifications_channel_check
  check (channel = any (array['sms', 'email', 'in_app', 'whatsapp'])) not valid;

create table if not exists public.messaging_rate (
  org_id uuid not null,
  channel text not null,
  window_secs int not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (org_id, channel, window_secs, window_start)
);
alter table public.messaging_rate enable row level security;   -- no policy: server only
revoke all on public.messaging_rate from anon, authenticated;
grant all on public.messaging_rate to service_role;

-- counts one send for (org, channel) in the current fixed window; true while under the limit
create or replace function public.messaging_rate_hit(p_org uuid, p_channel text, p_limit int, p_window_secs int default 3600)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_start timestamptz; v_hits int; v_win int := greatest(60, coalesce(p_window_secs, 3600));
begin
  if p_org is null or coalesce(p_channel, '') = '' or coalesce(p_limit, 0) <= 0 then return false; end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / v_win) * v_win);
  insert into public.messaging_rate as r (org_id, channel, window_secs, window_start, hits)
    values (p_org, p_channel, v_win, v_start, 1)
    on conflict (org_id, channel, window_secs, window_start) do update set hits = r.hits + 1
    returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
revoke all on function public.messaging_rate_hit(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.messaging_rate_hit(uuid, text, int, int) to service_role;

-- phone → digits with country code (Indian 10-digit / 0-prefixed → 91…; 00… → …)
create or replace function public.helm_norm_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when d ~ '^[0-9]{10}$'      then '91' || d
           when d ~ '^0[0-9]{10}$'     then '91' || substr(d, 2)
           when d ~ '^00[0-9]{8,15}$'  then substr(d, 3)
           else d
         end
    from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) s;
$$;
grant execute on function public.helm_norm_phone(text) to anon, authenticated, service_role;

-- send-whatsapp, called with the CALLER's JWT: may this user message this number for
-- this event? (quotes edit right, own studio's event, number belongs to the event —
-- client, a crew link holder, or a vendor booked on it — and the studio is under its
-- hourly WhatsApp limit). Returns the normalized number to send to.
create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.quotes; v_to text := public.helm_norm_phone(p_recipient);
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode = '42501'; end if;
  if v_to !~ '^[0-9]{10,15}$' then raise exception 'invalid number' using errcode = '22023'; end if;
  if not (
       public.helm_norm_phone(q.client ->> 'phone') = v_to
    or exists (select 1 from public.work_tokens w where w.quote_id = q.id and public.helm_norm_phone(w.phone) = v_to)
    or exists (select 1 from public.event_resources r join public.vendors v on v.id = r.vendor_id
                where r.quote_id = q.id and v.org_id = q.org_id and public.helm_norm_phone(v.phone) = v_to)
  ) then
    raise exception 'that number is not on this event' using errcode = '42501';
  end if;
  if not public.messaging_rate_hit(q.org_id, 'whatsapp', 100, 3600) then
    raise exception 'whatsapp limit reached for this studio — try again later' using errcode = 'HL429';
  end if;
  return jsonb_build_object('ok', true, 'to', v_to, 'org_id', q.org_id, 'quote_id', q.id);
end $$;
revoke all on function public.whatsapp_authorize(uuid, text) from public, anon;
grant execute on function public.whatsapp_authorize(uuid, text) to authenticated;

-- send-otp (service role): the OTP goes to the client phone on file when there is one;
-- otherwise only to an Indian mobile. Per-studio daily SMS cap. Returns where to send.
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.quotes; v_to text := public.helm_norm_phone(p_phone); v_file text;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null or q.approval_token_revoked_at is not null
     or (q.approval_token_expires_at is not null and q.approval_token_expires_at <= now()) then
    raise exception 'invalid link' using errcode = 'HL404';
  end if;
  v_file := public.helm_norm_phone(q.client ->> 'phone');
  if v_file <> '' then
    if v_to is distinct from v_file then raise exception 'phone not on file' using errcode = 'HL403'; end if;
  elsif v_to !~ '^91[6-9][0-9]{9}$' then
    raise exception 'invalid phone' using errcode = 'HL400';
  end if;
  if not public.messaging_rate_hit(q.org_id, 'sms', 200, 86400) then
    raise exception 'sms limit reached' using errcode = 'HL429';
  end if;
  return jsonb_build_object('quote_id', q.id, 'org_id', q.org_id, 'mobile', v_to);
end $$;
revoke all on function public.otp_send_authorize(uuid, text) from public, anon, authenticated;
grant execute on function public.otp_send_authorize(uuid, text) to service_role;

-- ---- VERIFY -------------------------------------------------------------------
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;   -- all public=false
-- select policyname, cmd from pg_policies where schemaname='storage' and policyname like 'invite_media%';
--   expect exactly: invite_media_org_read / _published_read (select), _org_write (insert),
--   _org_update, _org_delete. ANY other permissive write policy on storage.objects that
--   mentions invite-media / event-docs (dashboard-made) must be dropped by hand.
-- select tgname from pg_trigger where tgrelid='public.payment_milestones'::regclass and tgname='aa_milestone_paid_guard';
-- select has_function_privilege('authenticated','public.payment_link_begin(uuid,int)','EXECUTE');      -- false
-- select has_function_privilege('authenticated','public.messaging_rate_hit(uuid,text,int,int)','EXECUTE'); -- false

-- ═══════════════════ PART C — Login + password hardening (0028) ═══════════════════
-- ============================================================================
-- 0028_auth_hardening.sql — CANONICAL forward-only. Security audit Phase 3-4
-- follow-up (Authentication + Session Management).
--
-- What this changes, in plain words:
--   1. Studio admins creating a user (Control Center) must now give a password of
--      at least 12 characters with a letter and a number. Passwords are stored
--      with bcrypt cost 12 (was the pgcrypto default, cost 6).
--   2. Creating a user whose email already belongs to ANOTHER studio no longer says
--      "a user with that email already exists" — a studio admin could use that to
--      test which emails have Helm accounts anywhere on the platform. They now get
--      a generic "could not create this user" message. Inside the admin's own
--      studio the clear "already a user in your studio" message is kept.
--   3. One-time (temp) passwords now always meet the rule above, and the
--      "must change your password" flag can only be cleared AFTER the password was
--      really changed (it used to be clearable by calling the RPC directly).
--   4. New helpers: public.mfa_ok() (server-side two-step-verification check, NOT
--      yet used by any policy — see note at the end) and public.my_auth_info()
--      (the caller's OWN last sign-in time, two-step status and recent sessions,
--      for the account panel).
--
-- Drift-safe: admin_create_user is NOT rewritten. Whatever body the target
-- database has (canonical base-v1 or a drifted prod copy) is RENAMED to
-- public._admin_create_user_core (kept private) and a thin wrapper with the new
-- checks calls it. Every existing behaviour (org placement, role validation,
-- identities row, profile upsert) is preserved exactly. The rename happens once
-- (marker check), so re-running this file is a no-op.
-- Additive + idempotent. No rows are changed or deleted (except the temp-password
-- bookkeeping table this file creates).
-- ============================================================================

-- ---- 1) password rule (one place) -------------------------------------------
create or replace function public._password_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and length(p) >= 12 and p ~ '[A-Za-z]' and p ~ '[0-9]'
$$;
revoke all on function public._password_ok(text) from public, anon, authenticated;

-- ---- 2) keep the existing admin_create_user body as the private core ---------
do $$
begin
  if to_regprocedure('public._admin_create_user_core(text,text,text)') is null
     and to_regprocedure('public.admin_create_user(text,text,text)') is not null
     and pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) not like '%auth-hardening-0028%' then
    alter function public.admin_create_user(text, text, text) rename to _admin_create_user_core;
  end if;
end $$;
-- the core still carries its own is_admin() check, but nobody may call it directly
do $$
begin
  if to_regprocedure('public._admin_create_user_core(text,text,text)') is not null then
    revoke all on function public._admin_create_user_core(text, text, text) from public, anon, authenticated;
  end if;
end $$;

-- ---- 3) the hardened entry point (same name + signature the app calls) -------
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: password rule + bcrypt cost 12 + no cross-tenant email oracle
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role using errcode = '22023'; end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'invalid email' using errcode = '22023'; end if;
  if not public._password_ok(p_password) then
    raise exception 'password must be at least 12 characters and include a letter and a number' using errcode = '22023';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is not null then
    -- Only reveal what the admin can already see: members of their own studio.
    if exists (select 1 from public.profiles p where p.id = v_uid and p.org_id = public.current_org_id()) then
      raise exception 'this person is already a user in your studio' using errcode = '23505';
    end if;
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;

  v_uid := public._admin_create_user_core(v_email, p_password, p_role);
  -- re-hash at bcrypt cost 12 (pgcrypto supports bf cost 4..31)
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = v_uid;
  return v_uid;
end $$;
revoke all on function public.admin_create_user(text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

-- ---- 4) temp passwords: always policy-compliant; flag clearable only after a real change
create table if not exists public.auth_temp_passwords (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  pw_hash    text not null,                 -- the temp password's hash as issued
  created_at timestamptz not null default now()
);
alter table public.auth_temp_passwords enable row level security;
revoke all on public.auth_temp_passwords from public, anon, authenticated;

create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028
declare v_uid uuid; v_temp text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 16 random base64 chars (96 bits) + a fixed letter pair + one random digit:
  -- always >= 12 chars with a letter and a digit.
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text;
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  update public.profiles set must_change_password = true where id = v_uid;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;
revoke all on function public.admin_create_user_temp(text, text) from public, anon;
grant execute on function public.admin_create_user_temp(text, text) to authenticated;

create or replace function public.clear_password_change_required()
returns void language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: refuse while the account still has the temp password it was issued
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if exists (select 1 from public.auth_temp_passwords t join auth.users u on u.id = t.user_id
              where t.user_id = auth.uid() and u.encrypted_password = t.pw_hash) then
    raise exception 'set a new password first' using errcode = '42501';
  end if;
  update public.profiles set must_change_password = false where id = auth.uid();
  delete from public.auth_temp_passwords where user_id = auth.uid();
end $$;
revoke all on function public.clear_password_change_required() from public, anon;
grant execute on function public.clear_password_change_required() to authenticated;

-- ---- 5) mfa_ok(): server-side two-step check (helper only — see note) --------
-- true when the caller's token is aal2, or the caller has NO verified factor.
create or replace function public.mfa_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then return true; end if;
  if auth.uid() is null then return true; end if;
  return not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status::text = 'verified');
end $$;
revoke all on function public.mfa_ok() from public;
grant execute on function public.mfa_ok() to anon, authenticated;

-- ---- 6) my_auth_info(): the caller's OWN sign-in details for the account panel
create or replace function public.my_auth_info()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; s jsonb;
begin
  if auth.uid() is null then return null; end if;
  select jsonb_build_object(
           'last_sign_in_at', u.last_sign_in_at,
           'created_at',      u.created_at,
           'mfa_enabled',     exists (select 1 from auth.mfa_factors f
                                       where f.user_id = u.id and f.status::text = 'verified'))
    into v from auth.users u where u.id = auth.uid();
  begin
    select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into s from (
      select jsonb_build_object('created_at', ss.created_at, 'updated_at', ss.updated_at,
                                'user_agent', left(coalesce(ss.user_agent, ''), 200),
                                'ip', host(ss.ip), 'aal', ss.aal::text) as x
        from auth.sessions ss where ss.user_id = auth.uid()
       order by ss.created_at desc limit 10) q;
  exception when undefined_table or undefined_column then s := null;   -- older GoTrue: no session list
  end;
  return v || jsonb_build_object('sessions', s);
end $$;
revoke all on function public.my_auth_info() from public, anon;
grant execute on function public.my_auth_info() to authenticated;

-- ---- NOTE (not applied): server-side MFA backstop ---------------------------
-- The browser gate already sends anyone with a verified factor back to the
-- two-step screen until their session is aal2. To make the DATABASE refuse an
-- aal1 token as well, add `and public.mfa_ok()` to RESTRICTIVE policies, e.g.
--   create policy mfa_gate on public.quotes as restrictive for all to authenticated
--     using (public.mfa_ok()) with check (public.mfa_ok());
-- That is deliberately NOT done here: it touches every table's access path and
-- must be rolled out table-by-table with tests on staging first.
-- Verify after apply (read-only):
--   select pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) like '%auth-hardening-0028%';
--   select to_regprocedure('public._admin_create_user_core(text,text,text)') is not null;

-- ════════════════════════════════ VERIFY (one table — every row must say ok) ═══
select item, case when ok then 'ok' else 'PROBLEM' end as status from (values
  ('A money: NaN / infinity / negative amounts refused (new rows)',
     (select count(*) from pg_constraint where contype = 'c' and not convalidated and connamespace = 'public'::regnamespace) >= 80),
  ('A quote total + payment wrappers in place',
     to_regproc('public.helm_quote_total__base') is not null and to_regproc('public.create_payment__base') is not null
     and to_regproc('public.mark_paid__base') is not null),
  ('A events with receipts/consents/refunds cannot be deleted',
     exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'aa_quote_delete_guard')),
  ('A OTP: secure random codes + 5-try lockout kept',
     exists (select 1 from pg_proc where proname = 'request_otp' and pronamespace = 'public'::regnamespace and position('gen_random_bytes' in prosrc) > 0)
     and exists (select 1 from pg_proc where proname = 'verify_and_consent' and pronamespace = 'public'::regnamespace and position('for update' in lower(prosrc)) > 0)),
  ('A one studio cannot link to another studio''s crew/vendors/stock',
     (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'tg_ref_org_match') >= 10),
  ('A consent records what was approved; refunds need a second person',
     exists (select 1 from pg_trigger where tgrelid = 'public.quote_consents'::regclass and tgname = 'ab_consent_snapshot')
     and exists (select 1 from pg_trigger where tgrelid = 'public.event_refunds'::regclass and tgname = 'ab_refund_maker_checker')),
  ('A visitors and members cannot TRUNCATE tables',
     not has_table_privilege('authenticated', 'public.quotes', 'TRUNCATE')
     and not has_table_privilege('anon', 'public.audit_log', 'TRUNCATE')),
  ('B milestones are marked paid only through Settle',
     exists (select 1 from pg_trigger where tgrelid = 'public.payment_milestones'::regclass and tgname = 'aa_milestone_paid_guard')
     and to_regproc('public.settle_milestone') is not null),
  ('B only editors can change invitation photos; upload limits on',
     exists (select 1 from pg_policies where schemaname = 'storage' and policyname = 'invite_media_org_write' and with_check like '%has_area%')
     and to_regproc('public.storage_upload_allowed') is not null),
  ('B upload buckets stay private',
     not exists (select 1 from storage.buckets where id in ('invite-media','chat-media','event-docs') and public)),
  ('B payments: one link at a time + reconciliation list',
     to_regproc('public.payment_link_begin') is not null and to_regproc('public.razorpay_settle') is not null
     and to_regclass('public.payment_reconciliation') is not null),
  ('B WhatsApp / SMS: only event contacts, with limits',
     to_regproc('public.whatsapp_authorize') is not null and to_regproc('public.otp_send_authorize') is not null
     and to_regclass('public.messaging_rate') is not null),
  ('C passwords: 12+ chars with a letter and a number, strong hashing',
     to_regproc('public._password_ok') is not null and to_regproc('public._admin_create_user_core') is not null),
  ('C temp passwords must really be changed',
     to_regclass('public.auth_temp_passwords') is not null
     and not has_table_privilege('authenticated', 'public.auth_temp_passwords', 'SELECT')),
  ('C account page helpers installed (last sign-in, two-step status)',
     to_regproc('public.my_auth_info') is not null and to_regproc('public.mfa_ok') is not null)
) v(item, ok);
