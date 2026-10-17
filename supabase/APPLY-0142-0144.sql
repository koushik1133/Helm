-- APPLY 0142-0144 (paste whole file in the Supabase SQL editor; ONE transaction; ends with read-only verify rows - expect every ok = true)
-- 0142 money/currency/change-order tax/title lengths, 0143 Worker merged into Crew + Designer/Crew default access, 0144 role-gate fixes. Additive + idempotent; never deletes.
-- Replaces running APPLY-0143.sql and APPLY-0144.sql separately (safe to re-run either way).
begin;

-- ===== migrations/0142_money_currency_cotax_lengths.sql =====
-- 0142_money_currency_cotax_lengths.sql - CANONICAL forward-only. REQUIRES 0108, 0124, 0101 (_r101_quote_tax).
--
-- In plain words (helm-v01 dev pass 3):
--   1) Business page showed '-' for Booked / Collected / Outstanding: the studio row said USD while
--      every quote is INR, so dashboard_money put all the money under other_currencies. When the
--      studio has no live quote in its stored currency, dashboard_money now reports in the currency
--      most of its quotes use. organizations.currency itself is NOT changed.
--   2) _vb_event_pnl (event_pnl / business_pnl): the tax share of approved change orders is split out
--      at the quote's own rate (the app now adds GST on top when a change order is entered), so
--      profit is on ex-tax revenue everywhere.
--   3) Run-sheet and checklist (teardown / logistics) titles: a new or CHANGED title longer than
--      500 characters is refused (the app limits it to 200). Existing rows are never re-checked, so
--      nothing already saved can start failing; nothing is deleted.
--   Same function names, signatures, owners and grants. No table or column is created; no row changed.
-- Idempotent: create or replace + drop trigger if exists / create.
-- ============================================================================

