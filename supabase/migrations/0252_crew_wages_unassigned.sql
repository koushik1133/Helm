-- 0252_crew_wages_unassigned.sql - CANONICAL forward-only.
-- REQUIRES 0246 (_r21_cost_lines: the event cost ledger).
--
-- In plain words (r22 live QA, sample wedding: "7 staff assigned" on the workspace / Staff / Readiness, but only
-- 6 crew wage lines on Budget):
--   A task that names a crew member (event_tasks.crew_id set) was counted as staff on every screen, but the
--   0246 ledger skipped it for wages while the task status was still 'unassigned' (the sample "Pack and load
--   rentals" task for Suresh Yadav). ONE rule now, the same on the server and on the screens:
--     a crew member is ON the event when any of their tasks for it is not rejected and not cancelled
--     (or they are on its event-day arrival roster - unchanged).
--   Such a person is one wage line like everyone else: Estimated = day rate x 1 day; Committed only once they
--   accept; Actual from the event-day roster. A task still 'unassigned' is therefore an Estimated wage.
--   The same rule also decides whether the event "has crew" (a budget line ticked "Replaced by crew wages").
--
-- What changes: public._r21_cost_lines(uuid, uuid) only - create or replace, same name, inputs, output and
-- grants (internal: never callable by the app). The two task filters drop 'unassigned' from the skip list;
-- every other line of the 0246 body is unchanged. No table, column, row or policy is touched, nothing is
-- deleted. Safe to run twice.

create or replace function public._r21_cost_lines(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r21-money-0246 (r22-money-0252: a task naming a crew member counts while unassigned - estimated wage)
declare
  v_lines jsonb := '[]'::jsonb; v_part jsonb;
  v_lb numeric; v_llf numeric; v_bills_win boolean; v_has_crew boolean;
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = p_org) then return null; end if;

  -- crew on this event: assigned by a live task, or on the arrival roster (a crew member of this studio)
  v_has_crew := exists (select 1 from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = p_org
                         where t.quote_id = p_quote and t.org_id = p_org and t.status not in ('rejected', 'cancelled'))
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
                      and t.status not in ('rejected', 'cancelled'))
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

-- grants as in 0246 (create or replace keeps them; re-stated so a re-run never widens them)
do $$ begin
  execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r21_cost_lines(uuid, uuid) from authenticated'; end if;
end $$;

notify pgrst, 'reload schema';
