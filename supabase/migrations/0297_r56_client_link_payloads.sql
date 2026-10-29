-- 0297_r56_client_link_payloads.sql - CANONICAL forward-only.
-- REQUIRES 0012 / 0039 / 0042 / 0052 / 0260 (public_get_quote, public_get_proposal, public_get_portal wrappers),
--          0050 (auth_rate_hits, rate_hit), 0083 / 0095 / 0260 (public_get_booklet_image), 0262 (public_quote_validity,
--          _qv262_quote_for), 0039 (approval_link_age_until, link_age_expired), 0260 (_a260_link_state),
--          phase29 / phase57 (has_area, current_org_id).
--
-- In plain words (r56, audit 2026-10-28 group C):
--   C-01 (High) The approval link (approve / portal page) and the proposal link answered the quote's WHOLE pricing
--        record. The staff screens copy the whole client record into it, so anyone holding the link (a proposal link
--        is meant to be forwarded on WhatsApp) could read the staff-only Notes ("Anything to remember..."), the
--        client's e-mail, phone, address, company, tax number and the lead's budget, plus internal fields (rate
--        snapshot, auto-priced extras). Now both answer an ALLOW-LIST, the same idea as the booklet link:
--          * price inputs and totals the pages print (chairs, rates, guests, catering mode / amount, other,
--            service charge, discount, coupon kind / value, tax rate / country / name / inclusive / exempt, place of
--            supply, currency, subtotal, total + the client-facing computed lines),
--          * approval link: the client's NAME only (+ couple names, event type and date, which the page title uses),
--          * proposal link: no client details inside pricing at all (the page shows "For <name>" from client_name).
--        Notes, e-mail, phone, address, company, tax number, budget, internal costs / margins / rate snapshots and
--        every key not on the list never leave.
--   C-04 (Low) The booklet picture reader and the quote "valid until" reader wrote a rate-limit row for EVERY random
--        token before looking it up (and answered null, so the row stayed): an anonymous caller could grow
--        auth_rate_hits without limit. Now the token is looked up first and only a real link is counted (the 0156
--        rule). Plus a daily purge of rate-limit rows older than 2 days: the longest window rate_hit accepts is 1 day,
--        so such a row is already expired and the next hit would reset it anyway - deleting it changes nothing.
--   C-05 (Low) The portal link answered the studio's whole brand settings (minus billing). Now only the accent
--        colour (the one thing the page uses).
--   C-02 (Medium) "Send by e-mail" (client-mailer) must be allowed only for people who may EDIT quotes, like WhatsApp.
--        NEW client_mailer_check(quote, kind): signed-in, own studio, has_area('quotes','edit'), quote not deleted;
--        for the approval kind it also says whether the link is still live (C-03: never e-mail an expired link).
-- ZERO DATA LOSS: four functions re-issued as thin wrappers (same names, arguments, grants); each previous body kept
-- once as <name>__pre0297 with no API privilege. Two NEW helpers (no API privilege) and NEW client_mailer_check
-- (signed-in users). The only rows ever deleted are EXPIRED rate-limit counters (auth_rate_hits, older than 2 days).
-- No table, column, policy or index is created, changed or dropped. Additive + idempotent: safe to run twice. ASCII.
-- ROLLBACK (manual, per function, only if ever needed): alter function public.public_get_quote(uuid) rename to
--   public_get_quote__r56_off; alter function public.public_get_quote__pre0297(uuid) rename to public_get_quote;
--   grant execute on function public.public_get_quote(uuid) to anon, authenticated, service_role; (same for the
--   other three).

