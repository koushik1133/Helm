-- 0287_studio_timezone_today.sql - CANONICAL forward-only.
-- REQUIRES 0045 (studio_subscriptions), 0058/0120 (_trial_refresh), 0124/0239 (vendor_payables_summary__pre0239),
--          0181 (payment_reminder_send_now__pre0181), 0069 (_pkg_lock_reason), 0268 (checkout_availability).
--
-- In plain words (owner, r37: "the studios are in India (UAE planned) but I and some staff work from the US -
-- show and calculate everything in the STUDIO's time zone"):
--   The database clock runs in UTC. For an Indian studio the new day starts at 18:30 UTC, so a plain
--   "current_date" is still YESTERDAY for the first 5.5 hours of every Indian day (4 hours in Dubai).
--   1  NEW public.studio_timezone(org): the studio's own zone (organizations.timezone). A blank or unknown zone
--      falls back to the studio's country (IN -> Asia/Kolkata, AE -> Asia/Dubai), then Asia/Kolkata.
--   2  NEW public.studio_today(org [, at]): the calendar day in that zone ((now() at time zone <zone>)::date).
--      Both are internal (no API grant).
--   3  The server checks where "today" is visible to people now use the studio's day instead of UTC:
--        - payment reminder sent from the event ("overdue" / "due today" / "due soon" in the message);
--        - vendor payables card on the Business page (overdue / due in 7 days);
--        - the client's package choice lock ("too close to the event" N days before the event);
--        - inventory "overdue" (not back the day after the event) on the check-out screen;
--        - paid-plan trials: the trial ends, and the 7 / 3 / 1 day and "trial ended" reminders, on the studio's day.
--        - (follow-up) plan payment still running (_trial_paid), the attendance warning on event money, price-change
--          notices for upcoming events, crew WhatsApp for past events, nurture greetings (next birthday / anniversary,
--          "greeted this year"), the public enquiry form's date check, the default tax / payment date of a plan payment.
--      Plan billing (checkout tax date, payment date check, checkout trial end, cost breakdown range): the studio's day.
--      HQ actions (extend trial, realisation, provider settlement, tax rule start) and the HQ audit range (IST day
--      edges): India time. The UAE sample studio's dates: Dubai time.
--      Helm HQ screens (overview, billing, payments, HQ audit, security alerts): "today" / "this month" is INDIA time (NEW hq_today).
--      Each function keeps its name, arguments, answers and grants; only "current_date" is replaced.
--      _next_occasion(date) (called by signed-in users) now counts from the caller's own studio day (NEW internal
--      _my_studio_today, own studio only) through a NEW two-argument _next_occasion(date, today).
--      vendor_bills.bill_date keeps its column default (no default changed); the app and vendor_invoice_review always
--      send the date (the app: the studio's day).
--   No table, column, row or policy is changed; nothing deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run the previous bodies of the re-issued functions (0181, 0239, 0069, 0268,
--   0120 and the follow-up ones listed in section 4); the new helpers can stay.

-- ---- 1) the studio's zone + day --------------------------------------------------------------------------------------
create or replace function public.studio_timezone(p_org uuid)
returns text language plpgsql stable security definer set search_path to '' as $$
-- helm-0287-studio-tz
declare v_tz text; v_cc text;
begin
  select nullif(btrim(o.timezone), ''), upper(nullif(btrim(coalesce(o.country, o.brand #>> '{billing,country}', '')), ''))
    into v_tz, v_cc from public.organizations o where o.id = p_org;
  if v_tz is not null then
    begin
      perform now() at time zone v_tz;   -- an unknown zone name raises here
      return v_tz;
    exception when others then null;
    end;
  end if;
  return case v_cc when 'AE' then 'Asia/Dubai' else 'Asia/Kolkata' end;
end $$;

create or replace function public.studio_today(p_org uuid, p_at timestamptz default now())
returns date language sql stable security definer set search_path to '' as $$
  -- helm-0287-studio-tz
  select (coalesce(p_at, now()) at time zone public.studio_timezone(p_org))::date
$$;

do $$ declare f text; begin
  foreach f in array array['public.studio_timezone(uuid)', 'public.studio_today(uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ---- 2) the server checks that showed / used "today": same bodies, the studio's day instead of UTC ---------------------
CREATE OR REPLACE FUNCTION public.payment_reminder_send_now__pre0181(p_milestone uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); m public.payment_milestones; q public.quotes; v_n integer;
  v_cfg jsonb; v_due text; v_today date := public.studio_today(public.current_org_id());   -- r37: the studio's day
begin
  if v_me is null or v_org is null or not (public.has_area('finance', 'edit') or public.has_area('quotes', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into m from public.payment_milestones x where x.id = p_milestone and x.org_id = v_org;
  if m.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = m.quote_id and x.org_id = v_org;
  if q.id is null then raise exception 'milestone not found' using errcode = '42501'; end if;
  if m.status not in ('due', 'invoiced') then raise exception 'this milestone is already settled' using errcode = '22023'; end if;
  if coalesce(m.amount, 0) <= 0 then raise exception 'this milestone has no amount' using errcode = '22023'; end if;
  v_cfg := public._comms_cfg(v_org);
  if cardinality(public._comms_channels(v_cfg, 'pay_channels')) = 0 then
    raise exception 'choose a reminder channel in Control Center first' using errcode = '22023'; end if;
  if not exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c where public._comms_client_to(q.client, c, v_org) is not null) then
    raise exception 'add the client''s e-mail or WhatsApp number to the event first' using errcode = '22023'; end if;
  v_due := case when m.due_date is null then 'due' when m.due_date < v_today then 'overdue' when m.due_date = v_today then 'due today' else 'due soon' end;
  v_n := public._comms_queue_pay(m.id, 'manual', v_due, true, v_me);
  if v_n > 0 then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'payment_reminder.queued', 'payment_milestones', m.id::text, q.id, jsonb_build_object('rows', v_n), v_org);
  end if;
  return jsonb_build_object('queued', v_n, 'already_queued', v_n = 0);
end $function$;

CREATE OR REPLACE FUNCTION public.vendor_payables_summary__pre0239()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- vendor-bills-0124: read-only
declare v_org uuid := public.current_org_id(); r jsonb; v_today date := public.studio_today(public.current_org_id());   -- r37: the studio's day
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
    'overdue', coalesce(sum(amount - paid) filter (where due_date < v_today and amount > paid), 0),
    'due_7d', coalesce(sum(amount - paid) filter (where due_date between v_today and v_today + 7 and amount > paid), 0),
    'open_bills', count(*) filter (where amount > paid),
    'overdue_bills', count(*) filter (where due_date < v_today and amount > paid),
    'currencies', coalesce(jsonb_agg(distinct currency), '[]'::jsonb))
    into r from b;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public._pkg_lock_reason(p_quote uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare q public.quotes; v_days int; v_closed boolean := false; v_menu boolean := false;
begin
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null or q.deleted_at is not null or q.archived_at is not null then return 'unavailable'; end if;
  if not public._studio_writable(q.org_id) then return 'suspended'; end if;
  if to_regclass('public.event_closure') is not null then
    select exists (select 1 from public.event_closure c where c.quote_id = q.id and c.closed_at is not null) into v_closed;
  end if;
  if v_closed or q.lifecycle_stage in ('settlement', 'closed') then return 'frozen'; end if;   -- D6: closed event money is frozen
  if q.confirmed_at is not null or q.status = 'confirmed'
     or q.lifecycle_stage in ('planning', 'resources', 'ready', 'event_day') then return 'confirmed'; end if;
  select coalesce(ep.menu_locked, false) into v_menu from public.event_plan ep where ep.quote_id = q.id;
  if coalesce(v_menu, false) then return 'menu_locked'; end if;
  v_days := coalesce((public._pkg_settings(q.org_id) ->> 'pkg_lock_days')::int, 0);
  if q.event_date is not null and public.studio_today(q.org_id) > q.event_date - v_days then return 'too_close'; end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.checkout_availability(p_item uuid, p_quote uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid := public.current_org_id(); v_it record; v_date date; v_out numeric; v_free numeric;
  v_blocking jsonb; v_overdue jsonb; v_subs jsonb; v_resother jsonb;
begin
  if not (public.has_area('inventory', 'view') or public.has_area('inventory', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select id, name, category, unit, coalesce(total_qty, 0) as total into v_it
    from public.inventory_items where id = p_item and org_id = v_org;
  if not found then raise exception 'item not found' using errcode = '42501'; end if;
  if p_quote is not null then
    perform public.assert_quote_org(p_quote);
    select event_date into v_date from public.quotes where id = p_quote;
  end if;

  select coalesce(sum(public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged)), 0) into v_out
    from public.inventory_checkouts c where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial');
  v_free := public._checkout_free(p_item, v_date, p_quote);

  -- open check-outs holding this item: which event, how many, when due back (day after the event)
  select coalesce(jsonb_agg(x order by x->>'due_back' nulls last), '[]'::jsonb) into v_blocking from (
    select jsonb_build_object('checkout_id', c.id, 'quote_id', c.quote_id,
             'event', coalesce(q.title, 'No event'), 'event_date', q.event_date,
             'due_back', case when q.event_date is not null then q.event_date + 1 end,
             'qty', public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged), 'issued_to', c.issued_to,
             'overdue', (q.event_date is not null and q.event_date + 1 < public.studio_today(v_org))) as x
      from public.inventory_checkouts c left join public.quotes q on q.id = c.quote_id
     where c.item_id = p_item and c.org_id = v_org and c.status in ('out', 'partial')
       and public._r24_not_back(c.qty_out, c.qty_in, c.written_off, c.qty_damaged) > 0) s;
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_overdue
    from jsonb_array_elements(v_blocking) e where (e->>'overdue')::boolean;

  -- other events on the same date holding a reservation
  select coalesce(jsonb_agg(jsonb_build_object('quote_id', q.id, 'event', q.title, 'event_date', q.event_date, 'qty', r.qty)), '[]'::jsonb)
    into v_resother
    from (select quote_id, sum(qty) as qty from public.inventory_reservations
           where item_id = p_item and status in ('reserved', 'allocated') group by quote_id) r
    join public.quotes q on q.id = r.quote_id
   where v_date is not null and q.org_id = v_org and q.event_date = v_date and q.id is distinct from p_quote
     and q.deleted_at is null and q.archived_at is null and q.status <> 'cancelled';

  -- substitutes: same category, active, something free on that date
  select coalesce(jsonb_agg(s order by (s->>'available')::numeric desc), '[]'::jsonb) into v_subs from (
    select jsonb_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit,
             'available', public._checkout_free(i.id, v_date, p_quote)) as s
      from public.inventory_items i
     where i.org_id = v_org and i.id <> p_item and coalesce(i.active, true)
       and v_it.category is not null and i.category = v_it.category
     limit 20) t
   where (s->>'available')::numeric > 0;

  return jsonb_build_object('item_id', v_it.id, 'item', v_it.name, 'category', v_it.category, 'unit', v_it.unit,
    'total', v_it.total, 'out_now', v_out, 'reserved_other', greatest(v_it.total - v_out - v_free, 0),
    'in_repair', 0, 'available', v_free, 'event_date', v_date,
    'blocking', v_blocking, 'overdue', v_overdue, 'reserved_by', v_resother,
    'substitutes', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_subs) e limit 5) z));
end $function$;

CREATE OR REPLACE FUNCTION public._trial_refresh()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- trial-reminders-0058 trial-reminders-0120
declare n_pd int := 0; n_rem int := 0; rec record; v_kind text; v_id uuid;
begin
  for rec in
    select s.org_id, s.trial_ends_at from public.studio_subscriptions s
     where s.status = 'trial' and s.trial_ends_at is not null and s.trial_ends_at < public.studio_today(s.org_id)
       and not public._trial_paid(s.org_id)
     for update of s
  loop
    update public.studio_subscriptions set status = 'past_due', updated_at = now()
     where org_id = rec.org_id and status = 'trial';
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'billing.trial_ended_past_due', 'studio_subscriptions', rec.org_id::text,
              jsonb_build_object('trial_ends_at', rec.trial_ends_at), rec.org_id, now());
    n_pd := n_pd + 1;
  end loop;

  for rec in
    select s.org_id, s.status, s.trial_ends_at, (s.trial_ends_at - public.studio_today(s.org_id)) as d
      from public.studio_subscriptions s
     where s.trial_ends_at is not null and not public._trial_paid(s.org_id)
       and not exists (select 1 from public.organizations o where o.id = s.org_id and o.trial_ends_at is not null)
       and ((s.status = 'trial' and s.trial_ends_at between public.studio_today(s.org_id) and public.studio_today(s.org_id) + 7)
         or (s.status = 'past_due' and s.current_period_end is null
             and s.trial_ends_at < public.studio_today(s.org_id) and s.trial_ends_at >= public.studio_today(s.org_id) - 14))
  loop
    v_kind := case when rec.status = 'past_due' then 'trial_ended'
                   when rec.d <= 1 then 'trial_1d' when rec.d <= 3 then 'trial_3d' else 'trial_7d' end;
    v_id := null;
    insert into public.billing_reminders(org_id, kind, period_end) values (rec.org_id, v_kind, rec.trial_ends_at)
      on conflict (org_id, kind, period_end) do nothing
      returning id into v_id;
    if v_id is not null then
      n_rem := n_rem + 1;
      begin
        insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
          values (null, 'in_app', 'trial_reminder', 'simulated',
                  jsonb_build_object('trial', v_kind, 'label', public._trial_label(v_kind),
                                     'days_left', greatest(rec.d, 0), 'ends_at', rec.trial_ends_at),
                  rec.org_id);
      exception when others then null;
      end;
    end if;
  end loop;
  return jsonb_build_object('trial_past_due_set', n_pd, 'trial_reminders_queued', n_rem);
end $function$;

-- ---- 3) more helpers: Helm HQ's day (India time), the signed-in user's own studio day, the next occasion ----------
create or replace function public.hq_today(p_at timestamptz default now())
returns date language sql stable security definer set search_path to '' as $$
  -- helm-0287-studio-tz: Helm HQ runs on India time
  select (coalesce(p_at, now()) at time zone 'Asia/Kolkata')::date
