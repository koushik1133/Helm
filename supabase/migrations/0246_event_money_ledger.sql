-- 0246_event_money_ledger.sql - CANONICAL forward-only.
-- REQUIRES 0124 + 0142 + 0146 (_vb_event_pnl / event_pnl / vendor bills + payouts), 0049 (event_closure),
--          0072 (inventory write-offs), 0196 (event_costs.requirement_key), 0239 (business area),
--          phase29 / phase57 (has_area), is_admin().
--
-- In plain words (r21 owner, EVENT-MONEY-CLOSURE-PLAN.md Phase 1 "correct margin"; Rentman / Current RMS job
-- costing + Planning Pod estimated / actual grid):
--   1  ONE server-side cost ledger per event. Every cost line has a CATEGORY (venue, food, decor, rentals,
--      other vendors, staff & crew wages, misc / petty cash / staff expenses, logistics, damages & loss,
--      change orders, contingency) and three STAGES side by side:
--        Estimated  = what we planned (budget line estimate, else the booking cost, crew x day rate)
--        Committed  = what we agreed (booking booked / confirmed / delivered or contract ticked, crew who
--                     accepted, approved change orders, expense claims waiting for approval)
--        Actual     = what really happened (vendor bills, typed actuals, event-day attendance x day rate,
--                     approved / paid expense claims, equipment written off x item cost)
--      Built only from rows that already exist (event_costs, event_resources, vendor_bills + vendor_payouts,
--      event_tasks + crew_members.day_rate + event_day arrivals, expense_claims, change_requests,
--      inventory_checkouts.written_off + inventory_items.unit_cost, event_refunds). Nothing is copied.
--   2  STAFF WAGES COUNT (gap G1). Every crew member assigned to the event (tasks) or on its arrival roster
--      is one line: estimate = day rate x 1 day, committed once they accepted, actual from the event-day
--      roster (arrived = day rate, no-show = 0). A typed "Staff" budget line is NOT dropped automatically:
--      it is replaced by the crew lines only when someone ticks it (new event_costs.crew_covered); until
--      then the page warns "may count the same people twice". Day rates stay admin-only: the line-level
--      RPC returns per-person crew lines only to an admin, everyone else sees one combined crew line.
--   3  ESTIMATES ARE NO LONGER SILENT ACTUALS (gap G2). The P&L returns the margin three ways:
--        estimated margin (plan), expected margin (actual where known, else committed, else estimate)
--        and actual margin (actuals only), plus accuracy % = share of the expected cost that is actual.
--      A contingency line counts in the plan only (it is a buffer, not a cost) unless an actual is typed.
--   4  GST ON VENDOR BILLS (gap G3, data part). New optional vendor_bills.gst_amount (GST inside the bill
--      amount) and gst_claimable (input credit can be claimed; empty = yes, except food / catering = no).
--      When a bill has the split, margin counts the bill WITHOUT claimable GST (that part is returned as
--      input_tax); blocked GST stays a cost. A bill without the split counts as today and is flagged
--      "GST unknown". No existing bill is changed.
--   5  Refunds come off revenue WITHOUT their GST part (gap G10), split at the event's own tax rate.
--   6  OLD CLOSED EVENTS KEEP THEIR NUMBERS. A one-row marker (helm_money_rules 'r21-ledger', written once)
--      records when these rules started. An event closed BEFORE that keeps the 0146 numbers in every old
--      key (net_profit, vendors, other, staff, refunds, margin_pct) with rules = 'legacy'; the new figures
--      ride along under 'r21' for a read-only "with the new rules" preview. Events still open, re-opened,
--      or closed after the marker use the new rules (rules = 'r21').
--   7  event_pnl / business_pnl / Settlement / Budget / Closure keep calling _vb_event_pnl: same signature,
--      every old key kept (for 'r21' events: net_profit = expected margin, staff = crew wages + expense
--      claims, refunds ex-GST, so net_profit = revenue - vendors - other - staff - refunds still adds up),
--      plus new keys. The 0146 body is kept as _vb_event_pnl__pre0246 (renamed once, not callable by the app).
--   8  Two read RPCs for pages (Budget & margin, Closure) and for Insights:
--        event_cost_breakdown(quote)        -> one event: P&L, per-category variance, lines, warnings
--        studio_cost_breakdown(from, to)    -> every confirmed event in the range + totals per currency
--      Same studio only; event_cost_breakdown needs finance view (like event_pnl); studio_cost_breakdown
--      also needs the Business or Insights area (studio-wide money is admin-only by default, 0239).
--   9  insights_event_costs(from, to) (fix/r21-insights 0240) re-issued with the same signature, access and keys,
--      its parts now from this ledger: 'crew' includes the automatic crew wages (never double with a ticked staff
--      line), 'expense_claims' = staff expense claims only, refunds ex-GST, profit = event_pnl net_profit.
--      Apply AFTER 0240 when 0240 is installed (0240 re-run after this would STOP on its own guard, changing nothing).
-- Additive + idempotent: 3 new nullable / defaulted columns, 1 marker table (one row, insert once), functions
-- create-or-replace, one rename done once. No row updated or deleted, no policy changed. Safe to run twice.
-- ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved):
--   drop function public._vb_event_pnl(uuid, uuid);
--   alter function public._vb_event_pnl__pre0246(uuid, uuid) rename to _vb_event_pnl;
--   revoke all on function public._vb_event_pnl(uuid, uuid) from public, anon, authenticated;
--   drop function public.event_cost_breakdown(uuid); drop function public.studio_cost_breakdown(date, date);
--   re-run 0240 for the keyword-based insights_event_costs (only after the _vb_event_pnl restore above);
--   (the new columns + marker row can stay; nothing reads them then)

do $$ begin
  if to_regclass('public.vendor_bills') is null or to_regclass('public.vendor_payouts') is null
     or to_regprocedure('public.event_pnl(uuid)') is null then
    raise exception 'STOP: 0124 (vendor bills / event_pnl) is not applied'; end if;
  if to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)') is null then
    if to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null then
      raise exception 'STOP: _vb_event_pnl is missing (0124 / 0146)'; end if;
    if position('aud1017' in (select prosrc from pg_proc where oid = to_regprocedure('public._vb_event_pnl(uuid,uuid)'))) = 0 then
      raise exception 'STOP: _vb_event_pnl is not the 0146 body (apply 0146 first)'; end if;
  end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP: has_area / is_admin / current_org_id missing'; end if;
  if to_regclass('public.event_closure') is null or to_regclass('public.event_day') is null
     or to_regclass('public.event_tasks') is null or to_regclass('public.crew_members') is null
     or to_regclass('public.expense_claims') is null or to_regclass('public.event_refunds') is null
     or to_regclass('public.change_requests') is null or to_regclass('public.inventory_checkouts') is null then
    raise exception 'STOP: an event money table is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts' and column_name = 'written_off')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_costs' and column_name = 'requirement_key') then
    raise exception 'STOP: 0072 (written_off) / 0196 (requirement_key) is not applied'; end if;
