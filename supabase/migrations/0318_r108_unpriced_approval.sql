-- 0318_r108_unpriced_approval.sql - CANONICAL forward-only. R108 (owner, live client approval page).
--
-- In plain words:
--   A quote with no price (total missing or <= 0) could be approved by the client ("Total payable Rs 0").
--   1) NEW BEFORE INSERT trigger zz_r318_consent_priced on quote_consents refuses the consent row with a friendly HL409
--      message ("This quote isn't ready yet - it has no price. Please contact <Studio>."), hint quote_not_priced. Every
--      client approval path (SMS code, e-mail / WhatsApp code, trial Test mode confirm) writes its consent through
--      verify_and_consent, so one guard covers them all without re-wrapping any of those functions. App calls only
--      (anon / authenticated / service_role); SQL typed by hand in the SQL editor is not affected. The whole call rolls
--      back, so the code is not used up and the quote is unchanged.
--   2) NEW public RPC public_quote_ready(token) -> { priced, studio } so the approval page shows "Quote not priced yet -
--      please contact <Studio>" instead of the Approve steps, and send-otp sends no code for an unpriced quote.
-- ZERO DATA LOSS: two NEW functions, one NEW trigger function, one NEW trigger. No table / column / row / policy / index
-- changed or deleted; existing consents and quotes untouched (the trigger only looks at NEW consent rows).
-- Additive + idempotent: safe to run twice. ASCII only. Goes after 0260 + 0311.
-- ROLLBACK (manual, only if ever needed): drop trigger zz_r318_consent_priced on public.quote_consents;
--   revoke execute on function public.public_quote_ready(uuid) from anon, authenticated;

-- ---- 1) preflight -----------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.quotes') is null or to_regclass('public.quote_consents') is null or to_regclass('public.organizations') is null then
    raise exception 'STOP 0318: quotes / quote_consents / organizations missing'; end if;
  if to_regprocedure('public._r311_app_call()') is null then
    raise exception 'STOP 0318: _r311_app_call() missing - run 0311 first'; end if;
  if to_regprocedure('public._a260_quote_cancelled(uuid)') is null then
    raise exception 'STOP 0318: _a260_quote_cancelled(uuid) missing - run 0260 first'; end if;
end $$;

-- ---- 2) "does this quote have a price" (shared by the trigger and the RPC; not callable by the app) --------------
create or replace function public._r318_quote_priced(p_pricing jsonb)
returns boolean language sql immutable set search_path = '' as $$
  -- r108-approval-0318: priced = a numeric pricing.total above zero (the server stamps it, helm_quote_total)
  select case when jsonb_typeof(p_pricing) = 'object'
               and btrim(coalesce(p_pricing ->> 'total', '')) ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$'
              then btrim(p_pricing ->> 'total')::numeric > 0
              else false end;
$$;

-- ---- 3) public: is this link's quote ready to approve (priced) + the studio name ---------------------------------
create or replace function public.public_quote_ready(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r108-approval-0318: { priced, studio } only - never a price, address, phone or id. Unknown / expired / revoked /
-- deleted / cancelled link -> null. The studio name is the one the client portal already shows for the same link.
declare v_q uuid; v_org uuid; v_pricing jsonb; v_studio text;
begin
  if p_token is null then return null; end if;
  select q.id, q.org_id, q.pricing into v_q, v_org, v_pricing
    from public.quotes q
   where q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
     and q.deleted_at is null
   limit 1;
  if v_q is null or coalesce(public._a260_quote_cancelled(v_q), false) then return null; end if;
  select nullif(btrim(coalesce(o.name, '')), '') into v_studio from public.organizations o where o.id = v_org;
  return jsonb_build_object('priced', public._r318_quote_priced(v_pricing), 'studio', left(coalesce(v_studio, ''), 120));
end $$;

revoke all on function public._r318_quote_priced(jsonb) from public;
revoke all on function public.public_quote_ready(uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.public_quote_ready(uuid) to %I', r);
      if r <> 'service_role' then execute format('revoke all on function public._r318_quote_priced(jsonb) from %I', r); end if;
    end if;
  end loop;
end $$;

-- ---- 4) no client approval of a quote without a price ----------------------------------------------------------
create or replace function public._r318_tg_consent_priced()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r108-approval-0318: a consent row needs a priced quote (all approval paths insert through verify_and_consent).
-- App calls only (anon / authenticated / service_role, _r311_app_call); SQL by hand in the editor stays free.
declare v_pricing jsonb; v_studio text;
begin
  if not public._r311_app_call() then return new; end if;
  select q.pricing, nullif(btrim(coalesce(o.name, '')), '') into v_pricing, v_studio
    from public.quotes q left join public.organizations o on o.id = q.org_id
   where q.id = new.quote_id;
  if not found then return new; end if;                 -- the FK / caller decides about a missing quote
  if not public._r318_quote_priced(v_pricing) then
    raise exception '%', 'This quote isn''t ready yet - it has no price. Please contact '
        || coalesce(left(v_studio, 120), 'your planner') || '.'
      using errcode = 'HL409', hint = 'quote_not_priced';
  end if;
  return new;
end $$;
revoke all on function public._r318_tg_consent_priced() from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r318_tg_consent_priced() from %I', r); end if;
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.quote_consents'::regclass
                   and t.tgname = 'zz_r318_consent_priced' and not t.tgisinternal) then
    create trigger zz_r318_consent_priced before insert on public.quote_consents
      for each row execute function public._r318_tg_consent_priced();
  end if;
end $$;

notify pgrst, 'reload schema';
