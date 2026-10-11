-- ============================================================================
-- 0101_e2e_usability.sql - CANONICAL forward-only. Client pages + ex-tax revenue.
--
-- In plain words:
--   1. Insights showed "Revenue" INCLUDING the GST / VAT the studio collected for the
--      government, so profit and margin looked bigger than they are. insights_range now
--      ALSO returns tax, revenue_ex_tax, profit_ex_tax and margin_pct_ex_tax (overall and
--      per currency). Every existing field is returned exactly as before - nothing is
--      renamed or removed; the screen switches to the *_ex_tax fields.
--      (The 0094 body is copied ONCE to insights_range__pre0101 and the new function
--      calls it, then adds the fields. Same access rules: insights VIEW + finance VIEW.)
--   2. public_booklet_pay_terms(token): the client booklet link can show
--      "Balance Rs X due by dd/mm/yyyy" - returns the event date, the studio's
--      "balance due N days before" term and advance %. Figures only. Same link checks
--      as the booklet (revoked / expired / deleted event = invalid link), rate-limited,
--      and nothing when the studio hid the Payments section of that booklet.
--   3. public_portal_extras(token): the client portal can link to what already exists
--      for THAT event only - the live booklet link, the published invitation website,
--      payment receipts (number, date, amount, method) and the studio's public contact
--      (business phone, and e-mail only when the studio confirmed it - 0075 rule).
--      The token is checked by public_get_portal first (same expiry / shelving rules).
--
-- Security: SECURITY DEFINER with search_path = ''. Every read is scoped to the ONE
-- quote the token belongs to and that quote's own org_id (no cross-tenant data).
-- No provider references, notes, staff data or internal ids are returned.
-- Additive + idempotent: functions only. NO table, column or row is changed.
-- Needs 0094 (insights_range per currency), 0070 (booklet receipts), 0075
-- (business_email_confirmed), 0090 (public_get_portal), 0022 (event_site_live_until),
-- 0050 (rate_hit), 0069 (_bk_on).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.insights_range(date,date)') is null then raise exception '0101: insights_range missing (apply 0094 first)'; end if;
  if to_regprocedure('public.public_get_portal(uuid)') is null then raise exception '0101: public_get_portal missing (apply 0090 first)'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception '0101: rate_hit missing (apply 0050 first)'; end if;
  if to_regprocedure('public._bk_on(jsonb,text)') is null then raise exception '0101: _bk_on missing (apply 0069 first)'; end if;
  if to_regprocedure('public.event_site_live_until(uuid)') is null then raise exception '0101: event_site_live_until missing (apply 0022 first)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'business_email_confirmed') then
    raise exception '0101: apply 0075 first (organizations.business_email_confirmed missing)';
  end if;
end $$;