end $$;

-- ---- 1) new columns (nullable / defaulted; no existing row rewritten) ---------------------------------------
alter table public.event_costs add column if not exists crew_covered boolean not null default false;
comment on column public.event_costs.crew_covered is
  '0246: true = this typed staff line is replaced by the automatic crew wage lines (crew x day rate) in the margin';
alter table public.vendor_bills add column if not exists gst_amount numeric;
alter table public.vendor_bills add column if not exists gst_claimable boolean;
comment on column public.vendor_bills.gst_amount is '0246: GST included in amount (optional; empty = GST unknown)';
comment on column public.vendor_bills.gst_claimable is '0246: input credit can be claimed (empty = yes, except food / catering = no)';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.vendor_bills'::regclass and conname = 'vendor_bills_gst_0246_ck') then
    alter table public.vendor_bills add constraint vendor_bills_gst_0246_ck
      check (gst_amount is null or (gst_amount >= 0 and gst_amount < amount));
  end if;
end $$;

-- ---- 2) when the new margin rules started (written once, never moved) ---------------------------------------
create table if not exists public.helm_money_rules (
  rule text primary key,
  effective_at timestamptz not null default now(),
  note text
);
alter table public.helm_money_rules enable row level security;
alter table public.helm_money_rules force row level security;
revoke all on public.helm_money_rules from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.helm_money_rules from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on public.helm_money_rules from authenticated'; end if;
end $$;
insert into public.helm_money_rules(rule, effective_at, note)
  values ('r21-ledger', now(), 'events closed before this keep their recorded (legacy) P&L numbers')
  on conflict (rule) do nothing;

-- ---- 3) category of a cost from its words (same order as public/budget-plan.js STD) ---------------------------
create or replace function public._r21_category(p_text text, p_default text)
returns text language sql immutable set search_path = '' as $$
  -- r21-money-0246
  select case
    when f ~ '^std:' then coalesce((select m.c from (values ('std:venue', 'venue'), ('std:catering', 'food'), ('std:furniture', 'rentals'),
           ('std:decor', 'decor'), ('std:sound', 'rentals'), ('std:staff', 'staff'), ('std:logistics', 'logistics'),
           ('std:contingency', 'contingency')) m(k, c) where m.k = split_part(f, ' ', 1)), p_default)
    when f ~ '\m(venue|hall|lawn|banquet|ballroom|resort|location|space rent)' then 'venue'
    when f ~ '(cater|food|menu|meal|buffet|plate|dinner|lunch|breakfast|snack|beverage|drink|\mbar\M|chef|kitchen|cuisine)' then 'food'
    when f ~ '(chair|seat|furniture|\mtables?\M|sofa|lounge|couch|tent|shamiana)' then 'rentals'
    when f ~ '(decor|flor|flower|mandap|backdrop|centerpiece|centrepiece|drap|theme|balloon|garland)' then 'decor'
    when f ~ '(sound|light|audio|\mdj\M|\mav\M|\mled\M|stage|speaker|\mmics?\M|music|truss|projector|rental|equipment)' then 'rentals'
    when f ~ '(staff|crew|waiter|manpower|security|bouncer|\mhosts?\M|anchor|emcee|\mmc\M|helper|labou?r|coordinator)' then 'staff'
    when f ~ '(logistic|transport|truck|vehicle|delivery|travel|parking|valet|generator|\mpower\M|cartage)' then 'logistics'
    when f ~ '(contingen|buffer)' then 'contingency'
    when f ~ '(miscellaneous|\mmisc\M|petty)' then 'misc'
    else p_default end
  from (select lower(btrim(coalesce(p_text, ''))) as f) x;
$$;

create or replace function public._r21_category_label(p_cat text)
returns text language sql immutable set search_path = '' as $$
  -- r21-money-0246
  select case p_cat
    when 'venue' then 'Venue' when 'food' then 'Food & catering' when 'decor' then 'Decor & flowers'
    when 'rentals' then 'Rentals & equipment' when 'vendors' then 'Other vendors' when 'staff' then 'Staff & crew wages'
    when 'misc' then 'Misc, petty cash & staff expenses' when 'logistics' then 'Logistics & transport'
    when 'damages' then 'Damages & loss' when 'changes' then 'Change orders' when 'contingency' then 'Contingency (estimate only)'
    else coalesce(p_cat, 'Other') end;
$$;