$$;

-- the caller's OWN studio day (no argument, so nobody can read another studio's zone)
create or replace function public._my_studio_today()
returns date language sql stable security definer set search_path to '' as $$
  -- helm-0287-studio-tz
  select public.studio_today(public.current_org_id())
$$;

-- next yearly occurrence of p_date on or after p_today (29 Feb -> 28 Feb in other years)
create or replace function public._next_occasion(p_date date, p_today date)
returns date language plpgsql immutable set search_path to '' as $$
-- helm-0287-studio-tz
declare y int; m int; d int; cand date; v_t date := coalesce(p_today, (now() at time zone 'Asia/Kolkata')::date);
begin
  if p_date is null then return null; end if;
  y := extract(year from v_t)::int; m := extract(month from p_date)::int; d := extract(day from p_date)::int;
  begin cand := make_date(y, m, d); exception when others then cand := make_date(y, m, 28); end;
  if cand < v_t then
    begin cand := make_date(y + 1, m, d); exception when others then cand := make_date(y + 1, m, 28); end;
  end if;
  return cand;
end $$;

-- the old one-argument form keeps its name / answer / grants: "today" is now the caller's studio day (was UTC)
create or replace function public._next_occasion(p_date date)
returns date language plpgsql stable set search_path to 'public' as $$
-- helm-0287-studio-tz
begin
  return public._next_occasion(p_date, public._my_studio_today());
end $$;

do $$ declare f text; begin
  foreach f in array array['public.hq_today(timestamptz)', 'public._my_studio_today()', 'public._next_occasion(date, date)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- the one-argument _next_occasion is called by signed-in users (invoker), so they need its two helpers
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.hq_today(timestamptz) from authenticated';
    execute 'grant execute on function public._my_studio_today() to authenticated';
    execute 'grant execute on function public._next_occasion(date, date) to authenticated';
  end if;
end $$;

-- ---- 4) the rest of the server "today" checks: the studio's day (HQ screens: India time) --------------------------
CREATE OR REPLACE FUNCTION public._trial_paid(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.subscription_payments sp
                  where sp.org_id = p_org and sp.voided_at is null
                    and (sp.period_end is null or sp.period_end >= public.studio_today(p_org)));
$function$;