-- ---------------------------------------------------------------- 1. tax inside a quote total
-- The server total (D8) is the authority. computed.totalGst is used only when it belongs to that
-- same total; otherwise the tax is derived from gstPct. Exempt -> 0. Never negative, never > total.
create or replace function public._r101_quote_tax(p jsonb, p_total numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare c jsonb; g numeric; t numeric := coalesce(p_total, 0);
begin
  if p is null or jsonb_typeof(p) <> 'object' or t <= 0 then return 0; end if;
  if lower(coalesce(p ->> 'taxExempt', '')) = 'true' then return 0; end if;
  c := case when jsonb_typeof(p -> 'computed') = 'object' then p -> 'computed' end;
  if c is not null and coalesce(c ->> 'totalGst', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
     and coalesce(c ->> 'total', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
     and abs((c ->> 'total')::numeric - t) <= 1 then
    return greatest(0, least(t, round((c ->> 'totalGst')::numeric, 2)));
  end if;
  if coalesce(p ->> 'gstPct', '') !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then return 0; end if;
  g := (p ->> 'gstPct')::numeric;
  if g <= 0 or g > 100 then return 0; end if;
  return round(t - t / (1 + g / 100), 2);
end $$;
revoke all on function public._r101_quote_tax(jsonb, numeric) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r101_quote_tax(jsonb, numeric) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r101_quote_tax(jsonb, numeric) from authenticated'; end if;
end $$;

-- ---------------------------------------------------------------- 2. insights_range + *_ex_tax
-- the 0094 body is copied ONCE to insights_range__pre0101 (a second run finds it and skips)
do $$ begin
  if to_regprocedure('public.insights_range__pre0101(date,date)') is null then
    execute replace(pg_get_functiondef('public.insights_range(date,date)'::regprocedure),
                    'public.insights_range(', 'public.insights_range__pre0101(');
  end if;
end $$;
revoke all on function public.insights_range__pre0101(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_range__pre0101(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.insights_range__pre0101(date, date) from authenticated'; end if;
end $$;

create or replace function public.insights_range(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- insights-ex-tax-0101: the 0094 result + tax / revenue_ex_tax / profit_ex_tax / margin_pct_ex_tax
declare
  r jsonb; v_org uuid := public.current_org_id(); v_tz text;
  v_from date := coalesce(p_from, date '2000-01-01'); v_to date := coalesce(p_to, date '2100-12-31');
  v_taxes jsonb; v_tax numeric; m jsonb; bc jsonb; x jsonb; out_bc jsonb := '[]'::jsonb;
  rev numeric; pro numeric; tx numeric;
begin
  r := public.insights_range__pre0101(p_from, p_to);   -- every access check of 0094 runs here
  if r is null or jsonb_typeof(r) <> 'object' or not coalesce((r ->> 'finance')::boolean, false)
     or jsonb_typeof(r -> 'money') <> 'object' then return r; end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  -- the same confirmed events the 0094 money block sums (org, not deleted, in range, past discovery)
  select coalesce(jsonb_object_agg(cur, tax), '{}'::jsonb) into v_taxes from (
    select coalesce(nullif(upper(btrim(q.currency)), ''), 'INR') as cur,
           sum(public._r101_quote_tax(q.pricing,
               case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end)) as tax
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
       and coalesce(q.event_date, (q.created_at at time zone v_tz)::date) between v_from and v_to
       and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
     group by 1) s;
  select coalesce(sum(value::numeric), 0) into v_tax from jsonb_each_text(v_taxes);

  m := r -> 'money';
  rev := coalesce((m ->> 'revenue')::numeric, 0); pro := coalesce((m ->> 'profit')::numeric, 0);
  m := m || jsonb_build_object('tax', v_tax, 'revenue_ex_tax', rev - v_tax, 'profit_ex_tax', pro - v_tax,
         'margin_pct_ex_tax', case when rev - v_tax <> 0 then round((pro - v_tax) / (rev - v_tax) * 100) end);
  r := jsonb_set(r, '{money}', m);

  bc := r -> 'money_by_currency';
  if jsonb_typeof(bc) = 'array' then
    for x in select * from jsonb_array_elements(bc) loop
      tx := coalesce((v_taxes ->> (x ->> 'currency'))::numeric, 0);
      rev := coalesce((x ->> 'revenue')::numeric, 0); pro := coalesce((x ->> 'profit')::numeric, 0);
      out_bc := out_bc || jsonb_build_array(x || jsonb_build_object('tax', tx, 'revenue_ex_tax', rev - tx, 'profit_ex_tax', pro - tx,
                  'margin_pct_ex_tax', case when rev - tx <> 0 then round((pro - tx) / (rev - tx) * 100) end));
    end loop;
    r := jsonb_set(r, '{money_by_currency}', out_bc);
  end if;
  return r;
end $$;
revoke all on function public.insights_range(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_range(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_range(date, date) to authenticated'; end if;
end $$;

-- ---------------------------------------------------------------- 3. booklet payment terms
create or replace function public.public_booklet_pay_terms(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- booklet-pay-terms-0101
declare b public.client_booklets; q public.quotes; v_wait int; v_days text; v_adv text;
begin
  if p_token is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  v_wait := public.rate_hit('booklet.terms', md5('booklet:' || p_token::text), 600, 120);
  if v_wait > 0 then raise exception 'too many requests - try again in % seconds', v_wait using errcode = 'P0001'; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now() then raise exception 'invalid link' using errcode = 'P0001'; end if;
  select * into q from public.quotes x where x.id = b.quote_id and x.org_id = b.org_id and x.deleted_at is null;
  if q.id is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  if not public._bk_on(b.sections, 'payments') then return null; end if;
  select c.value ->> 'balanceDueDays', c.value ->> 'advancePct' into v_days, v_adv
    from public.app_config c where c.key = 'pricing' and c.org_id = q.org_id;
  return jsonb_build_object('event_date', q.event_date,
    'balance_due_days', case when coalesce(v_days, '') ~ '^[0-9]{1,3}$' and v_days::int <= 365 then v_days::int end,
    'advance_pct', case when coalesce(v_adv, '') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' and v_adv::numeric <= 100 then v_adv::numeric end);
end $$;
revoke all on function public.public_booklet_pay_terms(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_booklet_pay_terms(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_booklet_pay_terms(uuid) to authenticated'; end if;
end $$;

-- ---------------------------------------------------------------- 4. portal extras
-- the studio's PUBLIC contact only: name, business phone, and the business e-mail only when the
-- studio confirmed it (0075). Internal helper (not callable by anon / app) - never billing details.
create or replace function public._r101_studio_contact(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('name', left(o.name, 80),
           'phone', case when jsonb_typeof(o.brand -> 'phone') = 'string' then left(o.brand ->> 'phone', 40) end,
           'email', case when coalesce(o.business_email_confirmed, false)
                          and coalesce(o.business_email, '') ~ '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$'
                         then left(o.business_email, 200) end))
    from public.organizations o where o.id = p_org;
$$;
revoke all on function public._r101_studio_contact(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r101_studio_contact(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r101_studio_contact(uuid) from authenticated'; end if;
end $$;

create or replace function public.public_portal_extras(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- portal-extras-0101
declare v jsonb; q public.quotes; v_bt uuid; v_snaps boolean := false; v_imgs int := 0; v_slug text; v_rc jsonb;
begin
  if p_token is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  v := public.public_get_portal(p_token);              -- raises / null on an invalid, expired or shelved link
  if v is null or jsonb_typeof(v) <> 'object' then raise exception 'invalid link' using errcode = 'P0001'; end if;
  select * into q from public.quotes x where x.approval_token = p_token and x.deleted_at is null limit 1;
  if q.id is null then raise exception 'invalid link' using errcode = 'P0001'; end if;

  select b.token, (b.snap_2d_path is not null or b.snap_3d_path is not null) into v_bt, v_snaps
    from public.client_booklets b
   where b.quote_id = q.id and b.org_id = q.org_id and b.revoked_at is null and b.expires_at > now()
   order by b.created_at desc limit 1;
  if v_bt is not null then
    select count(*) into v_imgs from public.client_booklet_images i where i.quote_id = q.id and i.org_id = q.org_id;
  end if;

  select s.slug into v_slug from public.event_sites s
   where s.quote_id = q.id and s.org_id = q.org_id and s.status = 'published'
     and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'number', left(pm.receipt_no, 60), 'date', coalesce(pm.paid_at, pm.created_at),
           'amount', round(pm.amount, 2), 'method', left(nullif(btrim(coalesce(pm.method, '')), ''), 40))
           order by coalesce(pm.paid_at, pm.created_at), pm.id), '[]'::jsonb)
    into v_rc from public.quote_payments pm
   where pm.quote_id = q.id and pm.org_id = q.org_id and pm.status = 'paid';

  return jsonb_build_object('booklet_token', v_bt, 'has_layout', coalesce(v_snaps, false), 'booklet_images', v_imgs,
    'invite_slug', v_slug, 'receipts', v_rc, 'contact', public._r101_studio_contact(q.org_id));
end $$;
revoke all on function public.public_portal_extras(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_portal_extras(uuid) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_portal_extras(uuid) to authenticated'; end if;
end $$;