-- ---- 4) the cost lines of one event (internal: callers check the studio + access) ------------------------------
-- Each line: raw stages (estimated / committed / actual, null = not known) and the amounts it COUNTS in each
-- total (c_est / c_com / c_fc = expected / c_act). A line replaced by another source counts 0 and says why.
create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246
declare
  v_lines jsonb := '[]'::jsonb; v_part jsonb;
  v_lb numeric; v_llf numeric; v_bills_win boolean; v_has_crew boolean;
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org) then return null; end if;

  -- crew on this event: assigned by a live task, or on the arrival roster (a crew member of this studio)
  v_has_crew := exists (select 1 from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = p_org
                         where t.quote_id = p_quote and t.org_id = p_org and t.status not in ('rejected', 'cancelled', 'unassigned'))
             or exists (select 1 from public.event_day d join public.crew_members cm on cm.id = d.ref_id and cm.org_id = p_org
                         where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival');

  -- A) active vendor bookings: one line each (bills, else a typed actual on its cost line(s), else committed / estimate)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'booking:' || x.id, 'source', 'booking', 'source_id', x.id, 'category', x.cat, 'label', x.label,
      'estimated', x.est, 'committed', x.com, 'actual', x.act,
      'c_est', x.est, 'c_com', coalesce(x.com, 0), 'c_fc', coalesce(x.act, x.com, x.est), 'c_act', coalesce(x.act, 0),
      'paid', x.paid, 'gst_status', x.gst_status, 'input_tax', x.itc, 'blocked_gst', x.blocked,
      'bills', x.nbills, 'note', x.note) order by x.cat, x.label), '[]'::jsonb)
    into v_part
  from (
    select b.id, coalesce(nullif(btrim(b.label), ''), 'Vendor booking') as label, y.cat,
           case when coalesce(l.est, 0) > 0 then l.est else coalesce(b.cost, l.est, 0) end as est,
           case when b.status in ('booked', 'confirmed', 'delivered') or b.contract
                then coalesce(b.cost, case when coalesce(l.est, 0) > 0 then l.est end) end as com,
           case when bl.n > 0 then bl.cost when l.n > 0 and l.n_act = l.n then l.act end as act,
           coalesce(bl.paid, 0) + coalesce(b.advance, 0) as paid,
           case when bl.n > 0 then case when bl.n_unknown > 0 then 'unknown' else 'split' end end as gst_status,
           coalesce(bl.itc, 0) as itc, coalesce(bl.blocked, 0) as blocked, coalesce(bl.n, 0) as nbills,
           case when bl.n > 0 then 'actual from ' || bl.n || ' vendor bill(s)'
                when l.n > 0 and l.n_act = l.n then 'actual typed on the budget line'
                when b.status in ('booked', 'confirmed', 'delivered') or b.contract then 'booked - no bill yet'
                else 'enquiry - estimate only' end as note
      from public.event_resources b
      left join public.vendors v on v.id = b.vendor_id and v.org_id = p_org
      left join lateral (
        select count(*) as n, count(k.actual) as n_act, sum(k.estimated) as est, sum(k.actual) as act,
               string_agg(coalesce(k.requirement_key, '') || ' ' || coalesce(k.category, '') || ' ' || coalesce(k.description, ''), ' ') as words
          from public.event_costs k where k.booking_id = b.id and k.org_id = p_org and k.quote_id = p_quote) l on true
      left join lateral (
        select count(*) as n, count(*) filter (where vb.gst_amount is null) as n_unknown,
               sum(vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as cost,
               sum(case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end) as itc,
               sum(case when vb.gst_amount is not null and not z.claim then vb.gst_amount else 0 end) as blocked,
               sum((select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id)) as paid
          from public.vendor_bills vb
          cross join lateral (select coalesce(vb.gst_claimable,
                      public._r21_category(coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, ''), 'vendors') <> 'food') as claim) z
         where vb.booking_id = b.id and vb.org_id = p_org and vb.status <> 'void') bl on true
      cross join lateral (select public._r21_category(
                  case when l.words ~ '(^| )std:' then substring(l.words from 'std:[a-z]+')
                       else coalesce(l.words, '') || ' ' || coalesce(b.kind, '') || ' ' || coalesce(b.label, '') || ' ' || coalesce(v.category, '') end,
                  'vendors') as cat) y
     where b.quote_id = p_quote and b.org_id = p_org and b.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  -- B) vendor spend NOT tied to an active booking has ONE source (0146 rule): the unlinked bills or the
  --    unlinked "vendor" cost lines, whichever is larger - never both. The other side shows, counted 0.
  v_lb := coalesce((select sum(vb.amount - case when vb.gst_amount is not null and coalesce(vb.gst_claimable,
                         public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') <> 'food')
                       then vb.gst_amount else 0 end)
       from public.vendor_bills vb left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
        and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')), 0);
  v_llf := coalesce((select sum(coalesce(k.actual, k.estimated)) from public.event_costs k
      where k.quote_id = p_quote and k.org_id = p_org and k.kind = 'vendor' and not (k.crew_covered and v_has_crew)
        and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')), 0);
  v_bills_win := v_lb > 0 and v_lb >= v_llf;

  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'bill:' || x.id, 'source', 'bill', 'source_id', x.id, 'category', x.cat,
      'label', x.label, 'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', case when v_bills_win then x.cost else 0 end, 'c_act', case when v_bills_win then x.cost else 0 end,
      'paid', x.paid, 'gst_status', case when x.gst_amount is null then 'unknown' else 'split' end,
      'input_tax', case when v_bills_win and x.gst_amount is not null and x.claim then x.gst_amount else 0 end,
      'blocked_gst', case when v_bills_win and x.gst_amount is not null and not x.claim then x.gst_amount else 0 end,
      'bills', 1,
      'note', case when v_bills_win then 'vendor bill not linked to a booking' else 'not counted: the vendor cost lines for this spend are larger' end)
      order by x.bill_date, x.id), '[]'::jsonb)
    into v_part
  from (
    select vb.id, vb.bill_date, vb.gst_amount, z.cat, z.claim,
           coalesce(nullif(btrim(coalesce(v.name, '') || case when vb.bill_no is not null then ' #' || vb.bill_no else '' end), ''), 'Vendor bill') as label,
           vb.amount - case when vb.gst_amount is not null and z.claim then vb.gst_amount else 0 end as cost,
           (select coalesce(sum(p.amount), 0) from public.vendor_payouts p where p.bill_id = vb.id) as paid
      from public.vendor_bills vb
      left join public.vendors v on v.id = vb.vendor_id and v.org_id = p_org
      cross join lateral (select public._r21_category(coalesce(v.category, '') || ' ' || coalesce(v.name, '') || ' ' || coalesce(vb.description, ''), 'vendors') as cat) c0
      cross join lateral (select c0.cat as cat, coalesce(vb.gst_claimable, c0.cat <> 'food') as claim) z
     where vb.quote_id = p_quote and vb.org_id = p_org and vb.status <> 'void'
       and not exists (select 1 from public.event_resources b where b.id = vb.booking_id and b.status <> 'cancelled')) x;
  v_lines := v_lines || v_part;

  -- C) budget lines not tied to an active booking (vendor lines follow rule B; contingency is plan-only;
  --    a line ticked "replaced by crew wages" counts 0 while the event has crew)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'cost:' || x.id, 'source', case when x.kind = 'vendor' then 'vendor_line' else 'cost_line' end, 'source_id', x.id,
      'category', x.cat, 'label', x.label, 'estimated', x.estimated, 'committed', null, 'actual', x.actual,
      'c_est', case when x.replaced then 0 else x.estimated end, 'c_com', 0,
      'c_fc', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0
                   when x.cat = 'contingency' then coalesce(x.actual, 0) else coalesce(x.actual, x.estimated) end,
      'c_act', case when x.replaced or (x.kind = 'vendor' and v_bills_win) then 0 else coalesce(x.actual, 0) end,
      'paid', null, 'crew_covered', x.crew_covered, 'staff_like', x.cat = 'staff',
      'note', case when x.replaced then 'replaced by the crew wage lines'
                   when x.kind = 'vendor' and v_bills_win then 'in the plan only: the unlinked vendor bills count instead'
                   when x.cat = 'contingency' then 'buffer - counts in the plan only'
                   when x.actual is not null then 'actual typed on the budget line'
                   else 'estimate only - no actual yet' end)
      order by x.created_at, x.id), '[]'::jsonb)
    into v_part
  from (
    select k.id, k.kind, k.estimated, k.actual, k.created_at, k.crew_covered,
           coalesce(nullif(btrim(k.description), ''), 'Cost line') as label,
           (k.crew_covered and v_has_crew) as replaced,
           public._r21_category(case when k.requirement_key ~ '^std:' then k.requirement_key
                                     else coalesce(k.category, '') || ' ' || coalesce(k.description, '') end,
                                case when k.kind = 'vendor' then 'vendors' else 'misc' end) as cat
      from public.event_costs k
     where k.quote_id = p_quote and k.org_id = p_org
       and not exists (select 1 from public.event_resources b where b.id = k.booking_id and b.status <> 'cancelled')) x;
  v_lines := v_lines || v_part;

  -- D) crew wages: one line per person (day rate x 1 day; actual from the event-day roster)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'crew:' || x.id, 'source', 'crew', 'source_id', x.id, 'crew_id', x.id, 'category', 'staff',
      'label', x.name, 'day_rate', x.rate, 'rate_missing', coalesce(x.rate, 0) = 0,
      'estimated', coalesce(x.rate, 0), 'committed', case when x.accepted then coalesce(x.rate, 0) end,
      'actual', case when x.arrived then coalesce(x.rate, 0) when x.no_show then 0 end,
      'c_est', coalesce(x.rate, 0), 'c_com', case when x.accepted then coalesce(x.rate, 0) else 0 end,
      'c_fc', case when x.arrived then coalesce(x.rate, 0) when x.no_show then 0 else coalesce(x.rate, 0) end,
      'c_act', case when x.arrived then coalesce(x.rate, 0) else 0 end,
      'attendance', case when x.arrived then 'arrived' when x.no_show then 'no_show' else 'not_marked' end,
      'paid', null,
      'note', case when coalesce(x.rate, 0) = 0 then 'day rate missing - set it on the Staff page'
                   when x.arrived then 'arrived on the event day (1 day)'
                   when x.no_show then 'no-show on the event day (no wage)'
                   when x.accepted then 'accepted - attendance not marked yet'
                   else 'assigned - not accepted yet' end)
      order by x.name, x.id), '[]'::jsonb)
    into v_part
  from (
    select cm.id, coalesce(nullif(btrim(cm.name), ''), 'Crew member') as name, cm.day_rate as rate,
           exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                     and (t.status in ('accepted', 'in_progress', 'completed') or (t.responded_at is not null and t.status not in ('rejected', 'cancelled')))) as accepted,
           exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                     and d.ref_id = cm.id and d.status = 'arrived') as arrived,
           exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival'
                     and d.ref_id = cm.id and d.status = 'no_show') as no_show
      from public.crew_members cm
     where cm.org_id = p_org
       and (exists (select 1 from public.event_tasks t where t.quote_id = p_quote and t.org_id = p_org and t.crew_id = cm.id
                      and t.status not in ('rejected', 'cancelled', 'unassigned'))
         or exists (select 1 from public.event_day d where d.quote_id = p_quote and d.org_id = p_org and d.kind = 'arrival' and d.ref_id = cm.id))) x;
  v_lines := v_lines || v_part;

  -- E) expense claims (staff out-of-pocket): waiting = committed, approved / paid = actual, rejected = not a cost
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'claim:' || e.id, 'source', 'claim', 'source_id', e.id, 'category', 'misc',
      'label', 'Expense: ' || left(coalesce(nullif(btrim(e.who), ''), 'staff') || coalesce(' - ' || nullif(btrim(e.description), ''), ''), 160),
      'estimated', null, 'committed', case when e.status = 'pending' then e.amount end,
      'actual', case when e.status in ('approved', 'paid') then e.amount end,
      'c_est', 0, 'c_com', case when e.status = 'pending' then e.amount else 0 end,
      'c_fc', e.amount, 'c_act', case when e.status in ('approved', 'paid') then e.amount else 0 end,
      'paid', case when e.status = 'paid' then e.amount else 0 end, 'status', e.status,
      'note', case e.status when 'pending' then 'claim waiting for approval' when 'approved' then 'approved - not paid yet' else 'paid' end)
      order by e.created_at, e.id), '[]'::jsonb)
    into v_part
  from public.expense_claims e
  where e.quote_id = p_quote and e.org_id = p_org and e.status <> 'rejected';
  v_lines := v_lines || v_part;

  -- F) approved change orders: their extra cost is agreed (committed); the real spend arrives as a bill / line
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'change:' || c.id, 'source', 'change', 'source_id', c.id, 'category', 'changes',
      'label', 'Change: ' || left(coalesce(nullif(btrim(c.title), ''), 'change order'), 160),
      'estimated', c.cost_delta, 'committed', c.cost_delta, 'actual', null,
      'c_est', c.cost_delta, 'c_com', c.cost_delta, 'c_fc', c.cost_delta, 'c_act', 0, 'paid', null,
      'note', 'approved change order - extra cost agreed')
      order by c.created_at, c.id), '[]'::jsonb)
    into v_part
  from public.change_requests c
  where c.quote_id = p_quote and c.org_id = p_org and c.status = 'approved' and c.cost_delta <> 0;
  v_lines := v_lines || v_part;

  -- G) our own equipment written off at check-in: written off x the item's cost (absorbed by the event)
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', 'writeoff:' || x.id, 'source', 'writeoff', 'source_id', x.id, 'category', 'damages',
      'label', x.name || ' x' || trim(to_char(x.written_off, 'FM999999990.##')),
      'estimated', null, 'committed', null, 'actual', x.cost,
      'c_est', 0, 'c_com', 0, 'c_fc', x.cost, 'c_act', x.cost, 'paid', null, 'cost_missing', x.unit_cost = 0,
      'note', case when x.unit_cost = 0 then 'written off - item cost missing (set it in Inventory)' else 'written off at check-in' end)
      order by x.name, x.id), '[]'::jsonb)
    into v_part
  from (
    select ch.id, ch.written_off, coalesce(i.unit_cost, 0) as unit_cost,
           coalesce(nullif(btrim(i.name), ''), 'Item') as name, round(ch.written_off * coalesce(i.unit_cost, 0), 2) as cost
      from public.inventory_checkouts ch join public.inventory_items i on i.id = ch.item_id and i.org_id = p_org
     where ch.quote_id = p_quote and ch.org_id = p_org and ch.written_off > 0 and ch.status <> 'cancelled') x;
  v_lines := v_lines || v_part;

  return v_lines;