-- 1) dashboard_money: dominant quote currency fallback (body otherwise identical to 0108)
create or replace function public.dashboard_money(p_months integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- dashboard-money-0108 (0142: dominant quote currency fallback)
declare
  v_org uuid := public.current_org_id();
  v_q boolean; v_fin boolean; v_leads boolean;
  v_tz text; v_cur text; v_today date; v_start date;
  v_n integer := least(greatest(coalesce(p_months, 12), 1), 24);
  v_months jsonb; v_totals jsonb; v_other jsonb; v_overdue jsonb; v_pipe jsonb; v_leadc jsonb; v_up jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_q := public.has_area('quotes', 'view');
  v_fin := public.has_area('finance', 'view');
  if not (v_q or v_fin) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_leads := public.has_area('leads', 'view');

  select coalesce(nullif(o.timezone, ''), 'Asia/Kolkata'),
         case when upper(coalesce(o.currency, '')) ~ '^[A-Z]{3}$' then upper(o.currency) else 'INR' end
    into v_tz, v_cur from public.organizations o where o.id = v_org;
  v_tz := coalesce(v_tz, 'Asia/Kolkata'); v_cur := coalesce(v_cur, 'INR');
  -- 0142: organizations.currency can be a stale default (e.g. USD) while every quote is priced in
  -- INR - then every total came back 0 and the real money sat in other_currencies. When the studio
  -- has NO live quote in its stored currency, use the currency most of its quotes are priced in.
  if not exists (select 1 from public.quotes q where q.org_id = v_org and q.deleted_at is null
                   and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur) then
    select x.c into v_cur from (
      select upper(q.currency) as c, count(*) as n from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$'
       group by 1 order by 2 desc, 1 limit 1) x;
    v_cur := coalesce(v_cur, 'INR');
  end if;
  begin perform now() at time zone v_tz; exception when others then v_tz := 'Asia/Kolkata'; end;
  v_today := (now() at time zone v_tz)::date;
  v_start := (date_trunc('month', v_today::timestamp) - make_interval(months => v_n - 1))::date;

  -- one pass over the studio's quotes (quotes_org_idx), ledger + change requests pre-aggregated per quote
  with q as (
    select q.id, q.code, q.title, q.client, q.status, coalesce(q.lifecycle_stage, 'quote') as stage,
           coalesce(q.approval_status, 'none') as appr, q.confirmed_at, q.event_date,
           case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end as cur,
           case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end as base
      from public.quotes q
     where q.org_id = v_org and q.deleted_at is null
  ), cr as (
    select c.quote_id, sum(c.price_delta) as d from public.change_requests c
     where c.org_id = v_org and c.status = 'approved' group by c.quote_id
  ), led as (
    select p.quote_id, sum(p.amount) filter (where p.status = 'paid') as paid from public.quote_payments p
     where p.org_id = v_org group by p.quote_id
  ), msp as (
    select m.quote_id, sum(m.amount) filter (where m.status = 'paid') as paid from public.payment_milestones m
     where m.org_id = v_org group by m.quote_id
  ), ev as (
    select q.*, q.base + coalesce(cr.d, 0) as value,
           case when led.quote_id is not null then coalesce(led.paid, 0) else coalesce(msp.paid, 0) end as paid,
           led.quote_id is not null as has_led
      from q left join cr on cr.quote_id = q.id left join led on led.quote_id = q.id left join msp on msp.quote_id = q.id
  )
  select
    case when v_q then jsonb_build_object(
      'currency', v_cur,
      'open',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr <> 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr <> 'sent' and cur = v_cur), 0)),
      'sent',      jsonb_build_object('count', count(*) filter (where status = 'quote' and appr = 'sent'),
                                      'value', coalesce(sum(value) filter (where status = 'quote' and appr = 'sent' and cur = v_cur), 0)),
      'confirmed', jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage <> 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage <> 'closed' and cur = v_cur), 0)),
      'closed',    jsonb_build_object('count', count(*) filter (where status = 'confirmed' and stage = 'closed'),
                                      'value', coalesce(sum(value) filter (where status = 'confirmed' and stage = 'closed' and cur = v_cur), 0)),
      'cancelled', jsonb_build_object('count', count(*) filter (where status = 'cancelled')),
      'total', count(*)) end,
    jsonb_build_object(
      'booked_all', case when v_q or v_fin then coalesce(sum(value) filter (where status = 'confirmed' and cur = v_cur), 0) end,
      'collected_all', case when v_fin then coalesce(sum(paid) filter (where cur = v_cur), 0) end,
      'outstanding', case when v_fin then coalesce(sum(greatest(value - paid, 0)) filter (where status = 'confirmed' and cur = v_cur), 0) end),
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', x.cur, 'booked_all', x.b, 'collected_all', x.c, 'outstanding', x.o) order by x.cur), '[]'::jsonb)
        from (select e2.cur, coalesce(sum(e2.value) filter (where e2.status = 'confirmed'), 0) as b, coalesce(sum(e2.paid), 0) as c,
                     coalesce(sum(greatest(e2.value - e2.paid, 0)) filter (where e2.status = 'confirmed'), 0) as o
                from ev e2 where e2.cur <> v_cur group by e2.cur) x) end,
    case when v_fin then (
      select coalesce(jsonb_agg(o order by (o ->> 'due_date'), (o ->> 'code')), '[]'::jsonb) from (
        select jsonb_build_object('quote_id', z.quote_id, 'milestone_id', z.id, 'code', z.code, 'title', z.title,
                 'client', nullif(btrim(coalesce(z.client ->> 'name', '')), ''), 'label', z.label, 'due_date', z.due_date,
                 'amount', z.amount, 'paid', z.mpaid, 'balance', z.amount - z.mpaid, 'currency', z.cur) as o
          from (
            select y.*, case when y.has_led then least(greatest(y.qpaid - y.prior_amt, 0), y.amount)
                             when y.mstatus = 'paid' then y.amount else 0 end as mpaid
              from (
                select m.id, m.quote_id, m.label, m.due_date, m.amount, m.status as mstatus, e.code, e.title, e.client, e.cur,
                       e.paid as qpaid, e.has_led,
                       coalesce(sum(m.amount) over (partition by m.quote_id order by m.seq, m.due_date nulls last, m.created_at, m.id
                                                    rows between unbounded preceding and 1 preceding), 0) as prior_amt
                  from public.payment_milestones m
                  join ev e on e.id = m.quote_id and e.status = 'confirmed'
                 where m.org_id = v_org
              ) y
          ) z
         where z.due_date is not null and z.due_date < v_today and z.mstatus <> 'waived' and z.mpaid < z.amount
         order by z.due_date, z.code
         limit 10) s) end,
    case when v_fin then (
      select coalesce(jsonb_agg(jsonb_build_object('quote_id', u.id, 'value', u.value, 'paid', u.paid, 'currency', u.cur) order by u.event_date, u.code), '[]'::jsonb)
        from (select e3.id, e3.code, e3.event_date, e3.value, e3.paid, e3.cur from ev e3
               where e3.status = 'confirmed' and e3.event_date between v_today and v_today + 30
               order by e3.event_date, e3.code limit 50) u) end
    into v_pipe, v_totals, v_other, v_overdue, v_up
    from ev;

  -- months: booked by confirmation month (studio currency), collected by ledger paid month
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'),
           'booked', case when v_q or v_fin then coalesce(b.v, 0) end,
           'collected', case when v_fin then coalesce(c.v, 0) end) order by g.m), '[]'::jsonb)
    into v_months
    from generate_series(v_start::timestamp, date_trunc('month', v_today::timestamp), interval '1 month') g(m)
    left join (
      select date_trunc('month', (q.confirmed_at at time zone v_tz))::date as m,
             sum(case when (q.pricing ->> 'total') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end
                 + coalesce((select sum(c.price_delta) from public.change_requests c
                              where c.quote_id = q.id and c.org_id = v_org and c.status = 'approved'), 0)) as v
        from public.quotes q
       where q.org_id = v_org and q.deleted_at is null and q.status = 'confirmed' and q.confirmed_at is not null
         and q.confirmed_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) b on b.m = g.m::date
    left join (
      select date_trunc('month', (p.paid_at at time zone v_tz))::date as m, sum(p.amount) as v
        from public.quote_payments p
        join public.quotes q on q.id = p.quote_id and q.org_id = v_org and q.deleted_at is null
       where p.org_id = v_org and p.status = 'paid' and p.paid_at is not null
         and p.paid_at >= (v_start::timestamp at time zone v_tz)
         and (case when upper(coalesce(q.currency, '')) ~ '^[A-Z]{3}$' then upper(q.currency) else v_cur end) = v_cur
       group by 1) c on c.m = g.m::date;

  if v_leads then
    select coalesce(jsonb_object_agg(s.st, s.n), '{}'::jsonb) into v_leadc from (
      select coalesce(nullif(btrim(l.status), ''), 'new') as st, count(*) as n
        from public.leads l where l.org_id = v_org group by 1) s;
  end if;

  return jsonb_build_object('currency', v_cur, 'today', v_today, 'months_n', v_n,
    'finance', v_fin, 'months', v_months, 'totals', v_totals, 'other_currencies', v_other,
    'overdue', v_overdue, 'upcoming', v_up, 'pipeline', v_pipe, 'leads', v_leadc);
