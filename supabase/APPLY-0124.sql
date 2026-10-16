-- APPLY 0124 (paste whole file; one transaction, then the read-only checks; expect every ok = true)
begin;
-- ============================================================================
-- 0124_vendor_bills.sql - CANONICAL forward-only. REQUIRES 0049, 0101 (_r101_quote_tax), 0116.
-- In plain words (Phase C, client meeting):
--   * vendor_bills  - a bill a vendor sent for an event (number, date, amount, due date,
--                     optional photo/PDF in the existing event-docs files). Never deleted:
--                     a wrong bill is VOIDED with a reason (only while nothing is paid on it).
--   * vendor_payouts - money the studio paid against a bill. Written ONLY by the RPC
--                     record_vendor_payout, which is idempotent (same key = same payout,
--                     never twice) and refuses to pay more than the bill's open balance.
--   * event_pnl(quote)  - read-only per-event profit: Revenue (ex-tax) - Vendors -
--                     Logistics/Other - Staff expenses = Net profit. Vendor cost comes from
--                     ONE source per booking: its bills when it has any, else the booking
--                     cost (no double count).
--   * vendor_payables_summary() / business_pnl(from, to) - read-only studio totals for the
--     Business page (payables due/overdue, net profit by month, top events by profit).
-- Access: same studio only + the "finance" area (has_area). No delete policy anywhere.
-- Existing tables and rows are untouched (event_costs.category already exists).
-- Additive + idempotent: safe to run twice. ASCII only.
-- ============================================================================

create table if not exists public.vendor_bills (
  id uuid not null default gen_random_uuid() primary key,
  org_id uuid not null default public.current_org_id() references public.organizations(id),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  booking_id uuid references public.event_resources(id) on delete set null,
  vendor_id uuid references public.vendors(id) on delete set null,
  bill_no text,
  bill_date date not null default current_date,
  description text,
  amount numeric not null,
  currency text not null default 'INR',
  due_date date,
  file_id uuid references public.event_files(id) on delete set null,
  status text not null default 'open',
  void_reason text,
  voided_at timestamptz,
  voided_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint vendor_bills_amount_ck check (amount > 0 and amount < 1000000000000),
  constraint vendor_bills_status_ck check (status in ('open', 'void')),
  constraint vendor_bills_void_ck check (status <> 'void' or length(btrim(coalesce(void_reason, ''))) >= 3),
  constraint vendor_bills_text_ck check (length(coalesce(bill_no, '')) <= 80 and length(coalesce(description, '')) <= 500)
);
create index if not exists ix_vendor_bills_quote on public.vendor_bills (quote_id);
create index if not exists ix_vendor_bills_org_due on public.vendor_bills (org_id, due_date);

create table if not exists public.vendor_payouts (
  id uuid not null default gen_random_uuid() primary key,
  bill_id uuid not null references public.vendor_bills(id) on delete cascade,
  org_id uuid not null default public.current_org_id() references public.organizations(id),
  amount numeric not null,
  paid_on date not null default current_date,
  method text,
  reference text,
  idempotency_key text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint vendor_payouts_amount_ck check (amount > 0),
  constraint vendor_payouts_text_ck check (length(coalesce(method, '')) <= 40 and length(coalesce(reference, '')) <= 120)
);
create index if not exists ix_vendor_payouts_bill on public.vendor_payouts (bill_id);
create unique index if not exists ux_vendor_payouts_idem on public.vendor_payouts (org_id, idempotency_key) where idempotency_key is not null;

-- ---- RLS: same studio + finance area; NO delete policy (void instead) ----------------------
alter table public.vendor_bills enable row level security;
alter table public.vendor_bills force row level security;
alter table public.vendor_payouts enable row level security;
alter table public.vendor_payouts force row level security;

drop policy if exists vendor_bills_select on public.vendor_bills;
drop policy if exists vendor_bills_insert on public.vendor_bills;
drop policy if exists vendor_bills_update on public.vendor_bills;
create policy vendor_bills_select on public.vendor_bills for select to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'view'));
create policy vendor_bills_insert on public.vendor_bills for insert to authenticated
  with check (org_id = public.current_org_id() and public.has_area('finance', 'edit')
    and exists (select 1 from public.quotes q where q.id = quote_id and q.org_id = public.current_org_id())
    and (booking_id is null or exists (select 1 from public.event_resources b where b.id = booking_id and b.org_id = public.current_org_id() and b.quote_id = vendor_bills.quote_id))
    and (vendor_id is null or exists (select 1 from public.vendors v where v.id = vendor_id and v.org_id = public.current_org_id()))
    and (file_id is null or exists (select 1 from public.event_files f where f.id = file_id and f.org_id = public.current_org_id() and f.quote_id = vendor_bills.quote_id)));