end $$;

-- ---- 5) the whole money picture of one event (internal) --------------------------------------------------------
create or replace function public._r21_event_money(p_quote uuid, p_org uuid, p_lines boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246
declare
  v_old jsonb; v_lines jsonb; v_rev numeric; v_tax numeric; v_ref numeric; v_ref_ex numeric; v_net_rev numeric;
  t record; v_cats jsonb; v_warn jsonb := '[]'::jsonb; v_closed timestamptz; v_cut timestamptz; v_rules text;
  v_ev date; n int; a numeric;
begin
  v_old := public._vb_event_pnl__pre0246(p_quote, p_org);
  if v_old is null then return null; end if;
  v_lines := coalesce(public._r21_cost_lines(p_quote, p_org), '[]'::jsonb);
  v_rev := coalesce((v_old ->> 'revenue')::numeric, 0); v_tax := coalesce((v_old ->> 'tax')::numeric, 0);
  v_ref := coalesce((v_old ->> 'refunds')::numeric, 0);
  -- G10: a refund gives back revenue AND the GST on it - split at this event's own rate
  v_ref_ex := case when v_rev + v_tax > 0 and v_tax > 0 then round(v_ref * v_rev / (v_rev + v_tax), 2) else v_ref end;
  v_net_rev := v_rev - v_ref_ex;

  select coalesce(sum((l ->> 'c_est')::numeric), 0) as est, coalesce(sum((l ->> 'c_com')::numeric), 0) as com,
         coalesce(sum((l ->> 'c_fc')::numeric), 0) as fc, coalesce(sum((l ->> 'c_act')::numeric), 0) as act,
         coalesce(sum((l ->> 'input_tax')::numeric), 0) as itc, coalesce(sum((l ->> 'blocked_gst')::numeric), 0) as blocked,
         coalesce(sum((l ->> 'c_fc')::numeric) filter (where l ->> 'source' in ('booking', 'bill', 'vendor_line')), 0) as vendors,
         coalesce(sum((l ->> 'c_fc')::numeric) filter (where l ->> 'source' in ('cost_line', 'change', 'writeoff')), 0) as other,
         coalesce(sum((l ->> 'c_fc')::numeric) filter (where l ->> 'source' = 'crew'), 0) as wages,
         coalesce(sum((l ->> 'c_fc')::numeric) filter (where l ->> 'source' = 'claim'), 0) as claims
    into t from jsonb_array_elements(v_lines) l;

  select coalesce(jsonb_agg(jsonb_build_object('key', c.k, 'label', public._r21_category_label(c.k),
            'estimated', c.est, 'committed', c.com, 'actual', c.act, 'expected', c.fc, 'variance', c.fc - c.est,
            'variance_pct', case when c.est > 0 then round((c.fc - c.est) / c.est * 100) end,
            'estimate_only', c.fc - c.act, 'paid', c.paid, 'lines', c.n) order by c.ord), '[]'::jsonb)
    into v_cats
  from (select o.k, o.ord, coalesce(sum((l ->> 'c_est')::numeric), 0) as est, coalesce(sum((l ->> 'c_com')::numeric), 0) as com,
               coalesce(sum((l ->> 'c_fc')::numeric), 0) as fc, coalesce(sum((l ->> 'c_act')::numeric), 0) as act,
               coalesce(sum((l ->> 'paid')::numeric), 0) as paid, count(l) as n
          from (values ('venue', 1), ('food', 2), ('decor', 3), ('rentals', 4), ('vendors', 5), ('staff', 6), ('misc', 7),
                       ('logistics', 8), ('damages', 9), ('changes', 10), ('contingency', 11)) o(k, ord)
          left join jsonb_array_elements(v_lines) l on l ->> 'category' = o.k
         group by o.k, o.ord) c
  where c.n > 0;

  -- warnings (plain words; counts and amounts only - never a person's rate)
  n := (select count(*) from jsonb_array_elements(v_lines) l where l ->> 'source' = 'crew' and (l ->> 'rate_missing')::boolean);
  if n > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'crew_rate_missing', 'count', n,
    'text', n || ' crew member(s) on this event have no day rate, so their wages count as 0. Set the rate on the Staff page.')); end if;
  if exists (select 1 from jsonb_array_elements(v_lines) l where l ->> 'source' = 'crew') then
    select count(*), coalesce(sum((l ->> 'c_fc')::numeric), 0) into n, a from jsonb_array_elements(v_lines) l
     where l ->> 'source' in ('cost_line', 'vendor_line') and (l ->> 'staff_like')::boolean and not (l ->> 'crew_covered')::boolean
       and ((l ->> 'c_fc')::numeric > 0 or (l ->> 'c_est')::numeric > 0);
    if n > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'staff_double_count', 'count', n, 'amount', a,
      'text', 'A typed staff budget line and the automatic crew wages may count the same people twice. If the crew wages cover it, mark the line "Replaced by crew wages".')); end if;
  end if;
  select count(*), coalesce(sum((l ->> 'actual')::numeric), 0) into n, a from jsonb_array_elements(v_lines) l
   where l ->> 'source' in ('booking', 'bill') and l ->> 'gst_status' = 'unknown' and (l ->> 'c_act')::numeric > 0;
  if n > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'gst_unknown', 'count', n, 'amount', a,
    'text', n || ' vendor cost(s) from bills without the GST split are counted with their GST. Add the GST on the bill to count it without claimable GST.')); end if;
  select q.event_date into v_ev from public.quotes q where q.id = p_quote;
  n := (select count(*) from jsonb_array_elements(v_lines) l where l ->> 'source' = 'crew' and l ->> 'attendance' = 'not_marked');
  if n > 0 and v_ev is not null and v_ev < current_date then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'attendance_not_marked', 'count', n,
    'text', n || ' crew member(s) have no arrival marked for the event day, so their wages are still an estimate.')); end if;
  n := (select count(*) from jsonb_array_elements(v_lines) l where l ->> 'source' = 'writeoff' and (l ->> 'cost_missing')::boolean);
  if n > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'writeoff_cost_missing', 'count', n,
    'text', n || ' written-off item(s) have no item cost, so the loss counts as 0. Set the cost in Inventory.')); end if;
  if t.fc - t.act > 0 then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'estimate_only', 'amount', t.fc - t.act,
    'text', 'Part of the cost is still an estimate or a commitment (no bill, attendance or receipt yet).')); end if;

  -- legacy: an event closed before these rules started keeps its recorded numbers
  select c.closed_at into v_closed from public.event_closure c where c.quote_id = p_quote and c.org_id = p_org;
  select r.effective_at into v_cut from public.helm_money_rules r where r.rule = 'r21-ledger';
  v_rules := case when v_closed is not null and v_cut is not null and v_closed < v_cut then 'legacy' else 'r21' end;

  return jsonb_build_object(
    'quote_id', v_old -> 'quote_id', 'code', v_old -> 'code', 'title', v_old -> 'title', 'date', v_old -> 'date',
    'currency', v_old -> 'currency', 'rules', v_rules, 'closed_at', v_closed, 'rules_since', v_cut,
    'revenue', v_rev, 'tax', v_tax, 'refunds', v_ref, 'refunds_ex_tax', v_ref_ex, 'refunds_tax', v_ref - v_ref_ex,
    'net_revenue', v_net_rev,
    'cost_estimated', t.est, 'cost_committed', t.com, 'cost_expected', t.fc, 'cost_actual', t.act,
    'cost_vendors', t.vendors, 'cost_other', t.other, 'cost_wages', t.wages, 'cost_claims', t.claims,
    'margin_estimated', v_net_rev - t.est, 'margin_expected', v_net_rev - t.fc, 'margin_actual', v_net_rev - t.act,
    'margin_estimated_pct', case when v_net_rev <> 0 then round((v_net_rev - t.est) / v_net_rev * 100) end,
    'margin_expected_pct', case when v_net_rev <> 0 then round((v_net_rev - t.fc) / v_net_rev * 100) end,
    'margin_actual_pct', case when v_net_rev <> 0 then round((v_net_rev - t.act) / v_net_rev * 100) end,
    'gross_margin', v_net_rev - t.fc, 'overhead', 0, 'net_margin', v_net_rev - t.fc,
    'net_margin_pct', case when v_net_rev <> 0 then round((v_net_rev - t.fc) / v_net_rev * 100) end,
    'accuracy_pct', case when t.fc > 0 then floor(t.act / t.fc * 100) when t.fc = 0 and t.act = 0 then null end,
    'input_tax', t.itc, 'blocked_gst', t.blocked, 'gst_payable_estimate', greatest(v_tax - (v_ref - v_ref_ex) - t.itc, 0),
    'by_category', v_cats, 'warnings', v_warn,
    'legacy', jsonb_build_object('net_profit', v_old -> 'net_profit', 'margin_pct', v_old -> 'margin_pct',
                                 'vendors', v_old -> 'vendors', 'other', v_old -> 'other', 'staff', v_old -> 'staff',
                                 'refunds', v_old -> 'refunds'),
    'bills_total', v_old -> 'bills_total', 'bills_paid', v_old -> 'bills_paid', 'bills_due', v_old -> 'bills_due')
    || case when p_lines then jsonb_build_object('lines', v_lines) else '{}'::jsonb end;
