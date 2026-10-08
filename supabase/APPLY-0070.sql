-- ============================================================================
-- HELM - 0070 booklet payments (one paste) (2026-10-08)
--   * The client booklet Payments section now shows what was actually received:
--     the payment ledger (e.g. a cash advance from "Record payment") when the event
--     has ledger rows, else paid milestones - same rule as the settlement page.
--   * Outstanding = total - paid (negative = credit). Receipts list: number, date,
--     amount, method only.
-- REQUIRES 0069 - the preflight stops if not.
-- WHAT IT TOUCHES: 1 new helper function, public_get_booklet replaced in place (same
-- behaviour as 0069 for sections, snapshots, menu mode; same grants). NO table or row
-- is changed. SAFE TO RE-RUN.
-- Plain ASCII on purpose (the SQL editor mangles fancy characters).
-- ============================================================================
do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0069(uuid)') is null or to_regprocedure('public._pkg_paid(uuid)') is null
     or to_regprocedure('public._bk_on(jsonb,text)') is null then
    raise exception 'Apply 0069 (APPLY-0069.sql) first';
  end if;
end $$;

-- 0070_booklet_payments.sql - CANONICAL forward-only. Client booklet Payments section
-- reads the same money source of truth as the settlement page "Received" rule and the
-- 0068 client timeline.
-- REQUIRES 0069 (public_get_booklet wrapper, _pkg_paid, _pkg_total, _bk_* helpers).
--
-- In plain words:
--   * Bug: a cash advance recorded via flow.html "Record payment" lands in the
--     quote_payments ledger. The 0065 booklet reader only summed paid milestones, so the
--     client booklet showed Paid 0 while public_booklet_packages showed the advance.
--   * Now payments.paid = the quote_payments ledger paid rows when that event has any
--     ledger row, else its paid milestones (public._pkg_paid, the 0069 rule).
--   * payments.outstanding = quote total - paid (negative = client credit).
--   * payments.receipts = paid ledger rows, client-safe only: number, date, amount,
--     method. No provider refs, links, notes, keys or staff data.
--   * Everything else in the 0069 wrapper is kept as-is: hidden sections removed
--     server-side, snapshot flags, menu.mode, grants (anon + authenticated execute).
-- Additive + idempotent: CREATE OR REPLACE FUNCTION only. No table or row changes.

create or replace function public._bk_payments(p_quote uuid, p_org uuid, p_base jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-payments-0070
declare q public.quotes; v_total numeric; v_paid numeric; v_rc jsonb;
begin
  select * into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if q.id is null then return p_base; end if;
  v_total := public._pkg_total(q.pricing);
  v_paid := public._pkg_paid(q.id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', left(pm.receipt_no, 60),
           'date', coalesce(pm.paid_at, pm.created_at),
           'amount', round(pm.amount, 2),
           'method', left(nullif(btrim(coalesce(pm.method, '')), ''), 40))
           order by coalesce(pm.paid_at, pm.created_at), pm.id), '[]'::jsonb)
    into v_rc from public.quote_payments pm
   where pm.quote_id = q.id and pm.org_id = q.org_id and pm.status = 'paid';
  return coalesce(p_base, '{}'::jsonb) || jsonb_build_object(
    'paid', v_paid, 'total', v_total, 'outstanding', round(v_total - v_paid, 2), 'receipts', v_rc);
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- package-flow-0069: the 0065 reader, then unticked sections are removed server-side
-- booklet-payments-0070: payments use the ledger-else-milestones rule + receipts
declare r jsonb; b public.client_booklets; s jsonb; t public.menu_templates; v_cur text;
begin
  r := public.public_get_booklet__pre0069(p_token);      -- validates token, rate limit, audit
  select * into b from public.client_booklets x where x.token = p_token;
  s := public._bk_sections_norm(coalesce(b.sections, public._bk_sections_all()));
  if not public._bk_on(s, 'studio') then r := r || jsonb_build_object('studio', jsonb_build_object('name', r #> '{studio,name}')); end if;
  if not public._bk_on(s, 'client') then r := jsonb_set(r, '{event}', (r -> 'event') - 'client_name' - 'guests'); end if;
  if not public._bk_on(s, 'venue') then r := jsonb_set(r, '{event}', (r -> 'event') - 'venue_name' - 'venue_address'); end if;
  if not public._bk_on(s, 'menu') then r := r - 'menu';
  else
    t := public._bk_selected_pkg(b.quote_id);
    select o.currency into v_cur from public.organizations o where o.id = b.org_id;
    r := jsonb_set(r, '{menu}', coalesce(r -> 'menu', '{}'::jsonb) || jsonb_build_object(
      'mode', case when t.id is null then 'choose' else 'selected' end,
      'selected_package', case when t.id is null then r #> '{menu,selected_package}' else jsonb_build_object('id', t.id, 'name', t.name,
        'tier', t.tier, 'diet', t.diet, 'description', t.description, 'per_person', t.price_per_plate, 'price_per_plate', t.price_per_plate,
        'currency', coalesce(v_cur, 'INR'), 'dishes', t.dishes, 'items', t.dishes) end));
  end if;
  if not public._bk_on(s, 'layout2d') then r := r - 'layout'; end if;
  if not public._bk_on(s, 'quotation') then r := r - 'quote' - 'versions'; end if;
  if not public._bk_on(s, 'payments') then r := r - 'payments';
  elsif r is not null and b.id is not null then
    r := jsonb_set(r, '{payments}', public._bk_payments(b.quote_id, b.org_id, r -> 'payments'));
  end if;
  if not public._bk_on(s, 'terms') then r := r - 'terms'; end if;
  if not public._bk_on(s, 'note') then r := r - 'note'; end if;
  return r || jsonb_build_object('sections', s,
    'snapshots', jsonb_build_object('2d', public._bk_on(s, 'layout2d') and b.snap_2d_path is not null,
                                    '3d', public._bk_on(s, 'layout3d') and b.snap_3d_path is not null));
end $$;

do $$ declare s text; begin
  foreach s in array array['public._bk_payments(uuid, uuid, jsonb)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('booklet reader uses the 0070 payments rule', position('_bk_payments' in pg_get_functiondef('public.public_get_booklet(uuid)'::regprocedure)) > 0),
  ('0069 sections filtering kept', position('_bk_sections_norm' in pg_get_functiondef('public.public_get_booklet(uuid)'::regprocedure)) > 0
      and position('snapshots' in pg_get_functiondef('public.public_get_booklet(uuid)'::regprocedure)) > 0),
  ('paid helper = ledger else milestones', position('payment_milestones' in pg_get_functiondef('public._pkg_paid(uuid)'::regprocedure)) > 0),
  ('booklet reader open to the link (anon + members)', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.public_get_booklet(uuid)', 'execute')),
  ('payments helper not callable directly', not has_function_privilege('anon', 'public._bk_payments(uuid,uuid,jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'public._bk_payments(uuid,uuid,jsonb)', 'execute')),
  ('inner reader still hidden', not has_function_privilege('anon', 'public.public_get_booklet__pre0069(uuid)', 'execute'))
) v(item, ok);