create policy vendor_bills_update on public.vendor_bills for update to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'edit'))
  with check (org_id = public.current_org_id() and public.has_area('finance', 'edit'));

drop policy if exists vendor_payouts_select on public.vendor_payouts;
create policy vendor_payouts_select on public.vendor_payouts for select to authenticated
  using (org_id = public.current_org_id() and public.has_area('finance', 'view'));
-- (no insert/update/delete policy: payouts are written only by record_vendor_payout)

revoke delete on public.vendor_bills from anon, authenticated;
revoke all on public.vendor_payouts from anon;
revoke insert, update, delete on public.vendor_payouts from authenticated;
grant select, insert, update on public.vendor_bills to authenticated;
grant select on public.vendor_payouts to authenticated;

-- Users can never delete a bill or payout (no delete grant, no delete policy). Rows only go
-- away if the whole event is hard-deleted (FK cascade), same as every other event table.
-- ---- guard: a bill's studio/event never moves; amount never drops below what is paid;
--      a bill with payouts cannot be voided; a void bill is final -----------------------------
create or replace function public.tg_vendor_bill_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- vendor-bills-0124
declare v_paid numeric;
begin
  if new.org_id is distinct from old.org_id or new.quote_id is distinct from old.quote_id then
    raise exception 'A bill cannot be moved to another event.' using errcode = '42501';
  end if;
  if old.status = 'void' and (new.status <> 'void' or new.amount <> old.amount) then
    raise exception 'This bill is void and cannot be changed.' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.vendor_payouts p where p.bill_id = old.id;
  if new.amount < v_paid then
    raise exception 'The bill amount cannot be lower than what is already paid (%).', v_paid using errcode = '22023';
  end if;
  if new.status = 'void' and old.status <> 'void' then
    if v_paid > 0 then raise exception 'A bill with payments cannot be voided.' using errcode = '22023'; end if;
    new.voided_at := now(); new.voided_by := auth.uid();
  end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists vendor_bills_guard on public.vendor_bills;
create trigger vendor_bills_guard before update on public.vendor_bills
  for each row execute function public.tg_vendor_bill_guard();

create or replace function public.tg_vendor_payout_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Vendor payouts are a ledger and cannot be changed.' using errcode = '42501';
end $$;
drop trigger if exists vendor_payouts_immutable on public.vendor_payouts;
create trigger vendor_payouts_immutable before update on public.vendor_payouts
  for each row execute function public.tg_vendor_payout_immutable();