end $$;

-- ---- 6) _vb_event_pnl: same signature, every old key kept; 0146 body kept as __pre0246 -------------------------
do $$ begin
  if to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)') is null then
    alter function public._vb_event_pnl(uuid, uuid) rename to _vb_event_pnl__pre0246;
  end if;
end $$;

create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246: wraps the 0146 body (_vb_event_pnl__pre0246); legacy events keep its numbers
declare v_old jsonb; m jsonb; v_cats jsonb;
begin
  v_old := public._vb_event_pnl__pre0246(p_quote, p_org);
  if v_old is null then return null; end if;
  m := public._r21_event_money(p_quote, p_org, false);
  if m is null then return v_old; end if;
  select coalesce(jsonb_object_agg(c ->> 'key', (c ->> 'expected')::numeric), '{}'::jsonb) into v_cats
    from jsonb_array_elements(m -> 'by_category') c;
  if m ->> 'rules' = 'legacy' then
    return v_old || jsonb_build_object('rules', 'legacy', 'closed_at', m -> 'closed_at',
      'r21', jsonb_build_object('net_profit', m -> 'margin_expected', 'margin_pct', m -> 'margin_expected_pct',
        'cost_estimated', m -> 'cost_estimated', 'cost_actual', m -> 'cost_actual', 'cost_expected', m -> 'cost_expected',
        'accuracy_pct', m -> 'accuracy_pct', 'wages', m -> 'cost_wages'));
  end if;
  return v_old || jsonb_build_object(
    'rules', 'r21',
    'vendors', m -> 'cost_vendors', 'other', m -> 'cost_other',
    'staff', ((m ->> 'cost_wages')::numeric + (m ->> 'cost_claims')::numeric),
    'wages', m -> 'cost_wages', 'expenses', m -> 'cost_claims',
    'refunds', m -> 'refunds_ex_tax', 'refunds_tax', m -> 'refunds_tax',
    'net_profit', m -> 'margin_expected',
    'margin_pct', case when (m ->> 'revenue')::numeric <> 0 then round((m ->> 'margin_expected')::numeric / (m ->> 'revenue')::numeric * 100) end,
    'net_revenue', m -> 'net_revenue',
    'cost_estimated', m -> 'cost_estimated', 'cost_committed', m -> 'cost_committed',
    'cost_expected', m -> 'cost_expected', 'cost_actual', m -> 'cost_actual',
    'margin_estimated', m -> 'margin_estimated', 'margin_expected', m -> 'margin_expected', 'margin_actual', m -> 'margin_actual',
    'gross_margin', m -> 'gross_margin', 'net_margin', m -> 'net_margin', 'net_margin_pct', m -> 'net_margin_pct',
    'accuracy_pct', m -> 'accuracy_pct', 'input_tax', m -> 'input_tax', 'blocked_gst', m -> 'blocked_gst',
    'by_category', v_cats,
    'legacy_net_profit', v_old -> 'net_profit');