-- ---- 1) preflight -------------------------------------------------------------------------------------------
do $$ begin
  if (to_regprocedure('public.public_get_quote(uuid)') is null and to_regprocedure('public.public_get_quote__pre0297(uuid)') is null)
     or (to_regprocedure('public.public_get_proposal(uuid)') is null and to_regprocedure('public.public_get_proposal__pre0297(uuid)') is null)
     or (to_regprocedure('public.public_get_portal(uuid)') is null and to_regprocedure('public.public_get_portal__pre0297(uuid)') is null) then
    raise exception 'STOP 0297: public_get_quote / public_get_proposal / public_get_portal missing'; end if;
  if to_regprocedure('public.public_get_booklet_image(uuid,text,text)') is null and to_regprocedure('public.public_get_booklet_image__pre0297(uuid,text,text)') is null then
    raise exception 'STOP 0297: public_get_booklet_image missing - run 0083 / 0095 first'; end if;
  if (to_regprocedure('public.public_quote_validity(text,uuid)') is null and to_regprocedure('public.public_quote_validity__pre0297(text,uuid)') is null)
     or to_regprocedure('public._qv262_quote_for(text,uuid)') is null then
    raise exception 'STOP 0297: public_quote_validity / _qv262_quote_for missing - run 0262 first'; end if;
  if to_regclass('public.auth_rate_hits') is null or to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then
    raise exception 'STOP 0297: auth_rate_hits / rate_hit missing - run 0050 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0297: has_area / current_org_id missing'; end if;
  if to_regprocedure('public.approval_link_age_until(uuid)') is null or to_regprocedure('public.link_age_expired(timestamptz)') is null
     or to_regprocedure('public._a260_link_state(text,text)') is null then
    raise exception 'STOP 0297: approval_link_age_until / link_age_expired (0039) / _a260_link_state (0260) missing'; end if;
  if to_regclass('public.client_booklets') is null or to_regclass('public.quotes') is null then
    raise exception 'STOP 0297: quotes / client_booklets missing'; end if;
end $$;