-- ended-trial / suspended studios are read-only (same guard every other table has, 0045/0116)
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    execute 'drop trigger if exists zzz_studio_read_only on public.vendor_bills';
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.vendor_bills for each row execute function public.tg_studio_read_only(''org_id'')';
    execute 'drop trigger if exists zzz_studio_read_only on public.vendor_payouts';
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.vendor_payouts for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- record_vendor_payout: idempotent, refuses overpayment ---------------------------------
create or replace function public.record_vendor_payout(p_bill uuid, p_amount numeric, p_paid_on date,
  p_method text, p_reference text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- vendor-bills-0124
declare
  v_org uuid := public.current_org_id(); b public.vendor_bills%rowtype;
  v_paid numeric; v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_row public.vendor_payouts%rowtype;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_key is not null and length(v_key) > 100 then raise exception 'idempotency key too long' using errcode = '22023'; end if;
  if v_key is not null then
    select * into v_row from public.vendor_payouts p where p.org_id = v_org and p.idempotency_key = v_key;
    if found then
      if v_row.bill_id <> p_bill then raise exception 'idempotency key already used for another bill' using errcode = '22023'; end if;
      return jsonb_build_object('ok', true, 'duplicate', true, 'payout', to_jsonb(v_row));
    end if;
  end if;
  select * into b from public.vendor_bills x where x.id = p_bill and x.org_id = v_org for update;
  if not found then raise exception 'bill not found' using errcode = 'P0002'; end if;
  if b.status = 'void' then raise exception 'This bill is void.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.' using errcode = '22023'; end if;
  if p_paid_on is not null and p_paid_on > current_date + 1 then raise exception 'The payment date is in the future.' using errcode = '22023'; end if;
  select coalesce(sum(p.amount), 0) into v_paid from public.vendor_payouts p where p.bill_id = b.id;
  if v_paid + p_amount > b.amount then
    raise exception 'That would overpay the bill: only % is left to pay.', b.amount - v_paid using errcode = '22023';
  end if;
  insert into public.vendor_payouts(bill_id, org_id, amount, paid_on, method, reference, idempotency_key)
  values (b.id, v_org, p_amount, coalesce(p_paid_on, current_date), left(nullif(btrim(coalesce(p_method, '')), ''), 40),
          left(nullif(btrim(coalesce(p_reference, '')), ''), 120), v_key)
  returning * into v_row;
  return jsonb_build_object('ok', true, 'duplicate', false, 'payout', to_jsonb(v_row),
                            'paid', v_paid + p_amount, 'balance', b.amount - v_paid - p_amount);
end $$;
revoke all on function public.record_vendor_payout(uuid, numeric, date, text, text, text) from public, anon;
grant execute on function public.record_vendor_payout(uuid, numeric, date, text, text, text) to authenticated;

-- ---- per-event P&L (internal helper; callers check access) ---------------------------------
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124
declare
  q record; v_base numeric; v_chg_rev numeric; v_chg_cost numeric; v_tax numeric; v_rev numeric;
  v_vendor numeric; v_other numeric; v_staff numeric; v_net numeric; v_billed numeric; v_bill_paid numeric;
begin
  select x.id, x.code, x.title, x.event_date, x.pricing, coalesce(nullif(upper(btrim(x.currency)), ''), 'INR') as cur
    into q from public.quotes x where x.id = p_quote and x.org_id = p_org;
  if not found then return null; end if;
  v_base := case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end;
  select coalesce(sum(c.price_delta), 0), coalesce(sum(c.cost_delta), 0) into v_chg_rev, v_chg_cost
    from public.change_requests c where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved';
  v_tax := coalesce(public._r101_quote_tax(q.pricing, v_base), 0);
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
  -- + bills not tied to a booking (or tied to a cancelled one)
  v_vendor := v_vendor + coalesce((select sum(vb.amount) from public.vendor_bills vb
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  -- + vendor cost lines not tied to an active booking
  v_vendor := v_vendor + coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  -- logistics / other: non-vendor cost lines (not tied to a booking) + approved change cost
  v_other := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org and k.kind <> 'vendor'
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0) + v_chg_cost;
  v_staff := coalesce((select sum(x.amount) from public.expense_claims x where x.quote_id = p_quote and x.org_id = p_org and x.status = 'paid'), 0);
  v_net := v_rev - v_vendor - v_other - v_staff;
  select coalesce(sum(vb.amount), 0) into v_billed from public.vendor_bills vb where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  select coalesce(sum(p.amount), 0) into v_bill_paid from public.vendor_payouts p join public.vendor_bills vb on vb.id = p.bill_id
    where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void';
  return jsonb_build_object('quote_id', q.id, 'code', q.code, 'title', q.title, 'date', q.event_date, 'currency', q.cur,
    'revenue', v_rev, 'tax', v_tax, 'vendors', v_vendor, 'other', v_other, 'staff', v_staff, 'net_profit', v_net,
    'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
    'bills_total', v_billed, 'bills_paid', v_bill_paid, 'bills_due', v_billed - v_bill_paid);
end $$;
revoke all on function public._vb_event_pnl(uuid, uuid) from public, anon, authenticated;

create or replace function public.event_pnl(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._vb_event_pnl(p_quote, v_org);
end $$;
revoke all on function public.event_pnl(uuid) from public, anon;
grant execute on function public.event_pnl(uuid) to authenticated;

-- ---- studio payables (what is owed to vendors) ---------------------------------------------
create or replace function public.vendor_payables_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); r jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  with b as (
    select vb.id, vb.amount, vb.due_date, vb.currency,
           coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = vb.id), 0) as paid
      from public.vendor_bills vb where vb.org_id = v_org and vb.status <> 'void')
  select jsonb_build_object(
    'billed', coalesce(sum(amount), 0), 'paid', coalesce(sum(paid), 0),
    'outstanding', coalesce(sum(amount - paid), 0),
    'overdue', coalesce(sum(amount - paid) filter (where due_date < current_date and amount > paid), 0),
    'due_7d', coalesce(sum(amount - paid) filter (where due_date between current_date and current_date + 7 and amount > paid), 0),
    'open_bills', count(*) filter (where amount > paid),
    'overdue_bills', count(*) filter (where due_date < current_date and amount > paid),
    'currencies', coalesce(jsonb_agg(distinct currency), '[]'::jsonb))
    into r from b;
  return r;