end $$;

-- ---- 7) read RPCs ---------------------------------------------------------------------------------------------
-- One event: P&L (three margins + accuracy), per-category variance, cost lines, warnings. Finance view, same
-- studio (exactly like event_pnl). Per-person crew lines (day rates) only for an admin.
create or replace function public.event_cost_breakdown(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246: read-only
declare v_org uuid := public.current_org_id(); m jsonb; v_lines jsonb; c record;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  m := public._r21_event_money(p_quote, v_org, true);
  if m is null then return null; end if;
  v_lines := coalesce(m -> 'lines', '[]'::jsonb);
  if not public.is_admin() then
    -- pay is the admin's business (owner decision): one combined crew line, no names / rates
    select count(*) as n, coalesce(sum((l ->> 'c_est')::numeric), 0) as e, coalesce(sum((l ->> 'c_com')::numeric), 0) as cm,
           coalesce(sum((l ->> 'c_fc')::numeric), 0) as f, coalesce(sum((l ->> 'c_act')::numeric), 0) as a,
           count(*) filter (where l ->> 'attendance' = 'arrived') as arrived,
           count(*) filter (where l ->> 'attendance' = 'not_marked') as open
      into c from jsonb_array_elements(v_lines) l where l ->> 'source' = 'crew';
    select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines from jsonb_array_elements(v_lines) l where l ->> 'source' <> 'crew';
    if c.n > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('key', 'crew:all', 'source', 'crew', 'category', 'staff',
        'label', 'Crew wages (' || c.n || ' people)', 'estimated', c.e, 'committed', c.cm,
        'actual', case when c.open = 0 then c.a end,
        'c_est', c.e, 'c_com', c.cm, 'c_fc', c.f, 'c_act', c.a, 'people', c.n, 'pay_private', true,
        'note', c.arrived || ' arrived, ' || c.open || ' not marked - per-person pay is visible to the admin only'));
    end if;
  end if;
  return (m - 'lines') || jsonb_build_object('lines', v_lines, 'pay_private', not public.is_admin());
