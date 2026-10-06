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
-- Replace ONLY if the database still has the old body (no row lock / persisted attempts). Production already has its own hardened version — keep it.
do $guard$ begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'verify_and_consent' and position('for update' in lower(prosrc)) > 0 and position('attempts + 1' in prosrc) > 0) then
    execute $sql$
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
end; $function$
$sql$;
  end if;
end $guard$;
revoke all on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) from public;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated, service_role;

-- ============================================================================
-- 4) request_otp: cryptographically secure, uniform 6-digit code
--    (rejection sampling over 32 random bits from pgcrypto's gen_random_bytes).
-- ============================================================================
-- Replace ONLY if the database still generates codes with random(). Production already uses gen_random_bytes — keep its body.
do $guard$ begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'request_otp' and position('gen_random_bytes' in prosrc) > 0) then
    execute $sql$
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
end; $function$
$sql$;
  end if;
end $guard$;
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