end $$;
revoke all on function public.vendor_payables_summary() from public, anon;
grant execute on function public.vendor_payables_summary() to authenticated;

-- ---- business P&L: confirmed events in a date range (net profit by month + top events) -----
create or replace function public.business_pnl(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, current_date - 365);
        v_to date := coalesce(p_to, current_date + 365); v_rows jsonb := '[]'::jsonb; x record; e jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 1100 then raise exception 'range too long (max 3 years)' using errcode = '22023'; end if;
  for x in select q.id from public.quotes q
            where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
              and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
              and q.event_date between v_from and v_to
            order by q.event_date limit 2000 loop
    e := public._vb_event_pnl(x.id, v_org);
    if e is not null then v_rows := v_rows || jsonb_build_array(e); end if;
  end loop;
  return jsonb_build_object('from', v_from, 'to', v_to, 'events', v_rows);
end $$;
revoke all on function public.business_pnl(date, date) from public, anon;
grant execute on function public.business_pnl(date, date) to authenticated;
commit;

-- VERIFY 0124 (read-only; expect every ok = true)
select '0124 vendor_bills table exists' as item, to_regclass('public.vendor_bills') is not null as ok
union all select '0124 vendor_payouts table exists', to_regclass('public.vendor_payouts') is not null
union all select '0124 RLS forced on vendor_bills', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_bills')), false)
union all select '0124 RLS forced on vendor_payouts', coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.vendor_payouts')), false)
union all select '0124 no delete policy on bills or payouts', not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('vendor_bills', 'vendor_payouts') and cmd in ('DELETE', 'ALL'))
union all select '0124 users cannot delete bills', not has_table_privilege('authenticated', 'public.vendor_bills', 'delete')
union all select '0124 users cannot write payouts directly', not has_table_privilege('authenticated', 'public.vendor_payouts', 'insert') and not has_table_privilege('authenticated', 'public.vendor_payouts', 'delete')
union all select '0124 bills need finance area', coalesce((select bool_and(coalesce(qual, with_check) like '%has_area%finance%') from pg_policies where schemaname = 'public' and tablename = 'vendor_bills'), false)
union all select '0124 record_vendor_payout exists', to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)') is not null
union all select '0124 payout refuses overpayment', coalesce(pg_get_functiondef(to_regprocedure('public.record_vendor_payout(uuid, numeric, date, text, text, text)')) like '%overpay%', false)
union all select '0124 payout idempotency index', to_regclass('public.ux_vendor_payouts_idem') is not null
union all select '0124 event_pnl exists', to_regprocedure('public.event_pnl(uuid)') is not null
union all select '0124 vendor_payables_summary exists', to_regprocedure('public.vendor_payables_summary()') is not null
union all select '0124 business_pnl exists', to_regprocedure('public.business_pnl(date, date)') is not null
union all select '0124 anon may NOT run event_pnl', not has_function_privilege('anon', 'public.event_pnl(uuid)', 'execute')
union all select '0124 helper is private', not has_function_privilege('authenticated', 'public._vb_event_pnl(uuid, uuid)', 'execute')
union all select '0124 bill guard trigger', exists (select 1 from pg_trigger where tgname = 'vendor_bills_guard' and tgrelid = to_regclass('public.vendor_bills'))
union all select '0124 payouts immutable trigger', exists (select 1 from pg_trigger where tgname = 'vendor_payouts_immutable' and tgrelid = to_regclass('public.vendor_payouts'));