end $$;

-- Studio-wide (Insights / Business): every confirmed event in the range, the same numbers as above per event
-- (no lines), totals per currency. Finance view + (Business or Insights area); same studio only.
create or replace function public.studio_cost_breakdown(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246: read-only
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, current_date - 365);
        v_to date := coalesce(p_to, current_date + 365); v_rows jsonb := '[]'::jsonb; x record; m jsonb; v_tot jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('finance', 'view')
     or not (public.has_area('business', 'view') or public.has_area('insights', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if v_to - v_from > 1100 then raise exception 'range too long (max 3 years)' using errcode = '22023'; end if;
  for x in select q.id from public.quotes q
            where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed'
              and coalesce(q.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
              and q.event_date between v_from and v_to
            order by q.event_date, q.id limit 2000 loop
    m := public._r21_event_money(x.id, v_org, false);
    if m is not null then
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'quote_id', m -> 'quote_id', 'code', m -> 'code', 'title', m -> 'title', 'date', m -> 'date', 'currency', m -> 'currency',
        'rules', m -> 'rules', 'revenue', m -> 'revenue', 'net_revenue', m -> 'net_revenue',
        'cost_estimated', m -> 'cost_estimated', 'cost_committed', m -> 'cost_committed', 'cost_expected', m -> 'cost_expected',
        'cost_actual', m -> 'cost_actual', 'margin_estimated', m -> 'margin_estimated', 'margin_expected', m -> 'margin_expected',
        'margin_actual', m -> 'margin_actual', 'margin_expected_pct', m -> 'margin_expected_pct', 'accuracy_pct', m -> 'accuracy_pct',
        'recorded_net_profit', case when m ->> 'rules' = 'legacy' then m -> 'legacy' -> 'net_profit' else m -> 'margin_expected' end,
        'by_category', (select coalesce(jsonb_object_agg(c ->> 'key', jsonb_build_object('estimated', c -> 'estimated',
                          'committed', c -> 'committed', 'actual', c -> 'actual', 'expected', c -> 'expected')), '{}'::jsonb)
                          from jsonb_array_elements(m -> 'by_category') c)));
    end if;
  end loop;
  with ev as (select e from jsonb_array_elements(v_rows) e),
  cur as (select e ->> 'currency' as c, count(*) as n, sum((e ->> 'revenue')::numeric) as rev, sum((e ->> 'net_revenue')::numeric) as nrev,
                 sum((e ->> 'cost_estimated')::numeric) as est, sum((e ->> 'cost_expected')::numeric) as fc,
                 sum((e ->> 'cost_actual')::numeric) as act, sum((e ->> 'margin_expected')::numeric) as mar
            from ev group by 1),
  cat as (select e ->> 'currency' as c, ce.key as k, sum((ce.value ->> 'estimated')::numeric) as est,
                 sum((ce.value ->> 'actual')::numeric) as act, sum((ce.value ->> 'expected')::numeric) as fc
            from ev cross join lateral jsonb_each(e -> 'by_category') ce group by 1, 2),
  catj as (select c, jsonb_object_agg(k, jsonb_build_object('estimated', est, 'actual', act, 'expected', fc)) as j from cat group by c)
  select coalesce(jsonb_object_agg(cur.c, jsonb_build_object('events', cur.n, 'revenue', cur.rev, 'net_revenue', cur.nrev,
           'cost_estimated', cur.est, 'cost_expected', cur.fc, 'cost_actual', cur.act, 'margin_expected', cur.mar,
           'by_category', coalesce(catj.j, '{}'::jsonb))), '{}'::jsonb)
    into v_tot from cur left join catj on catj.c = cur.c;
  return jsonb_build_object('from', v_from, 'to', v_to, 'events', v_rows, 'totals', v_tot,
    'categories', (select jsonb_agg(jsonb_build_object('key', o.k, 'label', public._r21_category_label(o.k)) order by o.ord)
                     from (values ('venue', 1), ('food', 2), ('decor', 3), ('rentals', 4), ('vendors', 5), ('staff', 6), ('misc', 7),
                                  ('logistics', 8), ('damages', 9), ('changes', 10), ('contingency', 11)) o(k, ord)));
end $$;

-- ---- 7b) Insights per-event costs (0240 shape, same keys) on the ledger --------------------------------------
-- fix/r21-insights' insights_event_costs(from, to) (0240) split the cost by keywords and never counted crew wages.
-- Same signature, same access (insights + finance), same keys, so the Insights page keeps working unchanged;
-- the parts now come from the ledger above: crew = staff & crew wages (auto crew lines + typed staff lines that
-- are NOT ticked "replaced by crew wages" - never both), expense_claims = staff expense claims only, refunds
-- ex-GST, profit = event_pnl net_profit. Legacy (closed before 0246) events keep their recorded split.
-- New keys: rules, wages, damages, cost_estimated, cost_actual, accuracy_pct.
create or replace function public.insights_event_costs(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- insights-event-costs-0240 (r21-money-0246: parts from the event cost ledger, crew wages counted)
declare
  v_org uuid := public.current_org_id();
  v_tz text;
  v_from date := coalesce(p_from, date '2000-01-01');
  v_to date := coalesce(p_to, date '2100-12-31');
  q record; p jsonb; m jsonb; c jsonb; v_rows jsonb := '[]'::jsonb; v_col numeric; v_rev numeric; v_tax numeric;
  v_parts jsonb; v_total numeric; v_net numeric;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('insights', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_to < v_from then raise exception 'the end date is before the start date' using errcode = '22023'; end if;
  if not public.has_area('finance', 'view') then
    return jsonb_build_object('from', v_from, 'to', v_to, 'finance', false, 'events', '[]'::jsonb);
  end if;
  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata') into v_tz from public.organizations o where o.id = v_org;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;

  for q in
    select x.id, x.code, x.title, coalesce(x.lifecycle_stage, 'quote') as stage,
           coalesce(x.event_date, (x.created_at at time zone v_tz)::date) as d,
           nullif(btrim(coalesce(x.event_type, '')), '') as etype,
           case when coalesce(x.pricing ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (x.pricing ->> 'guests')::int > 0 then (x.pricing ->> 'guests')::int
                when coalesce(x.client ->> 'guests', '') ~ '^\s*[0-9]{1,6}\s*$' and (x.client ->> 'guests')::int > 0 then (x.client ->> 'guests')::int end as guests
      from public.quotes x
     where x.org_id = v_org and x.deleted_at is null and x.status = 'confirmed'
       and coalesce(x.event_date, (x.created_at at time zone v_tz)::date) between v_from and v_to
       and coalesce(x.lifecycle_stage, 'quote') not in ('lead', 'discovery', 'proposal')
     order by 5, 2 limit 500
  loop
    p := public._vb_event_pnl(q.id, v_org);
    continue when p is null;
    m := public._r21_event_money(q.id, v_org, false);
    v_rev := coalesce((p ->> 'revenue')::numeric, 0); v_tax := coalesce((p ->> 'tax')::numeric, 0);
    if m is not null and m ->> 'rules' = 'r21' then
      select coalesce(jsonb_object_agg(x ->> 'key', (x ->> 'expected')::numeric), '{}'::jsonb) into c from jsonb_array_elements(m -> 'by_category') x;
      v_parts := jsonb_build_object(
        'vendors', coalesce((c ->> 'venue')::numeric, 0) + coalesce((c ->> 'food')::numeric, 0) + coalesce((c ->> 'decor')::numeric, 0) + coalesce((c ->> 'vendors')::numeric, 0),
        'crew', coalesce((c ->> 'staff')::numeric, 0),
        'logistics', coalesce((c ->> 'logistics')::numeric, 0),
        'rentals', coalesce((c ->> 'rentals')::numeric, 0),
        'change_orders', coalesce((c ->> 'changes')::numeric, 0),
        'other_costs', coalesce((c ->> 'misc')::numeric, 0) - coalesce((m ->> 'cost_claims')::numeric, 0)
                       + coalesce((c ->> 'damages')::numeric, 0) + coalesce((c ->> 'contingency')::numeric, 0),
        'expense_claims', coalesce((m ->> 'cost_claims')::numeric, 0),
        'refunds', coalesce((m ->> 'refunds_ex_tax')::numeric, 0),
        'wages', coalesce((m ->> 'cost_wages')::numeric, 0), 'damages', coalesce((c ->> 'damages')::numeric, 0));
      v_total := coalesce((m ->> 'cost_expected')::numeric, 0) + coalesce((m ->> 'refunds_ex_tax')::numeric, 0);
    else
      -- legacy: the recorded (0146) split, unchanged
      v_parts := jsonb_build_object('vendors', coalesce((p ->> 'vendors')::numeric, 0), 'crew', 0, 'logistics', 0, 'rentals', 0,
        'change_orders', 0, 'other_costs', coalesce((p ->> 'other')::numeric, 0), 'expense_claims', coalesce((p ->> 'staff')::numeric, 0),
        'refunds', coalesce((p ->> 'refunds')::numeric, 0), 'wages', 0, 'damages', 0);
      v_total := coalesce((p ->> 'vendors')::numeric, 0) + coalesce((p ->> 'other')::numeric, 0) + coalesce((p ->> 'staff')::numeric, 0) + coalesce((p ->> 'refunds')::numeric, 0);
    end if;
    v_net := coalesce((p ->> 'net_profit')::numeric, v_rev - v_total);
    v_col := case
      when exists (select 1 from public.quote_payments pm where pm.quote_id = q.id and pm.org_id = v_org)
        then coalesce((select sum(pm.amount) from public.quote_payments pm where pm.quote_id = q.id and pm.org_id = v_org and pm.status = 'paid'), 0)
      else coalesce((select sum(mi.amount) from public.payment_milestones mi where mi.quote_id = q.id and mi.org_id = v_org and mi.status = 'paid'), 0) end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', q.id, 'code', q.code, 'title', q.title, 'date', q.d, 'stage', q.stage, 'event_type', q.etype, 'guests', q.guests,
      'currency', coalesce(p ->> 'currency', 'INR'), 'rules', coalesce(p ->> 'rules', 'r21'),
      'revenue', round(v_rev, 2), 'tax', round(v_tax, 2),
      'vendors', round((v_parts ->> 'vendors')::numeric, 2), 'crew', round((v_parts ->> 'crew')::numeric, 2),
      'logistics', round((v_parts ->> 'logistics')::numeric, 2), 'rentals', round((v_parts ->> 'rentals')::numeric, 2),
      'change_orders', round((v_parts ->> 'change_orders')::numeric, 2), 'other_costs', round((v_parts ->> 'other_costs')::numeric, 2),
      'expense_claims', round((v_parts ->> 'expense_claims')::numeric, 2), 'refunds', round((v_parts ->> 'refunds')::numeric, 2),
      'wages', round((v_parts ->> 'wages')::numeric, 2), 'damages', round((v_parts ->> 'damages')::numeric, 2),
      'cost_total', round(v_total, 2),
      'cost_estimated', m -> 'cost_estimated', 'cost_actual', m -> 'cost_actual', 'accuracy_pct', m -> 'accuracy_pct',
      'profit', round(v_net, 2), 'margin_pct', case when v_rev <> 0 then round(v_net / v_rev * 100) end,
      'collected', round(v_col, 2), 'outstanding', round(greatest(v_rev + v_tax - v_col, 0), 2)));
  end loop;
  return jsonb_build_object('from', v_from, 'to', v_to, 'finance', true, 'events', v_rows);
end $$;
revoke all on function public.insights_event_costs(date, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.insights_event_costs(date, date) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.insights_event_costs(date, date) to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.insights_event_costs(date, date) to service_role'; end if;
end $$;

-- ---- 8) grants: internal helpers never callable by the app; the two read RPCs for signed-in users ------------------
do $$ declare f text; begin
  foreach f in array array['public._r21_cost_lines(uuid, uuid)', 'public._r21_event_money(uuid, uuid, boolean)',
                           'public._vb_event_pnl(uuid, uuid)', 'public._vb_event_pnl__pre0246(uuid, uuid)',
                           'public.event_cost_breakdown(uuid)', 'public.studio_cost_breakdown(date, date)',
                           'public._r21_category(text, text)', 'public._r21_category_label(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach f in array array['public._r21_cost_lines(uuid, uuid)', 'public._r21_event_money(uuid, uuid, boolean)',
                             'public._vb_event_pnl(uuid, uuid)', 'public._vb_event_pnl__pre0246(uuid, uuid)',
                             'public._r21_category(text, text)', 'public._r21_category_label(text)'] loop
      execute format('revoke all on function %s from authenticated', f);
    end loop;
    execute 'grant execute on function public.event_cost_breakdown(uuid) to authenticated';
    execute 'grant execute on function public.studio_cost_breakdown(date, date) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.event_cost_breakdown(uuid) to service_role';
    execute 'grant execute on function public.studio_cost_breakdown(date, date) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
