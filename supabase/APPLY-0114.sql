-- APPLY-0114.sql - paste into the Supabase SQL editor (staging first, then prod). ASCII only, idempotent,
-- safe to paste twice. One transaction: if anything fails nothing is changed.
-- Contains 0114_booklet_change_lines.sql:
--   * _bk_payments - also returns approved change orders (title, amount, date) for the booklet Quotation.
--   No table, column, row or trigger is changed or deleted. No temp tables, no session settings.
-- Ends with verify rows (item, ok) - every ok must be true.

begin;

-- 0114_booklet_change_lines.sql - CANONICAL forward-only.
--
-- In plain words:
--   The client booklet Quotation section did not list APPROVED change orders, although the
--   Payments total (0111) already includes them. Fix: _bk_payments additionally returns
--   'changes' = [{title, amount, date}] for that booklet's own quote + org, status 'approved'
--   only (title and price only: cost_delta / detail / requester are NOT exposed). The body is
--   otherwise copied verbatim from 0111 (total, paid, outstanding, receipts unchanged).
--   _bk_payments stays internal (no anon / authenticated execute); public_get_booklet untouched.
--
--   Changes: 1 function body replaced. No table / column / row / trigger changed or deleted.
--   Additive + idempotent (create or replace). Safe to run twice. REQUIRES 0111.

create or replace function public._bk_payments(p_quote uuid, p_org uuid, p_base jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- booklet-payments-0070 / invoice-total-0111 / change-lines-0114
declare q public.quotes; v_total numeric; v_paid numeric; v_rc jsonb; v_ch jsonb;
begin
  select * into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if q.id is null then return p_base; end if;
  v_total := public._pkg_total(q.pricing);
  if v_total > 0 then   -- 0111: invoice = quote + approved change orders (0110 rule)
    v_total := v_total + coalesce((select round(sum(coalesce(c.price_delta, 0)), 2)
                                     from public.change_requests c
                                    where c.quote_id = q.id and c.status = 'approved'), 0);
  end if;
  v_paid := public._pkg_paid(q.id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'number', left(pm.receipt_no, 60),
           'date', coalesce(pm.paid_at, pm.created_at),
           'amount', round(pm.amount, 2),
           'method', left(nullif(btrim(coalesce(pm.method, '')), ''), 40))
           order by coalesce(pm.paid_at, pm.created_at), pm.id), '[]'::jsonb)
    into v_rc from public.quote_payments pm
   where pm.quote_id = q.id and pm.org_id = q.org_id and pm.status = 'paid';
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', left(coalesce(nullif(btrim(c.title), ''), 'Change'), 120),
           'amount', round(coalesce(c.price_delta, 0), 2),
           'date', coalesce(c.decided_at, c.created_at))
           order by coalesce(c.decided_at, c.created_at), c.id), '[]'::jsonb)
    into v_ch from public.change_requests c
   where c.quote_id = q.id and c.org_id = q.org_id and c.status = 'approved';
  return coalesce(p_base, '{}'::jsonb) || jsonb_build_object(
    'paid', v_paid, 'total', v_total, 'outstanding', round(v_total - v_paid, 2), 'receipts', v_rc, 'changes', v_ch);
end $$;

do $$ begin
  execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._bk_payments(uuid, uuid, jsonb) from authenticated'; end if;
end $$;

commit;

-- ---- VERIFY (expect every ok = true) ----
select '_bk_payments returns approved change lines' as item, pg_get_functiondef('public._bk_payments(uuid, uuid, jsonb)'::regprocedure) like '%change-lines-0114%' as ok
union all
select '_bk_payments keeps invoice total (0111)', pg_get_functiondef('public._bk_payments(uuid, uuid, jsonb)'::regprocedure) like '%invoice-total-0111%'
union all
select '_bk_payments keeps receipts', pg_get_functiondef('public._bk_payments(uuid, uuid, jsonb)'::regprocedure) like '%receipts%'
union all
select 'booklet reader still installed', to_regprocedure('public.public_get_booklet(uuid)') is not null
union all
select 'anon cannot run _bk_payments', not has_function_privilege('anon','public._bk_payments(uuid, uuid, jsonb)','execute')
union all
select 'studio users cannot run _bk_payments', not has_function_privilege('authenticated','public._bk_payments(uuid, uuid, jsonb)','execute')
union all
select 'anon can still open booklets', has_function_privilege('anon','public.public_get_booklet(uuid)','execute');