end $$;

do $$ begin
  execute 'revoke all on function public.dashboard_money(integer) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.dashboard_money(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.dashboard_money(integer) to authenticated'; end if;
end $$;

-- 2) _vb_event_pnl: change-order tax split (body otherwise identical to 0124)
create or replace function public._vb_event_pnl(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- vendor-bills-0124 (0142: change-order tax split)
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
  -- 0142: an approved change order's price_delta is what the client pays (incl. tax, as the
  -- overpay cap / booklet / Settlement use it). Split its tax at the quote's own rate so profit
  -- is on ex-tax revenue and the tax collected is complete.
  if v_tax > 0 and v_base - v_tax > 0 and v_chg_rev <> 0 then
    v_tax := v_tax + round(v_chg_rev * (v_tax / (v_base - v_tax)) / (1 + v_tax / (v_base - v_tax)), 2);
  end if;
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

-- 3) title length guard (only when a title is inserted or changed)
create or replace function public.tg_title_len_0142()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.title is not null and char_length(new.title) > 500
     and (tg_op = 'INSERT' or new.title is distinct from old.title) then
    raise exception 'Title is too long (max 500 characters).' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.tg_title_len_0142() from public;
do $$ declare t text; begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_title_len_0142() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_title_len_0142() from authenticated'; end if;
  foreach t in array array['run_sheet_items', 'event_checklist'] loop
    if to_regclass('public.' || t) is not null and exists (select 1 from information_schema.columns
         where table_schema = 'public' and table_name = t and column_name = 'title') then
      execute format('drop trigger if exists zz_title_len_0142 on public.%I', t);
      execute format('create trigger zz_title_len_0142 before insert or update of title on public.%I for each row execute function public.tg_title_len_0142()', t);
    end if;
  end loop;