-- ---- 2) the allow-list (C-01) -------------------------------------------------------------------------------
-- a plain value only (number / string / boolean); strings capped; objects / arrays never pass
create or replace function public._cl297_val(v jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  -- r56-client-link-0297
  select case jsonb_typeof(v)
           when 'number' then v
           when 'boolean' then v
           when 'string' then to_jsonb(left(v #>> '{}', 120))
           else null end;
$$;

-- p_mode 'quote'    (approval / portal page): price lines + the client's name (and couple names / event type / date)
-- p_mode 'proposal' (forwardable proposal link): price lines only, no client details at all
create or replace function public._cl297_pricing(p jsonb, p_mode text)
returns jsonb language plpgsql immutable set search_path = '' as $$
-- r56-client-link-0297: client-facing price lines only (allow-list; notes, contacts, budget, costs never leave)
declare
  k text; o jsonb := '{}'::jsonb; c jsonb; cat jsonb; cp jsonb; cl jsonb;
  top constant text[] := array['chairs', 'chairPrice', 'guests', 'platePrice', 'other', 'serviceChargePct', 'discount',
    'discountPct', 'gstPct', 'placeOfSupply', 'couponCode', 'currency', 'subtotal', 'total', 'taxInclusive', 'taxExempt',
    'taxCountry', 'taxRegion', 'taxName', 'taxRateOverride'];
  comp constant text[] := array['rental', 'plateSub', 'cateringAmt', 'cateringBucket', 'serviceCharge', 'subtotal',
    'discount', 'gstRental', 'gstCatering', 'totalGst', 'cgst', 'sgst', 'igst', 'total', 'taxInclusive', 'taxExempt'];
  cli constant text[] := array['name', 'names', 'coupleNames', 'eventType', 'eventDate'];
begin
  if p is null or jsonb_typeof(p) <> 'object' then return p; end if;   -- null / legacy non-object: unchanged shape
  foreach k in array top loop
    if p ? k and public._cl297_val(p -> k) is not null then o := o || jsonb_build_object(k, public._cl297_val(p -> k)); end if;
  end loop;
  if jsonb_typeof(p -> 'catering') = 'object' then
    cat := jsonb_strip_nulls(jsonb_build_object('mode', public._cl297_val(p #> '{catering,mode}'),
                                                'amount', public._cl297_val(p #> '{catering,amount}')));
    o := o || jsonb_build_object('catering', cat);
  end if;
  if jsonb_typeof(p -> 'coupon') = 'object' then
    cp := jsonb_strip_nulls(jsonb_build_object('kind', public._cl297_val(p #> '{coupon,kind}'),
                                               'value', public._cl297_val(p #> '{coupon,value}')));
    o := o || jsonb_build_object('coupon', cp);
  end if;
  if jsonb_typeof(p -> 'computed') = 'object' then
    c := '{}'::jsonb;
    foreach k in array comp loop
      if (p -> 'computed') ? k and public._cl297_val(p -> 'computed' -> k) is not null then
        c := c || jsonb_build_object(k, public._cl297_val(p -> 'computed' -> k)); end if;
    end loop;
    o := o || jsonb_build_object('computed', c);
  end if;
  if p_mode = 'quote' and jsonb_typeof(p -> 'client') = 'object' then
    cl := '{}'::jsonb;
    foreach k in array cli loop
      if (p -> 'client') ? k and public._cl297_val(p -> 'client' -> k) is not null then
        cl := cl || jsonb_build_object(k, public._cl297_val(p -> 'client' -> k)); end if;
    end loop;
    o := o || jsonb_build_object('client', cl);
  end if;
  return o;
end $$;

do $$ begin
  revoke all on function public._cl297_val(jsonb) from public;
  revoke all on function public._cl297_pricing(jsonb, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public._cl297_val(jsonb) from anon; revoke all on function public._cl297_pricing(jsonb, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._cl297_val(jsonb) from authenticated; revoke all on function public._cl297_pricing(jsonb, text) from authenticated; end if;
end $$;

-- ---- 3) keep each current body once as <name>__pre0297 (no API privilege) ---------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
      ('public_get_quote', 'uuid'), ('public_get_proposal', 'uuid'), ('public_get_portal', 'uuid'),
      ('public_get_booklet_image', 'uuid, text, text'), ('public_quote_validity', 'text, uuid')) v(fn, args) loop
    if to_regprocedure(format('public.%s__pre0297(%s)', r.fn, r.args)) is null
       and to_regprocedure(format('public.%s(%s)', r.fn, r.args)) is not null
       and position('r56-client-link-0297' in (select p.prosrc from pg_proc p
                                                 where p.oid = to_regprocedure(format('public.%s(%s)', r.fn, r.args)))) = 0 then
      execute format('alter function public.%s(%s) rename to %s', r.fn, r.args, r.fn || '__pre0297');
    end if;
    execute format('revoke all on function public.%s(%s) from public', r.fn || '__pre0297', r.args);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s(%s) from anon', r.fn || '__pre0297', r.args); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%s(%s) from authenticated', r.fn || '__pre0297', r.args); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on function public.%s(%s) from service_role', r.fn || '__pre0297', r.args); end if;
  end loop;
end $$;

-- ---- 4) C-01: approval link (approve page) ------------------------------------------------------------------
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297: every earlier check (expiry, shelf, cancel, re-approval) runs in the kept body; the answer
-- is allow-listed (top-level keys + client-facing pricing + the client's name only)
declare v jsonb; o jsonb := '{}'::jsonb; k text;
begin
  v := public.public_get_quote__pre0297(p_token);
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  foreach k in array array['code', 'title', 'event_type', 'status', 'approval_status', 'client_name', 'reapproval_required'] loop
    if v ? k then o := o || jsonb_build_object(k, v -> k); end if;
  end loop;
  if v ? 'pricing' then o := o || jsonb_build_object('pricing', public._cl297_pricing(v -> 'pricing', 'quote')); end if;
  return o;
end $$;

-- ---- 5) C-01: proposal link (forwardable: no personal details inside pricing) --------------------------------
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297: every earlier check runs in the kept body; the answer is allow-listed
declare v jsonb; o jsonb := '{}'::jsonb; k text;
begin
  v := public.public_get_proposal__pre0297(p_token);
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  foreach k in array array['concept', 'theme', 'palette', 'images', 'scope', 'event_code', 'event_title', 'event_type',
                           'client_name', 'total'] loop
    if v ? k then o := o || jsonb_build_object(k, v -> k); end if;
  end loop;
  if v ? 'pricing' then o := o || jsonb_build_object('pricing', public._cl297_pricing(v -> 'pricing', 'proposal')); end if;
  return o;
end $$;

-- ---- 6) C-05: portal link - the studio brand is reduced to the accent colour --------------------------------
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297: every earlier check / field runs in the kept body; studio = name + brand {accent} only
declare v jsonb; ac jsonb;
begin
  v := public.public_get_portal__pre0297(p_token);
  if v is null or jsonb_typeof(v) <> 'object' then return v; end if;
  if jsonb_typeof(v -> 'studio') = 'object' then
    ac := public._cl297_val(v #> '{studio,brand,accent}');
    v := jsonb_set(v, '{studio}', jsonb_build_object('name', v #> '{studio,name}',
           'brand', case when ac is not null and jsonb_typeof(ac) = 'string' then jsonb_build_object('accent', ac)
                         else '{}'::jsonb end));
  end if;
  return v;
end $$;

-- ---- 7) C-04: no rate-limit row for a random token (look the token up first, the 0156 rule) -----------------
create or replace function public.public_get_booklet_image(p_token uuid, p_kind text, p_variant text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297: an unknown token answers null BEFORE any rate-limit row is written; a real link runs the
-- kept body as before (cancel gate, rate limit, expiry / revoke, sections, picture)
begin
  if p_token is null or not exists (select 1 from public.client_booklets b where b.token = p_token) then return null; end if;
  return public.public_get_booklet_image__pre0297(p_token, p_kind, p_variant);
end $$;

create or replace function public.public_quote_validity(p_kind text, p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297: an unknown / dead token answers null BEFORE any rate-limit row is written; a live link runs
-- the kept body as before
begin
  if p_token is null or coalesce(p_kind, '') not in ('quote', 'booklet') then return null; end if;
  if public._qv262_quote_for(p_kind, p_token) is null then return null; end if;
  return public.public_quote_validity__pre0297(p_kind, p_token);
end $$;

-- grants: exactly as before (anon + signed-in + service role)
do $$ declare s text; begin
  foreach s in array array['public.public_get_quote(uuid)', 'public.public_get_proposal(uuid)', 'public.public_get_portal(uuid)',
                           'public.public_get_booklet_image(uuid, text, text)', 'public.public_quote_validity(text, uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', s); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', s); end if;
  end loop;
end $$;

-- ---- 8) C-04: purge EXPIRED rate-limit counters ----------------------------------------------------------------
-- rate_hit refuses windows over 86400 s, so a row whose window started more than 2 days ago is expired: the next hit
-- would reset it to 1 anyway. Deleting it changes no limit. Batched (at most p_max rows per call).
create or replace function public.auth_rate_hits_purge(p_max integer default 50000)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r56-client-link-0297
declare v_n integer;
begin
  delete from public.auth_rate_hits h
   where h.ctid in (select x.ctid from public.auth_rate_hits x
                     where x.window_start < now() - interval '2 days'
                     limit greatest(1, least(coalesce(p_max, 50000), 500000)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
do $$ begin
  revoke all on function public.auth_rate_hits_purge(integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.auth_rate_hits_purge(integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.auth_rate_hits_purge(integer) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.auth_rate_hits_purge(integer) to service_role; end if;
end $$;

-- pg_cron, ONLY if already installed (never created here): daily 04:23 UTC
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_rate_hits_purge') then
        perform cron.schedule('helm_rate_hits_purge', '23 4 * * *', 'select public.auth_rate_hits_purge()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_rate_hits_purge could not be scheduled (%); run select public.auth_rate_hits_purge() by hand', sqlerrm;
    end;
  end if;
end $$;

-- ---- 9) C-02 / C-03: who may "Send by e-mail" (client-mailer asks this AS THE CALLER before sending) ----------
create or replace function public.client_mailer_check(p_quote uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r56-client-link-0297: signed in, own studio, quotes EDIT (same rule as WhatsApp), quote not deleted; for the
-- approval link also whether it is still live (not expired / auto-expired / paused / cancelled)
declare v_org uuid := public.current_org_id(); v_tok uuid; v_exp timestamptz; v_live boolean := true; v_state text;
begin
  if auth.uid() is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('approval', 'booklet') then raise exception 'unknown message' using errcode = '22023'; end if;
  select q.approval_token, q.approval_token_expires_at into v_tok, v_exp
    from public.quotes q where q.id = p_quote and q.org_id = v_org and q.deleted_at is null;
  if not found then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if p_kind = 'approval' then
    v_state := public._a260_link_state('approval', v_tok::text);
    v_live := v_tok is not null and (v_exp is null or v_exp > now())
              and not coalesce(public.link_age_expired(public.approval_link_age_until(v_tok)), false)
              and coalesce(v_state, '') not in ('cancelled', 'paused');
  end if;
  return jsonb_build_object('ok', true, 'link_live', v_live);
end $$;
do $$ begin
  revoke all on function public.client_mailer_check(uuid, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.client_mailer_check(uuid, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.client_mailer_check(uuid, text) to authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.client_mailer_check(uuid, text) to service_role; end if;
end $$;

notify pgrst, 'reload schema';