CREATE OR REPLACE FUNCTION public._r21_event_money(p_quote uuid, p_org uuid, p_lines boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if n > 0 and v_ev is not null and v_ev < public.studio_today(p_org) then v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'attendance_not_marked', 'count', n,
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
end $function$;

CREATE OR REPLACE FUNCTION public._r3_price_change_notify(p_org uuid, p_source text, p_fields text[], p_package text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- reprice-alert-0077 + r4-0082: skips soft-deleted / archived quotes
-- trial-seed-0222: skips sample data (is_demo), confirmed events and client-approved / paid quotes
declare n integer := 0;
begin
  if p_org is null or coalesce(array_length(p_fields, 1), 0) = 0 then return 0; end if;
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
  select q.id, 'in_app', 'price_change', 'sent',
         jsonb_build_object('source', p_source, 'fields', to_jsonb(p_fields), 'event_code', q.code,
                            'path', 'flow.html?id=' || q.id::text), p_org
    from public.quotes q
   where q.org_id = p_org and q.deleted_at is null and q.archived_at is null
     and not coalesce(q.is_demo, false)
     and coalesce(q.status, '') not in ('cancelled', 'confirmed')
     and coalesce(q.approval_status, '') not in ('approved', 'paid')
     and coalesce(q.lifecycle_stage, 'quote') not in ('settlement', 'closed')
     and (q.event_date is null or q.event_date >= public.studio_today(p_org))
     and coalesce(public._r3_num(q.pricing, 'total'), 0) > 0
     and (
          (p_source = 'menu' and q.pricing ->> '_packageName' = p_package and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0)
       or (p_source = 'pricing' and (
             ('chairPrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'chairs'), 0) > 0)
          or ('platePrice' = any (p_fields) and coalesce(public._r3_num(q.pricing, 'guests'), 0) > 0 and nullif(q.pricing ->> '_packageName', '') is null)
          or (('layoutBase' = any (p_fields) or 'assetPrices' = any (p_fields)) and coalesce(public._r3_num(q.pricing, 'other'), 0) > 0)
          or 'gstPct' = any (p_fields) or 'serviceChargePct' = any (p_fields)))
     )
     and not exists (select 1 from public.notifications x
                      where x.quote_id = q.id and x.kind = 'price_change' and x.org_id = p_org
                        and x.created_at > now() - interval '10 minutes'
                        and x.detail ->> 'source' = p_source and x.detail -> 'fields' = to_jsonb(p_fields))
   order by q.event_date nulls last
   limit 200;
  get diagnostics n = row_count;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public._assign132_enqueue__pre0274(p_org uuid, p_quote uuid, p_kind text, p_item uuid, p_phone text, p_name text, p_activity text, p_when text, p_location text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- helm-0132-assign-notify
declare v_phone text := public._assign132_phone(p_phone); q record; v_tok uuid; v_body text; v_link text; v_prev record;
begin
  if p_org is null or p_quote is null or p_item is null or v_phone is null then return false; end if;
  select qq.id, qq.code, qq.title, qq.status, qq.event_date, qq.deleted_at, qq.lifecycle_stage into q
    from public.quotes qq where qq.id = p_quote and qq.org_id = p_org;
  if q.id is null or q.deleted_at is not null or coalesce(q.status, '') = 'cancelled'
     or coalesce(q.lifecycle_stage, '') = 'closed' or (q.event_date is not null and q.event_date < public.studio_today(p_org)) then
    return false;
  end if;
  -- the person's own live task link for this event, if the office has issued one
  select wt.token into v_tok from public.work_tokens wt
   where wt.quote_id = p_quote and wt.org_id = p_org and public._assign132_phone(wt.phone) = v_phone
     and wt.revoked_at is null and (wt.expires_at is null or wt.expires_at > now())
   order by wt.created_at desc limit 1;
  v_link := case when v_tok is not null then 'work.html?token=' || v_tok::text end;
  v_body := 'Hi ' || coalesce(nullif(btrim(p_name), ''), 'there') || ', '
         || coalesce(nullif(nullif(btrim(q.title), ''), 'Untitled event'), q.code)
         || ': you''ve been assigned ''' || left(coalesce(nullif(btrim(p_activity), ''), 'a task'), 200) || ''''
         || case when nullif(btrim(p_when), '') is not null then ' at ' || btrim(p_when) else '' end
         || case when nullif(btrim(p_location), '') is not null then ' (' || left(btrim(p_location), 120) || ')' else '' end
         || '.' || case when v_link is not null then ' Open your link:' else ' Please check with the office for details.' end;
  v_body := left(regexp_replace(v_body, '[[:cntrl:]<>]', ' ', 'g'), 880);
  perform pg_advisory_xact_lock(hashtextextended('helm.assign132:' || p_item::text || ':' || v_phone, 0));
  select o.id, o.status, o.claimed_at, o.sent_at into v_prev from public.assign_notify_outbox o
   where o.item_id = p_item and o.phone = v_phone and o.created_at > now() - interval '10 minutes'
   order by o.created_at desc limit 1;
  if v_prev.id is not null then
    if v_prev.status = 'pending' and v_prev.sent_at is null and v_prev.claimed_at is null then
      update public.assign_notify_outbox set body = v_body, link_path = v_link, name = left(p_name, 120), updated_at = now()
       where id = v_prev.id and claimed_at is null and sent_at is null;
      return true;
    end if;
    return false;   -- one message per item + person per 10 minutes
  end if;
  insert into public.assign_notify_outbox (org_id, quote_id, item_kind, item_id, phone, name, body, link_path, created_by)
    values (p_org, p_quote, p_kind, p_item, v_phone, left(nullif(btrim(p_name), ''), 120), v_body, v_link, auth.uid());
  return true;
end $function$;

CREATE OR REPLACE FUNCTION public.nurture_due__pre0202(p_within_days integer DEFAULT 30)
 RETURNS TABLE(id uuid, name text, email text, phone text, occasion text, occasion_type text, occasion_date date, next_date date, years integer, auto_on boolean, greeted_this_year boolean, quote_id uuid, last_event text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select n.id, n.name, n.email, n.phone, n.occasion, coalesce(n.occasion_type,'custom'),
         n.occasion_date,
         public._next_occasion(n.occasion_date) as next_date,
         (extract(year from public._next_occasion(n.occasion_date))::int
            - extract(year from n.occasion_date)::int) as years,
         n.auto_on,
         coalesce(n.last_greeted > public.studio_today(n.org_id) - interval '335 days', false) as greeted_this_year,
         n.quote_id,
         (select q.title from public.quotes q where q.id = n.quote_id) as last_event
  from public.nurture n
  where public.has_area('nurture','view')
    and n.org_id = public.current_org_id()
    and n.occasion_date is not null
    and public._next_occasion(n.occasion_date, public.studio_today(n.org_id)) <= public.studio_today(n.org_id) + (greatest(p_within_days,0) || ' days')::interval
  order by public._next_occasion(n.occasion_date);
$function$;

CREATE OR REPLACE FUNCTION public.queue_nurture_greeting__pre0202(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text := 'Blueprint Stage';
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'contact not found'; end if;

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot and org_id = public.current_org_id();
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom' and org_id = public.current_org_id(); end if;

  v_years := coalesce(extract(year from public._next_occasion(n.occasion_date))::int
                      - extract(year from n.occasion_date)::int, 0);
  select q.title into v_last from public.quotes q where q.id = n.quote_id;
  v_last := coalesce(v_last, 'your event with us');
  select array_agg(url order by seq, created_at) into v_photos
    from (select url, seq, created_at from public.event_media
          where quote_id = n.quote_id and in_gallery = true order by seq, created_at limit 3) m;

  v_subject := replace(replace(replace(replace(replace(coalesce(tpl.subject,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);
  v_body := replace(replace(replace(replace(replace(coalesce(tpl.body,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);

  v_detail := jsonb_build_object(
    'subject', v_subject, 'body', v_body,
    'photos', to_jsonb(coalesce(v_photos, array[]::text[])),
    'occasion_type', ot, 'contact', n.name, 'auto', n.auto_on);

  perform public._notify(n.quote_id, 'email', n.email, 'nurture_'||ot, v_detail);
  update public.nurture set last_greeted = public.studio_today(public.current_org_id()) where id = p_id and org_id = public.current_org_id();
  return v_detail;
end; $function$;

CREATE OR REPLACE FUNCTION public._resolve_tax(p_org uuid, p_paid_on date, p_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.studio_account; b public.helm_billing_settings; v_country text; v_seller text; v_rate numeric;
  r record; v_regime text; v_note text; v_comp jsonb := '[]'::jsonb; v_refund boolean := false; v_rc boolean := false;
  v_lut boolean; v_net numeric; v_tax numeric; v_half numeric; d date := coalesce(p_paid_on, public.studio_today(p_org));
begin
  select * into a from public.studio_account where org_id = p_org;
  select * into b from public.helm_billing_settings where id;
  v_seller := coalesce(b.seller_country, 'IN');
  v_country := coalesce(a.country, v_seller);
  select t.rate into v_rate from public.tax_rules t
   where t.country = 'IN' and t.regime in ('IN_GST_INTER','IN_GST_INTRA') and t.active and t.region is null
     and t.effective_from <= d and (t.effective_to is null or t.effective_to >= d)
   order by (t.regime = 'IN_GST_INTER') desc, t.effective_from desc limit 1;
  v_rate := coalesce(v_rate, 18);
  if v_country = v_seller then
    if lower(btrim(coalesce(a.state, ''))) <> '' and lower(btrim(coalesce(a.state, ''))) = lower(btrim(coalesce(b.seller_state, ''))) then
      select coalesce((select t.rate from public.tax_rules t where t.country = 'IN' and t.regime = 'IN_GST_INTRA' and t.active and t.region is null
         and t.effective_from <= d and (t.effective_to is null or t.effective_to >= d) order by t.effective_from desc limit 1), v_rate) into v_rate;
      v_regime := 'IN_GST_INTRA';
      v_comp := jsonb_build_array(jsonb_build_object('name', 'CGST', 'rate', round(v_rate / 2, 2)), jsonb_build_object('name', 'SGST', 'rate', round(v_rate / 2, 2)));
    else
      v_regime := 'IN_GST_INTER';
      v_comp := jsonb_build_array(jsonb_build_object('name', 'IGST', 'rate', v_rate));
    end if;
  else
    select t.* into r from public.tax_rules t
     where t.country = v_country and t.regime in ('NO_TAX','LOCAL_REGISTERED') and t.active
       and (t.region is null or lower(t.region) = lower(coalesce(a.state, '')))
       and t.effective_from <= d and (t.effective_to is null or t.effective_to >= d)
     order by (t.region is not null) desc, (t.regime = 'NO_TAX') desc, t.effective_from desc limit 1;
    v_rc := coalesce(a.is_business, true) and a.tax_id is not null;
    if found and r.regime = 'NO_TAX' then
      v_regime := 'NO_TAX'; v_rate := 0; v_note := r.invoice_note;
    elsif found then
      v_regime := 'LOCAL_REGISTERED'; v_rate := r.rate; v_note := r.invoice_note; v_rc := false;
      v_comp := jsonb_build_array(jsonb_build_object('name', 'Tax (' || v_country || ')', 'rate', r.rate));
    else
      v_lut := b.lut_number is not null and (b.lut_valid_from is null or b.lut_valid_from <= d)
               and (b.lut_valid_to is null or b.lut_valid_to >= d);
      if v_lut then
        v_regime := case when v_rc then 'REVERSE_CHARGE' else 'EXPORT_LUT_ZERO' end; v_rate := 0;
        v_note := E'Supply meant for export under LUT without payment of IGST \u2014 LUT ' || b.lut_number;
      else
        v_regime := 'EXPORT_IGST_PAID'; v_refund := true;
        v_note := 'Export of services with payment of IGST (refund claimable)';
        v_comp := jsonb_build_array(jsonb_build_object('name', 'IGST', 'rate', v_rate));
      end if;
    end if;
    if v_rc then
      v_note := concat_ws('. ', v_note, E'Reverse charge \u2014 VAT to be accounted for by the recipient');
    end if;
  end if;
  if p_amount is not null then
    v_net := round(p_amount / (1 + v_rate / 100), 2); v_tax := round(p_amount, 2) - v_net;
    if v_regime = 'IN_GST_INTRA' then
      v_half := round(v_tax / 2, 2);
      v_comp := jsonb_build_array(jsonb_build_object('name', 'CGST', 'rate', round(v_rate / 2, 2), 'amount', v_half),
                                  jsonb_build_object('name', 'SGST', 'rate', round(v_rate / 2, 2), 'amount', v_tax - v_half));
    elsif jsonb_array_length(v_comp) = 1 then
      v_comp := jsonb_build_array(v_comp -> 0 || jsonb_build_object('amount', v_tax));
    end if;
  end if;
  return jsonb_build_object('regime', v_regime, 'rate', v_rate, 'components', v_comp, 'note', v_note,
    'refundable', v_refund, 'reverse_charge', v_rc, 'net', v_net, 'tax', v_tax,
    'place_of_supply', case when v_country = 'IN' then coalesce(nullif(btrim(a.state), ''), 'IN') else v_country end,
    'lut_number', case when v_regime in ('EXPORT_LUT_ZERO','REVERSE_CHARGE') then b.lut_number end);
end $function$;

CREATE OR REPLACE FUNCTION public.hq_activate_plan(p_org uuid, p_plan_code text, p_interval text, p_amount numeric, p_method text, p_period_start date DEFAULT NULL::date, p_paid_on date DEFAULT NULL::date, p_reference text DEFAULT NULL::text, p_currency text DEFAULT 'INR'::text, p_fx_rate_to_inr numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- r21-trial-paid-0244
declare v_plan uuid; v_active boolean; v_start date := coalesce(p_period_start, public.studio_today(p_org)); v_end date;
  v_paid date := coalesce(p_paid_on, public.studio_today(p_org)); v_pay uuid; v_res jsonb; v_replay boolean := false; v_status text;
begin
  perform public._hq_wgate('hq.subscription.activate', 'studio_subscriptions', p_org::text,
    jsonb_build_object('plan', p_plan_code, 'interval', p_interval, 'amount', p_amount, 'currency', p_currency, 'method', p_method,
                       'period_start', v_start, 'paid_on', v_paid, 'reference', left(p_reference, 120)));
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio' using errcode = '22023'; end if;
  select hp.id, hp.active into v_plan, v_active from public.helm_plans hp where hp.code = lower(btrim(coalesce(p_plan_code, '')));
  if v_plan is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  if not v_active then raise exception 'this plan is switched off - turn it on in Plans first' using errcode = '22023'; end if;
  if coalesce(p_interval, '') not in ('monthly', 'yearly') then raise exception 'billing must be monthly or yearly' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be more than 0' using errcode = '22023'; end if;
  if v_start < date '2020-01-01' or v_start > public.studio_today(p_org) + 366 then raise exception 'period start is not valid' using errcode = '22023'; end if;
  v_end := public._sub_period_end(v_start, p_interval);
  perform pg_advisory_xact_lock(hashtext('helm_activate:' || p_org::text));
  select s.status into v_status from public.studio_subscriptions s where s.org_id = p_org for update;
  if v_status = 'suspended' then raise exception 'this studio is suspended - reactivate it first' using errcode = '22023'; end if;
  -- the same payment again (double click / retry): no second payment
  select sp.id into v_pay from public.subscription_payments sp
   where sp.org_id = p_org and sp.voided_at is null and sp.period_start = v_start and sp.period_end = v_end
     and sp.amount = round(p_amount, 2) and sp.method = p_method and sp.recorded_at > now() - interval '1 day'
   order by sp.recorded_at desc limit 1;
  v_replay := v_pay is not null;
  if not v_replay then
    -- the plan first, so the invoice names it
    insert into public.studio_subscriptions(org_id, plan_id, status, billing_interval, updated_at, updated_by)
      values (p_org, v_plan, 'trial', p_interval, now(), auth.uid())
    on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
        updated_at = now(), updated_by = auth.uid();
    v_pay := public._sub_record_payment(p_org, p_amount, p_currency, v_paid, v_start, v_end, p_method, p_reference,
               auth.uid(), null, null, null, p_fx_rate_to_inr);
  end if;
  v_res := public._sub_activate(p_org, v_plan, p_interval, v_start, v_end, auth.uid(), 'hq');
  return jsonb_build_object('result', case when v_replay then 'replay' else 'activated' end,
    'payment', (select public._sub_payment_json(sp) from public.subscription_payments sp where sp.id = v_pay),
    'subscription', (select jsonb_build_object('status', s.status, 'plan_code', (select hp.code from public.helm_plans hp where hp.id = s.plan_id),
                       'billing_interval', s.billing_interval, 'current_period_start', s.current_period_start,
                       'current_period_end', s.current_period_end)
                       from public.studio_subscriptions s where s.org_id = p_org),
    'activation', v_res);
end $function$;

CREATE OR REPLACE FUNCTION public.public_enquiry_submit__pre0276(p_slug text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid; v_ip text := public._r24_ip_hash(); c jsonb; k text;
  v_name text; v_email text; v_phone text; v_type text; v_date date; v_guests integer; v_msg text; v_lead uuid; v_studio text;
  v_ua text; v_reply_to text; v_status text := 'pending'; v_reason text; h jsonb;
begin
  -- r24-automation-0269
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('name', 'phone', 'email', 'event_type', 'event_date', 'guests', 'message', 'consent', 'website', 'captcha') then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'Please fill in the form.'); end if;
  end loop;
  if v_ip is not null and public.rate_hit('enq.ip', v_ip, 3600, 5) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many enquiries from this network. Please try again in an hour.'); end if;
  v_org := public._r24_enquiry_org(p_slug);
  if v_org is null then return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This enquiry form is not open right now.'); end if;
  -- a filled hidden field = a bot: say thank you, keep nothing
  if nullif(btrim(coalesce(p ->> 'website', '')), '') is not null then return jsonb_build_object('ok', true); end if;
  if public.rate_hit('enq.org', v_org::text, 3600, 30) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'The studio is receiving many enquiries. Please try again a little later.'); end if;
  v_name := left(btrim(regexp_replace(coalesce(p ->> 'name', ''), '[[:cntrl:]<>]', ' ', 'g')), 80);
  if char_length(v_name) < 2 then return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'name', 'message', 'Please enter your name.'); end if;
  v_email := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  if v_email is not null and not public._dl241_email_ok(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'email', 'message', 'Please enter a valid e-mail address.'); end if;
  v_phone := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
  if v_phone is not null and regexp_replace(v_phone, '[^0-9]', '', 'g') !~ '^[0-9]{10,15}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'phone', 'message', 'Please enter a valid phone number (10 digits).'); end if;
  if v_email is null and v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'phone', 'message', 'Please give a phone number or an e-mail so the studio can reply.'); end if;
  if coalesce(p ->> 'consent', '') <> 'true' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'consent', 'message', 'Please tick the box so the studio may contact you.'); end if;
  v_type := nullif(left(btrim(regexp_replace(coalesce(p ->> 'event_type', ''), '[[:cntrl:]<>]', ' ', 'g')), 60), '');
  if nullif(btrim(coalesce(p ->> 'event_date', '')), '') is not null then
    if (p ->> 'event_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick the event date.'); end if;
    begin v_date := (p ->> 'event_date')::date; exception when others then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick the event date.'); end;
    if v_date < public.studio_today(v_org) or v_date > public.studio_today(v_org) + 1100 then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'event_date', 'message', 'Please pick a date from today onwards.'); end if;
  end if;
  if nullif(btrim(coalesce(p ->> 'guests', '')), '') is not null then
    if (p ->> 'guests') !~ '^[0-9]{1,6}$' or (p ->> 'guests')::integer not between 1 and 100000 then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'guests', 'message', 'Guests: a number from 1 to 100000.'); end if;
    v_guests := (p ->> 'guests')::integer;
  end if;
  v_msg := nullif(left(btrim(regexp_replace(coalesce(p ->> 'message', ''), '[<>]', ' ', 'g')), 1000), '');
  if public.rate_hit('enq.addr', encode(pg_catalog.sha256(convert_to(v_org::text || ':' || coalesce(v_email, '') || ':'
       || coalesce(regexp_replace(v_phone, '[^0-9]', '', 'g'), ''), 'UTF8')), 'hex'), 86400, 3) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'We already have your enquiry. The studio will get back to you soon.'); end if;
  c := public._r24_cfg(v_org);
  select o.name into v_studio from public.organizations o where o.id = v_org;
  begin
    insert into public.leads(org_id, name, phone, email, source, event_type, event_date, guest_count, notes, status, owner)
      values (v_org, v_name, v_phone, v_email, 'enquiry_form', v_type, v_date, v_guests,
              'From the enquiry form' || coalesce(': ' || v_msg, ''), 'new', null)
      returning id into v_lead;
  exception when others then
    raise warning 'r24-0269: enquiry not saved (%)', sqlstate;
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'The studio cannot take enquiries online right now. Please call or e-mail them.');
  end;
  -- the instant reply: queued only (comms-dispatch sends it once e-mail is live); free trials / no e-mail -> kept as skipped
  if v_email is null then v_status := 'skipped'; v_reason := 'no_email';
  elsif not coalesce((c ->> 'enquiry_reply')::boolean, false) then v_status := 'skipped'; v_reason := 'reply_off';
  elsif coalesce(public._tb179_no_send(v_org), false) then v_status := 'skipped'; v_reason := 'free_trial';
  else v_reply_to := v_email; end if;
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ua := left(nullif(btrim(regexp_replace(coalesce(h ->> 'user-agent', ''), '[[:cntrl:]]', ' ', 'g')), ''), 200);
  insert into public.lead_enquiries(org_id, lead_id, ip_hash, user_agent, reply_to, reply_name, reply_status, reply_reason, sent_at)
    values (v_org, v_lead, v_ip, v_ua, coalesce(v_reply_to, v_email), v_name, v_status, v_reason, case when v_status = 'skipped' then now() end);
  if coalesce((c ->> 'enquiry_notify')::boolean, true) then
    begin
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (null, 'in_app', 'lead_new', 'simulated',
                jsonb_build_object('label', left('New enquiry from ' || v_name || coalesce(' - ' || v_type, '')
                                                 || coalesce(', ' || to_char(v_date, 'DD/MM/YYYY'), '') || ' (enquiry form)', 300),
                                   'via', 'comms', 'source', '0269', 'lead_id', v_lead), v_org);
    exception when others then raise warning 'r24-0269: enquiry bell skipped (%)', sqlstate;
    end;
  end if;
  return jsonb_build_object('ok', true, 'studio', v_studio);
end $function$;

CREATE OR REPLACE FUNCTION public.hq_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; v jsonb; n bigint; m bigint; today date := public.hq_today();   -- r37: Helm HQ runs on India time
begin
  perform public._hq_gate('hq_overview');
  perform public._billing_refresh();
  r := jsonb_build_object(
    'generated_at', now(),
    'studios', jsonb_build_object(
      'total',  (select count(*) from public.organizations),
      'new_7d', (select count(*) from public.organizations where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from public.organizations where created_at >= now() - interval '30 days'),
      'by_status', (select jsonb_object_agg(t.st_k, t.st_c) from (
          select coalesce(ss.status, 'none') st_k, count(*) st_c from public.organizations o
            left join public.studio_subscriptions ss on ss.org_id = o.id group by 1) t)),
    'users', jsonb_build_object(
      'total',  (select count(*) from auth.users),
      'new_7d', (select count(*) from auth.users where created_at >= now() - interval '7 days'),
      'new_30d',(select count(*) from auth.users where created_at >= now() - interval '30 days'),
      'active_7d', (select count(*) from auth.users where last_sign_in_at >= now() - interval '7 days'),
      'active_30d',(select count(*) from auth.users where last_sign_in_at >= now() - interval '30 days')),
    'billing', jsonb_build_object(
      'mrr', public._hq_mrr(), 'mrr_inr', public._hq_mrr_inr(),
      'paid_this_month', public._hq_money_by_currency(date_trunc('month', public.hq_today())::date, today),
      'past_due_count', (select count(*) from public.studio_subscriptions where status = 'past_due'),
      'suspended_count', (select count(*) from public.studio_subscriptions where status = 'suspended'),
      'reminders_pending', (select count(*) from public.billing_reminders where sent_at is null)));
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'studios', coalesce(s.c, 0), 'users', coalesce(u.c, 0)) order by d), '[]'::jsonb)
    into v
    from generate_series(today - 29, today, interval '1 day') d
    left join (select created_at::date k, count(*) c from public.organizations group by 1) s on s.k = d::date
    left join (select created_at::date k, count(*) c from auth.users group by 1) u on u.k = d::date;
  r := r || jsonb_build_object('signups_30d', v);
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select count(distinct user_id) from auth.mfa_factors where status::text = ''verified''' into n;
    select count(*) into m from auth.users;
    r := r || jsonb_build_object('mfa', jsonb_build_object('users_with_mfa', n, 'users_total', m,
             'pct', case when m > 0 then round(100.0 * n / m, 1) else 0 end));
  end if;
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      execute $q$select count(*) from auth.audit_log_entries
                  where created_at >= now() - interval '7 days'
                    and payload ->> 'action' in ('login','user_signedin','token_refreshed')$q$ into n;
      r := r || jsonb_build_object('auth_logins_7d', n);
    exception when others then null;
    end;
  end if;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION public.hq_billing(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f date := coalesce(p_from, date_trunc('month', public.hq_today())::date); t date := coalesce(p_to, public.hq_today());
begin
  perform public._hq_gate('hq_billing', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  perform public._billing_refresh();
  return jsonb_build_object('from', f, 'to', t,
    'collected', public._hq_money_by_currency(f, t),
    'payments_count', (select count(*) from public.subscription_payments where voided_at is null and paid_on between f and t),
    'voided_count', (select count(*) from public.subscription_payments where voided_at is not null and paid_on between f and t),
    'mrr', public._hq_mrr(), 'mrr_inr', public._hq_mrr_inr(), 'unrealised_exports',
      (select count(*) from public.subscription_payments x where x.voided_at is null and x.realised_on is null
         and x.tax_regime in ('EXPORT_LUT_ZERO','EXPORT_IGST_PAID','REVERSE_CHARGE')),
    'per_studio', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'status', coalesce(s.status, 'none'),
            'plan_code', hp.code, 'paid', x.paid, 'currency', x.currency, 'payments', x.n) order by o.name)
         from (select sp.org_id, sp.currency, sum(sp.amount) paid, count(*) n from public.subscription_payments sp
                where sp.voided_at is null and sp.paid_on between f and t group by sp.org_id, sp.currency) x
         join public.organizations o on o.id = x.org_id
         left join public.studio_subscriptions s on s.org_id = o.id left join public.helm_plans hp on hp.id = s.plan_id), '[]'::jsonb),
    'past_due', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'plan_code', hp.code,
            'current_period_end', s.current_period_end, 'days_overdue', public.hq_today() - s.current_period_end) order by s.current_period_end)
         from public.studio_subscriptions s join public.organizations o on o.id = s.org_id
         left join public.helm_plans hp on hp.id = s.plan_id where s.status = 'past_due'), '[]'::jsonb),
    'reminders', coalesce((select jsonb_agg(jsonb_build_object('id', br.id, 'org_id', br.org_id, 'studio', o.name, 'kind', br.kind,
            'period_end', br.period_end, 'created_at', br.created_at, 'sent_at', br.sent_at, 'channel', br.channel) order by br.created_at desc)
         from (select * from public.billing_reminders order by created_at desc limit 100) br
         join public.organizations o on o.id = br.org_id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) || jsonb_build_object('studio', o.name)
                          order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp join public.organizations o on o.id = sp.org_id
      where sp.paid_on between f and t), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.hq_payments(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f date := coalesce(p_from, public.hq_today() - 30); t date := coalesce(p_to, public.hq_today());
begin
  perform public._hq_gate('hq_payments', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t,
    'payments', coalesce((select jsonb_agg(public._sub_payment_json(sp) || jsonb_build_object('studio', o.name)
                          order by sp.paid_on desc, sp.recorded_at desc)
       from public.subscription_payments sp join public.organizations o on o.id = sp.org_id
      where sp.paid_on between f and t), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.hq_audit(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f date := coalesce(p_from, public.hq_today() - 30); t date := coalesce(p_to, public.hq_today());
begin
  perform public._hq_gate('hq_audit', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t, 'rows', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
     select jsonb_build_object('at', a.at, 'actor_email', a.actor_email, 'action', a.action, 'entity', a.entity,
              'entity_id', a.entity_id, 'changed', a.changed) x
       from public.audit_log a
      where a.action like 'hq.%' and a.org_id is null
        and a.at >= (f::timestamp at time zone 'Asia/Kolkata') and a.at < ((t + 1)::timestamp at time zone 'Asia/Kolkata')   -- r37: IST day edges
      order by a.at desc limit 1000) z), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.hq_security_alerts(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f date := coalesce(p_from, public.hq_today() - 30); t date := coalesce(p_to, public.hq_today());
begin
  perform public._hq_gate('hq_security_alerts', f::text || '..' || t::text);
  if t < f or t - f > 366 then raise exception 'date range must be 0..366 days' using errcode = '22023'; end if;
  return jsonb_build_object('from', f, 'to', t,
    'total', (select count(*) from public.security_alert_events e where e.created_at >= f and e.created_at < t + 1),
    'by_type', coalesce((select jsonb_agg(x order by x ->> 'latest' desc) from (
        select jsonb_build_object('type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'count', count(*), 'studios', count(distinct e.org_id), 'latest', max(e.created_at)) x
          from public.security_alert_events e where e.created_at >= f and e.created_at < t + 1
         group by e.alert_type) z), '[]'::jsonb),
    'by_studio', coalesce((select jsonb_agg(x order by x ->> 'latest' desc) from (
        select jsonb_build_object('org_id', e.org_id, 'studio', coalesce(o.name, case when e.org_id is null then 'Helm HQ' else 'Unknown studio' end),
                                  'type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'count', count(*), 'latest', max(e.created_at)) x
          from public.security_alert_events e left join public.organizations o on o.id = e.org_id
         where e.created_at >= f and e.created_at < t + 1
         group by e.org_id, o.name, e.alert_type
         order by max(e.created_at) desc limit 300) z), '[]'::jsonb),
    'latest', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('at', e.created_at, 'type', e.alert_type, 'label', public._sa54_label(e.alert_type),
                                  'studio', coalesce(o.name, case when e.org_id is null then 'Helm HQ' else 'Unknown studio' end),
                                  'actor_name', e.detail ->> 'actor_name', 'subject_name', e.detail ->> 'subject_name') x
          from public.security_alert_events e left join public.organizations o on o.id = e.org_id
         where e.created_at >= f and e.created_at < t + 1
         order by e.created_at desc limit 100) z), '[]'::jsonb));
end $function$
;

-- ---- 5) the last "today" spots: plan billing on the studio day; HQ actions on India time; HQ audit range on IST
--         day edges; the UAE sample data on Dubai time -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._checkout_quote(p_org uuid, p_plan text, p_interval text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cur text := public._checkout_currency(p_org); pr jsonb; v_net numeric; tx jsonb; v_rate numeric;
  v_tax numeric; v_half numeric; v_comp jsonb := '[]'::jsonb; c jsonb;
begin
  if p_interval is null or p_interval not in ('monthly','yearly') then
    raise exception 'choose monthly or yearly billing' using errcode = '22023'; end if;
  if p_plan is null or p_plan !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'choose a plan' using errcode = '22023'; end if;
  pr := public._checkout_plan_price(p_plan, v_cur);
  if pr is null then raise exception 'that plan is not available' using errcode = '22023'; end if;
  v_net := (pr ->> p_interval)::numeric;
  if v_net is null then raise exception 'that plan has no % price', p_interval using errcode = '22023'; end if;
  tx := public._resolve_tax(p_org, public.studio_today(p_org), null);
  v_rate := coalesce((tx ->> 'rate')::numeric, 0);
  v_tax := round(v_net * v_rate / 100, 2);
  if tx ->> 'regime' = 'IN_GST_INTRA' then
    v_half := round(v_tax / 2, 2);
    v_comp := jsonb_build_array(jsonb_build_object('name', 'CGST', 'rate', round(v_rate / 2, 2), 'amount', v_half),
                                jsonb_build_object('name', 'SGST', 'rate', round(v_rate / 2, 2), 'amount', v_tax - v_half));
  else
    for c in select value from jsonb_array_elements(coalesce(tx -> 'components', '[]'::jsonb)) loop
      v_comp := v_comp || jsonb_build_array(c || jsonb_build_object('amount', v_tax));
    end loop;
  end if;
  return jsonb_build_object('plan', pr ->> 'code', 'plan_name', pr ->> 'name', 'interval', p_interval, 'currency', v_cur,
    'net', round(v_net, 2), 'tax', v_tax, 'total', round(v_net, 2) + v_tax, 'rate', v_rate,
    'regime', tx ->> 'regime', 'components', v_comp, 'note', tx ->> 'note',
    'reverse_charge', coalesce((tx ->> 'reverse_charge')::boolean, false),
    'place_of_supply', tx ->> 'place_of_supply',
    'razorpay_plan_id', pr ->> case p_interval when 'monthly' then 'rzp_monthly' else 'rzp_yearly' end);
end $function$;
CREATE OR REPLACE FUNCTION public._sub_record_payment(p_org uuid, p_amount numeric, p_currency text, p_paid_on date, p_period_start date, p_period_end date, p_method text, p_reference text, p_actor uuid, p_provider text, p_provider_payment_id text, p_provider_subscription_id text, p_fx_rate_to_inr numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_seq bigint; b record; a public.studio_account; o public.organizations; v_plan text; tx jsonb;
  v_cur text := upper(coalesce(nullif(btrim(p_currency), ''), 'INR')); v_fx numeric;
begin
  select * into o from public.organizations where id = p_org;
  if not found then raise exception 'unknown studio' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 100000000 then raise exception 'amount must be more than 0' using errcode = '22023'; end if;
  if p_paid_on is null or p_paid_on > public.studio_today(p_org) + 1 or p_paid_on < date '2020-01-01' then
    raise exception 'paid on date is not valid' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('upi','bank','cash','card','other') then raise exception 'method must be upi, bank, cash, card or other' using errcode = '22023'; end if;
  if p_period_start is not null and p_period_end is not null and p_period_end < p_period_start then
    raise exception 'period end is before period start' using errcode = '22023'; end if;
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'currency must be a 3-letter ISO code' using errcode = '22023'; end if;
  if v_cur = 'INR' then v_fx := 1;
  elsif p_fx_rate_to_inr is null or p_fx_rate_to_inr <= 0 or p_fx_rate_to_inr > 100000 then
    raise exception 'an exchange rate to INR is required for % payments', v_cur using errcode = '22023';
  else v_fx := p_fx_rate_to_inr; end if;
  select * into b from public.helm_billing_settings where id;
  select * into a from public.studio_account where org_id = p_org;
  select p.code into v_plan from public.studio_subscriptions s join public.helm_plans p on p.id = s.plan_id where s.org_id = p_org;
  tx := public._resolve_tax(p_org, p_paid_on, p_amount);
  v_seq := nextval('public.helm_invoice_seq');
  insert into public.subscription_payments(org_id, amount, currency, paid_on, period_start, period_end, method, reference,
      recorded_by, invoice_seq, invoice_no, gst_rate, net_amount, gst_amount, seller, plan_code,
      provider, provider_payment_id, provider_subscription_id,
      tax_regime, tax_components, tax_note, tax_refundable, buyer, place_of_supply, fx_rate_to_inr, inr_equivalent)
    values (p_org, round(p_amount, 2), v_cur, p_paid_on, p_period_start, p_period_end,
      p_method, nullif(left(btrim(coalesce(p_reference, '')), 120), ''), p_actor, v_seq,
      coalesce(b.invoice_prefix, 'HELM-') || lpad(v_seq::text, 6, '0'), (tx ->> 'rate')::numeric, (tx ->> 'net')::numeric, (tx ->> 'tax')::numeric,
      jsonb_build_object('legal_name', b.legal_name, 'gstin', b.gstin, 'address', b.address, 'state', b.seller_state,
                         'country', coalesce(b.seller_country, 'IN'), 'lut_number', tx ->> 'lut_number'),
      v_plan, p_provider, p_provider_payment_id, p_provider_subscription_id,
      tx ->> 'regime', tx -> 'components', tx ->> 'note', coalesce((tx ->> 'refundable')::boolean, false),
      jsonb_build_object('org_id', o.id, 'legal_name', coalesce(a.legal_business_name, o.name), 'name', o.name,
        'country', coalesce(a.country, coalesce(b.seller_country, 'IN')), 'state', a.state,
        'tax_id_type', coalesce(a.tax_id_type, case when coalesce(a.gstin, o.gst_number) is not null then 'IN_GSTIN' end),
        'tax_id', coalesce(a.tax_id, a.gstin, o.gst_number), 'gstin', coalesce(a.gstin, o.gst_number),
        'is_business', coalesce(a.is_business, true), 'address', coalesce(a.billing_address, o.location),
        'email', coalesce(a.billing_contact_email, o.business_email), 'reverse_charge', coalesce((tx ->> 'reverse_charge')::boolean, false)),
      tx ->> 'place_of_supply', v_fx, round(round(p_amount, 2) * v_fx, 2))
    returning id into v_id;
  return v_id;
end $function$;
CREATE OR REPLACE FUNCTION public.checkout_attach_subscription(p_org uuid, p_subscription_id text, p_plan text, p_interval text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- unified-trial-0119
declare v_plan uuid; v_n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]{6,40}$' then
    raise exception 'bad subscription id' using errcode = '22023'; end if;
  if p_interval not in ('monthly','yearly') then raise exception 'bad interval' using errcode = '22023'; end if;
  select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan;
  if v_plan is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio or plan' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, billing_interval,
                                          provider, provider_subscription_id, updated_at)
    values (p_org, v_plan, 'trial', public.studio_today(p_org) + public._trial_days(), 'checkout', p_interval, 'razorpay', p_subscription_id, now())
  on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
      provider = 'razorpay', provider_subscription_id = excluded.provider_subscription_id, updated_at = now()
    where public.studio_subscriptions.status not in ('active','past_due','suspended')
       or (public.studio_subscriptions.status = 'past_due' and public.studio_subscriptions.trial_ends_at is not null
           and public.studio_subscriptions.current_period_end is null
           and not exists (select 1 from public.subscription_payments p where p.org_id = excluded.org_id and p.voided_at is null));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'subscription.checkout_created', 'studio_subscriptions', p_org::text,
              jsonb_build_object('plan', p_plan, 'interval', p_interval, 'provider_subscription_id', p_subscription_id), p_org, now());
  end if;
  return v_n > 0;
end $function$;
CREATE OR REPLACE FUNCTION public.studio_cost_breakdown(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- r21-money-0246: read-only
declare v_org uuid := public.current_org_id(); v_from date := coalesce(p_from, public.studio_today(public.current_org_id()) - 365);
        v_to date := coalesce(p_to, public.studio_today(public.current_org_id()) + 365); v_rows jsonb := '[]'::jsonb; x record; m jsonb; v_tot jsonb;
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
end $function$;
CREATE OR REPLACE FUNCTION public.hq_extend_trial(p_org uuid, p_days integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- one-trial-0186: one extension per studio, 1 to 7 days, reason required, Helm HQ only
declare
  v_reason text := btrim(regexp_replace(coalesce(p_reason, ''), '[[:space:]]+', ' ', 'g'));
  o public.organizations; s public.studio_subscriptions; v_block text; v_n integer;
  v_old timestamptz; v_new timestamptz; v_new_date date;
begin
  perform public._hq_wgate('hq.trial.extend', 'organizations', p_org::text,
    jsonb_build_object('days', p_days, 'reason', left(v_reason, 500)));
  if p_org is null then raise exception 'Unknown studio.' using errcode = '22023'; end if;
  if p_days is null or p_days < 1 or p_days > 7 then
    raise exception 'An extension is 1 to 7 days.' using errcode = '22023'; end if;
  if char_length(v_reason) < 5 then
    raise exception 'Write the reason for the extension (at least 5 characters).' using errcode = '22023'; end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason can be up to 500 characters.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:trial_extend:' || p_org::text, 0));
  select * into s from public.studio_subscriptions x where x.org_id = p_org for update;
  v_block := public._trial_extend_block(p_org);
  if v_block is not null then raise exception '%', v_block using errcode = '22023', hint = 'trial_extend_refused'; end if;
  select * into o from public.organizations x where x.id = p_org for update;

  if o.trial_ends_at is not null then
    v_old := o.trial_ends_at;
    v_new := greatest(o.trial_ends_at, now()) + make_interval(days => p_days);
    v_new_date := (v_new at time zone 'UTC')::date;
  else
    v_old := (s.trial_ends_at::timestamp at time zone 'UTC');
    v_new_date := greatest(s.trial_ends_at, public.hq_today()) + p_days;
    v_new := (v_new_date::timestamp at time zone 'UTC');
  end if;

  insert into public.trial_extensions(org_id, days, reason, previous_status, previous_ends_at, new_ends_at,
                                      granted_by, granted_by_email, granted_at)
    select p_org, p_days, v_reason, s.status, v_old, v_new, auth.uid(), u.email, now()
      from (select 1) one left join auth.users u on u.id = auth.uid()
  on conflict (org_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'This studio already had its one trial extension.' using errcode = '22023', hint = 'trial_extend_refused'; end if;

  update public.studio_subscriptions
     set status = 'trial', trial_ends_at = v_new_date, updated_at = now(), updated_by = auth.uid()
   where org_id = p_org;
  if o.trial_ends_at is not null then
    update public.organizations set trial_ends_at = v_new where id = p_org;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, 'Helm', 'subscription.trial_extended', 'organizations', p_org::text,
            jsonb_build_object('days', p_days, 'previous_ends_at', v_old, 'new_ends_at', v_new,
                               'previous_status', s.status, 'by', 'Helm'), p_org, now());
  return jsonb_build_object('org_id', p_org, 'days', p_days, 'status', 'trial',
                            'previous_ends_at', v_old, 'new_ends_at', v_new, 'trial_ends_on', v_new_date);
end $function$;
CREATE OR REPLACE FUNCTION public.hq_record_realisation(p_id uuid, p_fira_firc_ref text, p_realised_on date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n int;
begin
  perform public._hq_wgate('hq.payment.realised', 'subscription_payments', p_id::text,
    jsonb_build_object('fira_firc_ref', p_fira_firc_ref, 'realised_on', p_realised_on));
  if length(btrim(coalesce(p_fira_firc_ref, ''))) < 3 or p_realised_on is null or p_realised_on > public.hq_today() + 1 then
    raise exception 'FIRA / FIRC reference and realised date are required' using errcode = '22023'; end if;
  update public.subscription_payments set fira_firc_ref = left(btrim(p_fira_firc_ref), 80), realised_on = p_realised_on
   where id = p_id and realised_on is null and voided_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'payment not found, void, or already realised' using errcode = '22023'; end if;
  return (select public._sub_payment_json(sp) from public.subscription_payments sp where sp.id = p_id);
end $function$;
CREATE OR REPLACE FUNCTION public.hq_settle_provider_payment(p_provider_payment_id text, p_org uuid, p_amount numeric, p_paid_on date, p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date, p_currency text DEFAULT 'INR'::text, p_provider text DEFAULT 'razorpay'::text, p_provider_subscription_id text DEFAULT NULL::text, p_fx_rate_to_inr numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- r21-trial-paid-0244: settle (0045 body, idempotent on the provider payment id), then activate the plan when the
-- payment belongs to the provider subscription Helm attached to THIS studio
declare v_out jsonb; s public.studio_subscriptions; v_start date; v_end date; v_act jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  v_out := public.hq_settle_provider_payment__pre0244(p_provider_payment_id, p_org, p_amount, p_paid_on, p_period_start, p_period_end,
             p_currency, p_provider, p_provider_subscription_id, p_fx_rate_to_inr);
  if nullif(btrim(coalesce(p_provider_subscription_id, '')), '') is null then return v_out; end if;
  select * into s from public.studio_subscriptions where org_id = p_org;
  if not found or s.provider_subscription_id is distinct from btrim(p_provider_subscription_id) or s.plan_id is null
     or s.billing_interval is null or s.status = 'suspended' then
    return v_out || jsonb_build_object('activation', 'skipped');
  end if;
  v_start := coalesce(p_period_start, p_paid_on, public.hq_today());
  v_end := coalesce(p_period_end, public._sub_period_end(v_start, s.billing_interval));
  if v_end < v_start then v_end := public._sub_period_end(v_start, s.billing_interval); end if;
  v_act := public._sub_activate(p_org, s.plan_id, s.billing_interval, v_start, v_end, null, 'provider');
  return v_out || jsonb_build_object('activation', v_act ->> 'result');
end $function$;
CREATE OR REPLACE FUNCTION public.hq_upsert_tax_rule(p_country text, p_region text, p_regime text, p_rate numeric, p_invoice_note text DEFAULT NULL::text, p_effective_from date DEFAULT NULL::date, p_effective_to date DEFAULT NULL::date, p_active boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid; v_c text := upper(btrim(coalesce(p_country, ''))); v_r text := nullif(btrim(coalesce(p_region, '')), '');
  v_f date := coalesce(p_effective_from, public.hq_today());
begin
  perform public._hq_wgate('hq.tax_rule.upsert', 'tax_rules', v_c || ':' || coalesce(v_r, '') || ':' || coalesce(p_regime, ''),
    jsonb_build_object('rate', p_rate, 'note', p_invoice_note, 'from', v_f, 'to', p_effective_to, 'active', p_active));
  if v_c !~ '^[A-Z]{2}$' then raise exception 'country must be a 2-letter ISO code' using errcode = '22023'; end if;
  if coalesce(p_regime, '') not in ('IN_GST_INTRA','IN_GST_INTER','EXPORT_LUT_ZERO','EXPORT_IGST_PAID','REVERSE_CHARGE','LOCAL_REGISTERED','NO_TAX') then
    raise exception 'unknown regime' using errcode = '22023'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 50 then raise exception 'rate must be 0-50' using errcode = '22023'; end if;
  if p_effective_to is not null and p_effective_to < v_f then raise exception 'effective to is before effective from' using errcode = '22023'; end if;
  select id into v_id from public.tax_rules where country = v_c and coalesce(region, '') = coalesce(v_r, '') and regime = p_regime and effective_from = v_f;
  if v_id is null then
    insert into public.tax_rules(country, region, regime, rate, invoice_note, effective_from, effective_to, active, updated_by)
      values (v_c, v_r, p_regime, p_rate, nullif(left(btrim(coalesce(p_invoice_note, '')), 300), ''), v_f, p_effective_to, coalesce(p_active, true), auth.uid())
      returning id into v_id;
  else
    update public.tax_rules set rate = p_rate, invoice_note = nullif(left(btrim(coalesce(p_invoice_note, '')), 300), ''),
           effective_to = p_effective_to, active = coalesce(p_active, true), updated_at = now(), updated_by = auth.uid() where id = v_id;
  end if;
  return v_id;
end $function$;
CREATE OR REPLACE FUNCTION public._demo_seed_ae(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
-- demo-seed-0102-ae: Dubai sample studio data, AED + VAT 5%, only is_demo rows
declare
  d date := (now() at time zone 'Asia/Dubai')::date;   -- r37: the UAE sample studio's day
  q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid(); q3 uuid := gen_random_uuid(); q4 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  v_total numeric; v_a1 numeric; v_a2 numeric; v_a3 numeric;
begin
  if p_org is null then raise exception 'no studio' using errcode = '42501'; end if;
  if exists (select 1 from public.quotes where org_id = p_org and is_demo) then
    return jsonb_build_object('seeded', false, 'reason', 'already_seeded');
  end if;

  if exists (select 1 from public.venues where org_id = p_org and is_demo) then
    update public.venues set active = true where org_id = p_org and is_demo and not active;
  else
    insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, floating_capacity, length_m, width_m, dim_unit,
                              event_types, restrictions, cost_min, cost_max, cost_basis, parking_spaces, rooms, power_backup_kw,
                              green_rooms, washrooms, address, city, contact_name, notes, is_demo)
    values
      (p_org, E'Demo \u00b7 Al Noor Grand Ballroom', 'banquet_hall', 'ac', 'indoor', 500, 800, 45, 28, 'm',
       array['wedding','corporate','conference','product_launch'], array['no_outside_catering','sound_curfew'], 45000, 90000, 'per_day',
       300, 2, 500, 2, 10, E'Demo \u00b7 Sheikh Zayed Road, P.O. Box 00000', 'Dubai', E'Demo \u00b7 Banquet manager',
       E'Demo venue \u2014 sample data. In-house halal catering; alcohol only under the hotel licence.', true),
      (p_org, E'Demo \u00b7 Desert Pearl Camp', 'lawn', 'non_ac', 'outdoor', 300, 600, 60, 40, 'm',
       array['wedding','corporate','other'], array['generator_required','no_fireworks'], 30000, 60000, 'per_day',
       120, 1, 0, 1, 6, E'Demo \u00b7 Al Qudra Road, P.O. Box 00000', 'Dubai', E'Demo \u00b7 Camp manager',
       E'Demo venue \u2014 sample data. Majlis seating; best October to April.', true);
  end if;

  update public.dish_catalog x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.dish_catalog y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.category)) = lower(btrim(x.category)) and lower(btrim(y.name)) = lower(btrim(x.name)));
  update public.menu_templates x set active = true where x.org_id = p_org and x.is_demo and not x.active;
  update public.inventory_items x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.inventory_items y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.name)) = lower(btrim(x.name)));
  update public.crew_members set active = true where org_id = p_org and is_demo and not active;
  update public.vendors x set active = true where x.org_id = p_org and x.is_demo and not x.active
     and not exists (select 1 from public.vendors y where y.org_id = p_org and y.active and y.id <> x.id
                     and lower(btrim(y.name)) = lower(btrim(x.name)));

  -- halal menu (all meat halal; no pork, no alcohol in the packages)
  insert into public.dish_catalog(org_id, category, name, kind, is_demo) values
    (p_org, 'Cold mezze', E'Demo \u00b7 Hummus & moutabal', 'veg', true),
    (p_org, 'Cold mezze', E'Demo \u00b7 Fattoush', 'veg', true),
    (p_org, 'Hot mezze', E'Demo \u00b7 Lamb kibbeh (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Lamb ouzi with oriental rice (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Chicken machboos (halal)', 'nonveg', true),
    (p_org, 'Main course', E'Demo \u00b7 Hammour fillet, saffron sauce', 'nonveg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Luqaimat with date syrup', 'veg', true),
    (p_org, 'Desserts', E'Demo \u00b7 Umm Ali', 'veg', true)
  on conflict do nothing;
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  select x.* from (values
    (m1, p_org, 'gold', 'nonveg', E'Demo \u00b7 Arabic Mezze & Grill', 295::numeric,
     E'[{"n":"Demo \u00b7 Hummus & moutabal","c":"Cold mezze","k":"veg"},{"n":"Demo \u00b7 Fattoush","c":"Cold mezze","k":"veg"},{"n":"Demo \u00b7 Chicken machboos (halal)","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Luqaimat with date syrup","c":"Desserts","k":"veg"}]'::jsonb,
     true, 901, E'Demo package \u2014 sample data. AED per person, halal, no pork / alcohol.', 50, 800, true),
    (m2, p_org, 'premium', 'nonveg', E'Demo \u00b7 Emirati Royal Feast', 425::numeric,
     E'[{"n":"Demo \u00b7 Lamb kibbeh (halal)","c":"Hot mezze","k":"nonveg"},{"n":"Demo \u00b7 Lamb ouzi with oriental rice (halal)","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Hammour fillet, saffron sauce","c":"Main course","k":"nonveg"},{"n":"Demo \u00b7 Umm Ali","c":"Desserts","k":"veg"}]'::jsonb,
     true, 902, E'Demo package \u2014 sample data. AED per person, halal, no pork / alcohol.', 80, 1000, true)
  ) as x(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests, is_demo)
  where not exists (select 1 from public.menu_templates t where t.org_id = p_org and t.tier = x.tier and t.diet = x.diet);

  insert into public.inventory_items(org_id, name, category, total_qty, unit, priority, unit_cost, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Chiavari chairs (gold)', 'Furniture', 500, 'pcs', 'A', 15, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Round tables (1.8 m)', 'Furniture', 60, 'pcs', 'A', 60, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Majlis floor seating set', 'Furniture', 10, 'sets', 'A', 900, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 LED par lights', 'Lighting', 48, 'pcs', 'B', 120, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Stage platforms (2.4 x 1.2 m)', 'Staging', 24, 'pcs', 'A', 250, E'Demo item \u2014 sample data. AED.', true, true),
    (p_org, E'Demo \u00b7 Ramadan lantern set', 'Decor', 40, 'pcs', 'B', 80, E'Demo item \u2014 sample data. AED.', true, true)
  on conflict do nothing;

  insert into public.crew_members(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  select * from (values
    (p_org, E'Demo \u00b7 Omar Al Mansoori', '+971 00 000 0101', 'Operations', 'Event manager', 'full_time', 900, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Maria Santos', '+971 00 000 0102', 'Decor', 'Decor lead', 'full_time', 700, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Rahul Menon', '+971 00 000 0103', 'Logistics', 'Logistics supervisor', 'part_time', 550, E'Demo staff \u2014 sample data. Day rate in AED.', true, true),
    (p_org, E'Demo \u00b7 Layla Haddad', '+971 00 000 0104', 'Hospitality', 'Guest coordinator', 'on_call', 450::numeric, E'Demo staff \u2014 sample data. Day rate in AED.', true, true)
  ) as x(org_id, name, phone, department, role, emp_type, day_rate, notes, active, is_demo)
  where not exists (select 1 from public.crew_members c where c.org_id = p_org and c.name = x.name);
  insert into public.vendors(org_id, name, category, kind, phone, email, notes, active, is_demo) values
    (p_org, E'Demo \u00b7 Jumeirah Blooms', 'Florist', 'vendor', '+971 00 000 0201', 'demo.florist@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Gulf Sound & Lights', 'Sound & lights', 'rental', '+971 00 000 0202', 'demo.sound@example.com', E'Demo vendor \u2014 sample data.', true, true),
    (p_org, E'Demo \u00b7 Marina Lens Studio', 'Photography', 'freelancer', '+971 00 000 0203', 'demo.photo@example.com', E'Demo vendor \u2014 sample data.', true, true)
  on conflict do nothing;

  insert into public.leads(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, notes, status, is_demo) values
    (p_org, E'Demo \u00b7 Noura Al Hashimi', '+971 00 000 0301', 'demo.noura@example.com', 'Instagram', 'Wedding', d + 45, 350000, 400, E'Demo lead \u2014 sample data.', 'won', true),
    (p_org, E'Demo \u00b7 Khalid Rahman', '+971 00 000 0302', 'demo.khalid@example.com', 'Referral', 'Engagement', d + 30, 120000, 150, E'Demo lead \u2014 sample data.', 'quoted', true),
    (p_org, E'Demo \u00b7 Falcon Tech FZ-LLC', '+971 00 000 0303', 'demo.falcon@example.com', 'Website', 'Gala dinner', d + 60, 250000, 300, E'Demo lead \u2014 sample data. B2B client, VAT registered.', 'quoted', true),
    (p_org, E'Demo \u00b7 Sara Khan', '+971 00 000 0304', 'demo.sara@example.com', 'Walk-in', 'Iftar', d + 20, 60000, 120, E'Demo lead \u2014 sample data.', 'discovery', true),
    (p_org, E'Demo \u00b7 Daniel Wright', '+971 00 000 0305', 'demo.daniel@example.com', 'Google', 'Product launch', d + 90, 180000, 250, E'Demo lead \u2014 sample data. Just enquired.', 'new', true),
    (p_org, E'Demo \u00b7 Aisha Siddiqui', '+971 00 000 0306', 'demo.aisha@example.com', 'Instagram', 'Wedding', d + 75, 300000, 350, E'Demo lead \u2014 sample data. Went with another planner.', 'lost', true);

  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, lifecycle_stage, event_date, event_time,
                            client, pricing, confirmed_at, is_demo) values
    (q1, p_org, 'DEMO-101', E'Demo \u00b7 Noura & Saeed Wedding', 'Wedding', 'confirmed', 'paid', 'planning', d + 45, '20:00',
     E'{"name":"Demo \u00b7 Noura Al Hashimi","phone":"+971 00 000 0301","email":"demo.noura@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":400,"platePrice":425,"chairs":400,"chairPrice":15,"other":60000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', now(), true),
    (q2, p_org, 'DEMO-102', E'Demo \u00b7 Khalid & Huda Engagement', 'Engagement', 'quote', 'none', 'proposal', d + 30, '19:30',
     E'{"name":"Demo \u00b7 Khalid Rahman","phone":"+971 00 000 0302","email":"demo.khalid@example.com","city":"Sharjah","state":"Sharjah"}',
     '{"guests":150,"platePrice":295,"chairs":150,"chairPrice":15,"other":25000,"discount":3000,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true),
    (q3, p_org, 'DEMO-103', E'Demo \u00b7 Falcon Tech Annual Gala', 'Gala dinner', 'quote', 'none', 'quote', d + 60, '19:00',
     E'{"name":"Demo \u00b7 Falcon Tech FZ-LLC","company":"Falcon Tech FZ-LLC","trn":"100000000000003","phone":"+971 00 000 0303","email":"demo.falcon@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":300,"platePrice":295,"chairs":300,"chairPrice":15,"other":45000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true),
    (q4, p_org, 'DEMO-104', E'Demo \u00b7 Ramadan Iftar Majlis', 'Iftar', 'quote', 'none', 'discovery', d + 20, '18:15',
     E'{"name":"Demo \u00b7 Sara Khan","phone":"+971 00 000 0304","email":"demo.sara@example.com","city":"Dubai","state":"Dubai"}',
     '{"guests":120,"platePrice":295,"chairs":0,"chairPrice":0,"other":12000,"discount":0,"gstPct":5,"currency":"AED","taxCountry":"AE","taxRegion":"Dubai"}', null, true);
  update public.leads set is_demo = true where org_id = p_org and not is_demo and quote_id in (q1, q2, q3, q4)
     and name like E'Demo \u00b7 %';

  select case when (q.pricing ->> 'total') ~ '^[0-9]+(\.[0-9]+)?$' then (q.pricing ->> 'total')::numeric else 0 end
    into v_total from public.quotes q where q.id = q1;
  v_total := coalesce(v_total, 0);
  v_a1 := round(v_total * 0.5); v_a2 := round(v_total * 0.3); v_a3 := v_total - v_a1 - v_a2;
  insert into public.payment_milestones(quote_id, org_id, label, due_date, amount, status, paid_at, note, seq, is_demo)
  select q1, p_org, x.label, x.due, x.amt, x.st, x.pa, E'Demo \u2014 sample data.', x.seq, true
    from (values
      (E'Demo \u00b7 Booking deposit (50%)', d - 5, v_a1, 'paid', now() - interval '5 days', 1),
      (E'Demo \u00b7 Second payment (30%)', d + 15, v_a2, 'invoiced', null::timestamptz, 2),
      (E'Demo \u00b7 Balance (20%)', d + 38, v_a3, 'due', null::timestamptz, 3)
    ) as x(label, due, amt, st, pa, seq)
   where x.amt > 0;
  if v_a1 > 0 then
    insert into public.quote_payments(quote_id, org_id, provider, amount, currency, status, simulated, paid_at, method, receipt_no, note, is_demo)
      values (q1, p_org, 'bank', v_a1, 'AED', 'paid', true, now() - interval '5 days', 'bank', 'DEMO-R-0001',
              E'Demo payment \u2014 sample data (bank transfer), no money moved.', true);
  end if;

  insert into public.event_checklist(quote_id, org_id, section, title, detail, owner, due_date, status, seq, is_demo) values
    (q1, p_org, 'logistics', E'Demo \u00b7 Confirm ballroom booking with Al Noor', 'Deposit receipt filed.', E'Demo \u00b7 Omar Al Mansoori', d - 3, 'done', 1, true),
    (q1, p_org, 'compliance', E'Demo \u00b7 DET event permit + civil defence approval', 'Apply 3 weeks before.', E'Demo \u00b7 Omar Al Mansoori', d + 20, 'open', 2, true),
    (q1, p_org, 'guests', E'Demo \u00b7 Separate ladies majlis seating plan', null, E'Demo \u00b7 Layla Haddad', d + 10, 'open', 3, true),
    (q1, p_org, 'comms', E'Demo \u00b7 Send final halal menu to client', null, E'Demo \u00b7 Maria Santos', d + 25, 'open', 4, true),
    (q1, p_org, 'teardown', E'Demo \u00b7 Return rental lights to Gulf Sound', null, E'Demo \u00b7 Rahul Menon', d + 46, 'open', 5, true);

  insert into public.layouts(name, data, org_id, is_demo) values
    (E'Demo \u00b7 Noura & Saeed Wedding \u2014 Al Noor Ballroom', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('id','demo-stage','type','stage','category','structure','x',80,'y',6,'width',40,'height',16,'rotation',0,'label',E'Demo \u00b7 Kosha stage','properties','{}'::jsonb),
        jsonb_build_object('id','demo-dance','type','dancefloor','category','structure','x',88,'y',30,'width',24,'height',24,'rotation',0,'label',E'Demo \u00b7 Zaffa walkway floor','properties','{}'::jsonb),
        jsonb_build_object('id','demo-t1','type','table','category','seating','x',30,'y',40,'width',6,'height',6,'rotation',0,'label','Table 1','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t2','type','table','category','seating','x',44,'y',40,'width',6,'height',6,'rotation',0,'label','Table 2','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t3','type','table','category','seating','x',58,'y',40,'width',6,'height',6,'rotation',0,'label','Table 3','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t4','type','table','category','seating','x',136,'y',40,'width',6,'height',6,'rotation',0,'label','Table 4','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t5','type','table','category','seating','x',150,'y',40,'width',6,'height',6,'rotation',0,'label','Table 5','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-t6','type','table','category','seating','x',164,'y',40,'width',6,'height',6,'rotation',0,'label','Table 6','properties',jsonb_build_object('seats',10)),
        jsonb_build_object('id','demo-buffet1','type','buffet','category','logistics','x',20,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Halal buffet','properties','{}'::jsonb),
        jsonb_build_object('id','demo-buffet2','type','buffet','category','logistics','x',162,'y',100,'width',18,'height',3,'rotation',0,'label',E'Demo \u00b7 Arabic coffee & dates','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit1','type','exit','category','safety','x',0,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb),
        jsonb_build_object('id','demo-exit2','type','exit','category','safety','x',188,'y',128,'width',12,'height',6,'rotation',0,'label','Exit','properties','{}'::jsonb)),
      'grid', jsonb_build_object('snap', true, 'show', true, 'unit', 'm', 'sizeFt', 2),
      'margins', jsonb_build_object('left', 0, 'right', 0, 'top', 0, 'bottom', 0),
      'venue', jsonb_build_object('capacity', 500),
      'scale', jsonb_build_object('pxPerFt', 12, 'worldFt', jsonb_build_object('w', 200, 'h', 140)),
      'demo', true), p_org, true);

  update public.organizations set trial_mode = 'demo' where id = p_org;
  return jsonb_build_object('seeded', true, 'country', 'AE', 'quotes', 4, 'leads', 6, 'staff', 4, 'vendors', 3, 'inventory', 6,
                            'venues', 2, 'packages', 2, 'dishes', 8, 'layouts', 1);
end $function$;