end $$;

-- ===== migrations/0143_roles_crew_defaults.sql =====
-- 0143_roles_crew_defaults.sql - CANONICAL forward-only. REQUIRES 0008, 0049 (create_studio wrapper),
-- 0072 (_valid_role), 0106 (_a106_role_label), phase29 (role_access).
--
-- In plain words:
--   1) The "Worker" role is merged into "Crew" (owner decision). Every profile, invitation and staff
--      record whose role is EXACTLY 'worker' becomes 'crew'. Counts are printed as NOTICEs.
--      'worker' stays a VALID value in _valid_role() and the CHECK constraints, so nothing old breaks -
--      it is simply no longer offered anywhere in the app.
--      Any worker access row is copied to crew ONLY where crew has no row for that area (never overwrites).
--   2) Default access: Designer and Crew get a sensible starting set, but ONLY in a studio where that
--      role has nothing switched on yet (no row with view or edit). A role an admin has already set up
--      (any area on) is never touched. Rows are only ever switched ON, never off. The matrix stays fully
--      editable in Control Center and the "Apply suggested access" button stays.
--        Designer: design, layouts, proposal, media (view + edit); quotes, calendar, templates (view)
--        Crew:     runsheet, calendar (view)   ("briefing" is not a real area - skipped)
--      New studios get the same defaults (create_studio wrapper).
-- Nothing is deleted. Idempotent: re-running changes nothing.

-- ---- 1a) worker -> crew (exact value only) -------------------------------------------------
do $$ declare n int; begin
  update public.profiles set role = 'crew' where role = 'worker';
  get diagnostics n = row_count; raise notice '0143: profiles worker -> crew: %', n;
  if to_regclass('public.invitations') is not null then
    update public.invitations set role = 'crew' where role = 'worker';
    get diagnostics n = row_count; raise notice '0143: invitations worker -> crew: %', n;
  end if;
  if to_regclass('public.crew_members') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crew_members' and column_name = 'role') then
    update public.crew_members set role = 'crew' where role = 'worker';
    get diagnostics n = row_count; raise notice '0143: crew_members.role worker -> crew: %', n;
  end if;
end $$;

-- ---- 1b) copy worker access into crew where crew has no row for that area -------------------
do $$ declare n int; begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select w.org_id, 'crew', w.area, w.can_view, w.can_edit, now()
      from public.role_access w
     where w.role = 'worker'
       and not exists (select 1 from public.role_access c
                        where c.org_id = w.org_id and c.role = 'crew' and c.area = w.area)
  on conflict (org_id, role, area) do nothing;
  get diagnostics n = row_count; raise notice '0143: worker access rows copied to crew: %', n;
end $$;

-- staff record label for a legacy 'worker' login now reads "Crew"
create or replace function public._a106_role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  select case p_role
    when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'coordinator' then 'Event coordinator' when 'supervisor' then 'Supervisor'
    when 'quality' then 'Quality engineer' when 'operations' then 'Operations' when 'designer' then 'Designer'
    when 'crew' then 'Crew' when 'worker' then 'Crew' when 'client' then 'Client'
    else initcap(replace(coalesce(p_role, ''), '_', ' ')) end;
