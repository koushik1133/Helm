-- APPLY-0287.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER every earlier APPLY file (it re-issues the newest bodies of 0181 / 0239 / 0069 / 0268 / 0120).
-- If any of 0279-0286 (parallel branches) re-issues one of the five functions below, run THIS file after it.
-- Studio time zone for server "today": the database clock is UTC, so for an Indian studio the day used to change at
-- 05:30 IST instead of midnight (Dubai: 04:00). New internal helpers studio_timezone / studio_today; every server
-- check that used the UTC "today" (payment reminders, vendor payables, package lock, inventory overdue, trial end,
-- nurture greetings, enquiry form date, plan payment dates, ...) now uses the studio's day; Helm HQ screens use India
-- time (hq_today). Functions only - no table / column / row / policy changed, nothing
-- deleted. Safe to run twice. ASCII only. No temp tables.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (same branch: country-profile.js + store-api.js v290 + pages).
--   3  Check (any time between 00:00 and 05:30 IST is the interesting window): Business -> vendor bills due
--      yesterday (India date) show as overdue; Settings -> a reminder for a milestone due today says "due today".
begin;
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
      where a.action like 'hq.%' and a.org_id is null and a.at >= f and a.at < t + 1
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

commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 studio_timezone + studio_today exist',
     to_regprocedure('public.studio_timezone(uuid)') is not null and to_regprocedure('public.studio_today(uuid, timestamptz)') is not null),
  ('02 India day flips at 18:30 UTC',
     public.studio_today('00000000-0000-4000-8000-0000000000ff', '2026-10-27 18:29:59+00') = date '2026-10-27'
     and public.studio_today('00000000-0000-4000-8000-0000000000ff', '2026-10-27 18:30:00+00') = date '2026-10-28'),
  ('03 helpers are not callable from the API (anon / authenticated)',
     not has_function_privilege('anon', 'public.studio_today(uuid, timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.studio_today(uuid, timestamptz)', 'execute')
     and not has_function_privilege('anon', 'public.studio_timezone(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.studio_timezone(uuid)', 'execute')),
  ('04 the five functions use the studio day (no current_date left)',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('payment_reminder_send_now__pre0181', 'vendor_payables_summary__pre0239', '_pkg_lock_reason', 'checkout_availability', '_trial_refresh')
        and p.prosrc !~* 'current_date' and p.prosrc ~ 'studio_today') = 5),
  ('04b the follow-up functions use the studio day (no current_date left)',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('_trial_paid', '_r21_event_money', '_r3_price_change_notify', '_assign132_enqueue__pre0274', 'nurture_due__pre0202',
                          'queue_nurture_greeting__pre0202', '_resolve_tax', 'hq_activate_plan', 'public_enquiry_submit__pre0276')
        and p.prosrc !~* 'current_date' and p.prosrc ~ 'studio_today') = 9),
  ('04c Helm HQ screens use India time (hq_today)',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('hq_overview', 'hq_billing', 'hq_payments', 'hq_audit', 'hq_security_alerts')
        and p.prosrc !~* 'current_date' and p.prosrc ~ 'hq_today') = 5
     and public.hq_today('2026-10-27 18:30:00+00') = date '2026-10-28'),
  ('04d nurture: next occasion counts from the studio day; helpers granted as designed',
     public._next_occasion(date '2000-02-29', date '2026-10-28') = date '2027-02-28'
     and not has_function_privilege('authenticated', 'public.hq_today(timestamptz)', 'execute')
     and has_function_privilege('authenticated', 'public._my_studio_today()', 'execute')
     and has_function_privilege('authenticated', 'public._next_occasion(date)', 'execute')),
  ('05 checkout_availability still callable by signed-in users (grant kept)',
     has_function_privilege('authenticated', 'public.checkout_availability(uuid, uuid)', 'execute')),
  ('06 every studio zone name is valid or falls back (no studio without a zone)',
     not exists (select 1 from public.organizations o where public.studio_timezone(o.id) is null))
) v(item, ok) order by item;

-- INFO (not a pass/fail): studios whose country is UAE but whose zone is still the India default - owner to decide
select o.id, o.name, o.timezone, coalesce(o.country, o.brand #>> '{billing,country}') as country
  from public.organizations o
 where upper(coalesce(o.country, o.brand #>> '{billing,country}', '')) = 'AE' and o.timezone = 'Asia/Kolkata';