$$;

-- ---- 2) default access for unconfigured designer / crew ------------------------------------
create or replace function public._a143_role_defaults()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $$
  values ('designer','design',true,true), ('designer','layouts',true,true), ('designer','proposal',true,true),
         ('designer','media',true,true), ('designer','quotes',true,false), ('designer','calendar',true,false),
         ('designer','templates',true,false),
         ('crew','runsheet',true,false), ('crew','calendar',true,false);
$$;
revoke all on function public._a143_role_defaults() from public, anon, authenticated;

-- p_org null = every studio. Only roles with NOTHING switched on in that studio are seeded.
create or replace function public._a143_seed_role_defaults(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  with targets as (
    select o.id as org_id, r.role
      from public.organizations o
     cross join (select distinct d.role from public._a143_role_defaults() d) r
     where (p_org is null or o.id = p_org)
       and not exists (select 1 from public.role_access ra
                        where ra.org_id = o.id and ra.role = r.role and (ra.can_view or ra.can_edit))
  )
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select t.org_id, d.role, d.area, d.can_view, d.can_edit, now()
      from targets t join public._a143_role_defaults() d on d.role = t.role
  on conflict (org_id, role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
    where public.role_access.can_view = false and public.role_access.can_edit = false;  -- only switch ON
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._a143_seed_role_defaults(uuid) from public, anon, authenticated;
grant execute on function public._a143_seed_role_defaults(uuid) to service_role;

do $$ declare n int; begin
  n := public._a143_seed_role_defaults(null);
  raise notice '0143: default access rows switched on: %', n;
end $$;

-- ---- 2b) new studios get the same defaults (wrap the current create_studio once) -----------
do $$ begin
  if to_regprocedure('public.create_studio__pre0143(text,text,text,text)') is null then
    alter function public.create_studio(text, text, text, text) rename to create_studio__pre0143;
  end if;
end $$;
revoke all on function public.create_studio__pre0143(text, text, text, text) from public, anon, authenticated;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- a143: a NEW studio also gets the designer / crew starting access
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0143(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    perform public._a143_seed_role_defaults(v_org);
  end if;
  return v_org;
end $$;
revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated, service_role;

-- ===== migrations/0144_role_gate_fixes.sql =====
-- 0144_role_gate_fixes.sql - CANONICAL forward-only. REQUIRES 0039 (publish_proposal wrapper),
-- 0052 (confirm_quote / set_plan_lock wrappers), phase29 (role_access), base has_area().
-- (Planned as "0143_role_gate_fixes"; 0143 was taken by 0143_roles_crew_defaults, so this is 0144.)
--
-- In plain words - the role audit (docs/ops/ROLE-ACCESS-AUDIT.md) found the database and the
-- Control Center access matrix disagreeing in four places. This migration makes the MATRIX the
-- single authority everywhere:
--
--   1) can_edit() was a hard-coded role list {admin, planner, sales, operations}. So an Event
--      manager or Event coordinator who the matrix lets edit the plan / staff / closure still got
--      "not authorized" from ~15 server functions, while Sales / Operations passed it even with every
--      edit switch off. can_edit() now means "admin, or this role may edit at least one area"; the
--      real per-area check stays inside each function. The few functions that ONLY checked
--      can_edit() are wrapped first with the area they touch:
--        add_quote_version  -> quotes or layouts edit      assign_tasks / reassign_task -> staff edit
--        assign_tasks_vendor -> staff or vendors edit      set_plan_signoff -> plan or ready edit
--        set_plan_lock      -> plan edit                   confirm_quote    -> quotes edit
--        publish_proposal   -> proposal or quotes edit     mgr_notify (SMS/WhatsApp to a client) ->
--                                                          quotes, finance or settlement edit
--   2) Payment receipts (quote_payments) were governed by the "quotes" area, so every role that can
--      merely VIEW an event (coordinator, supervisor, operations, quality, designer) could read every
--      receipt amount + method. Reading now also needs finance, settlement or package-payment view;
--      direct writes need finance or settlement edit (the app writes payments only through the
--      record_payment / settlement RPCs, which already check finance / settlement edit).
--   3) event_activity() (the event "activity trail") only checked the studio, so ANY signed-in
--      member - crew and client logins included - could read payment amounts and the client's
--      email / phone from it. It now needs quotes view, and payment lines need finance view.
--   4) task_verify_summary() only checked the studio; it now needs staff or quotes view.
--
-- Nothing is deleted or rewritten: no table rows change, no policy is dropped except this
-- migration's own (re-run safe). Restrictive policies only NARROW access. Idempotent.

-- ---- 1a) wrap the can_edit()-only functions ONCE (rename -> *__pre0144) --------------------------
do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['add_quote_version',   'uuid, text, jsonb, integer'],
    ['assign_tasks',        'uuid, text, text[], uuid, text, text'],
    ['assign_tasks_vendor', 'uuid, text, text[], uuid'],
    ['reassign_task',       'uuid, uuid, text, text'],
    ['set_plan_signoff',    'uuid, text, boolean'],
    ['set_plan_lock',       'uuid, boolean'],
    ['confirm_quote',       'uuid, jsonb, jsonb'],
    ['publish_proposal',    'uuid, boolean'],
    ['mgr_notify',          'uuid, text, text, text, jsonb']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0144', f[2])) is null then
      if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is null then
        raise exception '0144: public.%(%) is missing on this database', f[1], f[2];
      end if;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0144');
    end if;
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0144', f[2]);
    execute format('grant execute on function public.%I(%s) to service_role', f[1] || '__pre0144', f[2]);
  end loop;
end $$;

create or replace function public.add_quote_version(p_quote_id uuid, p_label text, p_data jsonb, p_object_count integer)
returns public.quote_versions language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('quotes', 'edit') or public.has_area('layouts', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.add_quote_version__pre0144(p_quote_id, p_label, p_data, p_object_count);
end $$;

create or replace function public.assign_tasks(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.assign_tasks__pre0144(p_quote_id, p_category, p_titles, p_crew_id, p_name, p_phone);
end $$;

create or replace function public.assign_tasks_vendor(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('staff', 'edit') or public.has_area('vendors', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.assign_tasks_vendor__pre0144(p_quote_id, p_category, p_titles, p_vendor_id);
end $$;

create or replace function public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.reassign_task__pre0144(p_task_id, p_crew_id, p_name, p_phone);
end $$;

create or replace function public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
returns public.event_plan language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('plan', 'edit') or public.has_area('ready', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_plan_signoff__pre0144(p_quote_id, p_field, p_done);
end $$;

create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.has_area('plan', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  return public.set_plan_lock__pre0144(p_quote_id, p_locked);
end $$;

create or replace function public.confirm_quote(p_quote_id uuid, p_client jsonb, p_pricing jsonb)
returns public.quotes language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = public.current_org_id()) then
    raise exception 'no such event' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not authorized to confirm' using errcode = '42501'; end if;
  return public.confirm_quote__pre0144(p_quote_id, p_client, p_pricing);
end $$;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('proposal', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.publish_proposal__pre0144(p_quote_id, p_published);
end $$;

create or replace function public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not (public.has_area('quotes', 'edit') or public.has_area('finance', 'edit') or public.has_area('settlement', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public.mgr_notify__pre0144(p_quote_id, p_channel, p_to, p_kind, p_detail);
end $$;

do $$
declare f text[];
begin
  foreach f slice 1 in array array[
    ['add_quote_version',   'uuid, text, jsonb, integer'],
    ['assign_tasks',        'uuid, text, text[], uuid, text, text'],
    ['assign_tasks_vendor', 'uuid, text, text[], uuid'],
    ['reassign_task',       'uuid, uuid, text, text'],
    ['set_plan_signoff',    'uuid, text, boolean'],
    ['set_plan_lock',       'uuid, boolean'],
    ['confirm_quote',       'uuid, jsonb, jsonb'],
    ['publish_proposal',    'uuid, boolean'],
    ['mgr_notify',          'uuid, text, text, text, jsonb']
  ] loop
    execute format('revoke all on function public.%I(%s) from public, anon', f[1], f[2]);
    execute format('grant execute on function public.%I(%s) to authenticated, service_role', f[1], f[2]);
  end loop;
end $$;

-- ---- 1b) can_edit(): the matrix decides (admin, or the role may edit at least one area) ----------
create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.is_admin() or exists (
    select 1 from public.role_access ra
     where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.can_edit), false);
$$;

-- ---- 2) quote_payments: money needs a money area ---------------------------------------------------
alter table public.quote_payments enable row level security;
drop policy if exists a144_qp_money_read on public.quote_payments;
create policy a144_qp_money_read on public.quote_payments as restrictive for select to authenticated
  using (public.has_area('finance', 'view') or public.has_area('settlement', 'view') or public.has_area('pkg_payments', 'view'));
drop policy if exists a144_qp_money_ins on public.quote_payments;
create policy a144_qp_money_ins on public.quote_payments as restrictive for insert to authenticated
  with check (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));
drop policy if exists a144_qp_money_upd on public.quote_payments;
create policy a144_qp_money_upd on public.quote_payments as restrictive for update to authenticated
  using (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'))
  with check (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));
drop policy if exists a144_qp_money_del on public.quote_payments;
create policy a144_qp_money_del on public.quote_payments as restrictive for delete to authenticated
  using (public.has_area('finance', 'edit') or public.has_area('settlement', 'edit'));

-- ---- 3) event_activity(): quotes view; payment lines need a money area ------------------------------
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare items jsonb; v_fin boolean;
begin
  perform public.assert_quote_org(p_quote);
  if not public.has_area('quotes', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_fin := public.has_area('finance', 'view') or public.has_area('settlement', 'view') or public.has_area('pkg_payments', 'view');
  select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('at', created_at, 'kind','version','text','Layout v'||version_no||coalesce(' - '||label,'')) a
      from public.quote_versions where quote_id = p_quote
    union all
    select jsonb_build_object('at', coalesce(paid_at,created_at), 'kind','payment',
             'text', case when status='paid' then 'Payment '||coalesce(receipt_no,'')||' - '||to_char(amount,'FM9999999999')||' ('||coalesce(method,provider)||')'
                          else 'Payment '||status||' - '||to_char(amount,'FM9999999999') end) a
      from public.quote_payments where quote_id = p_quote and v_fin
    union all
    select jsonb_build_object('at', paid_at, 'kind','milestone','text','Milestone paid: '||label||' ('||to_char(amount,'FM9999999999')||')') a
      from public.payment_milestones where quote_id = p_quote and status='paid' and v_fin
    union all
    select jsonb_build_object('at', created_at, 'kind','consent','text','Client consent recorded ('||coalesce(client_name,'')||')') a
      from public.quote_consents where quote_id = p_quote
    union all
    select jsonb_build_object('at', created_at, 'kind','notify','text',kind||' -> '||coalesce(recipient,'')) a
      from public.notifications where quote_id = p_quote
  ) t;
  return items;
end; $$;

-- ---- 4) task_verify_summary(): staff or quotes view ---------------------------------------------------
create or replace function public.task_verify_summary(p_quote uuid)
returns table(total integer, completed integer, pending integer, passed integer, rejected integer)
language sql stable security definer set search_path to 'public' as $$
  select count(*)::int,
         count(*) filter (where status = 'completed')::int,
         count(*) filter (where verify_status = 'pending')::int,
         count(*) filter (where verify_status = 'passed')::int,
         count(*) filter (where verify_status = 'rejected')::int
  from public.event_tasks
  where quote_id = p_quote and org_id = public.current_org_id()
    and (public.has_area('staff', 'view') or public.has_area('quotes', 'view'));
$$;

commit;

-- ===== VERIFY (read-only) =====
select 'dashboard_money present' as item, to_regprocedure('public.dashboard_money(integer)') is not null as ok
union all select '_vb_event_pnl present', to_regprocedure('public._vb_event_pnl(uuid,uuid)') is not null
union all select 'title length guard present', to_regprocedure('public.tg_title_len_0142()') is not null
union all select 'no profile left on worker' , not exists(select 1 from public.profiles where role='worker')
union all select 'no invitation left on worker', not exists(select 1 from public.invitations where role='worker')
union all select 'worker still a valid role', public._valid_role('worker')
union all select 'seed function present', to_regprocedure('public._a143_seed_role_defaults(uuid)') is not null
union all select 'create_studio wrapped', to_regprocedure('public.create_studio__pre0143(text,text,text,text)') is not null
union all select 'create_studio not callable by anon', not has_function_privilege('anon','public.create_studio(text,text,text,text)','execute')
union all select 'seed function not callable by authenticated', not has_function_privilege('authenticated','public._a143_seed_role_defaults(uuid)','execute')
union all select 'every studio: designer has some access', not exists(select 1 from public.organizations o where not exists(select 1 from public.role_access ra where ra.org_id=o.id and ra.role='designer' and ra.can_view))
union all select 'every studio: crew has some access', not exists(select 1 from public.organizations o where not exists(select 1 from public.role_access ra where ra.org_id=o.id and ra.role='crew' and ra.can_view))
union all select 'can_edit follows the matrix' , pg_get_functiondef('public.can_edit()'::regprocedure) ilike '%role_access%'
union all select 'add_quote_version wrapped', to_regprocedure('public.add_quote_version__pre0144(uuid,text,jsonb,integer)') is not null
union all select 'assign_tasks wrapped', to_regprocedure('public.assign_tasks__pre0144(uuid,text,text[],uuid,text,text)') is not null
union all select 'assign_tasks_vendor wrapped', to_regprocedure('public.assign_tasks_vendor__pre0144(uuid,text,text[],uuid)') is not null
union all select 'reassign_task wrapped', to_regprocedure('public.reassign_task__pre0144(uuid,uuid,text,text)') is not null
union all select 'set_plan_signoff wrapped', to_regprocedure('public.set_plan_signoff__pre0144(uuid,text,boolean)') is not null
union all select 'set_plan_lock wrapped', to_regprocedure('public.set_plan_lock__pre0144(uuid,boolean)') is not null
union all select 'confirm_quote wrapped', to_regprocedure('public.confirm_quote__pre0144(uuid,jsonb,jsonb)') is not null
union all select 'publish_proposal wrapped', to_regprocedure('public.publish_proposal__pre0144(uuid,boolean)') is not null
union all select 'mgr_notify wrapped', to_regprocedure('public.mgr_notify__pre0144(uuid,text,text,text,jsonb)') is not null
union all select 'inner functions not callable by the app', not has_function_privilege('authenticated','public.confirm_quote__pre0144(uuid,jsonb,jsonb)','execute')
union all select 'wrappers callable by the app', has_function_privilege('authenticated','public.confirm_quote(uuid,jsonb,jsonb)','execute')
union all select 'wrappers not callable by anon', not has_function_privilege('anon','public.mgr_notify(uuid,text,text,text,jsonb)','execute')
union all select 'payments read needs a money area', exists(select 1 from pg_policies where schemaname='public' and tablename='quote_payments' and policyname='a144_qp_money_read' and permissive='RESTRICTIVE')
union all select 'payments writes need a money edit', (select count(*) from pg_policies where schemaname='public' and tablename='quote_payments' and policyname in ('a144_qp_money_ins','a144_qp_money_upd','a144_qp_money_del') and permissive='RESTRICTIVE') = 3
union all select 'event_activity checks quotes view', pg_get_functiondef('public.event_activity(uuid)'::regprocedure) ilike '%has_area(''quotes'', ''view'')%'
union all select 'task_verify_summary checks area', pg_get_functiondef('public.task_verify_summary(uuid)'::regprocedure) ilike '%has_area(''staff'', ''view'')%'
union all select 'manager can still edit somewhere (matrix intact)', exists(select 1 from public.role_access where role='manager' and can_edit)
;
